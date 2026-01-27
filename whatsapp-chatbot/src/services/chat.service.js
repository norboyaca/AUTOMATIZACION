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

// Inicializar base de conocimiento
knowledgeBase.initialize();

// Flag para saber si OpenAI está disponible
let openAIAvailable = true;

/**
 * Genera una respuesta de chat (HÍBRIDO)
 */
const generateTextResponse = async (userId, message, options = {}) => {
  try {
    const normalizedMessage = message.toLowerCase().trim();
    logger.debug(`Procesando: "${message.substring(0, 50)}..."`);

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

    // 3. Buscar en base de conocimiento local
    const localAnswer = knowledgeBase.findAnswer(message);

    if (localAnswer) {
      // Si hay match con confianza alta o media, usar respuesta local
      if (localAnswer.confidence === 'alta' || localAnswer.confidence === 'media') {
        logger.info(`📗 Respuesta: Knowledge Base (${localAnswer.confidence})`);
        return humanizeResponse(localAnswer.answer);
      }
    }

    // 4. Si OpenAI está disponible, intentar usarlo para preguntas complejas
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
    return getGenericResponse(message);

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

  // Obtener contexto de archivos subidos (PDF, TXT)
  const uploadedContext = knowledgeUploadService.getContextFromFiles(message, 2);

  // Combinar contextos
  let relevantContext = baseContext;
  if (uploadedContext) {
    relevantContext = relevantContext
      ? `${relevantContext}\n\n--- Información adicional ---\n${uploadedContext}`
      : uploadedContext;
  }

  const messages = buildMessages(message, [], relevantContext, options);

  const response = await aiProvider.chat(messages, {
    maxTokens: 150, // Respuestas cortas
    temperature: 0.8 // Un poco más natural/variado
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
  cleanQuestionMarks
};
