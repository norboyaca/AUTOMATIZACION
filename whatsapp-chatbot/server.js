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

          if (response && !response?.type) {
            await client.sendMessage(from, { text: response });
            logger.info(`✅ Respuesta enviada para mensaje pendiente`);

            io.emit('bot-response', {
              to: from,
              response: `[Aceptó consentimiento y respondió]: ${response.substring(0, 50)}...`,
              chatType
            });
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
    // FALLBACK: DETECTAR RESPUESTAS DE TEXTO PARA CONSENTIMIENTO
    // ===========================================
    if (type === 'chat' || type === 'conversation') {
      const normalizedBody = body.toLowerCase().trim();

      // Verificar si el usuario está respondiendo al consentimiento con texto
      // (desde la segunda interacción en adelante, si no ha aceptado)
      const interactionCount = chatService.getUserInteractionCount(from);
      const hasNotResponded = interactionCount >= 2 && !chatService.hasUserConsent(from);

      // Verificar también si ya se mostró el mensaje de consentimiento
      const consentRequested = interactionCount >= 2;

      if (hasNotResponded && consentRequested) {
        logger.info(`🔍 Verificando respuesta de texto para consentimiento: "${normalizedBody}"`);

        // Respuestas positivas
        if (['1', 'aceptar', 'acepto', 'ok', 'si', 'sí', 'yes', 'claro', 'de acuerdo', 'estar de acuerdo'].some(ans => normalizedBody.includes(ans) || normalizedBody === ans)) {
          chatService.setConsentResponse(from, true);
          const client = whatsappWeb.getClient();

          // Enviar confirmación de aceptación
          await client.sendMessage(from, {
            text: '✅ Gracias por aceptar. Procesando su consulta...'
          });
          logger.info(`✅ Usuario ${from} aceptó el consentimiento (texto)`);

          // Verificar si hay un mensaje pendiente y responderlo
          const pendingMessage = chatService.getPendingMessage(from);
          if (pendingMessage) {
            logger.info(`📝 Procesando mensaje pendiente: "${pendingMessage.substring(0, 50)}..."`);
            chatService.clearPendingMessage(from);

            // Generar respuesta para el mensaje pendiente
            const response = await chatService.generateTextResponse(from, pendingMessage, { skipConsent: true });

            if (response && !response?.type) {
              await client.sendMessage(from, { text: response });
              logger.info(`✅ Respuesta enviada para mensaje pendiente`);

              io.emit('bot-response', {
                to: from,
                response: `[Aceptó consentimiento y respondió]: ${response.substring(0, 50)}...`,
                chatType
              });
            }
          } else {
            await client.sendMessage(from, {
              text: 'Sumercé, en qué le podemos ayudar?'
            });

            io.emit('bot-response', {
              to: from,
              response: 'Aceptó consentimiento (texto)',
              chatType
            });
          }

          return;
        }

        // Respuestas negativas
        if (['2', 'no aceptar', 'no acepto', 'no', 'rechazar', 'rechazo'].some(ans => normalizedBody.includes(ans) || normalizedBody === ans)) {
          chatService.setConsentResponse(from, false);
          const client = whatsappWeb.getClient();
          await client.sendMessage(from, {
            text: 'Entendido. Sin el consentimiento no podemos continuar con la conversación. Si cambia de opinión, puede iniciar una nueva conversación.'
          });
          logger.info(`❌ Usuario ${from} rechazó el consentimiento (texto)`);

          io.emit('bot-response', {
            to: from,
            response: 'Rechazó consentimiento (texto)',
            chatType
          });

          return;
        }

        // Si no entiende la respuesta, pedir que responda claramente
        logger.info('⏳ Respuesta no reconocida, esperando confirmación de consentimiento');
        const client = whatsappWeb.getClient();
        await client.sendMessage(from, {
          text: 'Por favor, responda:\n\n✅ "1" o "Aceptar" para continuar\n❌ "2" o "No acepto" para rechazar'
        });

        return;
      }
    }

    // Notificar a la interfaz web
    io.emit('message-received', { from, body, type, chatType });

    // Solo procesar mensajes de texto por ahora
    if (type === 'chat' || type === 'conversation') {
      logger.info('🔄 Generando respuesta...');

      // Generar respuesta con IA
      const response = await chatService.generateTextResponse(from, body);

      // Si la respuesta es null (usuario rechazó consentimiento), no responder
      if (response === null) {
        logger.info('⏭️ Sin respuesta (consentimiento no aceptado)');
        return;
      }

      // Si la respuesta tiene tipo 'consent', enviar como texto con instrucciones
      if (response?.type === 'consent') {
        logger.info('📋 Enviando mensaje de consentimiento (texto)');

        const client = whatsappWeb.getClient();

        // Enviar mensaje como texto simple (objeto con propiedad text)
        await client.sendMessage(from, { text: response.text });

        logger.info(`✅ Mensaje de consentimiento enviado a ${from} [${chatType}]`);

        // Notificar a la interfaz web
        io.emit('bot-response', {
          to: from,
          response: '[Mensaje de consentimiento]',
          chatType
        });

        return;
      }

      logger.info(`✅ Respuesta generada: ${response.substring(0, 50)}...`);
      logger.info(`📤 Enviando respuesta a ${from} [${chatType}]...`);

      // Enviar respuesta usando Baileys API
      try {
        const client = whatsappWeb.getClient();
        await client.sendMessage(from, { text: response });
        logger.info(`✅ Respuesta enviada a ${from} [${chatType}]`);
      } catch (sendError) {
        logger.error(`❌ Error enviando respuesta: ${sendError.message}`);
        throw sendError;
      }

      // Notificar a la interfaz web
      io.emit('bot-response', { to: from, response, chatType });
    } else {
      logger.warn(`⚠️ Tipo de mensaje no soportado: ${type}`);
    }

  } catch (error) {
    logger.error('❌ Error procesando mensaje:', error);
    logger.error('Stack trace:', error.stack);

    // Enviar mensaje de error al usuario
    try {
      const client = whatsappWeb.getClient();
      await client.sendMessage(from, {
        text: 'Disculpa, tuve un problema procesando tu mensaje. Por favor intenta de nuevo.'
      });
      logger.info('Mensaje de error enviado');
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