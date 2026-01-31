/**
 * ===========================================
 * SERVICIO DE ESCALACIÓN A HUMANO
 * ===========================================
 *
 * Responsabilidades:
 * - Detectar cuándo una conversación requiere intervención humana
 * - Evaluar reglas de escalación
 * - Verificar horarios de atención
 * - Gestionar prioridades de escalación
 */

const logger = require('../utils/logger');

/**
 * Configuración de reglas de escalación
 */
const escalationRules = {
  // Frases que indican una SOLICITUD CLARA de hablar con asesor
  // IMPORTANTE: Solo frases completas que indiquen intención clara
  // NO incluir palabras sueltas como "asesor", "humano", "persona"
  explicitRequest: [
    'quiero hablar con asesor',
    'necesito hablar con asesor',
    'quiero asesor',
    'necesito asesor',
    'conectarme con asesor',
    'hablar con humano',
    'hablar con persona',
    'atención de asesor',
    'atención personal',
    'quiero hablar con alguien',
    'necesito hablar con alguien',
    'transferirme a asesor',
    'pasarme con asesor',
    'como puedo hablar con un asesor',
    'como hablar con asesor',
    'puedo hablar con asesor',
    'quiero hablar con un asesor',
    'necesito hablar con un asesor',
    'deseo hablar con asesor',
    'quiero que me atienda un asesor',
    'necesito atencion de asesor',
    'quiero atencion personal',
    'quiero hablar con persona',
    'necesito hablar con persona'
  ],

  // Tópicos complejos/sensibles que requieren atención humana
  complexTopics: [
    'queja', 'reclamo', 'problema', 'error', 'no funciona',
    'insatisfecho', 'descontento', 'mal servicio', 'demorado',
    'urgente', 'emergencia'
  ],

  // ❌ ELIMINADO: Ya no se usa límite de intentos
  // La IA siempre intenta responder primero
  // maxRetries: 3,

  // Horario laboral (PUNTO DE CONTROL 4)
  workingHours: {
    start: 8,  // 8:00 AM
    end: 16,   // 4:00 PM (se usa con endMinute para el cálculo)
    endMinute: 30,  // 4:30 PM - Horario FINAL de atención
    timezone: 'America/Bogota',
    weekdays: [1, 2, 3, 4, 5] // Lun-Vie (0=Domingo, 6=Sábado)
  },

  // Tiempo mínimo entre mensajes para considerar "reintento"
  retryMinInterval: 30000 // 30 segundos
};

/**
 * Historial temporal para detectar reintentos
 * Map<userId, Array<{timestamp, message}>>
 */
const retryHistory = new Map();

/**
 * Evalúa si un mensaje requiere escalación a humano
 *
 * @param {string} userId - ID del usuario
 * @param {string} message - Mensaje del usuario
 * @param {number} interactionCount - Número de interacciones en el ciclo actual
 * @returns {Object} - { needsHuman, reason, priority, message }
 */
function evaluateEscalation(userId, message, interactionCount = 0) {
  const normalizedMessage = message.toLowerCase().trim();

  // ✅ NUEVO: Obtener conversación para verificar si fue reactivada manualmente
  const conversationStateService = require('./conversation-state.service');
  const conversation = conversationStateService.getConversation(userId);

  // ✅ NUEVO: Si fue reactivada manualmente, ignorar regla de múltiples intentos
  // (Ya no se usa la regla de múltiples intentos, pero mantenemos el flag por si acaso)
  if (conversation && conversation.manuallyReactivated) {
    logger.info(`🔄 Conversación ${userId} fue reactivada manualmente. Reseteando flag.`);

    // Resetear el flag para que solo se aplique una vez
    conversation.manuallyReactivated = false;

    // No escalar (la regla de múltiples intentos ya no existe)
    logger.info(`   ✅ Flag de reactivación manual reseteado`);
    logger.info(`   ✅ La IA intentará responder normalmente`);

    return {
      needsHuman: false,
      reason: null,
      priority: null,
      message: null
    };
  }

  // 1. Solicitud explícita de asesor humano
  const explicitMatch = escalationRules.explicitRequest.find(keyword =>
    normalizedMessage.includes(keyword.toLowerCase())
  );

  if (explicitMatch) {
    logger.info(`🚨 Escalación explícita detectada para ${userId}: "${explicitMatch}"`);

    return {
      needsHuman: true,
      reason: 'user_requested',
      priority: 'high',
      message: 'El usuario solicita hablar con un asesor.',
      detectedKeyword: explicitMatch
    };
  }

  // 2. Tópico complejo o sensible
  const complexMatch = escalationRules.complexTopics.find(keyword =>
    normalizedMessage.includes(keyword.toLowerCase())
  );

  if (complexMatch) {
    logger.info(`⚠️ Tópico complejo detectado para ${userId}: "${complexMatch}"`);

    return {
      needsHuman: true,
      reason: 'complex_topic',
      priority: 'medium',
      message: `Tópico sensible detectado: "${complexMatch}". Requiere atención humana.`,
      detectedKeyword: complexMatch
    };
  }

  // ===========================================
  // ❌ ELIMINADO: Regla de múltiples intentos
  // ===========================================
  // La IA SIEMPRE debe intentar responder primero.
  // Solo se escala si:
  // 1. El usuario lo solicita explícitamente
  // 2. Es un tópico complejo/sensible
  // 3. La IA indica que no tiene información (baja confianza)
  //
  // No tiene sentido escalar automáticamente después de N mensajes,
  // ya que la IA moderna puede manejar conversaciones largas perfectamente.

  // 3. Múltiples intentos sin resolución (usar interactionCount) - ELIMINADO
  // if (interactionCount >= escalationRules.maxRetries) {
  //   logger.info(`🔄 Múltiples intentos para ${userId}: ${interactionCount}+`);
  //   return {
  //     needsHuman: true,
  //     reason: 'multiple_retries',
  //     priority: 'medium',
  //     message: `Usuario realizó ${interactionCount}+ interacciones sin resolución satisfactoria.`
  //   };
  // }

  // 3. Verificar si está fuera de horario laboral
  const isWithinHours = isWithinWorkingHours();

  if (!isWithinHours) {
    logger.info(`🌙 Fuera de horario laboral`);

    return {
      needsHuman: false,
      reason: 'out_of_hours',
      priority: 'low',
      message: 'Fuera del horario de atención (8:00 AM - 4:30 PM, Lun-Vie).'
    };
  }

  // No requiere escalación
  return {
    needsHuman: false,
    reason: null,
    priority: null,
    message: null
  };
}

