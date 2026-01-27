/**
 * ===========================================
 * PROVEEDOR WHATSAPP WEB (whatsapp-web.js)
 * ===========================================
 *
 * Conecta WhatsApp mediante código QR (como WhatsApp Web).
 * No requiere API de Meta ni Twilio.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');
const EventEmitter = require('events');

class WhatsAppWebProvider extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.status = 'disconnected';
  }

  /**
   * Inicializa el cliente de WhatsApp
   */
  async initialize() {
    logger.info('Inicializando WhatsApp Web...');

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(process.cwd(), '.wwebjs_auth')
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
    });

    // Eventos del cliente
    this._setupEventListeners();

    // Iniciar cliente
    await this.client.initialize();
  }

  /**
   * Configura los event listeners
   */
  _setupEventListeners() {
    // Cuando se genera el código QR
    this.client.on('qr', async (qr) => {
      logger.info('Código QR generado - Escanea con WhatsApp');
      this.status = 'waiting_qr';

      // Generar QR como data URL para mostrar en web
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.emit('qr', this.qrCode);
      } catch (err) {
        logger.error('Error generando QR:', err);
      }
    });

    // Cuando está autenticando
    this.client.on('authenticated', () => {
      logger.info('WhatsApp autenticado correctamente');
      this.status = 'authenticated';
      this.qrCode = null;
      this.emit('authenticated');
    });

    // Cuando está listo
    this.client.on('ready', () => {
      logger.info('WhatsApp Web está listo!');
      this.isReady = true;
      this.status = 'ready';
      this.emit('ready');
    });

    // Cuando se desconecta
    this.client.on('disconnected', (reason) => {
      logger.warn('WhatsApp desconectado:', reason);
      this.isReady = false;
      this.status = 'disconnected';
      this.emit('disconnected', reason);
    });

    // Cuando hay error de autenticación
    this.client.on('auth_failure', (msg) => {
      logger.error('Error de autenticación:', msg);
      this.status = 'auth_failure';
      this.emit('auth_failure', msg);
    });

    // Cuando llega un mensaje
    this.client.on('message', async (message) => {
      // Solo procesar mensajes que no son del bot
      if (!message.fromMe) {
        this.emit('message', message);
      }
    });
  }

  /**
   * Envía un mensaje de texto
   */
  async sendMessage(to, text) {
    if (!this.isReady) {
      throw new Error('WhatsApp no está conectado');
    }

    const chatId = this._formatNumber(to);

    // Método 1: Usar cliente estándar (debería funcionar con librería actualizada)
    try {
      const result = await this.client.sendMessage(chatId, text);
      logger.debug(`Mensaje enviado a ${to}`);
      return result;
    } catch (error) {
      // Si el error es markedUnread, intentar método alternativo
      if (error.message?.includes('markedUnread') || error.message?.includes('undefined')) {
        logger.warn('Error en sendMessage, intentando vía reply...');

        // Método 2: Responder al mensaje original si está disponible
        try {
          const chat = await this.client.getChatById(chatId);
          const messages = await chat.fetchMessages({ limit: 1 });

          if (messages.length > 0) {
            // Enviar como respuesta al último mensaje
            await messages[0].reply(text);
            logger.debug(`Mensaje enviado (reply) a ${to}`);
            return { success: true };
          }
        } catch (replyError) {
          logger.warn('Reply falló:', replyError.message);
        }

        // Método 3: Usar evaluate directamente
        try {
          await this.client.pupPage.evaluate(
            async (chatId, text) => {
              const chatWid = window.Store.WidFactory.createWid(chatId);
              const chat = await window.Store.Chat.find(chatWid);

              if (chat) {
                await window.WWebJS.sendMessage(chat, text, {});
                return true;
              }
              throw new Error('Chat no encontrado');
            },
            chatId,
            text
          );
          logger.debug(`Mensaje enviado (evaluate) a ${to}`);
          return { success: true };
        } catch (evalError) {
          logger.error('Evaluate falló:', evalError.message);
          throw error; // Lanzar error original
        }
      }

      logger.error('Error enviando mensaje:', error.message);
      throw error;
    }
  }

  /**
   * Envía una imagen
   */
  async sendImage(to, imagePath, caption = '') {
    if (!this.isReady) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      const chatId = this._formatNumber(to);
      const media = MessageMedia.fromFilePath(imagePath);
      const result = await this.client.sendMessage(chatId, media, { caption });
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
    if (!this.isReady) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      const chatId = this._formatNumber(to);
      const media = MessageMedia.fromFilePath(filePath);
      media.filename = filename;
      const result = await this.client.sendMessage(chatId, media);
      return result;
    } catch (error) {
      logger.error('Error enviando documento:', error);
      throw error;
    }
  }

  /**
   * Descarga media de un mensaje
   */
  async downloadMedia(message) {
    try {
      if (message.hasMedia) {
        const media = await message.downloadMedia();
        return media;
      }
      return null;
    } catch (error) {
      logger.error('Error descargando media:', error);
      throw error;
    }
  }

  /**
   * Formatea el número para WhatsApp
   */
  _formatNumber(number) {
    // Quitar caracteres no numéricos excepto +
    let cleaned = number.replace(/[^\d]/g, '');

    // Agregar sufijo de WhatsApp si no lo tiene
    if (!cleaned.endsWith('@c.us')) {
      cleaned = `${cleaned}@c.us`;
    }

    return cleaned;
  }

  /**
   * Obtiene el estado actual
   */
  getStatus() {
    return {
      status: this.status,
      isReady: this.isReady,
      hasQR: !!this.qrCode
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
    if (this.client) {
      await this.client.destroy();
      this.isReady = false;
      this.status = 'disconnected';
    }
  }

  /**
   * Cierra sesión (borra autenticación)
   */
  async logout() {
    if (this.client) {
      await this.client.logout();
      this.isReady = false;
      this.status = 'disconnected';
    }
  }
}

// Singleton
const instance = new WhatsAppWebProvider();

module.exports = instance;
