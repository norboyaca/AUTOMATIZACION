/**
 * ===========================================
 * CONFIGURACIÓN DE AUTENTICACIÓN - JWT
 * ===========================================
 *
 * CREDENCIALES HARDCODEADAS
 * Modifica estos valores directamente en el código.
 */

const bcrypt = require('bcryptjs');

// ===========================================
// CREDENCIALES DE ACCESO (HARDCODED)
// ===========================================

/**
 * Usuario y contraseña para autenticación
 *
 * Puedes cambiar estos valores directamente aquí.
 * La contraseña está hasheada con bcrypt para seguridad.
 *
 * Para generar un nuevo hash de contraseña:
 * const hash = bcrypt.hashSync('tu-contraseña', 10);
 */
const AUTH_CREDENTIALS = {
  username: 'admin',  // <-- Cambiar usuario aquí
  passwordHash: '$2a$10$aKTUEkwB.w.nZfGeexa2j.ZaH4PwqwZu7AcDsVOLQtM7CFpQr5u96'  // <-- Cambiar hash aquí (norboy2026)
};

/**
 * Contraseña en texto plano para referencia
 * (Solo para desarrollo - NO usar en producción)
 *
 * Para hashear una nueva contraseña:
 * 1. Ve a https://bcrypt-generator.com/
 * 2. Ingresa la contraseña deseada
 * 3. Copia el hash generado y pégalo en passwordHash arriba
 */
const RAW_PASSWORD = 'norboy2026';  // <-- Contraseña en texto (referencia)

// Hash actual de la contraseña por defecto (admin123)
// Generado con bcrypt.rounds=10
const DEFAULT_PASSWORD_HASH = '$2a$10$YourHashedPasswordHere';

// Usar el hash proporcionado o el por defecto
const passwordHash = AUTH_CREDENTIALS.passwordHash === DEFAULT_PASSWORD_HASH
  ? bcrypt.hashSync(RAW_PASSWORD, 10)
  : AUTH_CREDENTIALS.passwordHash;

// ===========================================
// CONFIGURACIÓN JWT
// ===========================================

const JWT_CONFIG = {
  /**
   * Secret key para firmar tokens
   *
   * CAMBIAR ESTE VALOR en producción.
   * Genera una string larga y aleatoria.
   */
  secret: 'tu-jwt-secret-key-cambialo-en-produccion-2024',

  /**
   * Tiempo de expiración del token
   *
   * Formatos válidos:
   * - '60' = 60 segundos
   * - '2m' = 2 minutos
   * - '2h' = 2 horas
   * - '7d' = 7 días
   */
  expiresIn: '24h'  // Token válido por 24 horas
};

// ===========================================
// EXPORTAR CONFIGURACIÓN
// ===========================================

module.exports = {
  // Credenciales
  username: AUTH_CREDENTIALS.username,
  passwordHash,

  // Config JWT
  jwtSecret: JWT_CONFIG.secret,
  jwtExpiresIn: JWT_CONFIG.expiresIn,

  // Helper para validar contraseña
  validatePassword: (plainPassword) => {
    return bcrypt.compareSync(plainPassword, passwordHash);
  }
};
