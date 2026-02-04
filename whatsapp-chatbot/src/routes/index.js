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
const authRoutes = require('./auth.routes');
const conversationsRoutes = require('./conversations.routes');
const { requireAuth } = require('../middlewares/auth.middleware');
const chatService = require('../services/chat.service');
const settingsService = require('../services/settings.service');
const knowledgeUploadService = require('../services/knowledge-upload.service');
const stagesService = require('../services/stages.service');
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

// Rutas de autenticación: /api/auth/*
router.use('/auth', authRoutes);

// Rutas de conversaciones: /api/conversations/*
router.use('/conversations', conversationsRoutes);

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
// ENDPOINTS DE CONFIGURACIÓN (PROTEGIDOS)
// ===========================================

// Obtener configuración actual
router.get('/settings', requireAuth, (req, res) => {
  try {
    const settings = settingsService.getSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Error obteniendo settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Guardar configuración
router.post('/settings', requireAuth, (req, res) => {
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
router.post('/test-connection', requireAuth, async (req, res) => {
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
// ✅ NUEVO: ENDPOINTS DE CONFIGURACIÓN DE IA
// ===========================================

/**
 * GET /api/ai-settings
 * Obtiene la configuración actual de proveedores de IA
 */
router.get('/ai-settings', requireAuth, (req, res) => {
  try {
    const settings = settingsService.getSettings();

    res.json({
      success: true,
      settings: {
        chatgpt: {
          enabled: settings.openai.enabled,
          available: settings.openaiAvailable,
          model: settings.openai.model,
          apiKeyConfigured: !!settings.openai.apiKey
        },
        grok: {
          enabled: settings.groq.enabled,
          available: settings.groqAvailable,
          model: settings.groq.model,
          apiKeyConfigured: !!settings.groq.apiKey
        }
      },
      // Información de prioridad (solo informativo)
      priority: {
        primary: 'chatgpt',
        fallback: 'grok',
        note: 'ChatGPT es siempre el proveedor primario. Grok actúa como fallback.'
      }
    });
  } catch (error) {
    logger.error('Error obteniendo configuración de IA:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/ai-settings
 * Actualiza la configuración de proveedores de IA
 *
 * Body esperado:
 * {
 *   chatgpt: { enabled: true/false },
 *   grok: { enabled: true/false }
 * }
 *
 * NOTA: NO se permite cambiar la prioridad. Siempre es ChatGPT → Grok
 */
router.put('/ai-settings', requireAuth, (req, res) => {
  try {
    const { chatgpt, grok } = req.body;

    // Preparar objeto de configuración
    const newSettings = {};

    // Actualizar estado de ChatGPT (OpenAI)
    if (chatgpt && typeof chatgpt.enabled === 'boolean') {
      newSettings.openai = { enabled: chatgpt.enabled };
      logger.info(`🤖 ChatGPT ${chatgpt.enabled ? 'ACTIVADO' : 'DESACTIVADO'}`);
    }

    // Actualizar estado de Grok
    if (grok && typeof grok.enabled === 'boolean') {
      newSettings.groq = { enabled: grok.enabled };
      logger.info(`🤖 Grok ${grok.enabled ? 'ACTIVADO' : 'DESACTIVADO'}`);
    }

    // Verificar que al menos uno esté habilitado
    const currentSettings = settingsService.getApiKeys();
    const chatgptWillBeEnabled = newSettings.openai?.enabled ?? currentSettings.openai.enabled;
    const grokWillBeEnabled = newSettings.groq?.enabled ?? currentSettings.groq.enabled;

    if (!chatgptWillBeEnabled && !grokWillBeEnabled) {
      return res.status(400).json({
        success: false,
        error: 'Debe mantener al menos un proveedor de IA activo',
        warning: 'No se puede desactivar ambos proveedores simultáneamente'
      });
    }

    // Guardar configuración
    const success = settingsService.saveSettings(newSettings);

    if (success) {
      // Reinicializar proveedores dinámicamente (SIN reiniciar servidor)
      const aiProvider = require('../providers/ai');
      aiProvider.reinitializeProviders();

      res.json({
        success: true,
        message: 'Configuración de IA actualizada',
        settings: {
          chatgpt: { enabled: chatgptWillBeEnabled },
          grok: { enabled: grokWillBeEnabled }
        }
      });
    } else {
      res.status(500).json({ success: false, error: 'Error guardando configuración' });
    }

  } catch (error) {
    logger.error('Error actualizando configuración de IA:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===========================================
// ENDPOINTS DE BASE DE CONOCIMIENTO
// ===========================================

// Subir archivo a la base de conocimiento
// ✅ CORREGIDO: stageId es OBLIGATORIO
router.post('/knowledge/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se recibió ningún archivo' });
    }

    // ✅ CORREGIDO: stageId es OBLIGATORIO - no permitir subida sin etapa
    const stageId = req.body.stageId || req.query.stageId || null;

    if (!stageId) {
      logger.warn('⚠️ Intento de subir archivo sin stageId');
      return res.status(400).json({
        success: false,
        error: 'Debe seleccionar una etapa antes de subir el documento'
      });
    }

    // Verificar que la etapa existe
    const stage = stagesService.getStageById(stageId);
    if (!stage) {
      logger.warn(`⚠️ Etapa no encontrada: ${stageId}`);
      return res.status(400).json({
        success: false,
        error: 'La etapa seleccionada no existe'
      });
    }

    logger.info(`📤 Subiendo archivo a etapa: ${stage.name} (${stageId})`);
    const result = await knowledgeUploadService.uploadFile(req.file, stageId);
    res.json({ success: true, file: result });

  } catch (error) {
    logger.error('Error subiendo archivo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar archivos de conocimiento
router.get('/knowledge/files', requireAuth, (req, res) => {
  try {
    const files = knowledgeUploadService.getUploadedFiles();
    res.json({ success: true, files });
  } catch (error) {
    logger.error('Error listando archivos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Eliminar archivo de conocimiento
router.delete('/knowledge/files/:id', requireAuth, (req, res) => {
  try {
    knowledgeUploadService.deleteFile(req.params.id);
    res.json({ success: true, message: 'Archivo eliminado' });
  } catch (error) {
    logger.error('Error eliminando archivo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ NUEVO: Descargar archivo de conocimiento
router.get('/knowledge/download/:id', requireAuth, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');

    const fileId = req.params.id;
    const files = knowledgeUploadService.getUploadedFiles();
    const file = files.find(f => f.id === fileId);

    if (!file) {
      return res.status(404).json({ success: false, error: 'Archivo no encontrado' });
    }

    // ✅ MEJORADO: Usar ruta relativa si existe, sino buscar en ubicación principal
    let filePath;
    if (file.relativePath) {
      // Usar ruta relativa para mantener compatibilidad con carpetas
      filePath = path.join(process.cwd(), 'knowledge_files', file.relativePath);
    } else {
      // Compatibilidad con archivos antiguos (sin relativePath)
      filePath = path.join(process.cwd(), 'knowledge_files', file.fileName);

      // Si no existe en la ubicación principal, buscar en subcarpetas
      if (!fs.existsSync(filePath) && file.stageId) {
        const stagesService = require('../services/stages.service');
        const stageFolder = stagesService.getStageFolder(file.stageId);
        filePath = path.join(stageFolder, file.fileName);
      }
    }

    // Verificar que el archivo existe físicamente
    if (!fs.existsSync(filePath)) {
      logger.error(`Archivo no encontrado en disco: ${filePath}`);
      return res.status(404).json({ success: false, error: 'El archivo no existe en el servidor' });
    }

    // Enviar el archivo
    res.download(filePath, file.originalName, (err) => {
      if (err) {
        logger.error('Error descargando archivo:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Error al descargar el archivo' });
        }
      }
    });

    logger.info(`📥 Archivo descargado: ${file.originalName} (${file.size} bytes)`);
  } catch (error) {
    logger.error('Error en descarga:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Buscar en archivos de conocimiento
router.post('/knowledge/search', requireAuth, (req, res) => {
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

// ===========================================
// ✅ NUEVO: ENDPOINTS DE ETAPAS (STAGES)
// ===========================================

// GET /api/stages - Obtener todas las etapas
router.get('/stages', requireAuth, (req, res) => {
  try {
    const stages = stagesService.getAllStages();
    res.json({ success: true, stages });
  } catch (error) {
    logger.error('Error obteniendo etapas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/stages - Crear nueva etapa
router.post('/stages', requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    const stage = stagesService.createStage(name);
    res.json({ success: true, stage });
  } catch (error) {
    logger.error('Error creando etapa:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/stages/:id - Actualizar nombre de etapa
router.put('/stages/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, error: 'El nombre es requerido' });
    }

    const stage = stagesService.updateStageName(id, name.trim());
    res.json({ success: true, stage });
  } catch (error) {
    logger.error('Error actualizando etapa:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/stages/:id - Eliminar etapa
router.delete('/stages/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    stagesService.deleteStage(id);
    res.json({ success: true, message: 'Etapa eliminada correctamente' });
  } catch (error) {
    logger.error('Error eliminando etapa:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ✅ NUEVO: Obtener archivos por etapa
router.get('/knowledge/files/stage/:stageId', requireAuth, (req, res) => {
  try {
    const { stageId } = req.params;
    const files = knowledgeUploadService.getFilesByStage(stageId);
    res.json({ success: true, files });
  } catch (error) {
    logger.error('Error obteniendo archivos de etapa:', error);
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
