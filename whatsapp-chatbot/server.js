/**
 * ===========================================
 * SERVIDOR PRINCIPAL - NORBOY CHATBOT
 * ===========================================
 *
 * Integra:
 * - Express (API)
 * - Socket.IO (comunicación en tiempo real)
 * - WhatsApp Web (conexión vía QR)
 * - OpenAI (respuestas inteligentes)
 */

require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const app = require('./src/app');
const config = require('./src/config');
const { requireAuth } = require('./src/middlewares/auth.middleware');
const logger = require('./src/utils/logger');
const messageProcessor = require('./src/services/message-processor.service');
const advisorControlService = require('./src/services/advisor-control.service');

// Seleccionar provider: baileys (recomendado) o web (whatsapp-web.js)
const whatsappProvider = process.env.WHATSAPP_PROVIDER || 'baileys';
const whatsappWeb = whatsappProvider === 'baileys'
  ? require('./src/providers/whatsapp/baileys.provider')
  : require('./src/providers/whatsapp/web.provider');

logger.info(`Usando WhatsApp provider: ${whatsappProvider}`);

const chatService = require('./src/services/chat.service');
const spamControlService = require('./src/services/spam-control.service');
const numberControlService = require('./src/services/number-control.service');

// ✅ Inyectar numberControlService en spam-control (evita dependencia circular)
spamControlService.setNumberControlService(numberControlService);

// ✅ NUEVO: Servicio de embeddings para inicialización automática
const embeddingsService = require('./src/services/embeddings.service');

const PORT = config.server.port;

// Crear servidor HTTP
const server = http.createServer(app);

// Configurar Socket.IO
const io = new Server(server);

// ✅ NUEVO: Inicializar messageProcessor con Socket.IO para emitir eventos de escalación
messageProcessor.setSocketIO(io);

// ✅ NUEVO: Inicializar advisorControl con Socket.IO para emitir eventos de nuevos mensajes
advisorControlService.setSocketIO(io);

// ===========================================
// SOCKET.IO - COMUNICACIÓN EN TIEMPO REAL
// ===========================================
io.on('connection', (socket) => {
  logger.debug('Cliente conectado a Socket.IO');

  // Enviar estado actual
  socket.on('get-status', () => {
    const status = whatsappWeb.getStatus();
    socket.emit('status', status);
  });

  // Enviar QR si existe
  socket.on('get-qr', () => {
    const qr = whatsappWeb.getQRCode();
    if (qr) {
      socket.emit('qr', qr);
    }
  });

  socket.on('disconnect', () => {
    logger.debug('Cliente desconectado de Socket.IO');
  });
});

// ===========================================
// WHATSAPP WEB - EVENTOS
// ===========================================

// Cuando se genera el QR
whatsappWeb.on('qr', (qr) => {
  io.emit('qr', qr);
});

// Cuando se autentica
whatsappWeb.on('authenticated', () => {
  io.emit('authenticated');
});

// Cuando está listo
whatsappWeb.on('ready', () => {
  io.emit('ready');
  logger.info('🟢 WhatsApp Web está listo para recibir mensajes');
});

// Cuando se desconecta
whatsappWeb.on('disconnected', (reason) => {
  io.emit('disconnected', reason);
});

// ✅ NUEVO: Cuando la sesión expira o se invalida → regenerar QR automáticamente
whatsappWeb.on('session-expired', (reason) => {
  io.emit('session-expired', reason);
  logger.warn(`⚠️ Sesión expirada: ${reason}`);
});

