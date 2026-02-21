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
const holidaysRoutes = require('./holidays.routes');
const mediaRoutes = require('./media.routes');
const { requireAuth } = require('../middlewares/auth.middleware');
const { messageLimiter } = require('../middlewares/rate-limit.middleware');
const chatService = require('../services/chat.service');
const settingsService = require('../services/settings.service');
const knowledgeUploadService = require('../services/knowledge-upload.service');
const stagesService = require('../services/stages.service');
const metricsService = require('../services/metrics.service');
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

// ✅ Rate limiting estricto para envío de mensajes (20 req/min)
router.use('/conversations', messageLimiter);

// Rutas de conversaciones: /api/conversations/*
router.use('/conversations', conversationsRoutes);

// Rutas de días festivos: /api/holidays/*
router.use('/holidays', holidaysRoutes);

// Rutas de media: /api/media/*
router.use('/media', mediaRoutes);

// ===========================================
// ✅ ENDPOINT DE MÉTRICAS
// ===========================================
router.get('/metrics', requireAuth, (req, res) => {
  try {
    const metrics = metricsService.getMetrics();
    const rateLimitStats = require('../middlewares/rate-limit.middleware').getStats();

    res.json({
      success: true,
      metrics,
      rateLimit: rateLimitStats
    });
  } catch (error) {
    logger.error('Error obteniendo métricas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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
// ✅ NUEVO: ENDPOINTS DE GESTIÓN DE API KEYS
// ===========================================

/**
 * GET /api/keys/status
 * Devuelve el estado de las API keys (si están configuradas o no)
 * NO devuelve las keys reales, solo si están configuradas y máscara segura
 */
router.get('/keys/status', requireAuth, (req, res) => {
  try {
    const status = settingsService.getKeysStatus();
    res.json({ success: true, keys: status });
  } catch (error) {
    logger.error('Error obteniendo estado de API keys:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/keys/:provider
 * Elimina la API key de un proveedor específico
 * Limpia: settings.json, .env y process.env
 *
 * @param provider - 'groq' o 'openai'
 */
router.delete('/keys/:provider', requireAuth, (req, res) => {
  try {
    const { provider } = req.params;

    // Validar proveedor
    if (!['groq', 'openai', 'aws'].includes(provider)) {
      return res.status(400).json({
        success: false,
        error: 'Proveedor no válido. Use "groq", "openai" o "aws"'
      });
    }

    const success = settingsService.deleteApiKey(provider);

    if (success) {
      // Reinicializar proveedores de IA con las keys actualizadas
      try {
        const aiProvider = require('../providers/ai');
        aiProvider.reinitializeProviders();
      } catch (e) {
        logger.warn('Error reinicializando proveedores después de eliminar key:', e.message);
      }

      res.json({
        success: true,
        message: `API key de ${provider} eliminada de .env, settings.json y memoria`,
        keys: settingsService.getKeysStatus()
      });
    } else {
      res.status(500).json({ success: false, error: 'Error eliminando API key' });
    }
  } catch (error) {
    logger.error('Error eliminando API key:', error);
    res.status(500).json({ success: false, error: error.message });
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
    const { provider, groq, openai, aws } = req.body;

    const success = settingsService.saveSettings({ provider, groq, openai, aws });

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

// ✅ NUEVO: PATCH /api/stages/:id/toggle - Activar/desactivar etapa
router.patch('/stages/:id/toggle', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'is_active debe ser booleano' });
    }

    const stage = stagesService.toggleStageActive(id, is_active);

    // ✅ FIX: Invalidar TODOS los caches para reflejar el cambio inmediatamente
    try {
      const embeddingsService = require('../services/embeddings.service');
      const ragOptimized = require('../services/rag-optimized.service');
      const knowledgeUploadService = require('../services/knowledge-upload.service');

      // 1. Recargar chunks de embeddings (filtra por etapas activas)
      if (embeddingsService.reloadChunks) {
        embeddingsService.reloadChunks();
      }

      // 2. Limpiar cache de queries RAG (evita servir respuestas stale por 5 min)
      if (ragOptimized.clearCache) {
        ragOptimized.clearCache();
      }

      // 3. Limpiar cache de datos de archivos (evita leer datos cacheados de etapas inactivas)
      if (knowledgeUploadService.clearFileDataCache) {
        knowledgeUploadService.clearFileDataCache();
      }

      logger.info(`✅ Todos los caches invalidados tras toggle de etapa ${id}`);
    } catch (e) {
      logger.warn('No se pudieron recargar caches:', e.message);
    }

    res.json({ success: true, stage });
  } catch (error) {
    logger.error('Error toggleando etapa:', error);
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

// ===========================================
// ✅ NUEVO: ENDPOINTS DE CONFIGURACIÓN DE HORARIO
// ===========================================
const scheduleConfig = require('../services/schedule-config.service');
const timeSimulation = require('../services/time-simulation.service');

/**
 * GET /api/settings/schedule
 * Devuelve la configuración completa de horario + estados de toggles
 */
router.get('/settings/schedule', requireAuth, (req, res) => {
  try {
    const config = scheduleConfig.getConfig();
    const formatted = scheduleConfig.getFormattedSchedule();
    const scheduleStatus = timeSimulation.getScheduleCheckStatus();

    res.json({
      success: true,
      schedule: {
        ...config,
        formatted,
        scheduleCheckEnabled: scheduleStatus.enabled,
        currentTime: scheduleStatus.currentTime,
        timezone: scheduleStatus.timezone
      }
    });
  } catch (error) {
    logger.error('Error obteniendo configuración de horario:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/settings/schedule
 * Actualiza la configuración de horario (horas inicio/fin, días)
 *
 * Body esperado (todos los campos son opcionales):
 * {
 *   weekdays: { start: 8, endHour: 16, endMinute: 30 },
 *   saturday: { start: 9, endHour: 12, endMinute: 0, enabled: true },
 *   sunday: { enabled: false }
 * }
 */
router.post('/settings/schedule', requireAuth, (req, res) => {
  try {
    const { weekdays, saturday, sunday } = req.body;

    if (!weekdays && !saturday && !sunday) {
      return res.status(400).json({
        success: false,
        error: 'Debe enviar al menos un campo para actualizar (weekdays, saturday, sunday)'
      });
    }

    const result = scheduleConfig.updateConfig({ weekdays, saturday, sunday });

    if (result.success) {
      logger.info('📅 Configuración de horario actualizada desde dashboard');
      const formatted = scheduleConfig.getFormattedSchedule();

      res.json({
        success: true,
        message: 'Horario actualizado correctamente',
        schedule: {
          ...result.config,
          formatted
        }
      });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.error('Error actualizando configuración de horario:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===========================================
// ✅ NUEVO: ENDPOINTS DE RESPUESTAS RÁPIDAS
// ===========================================

const fs = require('fs');
const path = require('path');
const quickRepliesFile = path.join(process.cwd(), 'data', 'quick-replies.json');



/** Helper: leer el archivo JSON de quick-replies */
function readQuickReplies() {
  try {
    if (!fs.existsSync(quickRepliesFile)) return [];
    return JSON.parse(fs.readFileSync(quickRepliesFile, 'utf8')) || [];
  } catch (e) {
    return [];
  }
}

/** Helper: guardar quick-replies en disco */
function writeQuickReplies(data) {
  fs.writeFileSync(quickRepliesFile, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * GET /api/quick-replies
 * Devuelve SOLO las respuestas rápidas activas (para el dropdown del chat)
 */
router.get('/quick-replies', requireAuth, (req, res) => {
  try {
    const all = readQuickReplies();
    const active = all.filter(r => r.active !== false);
    res.json({ success: true, quickReplies: active });
  } catch (error) {
    logger.error('Error obteniendo quick-replies:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/quick-replies/all
 * Devuelve TODAS las respuestas (para la vista CRUD del dashboard)
 */
router.get('/quick-replies/all', requireAuth, (req, res) => {
  try {
    const all = readQuickReplies();
    res.json({ success: true, quickReplies: all });
  } catch (error) {
    logger.error('Error obteniendo todas las quick-replies:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/quick-replies
 * Crea una nueva respuesta rápida
 * Body: { title, content, active }
 */
router.post('/quick-replies', requireAuth, (req, res) => {
  try {
    const { title, content, active } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'El título es requerido' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'El contenido es requerido' });
    }

    const all = readQuickReplies();
    const newReply = {
      id: require('crypto').randomUUID(),
      title: title.trim(),
      content: content.trim(),
      active: active !== false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    all.push(newReply);
    writeQuickReplies(all);

    logger.info(`✅ Quick reply creada: "${newReply.title}"`);
    res.json({ success: true, quickReply: newReply });
  } catch (error) {
    logger.error('Error creando quick-reply:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/quick-replies/:id
 * Actualiza una respuesta rápida existente
 * Body: { title, content, active }
 */
router.put('/quick-replies/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, active } = req.body;

    const all = readQuickReplies();
    const idx = all.findIndex(r => r.id === id);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Respuesta rápida no encontrada' });
    }

    if (title !== undefined) all[idx].title = title.trim();
    if (content !== undefined) all[idx].content = content.trim();
    if (active !== undefined) all[idx].active = Boolean(active);
    all[idx].updated_at = new Date().toISOString();

    writeQuickReplies(all);

    logger.info(`✅ Quick reply actualizada: "${all[idx].title}"`);
    res.json({ success: true, quickReply: all[idx] });
  } catch (error) {
    logger.error('Error actualizando quick-reply:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/quick-replies/:id
 * Elimina una respuesta rápida
 */
router.delete('/quick-replies/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const all = readQuickReplies();
    const idx = all.findIndex(r => r.id === id);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Respuesta rápida no encontrada' });
    }

    const removed = all.splice(idx, 1)[0];
    writeQuickReplies(all);

    logger.info(`🗑️ Quick reply eliminada: "${removed.title}"`);
    res.json({ success: true, message: 'Respuesta rápida eliminada' });
  } catch (error) {
    logger.error('Error eliminando quick-reply:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

