/**
 * ===========================================
 * SERVICIO DE MEDIA (ARCHIVOS MULTIMEDIA)
 * ===========================================
 *
 * Responsabilidades:
 * - Descargar archivos multimedia de WhatsApp
 * - Almacenar archivos temporalmente
 * - Limpiar archivos después de procesarlos
 * - Convertir formatos si es necesario
 *
 * IMPORTANTE: Los archivos de WhatsApp vienen como
 * referencias (IDs o URLs). Este servicio se encarga
 * de obtener el archivo real.
 */

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const config = require('../config');
const whatsappProvider = require('../providers/whatsapp');

/**
 * Descarga un archivo multimedia de WhatsApp
 * @param {string} mediaId - ID del archivo en WhatsApp
 * @param {string} mimeType - Tipo MIME del archivo
 * @returns {Promise<string>} Path al archivo descargado
 */
const downloadMedia = async (mediaId, mimeType) => {
  try {
    logger.debug(`Descargando media: ${mediaId}`);

    // 1. Obtener URL de descarga del proveedor
    const mediaUrl = await whatsappProvider.getMediaUrl(mediaId);

    // 2. Descargar el archivo
    const buffer = await whatsappProvider.downloadMedia(mediaUrl);

    // 3. Determinar extensión según mime type
    const extension = getExtensionFromMime(mimeType);

    // 4. Guardar archivo temporal
    const filename = `${uuidv4()}${extension}`;
    const filepath = path.join(config.media.uploadDir, filename);

    await fs.writeFile(filepath, buffer);

    logger.info(`Media descargada: ${filepath}`);
    return filepath;

  } catch (error) {
    logger.error('Error descargando media:', error);
    throw error;
  }
};

/**
 * Elimina un archivo temporal
 * @param {string} filepath - Path al archivo
 */
const deleteMedia = async (filepath) => {
  try {
    await fs.unlink(filepath);
    logger.debug(`Archivo eliminado: ${filepath}`);
  } catch (error) {
    // No lanzar error si el archivo no existe
    if (error.code !== 'ENOENT') {
      logger.warn('Error eliminando archivo:', error);
    }
  }
};

/**
 * Limpia archivos antiguos del directorio de uploads
 * @param {number} maxAgeMinutes - Edad máxima en minutos
 */
const cleanupOldFiles = async (maxAgeMinutes = 60) => {
  try {
    const uploadDir = config.media.uploadDir;
    const files = await fs.readdir(uploadDir);
    const now = Date.now();
    const maxAge = maxAgeMinutes * 60 * 1000;

    let deletedCount = 0;

    for (const file of files) {
      // Ignorar .gitkeep y otros archivos del sistema
      if (file.startsWith('.')) continue;

      const filepath = path.join(uploadDir, file);
      const stats = await fs.stat(filepath);

      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filepath);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logger.info(`Limpieza: ${deletedCount} archivos eliminados`);
    }

  } catch (error) {
    logger.error('Error en limpieza de archivos:', error);
  }
};

/**
 * Obtiene la extensión de archivo según el MIME type
 */
const getExtensionFromMime = (mimeType) => {
  const mimeMap = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/webm': '.webm',  // ✅ Agregado para audio del navegador
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
  };

  return mimeMap[mimeType] || '.bin';
};

/**
 * Verifica si el tipo de archivo está permitido
 */
const isAllowedFileType = (mimeType) => {
  const extension = getExtensionFromMime(mimeType).slice(1); // Quitar el punto
  return config.media.allowedExtensions.includes(extension);
};

/**
 * Obtiene información de un archivo
 */
const getFileInfo = async (filepath) => {
  try {
    const stats = await fs.stat(filepath);
    return {
      path: filepath,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      created: stats.birthtime,
      modified: stats.mtime
    };
  } catch (error) {
    return null;
  }
};

/**
 * Formatea bytes a formato legible
 */
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * ===========================================
 * ✅ NUEVAS FUNCIONES PARA CARGA DE ARCHIVOS
 * ===========================================
 * Para enviar archivos desde el dashboard
 */

/**
 * Tipos de archivo permitidos para carga desde dashboard
 */
