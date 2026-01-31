/**
 * ===========================================
 * SERVICIO DE ESTADO DE CONVERSACIONES
 * ===========================================
 *
 * Responsabilidades:
 * - Gestionar el estado de cada conversación
 * - Controlar ciclos de 60 minutos por número
 * - Manejar resets manuales y automáticos
 * - Almacenar historial de mensajes
 */

const logger = require('../utils/logger');

// Duración del ciclo en milisegundos (60 minutos)
const CYCLE_DURATION_MS = 60 * 60 * 1000;

/**
 * Estructura de datos por conversación:
 *
 * {
 *   userId: "573503267342@s.whatsapp.net",
 *   phoneNumber: "573503267342",
 *   cycleStart: 1706544000000,        // Timestamp inicio del ciclo actual
 *   lastInteraction: 1706547600000,   // Última actividad
 *   status: "active" | "expired" | "new_cycle" | "pending_advisor" | "out_of_hours" | "advisor_handled",
 *   consentStatus: "pending" | "accepted" | "rejected",
 *   interactionCount: 2,
 *   welcomeSent: false,
 *   consentMessageSent: false,
 *   lastMessage: "Texto del último mensaje",
 *   messageCount: 5,                   // Total de mensajes en el ciclo
 *
 *   // CAMPOS PARA ESCALACIÓN A HUMANO:
 *   needsHuman: false,                // Indica si requiere intervención humana
 *   needsHumanReason: null,            // Razón: 'user_requested', 'complex_topic', 'multiple_retries'
 *   assignedTo: null,                  // ID del asesor que tomó la conversación
 *   advisorName: null,                 // Nombre del asesor
 *   takenAt: null,                     // Timestamp cuando fue tomado por asesor
 *   escalationCount: 0,                // Contador de veces que fue escalado
 *
 *   // NUEVOS CAMPOS PARA CONTROL DEL BOT (PUNTO DE CONTROL 2):
 *   bot_active: true,                  // ✅ CRÍTICO: Controla si el bot responde automáticamente
 *   advisorMessages: [],               // Historial de mensajes enviados por asesores
 *   botDeactivatedAt: null,            // Timestamp de desactivación del bot
 *   botDeactivatedBy: null,            // ID del asesor que desactivó el bot
 *   messages: [],                      // Historial completo de mensajes
 *
 *   // NUEVOS CAMPOS PARA EVITAR REPETICIÓN:
 *   escalationMessageSent: false,      // ✅ Ya se envió mensaje de escalación
 *   waitingForHuman: false,            // ✅ Esperando respuesta de asesor (no responder más)
 *   lastEscalationMessageAt: null      // Timestamp del último mensaje de escalación
 * }
 */

// Almacenamiento en memoria (puede migrarse a DB después)
const conversations = new Map();

/**
 * Obtiene o crea una conversación para un usuario
 */
function getOrCreateConversation(userId) {
  if (!conversations.has(userId)) {
    const phoneNumber = extractPhoneNumber(userId);

    const conversation = {
      userId,
      phoneNumber,
      cycleStart: Date.now(),
      lastInteraction: Date.now(),
      status: 'active',
      consentStatus: 'pending',
      interactionCount: 0,
      welcomeSent: false,
      consentMessageSent: false,
      lastMessage: '',
      messageCount: 0,
      // Nuevos campos para escalación
      needsHuman: false,
      needsHumanReason: null,
      assignedTo: null,
      advisorName: null,
      takenAt: null,
      escalationCount: 0,
      // NUEVOS CAMPOS PARA CONTROL DEL BOT (PUNTO DE CONTROL 2)
      bot_active: true,                  // ✅ Bot activo por defecto
      advisorMessages: [],               // Historial de mensajes de asesores
      botDeactivatedAt: null,            // Timestamp de desactivación
      botDeactivatedBy: null,            // ID del asesor que desactivó
      messages: [],                      // Historial completo de mensajes
      // NUEVOS CAMPOS PARA EVITAR REPETICIÓN
      escalationMessageSent: false,      // No se ha enviado mensaje de escalación
      waitingForHuman: false,            // No está esperando asesor
      lastEscalationMessageAt: null,      // Sin timestamp de escalación
      // ✅ NUEVO: Flag para controlar reactivación manual
      manuallyReactivated: false         // Indica si fue reactivada manualmente por asesor
    };

    conversations.set(userId, conversation);
    logger.info(`Nueva conversación creada: ${userId}`);
  }

  return conversations.get(userId);
}

