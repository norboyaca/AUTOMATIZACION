/**
 * ===========================================
 * RUTAS DE MEDIA (DESCARGA DE ARCHIVOS)
 * ===========================================
 *
 * Endpoint seguro para descargar archivos
 * multimedia almacenados por el sistema.
 *
 * GET /api/media/download/:messageId
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const mediaStorageService = require('../services/media-storage.service');
const { requireAuth } = require('../middlewares/auth.middleware');

const router = express.Router();

/**
 * GET /download/:messageId
 *
 * Descarga un archivo multimedia por su messageId.
 * Requiere autenticación.
 */
router.get('/download/:messageId', requireAuth, (req, res) => {
    try {
        const { messageId } = req.params;

        if (!messageId) {
            return res.status(400).json({
                success: false,
                error: 'messageId es requerido'
            });
        }

        // Buscar archivo en el índice
        const mediaInfo = mediaStorageService.getMediaInfo(messageId);

        if (!mediaInfo) {
            logger.warn(`⚠️ [MEDIA-ROUTE] Archivo no encontrado para messageId: ${messageId}`);
            return res.status(404).json({
                success: false,
                error: 'Archivo no encontrado'
            });
        }

        // Verificar que el archivo exista en disco
        if (!fs.existsSync(mediaInfo.filePath)) {
            logger.error(`❌ [MEDIA-ROUTE] Archivo en índice pero no en disco: ${mediaInfo.filePath}`);
            return res.status(404).json({
                success: false,
                error: 'Archivo no disponible'
            });
        }

        // Determinar nombre para descarga
        const downloadName = mediaInfo.fileName || path.basename(mediaInfo.filePath);

        // Configurar headers para descarga
        res.setHeader('Content-Type', mediaInfo.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', mediaInfo.fileSize);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);

        // Stream del archivo al cliente
        const fileStream = fs.createReadStream(mediaInfo.filePath);
        fileStream.pipe(res);

        fileStream.on('error', (err) => {
            logger.error(`❌ [MEDIA-ROUTE] Error streaming archivo: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Error leyendo archivo' });
            }
        });

        logger.info(`📤 [MEDIA-ROUTE] Descargando ${mediaInfo.mediaType}: ${downloadName}`);

    } catch (error) {
        logger.error(`❌ [MEDIA-ROUTE] Error en descarga:`, error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

/**
 * GET /stream/:messageId
 *
 * Sirve un archivo multimedia para reproducción directa (audio/imagen).
 * No fuerza descarga, permite inline playback.
 * Requiere autenticación.
 */
router.get('/stream/:messageId', requireAuth, (req, res) => {
    try {
        const { messageId } = req.params;
        const mediaInfo = mediaStorageService.getMediaInfo(messageId);

        if (!mediaInfo || !fs.existsSync(mediaInfo.filePath)) {
            return res.status(404).json({ success: false, error: 'Archivo no encontrado' });
        }

        // Para streaming inline (audio player, image preview)
        res.setHeader('Content-Type', mediaInfo.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', mediaInfo.fileSize);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(mediaInfo.fileName || 'file')}"`);
        // No-cache para evitar problemas de autenticación en caché
        res.setHeader('Cache-Control', 'private, no-cache');

        const fileStream = fs.createReadStream(mediaInfo.filePath);
        fileStream.pipe(res);

        fileStream.on('error', (err) => {
            logger.error(`❌ [MEDIA-ROUTE] Error streaming: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Error leyendo archivo' });
            }
        });

    } catch (error) {
        logger.error(`❌ [MEDIA-ROUTE] Error en stream:`, error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

/**
 * GET /stats
 *
 * Estadísticas del almacenamiento de media.
 */
router.get('/stats', requireAuth, (req, res) => {
    try {
        const stats = mediaStorageService.getStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
