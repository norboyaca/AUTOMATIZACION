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
 *   status: "active" | "expired" | "new_cycle",
 *   consentStatus: "pending" | "accepted" | "rejected",
 *   interactionCount: 2,
 *   welcomeSent: false,
 *   consentMessageSent: false,
 *   lastMessage: "Texto del último mensaje",
 *   messageCount: 5                     // Total de mensajes en el ciclo
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
      messageCount: 0
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
    messageCount: 0
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

  return {
    total,
    active,
    expired,
    consent: {
      accepted,
      pending,
      rejected
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
  cleanExpiredConversations
};
