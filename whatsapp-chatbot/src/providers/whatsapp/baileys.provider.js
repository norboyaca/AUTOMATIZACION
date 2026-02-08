/**
 * ===========================================
 * PROVEEDOR BAILEYS (WhatsApp sin navegador)
 * ===========================================
 *
 * Conecta WhatsApp usando @whiskeysockets/baileys
 * - Sin Chrome/Puppeteer
 * - Conexión WebSocket directa
 * - Más estable y rápido
 * - Basado en CHAT-BOT-WIMPY/WhatsAppConnection.js
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const qrcodeImage = require('qrcode');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');
const EventEmitter = require('events');
const conversationStateService = require('../../services/conversation-state.service');

class BaileysProvider extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isReady = false;
    this.qrCode = null;
    this.status = 'disconnected';
    this.miNumero = null;
    this.isConnecting = false;
    this.authPath = path.join(process.cwd(), 'baileys_auth');
    // ✅ NUEVO: Almacenamiento local de chats (para el dashboard)
    this.localChats = new Map(); // id -> chat data
  }

  /**
   * Inicializa el cliente de WhatsApp con Baileys
   * Detecta sesión existente y evita generar QR innecesario
   */
  async initialize() {
    logger.info('Inicializando Baileys (WhatsApp sin navegador)...');

    if (this.isConnecting) {
      logger.warn('Ya hay una conexión en proceso');
      return;
    }

    this.isConnecting = true;
    this.qrEmitted = false;  // 🔑 Nuevo: rastrear si ya se emitió QR
    this.hasExistingSession = false;  // 🔑 Nuevo: rastrear si hay sesión previa

    try {
      // Crear directorio de autenticación si no existe
      if (!fs.existsSync(this.authPath)) {
        fs.mkdirSync(this.authPath, { recursive: true });
        logger.info('Directorio de autenticación creado (nueva sesión)');
      }

      // Verificar si hay archivos de sesión existentes
      const authFiles = fs.existsSync(this.authPath) ? fs.readdirSync(this.authPath) : [];
      this.hasExistingSession = authFiles.length > 0;

      if (this.hasExistingSession) {
        logger.info(`📁 Sesión existente detectada (${authFiles.length} archivos): ${authFiles.join(', ')}`);
        logger.info(`📂 Ruta de autenticación: ${this.authPath}`);
        logger.info(`♻️  Intentando restaurar sesión sin QR...`);
      } else {
        logger.info('📝 No hay sesión previa en baileys_auth');
        logger.info('📱 Se generará nuevo código QR para escanear');
      }

      // Cargar estado de autenticación
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);

      // Crear socket de WhatsApp
      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: undefined,
        browser: ['Chrome (Linux)', '', ''],
        syncFullHistory: true,  // ✅ CAMBIADO: true para obtener historial
        markOnlineOnConnect: true,
        emitOwnEvents: false
      });

      // Guardar credenciales cuando se actualicen
      this.sock.ev.on('creds.update', saveCreds);

      // ✅ NUEVO: Store en memoria para capturar chats del historial
      const chatsStore = {};
      const store = {
        get: (id) => chatsStore[id],
        set: (id) => chatsStore[id] = id,
        all: () => Object.keys(chatsStore)
      };

      // ✅ NUEVO: Escuchar eventos de actualización de chats (historial de WhatsApp)
      this.sock.ev.on('chats.set', async ({ chats, lastMsg, isLatest }) => {
        if (!chats || chats.length === 0) {
          logger.debug('📂 No hay chats en el evento chats.set');
          return;
        }

        logger.info(`📂 Recibiendo ${chats.length} chats desde WhatsApp (isLatest: ${isLatest})`);

        let importedCount = 0;
        for (const chat of chats) {
          const chatId = chat.id;
          if (!chatId) continue;

          // ✅ Guardar en almacenamiento local
          this.localChats.set(chatId, chat);

          // Solo procesar chats individuales (no grupos)
          if (!chatId.endsWith('@s.whatsapp.net')) {
            continue;
          }

          store.set(chatId, chatId);

          // Extraer número de teléfono
          const phoneNumber = chatId.replace('@s.whatsapp.net', '');

          // Obtener nombre del chat
          const chatName = chat.name || chat.notify || null;

          // Crear o actualizar conversación
          const existingConv = conversationStateService.getConversation(chatId);

          if (!existingConv) {
            conversationStateService.getOrCreateConversation(chatId, {
              whatsappName: chatName,
              realPhoneNumber: phoneNumber
            });
            importedCount++;
            logger.debug(`📂 Chat importado: ${phoneNumber} (${chatName || 'Sin nombre'})`);
          } else {
            // Actualizar nombre si no existe
            if (chatName && !existingConv.whatsappName) {
              existingConv.whatsappName = chatName;
              existingConv.whatsappNameUpdatedAt = Date.now();
            }
          }
        }

        logger.info(`✅ ${importedCount} nuevos chats importados desde WhatsApp`);
      });

      // Manejar eventos de conexión
      this.sock.ev.on('connection.update', async (update) => {
        await this._handleConnectionUpdate(update);
      });

      // Manejar mensajes entrantes
      this.sock.ev.on('messages.upsert', async (m) => {
        await this._handleMessages(m);
      });

      // ✅ NUEVO: Escuchar evento de sincronización de historial
      this.sock.ev.on('messaging-history:sync', async ({ chats, messages, contacts }) => {
        logger.info('📂 Sincronización de historial recibida de WhatsApp');

        if (chats && chats.length > 0) {
          logger.info(`📂 Procesando ${chats.length} chats del historial...`);
          let importedCount = 0;

          for (const chat of chats) {
            // chat tiene estructura: { id, name, t (timestamp), ... }
            const chatId = chat.id;

            // Solo procesar chats individuales (no grupos)
            if (!chatId.endsWith('@s.whatsapp.net')) {
              continue;
            }

            const phoneNumber = chatId.replace('@s.whatsapp.net', '');
            const chatName = chat.name || chat.notify || null;

            const existingConv = conversationStateService.getConversation(chatId);

            if (!existingConv) {
              conversationStateService.getOrCreateConversation(chatId, {
                whatsappName: chatName,
                realPhoneNumber: phoneNumber
              });
              importedCount++;
            } else {
              // Actualizar nombre si no existe
              if (chatName && !existingConv.whatsappName) {
                existingConv.whatsappName = chatName;
                existingConv.whatsappNameUpdatedAt = Date.now();
              }
            }
          }

          logger.info(`✅ ${importedCount} nuevos chats importados desde historial`);

          // Guardar las conversaciones importadas
          if (importedCount > 0) {
            const { saveConversationsToFile } = require('../../services/conversation-state.service');
            await saveConversationsToFile();
          }
        }
      });

      // ✅ NUEVO: Escuchar evento chat.upsert (cuando se actualiza un chat individual)
      this.sock.ev.on('chat.upsert', (chat) => {
        const chatId = chat.id;
        if (!chatId || !chatId.endsWith('@s.whatsapp.net')) {
          return;
        }

        // ✅ Guardar en almacenamiento local
        this.localChats.set(chatId, chat);

        const phoneNumber = chatId.replace('@s.whatsapp.net', '');
        const chatName = chat.name || chat.notify || null;

        const existingConv = conversationStateService.getConversation(chatId);

        if (!existingConv) {
          conversationStateService.getOrCreateConversation(chatId, {
            whatsappName: chatName,
            realPhoneNumber: phoneNumber
          });
          logger.debug(`📂 Chat upsert: ${phoneNumber} (${chatName || 'Sin nombre'})`);
        } else {
          if (chatName && !existingConv.whatsappName) {
            existingConv.whatsappName = chatName;
            existingConv.whatsappNameUpdatedAt = Date.now();
          }
        }
      });

      // ✅ NUEVO: Escuchar evento chats.upsert (cuando se agregan múltiples chats)
      this.sock.ev.on('chats.upsert', (chats) => {
        if (!chats || chats.length === 0) return;

        logger.info(`📂 chats.upsert: ${chats.length} chats recibidos`);

        for (const chat of chats) {
          const chatId = chat.id;
          if (!chatId || !chatId.endsWith('@s.whatsapp.net')) {
            continue;
          }

          // ✅ Guardar en almacenamiento local
          this.localChats.set(chatId, chat);

          const phoneNumber = chatId.replace('@s.whatsapp.net', '');
          const chatName = chat.name || chat.notify || null;

          const existingConv = conversationStateService.getConversation(chatId);

          if (!existingConv) {
            conversationStateService.getOrCreateConversation(chatId, {
              whatsappName: chatName,
              realPhoneNumber: phoneNumber
            });
            logger.debug(`📂 Chat upsert: ${phoneNumber} (${chatName || 'Sin nombre'})`);
          } else {
            if (chatName && !existingConv.whatsappName) {
              existingConv.whatsappName = chatName;
              existingConv.whatsappNameUpdatedAt = Date.now();
            }
          }
        }
      });

      // ✅ NUEVO: Escuchar evento "messaging-history:set" que contiene los chats
      this.sock.ev.on('messaging-history:set', ({ chats, contacts }) => {
        if (chats && chats.length > 0) {
          logger.info(`📂 messaging-history:set: ${chats.length} chats recibidos`);

          for (const chat of chats) {
            const chatId = chat.id;
            if (!chatId || !chatId.endsWith('@s.whatsapp.net')) {
              continue;
            }

            const phoneNumber = chatId.replace('@s.whatsapp.net', '');
            const chatName = chat.name || chat.notify || null;

            const existingConv = conversationStateService.getConversation(chatId);

            if (!existingConv) {
              conversationStateService.getOrCreateConversation(chatId, {
                whatsappName: chatName,
                realPhoneNumber: phoneNumber
              });
              logger.debug(`📂 Chat from history: ${phoneNumber} (${chatName || 'Sin nombre'})`);
            } else {
              if (chatName && !existingConv.whatsappName) {
                existingConv.whatsappName = chatName;
                existingConv.whatsappNameUpdatedAt = Date.now();
              }
            }
          }
        }
      });

      logger.info('Socket de Baileys inicializado');

    } catch (error) {
      logger.error('Error inicializando Baileys:', error);
      this.isConnecting = false;
      this.status = 'error';
      throw error;
    }
  }

  /**
   * Maneja actualizaciones de conexión
   * Implementa lógica para evitar QR innecesario con sesión existente
   */
  async _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    // QR Code generado
    if (qr) {
      logger.info('Código QR recibido');

      // 🔑 NUEVA LÓGICA: Solo emitir QR si:
      // 1. No hay sesión existente, O
      // 2. Aún no se ha conectado automáticamente (timeout de 8 segundos)

      // Si hay sesión existente, esperar un poco para ver si se conecta solo
      if (this.hasExistingSession && !this.qrEmitted) {
        logger.info('⏳ Sesión existente detectada, esperando auto-conexión (8s)...');

        // Esperar 8 segundos para ver si se conecta automáticamente
        setTimeout(async () => {
          if (!this.isReady) {
            // No se conectó automáticamente, emitir QR
            logger.info('⏰ Timeout: Sesión no válida, generando QR');
            this._emitQR(qr);
          } else {
            logger.info('✅ Sesión restaurada automáticamente sin QR');
          }
        }, 8000);
      } else {
        // No hay sesión existente, emitir QR inmediatamente
        this._emitQR(qr);
      }
    }

    // Conexión cerrada
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(`Conexión cerrada. Status: ${statusCode}`);
      this.isReady = false;
      this.isConnecting = false;
      this.status = 'disconnected';
      this.qrCode = null;
      this.miNumero = null;
      this.qrEmitted = false;  // Resetear flag para próxima reconexión

      this.emit('disconnected', lastDisconnect?.error?.message || 'Desconectado');

      if (shouldReconnect) {
        logger.info('Reconectando en 5 segundos...');
        setTimeout(() => this.initialize(), 5000);
      } else {
        logger.error('Sesión cerrada por el usuario');
      }
    }

    // Conexión exitosa
    if (connection === 'open') {
      await this._handleReady();
    }
  }

  /**
   * Emite el QR al dashboard y terminal
   * (método auxiliar para no duplicar código)
   */
  async _emitQR(qr) {
    if (this.qrEmitted) return;  // Ya se emitió este QR

    logger.info('Código QR generado - Escanea con WhatsApp');
    this.status = 'waiting_qr';
    this.qrCode = qr;
    this.qrEmitted = true;

    // Mostrar QR en terminal
    qrcode.generate(qr, { small: true });

    // Generar QR como data URL para web
    try {
      const qrDataUrl = await qrcodeImage.toDataURL(qr);
      this.emit('qr', qrDataUrl);
      logger.info('QR code emitido como data URL');
    } catch (err) {
      logger.error('Error generando QR data URL:', err);
      // En caso de error, emitir el QR crudo como fallback
      this.emit('qr', qr);
    }
  }

  /**
   * Maneja cuando el bot está listo
   */
  async _handleReady() {
    this.isReady = true;
    this.isConnecting = false;
    this.status = 'connected';

    // Mensaje específico según si restauró sesión o es nueva
    if (this.hasExistingSession && !this.qrEmitted) {
      logger.info('✅ ¡Sesión RESTAURADA automáticamente sin escanear QR!');
      logger.info('💾 La sesión se recuperó desde los archivos guardados en baileys_auth/');
    } else if (this.qrEmitted) {
      logger.info('✅ ¡Conectado a WhatsApp con Baileys (nueva sesión)!');
    } else {
      logger.info('✅ ¡Conectado a WhatsApp con Baileys!');
    }

    try {
      const user = this.sock.user;
      if (user && user.id) {
        this.miNumero = user.id.split(':')[0];
        logger.info(`📱 Mi número: ${this.miNumero}`);
      }
    } catch (e) {
      logger.warn('No se pudo obtener el número');
    }

    // ✅ NUEVO: Cargar chats históricos después de conectar
    // Esperar más tiempo para que Baileys termine de sincronizar (25 segundos)
    setTimeout(async () => {
      await this._loadHistoricalChats();
    }, 25000);

    this.isReady = true;
    this.isConnecting = false;
    this.status = 'ready';
    this.qrCode = null;

    this.emit('authenticated');
    this.emit('ready');
  }

  /**
   * ✅ NUEVO: Cargar chats históricos desde WhatsApp
   * Se ejecuta automáticamente después de conectar
   */
  async _loadHistoricalChats() {
    if (!this.sock || !this.isReady) {
      logger.warn('⚠️ No se pueden cargar chats: WhatsApp no está listo');
      return;
    }

    try {
      logger.info('📂 Cargando chats históricos desde WhatsApp...');

      let chats = null;
      let source = '';

      // MÉTODO 1: Intentar obtener desde this.sock.chats
      if (this.sock.chats && Object.keys(this.sock.chats).length > 0) {
        chats = this.sock.chats;
        source = 'sock.chats';
        logger.info(`📂 Chats encontrados en sock.chats: ${Object.keys(chats).length}`);
      }

      // MÉTODO 2: Intentar usar fetchChats si existe
      if (!chats && typeof this.sock.fetchChats === 'function') {
        try {
          logger.info('📂 Intentando fetchChats()...');
          const fetchedChats = await this.sock.fetchChats(undefined, true);
          if (fetchedChats && fetchedChats.length > 0) {
            // Convertir array a Map para procesamiento uniforme
            chats = {};
            for (const chat of fetchedChats) {
              chats[chat.id] = chat;
            }
            source = 'fetchChats()';
            logger.info(`📂 Chats obtenidos via fetchChats(): ${fetchedChats.length}`);
          }
        } catch (e) {
          logger.debug(`fetchChats() falló: ${e.message}`);
        }
      }

      if (!chats || Object.keys(chats).length === 0) {
        logger.warn('⚠️ No se encontraron chats en la sesión de WhatsApp');
        logger.info('💡 Los chats se cargarán automáticamente cuando lleguen nuevos mensajes');
        return;
      }

      let importedCount = 0;
      let updatedCount = 0;

      for (const [chatId, chatData] of Object.entries(chats)) {
        // Solo procesar chats individuales (no grupos)
        if (!chatId.endsWith('@s.whatsapp.net')) {
          continue;
        }

        const phoneNumber = chatId.replace('@s.whatsapp.net', '');
        const chatName = chatData.name || chatData.notify || null;

        const existingConv = conversationStateService.getConversation(chatId);

        if (!existingConv) {
          conversationStateService.getOrCreateConversation(chatId, {
            whatsappName: chatName,
            realPhoneNumber: phoneNumber
          });
          importedCount++;
          logger.debug(`📂 Chat importado: ${phoneNumber} (${chatName || 'Sin nombre'})`);
        } else {
          // Actualizar nombre si no existe
          if (chatName && !existingConv.whatsappName) {
            existingConv.whatsappName = chatName;
            existingConv.whatsappNameUpdatedAt = Date.now();
            updatedCount++;
          }
        }
      }

      logger.info(`✅ Importación de chats completada (${source}): ${importedCount} nuevos, ${updatedCount} actualizados`);

      // Guardar las conversaciones importadas
      const { saveConversationsToFile } = require('../../services/conversation-state.service');
      if (importedCount > 0 || updatedCount > 0) {
        await saveConversationsToFile();
      }

    } catch (error) {
      logger.error('Error cargando chats históricos:', error);
    }
  }

  /**
   * Maneja mensajes entrantes
   */
  async _handleMessages(m) {
    try {
      if (m.type !== 'notify') return;

      const msg = m.messages[0];
      if (!msg || !msg.message) return;

      // ✅ NUEVO: Ignorar mensajes de protocolo (HISTORY_SYNC, etc.)
      if (msg.message.protocolMessage) {
        logger.debug('📨 Mensaje de protocolo ignorado (HISTORY_SYNC)');
        return;
      }

      // ✅ Verificar que el mensaje tenga la estructura mínima necesaria
      if (!msg.key || !msg.key.remoteJid) {
        logger.debug('📨 Mensaje sin remoteJid, ignorando...');
        return;
      }

      // Ignorar mensajes propios
      if (msg.key.fromMe) {
        logger.debug('📤 Mensaje propio ignorado');
        return;
      }

      // Ignorar mensajes de broadcast
      if (msg.key.remoteJid === 'status@broadcast') return;

      // ✅ LOG CRÍTICO ANTES DE TRANSFORMAR
      logger.info(`📨 [RAW MESSAGE] remoteJid="${msg.key.remoteJid}", hasConversation=${!!msg.message.conversation}`);

      // Transformar mensaje al formato esperado por server.js
      const transformedMessage = this._transformMessage(msg);

      if (!transformedMessage) {
        logger.error('❌ [HANDLE] _transformMessage retornó NULL');
        return;
      }

      if (!transformedMessage.from) {
        logger.error('❌ [HANDLE] Mensaje transformado SIN "from"');

        // Escribir a archivo para debug seguro
        try {
          fs.writeFileSync('debug_message.json', JSON.stringify({
            key: msg.key,
            message: msg.message,
            full: msg,
            transformed: transformedMessage
          }, null, 2));
          logger.error('❌ Estructura del mensaje guardada en debug_message.json');
        } catch (e) {
          logger.error('Error escribiendo debug_message.json', e);
        }

        return;
      }

      // ✅ LOG ANTES DE EMITIR
      logger.info(`🚀 [EMIT] Emitiendo evento 'message': from="${transformedMessage.from}", body="${transformedMessage.body?.substring(0, 30)}"`);
      this.emit('message', transformedMessage);

    } catch (error) {
      logger.error('❌ [HANDLE] Error procesando mensaje:', error);
    }
  }

  /**
   * Transforma mensaje de Baileys al formato esperado
   * (compatible con web.provider.js)
   */
  _transformMessage(msg) {
    // ✅ Validar estructura mínima del mensaje
    if (!msg || !msg.key) {
      logger.warn('❌ MSG o MSG.KEY FALTANTE');
      return null;
    }

    // Extraer remoteJid - este es el campo crítico
    let from = msg.key.remoteJid;

    logger.info(`📨 [TRANSFORM] remoteJid="${from}", fromMe=${msg.key.fromMe}`);

    if (!from) {
      logger.error('❌ remoteJid es vacío, intentando participant...');
      if (msg.key.participant) {
        from = msg.key.participant;
        logger.info(`✅ Recuperado from de participant: ${from}`);
      } else {
        logger.error('❌ Imposible recuperar from - RETORNANDO NULL');
        return null;
      }
    }

    const body = msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    let type = 'chat';
    if (msg.message?.imageMessage) type = 'image';
    else if (msg.message?.videoMessage) type = 'video';
    else if (msg.message?.audioMessage || msg.message?.pttMessage) type = 'audio';
    else if (msg.message?.documentMessage) type = 'document';
    else if (msg.message?.buttonsResponseMessage) type = 'button_response';

    // ✅ Extraer pushName del mensaje o del objeto completo
    let pushName = msg.pushName || null;

    if (!pushName) {
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
      if (contextInfo?.participant) {
        pushName = contextInfo.participant.split('@')[0] || null;
      } else if (msg.message?.contactMessage?.displayName) {
        pushName = msg.message.contactMessage.displayName;
      } else if (msg.key?.participant) {
        pushName = msg.key.participant.split('@')[0] || null;
      }
    }

    // Limpiar el nombre
    if (pushName) {
      pushName = String(pushName).trim();
      if (/^\d+$/.test(pushName) || pushName === '') {
        pushName = null;
      }
    }

    const result = {
      from: from,
      to: msg.key.toJid || null,
      body: body,
      type: type,
      fromMe: msg.key.fromMe || false,
      id: msg.key.id,
      timestamp: msg.messageTimestamp || Date.now(),
      hasMedia: !!(
        msg.message?.imageMessage ||
        msg.message?.videoMessage ||
        msg.message?.audioMessage ||
        msg.message?.documentMessage
      ),
      pushName: pushName,
      _original: msg,
      message: msg.message
    };

    logger.info(`✅ [TRANSFORM] Mensaje transformado: from=${result.from}, body="${body.substring(0, 30)}"`);

    return result;
  }

  /**
   * Envía un mensaje de texto
   */
  async sendMessage(to, content) {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      // Formatear número si es necesario
      const chatId = this._formatNumber(to);

      // Si content es un string, enviar como texto simple
      if (typeof content === 'string') {
        const result = await this.sock.sendMessage(chatId, { text: content });
        logger.debug(`Mensaje enviado a ${to}`);
        return result;
      }

      // Si es un objeto con botones, enviar mensaje con botones
      if (content.buttons && Array.isArray(content.buttons)) {
        // Formatear botones para Baileys
        const formattedButtons = content.buttons.map(btn => ({
          buttonId: btn.buttonId,
          buttonText: { displayText: btn.buttonText },
          type: btn.type || 1
        }));

        const result = await this.sock.sendMessage(chatId, {
          text: content.text,
          buttons: formattedButtons
        });

        logger.debug(`Mensaje con botones enviado a ${to}`);
        return result;
      }

      // Si es un objeto con text, enviar como texto
      if (content.text) {
        const result = await this.sock.sendMessage(chatId, { text: content.text });
        logger.debug(`Mensaje enviado a ${to}`);
        return result;
      }

      // Fallback: intentar enviar directamente
      const result = await this.sock.sendMessage(chatId, content);
      logger.debug(`Mensaje enviado a ${to}`);
      return result;

    } catch (error) {
      logger.error('Error enviando mensaje:', error);
      throw error;
    }
  }

  /**
   * Envía una imagen
   */
  async sendImage(to, imagePath, caption = '') {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      const chatId = this._formatNumber(to);

      // Leer imagen como buffer
      const imageBuffer = fs.readFileSync(imagePath);

      // Enviar imagen
      const result = await this.sock.sendMessage(
        chatId,
        {
          image: imageBuffer,
          caption: caption
        }
      );

      logger.debug(`Imagen enviada a ${to}`);
      return result;
    } catch (error) {
      logger.error('Error enviando imagen:', error);
      throw error;
    }
  }

  /**
   * ✅ NUEVO: Envía un audio
   */
  async sendAudio(to, audioPath) {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      const chatId = this._formatNumber(to);

      // Leer audio como buffer
      const audioBuffer = fs.readFileSync(audioPath);

      // Enviar audio
      const result = await this.sock.sendMessage(
        chatId,
        {
          audio: audioBuffer,
          mimetype: 'audio/mpeg'  // MP3 es el formato más común
        }
      );

      logger.debug(`Audio enviado a ${to}`);
      return result;
    } catch (error) {
      logger.error('Error enviando audio:', error);
      throw error;
    }
  }

  /**
   * Envía un documento
   */
  async sendDocument(to, filePath, filename) {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      const chatId = this._formatNumber(to);

      // Leer documento como buffer
      const docBuffer = fs.readFileSync(filePath);

      // Determinar mimetype
      const ext = path.extname(filePath).toLowerCase();
      const mimetype = this._getMimeType(ext);

      // Enviar documento
      const result = await this.sock.sendMessage(
        chatId,
        {
          document: docBuffer,
          mimetype: mimetype,
          filename: filename || path.basename(filePath),
          caption: ''
        }
      );

      logger.debug(`Documento enviado a ${to}`);
      return result;
    } catch (error) {
      logger.error('Error enviando documento:', error);
      throw error;
    }
  }

  /**
   * Obtiene el mimetype basado en la extensión
   */
  _getMimeType(ext) {
    const mimes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4'
    };
    return mimes[ext] || 'application/octet-stream';
  }

  /**
   * Formatea el número para WhatsApp
   */
  _formatNumber(number) {
    // Si ya tiene @s.whatsapp.net o @g.us, retornar tal cual
    if (number.includes('@')) {
      return number;
    }

    // Agregar sufijo de WhatsApp
    return `${number}@s.whatsapp.net`;
  }

  /**
   * Obtiene el cliente de WhatsApp directamente
   */
  getClient() {
    return this.sock;
  }

  /**
   * Obtiene el estado actual
   */
  getStatus() {
    return {
      status: this.status,
      isReady: this.isReady,
      hasQR: !!this.qrCode,
      miNumero: this.miNumero
    };
  }

  /**
   * Obtiene el código QR actual
   */
  getQRCode() {
    return this.qrCode;
  }

  /**
   * Cierra la conexión
   */
  async destroy() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {
        logger.warn('Error haciendo logout:', e.message);
      }
      try {
        this.sock.end();
      } catch (e) {
        logger.warn('Error cerrando socket:', e.message);
      }
    }

    this.isReady = false;
    this.isConnecting = false;
    this.status = 'disconnected';
    this.qrCode = null;
    this.miNumero = null;
    this.qrEmitted = false;  // 🔑 Resetear flag

    logger.info('Conexión de Baileys cerrada');
  }

  /**
   * Cierra sesión (borra autenticación)
   */
  async logout() {
    await this.destroy();

    // Eliminar archivos de sesión
    if (fs.existsSync(this.authPath)) {
      fs.rmSync(this.authPath, { recursive: true, force: true });
      logger.info('Sesión de Baileys eliminada');
    }
  }

  // ===========================================
  // ✅ NUEVO: OBTENER CHATS DESDE WHATSAPP
  // ===========================================

  /**
   * Obtiene chats desde WhatsApp con límite
   * @param {number} limit - Cantidad de chats a obtener (default: 20)
   * @returns {Promise<Array>} Lista de chats
   */
  async fetchChats(limit = 20) {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      logger.info(`📱 Obteniendo ${limit} chats desde WhatsApp...`);

      // Obtener chats desde el almacenamiento local (se llena con eventos)
      let allChats = Array.from(this.localChats.values());

      // Si localChats está vacío, intentar con sock.chats
      if (allChats.length === 0 && this.sock.chats) {
        const chatsMap = this.sock.chats;
        allChats = Object.values(chatsMap);
      }

      logger.info(`📱 Total de chats en almacenamiento local: ${allChats.length}`);

      // Ordenar por último mensaje (más recientes primero)
      const sortedChats = allChats.sort((a, b) => {
        const timeA = a.lastMessageRecvTimestamp || 0;
        const timeB = b.lastMessageRecvTimestamp || 0;
        return timeB - timeA;
      });

      // Aplicar límite
      const limitedChats = sortedChats.slice(0, limit);

      logger.info(`📱 Retornando ${limitedChats.length} chats`);

      // Transformar al formato que espera el dashboard
      return limitedChats.map(chat => this._transformChat(chat));
    } catch (error) {
      logger.error('Error obteniendo chats:', error);
      throw error;
    }
  }

  /**
   * Obtiene todos los chats desde WhatsApp
   * @returns {Promise<Array>} Lista de chats
   */
  async fetchAllChats() {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      // Obtener chats desde el almacenamiento local
      let allChats = Array.from(this.localChats.values());

      // Si localChats está vacío, intentar con sock.chats
      if (allChats.length === 0 && this.sock.chats) {
        const chatsMap = this.sock.chats;
        allChats = Object.values(chatsMap);
      }

      logger.info(`📱 Chats obtenidos desde almacenamiento local: ${allChats.length}`);

      // Transformar al formato que espera el dashboard
      return chats.map(chat => this._transformChat(chat));
    } catch (error) {
      logger.error('Error obteniendo chats:', error);
      throw error;
    }
  }

  /**
   * Obtiene mensajes de un chat específico
   * @param {string} jid - JID del chat (ej: 573001234567@s.whatsapp.net)
   * @param {number} limit - Cantidad de mensajes (default: 20)
   * @param {string} cursor - Cursor para paginación
   * @returns {Promise<Object>} Mensajes y metadata de paginación
   */
  async fetchChatMessages(jid, limit = 20, cursor = null) {
    if (!this.isReady || !this.sock) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      logger.info(`📜 Obteniendo mensajes para ${jid}...`);

      // Obtener mensajes desde this.sock.messages (si está disponible)
      let messages = [];

      if (this.sock.messages && this.sock.messages[jid]) {
        // Los mensajes están en un Map por chat
        const chatMessages = this.sock.messages[jid];
        messages = Object.values(chatMessages);
        logger.info(`📜 Mensajes encontrados en sock.messages[${jid}]: ${messages.length}`);
      } else if (typeof this.sock.fetchMessages === 'function') {
        // Fallback a fetchMessages si existe
        const options = { limit };
        if (cursor) {
          options.cursor = cursor;
        }
        messages = await this.sock.fetchMessages(jid, options);
        logger.info(`📜 Mensajes obtenidos via fetchMessages: ${messages.length}`);
      }

      // Ordenar por timestamp (más recientes primero)
      messages.sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));

      // Aplicar límite
      const limitedMessages = messages.slice(0, limit);

      logger.info(`📜 Retornando ${limitedMessages.length} mensajes para ${jid}`);

      // Transformar mensajes al formato del dashboard
      const transformedMessages = limitedMessages.map(msg => this._transformMessageForDashboard(msg, jid));

      // Determinar si hay más mensajes
      const hasMore = messages.length > limit;

      // Obtener cursor del último mensaje para siguiente página
      const nextCursor = limitedMessages.length > 0
        ? limitedMessages[limitedMessages.length - 1].key.id
        : null;

      return {
        messages: transformedMessages,
        hasMore: hasMore,
        nextCursor: nextCursor
      };
    } catch (error) {
      logger.error('Error obteniendo mensajes:', error);
      throw error;
    }
  }

  /**
   * Transforma un chat de Baileys al formato del dashboard
   */
  _transformChat(chat) {
    const jid = chat.id;
    const phoneNumber = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

    // Obtener último mensaje
    let lastMessage = '';
    let lastMessageTime = Date.now();

    if (chat.messages && chat.messages.length > 0) {
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg.message) {
        const msgType = Object.keys(lastMsg.message)[0];
        if (msgType === 'conversation') {
          lastMessage = lastMsg.message.conversation;
        } else if (msgType === 'extendedTextMessage') {
          lastMessage = lastMsg.message.extendedTextMessage.text;
        } else if (msgType === 'imageMessage') {
          lastMessage = '[Foto]';
        } else if (msgType === 'audioMessage') {
          lastMessage = '[Audio]';
        } else if (msgType === 'videoMessage') {
          lastMessage = '[Video]';
        } else if (msgType === 'documentMessage') {
          lastMessage = `[${lastMsg.message.documentMessage.fileName || 'Documento'}]`;
        } else {
          lastMessage = `[${msgType}]`;
        }
        lastMessageTime = lastMsg.messageTimestamp * 1000;
      }
    }

    return {
      userId: jid,
      phoneNumber: phoneNumber,
      whatsappName: chat.name || chat.notify || null,
      registeredName: chat.name || chat.notify || null,  // Para compatibilidad con frontend
      lastMessage: lastMessage,
      lastInteraction: lastMessageTime,
      unreadCount: chat.unreadCount || 0,
      // Campos compatibles con el formato existente
      status: 'active',
      consentStatus: 'accepted',
      bot_active: true,
      messages: []
    };
  }

  /**
   * Transforma un mensaje de Baileys al formato del dashboard
   * (versión para mensajes históricos fetchChatMessages)
   */
  _transformMessageForDashboard(msg, jid) {
    const message = msg.message || {};
    const msgType = Object.keys(message)[0];

    let text = '';
    let type = 'text';
    let mediaUrl = null;
    let fileName = null;

    switch (msgType) {
      case 'conversation':
        text = message.conversation;
        type = 'text';
        break;
      case 'extendedTextMessage':
        text = message.extendedTextMessage.text;
        type = 'text';
        break;
      case 'imageMessage':
        text = message.imageMessage.caption || '[Foto]';
        type = 'image';
        // Nota: Para obtener la URL real habría que descargar el media
        break;
      case 'audioMessage':
        text = '[Audio]';
        type = 'audio';
        break;
      case 'videoMessage':
        text = message.videoMessage.caption || '[Video]';
        type = 'video';
        break;
      case 'documentMessage':
        text = `[${message.documentMessage.fileName || 'Documento'}]`;
        type = 'document';
        fileName = message.documentMessage.fileName;
        break;
      default:
        text = `[${msgType}]`;
        type = 'text';
    }

    // Determinar si es mensaje entrante o saliente
    const isFromMe = msg.key.fromMe;
    const sender = isFromMe ? 'admin' : 'user';

    return {
      id: msg.key.id,
      message: text,
      sender: sender,
      timestamp: (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000,
      type: type,
      mediaUrl: mediaUrl,
      fileName: fileName
    };
  }
}

// Singleton
const instance = new BaileysProvider();

module.exports = instance;
