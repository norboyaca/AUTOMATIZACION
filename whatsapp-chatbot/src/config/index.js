/**
 * ===========================================
 * CONFIGURACIÓN CENTRALIZADA
 * ===========================================
 *
 * Responsabilidades:
 * - Exportar toda la configuración desde un único punto
 * - Validar que las variables requeridas existan
 * - Proveer valores por defecto seguros
 *
 * USO:
 * const config = require('./config');
 * console.log(config.server.port);
 */

const openaiConfig = require('./openai.config');
const whatsappConfig = require('./whatsapp.config');

// ===========================================
// CONFIGURACIÓN DEL SERVIDOR
// ===========================================
const server = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production'
};

// ===========================================
// CONFIGURACIÓN DE ARCHIVOS/MEDIA
// ===========================================
const media = {
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 25,
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  // Agregado webm para audio grabado en navegador
  allowedExtensions: (process.env.ALLOWED_EXTENSIONS || 'jpg,jpeg,png,gif,webp,mp3,ogg,webm,mp4,3gp,pdf,doc,docx,xls,xlsx').split(',')
};

// ===========================================
// CONFIGURACIÓN DE LOGGING
// ===========================================
const logging = {
  level: process.env.LOG_LEVEL || 'debug',
  dir: process.env.LOG_DIR || './logs'
};

// ===========================================
// CONFIGURACIÓN DE AWS S3
// ===========================================
const s3 = {
  bucket: process.env.AWS_S3_BUCKET || '',
  region: process.env.AWS_REGION || 'us-east-1',
  enabled: !!process.env.AWS_S3_BUCKET
};

// ===========================================
// EXPORTAR CONFIGURACIÓN COMPLETA
// ===========================================
module.exports = {
  server,
  media,
  logging,
  s3,
  openai: openaiConfig,
  whatsapp: whatsappConfig
};
