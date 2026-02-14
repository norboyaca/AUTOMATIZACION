/**
 * ===========================================
 * SERVICIO DE CONTROL POR ASESOR
 * ===========================================
 *
 * PUNTO DE CONTROL 2: Desactivación automática del bot
 *
 * Responsabilidades:
 * - Enviar mensajes desde el dashboard
 * - Desactivar el bot cuando un asesor responde
 * - Reactivar el bot manualmente
 * - Controlar el flujo de atención humana
 */

const logger = require('../utils/logger');
const conversationStateService = require('./conversation-state.service');
const whatsappProvider = require('../providers/whatsapp');
const mediaService = require('./media.service');

// ✅ NUEVO: Socket.IO para emitir eventos de nuevos mensajes
let io = null;

function setSocketIO(socketIOInstance) {
  io = socketIOInstance;
  logger.info('✅ Socket.IO inicializado en advisor-control');
}

// Historial de mensajes enviados por asesores
// Map<userId, Array<{messageId, message, sender, senderId, timestamp}>>
const advisorMessagesHistory = new Map();

/**
 * ===========================================
 * PUNTO DE CONTROL 2: DESACTIVACIÓN AUTOMÁTICA
 * ===========================================
 *
 * Cuando un asesor envía un mensaje desde el dashboard:
 * 1. Bot se DESACTIVA permanentemente para esa conversación
 * 2. El bot NO volverá a responder automáticamente
 * 3. Estado cambia a "ATENDIDO POR ASESOR"
 * 4. needs_human = true
 * 5. bot_active = false
 *
 * El bot solo puede volver a activarse si:
 * - Se presiona manualmente "Reactivar bot"
 * - Se resetea la conversación
 *
 * @param {string} userId - ID del usuario de WhatsApp
 * @param {Object} advisorData - Datos del asesor { id, name, email }
 * @param {string} message - Mensaje a enviar
 * @returns {Promise<Object>} Resultado de la operación
 */
