/**
 * ===========================================
 * SERVICIO DE SIMULACIÓN DE HORA
 * ===========================================
 *
 * Permite simular una hora diferente para pruebas
 * de horario de atención.
 *
 * ✅ ACTUALIZADO: Ahora usa zona horaria fija desde utils/timezone.js
 * No depende de la zona horaria del servidor AWS.
 *
 * USO:
 * - Solo para desarrollo/testing
 * - Se activa con variable de entorno SIMULATE_TIME
 * - Formato: "HH:MM" (ej: "16:45" para las 4:45 PM)
 */

const logger = require('../utils/logger');
const timezone = require('../utils/timezone');

// Hora simulada (null = usar hora real)
let simulatedTime = null;

// ===========================================
// CONTROL DE VERIFICACIÓN DE HORARIO
// ===========================================
// Permite activar/desactivar la verificación de horario de atención
// ✅ DESACTIVADO POR DEFECTO - Se puede activar manualmente vía API
let scheduleCheckEnabled = false;

/**
 * Obtiene la hora actual (real o simulada)
 * ✅ ACTUALIZADO: Usa zona horaria fija (America/Bogota por defecto)
 *
 * @returns {Object} Objeto con { hours, minutes, seconds, decimal }
 */
function getCurrentTime() {
  if (simulatedTime) {
    const [hours, minutes] = simulatedTime.split(':').map(Number);

    logger.debug(`⏰ Usando hora simulada: ${simulatedTime}`);
    return {
      hours,
      minutes,
      seconds: 0,
      decimal: hours + (minutes / 60),
      timeString: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`,
      simulated: true,
      timezone: timezone.SYSTEM_TIMEZONE
    };
  }

  // ✅ CORREGIDO: Usar zona horaria fija en lugar de new Date()
  const now = timezone.now();
  return {
    hours: now.hours,
    minutes: now.minutes,
    seconds: now.seconds,
    decimal: now.decimal,
    timeString: now.timeString,
    simulated: false,
    timezone: timezone.SYSTEM_TIMEZONE
  };
}

/**
 * Establece una hora simulada para pruebas
 *
 * @param {string} timeString - Hora en formato "HH:MM"
 * @returns {Object} Resultado
 */
function setSimulatedTime(timeString) {
  // Validar formato
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
  if (!timeRegex.test(timeString)) {
    return {
      success: false,
      error: 'Formato inválido. Use "HH:MM" (ej: "16:45")'
    };
  }

  simulatedTime = timeString;
  logger.warn(`⚠️ HORA SIMULADA ACTIVADA: ${simulatedTime}`);
  logger.warn('   El sistema usará esta hora para verificar horarios');

  return {
    success: true,
    simulatedTime,
    message: `Hora simulada establecida: ${timeString}`
  };
}

/**
 * Limpia la hora simulada (vuelve a hora real)
 *
 * @returns {Object} Resultado
 */
function clearSimulatedTime() {
  const previousTime = simulatedTime;
  simulatedTime = null;

  logger.info(`✅ Hora simulada limpiada. Volviendo a hora real.`);

  return {
    success: true,
    previousTime,
    message: 'Hora simulada desactivada'
  };
}

/**
 * Obtiene la hora simulada actual (si está activa)
 *
 * @returns {string|null} Hora simulada o null
 */
function getSimulatedTime() {
  return simulatedTime;
}

/**
 * Verifica si la simulación de hora está activa
 *
 * @returns {boolean}
 */
function isSimulationActive() {
  return simulatedTime !== null;
}

/**
 * Obtiene la hora actual en formato decimal para comparaciones
 * ✅ ACTUALIZADO: Usa zona horaria fija
 *
 * @returns {number} Hora en formato decimal (ej: 16.5 = 4:30 PM)
 */
function getCurrentTimeDecimal() {
  const time = getCurrentTime();
  return time.decimal;
}

// ===========================================
// FUNCIONES DE CONTROL DE HORARIO
// ===========================================

/**
 * Activa o desactiva la verificación de horario
 *
 * @param {boolean} enabled - true para activar, false para desactivar
 * @returns {Object} Resultado
 */
function setScheduleCheck(enabled) {
  const previousState = scheduleCheckEnabled;
  scheduleCheckEnabled = enabled;

  if (enabled) {
    logger.info(`✅ Verificación de horario ACTIVADA`);
    logger.info(`   El bot verificará el horario de atención (8:00 AM - 4:30 PM)`);
    logger.info(`   Zona horaria: ${timezone.SYSTEM_TIMEZONE}`);
  } else {
    logger.warn(`⚠️ Verificación de horario DESACTIVADA`);
    logger.warn(`   El bot responderá SIN verificar el horario`);
  }

  return {
    success: true,
    scheduleCheckEnabled: scheduleCheckEnabled,
    previousState: previousState,
    message: enabled
      ? 'Verificación de horario activada'
      : 'Verificación de horario desactivada'
  };
}

/**
 * Verifica si la verificación de horario está activada
 *
 * @returns {boolean} true si está activada
 */
function isScheduleCheckEnabled() {
  return scheduleCheckEnabled;
}

/**
 * Obtiene el estado actual del control de horario
 * ✅ ACTUALIZADO: Incluye zona horaria fija
 *
 * @returns {Object} Estado
 */
function getScheduleCheckStatus() {
  const time = getCurrentTime();
  return {
    enabled: scheduleCheckEnabled,
    simulatedTime: simulatedTime,
    isSimulationActive: isSimulationActive(),
    currentTime: time.timeString,
    currentDecimal: time.decimal,
    timezone: timezone.SYSTEM_TIMEZONE
  };
}

module.exports = {
  getCurrentTime,
  setSimulatedTime,
  clearSimulatedTime,
  getSimulatedTime,
  isSimulationActive,
  getCurrentTimeDecimal,
  setScheduleCheck,
  isScheduleCheckEnabled,
  getScheduleCheckStatus
};
