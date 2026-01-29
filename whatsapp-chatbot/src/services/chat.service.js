/**
 * ===========================================
 * SERVICIO DE CHAT HÍBRIDO - NORBOY
 * ===========================================
 *
 * Sistema inteligente que decide:
 * 1. Si hay match en la base de conocimiento local → responde sin IA
 * 2. Si la pregunta es compleja o no hay match → usa OpenAI
 * 3. Si OpenAI falla → fallback a base de conocimiento
 */

const logger = require('../utils/logger');
const config = require('../config');
const aiProvider = require('../providers/ai');
const knowledgeBase = require('../knowledge');
const knowledgeUploadService = require('./knowledge-upload.service');
const conversationStateService = require('./conversation-state.service');

// Inicializar base de conocimiento
knowledgeBase.initialize();

// Flag para saber si OpenAI está disponible
let openAIAvailable = true;

// ===========================================
// SEGUIMIENTO DE CONSENTIMIENTO DE USUARIOS
// ===========================================
const userInteractionCount = new Map(); // userId → número de interacciones
const userConsent = new Map(); // userId → boolean (aceptó o no)
const userConsentRequested = new Map(); // userId → boolean (ya se mostró mensaje)
const pendingMessages = new Map(); // userId → mensaje pendiente (para responder después de aceptar)

/**
 * Genera una respuesta de chat (HÍBRIDO)
 */
