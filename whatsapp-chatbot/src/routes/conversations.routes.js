/**
 * ===========================================
 * RUTAS DE CONVERSACIONES
 * ===========================================
 *
 * Endpoints:
 * - GET /api/conversations - Listar todas las conversaciones
 * - GET /api/conversations/stats - Obtener estadísticas
 * - GET /api/conversations/pending - Listar pendientes de atención humana
 * - GET /api/conversations/with-advisor - Listar atendidas por asesores
 * - POST /api/conversations/:userId/reset - Reset manual de conversación
 * - POST /api/conversations/:userId/take - Asesor toma una conversación
 * - POST /api/conversations/:userId/release - Asesor libera una conversación
 * - POST /api/conversations/cleanup - Limpia conversaciones expiradas
 *
 * ✅ NUEVOS ENDPOINTS MULTIMEDIA:
 * - POST /api/conversations/upload-media - Subir archivo multimedia
 * - POST /api/conversations/:userId/send-media - Enviar mensaje multimedia
 */

const express = require('express');
const conversationStateService = require('../services/conversation-state.service');
const chatService = require('../services/chat.service');
const advisorControlService = require('../services/advisor-control.service');
const timeSimulation = require('../services/time-simulation.service');
const numberControlService = require('../services/number-control.service');
const spamControlService = require('../services/spam-control.service');
const mediaService = require('../services/media.service');  // ✅ NUEVO
const whatsappProvider = require('../providers/whatsapp');  // ✅ NUEVO para fetchChats
const { requireAuth } = require('../middlewares/auth.middleware');
const { single } = require('../middlewares/upload.middleware');  // ✅ NUEVO
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/conversations
 *
 * Lista todas las conversaciones activas y expiradas
 *
 * Query params:
 * - status: filter by status (active, expired, new_cycle)
 * - consent: filter by consent status (pending, accepted, rejected)
 * - limit: limitar cantidad de resultados (default: 20 para carga inicial)
 * - offset: offset para paginación (default: 0)
 */
