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
        logger.info(`📁 Sesión existente detectada (${authFiles.length} archivos), intentando restaurar...`);
      } else {
        logger.info('📝 No hay sesión previa, se generará nuevo QR');
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
        syncFullHistory: false,
        markOnlineOnConnect: true,
        emitOwnEvents: false
      });

      // Guardar credenciales cuando se actualicen
      this.sock.ev.on('creds.update', saveCreds);

      // Manejar eventos de conexión
      this.sock.ev.on('connection.update', async (update) => {
        await this._handleConnectionUpdate(update);
      });

      // Manejar mensajes entrantes
      this.sock.ev.on('messages.upsert', async (m) => {
        await this._handleMessages(m);
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
    logger.info('✅ ¡Conectado a WhatsApp con Baileys!');

    try {
      const user = this.sock.user;
      if (user && user.id) {
        this.miNumero = user.id.split(':')[0];
        logger.info(`📱 Mi número: ${this.miNumero}`);
      }
    } catch (e) {
      logger.warn('No se pudo obtener el número');
    }

    this.isReady = true;
    this.isConnecting = false;
    this.status = 'ready';
    this.qrCode = null;

    this.emit('authenticated');
    this.emit('ready');
  }

  /**
   * Maneja mensajes entrantes
   */
  async _handleMessages(m) {
    try {
      if (m.type !== 'notify') return;

      const msg = m.messages[0];
      if (!msg.message) return;

      // Ignorar mensajes propios
      if (msg.key.fromMe) return;

      // Ignorar mensajes de broadcast
      if (msg.key.remoteJid === 'status@broadcast') return;

      // Transformar mensaje al formato esperado por server.js
      const transformedMessage = this._transformMessage(msg);

      logger.debug(`📨 Mensaje recibido: from=${transformedMessage.from}, type=${transformedMessage.type}`);
      this.emit('message', transformedMessage);

    } catch (error) {
      logger.error('Error procesando mensaje:', error);
    }
  }

  /**
   * Transforma mensaje de Baileys al formato esperado
   * (compatible con web.provider.js)
   */
  _transformMessage(msg) {
    const from = msg.key.remoteJid;
    const body = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                '';

    let type = 'chat';
    if (msg.message.imageMessage) type = 'image';
    else if (msg.message.videoMessage) type = 'video';
    else if (msg.message.audioMessage || msg.message.pttMessage) type = 'audio';
    else if (msg.message.documentMessage) type = 'document';
    else if (msg.message.buttonsResponseMessage) type = 'button_response';

    return {
      from: from,
      to: msg.key.toJid || null,
      body: body,
      type: type,
      fromMe: msg.key.fromMe || false,
      id: msg.key.id,
      timestamp: msg.messageTimestamp || Date.now(),
      hasMedia: !!(
        msg.message.imageMessage ||
        msg.message.videoMessage ||
        msg.message.audioMessage ||
        msg.message.documentMessage
      ),
      // Referencia al mensaje original para reply()
      _original: msg,
      // Para respuestas de botones
      message: msg.message
    };
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
}

// Singleton
const instance = new BaileysProvider();

module.exports = instance;