// ===========================================
// PROCESAR MENSAJES DE WHATSAPP
// ===========================================
whatsappWeb.on('message', async (message) => {
  try {
    // ✅ LOG CRÍTICO AL RECIBIR MENSAJE
    logger.info(`🔔 [SERVER] Evento 'message' recibido`);
    logger.info(`   message.from="${message.from}"`);
    logger.info(`   message.body="${message.body?.substring(0, 30)}"`);
    logger.info(`   message.type="${message.type}"`);
    logger.info(`   message completo:`, JSON.stringify(message, null, 2));

    const from = message.from;
    const body = message.body;
    const type = message.type;
    const pushName = message.pushName || null; // ✅ NUEVO: Nombre del contacto

    // Detectar tipo de chat
    // ✅ CORREGIDO: Baileys usa @s.whatsapp.net para chats normales
    const chatType = from.includes('@lid') ? 'LID' :
      from.includes('@g.us') ? 'Grupo' :
        from.includes('@s.whatsapp.net') ? 'Normal' :
          from.includes('@c.us') ? 'Normal' : 'Desconocido';

    logger.info(`📩 Mensaje [${chatType}] de ${from}: ${body?.substring(0, 50)}...`);
    logger.info(`📝 Tipo de mensaje: ${type} | fromMe: ${message.fromMe}`);

    // ===========================================
    // ✅ NUEVO: IGNORAR MENSAJES DE GRUPOS
    // ===========================================
    // La IA NO debe responder en grupos de WhatsApp
    // Esto evita respuestas no deseadas, consumo de tokens y spam
    if (from.includes('@g.us')) {
      logger.info(`🚫 Mensaje de GRUPO ignorado - La IA no responde en grupos`);
      logger.info(`   Grupo: ${from}`);
      return; // No procesar este mensaje
    }
    if (pushName) {
      logger.info(`👤 Nombre del contacto: ${pushName}`);
    }

    // ✅ CORREGIDO: El nombre se guarda al crear/obtener la conversación
    // dentro de processIncomingMessage, no aquí (antes fallaba porque
    // la conversación aún no existía)

    // ===========================================
    // IGNORAR MENSAJES VACÍOS (eventos históricos de Baileys)
    // ✅ Solo para mensajes de texto - multimedia (audio, imagen, etc.) puede tener body vacío
    // ===========================================
    if ((type === 'chat' || type === 'conversation') && (!body || body.trim() === '')) {
      logger.debug('⏭️ Mensaje de texto vacío, ignorando (probablemente evento histórico)');
      return;
    }

    // ===========================================
    // MANEJO DE RESPUESTAS A BOTONES (CONSENTIMIENTO)
    // ===========================================
    if (type === 'button_response' || message?.message?.buttonsResponseMessage) {
      const selectedButtonId = message?.message?.buttonsResponseMessage?.selectedButtonId;

      logger.info(`🔘 Botón presionado: ${selectedButtonId}`);

      if (selectedButtonId === 'consent_accept') {
        chatService.setConsentResponse(from, true);
        const client = whatsappWeb.getClient();

        // Enviar confirmación de aceptación
        await client.sendMessage(from, {
          text: '✅ Gracias por aceptar. Procesando su consulta...'
        });
        logger.info(`✅ Usuario ${from} aceptó el consentimiento`);

        // Verificar si hay un mensaje pendiente y responderlo
        const pendingMessage = chatService.getPendingMessage(from);
        if (pendingMessage) {
          logger.info(`📝 Procesando mensaje pendiente: "${pendingMessage.substring(0, 50)}..."`);
          chatService.clearPendingMessage(from);

          // Generar respuesta para el mensaje pendiente
          const response = await chatService.generateTextResponse(from, pendingMessage, { skipConsent: true });

          // Procesar respuesta (puede ser string, objeto de escalación, o null)
          if (response) {
            let responseText = '';

            // Si es un string, usarlo directamente
            if (typeof response === 'string') {
              responseText = response;
            }
            // Si es un objeto con propiedad 'text' (escalamiento u otro)
            else if (response.text) {
              responseText = response.text;
            }

            // Enviar la respuesta si hay texto
            if (responseText) {
              await client.sendMessage(from, { text: responseText });
              logger.info(`✅ Respuesta enviada para mensaje pendiente: "${responseText.substring(0, 50)}..."`);

              io.emit('bot-response', {
                to: from,
                response: `[Aceptó consentimiento y respondió]: ${responseText.substring(0, 50)}...`,
                chatType
              });
            } else {
              logger.warn(`⚠️ Respuesta vacía para mensaje pendiente`);
            }
          } else {
            logger.warn(`⚠️ Sin respuesta para mensaje pendiente`);
          }
        } else {
          await client.sendMessage(from, {
            text: 'Sumercé, en qué le podemos ayudar?'
          });

          io.emit('bot-response', {
            to: from,
            response: 'Aceptó consentimiento',
            chatType
          });
        }
      } else if (selectedButtonId === 'consent_reject') {
        chatService.setConsentResponse(from, false);
        const client = whatsappWeb.getClient();
        await client.sendMessage(from, {
          text: 'Entendido. Sin el consentimiento no podemos continuar con la conversación. Si cambia de opinión, puede iniciar una nueva conversación.'
        });
        logger.info(`❌ Usuario ${from} rechazó el consentimiento`);
      }

      // Notificar a la interfaz web
      io.emit('bot-response', {
        to: from,
        response: selectedButtonId === 'consent_accept' ? 'Aceptó consentimiento' : 'Rechazó consentimiento',
        chatType
      });

      return;
    }

    // ===========================================
    // MANEJO DE RESPUESTAS DE TEXTO (CONSENTIMIENTO)
    // ===========================================
    // Verificar si el usuario está respondiendo al consentimiento con texto
    const hasPendingMessage = chatService.getPendingMessage(from);
    const interactionCount = chatService.getUserInteractionCount(from);
    const hasConsent = chatService.hasUserConsent(from);

    // Si hay mensaje pendiente (esperando respuesta de consentimiento) y el texto es una respuesta
    if (hasPendingMessage && !hasConsent && interactionCount >= 2) {
      const normalizedBody = body.toLowerCase().trim();
      const positiveResponses = ['1', 'aceptar', 'ok', 'si', 'sí', 'yes', 'acepto', 'acepto'];
      const negativeResponses = ['2', 'no aceptar', 'no', 'rechazar', 'rechazo'];

      logger.info(`🔍 Detectada posible respuesta de consentimiento: "${body}"`);

      let consentResponse = null;

      if (positiveResponses.includes(normalizedBody) || positiveResponses.some(r => normalizedBody.includes(r))) {
        consentResponse = 'accept';
        logger.info(`✅ Usuario ${from} aceptó el consentimiento (texto: "${body}")`);
      } else if (negativeResponses.includes(normalizedBody) || negativeResponses.some(r => normalizedBody.includes(r))) {
        consentResponse = 'reject';
        logger.info(`❌ Usuario ${from} rechazó el consentimiento (texto: "${body}")`);
      }

      // Si se detectó una respuesta de consentimiento
      if (consentResponse) {
        const client = whatsappWeb.getClient();

        if (consentResponse === 'accept') {
          chatService.setConsentResponse(from, true);

          // Enviar confirmación de aceptación
          await client.sendMessage(from, {
            text: '✅ Gracias por aceptar. Procesando su consulta...'
          });

          // Verificar si hay un mensaje pendiente y responderlo
          const pendingMessage = chatService.getPendingMessage(from);
          if (pendingMessage) {
            logger.info(`📝 Procesando mensaje pendiente: "${pendingMessage.substring(0, 50)}..."`);
            chatService.clearPendingMessage(from);

            // Generar respuesta para el mensaje pendiente con skipConsent
            const response = await chatService.generateTextResponse(from, pendingMessage, { skipConsent: true });

            // Procesar respuesta (puede ser string, objeto de escalación, o null)
            if (response) {
              let responseText = '';

              // Si es un string, usarlo directamente
              if (typeof response === 'string') {
                responseText = response;
              }
              // Si es un objeto con propiedad 'text' (escalamiento u otro)
              else if (response.text) {
                responseText = response.text;
              }

              // Enviar la respuesta si hay texto
              if (responseText) {
                await client.sendMessage(from, { text: responseText });
                logger.info(`✅ Respuesta enviada para mensaje pendiente: "${responseText.substring(0, 50)}..."`);

                io.emit('bot-response', {
                  to: from,
                  response: `[Aceptó consentimiento y respondió]: ${responseText.substring(0, 50)}...`,
                  chatType
                });
              } else {
                logger.warn(`⚠️ Respuesta vacía para mensaje pendiente`);
              }
            } else {
              logger.warn(`⚠️ Sin respuesta para mensaje pendiente`);
            }
          } else {
            await client.sendMessage(from, {
              text: 'Sumercé, en qué le podemos ayudar?'
            });

            io.emit('bot-response', {
              to: from,
              response: 'Aceptó consentimiento',
              chatType
            });
          }
        } else {
          // Reject
          chatService.setConsentResponse(from, false);
          await client.sendMessage(from, {
            text: 'Entendido. Sin el consentimiento no podemos continuar con la conversación. Si cambia de opinión, puede iniciar una nueva conversación.'
          });

          io.emit('bot-response', {
            to: from,
            response: 'Rechazó consentimiento',
            chatType
          });
        }

        return; // No procesar más este mensaje
      }
    }

    // Notificar a la interfaz web
    io.emit('message-received', { from, body, type, chatType });

    // ===========================================
    // NUEVO: Usar messageProcessor para todos los mensajes
    // ===========================================
    // Esto implementa todos los puntos de control:
    // - Punto 1: Verifica bot_active
    // - Punto 2: Desactivación por asesor
    // - Punto 3: Fallback obligatorio
    // - Punto 4: Control de horario (4:30 PM)
    // - Punto 5: Flujo general
    // - Y GUARDA LOS MENSAJES en conversation.messages

    if (type === 'chat' || type === 'conversation') {
      logger.info('🔄 Procesando mensaje de texto con messageProcessor...');

      // Usar messageProcessor que ya maneja todo:
      // - consentimiento
      // - escalación
      // - horario
      // - GUARDADO DE MENSAJES
      // ✅ CORREGIDO: Pasar pushName para que se guarde el nombre del contacto
      // ✅ CORREGIDO: Pasar pushName y whatsappMessageId (ID real)
      const response = await messageProcessor.processIncomingMessage(from, body, {
        pushName,
        whatsappMessageId: message.id
      });

      // Si response es null, no se debe enviar nada (ya se envió internamente)
      if (!response) {
        logger.debug('⏭️ Sin respuesta externa (ya procesada internamente)');
        return;
      }

      // Si hay respuesta, enviarla
      logger.info(`✅ Respuesta generada: ${response.substring(0, 50)}...`);
      logger.info(`📤 Enviando respuesta a ${from} [${chatType}]...`);

      try {
        const client = whatsappWeb.getClient();
        await client.sendMessage(from, { text: response });
        logger.info(`✅ Respuesta enviada a ${from} [${chatType}]`);
      } catch (sendError) {
        logger.error(`❌ Error enviando respuesta: ${sendError.message}`);
        throw sendError;
      }

      // Notificar a la interfaz web
      io.emit('bot-response', { to: from, response: response, chatType });

      // ===========================================
      // ✅ NUEVO: Procesar mensajes de audio, imagen, documento y video
      // ===========================================
    } else if (type === 'audio' || type === 'image' || type === 'document' || type === 'video') {
      logger.info(`🔄 Procesando mensaje multimedia (${type}) con messageProcessor...`);

      // ✅ NUEVO: Persistir archivo multimedia en disco
      let mediaData = null;
      try {
        const mediaStorageService = require('./src/services/media-storage.service');
        mediaData = await mediaStorageService.saveMediaFromMessage(message);
        if (mediaData) {
          logger.info(`✅ Media guardada: ${mediaData.mediaUrl} (${mediaData.fileName})`);
        }
      } catch (mediaError) {
        logger.warn(`⚠️ Error guardando media (no crítico): ${mediaError.message}`);
      }

      // Para mensajes multimedia, pasar el tipo y datos del mensaje original
      const mediaBody = type === 'audio' ? '[Audio recibido]' :
        type === 'image' ? '[Imagen recibida]' :
          type === 'document' ? '[Documento recibido]' :
            '[Video recibido]';

      const response = await messageProcessor.processIncomingMessage(from, mediaBody, {
        pushName,
        messageType: type,
        originalMessage: message,
        mediaData: mediaData,  // ✅ Pasar metadata de media
        whatsappMessageId: message.id // ✅ Pasar ID real
      });

      if (!response) {
        logger.debug('⏭️ Sin respuesta externa para multimedia (ya procesada internamente)');
        return;
      }

      // Si hay respuesta, enviarla
      logger.info(`✅ Respuesta generada para ${type}: ${response.substring(0, 50)}...`);

      try {
        const client = whatsappWeb.getClient();
        await client.sendMessage(from, { text: response });
        logger.info(`✅ Respuesta enviada a ${from} [${chatType}]`);
      } catch (sendError) {
        logger.error(`❌ Error enviando respuesta: ${sendError.message}`);
        throw sendError;
      }

      io.emit('bot-response', { to: from, response: response, chatType });

    } else {
      logger.warn(`⚠️ Tipo de mensaje no soportado: ${type}`);
    }

  } catch (error) {
    logger.error('❌ Error procesando mensaje:', error);
    logger.error('Stack trace:', error.stack);

    // Enviar mensaje de error al usuario (si tenemos el número)
    try {
      const client = whatsappWeb.getClient();

      // Obtener el número de teléfono del mensaje
      const userPhone = from || message?.key?.remoteJid;

      if (userPhone) {
        await client.sendMessage(userPhone, {
          text: 'Disculpa, tuve un problema procesando tu mensaje. Por favor intenta de nuevo.'
        });
        logger.info(`Mensaje de error enviado a ${userPhone}`);
      }
    } catch (e) {
      logger.error('❌❌ Error enviando mensaje de error:', e);
    }
  }
});

