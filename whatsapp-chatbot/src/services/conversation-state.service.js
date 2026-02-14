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
 * - ✅ PERSISTENCIA: DynamoDB (vía repository) + Caché en memoria
 */

const logger = require('../utils/logger');
const conversationRepository = require('../repositories/conversation.repository');
const { Conversation } = require('../models/conversation.model');

// Duración del ciclo en milisegundos (60 minutos)
const CYCLE_DURATION_MS = 60 * 60 * 1000;

// Caché en memoria para acceso rápido y compatibilidad síncrona
const conversationsCache = new Map();

// ✅ OPTIMIZACIÓN: Debounce de persistencia para evitar escrituras excesivas a DynamoDB
const persistTimers = new Map();
const PERSIST_DEBOUNCE_MS = 2000; // Esperar 2 segundos antes de persistir

// ===========================================
// ✅ Funciones de Persistencia (DynamoDB)
// ===========================================

/**
 * Carga las conversaciones activas desde DynamoDB al iniciar
 */
async function loadConversationsFromDB() {
  try {
    logger.info('🔄 Cargando conversaciones activas desde DynamoDB...');

    const activeConversations = await conversationRepository.findActive({ limit: 100 });
    logger.info(`📊 findActive() devolvió ${activeConversations.length} conversaciones`);

    let loadedCount = 0;
    for (const conv of activeConversations) {
      const convData = conv.toObject ? conv.toObject() : conv;

      // MAPEO: Modelo DynamoDB -> Estructura en memoria
      // DynamoDB usa: participantId
      // Memoria usa: userId, phoneNumber, whatsappName, etc.
      const cacheKey = convData.participantId;
      if (!cacheKey) {
        logger.warn('⚠️ Conversación sin participantId, saltando...');
        continue;
      }

      // Crear estructura compatible con memoria
      const memoryConversation = {
        // IDs (participantId de DynamoDB -> userId de memoria)
        userId: convData.participantId,
        participantId: convData.participantId,

        // Extraer phoneNumber del participantId (quitar sufijos de WhatsApp)
        phoneNumber: extractPhoneNumber(convData.participantId),

        // Nombres
        whatsappName: convData.participantName || null,

        // Estado
        status: convData.status || 'active',
        bot_active: convData.status !== 'advisor_handled', // Si está siendo atendido por asesor, bot inactivo

        // Flujo activo (para máquinas de estado)
        activeFlow: convData.activeFlow || null,
        flowState: convData.flowState || {},

        // Timestamps - convertir strings ISO a Date
        cycleStart: convData.createdAt ? new Date(convData.createdAt).getTime() : Date.now(),
        lastInteraction: convData.lastInteraction || (convData.updatedAt ? new Date(convData.updatedAt).getTime() : Date.now()),
        createdAt: convData.createdAt ? new Date(convData.createdAt) : new Date(),
        updatedAt: convData.updatedAt ? new Date(convData.updatedAt) : new Date(),

        // Consentimiento - ✅ FIX: Restaurar estado desde DynamoDB para no reenviar consent
        consentStatus: convData.consentStatus || 'pending',
        consentMessageSent: convData.consentMessageSent || false,
        datosAceptados: convData.datosAceptados || false,

        // Contadores
        interactionCount: 0,
        messageCount: 0,

        // Mensajes
        lastMessage: '',
        messages: [], // Se cargarán bajo demanda desde DynamoDB

        // Escalación
        needsHuman: convData.status === 'pending_advisor',
        needsHumanReason: null,
        assignedTo: null,
        advisorName: null,
        takenAt: null,
        escalationCount: 0,
        advisorMessages: [],

        // Bot
        botDeactivatedAt: null,
        botDeactivatedBy: null,

        // Otros
        escalationMessageSent: convData.status === 'pending_advisor',
        waitingForHuman: convData.status === 'pending_advisor',
        lastEscalationMessageAt: null,
        manuallyReactivated: false,
        whatsappNameUpdatedAt: null,

        // Contexto y metadatos
        context: convData.context || { systemPrompt: null, variables: {} },
        metadata: convData.metadata || {},
        tags: convData.tags || []
      };

      conversationsCache.set(cacheKey, memoryConversation);
      loadedCount++;
      logger.info(`✅ Cargada: ${cacheKey} (${memoryConversation.phoneNumber})`);
    }

    logger.info(`✅ ${loadedCount} conversaciones cargadas desde DynamoDB a memoria`);
  } catch (error) {
    logger.error('❌ Error cargando conversaciones desde DynamoDB:', error);
    logger.error(`   Stack: ${error.stack}`);
  }
}