const ALLOWED_UPLOAD_TYPES = {
  audio: ['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/webm'],  // ✅ Agregado webm
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']  // ✅ Agregado PDF y Word
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Guarda un archivo subido desde el dashboard
 * @param {Object} file - Archivo desde multer o buffer
 * @param {string} type - Tipo de archivo ('audio', 'image', 'document')
 * @returns {Promise<Object>} Información del archivo guardado
 */
const saveUploadedFile = async (file, type) => {
  try {
    // Validar tamaño
    const fileSize = file.size || (file.buffer ? file.buffer.length : 0);
    if (fileSize > MAX_FILE_SIZE) {
      throw new Error(`Archivo demasiado grande. Máximo: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }

    // Validar tipo MIME
    const mimeType = file.mimetype;
    const allowedTypes = ALLOWED_UPLOAD_TYPES[type];
    if (!allowedTypes || !allowedTypes.includes(mimeType)) {
      throw new Error(`Tipo de archivo no permitido para ${type}: ${mimeType}`);
    }

    // Generar nombre único
    const extension = getExtensionFromMime(mimeType);
    const filename = `${Date.now()}_${uuidv4()}${extension}`;

    // ✅ NUEVO: Convertir a ruta absoluta
    const baseUploadDir = path.resolve(config.media.uploadDir);
    const uploadDir = path.join(baseUploadDir, type);

    // Crear directorio si no existe
    await fs.mkdir(uploadDir, { recursive: true });

    // Guardar archivo
    const filepath = path.join(uploadDir, filename);

    if (file.buffer) {
      // Archivo desde memoria (multer memoryStorage)
      await fs.writeFile(filepath, file.buffer);
    } else if (file.path) {
      // Archivo temporal (multer diskStorage)
      await fs.copyFile(file.path, filepath);
    }

    logger.info(`Archivo guardado: ${filepath} (${type})`);

    return {
      filename,
      filepath,  // ✅ Ruta absoluta al archivo
      originalname: file.originalname || 'archivo',
      mimetype: mimeType,
      size: fileSize,
      type,
      // ✅ URL completa para frontend - incluir /api/conversations
      url: `/api/conversations/uploads/${type}/${filename}`
    };
  } catch (error) {
    logger.error('Error guardando archivo subido:', error);
    throw error;
  }
};

/**
 * Obtiene un archivo por su URL relativa
 * @param {string} url - URL relativa del archivo
 * @returns {Promise<Object>} Información del archivo
 */
const getFileByUrl = async (url) => {
  try {
    // Extraer tipo y nombre de la URL: /uploads/audio/file.mp3
    const match = url.match(/\/uploads\/(\w+)\/(.+)/);
    if (!match) {
      throw new Error('URL inválida');
    }

    const [, type, filename] = match;
    const filepath = path.join(config.media.uploadDir, type, filename);

    const stats = await fs.stat(filepath);
    const fileBuffer = await fs.readFile(filepath);

    return {
      filepath,
      buffer: fileBuffer,
      mimetype: getMimeTypeFromFilename(filename),
      size: stats.size
    };
  } catch (error) {
    logger.error('Error obteniendo archivo por URL:', error);
    throw error;
  }
};

/**
 * Obtiene el MIME type según el nombre de archivo
 */
const getMimeTypeFromFilename = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',  // ✅ Agregado para audio del navegador
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };

  return mimeMap[ext] || 'application/octet-stream';
};

/**
 * Valida un archivo antes de subirlo
 * @param {Object} file - Archivo a validar
 * @param {string} type - Tipo esperado
 * @returns {Object}} Resultado de validación
 */
const validateUploadedFile = (file, type) => {
  const errors = [];

  // Validar tamaño
  const fileSize = file.size || (file.buffer ? file.buffer.length : 0);
  if (fileSize > MAX_FILE_SIZE) {
    errors.push(`Archivo excede los ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  // Validar tipo MIME
  const mimeType = file.mimetype;
  const allowedTypes = ALLOWED_UPLOAD_TYPES[type];
  if (!allowedTypes) {
    errors.push(`Tipo de archivo no válido: ${type}`);
  } else if (!allowedTypes.includes(mimeType)) {
    errors.push(`Tipo MIME no permitido: ${mimeType}. Permitidos: ${allowedTypes.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

module.exports = {
  downloadMedia,
  deleteMedia,
  cleanupOldFiles,
  getExtensionFromMime,
  isAllowedFileType,
  getFileInfo,
  // ✅ Nuevas funciones
  saveUploadedFile,
  getFileByUrl,
  getMimeTypeFromFilename,
  validateUploadedFile,
  // Constantes
  ALLOWED_UPLOAD_TYPES,
  MAX_FILE_SIZE
};
