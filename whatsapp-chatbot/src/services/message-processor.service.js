/**
 * ===========================================
 * PROCESADOR DE MENSAJES - FLUJO PRINCIPAL
 * ===========================================
 *
 * PUNTO DE CONTROL ÚNICO para todo mensaje entrante.
 * Implementa todos los puntos de control requeridos.
 *
 * PUNTOS DE CONTROL:
 * - Punto 1: Verificar bot_active
 * - Punto 3: Fallback obligatorio
 * - Punto 4: Control de horario (4:30 PM)
 * - Punto 5: Flujo general
 */

const logger = require('../utils/logger');
const conversationStateService = require('./conversation-state.service');
const escalationService = require('./escalation.service');
const chatService = require('./chat.service');
const whatsappProvider = require('../providers/whatsapp');
const timeSimulation = require('./time-simulation.service');

// ✅ NUEVO: Socket.IO para emitir eventos de escalación al dashboard
let io = null;

function setSocketIO(socketIOInstance) {
  io = socketIOInstance;
  logger.info('✅ Socket.IO inicializado en message-processor');
}

// ===========================================
// MENSAJAGES DEL SISTEMA
// ===========================================
const NO_INFO_MESSAGE = 'Comprendo, sumercé. 👩‍💼\n\nEl asesor de NORBOY encargado de este tema le atenderá en breve...';

// ===========================================
// CONFIGURACIÓN DE HORARIO DE ATENCIÓN
// ===========================================
/**
 * Horario de atención: hasta las 4:30 PM
 */
const BUSINESS_HOURS = {
  endHour: 16,          // 4:00 PM
  endMinute: 30,        // 4:30 PM
  timezone: 'America/Bogota'
};

// ===========================================
// PUNTO DE CONTROL 5: FLUJO GENERAL
// ===========================================

/**
 * Procesa un mensaje entrante implementando todos los puntos de control
 *
 * @param {string} userId - ID del usuario de WhatsApp
 * @param {string} message - Mensaje recibido
 * @returns {Promise<string|null>} Respuesta a enviar o null si no se debe responder
 */