/**
 * Persiste una conversación en DynamoDB (Debounced)
 * Agrupa múltiples cambios en una sola escritura
 * @param {Object} conversation - Objeto de conversación del caché
 * @param {boolean} immediate - Si true, persiste inmediatamente sin debounce
 */
async function persistConversation(conversation, immediate = false) {
  try {
    // Validar que tenga datos mínimos
    if (!conversation || !conversation.userId) return;

    const userId = conversation.userId;

    // Si es inmediato (ej: nueva conversación), persistir sin debounce
    if (immediate) {
      // Cancelar timer pendiente si existe
      if (persistTimers.has(userId)) {
        clearTimeout(persistTimers.get(userId));
        persistTimers.delete(userId);
      }
      await conversationRepository.saveRaw(conversation);
      logger.info(`💾 Conversación guardada en DynamoDB: ${conversation.userId} (${conversation.phoneNumber || conversation.participantId})`);
      return;
    }

    // ✅ DEBOUNCE: Cancelar timer anterior y crear uno nuevo
    if (persistTimers.has(userId)) {
      clearTimeout(persistTimers.get(userId));
    }

    const timer = setTimeout(async () => {
      persistTimers.delete(userId);
      try {
        await conversationRepository.saveRaw(conversation);
        logger.debug(`💾 Conversación persistida (debounced): ${userId}`);
      } catch (err) {
        logger.error(`❌ Error persistiendo conversación (debounced) ${userId}:`, err);
      }
    }, PERSIST_DEBOUNCE_MS);

    persistTimers.set(userId, timer);
  } catch (error) {
    logger.error(`❌ Error persistiendo conversación ${conversation?.userId}:`, error);
  }
}

/**
 * Inicializar la persistencia al cargar el módulo
 * ✅ RE-HABILITADO: Cargar conversaciones desde DynamoDB al arrancar
 * para que el dashboard muestre conversaciones existentes inmediatamente.
 * Baileys sigue siendo fuente de verdad para chats nuevos.
 */
loadConversationsFromDB().then(() => {
  logger.info('✅ Sistema de estado sincronizado con DynamoDB');
}).catch(err => {
  logger.warn('⚠️ No se pudo cargar desde DynamoDB, la memoria se llenará con eventos de Baileys:', err.message);
});

// ===========================================
// Lógica de Negocio
// ===========================================

/**
 * Obtiene o crea una conversación para un usuario
 * 
 * @param {string} userId - ID del usuario de WhatsApp
 * @param {Object} options - Opciones adicionales
 * @returns {Object} Conversación (referencia al caché)
 */
