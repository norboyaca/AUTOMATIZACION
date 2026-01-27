/**
 * ===========================================
 * REPOSITORIO DE CONVERSACIONES
 * ===========================================
 *
 * Responsabilidades:
 * - Abstracción de la capa de persistencia
 * - CRUD de conversaciones
 * - CRUD de mensajes
 * - Consultas especializadas
 *
 * PATRÓN: Repository
 * Permite cambiar la implementación de almacenamiento
 * sin afectar el resto de la aplicación.
 *
 * IMPLEMENTACIONES POSIBLES:
 * - En memoria (desarrollo/testing)
 * - MongoDB
 * - PostgreSQL
 * - Redis (para sesiones/caché)
 */

const logger = require('../utils/logger');
const { Conversation } = require('../models/conversation.model');
const { Message } = require('../models/message.model');

/**
 * Almacenamiento en memoria (para desarrollo)
 * En producción, reemplazar con MongoDB/PostgreSQL
 */
const memoryStore = {
  conversations: new Map(),
  messages: new Map()
};

/**
 * Repositorio de Conversaciones
 */
class ConversationRepository {

  // ===========================================
  // OPERACIONES DE CONVERSACIÓN
  // ===========================================

  /**
   * Busca una conversación por ID de participante (número)
   * @param {string} participantId - Número de WhatsApp
   * @returns {Promise<Conversation|null>}
   */
  async findByParticipantId(participantId) {
    // TODO: Reemplazar con query a base de datos
    const conversation = memoryStore.conversations.get(participantId);
    return conversation ? new Conversation(conversation) : null;
  }

  /**
   * Busca o crea una conversación
   * @param {string} participantId
   * @returns {Promise<Conversation>}
   */
  async findOrCreate(participantId) {
    let conversation = await this.findByParticipantId(participantId);

    if (!conversation) {
      conversation = Conversation.create(participantId);
      await this.save(conversation);
      logger.debug(`Nueva conversación creada para ${participantId}`);
    }

    return conversation;
  }

  /**
   * Guarda una conversación
   * @param {Conversation} conversation
   * @returns {Promise<Conversation>}
   */
  async save(conversation) {
    conversation.updatedAt = new Date();
    memoryStore.conversations.set(conversation.participantId, conversation.toObject());
    return conversation;
  }

  /**
   * Actualiza una conversación
   * @param {string} participantId
   * @param {Object} updates
   * @returns {Promise<Conversation|null>}
   */
  async update(participantId, updates) {
    const conversation = await this.findByParticipantId(participantId);

    if (!conversation) {
      return null;
    }

    Object.assign(conversation, updates);
    return await this.save(conversation);
  }

  /**
   * Elimina una conversación
   * @param {string} participantId
   * @returns {Promise<boolean>}
   */
  async delete(participantId) {
    const existed = memoryStore.conversations.has(participantId);
    memoryStore.conversations.delete(participantId);
    // También eliminar mensajes asociados
    memoryStore.messages.delete(participantId);
    return existed;
  }

  /**
   * Lista conversaciones activas
   * @param {Object} options - Opciones de paginación
   * @returns {Promise<Array<Conversation>>}
   */
  async findActive(options = { limit: 50, offset: 0 }) {
    const conversations = Array.from(memoryStore.conversations.values())
      .filter(c => c.status === 'active')
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(options.offset, options.offset + options.limit);

    return conversations.map(c => new Conversation(c));
  }

  // ===========================================
  // OPERACIONES DE MENSAJES
  // ===========================================

  /**
   * Guarda un mensaje
   * @param {Message} message
   * @returns {Promise<Message>}
   */
  async saveMessage(message) {
    const participantId = message.from || message.to;

    if (!memoryStore.messages.has(participantId)) {
      memoryStore.messages.set(participantId, []);
    }

    memoryStore.messages.get(participantId).push(message.toObject());
    return message;
  }

  /**
   * Obtiene el historial de mensajes
   * @param {string} participantId
   * @param {Object} options
   * @returns {Promise<Array<Message>>}
   */
  async getHistory(participantId, options = { limit: 20 }) {
    const messages = memoryStore.messages.get(participantId) || [];

    return messages
      .slice(-options.limit)
      .map(m => new Message(m));
  }

  /**
   * Cuenta mensajes de una conversación
   * @param {string} participantId
   * @returns {Promise<number>}
   */
  async countMessages(participantId) {
    const messages = memoryStore.messages.get(participantId) || [];
    return messages.length;
  }

  // ===========================================
  // UTILIDADES
  // ===========================================

  /**
   * Limpia conversaciones inactivas
   * @param {number} maxAgeDays - Días de inactividad
   * @returns {Promise<number>} Número de conversaciones eliminadas
   */
  async cleanupInactive(maxAgeDays = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    let deletedCount = 0;

    for (const [id, conv] of memoryStore.conversations) {
      if (new Date(conv.updatedAt) < cutoffDate) {
        memoryStore.conversations.delete(id);
        memoryStore.messages.delete(id);
        deletedCount++;
      }
    }

    logger.info(`Limpieza: ${deletedCount} conversaciones eliminadas`);
    return deletedCount;
  }

  /**
   * Obtiene estadísticas
   * @returns {Promise<Object>}
   */
  async getStats() {
    const conversations = Array.from(memoryStore.conversations.values());

    return {
      totalConversations: conversations.length,
      activeConversations: conversations.filter(c => c.status === 'active').length,
      totalMessages: Array.from(memoryStore.messages.values())
        .reduce((sum, msgs) => sum + msgs.length, 0)
    };
  }
}

// Exportar instancia singleton
module.exports = new ConversationRepository();