const generateTextResponse = async (userId, message, options = {}) => {
  try {
    const normalizedMessage = message.toLowerCase().trim();
    logger.debug(`Procesando: "${message.substring(0, 50)}..."}`);

    // ===========================================
    // VERIFICACIÓN DE CICLO DE 60 MINUTOS
    // ===========================================
    const wasReset = conversationStateService.checkAndUpdateCycle(userId);

    if (wasReset) {
      // Si el ciclo expiró, resetear TODAS las variables de consentimiento
      logger.info(`🔄 Ciclo reseteado para ${userId}, limpiando TODO el estado`);
      resetUserState(userId);

      // Indicar que se debe enviar bienvenida y consentimiento nuevamente
      // Esto hará que en la siguiente interacción se vuelva a mostrar el flujo completo
    }

    // ===========================================
    // SISTEMA DE CONSENTIMIENTO
    // ===========================================

    // Incrementar contador de interacciones (solo si no es skipConsent)
    const currentCount = options.skipConsent
      ? (userInteractionCount.get(userId) || 0)
      : (userInteractionCount.get(userId) || 0) + 1;

    if (!options.skipConsent) {
      userInteractionCount.set(userId, currentCount);
      conversationStateService.incrementInteractionCount(userId);
      logger.info(`💬 Usuario ${userId}: Interacción #${currentCount}`);
    }

    // Si es la SEGUNDA interacción y no ha respondido consentimiento, mostrar mensaje
    if (currentCount === 2 && !userConsent.has(userId) && !userConsentRequested.get(userId) && !options.skipConsent) {
      logger.info('📋 Segunda interacción, solicitando consentimiento');
      userConsentRequested.set(userId, true);

      // Guardar el mensaje para responderlo después de que acepte
      pendingMessages.set(userId, message);
      logger.info(`📝 Mensaje pendiente guardado: "${message.substring(0, 50)}..."`);

      return getConsentMessage(userId);
    }

    // Si NO ha aceptado el consentimiento, no responder
    if (userConsent.get(userId) === false && !options.skipConsent) {
      logger.info('🚫 Usuario rechazó consentimiento, no responde');
      return null; // No responder
    }

    // Si aún no ha aceptado (esperando respuesta a botones), no procesar
    if (currentCount > 2 && !userConsent.has(userId) && !options.skipConsent) {
      logger.info('⏳ Esperando respuesta de consentimiento');
      return null;
    }

    // 1. Detectar saludos simples (no necesita IA)
    if (isGreeting(normalizedMessage)) {
      logger.info('📗 Respuesta: Saludo (local)');
      return getGreetingResponse();
    }

    // 2. Detectar comandos de ayuda (no necesita IA)
    if (isHelpCommand(normalizedMessage)) {
      logger.info('📗 Respuesta: Ayuda (local)');
      return getHelpResponse();
    }

    // 3. Buscar en base de conocimiento local (para fallback)
    const localAnswer = knowledgeBase.findAnswer(message);

    // 4. NUEVO: Verificar si hay documentos subidos
    const uploadedFiles = knowledgeUploadService.getUploadedFiles();
    const hasUploadedDocs = uploadedFiles.length > 0;

    logger.info(`📂 Verificando documentos: ${uploadedFiles.length} encontrados`);

    // 5. Si hay documentos subidos, SIEMPRE usar IA (que incluye contexto de documentos)
    if (hasUploadedDocs) {
      logger.info(`📚 Hay ${uploadedFiles.length} documento(s) subido(s), usando IA con contexto completo`);
      logger.info(`📄 Documentos: ${uploadedFiles.map(f => f.originalName).join(', ')}`);
      if (openAIAvailable) {
        try {
          const aiResponse = await generateWithAI(userId, message, options);
          logger.info('✅ Respuesta: OpenAI con documentos');
          return aiResponse;
        } catch (error) {
          logger.warn('❌ OpenAI no disponible con documentos, usando fallback local:', error.message);
          openAIAvailable = false;
          setTimeout(() => { openAIAvailable = true; }, 5 * 60 * 1000);
        }
      }
    } else {
      logger.info('📭 No hay documentos subidos, usando flujo normal');
    }

    // 6. Si NO hay documentos subidos y hay match local, usarlo
    if (!hasUploadedDocs && localAnswer) {
      if (localAnswer.confidence === 'alta' || localAnswer.confidence === 'media') {
        logger.info(`📗 Respuesta: Knowledge Base (${localAnswer.confidence})`);
        return humanizeResponse(localAnswer.answer);
      }
    }

    // 7. Si OpenAI está disponible, intentar usarlo para preguntas complejas
    if (openAIAvailable) {
      try {
        const aiResponse = await generateWithAI(userId, message, options);
        logger.info('📘 Respuesta: OpenAI');
        return aiResponse;
      } catch (error) {
        logger.warn('OpenAI no disponible, usando fallback local');
        openAIAvailable = false;

        // Reintentar OpenAI después de 5 minutos
        setTimeout(() => {
          openAIAvailable = true;
          logger.info('OpenAI habilitado nuevamente');
        }, 5 * 60 * 1000);
      }
    }

    // 5. Fallback: buscar respuesta aproximada en knowledge base
    if (localAnswer && localAnswer.confidence === 'baja') {
      logger.info('📗 Respuesta: Knowledge Base (fallback)');
      return humanizeResponse(localAnswer.answer);
    }

    // 6. Último recurso: respuesta genérica con sugerencias
    logger.info('📙 Respuesta: Genérica');
    const response = getGenericResponse(message);

    // Actualizar último mensaje de la conversación
    conversationStateService.updateLastMessage(userId, message);

    return response;

  } catch (error) {
    logger.error('Error en chat service:', error);
    return getErrorResponse();
  }
};

/**
 * Genera respuesta usando IA (Groq/OpenAI)
 */
const generateWithAI = async (userId, message, options = {}) => {
  // Obtener contexto de la base de conocimiento original
  const baseContext = knowledgeBase.getContext(message, 3);

  // Obtener archivos subidos
  const files = knowledgeUploadService.getUploadedFiles();
  const hasDocuments = files.length > 0;

  let relevantContext = baseContext;

  if (hasDocuments) {
    logger.info(`📚 Procesando ${files.length} documento(s) subido(s)`);

    // SIEMPRE usar búsqueda inteligente para encontrar fragmentos relevantes
    const searchResults = knowledgeUploadService.searchInFiles(message);

    if (searchResults.length > 0) {
      // Usar fragmentos encontrados (más eficiente y preciso)
      logger.info(`🎯 Encontrados ${searchResults.length} fragmentos relevantes`);
      const contextFromSearch = searchResults
        .slice(0, 3)
        .map(r => `[Fuente: ${r.source}]\n${r.text}`)
        .join('\n\n---\n\n');

      relevantContext = relevantContext
        ? `${relevantContext}\n\n--- Información de documentos ---\n${contextFromSearch}`
        : contextFromSearch;
    } else {
      // Si no hay coincidencias, pasar TODO el contenido (como último recurso)
      logger.info('📄 Sin coincidencias exactas, usando contenido completo de documentos');
      let allUploadedContent = '';

      for (const file of files) {
        const dataPath = require('path').join(process.cwd(), 'knowledge_files', `${file.id}_data.json`);
        try {
          if (require('fs').existsSync(dataPath)) {
            const data = JSON.parse(require('fs').readFileSync(dataPath, 'utf8'));
            allUploadedContent += `\n\n--- ${file.originalName} ---\n${data.content}`;
          }
        } catch (e) {
          logger.warn(`Error leyendo archivo ${file.originalName}:`, e.message);
        }
      }

      relevantContext = relevantContext
        ? `${relevantContext}\n\n--- Contenido completo de documentos ---\n${allUploadedContent}`
        : allUploadedContent;
    }
  }

  const messages = buildMessages(message, [], relevantContext, options);

  // Aumentar tokens cuando hay contexto de documentos
  const maxTokens = hasDocuments ? 400 : 150;

  const response = await aiProvider.chat(messages, {
    maxTokens: maxTokens,
    temperature: 0.7 // Un poco más preciso
  });

  return cleanQuestionMarks(response);
};