async function sendAdvisorMessage(userId, advisorData, message) {
  try {
    // ✅ Usar getOrCreateConversation en lugar de getConversation
    // Esto carga la conversación desde DynamoDB si no está en memoria
    const conversation = conversationStateService.getOrCreateConversation(userId);

    if (!conversation) {
      throw new Error('No se pudo crear o obtener la conversación');
    }

    logger.info(`👨‍💼 Asesor ${advisorData.name} enviando mensaje a ${userId}`);
    logger.info(`   Mensaje: "${message.substring(0, 50)}..."`);

    // ===========================================
    // PUNTO DE CONTROL 2: DESACTIVAR BOT
    // ===========================================

    const wasActive = conversation.bot_active;

    // Desactivar el bot
    conversation.bot_active = false;
    conversation.status = 'advisor_handled';
    conversation.assignedTo = advisorData.id;
    conversation.advisorName = advisorData.name;
    conversation.needs_human = true;
    conversation.botDeactivatedAt = Date.now();
    conversation.botDeactivatedBy = advisorData.id;

    // ✅ NUEVO: Limpiar flujo activo para que no interfiera
    try {
      const flowManager = require('../flows');
      if (flowManager.hasActiveFlow(userId)) {
        flowManager.endFlow(userId);
        conversation.activeFlow = null;
        logger.info(`🔄 Flujo activo limpiado para ${userId} (asesor tomó control)`);
      }
    } catch (e) {
      logger.warn(`⚠️ Error limpiando flujo activo: ${e.message}`);
    }

    // ===========================================
    // ✅ CORRECCIÓN PROBLEMA 1: Guardar mensaje en UN SOLO lugar
    // ===========================================
    // ANTES: Se guardaba en conversation.messages Y conversation.advisorMessages
    //         Esto causaba duplicación cuando se combinaban en el endpoint
    // AHORA: Solo se guarda en conversation.messages con sender='admin'
    //         advisorMessages es un historial interno SOLO para estadísticas

    const messageRecord = {
      id: `adv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      message: message,
      sender: 'admin',  // IMPORTANTE: 'admin' para que el HTML lo alinee a la derecha
      senderId: advisorData.id,
      senderName: advisorData.name,  // Nombre del asesor para mostrar
      senderEmail: advisorData.email || null,
      timestamp: Date.now()
    };

    // ✅ ÚNICO lugar de almacenamiento para frontend: conversation.messages
    if (!conversation.messages) {
      conversation.messages = [];
    }
    conversation.messages.push(messageRecord);

    // Actualizar última interacción
    conversation.lastInteraction = Date.now();
    conversation.lastMessage = message;

    // ✅ NUEVO: Guardar mensaje de asesor en DynamoDB para persistencia
    setImmediate(async () => {
      try {
        const conversationRepository = require('../repositories/conversation.repository');
        const { Message } = require('../models/message.model');
        const dynamoMessage = new Message({
          id: messageRecord.id,
          conversationId: userId,
          participantId: userId,
          direction: 'outgoing',
          type: 'text',
          content: { text: message },
          from: advisorData.id,
          to: userId,
          status: 'delivered',
          metadata: {
            sender: 'admin',
            senderName: advisorData.name,
            senderEmail: advisorData.email || null,
            originalType: 'text'
          },
          createdAt: new Date(messageRecord.timestamp),
          updatedAt: new Date()
        });
        await conversationRepository.saveMessage(dynamoMessage);
        logger.info(`✅ [DYNAMODB] Mensaje de asesor guardado: ${messageRecord.id}`);
      } catch (dbError) {
        logger.error(`❌ [DYNAMODB] Error guardando mensaje de asesor ${messageRecord.id}:`, dbError.message);
      }
    });

    // Historial interno SOLO para estadísticas (NO se expone al frontend)
    if (!advisorMessagesHistory.has(userId)) {
      advisorMessagesHistory.set(userId, []);
    }
    advisorMessagesHistory.get(userId).push(messageRecord);

    if (wasActive) {
      logger.info(`🔴 BOT DESACTIVADO para ${userId}`);
      logger.info(`   Estado: ${conversation.status}`);
      logger.info(`   Asesor: ${advisorData.name} (${advisorData.id})`);
    } else {
      logger.info(`🔄 Bot ya estaba inactivo para ${userId}`);
      logger.info(`   Asesor ${advisorData.name} continúa atención`);
    }

    // Enviar mensaje por WhatsApp
    await whatsappProvider.sendMessage(userId, message);

    // ===========================================
    // ✅ CORRECCIÓN PROBLEMA 1 & 2: Emitir Socket.IO con datos correctos
    // ===========================================
    // IMPORTANT: Emitir después de guardar para asegurar que el ID existe
    // El mensaje YA está guardado en conversation.messages con ID único
    if (io) {
      io.emit('new-message', {
        userId: userId,
        phoneNumber: conversation.phoneNumber,
        whatsappName: conversation.whatsappName || '',
        message: messageRecord,
        timestamp: Date.now()
      });
      logger.debug(`📡 Evento 'new-message' emitido para ${userId} (asesor, ID: ${messageRecord.id})`);
    }

    logger.info(`✅ Mensaje de asesor enviado a ${userId}`);

    return {
      success: true,
      botActive: false,
      status: conversation.status,
      wasPreviouslyActive: wasActive,
      message: {
        id: messageRecord.messageId,
        text: message,
        timestamp: messageRecord.timestamp
      }
    };

  } catch (error) {
    logger.error(`Error enviando mensaje de asesor a ${userId}:`, error);
    throw error;
  }
}

/**
 * Reactiva el bot manualmente
 *
 * Solo se puede hacer manualmente desde el dashboard con el botón "Reactivar bot"
 *
 * @param {string} userId - ID del usuario
 * @param {Object} advisorData - Datos del asesor que reactiva
 * @returns {Promise<Object>} Resultado de la operación
 */
async function reactivateBot(userId, advisorData) {
  try {
    // ✅ Usar getOrCreateConversation en lugar de getConversation
    const conversation = conversationStateService.getOrCreateConversation(userId);

    if (!conversation) {
      throw new Error('No se pudo crear o obtener la conversación');
    }

    logger.info(`🔄 Reactivando bot para ${userId} por ${advisorData.name}`);
    logger.info(`📊 Estado ANTES de reactivar:`);
    logger.info(`   bot_active: ${conversation.bot_active}`);
    logger.info(`   status: ${conversation.status}`);
    logger.info(`   interactionCount: ${conversation.interactionCount}`);
    logger.info(`   waitingForHuman: ${conversation.waitingHuman}`);
    logger.info(`   escalationMessageSent: ${conversation.escalationMessageSent}`);

    // Reactivar bot
    conversation.bot_active = true;
    conversation.status = 'active';
    conversation.assignedTo = null;
    conversation.advisorName = null;
    conversation.needs_human = false;
    conversation.needsHumanReason = null;
    conversation.botDeactivatedAt = null;
    conversation.botDeactivatedBy = null;
    conversation.lastInteraction = Date.now();

    // ✅ CORRECCIÓN CRÍTICA: Reiniciar contador de intentos
    conversation.interactionCount = 0;
    conversation.manuallyReactivated = true;  // Flag para ignorar escalación por historial

    // NUEVO: Resetear flags de escalación (permitir nueva escalación futura)
    conversation.escalationMessageSent = false;
    conversation.waitingForHuman = false;
    conversation.lastEscalationMessageAt = null;

    logger.info(`🟢 BOT REACTIVADO para ${userId}`);
    logger.info(`📊 Estado DESPUÉS de reactivar:`);
    logger.info(`   ✅ bot_active: ${conversation.bot_active}`);
    logger.info(`   ✅ status: ${conversation.status}`);
    logger.info(`   ✅ interactionCount: ${conversation.interactionCount} (REINICIADO)`);
    logger.info(`   ✅ manuallyReactivated: ${conversation.manuallyReactivated} (activado por 1 ciclo)`);
    logger.info(`   ✅ waitingForHuman: ${conversation.waitingForHuman}`);
    logger.info(`   ✅ escalationMessageSent: ${conversation.escalationMessageSent}`);
    logger.info(`   📋 Acción realizada por: ${advisorData.name} (${advisorData.id})`);
    logger.info(`   🔄 Nuevo ciclo iniciado: contador de intentos en 0`);

    // ✅ CORRECCIÓN: Retornar el resultado correctamente
    return {
      success: true,
      botActive: conversation.bot_active,
      status: conversation.status
    };

  } catch (error) {
    logger.error(`Error reactivando bot para ${userId}:`, error);
    throw error;
  }
}

/**
 * Verifica si el bot está activo para una conversación
 *
 * @param {string} userId - ID del usuario
 * @returns {boolean} true si el bot está activo
 */
function isBotActive(userId) {
  const conversation = conversationStateService.getConversation(userId);
  return conversation ? conversation.bot_active === true : true; // Por defecto activo
}

/**
 * ✅ OBSOLETO: Los mensajes de asesores ahora están en conversation.messages
 *
 * Esta función se mantiene por compatibilidad pero siempre retorna array vacío.
 * Los mensajes con sender='admin' ya están incluidos en conversation.messages.
 *
 * @param {string} userId - ID del usuario
 * @returns {Array} Siempre array vacío
 */
function getAdvisorMessages(userId) {
  // ✅ CORRECCIÓN: Retornar vacío porque los mensajes ya están en conversation.messages
  return [];
}

/**
 * Obtiene todas las conversaciones donde el bot está inactivo
 *
 * @returns {Array} Lista de conversaciones
 */
function getInactiveBotConversations() {
  const all = conversationStateService.getAllConversations();
  return all.filter(c => c.bot_active === false);
}

/**
 * Obtiene estadísticas de control de asesores
 *
 * @returns {Object} Estadísticas
 */
function getStats() {
  const all = conversationStateService.getAllConversations();

  const botActive = all.filter(c => c.bot_active === true).length;
  const botInactive = all.filter(c => c.bot_active === false).length;
  const advisorHandled = all.filter(c => c.status === 'advisor_handled').length;
  const pendingAdvisor = all.filter(c => c.status === 'pending_advisor').length;

  // Total de mensajes de asesores
  let totalAdvisorMessages = 0;
  advisorMessagesHistory.forEach(messages => {
    totalAdvisorMessages += messages.length;
  });

  return {
    total: all.length,
    botActive,
    botInactive,
    advisorHandled,
    pendingAdvisor,
    totalAdvisorMessages,
    conversationsWithAdvisorMessages: advisorMessagesHistory.size
  };
}

/**
 * Limpia el historial de mensajes de un asesor
 * (útil para testing o mantenimiento)
 *
 * @param {string} userId - ID del usuario
 */
function clearAdvisorMessages(userId) {
  const conversation = conversationStateService.getConversation(userId);

  if (conversation) {
    conversation.advisorMessages = [];
  }

  advisorMessagesHistory.delete(userId);

  logger.info(`🗑️ Historial de mensajes de asesor limpiado para ${userId}`);
}

/**
 * Transfiere una conversación a otro asesor
 *
 * @param {string} userId - ID del usuario
 * @param {Object} newAdvisorData - Datos del nuevo asesor
 * @returns {Promise<Object>} Resultado de la operación
 */
async function transferToAdvisor(userId, newAdvisorData) {
  try {
    // ✅ Usar getOrCreateConversation en lugar de getConversation
    const conversation = conversationStateService.getOrCreateConversation(userId);

    if (!conversation) {
      throw new Error('No se pudo crear o obtener la conversación');
    }

    const oldAdvisor = conversation.advisorName;

    logger.info(`🔄 Transfiriendo conversación de ${userId}`);
    logger.info(`   De: ${oldAdvisor || 'sin asignar'}`);
    logger.info(`   A: ${newAdvisorData.name}`);

    // Actualizar asignación
    conversation.assignedTo = newAdvisorData.id;
    conversation.advisorName = newAdvisorData.name;
    conversation.lastInteraction = Date.now();

    // Agregar nota de transferencia al historial
    const transferNote = {
      messageId: `transfer_${Date.now()}`,
      message: `[Sistema] Conversación transferida de ${oldAdvisor || 'sin asignar'} a ${newAdvisorData.name}`,
      sender: 'Sistema',
      senderId: 'system',
      timestamp: Date.now(),
      type: 'transfer'
    };

    conversation.advisorMessages = conversation.advisorMessages || [];
    conversation.advisorMessages.push(transferNote);

    if (!advisorMessagesHistory.has(userId)) {
      advisorMessagesHistory.set(userId, []);
    }
    advisorMessagesHistory.get(userId).push(transferNote);

    logger.info(`✅ Conversación transferida exitosamente`);

    return {
      success: true,
      status: conversation.status,
      from: oldAdvisor,
      to: newAdvisorData.name
    };

  } catch (error) {
    logger.error(`Error transfiriendo conversación:`, error);
    throw error;
  }
}

/**
 * ===========================================
 * ✅ NUEVO: ENVIAR MENSAJE MULTIMEDIA DESDE DASHBOARD
 * ===========================================
 * Soporta: audio, imagen, documento (PDF)
 *
 * @param {string} userId - ID del usuario de WhatsApp
 * @param {Object} advisorData - Datos del asesor
 * @param {Object} mediaData - Datos del archivo multimedia
 * @param {string} mediaData.type - Tipo: 'audio', 'image', 'document'
 * @param {string} mediaData.url - URL del archivo
 * @param {string} mediaData.filename - Nombre original del archivo
 * @param {number} mediaData.size - Tamaño del archivo
 * @param {string} caption - Texto opcional de acompañamiento
 * @returns {Promise<Object>} Resultado de la operación
 */
async function sendAdvisorMediaMessage(userId, advisorData, mediaData, caption = '') {
  try {
    // ✅ Usar getOrCreateConversation en lugar de getConversation
    const conversation = conversationStateService.getOrCreateConversation(userId);

    if (!conversation) {
      throw new Error('No se pudo crear o obtener la conversación');
    }

    logger.info(`👨‍💼 Asesor ${advisorData.name} enviando ${mediaData.type} a ${userId}`);

    // Desactivar el bot si estaba activo
    const wasActive = conversation.bot_active;

    conversation.bot_active = false;
    conversation.status = 'advisor_handled';
    conversation.assignedTo = advisorData.id;
    conversation.advisorName = advisorData.name;
    conversation.needs_human = true;
    conversation.botDeactivatedAt = Date.now();
    conversation.botDeactivatedBy = advisorData.id;

    // Determinar el tipo de mensaje según el tipo de archivo
    const messageType = mediaData.type; // 'audio', 'image', 'document'

    // Crear registro del mensaje multimedia
    const messageRecord = {
      id: `adv_media_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      message: caption || mediaData.filename, // Si hay caption, usarlo; si no, el nombre del archivo
      sender: 'admin',
      senderId: advisorData.id,
      senderName: advisorData.name,
      senderEmail: advisorData.email || null,
      timestamp: Date.now(),
      type: messageType,  // ✅ NUEVO: Tipo multimedia
      mediaUrl: mediaData.url,
      fileName: mediaData.filename,
      fileSize: mediaData.size
    };

    // Guardar en conversación
    if (!conversation.messages) {
      conversation.messages = [];
    }
    conversation.messages.push(messageRecord);

    // Actualizar última interacción
    conversation.lastInteraction = Date.now();
    conversation.lastMessage = caption || `[${mediaData.type}] ${mediaData.filename}`;

    // Actualizar historial interno
    if (!advisorMessagesHistory.has(userId)) {
      advisorMessagesHistory.set(userId, []);
    }
    advisorMessagesHistory.get(userId).push(messageRecord);

    // ✅ NUEVO: Guardar mensaje multimedia de asesor en DynamoDB para persistencia
    setImmediate(async () => {
      try {
        const conversationRepository = require('../repositories/conversation.repository');
        const { Message } = require('../models/message.model');
        const dynamoMessage = new Message({
          id: messageRecord.id,
          conversationId: userId,
          participantId: userId,
          direction: 'outgoing',
          type: messageType,
          content: {
            text: caption || mediaData.filename,
            mediaUrl: mediaData.url,
            fileName: mediaData.filename,
            fileSize: mediaData.size
          },
          from: advisorData.id,
          to: userId,
          status: 'delivered',
          metadata: {
            sender: 'admin',
            senderName: advisorData.name,
            senderEmail: advisorData.email || null,
            originalType: messageType
          },
          createdAt: new Date(messageRecord.timestamp),
          updatedAt: new Date()
        });
        await conversationRepository.saveMessage(dynamoMessage);
        logger.info(`✅ [DYNAMODB] Mensaje multimedia de asesor guardado: ${messageRecord.id}`);
      } catch (dbError) {
        logger.error(`❌ [DYNAMODB] Error guardando mensaje multimedia de asesor ${messageRecord.id}:`, dbError.message);
      }
    });

    if (wasActive) {
      logger.info(`🔴 BOT DESACTIVADO para ${userId} (mensaje multimedia)`);
    }

    // Enviar mensaje por WhatsApp según el tipo
    // NOTA: filepath debe venir desde el frontend para que Baileys pueda leer el archivo
    await whatsappProvider.sendMediaMessage(userId, {
      type: mediaData.type,
      url: mediaData.url,
      filepath: mediaData.filepath,  // ✅ Ruta absoluta al archivo
      filename: mediaData.filename,
      caption: caption
    });

    // Emitir evento Socket.IO
    if (io) {
      io.emit('new-message', {
        userId: userId,
        phoneNumber: conversation.phoneNumber,
        whatsappName: conversation.whatsappName || '',
        message: messageRecord,
        timestamp: Date.now()
      });
      logger.debug(`📡 Evento 'new-message' emitido para ${userId} (media, ID: ${messageRecord.id})`);
    }

    logger.info(`✅ Mensaje multimedia de asesor enviado a ${userId}`);

    return {
      success: true,
      botActive: false,
      status: conversation.status,
      wasPreviouslyActive: wasActive,
      message: messageRecord
    };

  } catch (error) {
    logger.error(`Error enviando mensaje multimedia de asesor a ${userId}:`, error);
    throw error;
  }
}

module.exports = {
  sendAdvisorMessage,
  sendAdvisorMediaMessage,  // ✅ NUEVO: Enviar mensajes multimedia
  reactivateBot,
  isBotActive,
  getAdvisorMessages,
  getInactiveBotConversations,
  getStats,
  clearAdvisorMessages,
  transferToAdvisor,
  setSocketIO  // ✅ NUEVO: Para inicializar Socket.IO
};