// ===========================================
// CAPTURAR MENSAJES ENVIADOS DESDE EL CELULAR
// ===========================================
// Cuando el asesor responde directamente desde el celular físico (no desde el dashboard),
// Baileys emite 'outgoing-message'. Lo guardamos como 'advisor' para mantener el historial
// completo de la conversación sin activar ninguna lógica de bot.
whatsappWeb.on('outgoing-message', async (outgoing) => {
  try {
    const { to, body, id, mediaType, originalMsg } = outgoing;
    logger.info(`📤 [SERVER] Guardando mensaje enviado desde celular → ${to}: "${body.substring(0, 50)}" (tipo: ${mediaType})`);

    // If the advisor sent multimedia from the phone, persist the file to disk/S3
    let mediaData = null;
    if (originalMsg && mediaType !== 'text') {
      try {
        const mediaStorageService = require('./src/services/media-storage.service');
        mediaData = await mediaStorageService.saveMediaFromMessage(originalMsg);
        if (mediaData) {
          logger.info(`✅ [SERVER] Media saliente guardada: ${mediaData.mediaUrl} (${mediaData.fileName})`);
        }
      } catch (mediaError) {
        logger.warn(`⚠️ [SERVER] Error guardando media saliente (no crítico): ${mediaError.message}`);
      }
    }

    await messageProcessor.saveOutgoingMessage(to, body, id, mediaData);

    logger.info(`✅ [SERVER] Mensaje desde celular guardado correctamente`);
  } catch (err) {
    logger.error(`❌ [SERVER] Error guardando mensaje desde celular: ${err.message}`);
  }
});