router.get('/', requireAuth, (req, res) => {
  try {
    const { status, consent, limit, offset } = req.query;

    let conversations = conversationStateService.getAllConversations();

    // Filtrar por status si se proporciona
    if (status) {
      conversations = conversations.filter(c => c.status === status);
    }

    // Filtrar por consent si se proporciona
    if (consent) {
      conversations = conversations.filter(c => c.consentStatus === consent);
    }

    // Ordenar por última interacción (más reciente primero)
    conversations.sort((a, b) => b.lastInteraction - a.lastInteraction);

    // ===========================================
    // ✅ NUEVO: Paginación para carga inicial
    // ===========================================
    const totalBeforeLimit = conversations.length;
    const limitNum = limit ? parseInt(limit, 10) : null; // null = sin límite
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    // Aplicar offset
    let paginatedConversations = conversations.slice(offsetNum);

    // Aplicar límite solo si se especifica
    if (limitNum !== null) {
      paginatedConversations = paginatedConversations.slice(0, limitNum);
    }

    // Enriquecer con información del control de números
    paginatedConversations = paginatedConversations.map(conv => {
      const iaCheck = numberControlService.shouldIARespond(conv.phoneNumber);
      const controlRecord = numberControlService.getControlledNumber(conv.phoneNumber);

      // ✅ MEJORADO: Prioridad de nombres:
      // 1. Nombre del registro de control (manual)
      // 2. Nombre de WhatsApp (pushName)
      // 3. "Sin nombre"
      const displayName = controlRecord?.name || conv.whatsappName || 'Sin nombre';

      return {
        ...conv,
        // Nombre con prioridad: manual > WhatsApp > Sin nombre
        registeredName: displayName,
        whatsappName: conv.whatsappName || null, // Para distinguir origen del nombre
        // Estado de IA según control de números
        iaControlled: controlRecord !== null,
        iaActive: iaCheck.shouldRespond,
        iaControlReason: controlRecord?.reason || null
      };
    });

    res.json({
      success: true,
      conversations: paginatedConversations,
      total: totalBeforeLimit,
      returned: paginatedConversations.length,
      hasMore: (offsetNum + paginatedConversations.length) < totalBeforeLimit
    });
  } catch (error) {
    logger.error('Error obteniendo conversaciones:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/stats
 *
 * Obtiene estadísticas de conversaciones
 */
router.get('/stats', requireAuth, (req, res) => {
  try {
    const stats = conversationStateService.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/conversations/:userId/reset
 *
 * Reset manual de una conversación
 *
 * Esto reinicia:
 * - El ciclo de 60 minutos
 * - El estado de consentimiento
 * - Los contadores de interacción
 *
 * El próximo mensaje del usuario volverá a recibir:
 * 1. Mensaje de bienvenida
 * 2. Mensaje de consentimiento
 */
router.post('/:userId/reset', requireAuth, (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`Reset manual solicitado para: ${userId}`);

    // 1. Resetear estado en conversation-state.service.js
    const conversation = conversationStateService.resetConversation(userId);

    // 2. Resetear estado en chat.service.js (consentimiento, interacciones, etc.)
    chatService.resetUserState(userId);

    res.json({
      success: true,
      message: 'Conversación reiniciada correctamente',
      conversation: {
        userId: conversation.userId,
        phoneNumber: conversation.phoneNumber,
        status: conversation.status
      }
    });
  } catch (error) {
    logger.error('Error reseteando conversación:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/conversations/cleanup
 *
 * Limpia conversaciones expiradas (mantenimiento)
 * Elimina conversaciones que no han tenido actividad en 24+ horas
 */
router.post('/cleanup', requireAuth, (req, res) => {
  try {
    const cleaned = conversationStateService.cleanExpiredConversations();

    res.json({
      success: true,
      message: `Limpieza completada`,
      cleaned
    });
  } catch (error) {
    logger.error('Error en limpieza de conversaciones:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// NUEVOS ENDPOINTS PARA ESCALACIÓN A HUMANO
// ===========================================

/**
 * POST /api/conversations/:userId/take
 *
 * Un asesor toma una conversación escalada
 *
 * Esto cambia el estado de 'pending_advisor' a 'advisor_handled'
 * y registra qué asesor tomó la conversación
 */
router.post('/:userId/take', requireAuth, (req, res) => {
  try {
    const { userId } = req.params;

    // NOTA: En un sistema real, req.user vendría del middleware de autenticación
    // Por ahora, usamos datos simulados o del cuerpo de la petición
    const advisorData = req.body.advisor || {
      id: 'advisor_' + Date.now(),
      name: 'Asesor',
      email: 'advisor@norboy.coop'
    };

    logger.info(`Asesor solicitando tomar conversación: ${userId}`);

    const conversation = conversationStateService.assignAdvisor(userId, advisorData);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    res.json({
      success: true,
      message: 'Conversación tomada exitosamente',
      conversation
    });
  } catch (error) {
    logger.error('Error tomando conversación:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/conversations/:userId/release
 *
 * Un asesor libera una conversación (regresa al bot)
 *
 * Esto cambia el estado de 'advisor_handled' de vuelta a 'active'
 * y permite que el bot continúe respondiendo
 */
router.post('/:userId/release', requireAuth, (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`Liberando conversación de vuelta al bot: ${userId}`);

    const conversation = conversationStateService.releaseFromAdvisor(userId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    res.json({
      success: true,
      message: 'Conversación liberada al bot',
      conversation
    });
  } catch (error) {
    logger.error('Error liberando conversación:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/pending
 *
 * Lista solo conversaciones pendientes de atención (needs_human = true)
 *
 * Filtra conversaciones con estado 'pending_advisor'
 */
router.get('/pending', requireAuth, (req, res) => {
  try {
    const pending = conversationStateService.getPendingConversations();

    // Ordenar por prioridad (más recientes primero)
    pending.sort((a, b) => b.lastInteraction - a.lastInteraction);

    res.json({
      success: true,
      conversations: pending,
      total: pending.length
    });
  } catch (error) {
    logger.error('Error obteniendo conversaciones pendientes:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/with-advisor
 *
 * Lista conversaciones actualmente atendidas por asesores
 *
 * Filtra conversaciones con estado 'advisor_handled'
 */
router.get('/with-advisor', requireAuth, (req, res) => {
  try {
    const withAdvisor = conversationStateService.getAdvisorHandledConversations();

    // Ordenar por tiempo de toma (más recientes primero)
    withAdvisor.sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0));

    res.json({
      success: true,
      conversations: withAdvisor,
      total: withAdvisor.length
    });
  } catch (error) {
    logger.error('Error obteniendo conversaciones con asesor:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// NUEVOS ENDPOINTS PARA CONTROL DEL BOT
// PUNTO DE CONTROL 2: Desactivación automática
// ===========================================

/**
 * POST /api/conversations/:userId/send-message
 *
 * Envía un mensaje desde el dashboard y DESACTIVA el bot
 * PUNTO DE CONTROL 2: Cuando el asesor responde, el bot se desactiva
 *
 * Body:
 * {
 *   "message": "Texto del mensaje",
 *   "advisor": {
 *     "id": "advisor_123",
 *     "name": "Juan Pérez",
 *     "email": "juan@norboy.coop"
 *   }
 * }
 */
router.post('/:userId/send-message', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { message, advisor } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Mensaje requerido'
      });
    }

    if (!advisor || !advisor.id || !advisor.name) {
      return res.status(400).json({
        success: false,
        error: 'Datos del asesor requeridos'
      });
    }

    logger.info(`📨 Enviando mensaje de asesor a ${userId}`);

    // Enviar mensaje y desactivar bot (PUNTO DE CONTROL 2)
    const result = await advisorControlService.sendAdvisorMessage(
      userId,
      advisor,
      message
    );

    res.json({
      success: true,
      message: result.wasPreviouslyActive
        ? 'Mensaje enviado y bot desactivado'
        : 'Mensaje enviado (bot ya estaba inactivo)',
      botActive: result.botActive,
      status: result.status
    });

  } catch (error) {
    logger.error('Error enviando mensaje de asesor:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/conversations/:userId/reactivate-bot
 *
 * Reactiva el bot manualmente
 *
 * Solo se puede hacer manualmente desde el dashboard
 *
 * Body:
 * {
 *   "advisor": {
 *     "id": "advisor_123",
 *     "name": "Juan Pérez"
 *   }
 * }
 */
router.post('/:userId/reactivate-bot', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { advisor } = req.body;

    if (!advisor || !advisor.id || !advisor.name) {
      return res.status(400).json({
        success: false,
        error: 'Datos del asesor requeridos'
      });
    }

    logger.info(`🔄 Reactivando bot para ${userId} por ${advisor.name}`);

    const result = await advisorControlService.reactivateBot(userId, advisor);

    res.json({
      success: true,
      message: 'Bot reactivado correctamente',
      botActive: result.botActive,
      status: result.status
    });

  } catch (error) {
    logger.error('Error reactivando bot:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/:userId/bot-status
 *
 * Verifica si el bot está activo
 */
router.get('/:userId/bot-status', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const isActive = advisorControlService.isBotActive(userId);
    const conversation = conversationStateService.getConversation(userId);

    res.json({
      success: true,
      botActive: isActive,
      status: conversation ? conversation.status : null,
      botDeactivatedAt: conversation ? conversation.botDeactivatedAt : null,
      botDeactivatedBy: conversation ? conversation.botDeactivatedBy : null
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/:userId/messages
 *
 * Obtiene el historial de mensajes de una conversación con paginación
 *
 * ✅ OPCIÓN 3 - HÍBRIDA:
 * - Primero busca en memoria (últimos 50)
 * - Si necesita más, busca en DynamoDB
 * - Fusiona resultados transparentemente
 *
 * Query params:
 *   - limit: cantidad de mensajes a devolver (default: 20)
 *   - before: cursor/timestamp para cargar mensajes anteriores
 *   - full: true para cargar historial completo sin paginación
 */
router.get('/:userId/messages', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit, before, full } = req.query;
    const conversation = conversationStateService.getConversation(userId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    const limitNum = limit ? parseInt(limit, 10) : 20;
    let allMessages = conversation.messages || [];
    let source = 'memory';

    // ===========================================
    // ✅ OPCIÓN 3 - HÍBRIDA: Buscar en DynamoDB si:
    // - Se pide 'full=true', O
    // - No hay suficientes mensajes en memoria, O
    // - El cursor 'before' es anterior al mensaje más antiguo en memoria
    // ===========================================

    const memoryMessages = allMessages;
    const oldestMemoryTimestamp = memoryMessages.length > 0
      ? Math.min(...memoryMessages.map(m => m.timestamp || 0))
      : Infinity;

    const needDynamoDB = full === 'true' ||
      (before && parseInt(before, 10) < oldestMemoryTimestamp) ||
      (memoryMessages.length < limitNum && full === 'true');

    if (needDynamoDB) {
      try {
        const conversationRepository = require('../repositories/conversation.repository');
        logger.info(`📊 [DYNAMODB] Consultando mensajes para ${userId}...`);

        // Obtener historial desde DynamoDB
        const dynamoMessages = await conversationRepository.getHistory(userId, {
          limit: full === 'true' ? 1000 : limitNum + 50 // Buffer para paginación
        });

        // Convertir formato DynamoDB al formato esperado por el frontend
        const formattedDynamoMessages = dynamoMessages.map(msg => ({
          id: msg.id || msg.messageId,
          conversationId: msg.conversationId || userId,
          sender: msg.direction === 'incoming' ? 'user' : 'bot',
          message: msg.content?.text || '[Multimedia]',
          timestamp: msg.timestamp || Date.parse(msg.createdAt),
          type: msg.metadata?.originalType || 'text'
        }));

        // Usar mensajes de DynamoDB
        allMessages = formattedDynamoMessages;
        source = 'dynamodb';
        logger.info(`✅ [DYNAMODB] ${allMessages.length} mensajes obtenidos`);

      } catch (dbError) {
        logger.error(`❌ [DYNAMODB] Error consultando mensajes:`, dbError.message);
        // Fallback a memoria si DynamoDB falla
        allMessages = memoryMessages;
        source = 'memory (fallback)';
      }
    }

    // ===========================================
    // Paginación
    // ===========================================
    // Ordenar por timestamp DESC (más recientes primero) para paginación
    const sortedMessages = [...allMessages].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    let messagesToReturn = sortedMessages;
    let hasMore = false;

    // Si se pide el historial completo, saltar paginación
    if (full === 'true') {
      messagesToReturn = sortedMessages;
      hasMore = false;
    } else {
      // Aplicar paginación

      // Si se proporciona cursor 'before', filtrar mensajes más antiguos que ese timestamp
      if (before) {
        const beforeTimestamp = parseInt(before, 10);
        messagesToReturn = sortedMessages.filter(msg => (msg.timestamp || 0) < beforeTimestamp);
      }

      // Verificar si hay más mensajes
      hasMore = messagesToReturn.length > limitNum;

      // Aplicar límite
      messagesToReturn = messagesToReturn.slice(0, limitNum);
    }

    // Revertir orden para enviar al frontend (cronológico: antiguos arriba)
    const chronologicalMessages = [...messagesToReturn].reverse();

    // Cursor para la siguiente página (el timestamp del mensaje más antiguo)
    const nextCursor = messagesToReturn.length > 0
      ? messagesToReturn[messagesToReturn.length - 1].timestamp
      : null;

    logger.info(`📜 Mensajes cargados para ${userId}: ${chronologicalMessages.length}/${allMessages.length} (source: ${source}, hasMore: ${hasMore})`);

    res.json({
      success: true,
      messages: chronologicalMessages,
      total: allMessages.length,
      returned: chronologicalMessages.length,
      hasMore: hasMore,
      nextCursor: nextCursor,
      conversationStart: conversation.cycleStart,
      status: conversation.status,
      source: source // Para debug: saber de dónde vinieron los datos
    });

  } catch (error) {
    logger.error('Error obteniendo mensajes:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/stats/bot-control
 *
 * Obtiene estadísticas de control del bot
 */
router.get('/stats/bot-control', requireAuth, (req, res) => {
  try {
    const stats = advisorControlService.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('Error obteniendo estadísticas de bot:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// ENDPOINTS PARA SIMULACIÓN DE HORA (TESTING)
// ===========================================

/**
 * POST /api/conversations/simulate-time
 *
 * Establece una hora simulada para pruebas de horario
 *
 * Body:
 * {
 *   "time": "16:45"  // Hora en formato HH:MM (4:45 PM)
 * }
 *
 * NOTA: Solo para desarrollo/testing
 */
router.post('/simulate-time', requireAuth, (req, res) => {
  try {
    const { time } = req.body;

    if (!time) {
      return res.status(400).json({
        success: false,
        error: 'Hora requerida en formato "HH:MM"'
      });
    }

    const result = timeSimulation.setSimulatedTime(time);

    if (result.success) {
      logger.warn(`🔧 Simulación de hora activada por usuario: ${time}`);

      // Incluir información sobre el horario de atención
      res.json({
        success: true,
        ...result,
        businessHours: {
          end: '4:30 PM',
          description: 'Horario final de atención'
        },
        warning: '⚠️ Modo de simulación activo. Usa /api/conversations/clear-simulated-time para volver a hora real.'
      });
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    logger.error('Error estableciendo hora simulada:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/conversations/clear-simulated-time
 *
 * Limpia la hora simulada y vuelve a la hora real
 */
router.post('/clear-simulated-time', requireAuth, (req, res) => {
  try {
    const result = timeSimulation.clearSimulatedTime();

    res.json({
      success: true,
      ...result,
      message: 'Hora simulada desactivada. Usando hora real del sistema.'
    });

  } catch (error) {
    logger.error('Error limpiando hora simulada:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/simulated-time
 *
 * Obtiene la hora simulada actual (si está activa)
 */
router.get('/simulated-time', requireAuth, (req, res) => {
  try {
    const simulated = timeSimulation.getSimulatedTime();
    const isActive = timeSimulation.isSimulationActive();

    const currentTime = timeSimulation.getCurrentTime();
    res.json({
      success: true,
      isSimulationActive: isActive,
      simulatedTime: simulated,
      currentRealTime: currentTime.timeString,
      currentEffectiveTime: currentTime.timeString,
      timezone: currentTime.timezone
    });

  } catch (error) {
    logger.error('Error obteniendo hora simulada:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// ENDPOINTS PARA CONTROL DE VERIFICACIÓN DE HORARIO
// ===========================================

/**
 * POST /api/conversations/toggle-schedule-check
 *
 * Activa o desactiva la verificación de horario
 *
 * Body:
 * {
 *   "enabled": true  // true para activar, false para desactivar
 * }
 */
router.post('/toggle-schedule-check', requireAuth, (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Parámetro "enabled" debe ser un booleano (true/false)'
      });
    }

    const result = timeSimulation.setScheduleCheck(enabled);

    if (result.success) {
      logger.warn(`🔧 Control de horario ${enabled ? 'ACTIVADO' : 'DESACTIVADO'} por usuario`);

      res.json({
        success: true,
        ...result,
        businessHours: {
          end: '4:30 PM',
          description: 'Horario final de atención'
        }
      });
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    logger.error('Error cambiando verificación de horario:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/schedule-check-status
 *
 * Obtiene el estado actual de la verificación de horario
 */
router.get('/schedule-check-status', requireAuth, (req, res) => {
  try {
    const status = timeSimulation.getScheduleCheckStatus();

    res.json({
      success: true,
      ...status,
      businessHours: {
        start: '8:00 AM',
        end: '4:30 PM',
        description: 'Horario de atención'
      }
    });

  } catch (error) {
    logger.error('Error obteniendo estado de verificación de horario:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// ENDPOINTS PARA CONTROL DE VERIFICACIÓN DE DÍAS FESTIVOS
// ===========================================

/**
 * POST /api/conversations/toggle-holiday-check
 *
 * Activa o desactiva la verificación de días festivos
 *
 * Body:
 * {
 *   "enabled": true  // true para activar, false para desactivar
 * }
 */
router.post('/toggle-holiday-check', requireAuth, (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Parámetro "enabled" debe ser un booleano (true/false)'
      });
    }

    const holidaysService = require('../services/holidays.service');
    const result = holidaysService.setHolidayCheck(enabled);

    if (result.success) {
      logger.warn(`🔧 Control de días festivos ${enabled ? 'ACTIVADO' : 'DESACTIVADO'} por usuario`);

      res.json({
        success: true,
        ...result
      });
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    logger.error('Error cambiando verificación de días festivos:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/holiday-check-status
 *
 * Obtiene el estado actual de la verificación de días festivos
 */
router.get('/holiday-check-status', requireAuth, (req, res) => {
  try {
    const holidaysService = require('../services/holidays.service');
    const status = holidaysService.getHolidayCheckStatus();

    res.json({
      success: true,
      ...status
    });

  } catch (error) {
    logger.error('Error obteniendo estado de verificación de días festivos:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// ENDPOINTS PARA CONTROL DE NÚMEROS (IA DESACTIVADA)
// ===========================================

/**
 * GET /api/conversations/number-control
 *
 * Lista todos los números con control de IA
 */
router.get('/number-control', requireAuth, (req, res) => {
  try {
    const numbers = numberControlService.getAllControlledNumbers();
    const stats = numberControlService.getStats();

    // ✅ NUEVO: Enriquecer con nombres de WhatsApp de conversaciones activas
    const allConversations = conversationStateService.getAllConversations();
    const conversationsMap = new Map(
      allConversations.map(c => [c.phoneNumber, c.whatsappName])
    );

    const enrichedNumbers = numbers.map(record => {
      const whatsappName = conversationsMap.get(record.phoneNumber);
      // Si no hay nombre manual, usar el de WhatsApp
      const displayName = record.name || whatsappName || 'Sin nombre';

      return {
        ...record,
        whatsappName: whatsappName || null, // Nombre de WhatsApp (si existe)
        displayName: displayName // Nombre a mostrar (con prioridad)
      };
    });

    res.json({
      success: true,
      numbers: enrichedNumbers,
      total: enrichedNumbers.length,
      stats
    });
  } catch (error) {
    logger.error('Error obteniendo números controlados:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/conversations/number-control
 *
 * Registra un nuevo número para desactivar la IA
 *
 * Body:
 * {
 *   "phoneNumber": "3001234567",  // Obligatorio
 *   "name": "Juan Pérez",         // Opcional
 *   "reason": "Cliente VIP"       // Opcional
 * }
 */
router.post('/number-control', requireAuth, (req, res) => {
  try {
    const { phoneNumber, name, reason } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'El número de teléfono es obligatorio'
      });
    }

    const record = numberControlService.addControlledNumber({
      phoneNumber,
      name,
      reason,
      registeredBy: req.body.registeredBy || 'Asesor'
    });

    res.json({
      success: true,
      message: 'Número registrado. La IA no responderá a este número.',
      record
    });
  } catch (error) {
    logger.error('Error registrando número:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/conversations/number-control/:phoneNumber
 *
 * Actualiza los datos de un número controlado
 *
 * Body:
 * {
 *   "name": "Nuevo nombre",
 *   "reason": "Nuevo motivo",
 *   "iaActive": true/false
 * }
 */
router.put('/number-control/:phoneNumber', requireAuth, (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { name, reason, iaActive, updatedBy } = req.body;

    const record = numberControlService.updateControlledNumber(phoneNumber, {
      name,
      reason,
      iaActive,
      updatedBy: updatedBy || 'Asesor'
    });

    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'Número no encontrado'
      });
    }

    res.json({
      success: true,
      message: iaActive ? 'IA activada para este número' : 'IA desactivada para este número',
      record
    });
  } catch (error) {
    logger.error('Error actualizando número:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/conversations/number-control/:phoneNumber
 *
 * Elimina un número del control (la IA volverá a responder)
 */
router.delete('/number-control/:phoneNumber', requireAuth, (req, res) => {
  try {
    const { phoneNumber } = req.params;

    const deleted = numberControlService.removeControlledNumber(phoneNumber);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Número no encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Número eliminado del control. La IA volverá a responder normalmente.'
    });
  } catch (error) {
    logger.error('Error eliminando número:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/number-control/:phoneNumber/check
 *
 * Verifica si la IA debe responder a un número
 */
router.get('/number-control/:phoneNumber/check', requireAuth, (req, res) => {
  try {
    const { phoneNumber } = req.params;

    const result = numberControlService.shouldIARespond(phoneNumber);
    const name = numberControlService.getNameByPhone(phoneNumber);

    res.json({
      success: true,
      phoneNumber,
      name,
      ...result
    });
  } catch (error) {
    logger.error('Error verificando número:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// ENDPOINTS PARA CONTROL ANTI-SPAM
// ===========================================

/**
 * GET /api/conversations/spam-control
 *
 * Obtiene estadísticas y lista de bloqueos por spam
 */
router.get('/spam-control', requireAuth, (req, res) => {
  try {
    const stats = spamControlService.getStats();
    const blocks = spamControlService.getSpamBlocks();

    res.json({
      success: true,
      stats,
      blocks,
      total: blocks.length
    });
  } catch (error) {
    logger.error('Error obteniendo datos anti-spam:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/spam-control/active
 *
 * Obtiene solo los bloqueos activos por spam
 */
router.get('/spam-control/active', requireAuth, (req, res) => {
  try {
    const blocks = spamControlService.getSpamBlocks(true);

    res.json({
      success: true,
      blocks,
      total: blocks.length
    });
  } catch (error) {
    logger.error('Error obteniendo bloqueos activos de spam:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/conversations/spam-control/:phoneNumber/reactivate
 *
 * Reactiva la IA para un número bloqueado por spam
 *
 * Body:
 * {
 *   "reactivatedBy": "Nombre del admin"
 * }
 */
router.post('/spam-control/:phoneNumber/reactivate', requireAuth, (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { reactivatedBy } = req.body;

    const result = spamControlService.reactivateFromSpam(
      phoneNumber,
      reactivatedBy || 'Admin'
    );

    if (result.success) {
      logger.info(`🟢 IA reactivada desde dashboard para ${phoneNumber} por ${reactivatedBy || 'Admin'}`);
    }

    res.json(result);
  } catch (error) {
    logger.error('Error reactivando IA por spam:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/spam-control/:phoneNumber
 *
 * Obtiene el estado de spam de un número específico
 */
router.get('/spam-control/:phoneNumber', requireAuth, (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const block = spamControlService.getSpamBlock(phoneNumber);
    const isBlocked = spamControlService.isBlockedBySpam(phoneNumber);

    res.json({
      success: true,
      phoneNumber,
      isBlockedBySpam: isBlocked,
      block
    });
  } catch (error) {
    logger.error('Error verificando spam:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// ✅ NUEVOS ENDPOINTS PARA MENSAJES MULTIMEDIA
// ===========================================

/**
 * POST /api/conversations/upload-media
 *
 * Sube un archivo multimedia (audio, imagen, documento)
 *
 * FormData:
 * - file: El archivo a subir
 * - type: Tipo de archivo ('audio', 'image', 'document')
 */
router.post('/upload-media', requireAuth, single('file'), async (req, res) => {
  try {
    const { type } = req.body;

    logger.info(`📁 upload-media recibido: type="${type}", file=${req.file ? 'SÍ' : 'NO'}`);
    if (req.file) {
      logger.info(`   archivo: originalname="${req.file.originalname}", mimetype="${req.file.mimetype}"`);
    }

    if (!type || !['audio', 'image', 'document'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Tipo de archivo no válido. Debe ser: audio, image, o document'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No se proporcionó ningún archivo'
      });
    }

    // Guardar archivo usando el servicio de media
    const savedFile = await mediaService.saveUploadedFile(req.file, type);

    res.json({
      success: true,
      file: {
        url: savedFile.url,
        filepath: savedFile.filepath,  // ✅ NUEVO: Ruta absoluta para enviar por WhatsApp
        filename: savedFile.filename,
        originalname: savedFile.originalname,
        size: savedFile.size,
        type: savedFile.type
      }
    });

  } catch (error) {
    logger.error('Error subiendo archivo:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Manejador de errores de multer
router.use((error, req, res, next) => {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      error: 'Archivo demasiado grande'
    });
  }
  if (error.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
  next(error);
});

/**
 * POST /api/conversations/:userId/send-media
 *
 * Envía un mensaje multimedia a una conversación
 *
 * Body:
 * {
 *   "media": {
 *     "type": "audio|image|document",
 *     "url": "/uploads/audio/file.mp3",
 *     "filename": "archivo.mp3",
 *     "size": 12345
 *   },
 *   "caption": "Texto opcional (para imágenes/documentos)",
 *   "advisor": {
 *     "id": "advisor_123",
 *     "name": "Juan Pérez",
 *     "email": "juan@norboy.coop"
 *   }
 * }
 */
router.post('/:userId/send-media', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { media, caption, advisor } = req.body;

    if (!media || !media.type || !media.url) {
      return res.status(400).json({
        success: false,
        error: 'Datos de media incompletos'
      });
    }

    if (!advisor || !advisor.id || !advisor.name) {
      return res.status(400).json({
        success: false,
        error: 'Datos del asesor requeridos'
      });
    }

    logger.info(`📨 Enviando mensaje multimedia de asesor a ${userId}`);

    // Enviar mensaje multimedia
    const result = await advisorControlService.sendAdvisorMediaMessage(
      userId,
      advisor,
      media,
      caption || ''
    );

    res.json({
      success: true,
      message: result.wasPreviouslyActive
        ? 'Mensaje multimedia enviado y bot desactivado'
        : 'Mensaje multimedia enviado (bot ya estaba inactivo)',
      botActive: result.botActive,
      status: result.status,
      sentMessage: result.message
    });

  } catch (error) {
    logger.error('Error enviando mensaje multimedia:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Servir archivos estáticos subidos
router.use('/uploads', express.static(require('path').join(__dirname, '../../uploads')));

// ===========================================
// MANEJADOR DE ERRORES DE MULTER
// ===========================================
router.use((error, req, res, next) => {
  // Solo manejar errores de multer que vienen de /upload-media
  if (error && (error.code === 'LIMIT_FILE_SIZE' || error.code === 'INVALID_FILE_TYPE' || error.code === 'LIMIT_UNEXPECTED_FILE')) {
    logger.error('❌ Error en multer:', error);

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Archivo demasiado grande'
      });
    }

    if (error.code === 'INVALID_FILE_TYPE' || error.message.includes('Tipo de archivo no permitido')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        error: 'Campo de archivo no válido o faltante'
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message || 'Error al procesar el archivo'
    });
  }
  next(error);
});

module.exports = router;

// ===========================================
// ✅ NUEVOS ENDPOINTS PARA CHATS DIRECTOS DE WHATSAPP
// ===========================================

/**
 * GET /api/conversations/whatsapp-chats
 *
 * Obtiene los chats desde Baileys, memoria o DynamoDB (en ese orden)
 *
 * Query params:
 * - limit: cantidad de chats (default: 20)
 */
router.get('/whatsapp-chats', requireAuth, async (req, res) => {
  try {
    const { limit } = req.query;
    const limitNum = limit ? parseInt(limit, 10) : 20;

    logger.info(`📱 Obteniendo chats (limit: ${limitNum})`);

    // ✅ FIX: Merge data from ALL sources instead of stopping at the first one.
    // This ensures conversations from Baileys, memory, AND DynamoDB are all returned.
    const chatsByUserId = new Map();
    const sources = [];

    // 1. Obtener desde Baileys
    try {
      const whatsappProvider = require('../providers/whatsapp');
      const baileysChats = await whatsappProvider.fetchChats(limitNum);
      if (baileysChats && baileysChats.length > 0) {
        baileysChats.forEach(c => chatsByUserId.set(c.userId, c));
        sources.push('baileys');
        logger.info(`📱 ${baileysChats.length} chats desde Baileys`);
      }
    } catch (e) {
      logger.warn(`⚠️ Error obteniendo chats de Baileys: ${e.message}`);
    }

    // 2. Obtener desde memoria y MERGE (no reemplazar)
    try {
      const memoryConversations = conversationStateService.getAllConversations();
      if (memoryConversations.length > 0) {
        memoryConversations.forEach(conv => {
          const memChat = {
            userId: conv.userId,
            phoneNumber: conv.phoneNumber,
            whatsappName: conv.whatsappName || 'Sin nombre',
            registeredName: conv.registeredName || conv.whatsappName || 'Sin nombre',
            lastMessage: conv.lastMessage || '',
            lastInteraction: conv.lastInteraction || Date.now(),
            unreadCount: 0,
            status: conv.status || 'active',
            bot_active: conv.bot_active !== undefined ? conv.bot_active : true
          };
          const existing = chatsByUserId.get(conv.userId);
          if (existing) {
            // Merge: prefer memory status/lastMessage (more up-to-date) but keep Baileys name
            Object.assign(existing, {
              status: conv.status || existing.status,
              lastMessage: conv.lastMessage || existing.lastMessage,
              lastInteraction: Math.max(conv.lastInteraction || 0, existing.lastInteraction || 0),
              bot_active: conv.bot_active !== undefined ? conv.bot_active : existing.bot_active
            });
          } else {
            chatsByUserId.set(conv.userId, memChat);
          }
        });
        sources.push('memory');
        logger.info(`📱 ${memoryConversations.length} chats desde memoria (merged)`);
      }
    } catch (e) {
      logger.warn(`⚠️ Error obteniendo chats de memoria: ${e.message}`);
    }

    // 3. Obtener desde DynamoDB y MERGE (siempre, no solo cuando vacío)
    try {
      const conversationRepository = require('../repositories/conversation.repository');
      const dbConversations = await conversationRepository.findActive({ limit: limitNum });
      if (dbConversations.length > 0) {
        dbConversations.forEach(conv => {
          const data = conv.toObject ? conv.toObject() : conv;
          const phoneNumber = (data.participantId || '')
            .replace('@s.whatsapp.net', '')
            .replace('@g.us', '')
            .replace('@lid', '');
          const dbChat = {
            userId: data.participantId,
            phoneNumber: phoneNumber,
            whatsappName: data.participantName || 'Sin nombre',
            registeredName: data.participantName || 'Sin nombre',
            lastMessage: data.lastMessage || '',
            lastInteraction: data.lastInteraction || (data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now()),
            unreadCount: 0,
            status: data.status || 'active',
            bot_active: data.status !== 'advisor_handled'
          };
          // Only add if not already present from Baileys/memory
          if (!chatsByUserId.has(data.participantId)) {
            chatsByUserId.set(data.participantId, dbChat);
          }
        });
        sources.push('dynamodb');
        logger.info(`📱 ${dbConversations.length} chats desde DynamoDB (merged)`);
      }
    } catch (e) {
      logger.warn(`⚠️ Error obteniendo chats de DynamoDB: ${e.message}`);
    }

    const chats = Array.from(chatsByUserId.values());
    const source = sources.length > 0 ? sources.join('+') : 'none';
    logger.info(`📱 Total: ${chats.length} chats combinados desde [${source}]`);

    // Enriquecer con información del control de números
    const enrichedChats = chats.map(chat => {
      const phoneNumber = chat.phoneNumber || '';
      const iaCheck = numberControlService.shouldIARespond(phoneNumber);
      const controlRecord = numberControlService.getControlledNumber(phoneNumber);

      // Prioridad de nombres: manual > WhatsApp > Sin nombre
      const displayName = controlRecord?.name || chat.whatsappName || 'Sin nombre';

      return {
        ...chat,
        registeredName: displayName,
        whatsappName: chat.whatsappName || null,
        iaControlled: controlRecord !== null,
        iaActive: iaCheck.shouldRespond,
        iaControlReason: controlRecord?.reason || null
      };
    });

    // Ordenar por última interacción (más recientes primero)
    enrichedChats.sort((a, b) => (b.lastInteraction || 0) - (a.lastInteraction || 0));

    // Aplicar límite
    const limitedChats = enrichedChats.slice(0, limitNum);

    res.json({
      success: true,
      conversations: limitedChats,
      total: enrichedChats.length,
      returned: limitedChats.length,
      hasMore: enrichedChats.length > limitNum,
      source: source
    });

  } catch (error) {
    logger.error('Error obteniendo chats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/:userId/whatsapp-messages
 *
 * Obtiene mensajes de un chat desde Baileys, Memoria o DynamoDB
 *
 * Query params:
 * - limit: cantidad de mensajes (default: 50)
 * - cursor: cursor para paginación
 */
router.get('/:userId/whatsapp-messages', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit, cursor } = req.query;
    const limitNum = limit ? parseInt(limit, 10) : 200;

    // ✅ CRITICAL FIX: Normalize userId to match DynamoDB format
    // If userId doesn't have @s.whatsapp.net, add it
    const normalizedUserId = userId.includes('@') ? userId : `${userId}@s.whatsapp.net`;

    logger.info(`📜 Obteniendo mensajes para ${userId} (normalizado: ${normalizedUserId}, limit: ${limitNum})`);

    // CARGAR DIRECTAMENTE DESDE DYNAMODB (fuente de verdad)
    // DynamoDB tiene TODOS los mensajes guardados, traemos solo los últimos 200
    logger.info(`📜 Cargando últimos ${limitNum} mensajes desde DynamoDB...`);
    const conversationRepository = require('../repositories/conversation.repository');
    const dbMessages = await conversationRepository.getHistory(normalizedUserId, { limit: limitNum });

    const messages = dbMessages.map(msg => ({
      id: msg.id || msg.messageId,
      sender: msg.metadata?.sender || (msg.direction === 'incoming' ? 'user' : 'bot'),
      senderName: msg.metadata?.sender === 'admin' ? (msg.metadata?.senderName || 'Asesor') : undefined,
      message: msg.content?.text || '[Multimedia]',
      text: msg.content?.text || '[Multimedia]',
      type: msg.metadata?.originalType || msg.messageType || 'text',
      timestamp: msg.timestamp || msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now(),
      direction: msg.direction || 'incoming'
    }));

    logger.info(`📜 ${messages.length} mensajes cargados desde DynamoDB`);

    // Ordenar por timestamp (más antiguos primero para chat)
    messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    res.json({
      success: true,
      messages: messages,
      hasMore: false,
      nextCursor: null,
      total: messages.length,
      returned: messages.length,
      source: 'dynamodb'
    });

  } catch (error) {
    logger.error('Error obteniendo mensajes:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// ✅ NUEVO: ENVIAR AUDIO DESDE EL DASHBOARD
// ===========================================

/**
 * POST /api/conversations/:userId/send-audio
 *
 * Envía un audio grabado desde el dashboard al usuario de WhatsApp.
 * Recibe el audio como multipart/form-data con campo 'audio'.
 */
router.post('/:userId/send-audio', requireAuth, single('audio'), async (req, res) => {
  let filePath = null;

  try {
    const { userId } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Archivo de audio requerido'
      });
    }

    filePath = req.file.path;
    logger.info(`🎤 Enviando audio a ${userId} desde dashboard (${req.file.originalname})`);

    // Enviar audio vía WhatsApp
    await whatsappProvider.sendAudio(userId, filePath);

    // Guardar mensaje en la conversación
    const conversation = conversationStateService.getConversation(userId);
    if (conversation) {
      if (!conversation.messages) conversation.messages = [];
      conversation.messages.push({
        id: `audio_${Date.now()}`,
        sender: 'admin',
        type: 'audio',
        message: '[Audio enviado]',
        timestamp: Date.now()
      });
    }

    logger.info(`✅ Audio enviado exitosamente a ${userId}`);

    res.json({
      success: true,
      message: 'Audio enviado correctamente'
    });

  } catch (error) {
    logger.error('Error enviando audio:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });

  } finally {
    // Limpiar archivo temporal
    if (filePath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.debug(`🗑️ Archivo temporal eliminado: ${filePath}`);
        }
      } catch (cleanupError) {
        logger.warn(`⚠️ Error eliminando archivo temporal: ${cleanupError.message}`);
      }
    }
  }
});

// ===========================================
// ✅ NUEVO: ENVIAR ARCHIVO DESDE EL DASHBOARD
// ===========================================

/**
 * POST /api/conversations/:userId/send-file
 *
 * Envía un archivo (imagen, documento, audio) desde el dashboard al usuario de WhatsApp.
 * Recibe el archivo como multipart/form-data con campo 'file'.
 * Body adicional: type (image, document, audio)
 */
router.post('/:userId/send-file', requireAuth, single('file'), async (req, res) => {
  let filePath = null;

  try {
    const { userId } = req.params;
    const fileType = req.body.type || 'document';

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Archivo requerido'
      });
    }

    filePath = req.file.path;
    const originalName = req.file.originalname;
    logger.info(`📎 Enviando archivo (${fileType}) a ${userId}: ${originalName}`);

    // Enviar según tipo
    const path = require('path');
    switch (fileType) {
      case 'image':
        await whatsappProvider.sendImage(userId, filePath, '');
        break;
      case 'audio':
        await whatsappProvider.sendAudio(userId, filePath);
        break;
      case 'document':
      default:
        await whatsappProvider.sendDocument(userId, filePath, originalName);
        break;
    }

    // Guardar mensaje en la conversación
    const conversation = conversationStateService.getConversation(userId);
    if (conversation) {
      if (!conversation.messages) conversation.messages = [];
      conversation.messages.push({
        id: `file_${Date.now()}`,
        sender: 'admin',
        type: fileType,
        message: `[${fileType === 'image' ? 'Imagen' : fileType === 'audio' ? 'Audio' : 'Documento'} enviado: ${originalName}]`,
        fileName: originalName,
        timestamp: Date.now()
      });
    }

    logger.info(`✅ Archivo enviado exitosamente a ${userId}`);

    res.json({
      success: true,
      message: 'Archivo enviado correctamente'
    });

  } catch (error) {
    logger.error('Error enviando archivo:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });

  } finally {
    // Limpiar archivo temporal
    if (filePath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.debug(`🗑️ Archivo temporal eliminado: ${filePath}`);
        }
      } catch (cleanupError) {
        logger.warn(`⚠️ Error eliminando archivo temporal: ${cleanupError.message}`);
      }
    }
  }
});

module.exports = router;
