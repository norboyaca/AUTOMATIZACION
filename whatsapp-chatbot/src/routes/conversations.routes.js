/**
 * ===========================================
 * RUTAS DE CONVERSACIONES
 * ===========================================
 *
 * Endpoints:
 * - GET /api/conversations - Listar todas las conversaciones
 * - GET /api/conversations/stats - Obtener estadísticas
 * - POST /api/conversations/:userId/reset - Reset manual de conversación
 */

const express = require('express');
const conversationStateService = require('../services/conversation-state.service');
const chatService = require('../services/chat.service');
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

module.exports = router;
