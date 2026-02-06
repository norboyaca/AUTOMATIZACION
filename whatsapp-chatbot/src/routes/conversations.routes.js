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
const numberControlService = require('../services/number-control.service');
const spamControlService = require('../services/spam-control.service');
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

    // Enriquecer con información del control de números
    conversations = conversations.map(conv => {
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
 * Obtiene el historial COMPLETO de mensajes de una conversación activa
 *
 * ✅ CAMBIADO: Ahora devuelve TODOS los mensajes por defecto
 * - No se limita a 4 mensajes
 * - Solo devuelve mensajes de la conversación activa actual (no días anteriores)
 * - Query params opcionles:
 *   - limit: para fines especiales de debugging
 *   - full: true para cargar historial completo (ahora es el default)
 */
router.get('/:userId/messages', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const conversation = conversationStateService.getConversation(userId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    // ✅ CAMBIADO: Por defecto cargar TODOS los mensajes (ilimitado)
    // Solo se puede limitar explícitamente con query param para debugging
    const explicitLimit = req.query.limit ? parseInt(req.query.limit, 10) : null;

    // ===========================================
    // ✅ CORRECCIÓN PROBLEMA 1 & 2: No combinar advisorMessages
    // ===========================================
    // ANTES: Se combinaba conversation.messages + advisorMessages
    //        Esto causaba duplicación porque advisorMessages también
    //        estaba guardado en conversation.messages
    //
    // AHORA: Solo usar conversation.messages que YA incluye todos:
    //        - Mensajes de usuario (sender='user')
    //        - Mensajes del bot (sender='bot')
    //        - Mensajes de asesores (sender='admin')

    const allMessages = conversation.messages || [];

    // Ordenar por timestamp (cronológicamente)
    allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // ✅ CAMBIADO: Por defecto devolver TODOS los mensajes
    const messagesToReturn = explicitLimit
      ? allMessages.slice(-explicitLimit)  // Solo si se pide explícitamente
      : allMessages;  // Por defecto: todos los mensajes

    logger.info(`📜 Mensajes cargados para ${userId}: ${messagesToReturn.length}/${allMessages.length} mensajes`);

    res.json({
      success: true,
      messages: messagesToReturn,
      total: allMessages.length,
      returned: messagesToReturn.length,
      isLimited: explicitLimit !== null,
      conversationStart: conversation.cycleStart,
      status: conversation.status
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

module.exports = router;