/**
 * Extrae el número de teléfono del userId de WhatsApp
 */
function extractPhoneNumber(userId) {
  // userId format: "573503267342@s.whatsapp.net" or "573503267342@c.us"
  return userId.split('@')[0];
}

/**
 * Verifica si el ciclo de 60 minutos ha expirado
 */
function hasCycleExpired(conversation) {
  const now = Date.now();
  const timeSinceLastInteraction = now - conversation.lastInteraction;
  return timeSinceLastInteraction >= CYCLE_DURATION_MS;
}

/**
 * Obtiene el tiempo restante del ciclo en milisegundos
 */
function getRemainingTime(conversation) {
  const now = Date.now();
  const elapsed = now - conversation.cycleStart;
  const remaining = CYCLE_DURATION_MS - elapsed;
  return Math.max(0, remaining);
}

/**
 * Obtiene el tiempo restante formateado (minutos)
 */
function getRemainingTimeFormatted(conversation) {
  const remaining = getRemainingTime(conversation);
  const minutes = Math.floor(remaining / (60 * 1000));
  const seconds = Math.floor((remaining % (60 * 1000)) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Verifica y actualiza el ciclo de una conversación
 * Retorna true si se reinició el ciclo
 */
function checkAndUpdateCycle(userId) {
  const conversation = getOrCreateConversation(userId);

  if (hasCycleExpired(conversation)) {
    logger.info(`Ciclo expirado para ${userId}, reiniciando...`);
    resetConversation(userId);
    return true;
  }

  // Actualizar última interacción
  conversation.lastInteraction = Date.now();
  conversation.messageCount++;

  return false;
}

/**
 * Reinicia una conversación (nuevo ciclo)
 */
function resetConversation(userId) {
  if (!conversations.has(userId)) {
    return getOrCreateConversation(userId);
  }

  const oldConversation = conversations.get(userId);
  const phoneNumber = oldConversation.phoneNumber;

  const newConversation = {
    userId,
    phoneNumber,
    cycleStart: Date.now(),
    lastInteraction: Date.now(),
    status: 'new_cycle',
    consentStatus: 'pending',
    interactionCount: 0,
    welcomeSent: false,
    consentMessageSent: false,
    lastMessage: '',
    messageCount: 0,
    // Nuevos campos para escalación (resetear)
    needsHuman: false,
    needsHumanReason: null,
    assignedTo: null,
    advisorName: null,
    takenAt: null,
    escalationCount: 0,
    // NUEVOS CAMPOS PARA CONTROL DEL BOT (resetear al reiniciar ciclo)
    bot_active: true,                  // ✅ Reactivar bot al reiniciar
    advisorMessages: [],               // Limpiar historial de asesores
    botDeactivatedAt: null,            // Limpiar timestamp de desactivación
    botDeactivatedBy: null,            // Limpiar quién desactivó
    messages: [],                      // Limpiar historial de mensajes
    // NUEVOS CAMPOS PARA EVITAR REPETICIÓN (resetear)
    escalationMessageSent: false,      // Resetear flag de escalación
    waitingForHuman: false,            // Resetear espera
    lastEscalationMessageAt: null,      // Resetear timestamp
    manuallyReactivated: false          // ✅ NUEVO: Resetear flag de reactivación manual
  };

  conversations.set(userId, newConversation);
  logger.info(`Conversación reiniciada: ${userId}`);

  return newConversation;
}

/**
 * Actualiza el estado de consentimiento
 */
function updateConsentStatus(userId, status) {
  const conversation = getOrCreateConversation(userId);
  conversation.consentStatus = status;
  conversation.consentMessageSent = true;
}

/**
 * Marca que se envió el mensaje de bienvenida
 */
function markWelcomeSent(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.welcomeSent = true;
}

/**
 * Marca que se envió el mensaje de consentimiento
 */
function markConsentSent(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.consentMessageSent = true;
}

/**
 * Guarda el último mensaje de una conversación
 */
function updateLastMessage(userId, message) {
  const conversation = getOrCreateConversation(userId);
  conversation.lastMessage = message;
  conversation.lastInteraction = Date.now();
}

/**
 * Incrementa el contador de interacciones
 */
function incrementInteractionCount(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.interactionCount++;
}

/**
 * Obtiene todas las conversaciones
 */
function getAllConversations() {
  return Array.from(conversations.values()).map(conv => ({
    ...conv,
    remainingTime: getRemainingTime(conv),
    remainingTimeFormatted: getRemainingTimeFormatted(conv),
    timeSinceLastInteraction: Date.now() - conv.lastInteraction
  }));
}

/**
 * Obtiene una conversación por userId
 */
function getConversation(userId) {
  return conversations.get(userId) || null;
}

/**
 * Obtiene estadísticas de conversaciones
 */
function getStats() {
  const all = getAllConversations();
  const now = Date.now();

  const active = all.filter(c => !hasCycleExpired(c)).length;
  const expired = all.filter(c => hasCycleExpired(c)).length;
  const total = all.length;

  // Consentimiento
  const accepted = all.filter(c => c.consentStatus === 'accepted').length;
  const pending = all.filter(c => c.consentStatus === 'pending').length;
  const rejected = all.filter(c => c.consentStatus === 'rejected').length;

  // NUEVO: Estadísticas de escalación
  const pendingAdvisor = all.filter(c => c.status === 'pending_advisor').length;
  const advisorHandled = all.filter(c => c.status === 'advisor_handled').length;
  const outOfHours = all.filter(c => c.status === 'out_of_hours').length;

  return {
    total,
    active,
    expired,
    consent: {
      accepted,
      pending,
      rejected
    },
    escalation: {
      pendingAdvisor,
      advisorHandled,
      outOfHours
    }
  };
}

/**
 * Limpia conversaciones expiradas (mantenimiento)
 */
function cleanExpiredConversations() {
  const now = Date.now();
  let cleaned = 0;

  for (const [userId, conversation] of conversations.entries()) {
    // Si expiró hace más de 24 horas, eliminar
    const timeSinceLastInteraction = now - conversation.lastInteraction;
    if (timeSinceLastInteraction > 24 * 60 * 60 * 1000) {
      conversations.delete(userId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info(`Limpiadas ${cleaned} conversaciones expiradas (24h+)`);
  }

  return cleaned;
}

// ===========================================
// NUEVOS MÉTODOS PARA ESCALACIÓN A HUMANO
// ===========================================

/**
 * Marca una conversación para escalación a humano
 *
 * @param {string} userId - ID del usuario
 * @param {Object} escalationData - Datos de la escalación
 * @returns {Object} Conversación actualizada
 */
function markForEscalation(userId, escalationData = {}) {
  const conversation = getOrCreateConversation(userId);

  conversation.status = 'pending_advisor';
  conversation.needsHuman = true;
  conversation.needsHumanReason = escalationData.reason || 'unknown';
  conversation.escalationCount = (conversation.escalationCount || 0) + 1;
  conversation.lastInteraction = Date.now();

  logger.info(`🚨 Usuario ${userId} marcado para escalación: ${escalationData.reason || 'unknown'} (escalación #${conversation.escalationCount})`);

  return conversation;
}

/**
 * Marca una conversación como fuera de horario
 *
 * @param {string} userId - ID del usuario
 * @returns {Object} Conversación actualizada
 */
function markOutOfHours(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.status = 'out_of_hours';
  conversation.lastInteraction = Date.now();

  logger.info(`🌙 Usuario ${userId} marcado como fuera de horario`);

  return conversation;
}

/**
 * Asigna un asesor a una conversación
 *
 * @param {string} userId - ID del usuario
 * @param {Object} advisorData - Datos del asesor { id, name, email }
 * @returns {Object|null} Conversación actualizada o null si no existe
 */
function assignAdvisor(userId, advisorData = {}) {
  const conversation = getConversation(userId);

  if (!conversation) {
    logger.warn(`No se encontró conversación para ${userId} al asignar asesor`);
    return null;
  }

  conversation.status = 'advisor_handled';
  conversation.assignedTo = advisorData.id || null;
  conversation.advisorName = advisorData.name || null;
  conversation.takenAt = Date.now();
  conversation.lastInteraction = Date.now();

  // ✅ CORRECCIÓN: Resetear contador de interacciones cuando el asesor toma la conversación
  // Esto evita que se escale nuevamente por "multiple_retries" después de que el asesor responda
  conversation.interactionCount = 0;
  logger.info(`✅ Asesor ${advisorData.name || advisorData.id} tomó conversación de ${userId}`);
  logger.info(`   ✅ interactionCount reseteado a 0`);

  return conversation;
}

/**
 * Libera una conversación de vuelta al bot
 *
 * @param {string} userId - ID del usuario
 * @returns {Object|null} Conversación actualizada o null si no existe
 */
function releaseFromAdvisor(userId) {
  const conversation = getConversation(userId);

  if (!conversation) {
    logger.warn(`No se encontró conversación para ${userId} al liberar`);
    return null;
  }

  conversation.status = 'active';
  conversation.assignedTo = null;
  conversation.advisorName = null;
  conversation.takenAt = null;
  conversation.needsHuman = false;
  conversation.needsHumanReason = null;
  conversation.lastInteraction = Date.now();

  // ✅ CORRECCIÓN: Reactivar el bot cuando se libera la conversación
  conversation.bot_active = true;

  // ✅ CORRECCIÓN: Resetear flags de escalación para permitir nueva respuesta
  conversation.escalationMessageSent = false;
  conversation.waitingForHuman = false;
  conversation.lastEscalationMessageAt = null;
  conversation.botDeactivatedAt = null;
  conversation.botDeactivatedBy = null;

  logger.info(`🔄 Conversación de ${userId} liberada de vuelta al bot`);
  logger.info(`   ✅ bot_active: true`);
  logger.info(`   ✅ status: active`);
  logger.info(`   ✅ waitingForHuman: false`);

  return conversation;
}

/**
 * Obtiene todas las conversaciones que necesitan atención humana
 *
 * @returns {Array} Lista de conversaciones pendientes
 */
function getPendingConversations() {
  const all = getAllConversations();
  return all.filter(c =>
    c.status === 'pending_advisor' && c.needsHuman
  );
}

/**
 * Obtiene todas las conversaciones atendidas por asesores
 *
 * @returns {Array} Lista de conversaciones con asesores
 */
function getAdvisorHandledConversations() {
  const all = getAllConversations();
  return all.filter(c => c.status === 'advisor_handled');
}


module.exports = {
  // Gestión de conversaciones
  getOrCreateConversation,
  getConversation,
  getAllConversations,
  resetConversation,

  // Ciclos
  checkAndUpdateCycle,
  hasCycleExpired,
  getRemainingTime,
  getRemainingTimeFormatted,

  // Estado
  updateConsentStatus,
  updateLastMessage,
  markWelcomeSent,
  markConsentSent,
  incrementInteractionCount,

  // Estadísticas
  getStats,
  cleanExpiredConversations,

  // NUEVO: Escalación a humano
  markForEscalation,
  markOutOfHours,
  assignAdvisor,
  releaseFromAdvisor,
  getPendingConversations,
  getAdvisorHandledConversations
};
