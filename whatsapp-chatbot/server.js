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
const logger = require('./src/utils/logger');
const whatsappWeb = require('./src/providers/whatsapp/web.provider');
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

    logger.info(`📩 Mensaje [${chatType}] de ${from}: ${body.substring(0, 50)}...`);

    // Notificar a la interfaz web
    io.emit('message-received', { from, body, type, chatType });

    // Solo procesar mensajes de texto por ahora
    if (type === 'chat') {
      // Generar respuesta con IA
      const response = await chatService.generateTextResponse(from, body);

      // ✅ CAMBIO CRÍTICO: Usar message.reply() en lugar de whatsappWeb.sendMessage()
      // Esto funciona con TODOS los tipos de chat (@c.us, @lid, @g.us)
      await message.reply(response);

      logger.info(`📤 Respuesta enviada a ${from} [${chatType}]`);

      // Notificar a la interfaz web
      io.emit('bot-response', { to: from, response, chatType });
    }

  } catch (error) {
    logger.error('Error procesando mensaje:', error);

    // Enviar mensaje de error al usuario
    try {
      // ✅ CAMBIO CRÍTICO: Usar message.reply() también para errores
      await message.reply(
        'Disculpa, tuve un problema procesando tu mensaje. Por favor intenta de nuevo.'
      );
    } catch (e) {
      logger.error('Error enviando mensaje de error:', e);
    }
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
const shutdown = async (signal) => {
  logger.info(`${signal} recibido. Cerrando servidor...`);

  // Cerrar WhatsApp
  try {
    await whatsappWeb.destroy();
    logger.info('WhatsApp cerrado');
  } catch (e) {
    logger.warn('Error cerrando WhatsApp:', e);
  }

  server.close(() => {
    logger.info('Servidor HTTP cerrado');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Cierre forzado por timeout');
    process.exit(1);
  }, 10000);
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