/**
 * Verifica si estamos dentro del horario laboral
 * PUNTO DE CONTROL 4: Horario hasta las 4:30 PM
 *
 * @returns {boolean}
 */
function isWithinWorkingHours() {
  try {
    const now = new Date();

    // Obtener hora y minuto en la zona horaria configurada
    const hour = now.getHours();
    const minute = now.getMinutes();
    const day = now.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado

    const { start, end, endMinute, weekdays } = escalationRules.workingHours;

    // Verificar si es día laboral
    const isWorkday = weekdays.includes(day);

    if (!isWorkday) {
      logger.debug(`Hoy no es día laboral (día ${day})`);
      return false;
    }

    // PUNTO DE CONTROL 4: Verificar horario con minutos
    // Convertir a decimal para comparación: 16.5 = 4:30 PM
    const currentTimeDecimal = hour + (minute / 60);
    const endTimeDecimal = end + (endMinute / 60);

    // Estamos dentro del horario si: start <= current < end:endMinute
    const isWorkHour = currentTimeDecimal >= start && currentTimeDecimal < endTimeDecimal;

    logger.debug(`Horario check: ${hour}:${minute.toString().padStart(2, '0')} está en rango ${start}:00-${end}:${endMinute.toString().padStart(2, '0')}? ${isWorkHour}`);

    return isWorkHour;
  } catch (error) {
    logger.error('Error verificando horario laboral:', error);
    // En caso de error, asumimos que estamos en horario laboral
    return true;
  }
}

/**
 * Obtiene el próximo horario de apertura
 *
 * @returns {Object} - { date, formatted }
 */
function getNextOpeningTime() {
  const now = new Date();
  const { start, weekdays } = escalationRules.workingHours;

  // Si hoy es día laboral pero ya pasó el horario, próximo es mañana
  // Si hoy no es día laboral, encontrar el próximo lunes

  let nextOpening = new Date(now);
  nextOpening.setHours(start, 0, 0, 0); // Establecer hora de apertura

  const currentDay = now.getDay();
  const currentHour = now.getHours();

  // Si estamos antes de la hora de apertura en un día laboral
  if (weekdays.includes(currentDay) && currentHour < start) {
    // Ya está en hoy
  } else {
    // Buscar próximo día laboral
    let daysToAdd = 1;
    while (!weekdays.includes((currentDay + daysToAdd) % 7)) {
      daysToAdd++;
    }
    nextOpening.setDate(now.getDate() + daysToAdd);
  }

  const formatted = nextOpening.toLocaleString('es-CO', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: escalationRules.workingHours.timezone
  });

  return {
    date: nextOpening,
    formatted
  };
}

/**
 * Registra un reintento para detección de múltiples intentos
 *
 * @param {string} userId
 * @param {string} message
 */
function registerRetry(userId, message) {
  if (!retryHistory.has(userId)) {
    retryHistory.set(userId, []);
  }

  const userRetries = retryHistory.get(userId);
  const now = Date.now();

  // Agregar reintento
  userRetries.push({
    timestamp: now,
    message
  });

  // Limpiar reintentos antiguos (más de 5 minutos)
  const recentRetries = userRetries.filter(r =>
    now - r.timestamp < 5 * 60 * 1000
  );

  retryHistory.set(userId, recentRetries);

  logger.debug(`Reintento registrado para ${userId}. Total reciente: ${recentRetries.length}`);
}

/**
 * Obtiene el número de reintentos recientes de un usuario
 *
 * @param {string} userId
 * @returns {number}
 */
function getRetryCount(userId) {
  const userRetries = retryHistory.get(userId);
  return userRetries ? userRetries.length : 0;
}

/**
 * Limpia el historial de reintentos de un usuario
 *
 * @param {string} userId
 */
function clearRetryHistory(userId) {
  retryHistory.delete(userId);
  logger.debug(`Historial de reintentos limpiado para ${userId}`);
}

/**
 * Obtiene estadísticas de escalación
 *
 * @returns {Object}
 */
function getEscalationStats() {
  const now = Date.now();
  let totalRetries = 0;
  let recentRetries = 0;

  for (const [userId, retries] of retryHistory.entries()) {
    totalRetries += retries.length;
    recentRetries += retries.filter(r => now - r.timestamp < 60 * 60 * 1000).length;
  }

  return {
    totalUsersWithRetries: retryHistory.size,
    totalRetries,
    recentRetries,
    isWithinWorkingHours: isWithinWorkingHours(),
    nextOpeningTime: getNextOpeningTime()
  };
}

module.exports = {
  evaluateEscalation,
  isWithinWorkingHours,
  getNextOpeningTime,
  registerRetry,
  getRetryCount,
  clearRetryHistory,
  getEscalationStats
};