/**
 * Detecta si es un saludo
 */
const isGreeting = (text) => {
  const greetings = [
    'hola', 'buenos dias', 'buenas tardes', 'buenas noches',
    'hey', 'hi', 'hello', 'saludos', 'que tal', 'buenas',
    'ola', 'holi', 'holaa', 'holaaa'
  ];
  return greetings.some(g => text === g || text.startsWith(g + ' ') || text.startsWith(g + ','));
};

/**
 * Detecta si es comando de ayuda
 */
const isHelpCommand = (text) => {
  const helpCommands = ['ayuda', 'help', 'menu', '/ayuda', '/help', '/menu', 'opciones', 'comandos'];
  return helpCommands.includes(text);
};

/**
 * Respuesta de saludo
 */
const getGreetingResponse = () => {
  const greetings = [
    `Hola! 👋 Somos el equipo NORBOY. Sumercé, en qué le podemos ayudar?`,
    `Buen día! Somos NORBOY. Sumercé, qué necesita saber?`,
    `Hola! Aquí el equipo NORBOY 👋 En qué le podemos servir?`,
    `Saludos! Somos NORBOY. Cuéntenos, en qué le ayudamos?`
  ];

  return greetings[Math.floor(Math.random() * greetings.length)];
};

/**
 * Respuesta de ayuda/menú
 */
const getHelpResponse = () => {
  return `Con gusto le ayudamos! Puede preguntarnos sobre:

• Delegados y cómo elegirlos
• La Asamblea General
• Consejo de Administración
• Junta de Vigilancia
• El proceso "Elegimos Juntos"

Escríbanos su pregunta, estamos para servirle 👍`;
};

/**
 * Respuesta genérica cuando no hay match
 */
const getGenericResponse = (originalMessage) => {
  return `Sumercé, no tenemos información sobre eso. Solo podemos ayudarle con temas del proceso "Elegimos Juntos" de NORBOY: delegados, Asamblea, órganos de control. Pregúntenos sobre esos temas, estamos para servirle 👍`;
};

/**
 * Respuesta de error
 */
const getErrorResponse = () => {
  return `Disculpe sumercé, tuvimos un problema técnico. Por favor intente de nuevo en unos segundos.`;
};

/**
 * Mensaje de consentimiento (con lista de opciones)
 */
const getConsentMessage = (userId) => {
  // Marcar que se envió el mensaje de consentimiento
  if (userId) {
    conversationStateService.markConsentSent(userId);
  }

  return {
    type: 'consent',
    text: `👋 ¡Bienvenido a NORBOY!

Para poder asesorarte mejor,
te solicitamos autorizar el
tratamiento de tus datos personales.

👉 Conócenos aquí:
https://norboy.coop/

📄 Consulta nuestras políticas:
🔒 Política de Protección de Datos Personales:
https://norboy.coop/proteccion-de-datos-personales/
💬 Uso de WhatsApp:
https://www.whatsapp.com/legal

Para continuar, responde:
1️⃣ ACEPTAR
2️⃣ NO ACEPTAR`,
    useList: false // No usar lista por ahora, solo texto
  };
};

