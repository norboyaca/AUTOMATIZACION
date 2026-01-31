/**
 * ===========================================
 * ÍNDICE DE PROVEEDORES WHATSAPP
 * ===========================================
 *
 * Responsabilidades:
 * - Exportar el proveedor activo según configuración
 * - Implementar patrón Factory/Strategy
 * - Abstraer la selección del proveedor
 *
 * USO:
 * const whatsappProvider = require('./providers/whatsapp');
 * await whatsappProvider.sendMessage(to, message);
 *
 * El código que usa este módulo NO necesita saber
 * si está usando Meta o Twilio.
 */

const config = require('../../config');
const MetaProvider = require('./meta.provider');
const TwilioProvider = require('./twilio.provider');
const BaileysProvider = require('./baileys.provider');

// ===========================================
// FACTORY DE PROVEEDORES
// ===========================================

let providerInstance = null;

/**
 * Obtiene la instancia del proveedor activo
 * Implementa patrón Singleton para reutilizar conexión
 */
const getProvider = () => {
  if (providerInstance) {
    return providerInstance;
  }

  const providerType = config.whatsapp.provider;

  switch (providerType) {
    case 'meta':
      providerInstance = new MetaProvider(config.whatsapp.meta);
      break;
    case 'twilio':
      providerInstance = new TwilioProvider(config.whatsapp.twilio);
      break;
    case 'baileys':
      // BaileysProvider ya es un singleton, no hay que instanciarlo
      providerInstance = BaileysProvider;
      break;
    default:
      throw new Error(`Proveedor WhatsApp no soportado: ${providerType}`);
  }

  return providerInstance;
};

// ===========================================
// EXPORTAR MÉTODOS DEL PROVEEDOR ACTIVO
// ===========================================
// Esto permite usar el módulo directamente:
// whatsappProvider.sendMessage(...)

module.exports = {
  /**
   * Envía un mensaje de texto
   * @param {string} to - Número de destino
   * @param {string|Object} message - Mensaje a enviar
   */
  sendMessage: (to, message) => getProvider().sendMessage(to, message),

  /**
   * Envía una imagen
   * @param {string} to - Número de destino
   * @param {string} imageUrl - URL de la imagen
   * @param {string} caption - Texto opcional
   */
  sendImage: (to, imageUrl, caption) => getProvider().sendImage(to, imageUrl, caption),

  /**
   * Envía un documento
   * @param {string} to - Número de destino
   * @param {string} documentUrl - URL del documento
   * @param {string} filename - Nombre del archivo
   */
  sendDocument: (to, documentUrl, filename) => getProvider().sendDocument(to, documentUrl, filename),

  /**
   * Obtiene la URL de descarga de un archivo multimedia
   * @param {string} mediaId - ID del archivo
   * @returns {Promise<string>} URL de descarga
   */
  getMediaUrl: (mediaId) => getProvider().getMediaUrl(mediaId),

  /**
   * Descarga un archivo multimedia
   * @param {string} url - URL del archivo
   * @returns {Promise<Buffer>} Contenido del archivo
   */
  downloadMedia: (url) => getProvider().downloadMedia(url),

  /**
   * Marca un mensaje como leído
   * @param {string} messageId - ID del mensaje
   */
  markAsRead: (messageId) => getProvider().markAsRead(messageId),

  // Exponer factory por si se necesita acceso directo
  getProvider
};
