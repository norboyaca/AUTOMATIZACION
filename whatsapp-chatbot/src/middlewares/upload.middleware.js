/**
 * ===========================================
 * MIDDLEWARE DE SUBIDA DE ARCHIVOS
 * ===========================================
 *
 * Responsabilidades:
 * - Configurar multer para recepción de archivos
 * - Validar tipos de archivo permitidos
 * - Limitar tamaño de archivos
 * - Definir destino de almacenamiento temporal
 *
 * NOTA: Los archivos de WhatsApp vienen como URLs,
 * no como uploads directos. Este middleware es para
 * rutas adicionales que requieran subida de archivos.
 */

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { AppError } = require('./error.middleware');

// ===========================================
// CONFIGURACIÓN DE ALMACENAMIENTO
// ===========================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.media.uploadDir);
  },
  filename: (req, file, cb) => {
    // Generar nombre único para evitar colisiones
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// ===========================================
// FILTRO DE TIPOS DE ARCHIVO
// ===========================================
const fileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname).toLowerCase().slice(1);

  if (config.media.allowedExtensions.includes(extension)) {
    cb(null, true);
  } else {
    cb(new AppError(
      `Tipo de archivo no permitido: ${extension}`,
      400,
      'INVALID_FILE_TYPE'
    ), false);
  }
};

// ===========================================
// CONFIGURACIÓN DE MULTER
// ===========================================
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.media.maxFileSizeMB * 1024 * 1024, // Convertir MB a bytes
    files: 5 // Máximo de archivos por petición
  }
});

// ===========================================
// MIDDLEWARES EXPORTADOS
// ===========================================

// Para un solo archivo
const single = (fieldName = 'file') => upload.single(fieldName);

// Para múltiples archivos del mismo campo
const multiple = (fieldName = 'files', maxCount = 5) =>
  upload.array(fieldName, maxCount);

// Para campos específicos
const fields = (fieldsConfig) => upload.fields(fieldsConfig);

module.exports = {
  single,
  multiple,
  fields,
  upload // Exportar instancia completa por si se necesita
};
