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
const mediaService = require('../services/media.service');  // Legacy service
const mediaStorageService = require('../services/media-storage.service'); // ✅ NUEVO: almacenamiento persistente (S3)
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
    const { message, advisor, replyTo } = req.body;

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
      message,
      replyTo || null
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
 * POST /api/conversations/:userId/deactivate-bot
 *
 * Desactiva el bot manualmente desde el dashboard
 * Permite al asesor tomar control sin enviar un mensaje primero
 */
router.post('/:userId/deactivate-bot', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { advisor } = req.body;

    if (!advisor || !advisor.id || !advisor.name) {
      return res.status(400).json({
        success: false,
        error: 'Datos del asesor requeridos'
      });
    }

    logger.info(`🔴 Desactivando bot manualmente para ${userId} por ${advisor.name}`);

    const conversation = conversationStateService.getOrCreateConversation(userId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    // Desactivar bot
    conversation.bot_active = false;
    conversation.status = 'advisor_handled';
    conversation.assignedTo = advisor.id;
    conversation.advisorName = advisor.name;
    conversation.needs_human = true;
    conversation.botDeactivatedAt = Date.now();
    conversation.botDeactivatedBy = advisor.id;

    // Limpiar flujo activo si existe
    try {
      const flowManager = require('../flows');
      if (flowManager.hasActiveFlow(userId)) {
        flowManager.endFlow(userId);
        conversation.activeFlow = null;
        logger.info(`🔄 Flujo activo limpiado para ${userId}`);
      }
    } catch (e) {
      logger.warn(`⚠️ Error limpiando flujo: ${e.message}`);
    }

    logger.info(`✅ Bot desactivado para ${userId} por ${advisor.name}`);

    res.json({
      success: true,
      message: 'Bot desactivado correctamente',
      botActive: false,
      status: conversation.status
    });

  } catch (error) {
    logger.error('Error desactivando bot:', error);
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
          type: msg.metadata?.originalType || msg.type || 'text',
          // ✅ FIX Bug2: Restaurar metadata de media desde DynamoDB
          mediaUrl: msg.content?.mediaUrl || null,
          fileName: msg.content?.fileName || null,
          mimeType: msg.content?.mimeType || null,
          fileSize: msg.content?.fileSize || null
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

    if (!type || !['audio', 'image', 'video', 'document'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Tipo de archivo no válido. Debe ser: audio, image, video, o document'
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

    // 2. [CRITICAL FIX] Verificar estado en DB para los chats de Baileys
    // Esto asegura que si un chat de Baileys fue eliminado en DB, se oculte.
    // O si tiene customName en DB, se use.
    try {
      if (chatsByUserId.size > 0) {
        const conversationRepository = require('../repositories/conversation.repository');
        const idsToCheck = Array.from(chatsByUserId.keys());

        // Batch get para eficiencia
        const dbStatuses = await conversationRepository.findAllByIds(idsToCheck);

        dbStatuses.forEach(dbConv => {
          const data = dbConv.toObject ? dbConv.toObject() : dbConv;

          // Si está eliminado en DB, quitarlo de la lista (aunque Baileys lo traiga)
          if (data.isDeleted) {
            chatsByUserId.delete(data.participantId);
            return;
          }

          // Si tiene customName, actualizar el objeto de Baileys
          const existing = chatsByUserId.get(data.participantId);
          if (existing && data.customName) {
            existing.customName = data.customName;
            existing.registeredName = data.customName;
          }
        });
        logger.info(`🔍 Verificados ${idsToCheck.length} chats de Baileys contra DB`);
      }
    } catch (e) {
      logger.warn(`⚠️ Error verificando estados de Baileys vs DB: ${e.message}`);
    }

    // 3. Obtener desde memoria y MERGE (no reemplazar)
    try {
      // ✅ FIX: Usar getAllConversationsRaw para VER también los eliminados y poder quitarlos del mapa
      const memoryConversations = conversationStateService.getAllConversationsRaw();
      if (memoryConversations.length > 0) {
        memoryConversations.forEach(conv => {
          // ✅ FIX: Si está eliminado, remover del mapa si ya existe (ej: de Baileys)
          if (conv.isDeleted) {
            chatsByUserId.delete(conv.userId);
            return;
          }

          const memChat = {
            userId: conv.userId,
            phoneNumber: conv.phoneNumber,
            whatsappName: conv.whatsappName || 'Sin nombre',
            customName: conv.customName || null, // ✅ NUEVO
            registeredName: conv.customName || conv.registeredName || conv.whatsappName || 'Sin nombre',
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
              bot_active: conv.bot_active !== undefined ? conv.bot_active : existing.bot_active,
              customName: conv.customName || existing.customName // Prefer memory customName
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
            customName: data.customName || null, // ✅ NUEVO
            registeredName: data.customName || data.participantName || 'Sin nombre',
            lastMessage: data.lastMessage || '',
            lastInteraction: data.lastInteraction || (data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now()),
            unreadCount: 0,
            status: data.status || 'active',
            bot_active: data.status !== 'advisor_handled'
          };
          // Only add if not already present AND not deleted
          if (data.isDeleted) {
            chatsByUserId.delete(data.participantId);
            return;
          }

          const existing = chatsByUserId.get(data.participantId);
          if (existing) {
            // ✅ FIX: Enrich existing chat with DB data (customName) if missing
            if (!existing.customName && data.customName) {
              existing.customName = data.customName;
              existing.registeredName = data.customName;
            }
          } else {
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

      // Prioridad de nombres: manual > customName > WhatsApp > Sin nombre
      const displayName = controlRecord?.name || chat.customName || chat.whatsappName || 'Sin nombre';

      return {
        ...chat,
        registeredName: displayName,
        registeredName: displayName,
        whatsappName: chat.whatsappName || null,
        customName: chat.customName || null, // ✅ NUEVO
        iaControlled: controlRecord !== null,
        iaActive: iaCheck.shouldRespond,
        iaControlReason: controlRecord?.reason || null
      };
    });

    // Ordenar por última interacción (más recientes primero)
    // ✅ FIX: Fallback a updatedAt/createdAt si lastInteraction no está disponible
    const getTimestamp = (chat) => {
      const t = chat.lastInteraction || chat.updatedAt || chat.createdAt || 0;
      return typeof t === 'number' ? t : new Date(t).getTime();
    };
    enrichedChats.sort((a, b) => getTimestamp(b) - getTimestamp(a));

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
    // Default to 20 — lazy load fetches in pages
    const limitNum = limit ? parseInt(limit, 10) : 20;
    // Convert cursor string to number (cursor = timestamp of oldest visible message)
    const beforeTimestamp = cursor ? parseInt(cursor, 10) : undefined;

    // ✅ CRITICAL FIX: Normalize userId to match DynamoDB format
    // If userId doesn't have @s.whatsapp.net, add it
    const normalizedUserId = userId.includes('@') ? userId : `${userId}@s.whatsapp.net`;

    logger.info(`📜 Obteniendo mensajes para ${userId} (normalizado: ${normalizedUserId}, limit: ${limitNum})`);

    // ===========================================
    // ✅ FIX: Cargar desde DynamoDB con fallback a MEMORIA
    // DynamoDB save es asíncrono (setImmediate), así que hay una ventana
    // donde la memoria tiene mensajes pero DynamoDB aún no.
    // ===========================================
    let messages = [];
    let source = 'none';

    // 1. Intentar cargar desde DynamoDB (fuente de verdad para historial)
    try {
      logger.info(`📜 Cargando últimos ${limitNum} mensajes desde DynamoDB...`);
      const conversationRepository = require('../repositories/conversation.repository');
      const dbMessages = await conversationRepository.getHistory(normalizedUserId, {
        limit: limitNum,
        beforeTimestamp
      });

      if (dbMessages && dbMessages.length > 0) {
        // When using cursor, DynamoDB returns newest-first within the window;
        // getHistory already reverses to chronological, so oldest is at index 0
        // nextCursor = timestamp of the oldest message in this batch
        const oldestMsg = dbMessages[0];
        const nextCursorValue = oldestMsg ? (oldestMsg.timestamp || null) : null;
        messages = dbMessages.map(msg => ({
          id: msg.id || msg.messageId,
          sender: msg.metadata?.sender || (msg.direction === 'incoming' ? 'user' : 'bot'),
          senderName: msg.metadata?.sender === 'admin' ? (msg.metadata?.senderName || 'Asesor') : undefined,
          message: msg.content?.text || '[Multimedia]',
          text: msg.content?.text || '[Multimedia]',
          type: msg.metadata?.originalType || msg.messageType || 'text',
          timestamp: msg.timestamp || msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now(),
          direction: msg.direction || 'incoming',
          // ✅ NUEVO: Campos de media para renderizado multimedia
          mediaUrl: msg.content?.mediaUrl || null,
          fileName: msg.content?.fileName || null,
          fileSize: msg.content?.fileSize || null,
          mimeType: msg.content?.mimeType || null,
          // ✅ NUEVO: ReplyTo para UI
          replyTo: msg.metadata?.replyTo || null
        }));
        source = 'dynamodb';
        logger.info(`📜 ${messages.length} mensajes cargados desde DynamoDB (cursor: ${beforeTimestamp || 'inicio'}, hasMore: ${dbMessages.length === limitNum})`);
      } else {
        logger.info(`📜 0 mensajes en DynamoDB, intentando memoria...`);
      }
    } catch (dbError) {
      logger.warn(`⚠️ Error cargando desde DynamoDB: ${dbError.message}, intentando memoria...`);
    }

    // 2. Fallback a MEMORIA si DynamoDB está vacío o falló
    if (messages.length === 0) {
      const conversation = conversationStateService.getConversation(normalizedUserId);
      if (conversation && conversation.messages && conversation.messages.length > 0) {
        messages = conversation.messages.map(msg => ({
          id: msg.id || msg.messageId || `mem_${msg.timestamp}`,
          sender: msg.sender || 'user',
          senderName: msg.senderName,
          message: msg.message || msg.text || '',
          text: msg.message || msg.text || '',
          type: msg.type || 'text',
          timestamp: msg.timestamp || Date.now(),
          direction: msg.direction || (msg.sender === 'user' ? 'incoming' : 'outgoing'),
          // ✅ NUEVO: Campos de media para renderizado multimedia
          mediaUrl: msg.mediaUrl || null,
          fileName: msg.fileName || null,
          fileSize: msg.fileSize || null,
          mimeType: msg.mimeType || null,
          // ✅ NUEVO: ReplyTo para UI (memoria)
          replyTo: msg.replyTo || null
        }));
        source = 'memory';
        logger.info(`📜 ${messages.length} mensajes cargados desde MEMORIA (fallback)`);
      } else {
        logger.info(`📜 Sin mensajes en memoria para ${normalizedUserId}`);
      }
    }

    // Sort ascending (oldest first) for chat display
    messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Calculate pagination metadata
    // hasMore: true if DynamoDB returned a full page (there may be earlier messages)
    // For the memory fallback, pagination is not available — always hasMore: false
    const resultHasMore = source === 'dynamodb' && messages.length === limitNum;
    // nextCursor: timestamp of the oldest message in this batch (for the next request)
    const resultNextCursor = resultHasMore && messages.length > 0
      ? messages[0].timestamp
      : null;

    res.json({
      success: true,
      messages: messages,
      hasMore: resultHasMore,
      nextCursor: resultNextCursor,
      total: messages.length,
      returned: messages.length,
      source: source
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

    // ✅ FIX: Guardar audio enviado en almacenamiento persistente (S3/Local)
    let mediaInfo = null;
    try {
      const fs = require('fs');
      const buffer = fs.readFileSync(filePath);
      const mimeType = req.file.mimetype || 'audio/ogg';
      mediaInfo = await mediaStorageService.saveOutboundMedia(buffer, req.file.originalname, mimeType, userId);
    } catch (saveError) {
      logger.warn(`⚠️ Error guardando audio outbound: ${saveError.message}`);
    }

    // Guardar mensaje en la conversación
    const conversation = conversationStateService.getConversation(userId);
    if (conversation) {
      if (!conversation.messages) conversation.messages = [];
      conversation.messages.push({
        id: mediaInfo ? mediaInfo.messageId : `audio_${Date.now()}`,
        sender: 'admin',
        type: 'audio',
        message: '[Audio enviado]',
        timestamp: Date.now(),
        // ✅ Metadata para reproducción
        mediaUrl: mediaInfo ? mediaInfo.mediaUrl : null,
        fileName: mediaInfo ? mediaInfo.fileName : req.file.originalname,
        mimeType: mediaInfo ? mediaInfo.mimeType : 'audio/ogg',
        fileSize: mediaInfo ? mediaInfo.fileSize : req.file.size
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
      case 'video':
        await whatsappProvider.sendVideo(userId, filePath, '');
        break;
      case 'audio':
        await whatsappProvider.sendAudio(userId, filePath);
        break;
      case 'document':
      default:
        await whatsappProvider.sendDocument(userId, filePath, originalName);
        break;
    }

    // ✅ FIX: Guardar archivo enviado en almacenamiento persistente (S3/Local)
    let mediaInfo = null;
    try {
      const fs = require('fs');
      const buffer = fs.readFileSync(filePath);
      const mimeType = req.file.mimetype || 'application/octet-stream';
      mediaInfo = await mediaStorageService.saveOutboundMedia(buffer, originalName, mimeType, userId);
    } catch (saveError) {
      logger.warn(`⚠️ Error guardando archivo outbound: ${saveError.message}`);
    }

    // Guardar mensaje en la conversación
    const conversation = conversationStateService.getConversation(userId);
    if (conversation) {
      if (!conversation.messages) conversation.messages = [];
      conversation.messages.push({
        id: mediaInfo ? mediaInfo.messageId : `file_${Date.now()}`,
        sender: 'admin',
        type: fileType,
        message: `[${fileType === 'image' ? 'Imagen' : fileType === 'video' ? 'Video' : fileType === 'audio' ? 'Audio' : 'Documento'} enviado: ${originalName}]`,
        fileName: originalName,
        timestamp: Date.now(),
        // ✅ Metadata para visualización/descarga
        mediaUrl: mediaInfo ? mediaInfo.mediaUrl : null,
        mimeType: mediaInfo ? mediaInfo.mimeType : req.file.mimetype,
        fileSize: mediaInfo ? mediaInfo.fileSize : req.file.size
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

/**
 * PATCH /api/conversations/:userId/custom-name
 * Actualiza el nombre personalizado de un contacto
 */
router.patch('/:userId/custom-name', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { name } = req.body;

    // conversationStateService.updateCustomName ya maneja la persistencia
    // y revive el chat si estaba borrado (isDeleted = false)
    const conversation = conversationStateService.updateCustomName(userId, name);

    res.json({
      success: true,
      conversation: {
        userId: conversation.userId,
        customName: conversation.customName,
        whatsappName: conversation.whatsappName,
        registeredName: conversation.customName || conversation.whatsappName || 'Sin nombre'
      }
    });
  } catch (error) {
    logger.error(`Error actualizando nombre para ${req.params.userId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/conversations/create-chat
 * Crea un nuevo chat manualmente
 */
router.post('/create-chat', requireAuth, async (req, res) => {
  try {
    const { phoneNumber, name } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Número de teléfono requerido' });
    }

    // Normalizar número (eliminar espacios, guiones, +, etc)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const userId = `${cleanPhone}@s.whatsapp.net`;

    logger.info(`📝 Creando nuevo chat manual: ${userId} (${name || 'Sin nombre'})`);

    // Crear o recuperar conversación
    // Esto ya añade la conversación a memoria y la persiste en DynamoDB
    const conversation = conversationStateService.getOrCreateConversation(userId, {
      realPhoneNumber: cleanPhone
    });

    // Si se proveyó un nombre, actualizarlo
    if (name) {
      conversationStateService.updateCustomName(userId, name);
    }

    // Forzar que sea visible (no deleted) y fecha actual para que suba en la lista
    conversation.isDeleted = false;
    conversation.lastInteraction = Date.now();

    // Persistimos los cambios
    const conversationRepository = require('../repositories/conversation.repository');
    await conversationRepository.saveRaw(conversation);

    res.json({
      success: true,
      conversation: {
        userId: conversation.userId,
        phoneNumber: conversation.phoneNumber,
        customName: conversation.customName,
        registeredName: conversation.customName || conversation.whatsappName || conversation.phoneNumber
      }
    });

  } catch (error) {
    logger.error('Error creando chat:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/conversations/:userId
 * Elimina una conversación (Soft Delete)
 */
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    logger.info(`🗑️ Soft-deleting chat: ${userId}`);

    const conversation = conversationStateService.softDeleteConversation(userId);

    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    res.json({ success: true, message: 'Chat eliminado correctamente' });
  } catch (error) {
    logger.error(`Error eliminando chat ${req.params.userId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