// ===========================================
// ENDPOINTS DE SESIÓN (Cerrar/Limpiar)
// ===========================================

// Cerrar sesión actual y reconectar
app.post('/logout', requireAuth, async (_req, res) => {
  try {
    logger.info('Solicitando cierre de sesión...');
    const client = whatsappWeb.getClient();

    if (client) {
      // Cerrar sesión de WhatsApp
      await whatsappWeb.logout();
      logger.info('✅ Sesión cerrada correctamente');

      // Reinicializar después de 2 segundos
      setTimeout(async () => {
        try {
          await whatsappWeb.initialize();
        } catch (error) {
          logger.error('Error reinicializando:', error);
        }
      }, 2000);

      res.json({
        success: true,
        message: 'Sesión cerrada. Reconectando automáticamente...'
      });
    } else {
      res.json({
        success: false,
        message: 'No hay sesión activa'
      });
    }
  } catch (error) {
    logger.error('Error cerrando sesión:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Limpiar sesión y generar nuevo QR
app.post('/clear-session', requireAuth, async (_req, res) => {
  try {
    logger.info('Limpiando sesión y generando nuevo QR...');
    const fs = require('fs');
    const path = require('path');

    const client = whatsappWeb.getClient();

    // Cerrar sesión si está activa
    if (client) {
      try {
        await whatsappWeb.logout();
      } catch (e) {
        logger.warn('Error haciendo logout, limpiando de todas formas:', e.message);
      }
    }

    // Eliminar carpeta de sesión
    const authPath = path.join(process.cwd(), 'baileys_auth');
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      logger.info('✅ Sesión eliminada correctamente');
    }

    // Reinicializar para generar nuevo QR
    setTimeout(async () => {
      try {
        await whatsappWeb.initialize();
      } catch (error) {
        logger.error('Error reinicializando:', error);
      }
    }, 3000);

    res.json({
      success: true,
      message: 'Sesión limpiada. Generando nuevo QR...'
    });
  } catch (error) {
    logger.error('Error limpiando sesión:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ===========================================
// INICIAR SERVIDOR
// ===========================================
server.listen(PORT, async () => {
  logger.info(`🚀 Servidor iniciado en http://localhost:${PORT}`);
  logger.info(`📱 Abre http://localhost:${PORT} para conectar WhatsApp`);

  // ✅ NUEVO: Inicializar embeddings automáticamente en background
  initializeEmbeddingsInBackground();

  // Inicializar WhatsApp Web
  try {
    await whatsappWeb.initialize();
  } catch (error) {
    logger.error('Error inicializando WhatsApp:', error);
  }
});

// ===========================================
// ✅ NUEVO: INICIALIZACIÓN DE EMBEDDINGS EN BACKGROUND
// ===========================================

/**
 * Inicializa los embeddings de todos los documentos en background
 * No bloquea el inicio del servidor, se ejecuta en segundo plano
 */
async function initializeEmbeddingsInBackground() {
  try {
    // Solo inicializar si USE_EMBEDDINGS no es 'false'
    if (process.env.USE_EMBEDDINGS !== 'false') {
      logger.info('🧠 Inicializando embeddings en background...');
      logger.info('   (El bot ya está funcionando, esto se procesa en segundo plano)');

      // Cargar chunks en memoria (lee JSON existentes, no genera embeddings nuevos)
      await embeddingsService.loadAllChunks();

      // ✅ Pre-calentar modelo de embeddings para eliminar latencia en primera consulta
      await embeddingsService.warmup();

      // Obtener estadísticas actuales
      const stats = embeddingsService.getEmbeddingStats();
      const totalChunks = stats.totalChunks;
      const withEmbeddings = stats.withEmbeddings;
      const withoutEmbeddings = stats.withoutEmbeddings;

      logger.info(`📊 Estadísticas de embeddings:`);
      logger.info(`   Total chunks: ${totalChunks}`);
      logger.info(`   ✅ Con embeddings: ${withEmbeddings} (${totalChunks > 0 ? ((withEmbeddings / totalChunks) * 100).toFixed(1) : 0}%)`);
      logger.info(`   ❌ Sin embeddings: ${withoutEmbeddings} (${totalChunks > 0 ? ((withoutEmbeddings / totalChunks) * 100).toFixed(1) : 0}%)`);

      // Si hay chunks sin embeddings, generarlos
      if (withoutEmbeddings > 0) {
        logger.info(`🔄 Generando ${withoutEmbeddings} embeddings faltantes en background...`);
        logger.info(`   (El bot sigue funcionando normalmente con keyword search mientras tanto)`);

        // Generar embeddings faltantes (no bloquea el inicio)
        const knowledgeUploadService = require('./src/services/knowledge-upload.service');
        const files = knowledgeUploadService.getUploadedFiles();

        let processedCount = 0;
        let generatedCount = 0;

        for (const file of files) {
          try {
            const data = await knowledgeUploadService.getFileData(file);

            if (data && data.chunks) {
              // Verificar cuántos chunks necesitan embeddings
              const chunksNeedingEmbeddings = data.chunks.filter(c => !c.embeddingGenerated && !c.embedding);

              if (chunksNeedingEmbeddings.length > 0) {
                // Generar embeddings para los chunks que faltan
                const chunksWithEmbeddings = await embeddingsService.ensureEmbeddings(data.chunks);

                // Guardar si se generaron nuevos embeddings
                await knowledgeUploadService.saveFileData(file, {
                  ...data,
                  chunks: chunksWithEmbeddings
                });

                generatedCount += chunksNeedingEmbeddings.length;
              }

              processedCount++;

              // Log de progreso cada 3 archivos
              if (processedCount % 3 === 0 || processedCount === files.length) {
                logger.info(`   Progreso: ${processedCount}/${files.length} archivos procesados (${generatedCount} embeddings generados)...`);
              }
            }
          } catch (error) {
            logger.warn(`⚠️ Error procesando embeddings para ${file.originalName}: ${error.message}`);
          }
        }

        logger.info(`✅ Embeddings inicializados: ${processedCount} archivos procesados, ${generatedCount} embeddings generados`);

        // Recargar chunks con los nuevos embeddings
        await embeddingsService.reloadChunks();

        const finalStats = embeddingsService.getEmbeddingStats();
        logger.info(`📊 Estadísticas finales:`);
        logger.info(`   ✅ Con embeddings: ${finalStats.withEmbeddings}/${finalStats.totalChunks} (${((finalStats.withEmbeddings / finalStats.totalChunks) * 100).toFixed(1)}%)`);
        logger.info(`🎯 Búsqueda vectorial activa`);
      } else {
        logger.info('✅ Todos los chunks ya tienen embeddings');
        logger.info('🎯 Búsqueda vectorial activa');
      }
    } else {
      logger.info('ℹ️ Embeddings desactivados (USE_EMBEDDINGS=false)');
      logger.info('   Usando keyword search (sistema anterior)');
    }
  } catch (error) {
    logger.error('❌ Error inicializando embeddings:', error.message);
    logger.warn('   El bot continuará funcionando sin embeddings (usando keyword search)');
  }
}

// ===========================================
// GRACEFUL SHUTDOWN
// ===========================================
let isShuttingDown = false;

const shutdown = async (signal) => {
  if (isShuttingDown) {
    logger.warn('Shutdown ya en progreso, ignorando señal duplicada...');
    return;
  }

  isShuttingDown = true;
  logger.info(`${signal} recibido. Cerrando servidor...`);

  // 1. Cerrar Socket.IO primero (para evitar nuevas conexiones WebSocket)
  try {
    if (io) {
      // Desconectar todos los clientes
      io.sockets.disconnectSockets();
      // Cerrar el servidor de Socket.IO
      await new Promise((resolve) => {
        io.close(() => {
          logger.info('Socket.IO cerrado');
          resolve();
        });
      });
    }
  } catch (e) {
    logger.warn('Error cerrando Socket.IO:', e.message);
  }

  // 2. Cerrar WhatsApp
  try {
    await whatsappWeb.destroy();
    logger.info('WhatsApp cerrado');
  } catch (e) {
    logger.warn('Error cerrando WhatsApp:', e.message);
  }

  // 3. Cerrar servidor HTTP (ya no acepta nuevas conexiones)
  try {
    server.close(() => {
      logger.info('✅ Servidor HTTP cerrado correctamente');
      process.exit(0);
    });
  } catch (e) {
    logger.error('Error cerrando servidor HTTP:', e.message);
    process.exit(1);
  }

  // 4. Timeout aumentado (30 segundos) para dar tiempo a cerrar conexiones
  setTimeout(() => {
    logger.error('⚠️ Timeout: Cierre forzado después de 30 segundos');

    // Forzar cierre de todas las conexiones
    try {
      server.closeAllConnections();
    } catch (e) {
      // Ignorar errores
    }

    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Excepción no capturada:', error);

  // No crashear por errores de red transitorios (ej: download de videos grandes)
  const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'];
  const errorCode = error.code || error.cause?.code || '';
  const isTransient = transientCodes.includes(errorCode)
    || error.message?.includes('terminated')
    || error.message?.includes('ECONNRESET')
    || error.message?.includes('fetch failed');

  if (isTransient) {
    logger.warn('⚠️ Error de red transitorio, el servidor continúa ejecutándose');
    return; // No salir
  }

  // Para errores realmente fatales, sí salir
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa rechazada no manejada:', reason);
});

module.exports = server;