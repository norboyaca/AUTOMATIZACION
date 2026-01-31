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
 */

const express = require('express');
const conversationStateService = require('../services/conversation-state.service');
const chatService = require('../services/chat.service');
const advisorControlService = require('../services/advisor-control.service');
const timeSimulation = require('../services/time-simulation.service');
const { requireAuth } = require('../middlewares/auth.middleware');
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
 */
router.get('/', requireAuth, (req, res) => {
  try {
    const { status, consent } = req.query;

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

    res.json({
      success: true,
      conversations,
      total: conversations.length
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
 * Obtiene el historial de mensajes de una conversación
 *
 * Query params:
 * - limit: número máximo de mensajes a devolver (default: 4, últimos 4 mensajes)
 * - full: true para cargar historial completo (solo para debugging)
 */
router.get('/:userId/messages', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = req.query.full ? 'all' : parseInt(req.query.limit || '4', 10);

    const advisorMessages = advisorControlService.getAdvisorMessages(userId);
    const conversation = conversationStateService.getConversation(userId);

    // Combinar mensajes del asesor con el historial general
    const allMessages = conversation && conversation.messages
      ? [...conversation.messages, ...advisorMessages]
      : advisorMessages;

    // Ordenar por timestamp
    allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // LIMITAR: Solo devolver los últimos N mensajes (default: 4)
    const limitedMessages = limit === 'all'
      ? allMessages
      : allMessages.slice(-limit);

    logger.debug(`Mensajes devueltos para ${userId}: ${limitedMessages.length}/${allMessages.length}`);

    res.json({
      success: true,
      messages: limitedMessages,
      total: allMessages.length, // Total de mensajes existentes
      returned: limitedMessages.length, // Cantidad devuelta
      isLimited: limit !== 'all'
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

    res.json({
      success: true,
      isSimulationActive: isActive,
      simulatedTime: simulated,
      currentRealTime: new Date().toLocaleTimeString(),
      currentEffectiveTime: timeSimulation.getCurrentTime().toLocaleTimeString()
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

module.exports = router;
