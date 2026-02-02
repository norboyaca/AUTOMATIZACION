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
const escalationService = require('./escalation.service');

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

    // ===========================================
    // IMPORTANTE: NO evaluar escalación aquí
    // La escalación se maneja en messageProcessor
    // Aquí solo intentar responder
    // ===========================================

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

    // 6. Último recurso: respuesta genérica (ahora asíncrono)
    logger.info('📙 Respuesta: Genérica (último intento con IA)');
    const response = await getGenericResponse(message);

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
 *
 * ✅ MEJORADO: Evalúa calidad de fragmentos encontrados antes de decidir escalar
 */
const generateWithAI = async (userId, message, options = {}) => {
  // Obtener contexto de la base de conocimiento original
  const baseContext = knowledgeBase.getContext(message, 3);

  // Obtener archivos subidos
  const files = knowledgeUploadService.getUploadedFiles();
  const hasDocuments = files.length > 0;

  let relevantContext = baseContext;
  let searchResults = [];
  let contextQuality = 'none'; // 'high', 'medium', 'low', 'none'

  if (hasDocuments) {
    logger.info(`📚 Procesando ${files.length} documento(s) subido(s)`);

    // SIEMPRE usar búsqueda inteligente para encontrar fragmentos relevantes
    searchResults = knowledgeUploadService.searchInFiles(message);

    if (searchResults.length > 0) {
      // ✅ NUEVO: Evaluar calidad de los resultados
      const topScore = searchResults[0].score;
      const avgScore = searchResults.reduce((sum, r) => sum + r.score, 0) / searchResults.length;

      // Determinar calidad del contexto basado en scores
      if (topScore >= 20) {
        contextQuality = 'high';
        logger.info(`✅ Contexto de ALTA calidad detectado (top score: ${topScore})`);
      } else if (topScore >= 10) {
        contextQuality = 'medium';
        logger.info(`📊 Contexto de calidad MEDIA detectado (top score: ${topScore})`);
      } else {
        contextQuality = 'low';
        logger.info(`⚠️ Contexto de BAJA calidad detectado (top score: ${topScore})`);
      }

      // Usar fragmentos encontrados (más eficiente y preciso)
      logger.info(`🎯 Encontrados ${searchResults.length} fragmentos relevantes (avg score: ${avgScore.toFixed(1)})`);

      // ✅ NUEVO: Aumentar cantidad de contexto según calidad
      const contextCount = contextQuality === 'high' ? 5 : contextQuality === 'medium' ? 4 : 3;

      const contextFromSearch = searchResults
        .slice(0, contextCount)
        .map(r => `[Fuente: ${r.source}]\n${r.text}`)
        .join('\n\n---\n\n');

      relevantContext = relevantContext
        ? `${relevantContext}\n\n--- Información de documentos ---\n${contextFromSearch}`
        : contextFromSearch;
    } else {
      // Si no hay coincidencias, pasar TODO el contenido (como último recurso)
      logger.info('📄 Sin coincidencias exactas, usando contenido completo de documentos');
      contextQuality = 'none';
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

  // ✅ NUEVO: Obtener historial de conversación del día para dar contexto a la IA
  const conversationHistory = await getConversationHistory(userId);

  const messages = buildMessages(message, conversationHistory, relevantContext, options, { contextQuality, searchResults });

  // Aumentar tokens cuando hay contexto de documentos
  const maxTokens = hasDocuments ? 400 : 150;

  const response = await aiProvider.chat(messages, {
    maxTokens: maxTokens,
    temperature: 0.7 // Un poco más preciso
  });

  const cleanedResponse = cleanQuestionMarks(response);

  // ===========================================
  // DETECTAR RESPUESTA DE BAJA CONFIANZA
  // ===========================================
  // Si la IA indica que no tiene información, activar escalación
  //
  // ✅ IMPORTANTE: Excluir el mensaje de escalación del sistema para evitar bucle infinito
  const ESCALATION_MESSAGE_PATTERNS = [
    'comprendo, sumercé',
    'el asesor de norboy encargado de este tema le atenderá'
  ];

  // Verificar primero si la respuesta es el mensaje de escalación (para evitar bucle)
  const isEscalationMessage = ESCALATION_MESSAGE_PATTERNS.some(pattern =>
    cleanedResponse.toLowerCase().includes(pattern)
  );

  if (isEscalationMessage) {
    logger.warn(`⚠️ La IA respondió con el mensaje de escalación para ${userId}`);
    logger.warn(`   Esto indica que la IA NO encontró información relevante`);
    logger.warn(`   Respuesta: "${cleanedResponse.substring(0, 100)}..."`);
    logger.warn(`   Calidad del contexto: ${contextQuality}, Fragmentos encontrados: ${searchResults.length}`);

    // ✅ NUEVO: Si la calidad del contexto es alta o media, intentar respuesta alternativa
    if (contextQuality === 'high' || contextQuality === 'medium') {
      logger.info(`🔄 Intentando respuesta alternativa con contexto de calidad ${contextQuality.toUpperCase()}`);

      // Generar respuesta usando el mejor fragmento encontrado
      const topFragment = searchResults[0].text;
      const fallbackResponse = `Según la información disponible sobre el proceso electoral:\n\n${topFragment.substring(0, 300)}...\n\nPara más detalles específicos, un asesor puede atenderte.`;

      logger.info(`✅ Respuesta alternativa generada usando fragmento top`);
      return fallbackResponse;
    }

    // Retornar el mensaje de escalación directamente
    return {
      type: 'escalation_no_info',
      text: NO_INFO_MESSAGE,
      needsHuman: true,
      escalation: {
        reason: 'ai_no_information',
        priority: 'medium',
        detectedKeyword: 'escalation_message_response',
        originalResponse: cleanedResponse.substring(0, 200),
        contextQuality: contextQuality,
        fragmentsFound: searchResults.length
      }
    };
  }

  // Patrones de baja confianza (EXCLUYENDO el mensaje de escalación del sistema)
  const lowConfidencePatterns = [
    'no tengo información',
    'no cuento con información',
    'no dispongo de información',
    'no se encuentra información',
    'no mencionas',
    'no especificas',
    'lo siento pero no',
    'no tengo información disponible',
    'no cuento con detalles',
    'estamos verificando esa información'
  ];

  const normalizedResponse = cleanedResponse.toLowerCase().trim();
  const hasLowConfidence = lowConfidencePatterns.some(pattern =>
    normalizedResponse.includes(pattern)
  );

  if (hasLowConfidence) {
    logger.warn(`⚠️ IA indica falta de información para ${userId}`);
    logger.warn(`   Respuesta: "${cleanedResponse.substring(0, 100)}..."`);
    logger.warn(`   Patrón detectado: "${lowConfidencePatterns.find(p => normalizedResponse.includes(p))}"`);
    logger.warn(`   Calidad del contexto: ${contextQuality}, Fragmentos encontrados: ${searchResults.length}`);

    // ✅ NUEVO: Si la calidad del contexto es buena, intentar con el mejor fragmento
    if (contextQuality === 'high' || (contextQuality === 'medium' && searchResults.length >= 3)) {
      logger.info(`🔄 Recuperando: usando mejor fragmento encontrado (score: ${searchResults[0].score})`);

      const topFragment = searchResults[0].text;
      const fallbackResponse = `${topFragment.substring(0, 500)}...\n\nSi necesitas más detalles, un asesor puede ayudarte.`;

      return fallbackResponse;
    }

    // Retornar objeto especial de escalación
    return {
      type: 'escalation_no_info',
      text: NO_INFO_MESSAGE,
      needsHuman: true,
      escalation: {
        reason: 'ai_no_information',
        priority: 'medium',
        detectedKeyword: 'low_confidence_response',
        originalResponse: cleanedResponse.substring(0, 200),
        contextQuality: contextQuality,
        fragmentsFound: searchResults.length
      }
    };
  }

  return cleanedResponse;
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
 * Mensaje cuando la IA no tiene información suficiente
 */
const NO_INFO_MESSAGE = 'Comprendo, sumercé. 👩‍💼\n\nEl asesor de NORBOY encargado de este tema le atenderá en breve...';

/**
 * Respuesta genérica cuando no hay match
 *
 * ✅ IMPORTANTE: Esta función se llama como ÚLTIMO recurso.
 * Debe intentar usar la IA con cualquier contexto disponible antes de escalar.
 */
const getGenericResponse = async (originalMessage) => {
  logger.warn(`⚠️ Sin información en base de conocimientos local para: "${originalMessage.substring(0, 50)}..."`);

  // ✅ NUEVO: Intentar una última vez con la IA usando un prompt más permisivo
  // Esto permite que la IA use su conocimiento general cuando no hay documentos específicos
  try {
    logger.info(`🔄 Último intento: IA sin contexto restrictivo`);

    const fallbackMessages = [
      {
        role: 'system',
        content: `Eres un asistente virtual de NORBOY, una cooperativa especializada de ahorro y crédito.

INSTRUCCIONES:
1. Responde de manera amable y profesional usando "sumercé" para dirigirte al usuario
2. Si la pregunta es sobre el proceso de elección de delegados 2026-2029, indica que un asesor le ayudará
3. Si la pregunta es sobre temas generales de cooperativas, puedes dar una respuesta general
4. Si no puedes responder, indica claramente que un asesor le atenderá

IMPORTANTE: NO inventes información específica que no sepas. Es mejor admitir que no sabes que inventar datos.`
      },
      {
        role: 'user',
        content: originalMessage
      }
    ];

    const aiResponse = await aiProvider.chat(fallbackMessages, {
      maxTokens: 150,
      temperature: 0.7
    });

    const cleanedResponse = cleanQuestionMarks(aiResponse);

    // Verificar si la respuesta indica que no puede ayudar
    const cannotHelpPatterns = [
      'no puedo responder',
      'no tengo información',
      'no dispongo de información',
      'un asesor te contestará',
      'un asesor le atenderá'
    ];

    const cannotHelp = cannotHelpPatterns.some(pattern =>
      cleanedResponse.toLowerCase().includes(pattern)
    );

    if (cannotHelp) {
      logger.warn(`⚠️ IA indica que no puede ayudar (fallback)`);
      // Escalar al asesor
      return {
        type: 'escalation_no_info',
        text: NO_INFO_MESSAGE,
        needsHuman: true,
        escalation: {
          reason: 'no_knowledge_match',
          priority: 'medium',
          message: 'No se encontró información en base de conocimientos'
        }
      };
    }

    logger.info(`✅ Respuesta generada (fallback): "${cleanedResponse.substring(0, 50)}..."`);
    return cleanedResponse;

  } catch (error) {
    logger.error(`❌ Error incluso en fallback de IA:`, error.message);

    // Último recurso: escalar al asesor
    return {
      type: 'escalation_no_info',
      text: NO_INFO_MESSAGE,
      needsHuman: true,
      escalation: {
        reason: 'ai_fallback_failed',
        priority: 'high',
        message: 'Error en sistema de IA'
      }
    };
  }
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

━━━━━━━━━━━━━━━━━━
⚠️ IMPORTANTE

Para continuar debes ESCRIBIR el número 
aceptas las políticas:
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
 * Mensaje cuando se escala a humano
 */
const getEscalationMessage = (escalation) => {
  return {
    type: 'escalation',
    text: `Comprendo, sumercé. 👩‍💼

El asesor de NORBOY encargado de este tema le atenderá en breve...`,
    needsHuman: true,
    escalation
  };
};

/**
 * Mensaje fuera de horario
 */
const getOutOfHoursMessage = () => {
  const nextOpening = escalationService.getNextOpeningTime();

  return {
    type: 'out_of_hours',
    text: `Sumercé, nuestro horario de atención es:
📅 Lunes a Viernes: 8:00 AM - 4:30 PM
📅 Sábados: 9:00 AM - 12:00 PM
❌ Domingos: Cerrado

Lo atenderemos con gusto:
📅 ${nextOpening.formatted}

🌙 Buenas noches.`
  };
};

/**
 * Construye mensajes para IA
 *
 * ✅ MEJORADO: Prompt más flexible que permite respuestas inteligentes
 * ✅ NUEVO: Ajusta el prompt según la calidad del contexto encontrado
 */
const buildMessages = (userMessage, history = [], context = '', options = {}, contextInfo = {}) => {
  const messages = [];
  const { contextQuality = 'none', searchResults = [] } = contextInfo;

  const systemPrompt = options.systemPrompt || config.openai.systemPrompts.default;

  messages.push({
    role: 'system',
    content: systemPrompt
  });

  if (context) {
    // ✅ NUEVO: Prompt ajustado dinámicamente según calidad del contexto
    let promptContext = '';

    if (contextQuality === 'high' || contextQuality === 'medium') {
      // Contexto de buena calidad: ser más permisivo
      promptContext = `📚 INFORMACIÓN DE DOCUMENTOS (CALIDAD: ${contextQuality.toUpperCase()}):
Se encontraron ${searchResults.length} fragmentos relevantes en los documentos.

${context}

INSTRUCCIONES ESPECIALES (contexto de calidad ${contextQuality.toUpperCase()}):
1. ✅ TIENES INFORMACIÓN RELEVANTE DISPONIBLE - ÚSALA
2. Responde usando la información de los documentos proporcionados arriba
3. Si no encuentras la fecha/hora EXACTA, PUEDES:
   - Explicar el proceso general
   - Mencionar qué etapas hay
   - Indicar cómo será la elección
   - Decir "según el cronograma del proceso" sin dar fecha específica
4. Solo escala al asesor si la pregunta es COMPLETAMENTE AJENA a NORBOY
5. Responde siempre de manera amable usando "sumercé"

EJEMPLOS DE RESPUESTAS APROPIADAS:
- "La votación se realizará según el cronograma oficial del proceso..."
- "El proceso de elección contempla varias etapas..."
- "Según la información disponible, los delegados se eligen mediante..."`;
    } else {
      // Contexto de baja calidad: ser más cauteloso
      promptContext = `📚 INFORMACIÓN DE DOCUMENTOS DISPONIBLE:\n${context}\n\nINSTRUCCIONES:
1. PRIORIDAD: Usa PRIMERO la información de los documentos proporcionados arriba
2. Si encuentras información relevante en los documentos, responde usando esa información
3. PUEDES complementar con tu conocimiento general sobre cooperativas si es necesario
4. Si la pregunta NO está relacionada con NORBOY o cooperativas, indica amablemente que un asesor le ayudará
5. Si NO encuentras ABSOLUTAMENTE NINGUNA información relevante después de revisar TODO el contexto, di: "Estamos verificando esa información. Un asesor te contestará en breve."
6. Responde siempre de manera amable usando "sumercé" para dirigirte al usuario

IMPORTANTE:
- NO inventes datos específicos que no estén en los documentos (fechas exactas, montos, nombres específicos, etc.)
- PUEDES dar información general sobre el proceso aunque no tengas la fecha exacta
- PUEDES explicar cómo será el proceso aunque no sepas el día específico
- Si el documento menciona un cronograma o período pero no una fecha exacta, usa esa información general`;
    }

    messages.push({
      role: 'system',
      content: promptContext
    });
  } else {
    // Si no hay contexto de documentos, permitir respuestas más generales sobre NORBOY
    messages.push({
      role: 'system',
      content: `📋 BASE DE CONOCIMIENTO:\nNo hay documentos específicos cargados.\n\nINSTRUCCIONES:
1. Responde preguntas generales sobre NORBOY (cooperativa, proceso electoral, delegados)
2. Si la pregunta requiere información específica (fechas, montos, detalles), di: "Estamos verificando esa información. Un asesor te contestará en breve."
3. Si la pregunta es sobre temas completamente ajenos a NORBOY, indica amablemente que un asesor le ayudará
4. Responde siempre de manera amable usando "sumercé" para dirigirte al usuario

NO respondas sobre temas ajenos a la cooperativa (ciencia, historia, geografía, clima, etc.).`
    });
  }

  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: userMessage });

  return messages;
};

/**
 * Obtiene el historial de conversación del día actual
 *
 * @param {string} userId - ID del usuario
 * @returns {Array} Historial de mensajes del día en formato OpenAI
 */
const getConversationHistory = async (userId) => {
  try {
    // Obtener el servicio de estado de conversación
    const conversationStateService = require('./conversation-state.service');
    const conversation = conversationStateService.getConversation(userId);

    if (!conversation || !conversation.messages || conversation.messages.length === 0) {
      return [];
    }

    // Obtener mensajes de hoy (últimas 24 horas)
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const todayStart = now - oneDayMs;

    // Filtrar mensajes de hoy y convertirlos al formato de OpenAI
    const todayMessages = conversation.messages
      .filter(msg => msg.timestamp >= todayStart)
      .map(msg => {
        // Mapear sender a role
        let role = 'user';
        if (msg.sender === 'bot' || msg.sender === 'admin') {
          role = 'assistant';
        }

        return {
          role: role,
          content: msg.message
        };
      });

    logger.debug(`📜 Historial cargado para ${userId}: ${todayMessages.length} mensajes de hoy`);

    return todayMessages;
  } catch (error) {
    logger.error(`Error obteniendo historial de conversación para ${userId}:`, error);
    return [];
  }
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
  resetUserState,
  getEscalationMessage,
  getOutOfHoursMessage,
  NO_INFO_MESSAGE  // Exportar para uso en otros módulos
};
