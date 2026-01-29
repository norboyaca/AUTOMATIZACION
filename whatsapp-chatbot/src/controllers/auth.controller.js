/**
 * ===========================================
 * CONTROLADOR DE AUTENTICACIÓN
 * ===========================================
 *
 * Responsabilidades:
 * - Manejar login de usuarios
 * - Generar tokens JWT
 * - Validar credenciales
 */

const jwt = require('jsonwebtoken');
const authConfig = require('../config/auth.config');
const logger = require('../utils/logger');

/**
 * Endpoint POST /api/auth/login
 *
 * Cuerpo esperado:
 * {
 *   "username": "admin",
 *   "password": "admin123"
 * }
 *
 * Respuesta exitosa (200):
 * {
 *   "success": true,
 *   "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
 *   "user": {
 *     "username": "admin"
 *   },
 *   "expiresIn": "24h"
 * }
 *
 * Respuesta de error (401):
 * {
 *   "error": "Credenciales inválidas",
 *   "code": "INVALID_CREDENTIALS"
 * }
 */
const login = (req, res) => {
  try {
    const { username, password } = req.body;

    // Validar que se proporcionaron credenciales
    if (!username || !password) {
      return res.status(400).json({
        error: 'Se requieren usuario y contraseña',
        code: 'MISSING_CREDENTIALS'
      });
    }

    // Validar credenciales contra la configuración hardcodeada
    const isValidUsername = username === authConfig.username;
    const isValidPassword = authConfig.validatePassword(password);

    if (!isValidUsername || !isValidPassword) {
      logger.warn(`Intento de login fallido: ${username}`);

      return res.status(401).json({
        error: 'Credenciales inválidas',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Generar token JWT
    const token = jwt.sign(
      {
        username: authConfig.username
      },
      authConfig.jwtSecret,
      {
        expiresIn: authConfig.jwtExpiresIn
      }
    );

    logger.info(`Login exitoso: ${username}`);

    // Respuesta exitosa
    res.json({
      success: true,
      token,
      user: {
        username: authConfig.username
      },
      expiresIn: authConfig.jwtExpiresIn
    });

  } catch (error) {
    logger.error('Error en login:', error);

    res.status(500).json({
      error: 'Error en el servidor',
      code: 'SERVER_ERROR'
    });
  }
};

/**
 * Endpoint GET /api/auth/me
 *
 * Retorna información del usuario autenticado
 * Requiere token JWT válido
 *
 * Header: Authorization: Bearer <token>
 *
 * Respuesta (200):
 * {
 *   "success": true,
 *   "user": {
 *     "username": "admin"
 *   }
 * }
 */
const me = (req, res) => {
  // Este endpoint requiere el middleware requireAuth
  // req.user es agregado por el middleware

  res.json({
    success: true,
    user: {
      username: req.user.username
    }
  });
};

module.exports = {
  login,
  me
};
