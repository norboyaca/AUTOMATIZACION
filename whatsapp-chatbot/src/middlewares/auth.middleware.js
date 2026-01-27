/**
 * ===========================================
 * MIDDLEWARE DE AUTENTICACIÓN
 * ===========================================
 *
 * Responsabilidades:
 * - Verificar firmas de webhooks (seguridad)
 * - Validar tokens de API
 * - Proteger rutas sensibles
 *
 * SEGURIDAD: Los webhooks de WhatsApp incluyen
 * una firma HMAC que debe verificarse para
 * prevenir ataques de suplantación.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Verifica la firma del webhook de Meta
 * Meta envía la firma en el header X-Hub-Signature-256
 */
const verifyWebhookSignature = (req, res, next) => {
  // TODO: Implementar verificación de firma según proveedor

  if (config.whatsapp.provider === 'meta') {
    return verifyMetaSignature(req, res, next);
  }

  if (config.whatsapp.provider === 'twilio') {
    return verifyTwilioSignature(req, res, next);
  }

  // Si no hay proveedor configurado, continuar (solo en desarrollo)
  if (config.server.isDevelopment) {
    logger.warn('Verificación de firma omitida en desarrollo');
    return next();
  }

  return res.status(401).json({ error: 'Proveedor no configurado' });
};

/**
 * Verificación de firma para Meta (Facebook)
 */
const verifyMetaSignature = (req, res, next) => {
  // TODO: Implementar verificación HMAC-SHA256
  // const signature = req.headers['x-hub-signature-256'];
  // const expectedSignature = crypto
  //   .createHmac('sha256', APP_SECRET)
  //   .update(JSON.stringify(req.body))
  //   .digest('hex');

  // Por ahora, pasar en desarrollo
  if (config.server.isDevelopment) {
    return next();
  }

  // Placeholder para implementación
  logger.debug('Verificando firma Meta...');
  next();
};

/**
 * Verificación de firma para Twilio
 */
const verifyTwilioSignature = (req, res, next) => {
  // TODO: Implementar verificación de Twilio
  // Usar twilio.validateRequest()

  if (config.server.isDevelopment) {
    return next();
  }

  logger.debug('Verificando firma Twilio...');
  next();
};

module.exports = {
  verifyWebhookSignature,
  verifyMetaSignature,
  verifyTwilioSignature
};