/**
 * Verifica si el usuario ha dado consentimiento
 */
const hasUserConsent = (userId) => {
  return userConsent.get(userId) === true;
};

/**
 * Registra la respuesta de consentimiento del usuario
 */
const setConsentResponse = (userId, accepted) => {
  userConsent.set(userId, accepted);

  // Sincronizar con conversationStateService
  conversationStateService.updateConsentStatus(userId, accepted ? 'accepted' : 'rejected');

  logger.info(`📋 Usuario ${userId} ${accepted ? 'ACEPTÓ' : 'RECHAZÓ'} el consentimiento`);
  return accepted;
};

/**
 * Reinicia el contador de interacciones de un usuario
 */
const resetUserInteractions = (userId) => {
  userInteractionCount.set(userId, 0);
  userConsentRequested.delete(userId);
};

/**
 * Obtiene el número de interacciones de un usuario
 */
const getUserInteractionCount = (userId) => {
  return userInteractionCount.get(userId) || 0;
};

/**
 * Obtiene el mensaje pendiente de un usuario (para responder después de aceptar)
 */
const getPendingMessage = (userId) => {
  return pendingMessages.get(userId) || null;
};

/**
 * Limpia el mensaje pendiente de un usuario
 */
const clearPendingMessage = (userId) => {
  pendingMessages.delete(userId);
};

/**
 * Reset completo del estado de un usuario
 * Limpia todas las variables de estado para un usuario específico
 *
 * Se llama cuando:
 * - Reset manual desde el dashboard
 * - El ciclo de 60 minutos expira
 *
 * Esto asegura que el próximo mensaje del usuario reciba:
 * - Saludo de bienvenida
 * - Mensaje de consentimiento de datos
 */
const resetUserState = (userId) => {
  userInteractionCount.delete(userId);
  userConsent.delete(userId);
  userConsentRequested.delete(userId);
  pendingMessages.delete(userId);

  logger.info(`🔄 Estado reseteado completamente para ${userId}`);
};

/**
 * Humaniza una respuesta local (mantiene respuestas cortas)
 */
const humanizeResponse = (answer) => {
  const starters = ['', 'Claro! ', 'Con gusto, ', 'Le cuento: ', 'Por supuesto, '];
  const randomStarter = starters[Math.floor(Math.random() * starters.length)];

  const closers = [
    '',
    '\n\nEstamos para servirle, sumercé es lo más importante! 😊',
    '',
    '\n\nQué más le podemos ayudar?',
    ''
  ];
  const randomCloser = closers[Math.floor(Math.random() * closers.length)];

  return `${randomStarter}${answer}${randomCloser}`;
};

/**
 * Limpia signos de interrogación invertidos
 */
const cleanQuestionMarks = (text) => {
  return text.replace(/¿/g, '');
};

/**
 * Construye mensajes para IA
 */
const buildMessages = (userMessage, history = [], context = '', options = {}) => {
  const messages = [];

  const systemPrompt = options.systemPrompt || config.openai.systemPrompts.default;

  messages.push({
    role: 'system',
    content: systemPrompt
  });

  if (context) {
    messages.push({
      role: 'system',
      content: `INFO RELEVANTE:\n${context}\n\nResponde BREVE usando esta info si aplica.`
    });
  }

  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: userMessage });

  return messages;
};

/**
 * Obtiene el historial de conversación
 */
const getConversationHistory = async (userId) => {
  return [];
};

/**
 * Obtiene información por categoría
 */
const getInfoByCategory = (category) => {
  const items = knowledgeBase.getByCategory(category);
  if (items.length === 0) return null;
  return items.map(item => `• ${item.question}\n  ${item.answer}`).join('\n\n');
};

/**
 * Lista categorías disponibles
 */
const getAvailableCategories = () => {
  return knowledgeBase.getCategories();
};

module.exports = {
  generateTextResponse,
  getConversationHistory,
  buildMessages,
  getInfoByCategory,
  getAvailableCategories,
  cleanQuestionMarks,
  hasUserConsent,
  setConsentResponse,
  resetUserInteractions,
  getUserInteractionCount,
  getPendingMessage,
  clearPendingMessage,
  resetUserState  // NUEVA FUNCIÓN
};