function getOrCreateConversation(userId, options = {}) {
  const { whatsappName, realPhoneNumber } = options;

  if (!conversationsCache.has(userId)) {
    const phoneNumber = realPhoneNumber || extractPhoneNumber(userId);

    const conversation = {
      userId,
      participantId: userId, // Compatibilidad con modelo DB
      phoneNumber,
      cycleStart: Date.now(),
      lastInteraction: Date.now(),
      status: 'active',
      consentStatus: 'pending',
      interactionCount: 0,
      welcomeSent: false,
      consentMessageSent: false,
      datosAceptados: false, // ✅ NUEVO: Persistente - true cuando acepta tratamiento de datos (no se repite)
      lastMessage: '',
      messageCount: 0,
      needsHuman: false,
      needsHumanReason: null,
      assignedTo: null,
      advisorName: null,
      takenAt: null,
      escalationCount: 0,
      bot_active: true,
      advisorMessages: [],
      botDeactivatedAt: null,
      botDeactivatedBy: null,
      messages: [], // Los mensajes se guardan en tabla aparte, esto es solo caché reciente
      escalationMessageSent: false,
      waitingForHuman: false,
      lastEscalationMessageAt: null,
      manuallyReactivated: false,
      whatsappName: (whatsappName && whatsappName.trim()) ? whatsappName.trim() : null,
      whatsappNameUpdatedAt: whatsappName ? Date.now() : null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    conversationsCache.set(userId, conversation);

    logger.info(`✅ Nueva conversación creada en memoria: ${userId}`);

    // Persistir inmediatamente (nueva conversación)
    persistConversation(conversation, true);

  } else {
    // Actualizar datos existentes si es necesario
    const conversation = conversationsCache.get(userId);
    let changed = false;

    if (whatsappName && whatsappName.trim() && !conversation.whatsappName) {
      conversation.whatsappName = whatsappName.trim();
      conversation.whatsappNameUpdatedAt = Date.now();
      changed = true;
    }

    if (realPhoneNumber && realPhoneNumber !== conversation.phoneNumber) {
      if (realPhoneNumber.length <= 13 && conversation.phoneNumber.length > 13) {
        conversation.phoneNumber = realPhoneNumber;
        logger.info(`✅ Número corregido: ${conversation.phoneNumber} → ${realPhoneNumber}`);
        changed = true;
      }
    }

    if (changed) {
      persistConversation(conversation);
    }
  }

  return conversationsCache.get(userId);
}

/**
 * Extrae el número de teléfono del userId de WhatsApp
 */
function extractPhoneNumber(userId) {
  if (!userId) return '';
  const beforeAt = userId.split('@')[0];
  let cleaned = beforeAt.replace(/^whatsapp:/i, '');

  if (cleaned.length > 13) {
    // logger.warn(`⚠️ Posible wa_id interno: ${cleaned}`);
  }
  return cleaned;
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
 */
function checkAndUpdateCycle(userId) {
  const conversation = getOrCreateConversation(userId);

  if (hasCycleExpired(conversation)) {
    logger.info(`Ciclo expirado para ${userId}, reiniciando...`);
    resetConversation(userId);
    return true; // Ciclo reiniciado
  }

  // Actualizar última interacción
  conversation.lastInteraction = Date.now();
  conversation.messageCount++;

  // Persistir actualización
  persistConversation(conversation);

  return false;
}

/**
 * Reinicia una conversación (nuevo ciclo)
 */
function resetConversation(userId) {
  if (!conversationsCache.has(userId)) {
    return getOrCreateConversation(userId);
  }

  const oldConversation = conversationsCache.get(userId);
  const phoneNumber = oldConversation.phoneNumber;

  // Preservar mensajes del día actual
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const todayStart = now - oneDayMs;

  const todayMessages = (oldConversation.messages || [])
    .filter(msg => msg.timestamp >= todayStart);

  const newConversation = {
    userId,
    participantId: userId,
    phoneNumber,
    cycleStart: Date.now(),
    lastInteraction: Date.now(),
    status: 'new_cycle',
    consentStatus: 'pending',
    interactionCount: 0,
    welcomeSent: false,
    consentMessageSent: false,
    datosAceptados: false, // ✅ NUEVO: Se reinicia al reinicar ciclo
    lastMessage: '',
    messageCount: 0,
    needsHuman: false,
    needsHumanReason: null,
    assignedTo: null,
    advisorName: null,
    takenAt: null,
    escalationCount: 0,
    bot_active: true,
    advisorMessages: [],
    botDeactivatedAt: null,
    botDeactivatedBy: null,
    messages: todayMessages,
    escalationMessageSent: false,
    waitingForHuman: false,
    lastEscalationMessageAt: null,
    manuallyReactivated: false,
    whatsappName: oldConversation.whatsappName || null,
    whatsappNameUpdatedAt: oldConversation.whatsappNameUpdatedAt || null,
    updatedAt: new Date()
  };

  conversationsCache.set(userId, newConversation);

  logger.info(`Conversación reiniciada: ${userId}`);
  persistConversation(newConversation);

  return newConversation;
}

/**
 * Actualiza el estado de consentimiento
 */
function updateConsentStatus(userId, status) {
  const conversation = getOrCreateConversation(userId);
  conversation.consentStatus = status;
  conversation.consentMessageSent = true;
  persistConversation(conversation);
}

/**
 * Marca que se envió el mensaje de bienvenida
 */
function markWelcomeSent(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.welcomeSent = true;
  persistConversation(conversation);
}

/**
 * Marca que se envió el mensaje de consentimiento
 */
function markConsentSent(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.consentMessageSent = true;
  persistConversation(conversation);
}

/**
 * Guarda el último mensaje de una conversación
 * NOTA: Los mensajes individuales se guardan vía conversationRepository.saveMessage en el procesador,
 * aquí solo actualizamos la referencia "último mensaje" en la cabecera de la conversación.
 */
function updateLastMessage(userId, message) {
  const conversation = getOrCreateConversation(userId);

  // Guardar en caché local de mensajes (para contexto inmediato)
  if (!conversation.messages) conversation.messages = [];
  conversation.messages.push(message);

  // Limitar caché local a últimos 50 mensajes para no explotar memoria
  if (conversation.messages.length > 50) {
    conversation.messages = conversation.messages.slice(-50);
  }

  conversation.lastMessage = message.content?.text || '[Multimedia]';
  conversation.lastInteraction = Date.now();

  persistConversation(conversation);
}

/**
 * Incrementa el contador de interacciones
 */
function incrementInteractionCount(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.interactionCount++;
  persistConversation(conversation);
}

/**
 * Obtiene todas las conversaciones (del caché)
 */
function getAllConversations() {
  return Array.from(conversationsCache.values()).map(conv => ({
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
  return conversationsCache.get(userId) || null;
}

/**
 * Obtiene estadísticas
 */
function getStats() {
  const all = getAllConversations();

  const active = all.filter(c => !hasCycleExpired(c)).length;
  const expired = all.filter(c => hasCycleExpired(c)).length;
  const total = all.length;

  const accepted = all.filter(c => c.consentStatus === 'accepted').length;
  const pending = all.filter(c => c.consentStatus === 'pending').length;
  const rejected = all.filter(c => c.consentStatus === 'rejected').length;

  const pendingAdvisor = all.filter(c => c.status === 'pending_advisor').length;
  const advisorHandled = all.filter(c => c.status === 'advisor_handled').length;
  const outOfHours = all.filter(c => c.status === 'out_of_hours').length;

  return {
    total,
    active,
    expired,
    consent: { accepted, pending, rejected },
    escalation: { pendingAdvisor, advisorHandled, outOfHours },
    source: 'DynamoDB (Cached)'
  };
}

/**
 * Limpia conversaciones expiradas de memoria (no de DB)
 */
function cleanExpiredConversations() {
  const now = Date.now();
  let cleaned = 0;

  for (const [userId, conversation] of conversationsCache.entries()) {
    const timeSinceLastInteraction = now - conversation.lastInteraction;
    // Si expiró hace más de 24 horas, quitar de memoria
    if (timeSinceLastInteraction > 24 * 60 * 60 * 1000) {
      conversationsCache.delete(userId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info(`🧹 Limpiadas ${cleaned} conversaciones inactivas de memoria`);
  }
  return cleaned;
}

// ===========================================
// Métodos de Escalación y Control
// ===========================================

function markForEscalation(userId, escalationData = {}) {
  const conversation = getOrCreateConversation(userId);
  conversation.status = 'pending_advisor';
  conversation.needsHuman = true;
  conversation.needsHumanReason = escalationData.reason || 'unknown';
  conversation.escalationCount = (conversation.escalationCount || 0) + 1;
  conversation.lastInteraction = Date.now();

  logger.info(`🚨 Escalación para ${userId}: ${escalationData.reason}`);
  persistConversation(conversation);
  return conversation;
}

function markOutOfHours(userId) {
  const conversation = getOrCreateConversation(userId);
  conversation.status = 'out_of_hours';
  conversation.lastInteraction = Date.now();
  persistConversation(conversation);
  return conversation;
}

function assignAdvisor(userId, advisorData = {}) {
  const conversation = getConversation(userId);
  if (!conversation) return null;

  conversation.status = 'advisor_handled';
  conversation.assignedTo = advisorData.id || null;
  conversation.advisorName = advisorData.name || null;
  conversation.takenAt = Date.now();
  conversation.lastInteraction = Date.now();
  conversation.interactionCount = 0;

  logger.info(`✅ Asesor asignado a ${userId}`);
  persistConversation(conversation);
  return conversation;
}

function releaseFromAdvisor(userId) {
  const conversation = getConversation(userId);
  if (!conversation) return null;

  conversation.status = 'active';
  conversation.assignedTo = null;
  conversation.advisorName = null;
  conversation.takenAt = null;
  conversation.needsHuman = false;
  conversation.needsHumanReason = null;
  conversation.lastInteraction = Date.now();
  conversation.bot_active = true;
  conversation.escalationMessageSent = false;
  conversation.waitingForHuman = false;
  conversation.lastEscalationMessageAt = null;
  conversation.botDeactivatedAt = null;
  conversation.botDeactivatedBy = null;

  logger.info(`🔄 Conversación liberada: ${userId}`);
  persistConversation(conversation);
  return conversation;
}

function getPendingConversations() {
  return getAllConversations().filter(c => c.status === 'pending_advisor' && c.needsHuman);
}

function getAdvisorHandledConversations() {
  return getAllConversations().filter(c => c.status === 'advisor_handled');
}

/**
 * Actualiza nombre de WhatsApp
 */
function updateWhatsappName(userId, whatsappName, force = false) {
  const conversation = getConversation(userId);
  if (!conversation) return null;

  if (!whatsappName || whatsappName.trim() === '') return conversation;

  if (!conversation.whatsappName || force) {
    conversation.whatsappName = whatsappName.trim();
    conversation.whatsappNameUpdatedAt = Date.now();
    persistConversation(conversation);
  }
  return conversation;
}

// Métodos legacy para mantener compatibilidad si se llaman desde algún lado
// (aunque ya no hacen nada relevante o usan la nueva lógica)
function getMessagesByDateRange(userId, startDate, endDate) {
  const conversation = getConversation(userId);
  if (!conversation || !conversation.messages) return [];
  // Implementación simplificada sobre caché
  return conversation.messages;
}

function cleanOldMessages(userId, daysToKeep = 1) {
  return 0; // Ya se maneja en lógica de reset
}

module.exports = {
  getOrCreateConversation,
  extractPhoneNumber,
  hasCycleExpired,
  getRemainingTime,
  getRemainingTimeFormatted,
  checkAndUpdateCycle,
  resetConversation,
  updateConsentStatus,
  markWelcomeSent,
  markConsentSent,
  updateLastMessage,
  incrementInteractionCount,
  getAllConversations,
  getConversation,
  getStats,
  cleanExpiredConversations,
  // Nuevos métodos exportados
  markForEscalation,
  markOutOfHours,
  assignAdvisor,
  releaseFromAdvisor,
  getPendingConversations,
  getAdvisorHandledConversations,
  updateWhatsappName,
  getMessagesByDateRange,
  cleanOldMessages,
  // ✅ Exportar para que Baileys y otros módulos puedan recargar
  loadConversationsFromDB
};
