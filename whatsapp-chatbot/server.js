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

// ===========================================
// PROCESAR MENSAJES DE WHATSAPP
// ===========================================
whatsappWeb.on('message', async (message) => {
  try {
    const from = message.from;
    const body = message.body;
    const type = message.type;

    // Detectar tipo de chat
    const chatType = from.includes('@lid') ? 'LID' :
                     from.includes('@g.us') ? 'Grupo' :
                     from.includes('@c.us') ? 'Normal' : 'Desconocido';

    logger.info(`📩 Mensaje [${chatType}] de ${from}: ${body?.substring(0, 50)}...`);
    logger.info(`📝 Tipo de mensaje: ${type} | fromMe: ${message.fromMe}`);

    // ===========================================
    // IGNORAR MENSAJES VACÍOS (eventos históricos de Baileys)
    // ===========================================
    if (!body || body.trim() === '') {
      logger.debug('⏭️ Mensaje vacío, ignorando (probablemente evento histórico)');
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
      logger.info('🔄 Procesando mensaje con messageProcessor...');

      // Usar messageProcessor que ya maneja todo:
      // - consentimiento
      // - escalación
      // - horario
      // - GUARDADO DE MENSAJES
      const response = await messageProcessor.processIncomingMessage(from, body);

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

  // Inicializar WhatsApp Web
  try {
    await whatsappWeb.initialize();
  } catch (error) {
    logger.error('Error inicializando WhatsApp:', error);
  }
});

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
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa rechazada no manejada:', reason);
});

module.exports = server;