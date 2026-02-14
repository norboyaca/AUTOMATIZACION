/**
 * ===========================================
 * SERVICIO DE ALMACENAMIENTO DE MEDIA
 * ===========================================
 *
 * Responsabilidades:
 * - Descargar archivos multimedia de mensajes de Baileys
 * - Guardarlos persistentemente en disco
 * - Proveer acceso por messageId para descarga
 * - Validar tamaño máximo permitido
 *
 * IMPORTANTE: Este servicio NO modifica la lógica de mensajes.
 * Solo agrega almacenamiento persistente.
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const config = require('../config');
const logger = require('../utils/logger');

// ===========================================
// CONFIGURACIÓN
// ===========================================
const MAX_FILE_SIZE_BYTES = (config.media.maxFileSizeMB || 25) * 1024 * 1024;
const UPLOADS_BASE_DIR = path.resolve(config.media.uploadDir || './uploads');

// Mapa en memoria: messageId → { filePath, fileName, mimeType, fileSize }
const mediaIndex = new Map();

// ===========================================
// PERSISTENCIA DEL ÍNDICE EN DISCO
// ===========================================
const INDEX_FILE_PATH = path.join(UPLOADS_BASE_DIR, 'media-index.json');

/**
 * Carga el índice desde disco al iniciar
 */
function _loadIndex() {
    try {
        if (fs.existsSync(INDEX_FILE_PATH)) {
            const raw = fs.readFileSync(INDEX_FILE_PATH, 'utf-8');
            const entries = JSON.parse(raw);
            for (const [key, value] of entries) {
                mediaIndex.set(key, value);
            }
            logger.info(`📂 [MEDIA-STORAGE] Índice cargado: ${mediaIndex.size} archivos`);
        }
    } catch (err) {
        logger.warn(`⚠️ [MEDIA-STORAGE] Error cargando índice: ${err.message}`);
    }
}

/**
 * Guarda el índice en disco (debounced para evitar escrituras excesivas)
 */
let _saveTimeout = null;
function _saveIndex() {
    if (_saveTimeout) clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
        try {
            // Asegurar que el directorio base existe
            if (!fs.existsSync(UPLOADS_BASE_DIR)) {
                fs.mkdirSync(UPLOADS_BASE_DIR, { recursive: true });
            }
            const entries = Array.from(mediaIndex.entries());
            fs.writeFileSync(INDEX_FILE_PATH, JSON.stringify(entries, null, 2), 'utf-8');
            logger.debug(`💾 [MEDIA-STORAGE] Índice guardado: ${entries.length} archivos`);
        } catch (err) {
            logger.error(`❌ [MEDIA-STORAGE] Error guardando índice: ${err.message}`);
        }
    }, 500); // debounce 500ms
}

// Cargar índice al iniciar el módulo
_loadIndex();

// ===========================================
// EXTENSIONES POR MIME TYPE
// ===========================================
const MIME_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/ogg; codecs=opus': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
};

/**
 * Asegura que el directorio de uploads exista
 */
async function ensureUploadDir(subDir = '') {
    const dir = subDir ? path.join(UPLOADS_BASE_DIR, subDir) : UPLOADS_BASE_DIR;
    try {
        await fsPromises.mkdir(dir, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') {
            logger.error(`Error creando directorio de uploads: ${dir}`, err);
            throw err;
        }
    }
    return dir;
}

/**
 * Descarga y guarda un archivo multimedia de un mensaje de Baileys
 *
 * @param {Object} transformedMessage - Mensaje transformado con _original
 * @returns {Object|null} { mediaUrl, fileName, mimeType, fileSize } o null si falla
 */
