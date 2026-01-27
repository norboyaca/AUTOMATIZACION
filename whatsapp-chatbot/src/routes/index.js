/**
 * ===========================================
 * ÍNDICE DE RUTAS
 * ===========================================
 *
 * Responsabilidades:
 * - Agregar todas las rutas de la aplicación
 * - Servir como punto de montaje único
 *
 * Las rutas se montan en /api (ver app.js)
 */

const express = require('express');
const multer = require('multer');
const webhookRoutes = require('./webhook.routes');
const chatService = require('../services/chat.service');
const settingsService = require('../services/settings.service');
const knowledgeUploadService = require('../services/knowledge-upload.service');
const logger = require('../utils/logger');

const router = express.Router();

// Configuración de Multer para subida de archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB máximo
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.txt', '.pdf'];
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos TXT y PDF'));
    }
  }
});

// ===========================================
// MONTAJE DE RUTAS
// ===========================================

// Webhook de WhatsApp: /api/webhook
router.use('/webhook', webhookRoutes);

// ===========================================
// ENDPOINT DE PRUEBA DEL CHAT
// ===========================================
router.post('/test-chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    logger.info(`Test chat: "${message}"`);

    // Generar respuesta
    const response = await chatService.generateTextResponse('test-user', message);

    res.json({ response });
  } catch (error) {
    logger.error('Error en test-chat:', error);
    res.status(500).json({
      error: 'Error generando respuesta',
      details: error.message
    });
  }
});

// ===========================================
// ENDPOINTS DE CONFIGURACIÓN
// ===========================================

// Obtener configuración actual
router.get('/settings', (req, res) => {
  try {
    const settings = settingsService.getSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Error obteniendo settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Guardar configuración
router.post('/settings', (req, res) => {
  try {
    const { provider, groq, openai } = req.body;

    const success = settingsService.saveSettings({ provider, groq, openai });

    if (success) {
      // Recargar proveedores de IA con las nuevas keys
      reloadAIProviders();
      res.json({ success: true, message: 'Configuración guardada' });
    } else {
      res.status(500).json({ success: false, error: 'Error guardando configuración' });
    }
  } catch (error) {
    logger.error('Error guardando settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Probar conexión con proveedor
router.post('/test-connection', async (req, res) => {
  try {
    const { provider } = req.body;
    const keys = settingsService.getApiKeys();

    if (provider === 'groq') {
      if (!keys.groq.apiKey) {
        return res.json({ success: false, error: 'No hay API key de Groq configurada' });
      }

      // Probar conexión con Groq
      const OpenAI = require('openai');
      const client = new OpenAI({
        apiKey: keys.groq.apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      });

      const response = await client.chat.completions.create({
        model: keys.groq.model || 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'Di "OK" si funciona' }],
        max_tokens: 10
      });

      if (response.choices[0]?.message?.content) {
        res.json({ success: true, message: 'Conexión exitosa con Groq' });
      } else {
        res.json({ success: false, error: 'Respuesta vacía de Groq' });
      }

    } else if (provider === 'openai') {
      if (!keys.openai.apiKey) {
        return res.json({ success: false, error: 'No hay API key de OpenAI configurada' });
      }

      // Probar conexión con OpenAI
      const OpenAI = require('openai');
      const client = new OpenAI({
        apiKey: keys.openai.apiKey
      });

      const response = await client.chat.completions.create({
        model: keys.openai.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Di "OK" si funciona' }],
        max_tokens: 10
      });

      if (response.choices[0]?.message?.content) {
        res.json({ success: true, message: 'Conexión exitosa con OpenAI' });
      } else {
        res.json({ success: false, error: 'Respuesta vacía de OpenAI' });
      }

    } else {
      res.json({ success: false, error: 'Proveedor no válido' });
    }

  } catch (error) {
    logger.error('Error probando conexión:', error);
    res.json({ success: false, error: error.message });
  }
});

// ===========================================
// ENDPOINTS DE BASE DE CONOCIMIENTO
// ===========================================

// Subir archivo a la base de conocimiento
router.post('/knowledge/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se recibió ningún archivo' });
    }

    const result = await knowledgeUploadService.uploadFile(req.file);
    res.json({ success: true, file: result });

  } catch (error) {
    logger.error('Error subiendo archivo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar archivos de conocimiento
router.get('/knowledge/files', (req, res) => {
  try {
    const files = knowledgeUploadService.getUploadedFiles();
    res.json({ success: true, files });
  } catch (error) {
    logger.error('Error listando archivos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Eliminar archivo de conocimiento
router.delete('/knowledge/files/:id', (req, res) => {
  try {
    knowledgeUploadService.deleteFile(req.params.id);
    res.json({ success: true, message: 'Archivo eliminado' });
  } catch (error) {
    logger.error('Error eliminando archivo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Buscar en archivos de conocimiento
router.post('/knowledge/search', (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ success: false, error: 'Query requerida' });
    }

    const results = knowledgeUploadService.searchInFiles(query);
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error buscando:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Recarga los proveedores de IA con las nuevas configuraciones
 */
function reloadAIProviders() {
  try {
    // Limpiar cache del módulo para forzar recarga
    const aiProviderPath = require.resolve('../providers/ai');
    delete require.cache[aiProviderPath];

    const groqProviderPath = require.resolve('../providers/ai/groq.provider');
    delete require.cache[groqProviderPath];

    const openaiProviderPath = require.resolve('../providers/ai/openai.provider');
    delete require.cache[openaiProviderPath];

    logger.info('Proveedores de IA recargados');
  } catch (error) {
    logger.warn('Error recargando proveedores:', error.message);
  }
}

module.exports = router;
