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
const s3Service = require('./s3.service');

// ===========================================
// CONFIGURACIÓN
// ===========================================
const MAX_FILE_SIZE_BYTES = (config.media.maxFileSizeMB || 25) * 1024 * 1024;
const UPLOADS_BASE_DIR = path.resolve(config.media.uploadDir || './uploads');
const RETENTION_MS = 4 * 60 * 60 * 1000; // 4 horas de retención local (Hot Cache)

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

/**
 * Limpia archivos locales antiguos que ya están en S3
 * Se ejecuta automáticamente cada hora
 */
async function cleanupOldLocalFiles() {
    if (!config.s3.enabled) return;

    logger.info('🧹 [MEDIA-STORAGE] Iniciando limpieza de caché local...');
    const now = Date.now();
    let deletedCount = 0;
    let freedSpace = 0;

    for (const [id, info] of mediaIndex.entries()) {
        // Solo borrar si: 
        // 1. Está en S3 (info.s3Key)
        // 2. Es antiguo (> 4 horas)
        // 3. Existe archivo local
        if (info.s3Key && (now - (info.savedAt || 0) > RETENTION_MS)) {
            try {
                if (fs.existsSync(info.filePath)) {
                    await fsPromises.unlink(info.filePath);
                    deletedCount++;
                    freedSpace += (info.fileSize || 0);
                    // No actualizamos info.filePath para mantener la ruta "teórica" 
                    // getMediaBuffer detectará que no existe y bajará de S3
                }
            } catch (err) {
                logger.warn(`⚠️ [MEDIA-STORAGE] Error borrando archivo local ${id}: ${err.message}`);
            }
        }
    }

    if (deletedCount > 0) {
        logger.info(`🧹 [MEDIA-STORAGE] Limpieza completada: ${deletedCount} archivos eliminados, ${(freedSpace / 1024 / 1024).toFixed(2)} MB liberados`);
    } else {
        logger.debug('🧹 [MEDIA-STORAGE] Limpieza completada: Sin archivos para borrar');
    }
}

// Programar limpieza cada hora
setInterval(cleanupOldLocalFiles, 60 * 60 * 1000);

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
        const MAX_RETRIES = 3;
        const DOWNLOAD_TIMEOUT_MS = 60000; // 60 segundos timeout por intento
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Envolver en Promise con timeout para evitar descargas colgadas
                const downloadPromise = downloadMediaMessage(
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

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Timeout descargando media (${DOWNLOAD_TIMEOUT_MS / 1000}s)`)), DOWNLOAD_TIMEOUT_MS)
                );

                const stream = await Promise.race([downloadPromise, timeoutPromise]);
                buffer = Buffer.isBuffer(stream) ? stream : Buffer.from(stream);
                lastError = null;
                break; // Descarga exitosa, salir del loop
            } catch (downloadError) {
                lastError = downloadError;
                const isRetryable = downloadError.message?.includes('terminated')
                    || downloadError.message?.includes('ECONNRESET')
                    || downloadError.message?.includes('Timeout')
                    || downloadError.code === 'ECONNRESET'
                    || downloadError.cause?.code === 'ECONNRESET';

                if (isRetryable && attempt < MAX_RETRIES) {
                    const waitMs = attempt * 2000; // 2s, 4s backoff
                    logger.warn(`⚠️ [MEDIA-STORAGE] Intento ${attempt}/${MAX_RETRIES} falló (${downloadError.message}), reintentando en ${waitMs / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitMs));
                } else {
                    logger.error(`❌ [MEDIA-STORAGE] Error descargando media (intento ${attempt}/${MAX_RETRIES}): ${downloadError.message}`);
                    break;
                }
            }
        }

        if (lastError || !buffer) {
            logger.error(`❌ [MEDIA-STORAGE] No se pudo descargar media después de ${MAX_RETRIES} intentos`);
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
            s3Key: null // Se actualizará tras subida a S3
        };

        // Subir a S3 en segundo plano (fire & forget para no bloquear responsividad)
        // Pero actualizamos el índice cuando termine
        if (config.s3.enabled) {
            const s3Key = s3Service.generateS3Key(mimeType, uniqueName, chatId);
            s3Service.uploadFile(s3Key, buffer, mimeType)
                .then(result => {
                    if (result) {
                        mediaInfo.s3Key = result.s3Key;
                        mediaIndex.set(messageId, mediaInfo);
                        _saveIndex();
                        logger.info(`☁️ [MEDIA-STORAGE] Sync S3 completado: ${result.s3Key}`);
                    }
                })
                .catch(err => logger.error(`❌ [MEDIA-STORAGE] Error sync S3: ${err.message}`));
        }

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

/**
 * Guarda un archivo enviado desde el dashboard (Outbound)
 *
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {string} mimeType
 * @param {string} userId (chatId)
 * @returns {Object} mediaInfo
 */
async function saveOutboundMedia(buffer, fileName, mimeType, userId) {
    try {
        const messageId = `out_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const chatId = userId.replace('@s.whatsapp.net', '');
        const ext = MIME_TO_EXT[mimeType] || '.bin';
        const uniqueName = `${chatId}_${messageId}${ext}`;

        // Guardar local
        const chatDir = await ensureUploadDir(chatId);
        const filePath = path.join(chatDir, uniqueName);
        await fsPromises.writeFile(filePath, buffer);

        // Metadata
        const mediaInfo = {
            mediaUrl: `/api/media/download/${messageId}`,
            fileName,
            mimeType,
            fileSize: buffer.length,
            filePath,
            mediaType: mimeType.split('/')[0],
            chatId,
            savedAt: Date.now(),
            s3Key: null
        };

        // Subir a S3
        if (config.s3.enabled) {
            const s3Key = s3Service.generateS3Key(mimeType, uniqueName, chatId);
            const s3Result = await s3Service.uploadFile(s3Key, buffer, mimeType);
            if (s3Result) {
                mediaInfo.s3Key = s3Result.s3Key;
            }
        }

        mediaIndex.set(messageId, mediaInfo);
        _saveIndex();

        return { ...mediaInfo, messageId };
    } catch (error) {
        logger.error(`❌ [MEDIA-STORAGE] Error guardando outbound media: ${error.message}`);
        throw error;
    }
}

/**
 * Obtiene el buffer del archivo (Local > S3)
 */
async function getMediaBuffer(messageId) {
    const info = mediaIndex.get(messageId);
    if (!info) return null;

    // 1. Intentar local
    try {
        if (fs.existsSync(info.filePath)) {
            return await fsPromises.readFile(info.filePath);
        }
    } catch (e) { /* ignore */ }

    // 2. Intentar S3
    if (config.s3.enabled && info.s3Key) {
        logger.info(`☁️ [MEDIA-STORAGE] Recuperando ${messageId} desde S3...`);
        const buffer = await s3Service.downloadFile(info.s3Key);
        // Restaurar caché local si se descarga
        if (buffer) {
            try {
                const dir = path.dirname(info.filePath);
                if (!fs.existsSync(dir)) await fsPromises.mkdir(dir, { recursive: true });
                await fsPromises.writeFile(info.filePath, buffer);
            } catch (err) {
                logger.warn(`⚠️ [MEDIA-STORAGE] No se pudo restaurar caché local: ${err.message}`);
            }
        }
        return buffer;
    }

    return null;
}

module.exports = {
    saveMediaFromMessage,
    saveOutboundMedia,
    getMediaInfo,
    getMediaBuffer,
    cleanupOldLocalFiles,
    hasMedia,
    getStats,
    ensureUploadDir,
};