async function processIncomingMessage(userId, message) {
  try {
    logger.info(`📨 Procesando mensaje de ${userId}: "${message.substring(0, 50)}..."`);

    // Obtener o crear conversación
    const conversation = conversationStateService.getOrCreateConversation(userId);

    // Actualizar última interacción
    conversation.lastInteraction = Date.now();
    conversation.lastMessage = message;

    // ===========================================
    // VERIFICACIÓN DE CONSENTIMIENTO
    // ===========================================
    // Si el consentimiento está solicitado, verificar la respuesta del usuario
    if (conversation.consentMessageSent === true && conversation.consentStatus === 'pending') {
      const normalizedMessage = message.toLowerCase().trim();
      logger.info(`📋 Verificando respuesta de consentimiento: "${normalizedMessage}"`);

      // Verificar si acepta
      if (normalizedMessage === 'si' || normalizedMessage === 'sí' ||
          normalizedMessage === '1' || normalizedMessage.includes('acept')) {
        logger.info(`✅ Usuario ${userId} ACEPTÓ el consentimiento`);
        chatService.setConsentResponse(userId, true);
        conversation.consentStatus = 'accepted';
        conversation.consentMessageSent = false;

        // Enviar confirmación
        const confirmationMsg = `¡Perfecto, sumercé! 👍\n\nAhora puedo asesorarte.\n\n¿En qué puedo ayudarte?`;
        await whatsappProvider.sendMessage(userId, confirmationMsg);
        await saveMessage(userId, message, 'user');
        await saveMessage(userId, confirmationMsg, 'bot', 'system');

        return null; // No procesar más este mensaje
      }

      // Verificar si rechaza
      if (normalizedMessage === 'no' || normalizedMessage === '2' ||
          normalizedMessage.includes('rechaz')) {
        logger.info(`❌ Usuario ${userId} RECHAZÓ el consentimiento`);
        chatService.setConsentResponse(userId, false);
        conversation.consentStatus = 'rejected';
        conversation.consentMessageSent = false;
        conversation.bot_active = false; // Desactivar bot

        // Enviar mensaje de rechazo
        const rejectionMsg = `Entendido, sumercé. Su decisión ha sido registrada.\n\nSi cambia de opinión, puede escribirnos nuevamente.`;
        await whatsappProvider.sendMessage(userId, rejectionMsg);
        await saveMessage(userId, message, 'user');
        await saveMessage(userId, rejectionMsg, 'bot', 'system');

        return null; // No procesar más este mensaje
      }
    }

    // ✅ NUEVO: Log del estado actual al recibir mensaje
    logger.debug(`🔍 Estado INICIAL de conversación ${userId}:`);
    logger.debug(`   bot_active: ${conversation.bot_active}`);
    logger.debug(`   status: ${conversation.status}`);
    logger.debug(`   waitingForHuman: ${conversation.waitingForHuman}`);
    logger.debug(`   escalationMessageSent: ${conversation.escalationMessageSent}`);

    // ===========================================
    // PUNTO DE CONTROL 1: BOT ACTIVO?
    // ===========================================
    // Si el bot está desactivado, NO responder automáticamente
    if (conversation.bot_active === false) {
      logger.info(`🔴 Bot DESACTIVADO para ${userId}. No se responde automáticamente.`);
      logger.info(`   Razón: Estado actual = ${conversation.status}`);
      logger.info(`   Desactivado por: ${conversation.botDeactivatedBy || 'sistema'}`);
      logger.debug(`🔍 Estado conversación ${userId}:`);
      logger.debug(`   bot_active: ${conversation.bot_active}`);
      logger.debug(`   status: ${conversation.status}`);
      logger.debug(`   waitingForHuman: ${conversation.waitingForHuman}`);

      // Guardar mensaje pero NO responder
      await saveMessage(userId, message, 'user');

      // Si está en estado advisor_handled, no hacer nada más
      // El asesor está atendiendo manualmente
      return null;
    }

    // ===========================================
    // NUEVA REGLA: ESPERA POR ASESOR (evitar repetición)
    // ===========================================
    // Si ya está esperando asesor y YA se envió el mensaje de escalación,
    // NO responder nada más. Solo guardar el mensaje.
    if (conversation.waitingForHuman === true) {
      logger.info(`⏸️ Usuario ${userId} está esperando asesor. NO se responde.`);
      logger.info(`   escalationMessageSent: ${conversation.escalationMessageSent}`);
      logger.info(`   Mensaje del usuario guardado: "${message.substring(0, 50)}..."`);

      // Solo guardar el mensaje del usuario
      await saveMessage(userId, message, 'user');
      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 4: HORARIO DE ATENCIÓN
    // ===========================================
    if (isOutOfHours()) {
      logger.info(`🌙 Fuera de horario para ${userId}`);

      // Solo enviar mensaje de fuera de horario si NO se ha enviado antes
      if (conversation.escalationMessageSent === true) {
        logger.info(`   Mensaje de fuera de horario ya enviado. Solo guardando mensaje.`);
        await saveMessage(userId, message, 'user');
        return null;
      }

      const outOfHoursMsg = getOutOfHoursMessage();

      // Actualizar estado
      conversation.status = 'out_of_hours';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.escalationMessageSent = true;
      conversation.waitingForHuman = true;
      conversation.lastEscalationMessageAt = Date.now();

      // Enviar mensaje de fuera de horario
      await whatsappProvider.sendMessage(userId, outOfHoursMsg);

      // Guardar mensajes
      await saveMessage(userId, message, 'user');
      await saveMessage(userId, outOfHoursMsg, 'bot', 'out_of_hours');

      logger.info(`✅ Mensaje fuera de horario enviado a ${userId}`);

      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 3: EVALUAR ESCALACIÓN (ANTES DE IA)
    // ===========================================
    // IMPORTANTE: Evaluar escalación ANTES de llamar a OpenAI para:
    // 1. Ahorrar tokens de OpenAI
    // 2. Responder más rápido
    // 3. Escalar correctamente cuando el usuario lo pide

    const interactionCount = conversation.interactionCount || 0;
    const escalation = escalationService.evaluateEscalation(userId, message, interactionCount);

    if (escalation.needsHuman) {
      logger.info(`🚨 Escalación detectada para ${userId}: ${escalation.reason}`);
      logger.info(`   Prioridad: ${escalation.priority}`);

      // Verificar que no se haya enviado ya el mensaje de escalación
      if (conversation.escalationMessageSent === true) {
        logger.info(`   Mensaje de escalación ya enviado. Solo guardando mensaje.`);
        await saveMessage(userId, message, 'user');
        return null;
      }

      // Mensaje de escalación
      const escalationMsg = `Comprendo, sumercé. 👩‍💼

El asesor de NORBOY encargado de este tema le atenderá en breve...`;

      // Actualizar estado de la conversación
      conversation.status = 'pending_advisor';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.needsHumanReason = escalation.reason;
      conversation.escalationMessageSent = true;
      conversation.waitingForHuman = true;
      conversation.lastEscalationMessageAt = Date.now();

      logger.info(`📊 Estado cambiado a: pending_advisor`);
      logger.info(`   → bot_active: false`);
      logger.info(`   → waitingForHuman: true`);

      // Guardar mensajes
      await saveMessage(userId, message, 'user');
      await saveMessage(userId, escalationMsg, 'bot', 'escalation');

      // Enviar mensaje de escalación
      await whatsappProvider.sendMessage(userId, escalationMsg);

      // ✅ NUEVO: Emitir evento de escalación al dashboard
      if (io) {
        io.emit('escalation-detected', {
          userId: userId,
          phoneNumber: conversation.phoneNumber,
          reason: escalation.reason,
          priority: escalation.priority,
          message: message,
          detectedKeyword: escalation.detectedKeyword,
          timestamp: Date.now()
        });
        logger.info(`📢 Evento 'escalation-detected' emitido al dashboard para ${userId}`);
      }

      logger.info(`✅ Mensaje de escalación enviado a ${userId}`);

      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 4: PROCESAR MENSAJE CON IA
    // ===========================================

    // Intentar generar respuesta con la IA
    let response;
    try {
      response = await chatService.generateTextResponse(userId, message, {
        skipConsent: false
      });
    } catch (aiError) {
      logger.error(`Error en IA para ${userId}:`, aiError);
      response = null;
    }

    // ===========================================
    // MANEJO DE RESPUESTA DE ESCALACIÓN
    // ===========================================
    // chatService puede retornar un objeto de escalación { type, text, needsHuman }
    let responseText = null;
    let isEscalation = false;

    if (response && typeof response === 'object' &&
        (response.type === 'escalation' || response.type === 'escalation_no_info')) {

      // Es una respuesta de escalación desde chatService
      isEscalation = true;
      responseText = response.text || NO_INFO_MESSAGE;

      const escalationReason = response.escalation?.reason || 'unknown';

      logger.info(`🚨 Escalación detectada desde chatService para ${userId}`);
      logger.info(`   Razón: ${escalationReason}`);
      logger.info(`   Tipo: ${response.type}`);

      // Actualizar estado de la conversación
      if (!conversation.escalationMessageSent) {
        conversation.status = 'pending_advisor';
        conversation.bot_active = false;
        conversation.needs_human = true;
        conversation.needsHumanReason = escalationReason;
        conversation.escalationMessageSent = true;
        conversation.waitingForHuman = true;
        conversation.lastEscalationMessageAt = Date.now();

        logger.info(`📊 Estado actualizado para ${userId}:`);
        logger.info(`   → status: pending_advisor`);
        logger.info(`   → bot_active: false`);
        logger.info(`   → waitingForHuman: true`);
        logger.info(`   → escalationMessageSent: true`);
      }

      // Guardar mensajes
      await saveMessage(userId, message, 'user');

      // ✅ CORRECCIÓN: Pasar el objeto response completo si tiene type especial
      if (typeof response === 'object' && response.type) {
        await saveMessage(userId, response, 'bot', response.type);
      } else {
        await saveMessage(userId, responseText, 'bot', 'text');
      }

      // Enviar mensaje de escalación
      await whatsappProvider.sendMessage(userId, responseText);

      // ✅ NUEVO: Emitir evento de escalación al dashboard
      if (io) {
        io.emit('escalation-detected', {
          userId: userId,
          phoneNumber: conversation.phoneNumber,
          reason: escalationReason,
          priority: response.escalation?.priority || 'medium',
          message: message,
          type: response.type,
          timestamp: Date.now()
        });
        logger.info(`📢 Evento 'escalation-detected' emitido al dashboard para ${userId}`);
      }

      logger.info(`✅ Mensaje de escalación enviado a ${userId}: "${responseText}"`);

      return null; // No enviar nada más (ya se envió arriba)
    }

    // Extraer texto de la respuesta si es un objeto con propiedad 'text'
    if (response && typeof response === 'object' && response.text) {
      responseText = response.text;
    } else if (typeof response === 'string') {
      responseText = response;
    }

    // ===========================================
    // PUNTO DE CONTROL 3: FALLBACK OBLIGATORIO
    // ===========================================
    if (!responseText || responseText === null || responseText === undefined) {
      logger.warn(`⚠️ Sin respuesta para ${userId}. Activando fallback.`);
      logger.warn(`   Mensaje: "${message.substring(0, 100)}..."`);

      // IMPORTANTE: Solo enviar el mensaje de fallback si NO se ha enviado antes
      if (conversation.escalationMessageSent === true) {
        logger.info(`   Mensaje de escalación ya enviado. Solo guardando mensaje.`);
        await saveMessage(userId, message, 'user');
        return null;
      }

      const fallbackMsg = "Su mensaje se procesará cuanto antes.";

      // Actualizar estado a pendiente de asesor
      conversation.status = 'pending_advisor';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.needsHumanReason = 'no_response_found';

      // NUEVO: Marcar que ya se envió el mensaje y está esperando
      conversation.escalationMessageSent = true;
      conversation.waitingForHuman = true;
      conversation.lastEscalationMessageAt = Date.now();

      logger.info(`📊 Estado cambiado a: pending_advisor (fallback)`);
      logger.info(`   → bot_active: false`);
      logger.info(`   → waitingForHuman: true`);

      // Enviar mensaje de fallback (SOLO UNA VEZ)
      await whatsappProvider.sendMessage(userId, fallbackMsg);

      // Guardar mensajes
      await saveMessage(userId, message, 'user');
      await saveMessage(userId, fallbackMsg, 'bot', 'escalation_fallback');

      logger.info(`🚨 Usuario ${userId} escalado a asesor (fallback)`);

      return null;
    }

    // ===========================================
    // RESPUESTA EXITOSA
    // ===========================================
    logger.info(`✅ Respuesta generada para ${userId}: "${responseText.substring(0, 50)}..."`);

    // Guardar mensajes
    await saveMessage(userId, message, 'user');

    // ✅ CORRECCIÓN: Pasar el objeto response completo si tiene type especial
    // Esto preserva el type 'consent', 'system', 'escalation', etc.
    if (typeof response === 'object' && response.type) {
      // Es un objeto con type especial (consent, system, escalation, etc.)
      await saveMessage(userId, response, 'bot', response.type);
    } else {
      // Es una respuesta de texto normal
      await saveMessage(userId, responseText, 'bot', 'text');
    }

    return responseText;

  } catch (error) {
    logger.error(`Error crítico procesando mensaje de ${userId}:`, error);

    // En caso de error crítico, también escalar
    try {
      const fallbackMsg = "Su mensaje se procesará cuanto antes.";

      const conversation = conversationStateService.getOrCreateConversation(userId);
      conversation.status = 'pending_advisor';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.needsHumanReason = 'processing_error';

      await whatsappProvider.sendMessage(userId, fallbackMsg);
      await saveMessage(userId, message, 'user');
      await saveMessage(userId, fallbackMsg, 'bot');

      logger.error(`🚨 Usuario ${userId} escalado a asesor (error)`);

    } catch (fallbackError) {
      logger.error(`Error incluso en fallback:`, fallbackError);
    }

    return null;
  }
}

/**
 * Verifica si estamos fuera del horario de atención
 * Horario: hasta las 4:30 PM (16:30)
 *
 * @returns {boolean} true si está fuera de horario
 */
function isOutOfHours() {
  // ✅ NUEVO: Verificar si la verificación de horario está desactivada
  if (!timeSimulation.isScheduleCheckEnabled()) {
    logger.debug(`⏰ Verificación de horario DESACTIVADA. Se permite respuesta.`);
    return false;
  }

  // Usar servicio de simulación si está activo
  const now = timeSimulation.getCurrentTime();
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Formato decimal para comparar: 16.5 = 4:30 PM
  const currentTimeDecimal = hour + (minute / 60);
  const endTimeDecimal = BUSINESS_HOURS.endHour + (BUSINESS_HOURS.endMinute / 60);

  const isAfter = currentTimeDecimal > endTimeDecimal;

  if (isAfter || timeSimulation.isSimulationActive()) {
    const timeSource = timeSimulation.isSimulationActive()
      ? `HORA SIMULADA: ${timeSimulation.getSimulatedTime()}`
      : `Horario actual: ${hour}:${minute.toString().padStart(2, '0')}`;

    logger.debug(`⏰ ${timeSource} > ${BUSINESS_HOURS.endHour}:${BUSINESS_HOURS.endMinute.toString().padStart(2, '0')}? ${isAfter ? 'FUERA' : 'DENTRO'}`);
  }

  return isAfter;
}

/**
 * PUNTO DE CONTROL 4: Mensaje fuera de horario
 *
 * @returns {string} Mensaje de fuera de horario
 */
function getOutOfHoursMessage() {
  return "Nuestro horario de atención es:\n\n📅 Lunes a Viernes: 8:00 AM - 4:30 PM\n📅 Sábados: 9:00 AM - 12:00 PM\n❌ Domingos: Cerrado\n\nSu mensaje será atendido en el siguiente horario hábil. Gracias por su comprensión.";
}

/**
 * Guarda un mensaje en el historial
 *
 * @param {string} userId - ID del usuario
 * @param {string|Object} message - Contenido del mensaje (objeto si tiene type especial)
 * @param {string} sender - 'user' | 'bot' | 'admin' | 'system'
 * @param {string} messageType - 'text' | 'consent' | 'system' | 'escalation' (opcional)
 */
async function saveMessage(userId, message, sender, messageType = 'text') {
  try {
    // Obtener conversación
    const conversation = conversationStateService.getConversation(userId);
    if (!conversation) {
      logger.warn(`Conversación no encontrada para ${userId}`);
      return;
    }

    // ✅ CORRECCIÓN: Extraer type del mensaje si es un objeto
    let messageText = message;
    let messageActualType = messageType;

    if (typeof message === 'object' && message !== null) {
      // Si es un objeto con propiedad 'type' (ej: consent, escalation, system)
      if (message.type) {
        messageActualType = message.type;
      }
      // Extraer el texto del mensaje
      if (message.text) {
        messageText = message.text;
      } else if (message.message) {
        messageText = message.message;
      }
    }

    // Crear objeto de mensaje
    const messageRecord = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      conversationId: userId,
      sender: sender,
      message: messageText,
      timestamp: Date.now(),
      type: messageActualType  // ✅ CORREGIDO: Usar el type correcto
    };

    // Guardar en el array de mensajes de la conversación
    if (!conversation.messages) {
      conversation.messages = [];
    }
    conversation.messages.push(messageRecord);

    // Actualizar último mensaje
    conversationStateService.updateLastMessage(userId, messageText);
    conversation.lastInteraction = Date.now();

    logger.debug(`💾 Mensaje guardado: [${sender}] type=${messageActualType} "${messageText.substring(0, 30)}..."`);

    // ✅ NUEVO: Emitir evento Socket.IO para actualizar dashboard en tiempo real
    if (io) {
      io.emit('new-message', {
        userId: userId,
        phoneNumber: conversation.phoneNumber,
        message: messageRecord,
        timestamp: Date.now()
      });
      logger.debug(`📡 Evento 'new-message' emitido para ${userId}`);
    }
  } catch (error) {
    logger.error('Error guardando mensaje:', error);
  }
}

/**
 * Obtiene el historial de mensajes de una conversación
 *
 * @param {string} userId - ID del usuario
 * @returns {Array} Lista de mensajes
 */
function getMessages(userId) {
  const conversation = conversationStateService.getConversation(userId);

  if (!conversation) {
    return [];
  }

  // TODO: Implementar recuperación desde base de datos
  // Por ahora, retornar array vacío o desde memoria
  return conversation.messages || [];
}

/**
 * Obtiene estadísticas del procesador
 *
 * @returns {Object} Estadísticas
 */
function getStats() {
  const all = conversationStateService.getAllConversations();

  const botActive = all.filter(c => c.bot_active === true).length;
  const botInactive = all.filter(c => c.bot_active === false).length;
  const needsHuman = all.filter(c => c.needs_human === true).length;
  const outOfHours = all.filter(c => c.status === 'out_of_hours').length;

  return {
    total: all.length,
    botActive,
    botInactive,
    needsHuman,
    outOfHours,
    isOutOfHoursNow: isOutOfHours(),
    businessHours: BUSINESS_HOURS
  };
}

module.exports = {
  processIncomingMessage,
  isOutOfHours,
  getOutOfHoursMessage,
  getMessages,
  getStats,
  setSocketIO  // ✅ NUEVO: Para inicializar Socket.IO
};
