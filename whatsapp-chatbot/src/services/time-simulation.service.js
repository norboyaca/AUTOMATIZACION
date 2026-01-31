/**
 * ===========================================
 * SERVICIO DE SIMULACIÓN DE HORA
 * ===========================================
 *
 * Permite simular una hora diferente para pruebas
 * de horario de atención.
 *
 * USO:
 * - Solo para desarrollo/testing
 * - Se activa con variable de entorno SIMULATE_TIME
 * - Formato: "HH:MM" (ej: "16:45" para las 4:45 PM)
 */

const logger = require('../utils/logger');

// Hora simulada (null = usar hora real)
let simulatedTime = null;

// ===========================================
// CONTROL DE VERIFICACIÓN DE HORARIO
// ===========================================
// Permite activar/desactivar la verificación de horario de atención
let scheduleCheckEnabled = true;

/**
 * Obtiene la hora actual (real o simulada)
 *
 * @returns {Date} Fecha actual
 */
function getCurrentTime() {
  if (simulatedTime) {
    // Devolver la hora simulada
    const now = new Date();
    const [hours, minutes] = simulatedTime.split(':').map(Number);

    const simulatedDate = new Date();
    simulatedDate.setHours(hours);
    simulatedDate.setMinutes(minutes);
    simulatedDate.setSeconds(0);

    logger.debug(`⏰ Usando hora simulada: ${simulatedTime}`);
    return simulatedDate;
  }

  // Devolver la hora real
  return new Date();
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
 * Útil para verificar si estamos dentro del horario
 *
 * @returns {number} Hora en formato decimal (ej: 16.5 = 4:30 PM)
 */
function getCurrentTimeDecimal() {
  const now = getCurrentTime();
  const hour = now.getHours();
  const minute = now.getMinutes();
  return hour + (minute / 60);
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
 *
 * @returns {Object} Estado
 */
function getScheduleCheckStatus() {
  return {
    enabled: scheduleCheckEnabled,
    simulatedTime: simulatedTime,
    isSimulationActive: isSimulationActive(),
    currentTime: getCurrentTime().toLocaleTimeString(),
    currentDecimal: getCurrentTimeDecimal()
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