async function saveMediaFromMessage(transformedMessage) {
    try {
        const originalMsg = transformedMessage._original || transformedMessage;
        const msgKey = originalMsg.key || transformedMessage.id;
        const messageId = typeof msgKey === 'object' ? msgKey.id : msgKey;
        const chatId = typeof msgKey === 'object'
            ? (msgKey.remoteJid || '').replace('@s.whatsapp.net', '').replace('@g.us', '')
            : 'unknown';

        if (!messageId) {
            logger.warn('⚠️ [MEDIA-STORAGE] No se puede guardar media sin messageId');
            return null;
        }

        // Evitar duplicados
        if (mediaIndex.has(messageId)) {
            logger.debug(`⏭️ [MEDIA-STORAGE] Media ya guardada para ${messageId}`);
            return mediaIndex.get(messageId);
        }

        // Detectar tipo de media y metadata
        const message = originalMsg.message || {};
        let mimeType = '';
        let fileName = '';
        let mediaType = '';

        if (message.imageMessage) {
            mimeType = message.imageMessage.mimetype || 'image/jpeg';
            fileName = message.imageMessage.caption || '';
            mediaType = 'image';
        } else if (message.audioMessage) {
            mimeType = message.audioMessage.mimetype || 'audio/ogg';
            fileName = '';
            mediaType = 'audio';
        } else if (message.pttMessage) {
            mimeType = message.pttMessage.mimetype || 'audio/ogg';
            fileName = '';
            mediaType = 'audio';
        } else if (message.documentMessage) {
            mimeType = message.documentMessage.mimetype || 'application/octet-stream';
            fileName = message.documentMessage.fileName || 'documento';
            mediaType = 'document';
        } else if (message.videoMessage) {
            mimeType = message.videoMessage.mimetype || 'video/mp4';
            fileName = message.videoMessage.caption || '';
            mediaType = 'video';
        } else {
            logger.debug(`⏭️ [MEDIA-STORAGE] Mensaje sin media descargable`);
            return null;
        }

        // Determinar extensión
        const ext = MIME_TO_EXT[mimeType] || MIME_TO_EXT[mimeType.split(';')[0]] || '.bin';

        // Generar nombre de archivo único
        const timestamp = Date.now();
        const safeFileName = fileName
            ? fileName.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 50)
            : `${mediaType}_${timestamp}`;
        const uniqueName = `${chatId}_${messageId}_${timestamp}${ext}`;

        // Crear subdirectorio por chat
        const chatDir = await ensureUploadDir(chatId);
        const filePath = path.join(chatDir, uniqueName);

        // Descargar media de Baileys
        logger.info(`📥 [MEDIA-STORAGE] Descargando ${mediaType} de mensaje ${messageId}...`);

        let buffer;
        try {
            const stream = await downloadMediaMessage(
                originalMsg,
                'buffer',
                {},
                {
                    logger: {
                        info: () => { },
                        error: (...args) => logger.error(...args),
                        warn: (...args) => logger.warn(...args),
                        debug: () => { },
                        trace: () => { },
                        child: () => ({
                            info: () => { },
                            error: (...args) => logger.error(...args),
                            warn: (...args) => logger.warn(...args),
                            debug: () => { },
                            trace: () => { },
                        }),
                    },
                    reuploadRequest: undefined,
                }
            );
            buffer = Buffer.isBuffer(stream) ? stream : Buffer.from(stream);
        } catch (downloadError) {
            logger.error(`❌ [MEDIA-STORAGE] Error descargando media: ${downloadError.message}`);
            return null;
        }

        // Validar tamaño
        if (buffer.length > MAX_FILE_SIZE_BYTES) {
            logger.warn(`⚠️ [MEDIA-STORAGE] Archivo excede el tamaño máximo (${(buffer.length / 1024 / 1024).toFixed(2)} MB > ${config.media.maxFileSizeMB} MB)`);
            return null;
        }

        // Guardar archivo a disco
        await fsPromises.writeFile(filePath, buffer);

        const fileSize = buffer.length;
        const mediaUrl = `/api/media/download/${messageId}`;
        const displayName = fileName || safeFileName;

        // Registrar en índice
        const mediaInfo = {
            mediaUrl,
            fileName: displayName,
            mimeType,
            fileSize,
            filePath,
            mediaType,
            chatId,
            savedAt: timestamp,
        };

        mediaIndex.set(messageId, mediaInfo);
        _saveIndex();

        logger.info(`✅ [MEDIA-STORAGE] ${mediaType} guardado: ${uniqueName} (${(fileSize / 1024).toFixed(1)} KB)`);
        logger.info(`   → Ruta: ${filePath}`);
        logger.info(`   → URL: ${mediaUrl}`);

        return mediaInfo;

    } catch (error) {
        logger.error(`❌ [MEDIA-STORAGE] Error guardando media:`, error);
        return null;
    }
}

/**
 * Obtiene la información de un archivo por messageId
 *
 * @param {string} messageId
 * @returns {Object|null} { filePath, fileName, mimeType, fileSize } o null
 */
function getMediaInfo(messageId) {
    return mediaIndex.get(messageId) || null;
}

/**
 * Verifica si existe media para un messageId
 *
 * @param {string} messageId
 * @returns {boolean}
 */
function hasMedia(messageId) {
    return mediaIndex.has(messageId);
}

/**
 * Obtiene estadísticas del almacenamiento
 */
function getStats() {
    return {
        totalFiles: mediaIndex.size,
        uploadsDir: UPLOADS_BASE_DIR,
        maxFileSizeMB: config.media.maxFileSizeMB || 25,
    };
}

module.exports = {
    saveMediaFromMessage,
    getMediaInfo,
    hasMedia,
    getStats,
    ensureUploadDir,
};
