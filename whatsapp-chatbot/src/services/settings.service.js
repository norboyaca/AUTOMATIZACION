/**
 * ===========================================
 * SERVICIO DE CONFIGURACIÓN
 * ===========================================
 *
 * Maneja la configuración dinámica de API keys
 * y proveedores de IA.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Archivo de configuración
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');

// Configuración en memoria
let settings = {
  provider: 'groq',
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
};

/**
 * Carga configuración desde archivo
 */
const loadSettings = () => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const saved = JSON.parse(data);

      // Merge con valores de .env como fallback
      settings = {
        provider: saved.provider || settings.provider,
        groq: {
          apiKey: saved.groq?.apiKey || process.env.GROQ_API_KEY || '',
          model: saved.groq?.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
        },
        openai: {
          apiKey: saved.openai?.apiKey || process.env.OPENAI_API_KEY || '',
          model: saved.openai?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini'
        }
      };

      logger.info('Configuración cargada desde settings.json');
    } else {
      logger.info('Usando configuración de variables de entorno');
    }
  } catch (error) {
    logger.warn('Error cargando settings.json:', error.message);
  }

  return settings;
};

/**
 * Guarda configuración en archivo
 */
const saveSettings = (newSettings) => {
  try {
    // Actualizar configuración en memoria
    if (newSettings.provider) {
      settings.provider = newSettings.provider;
    }

    if (newSettings.groq) {
      if (newSettings.groq.apiKey) settings.groq.apiKey = newSettings.groq.apiKey;
      if (newSettings.groq.model) settings.groq.model = newSettings.groq.model;
    }

    if (newSettings.openai) {
      if (newSettings.openai.apiKey) settings.openai.apiKey = newSettings.openai.apiKey;
      if (newSettings.openai.model) settings.openai.model = newSettings.openai.model;
    }

    // Guardar en archivo
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

    // Actualizar variables de entorno para que los providers las lean
    if (settings.groq.apiKey) {
      process.env.GROQ_API_KEY = settings.groq.apiKey;
      process.env.GROQ_MODEL = settings.groq.model;
    }
    if (settings.openai.apiKey) {
      process.env.OPENAI_API_KEY = settings.openai.apiKey;
      process.env.OPENAI_MODEL = settings.openai.model;
    }

    logger.info('Configuración guardada');
    return true;
  } catch (error) {
    logger.error('Error guardando configuración:', error);
    return false;
  }
};

/**
 * Obtiene la configuración actual (oculta parte de las API keys)
 */
const getSettings = () => {
  return {
    provider: settings.provider,
    groq: {
      apiKey: maskApiKey(settings.groq.apiKey),
      model: settings.groq.model
    },
    openai: {
      apiKey: maskApiKey(settings.openai.apiKey),
      model: settings.openai.model
    },
    groqAvailable: !!settings.groq.apiKey,
    openaiAvailable: !!settings.openai.apiKey
  };
};

/**
 * Obtiene las API keys reales (para uso interno)
 */
const getApiKeys = () => {
  return {
    provider: settings.provider,
    groq: settings.groq,
    openai: settings.openai
  };
};

/**
 * Oculta parte de la API key
 */
const maskApiKey = (key) => {
  if (!key || key.length < 10) return '';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
};

/**
 * Obtiene el proveedor actual
 */
const getCurrentProvider = () => {
  return settings.provider;
};

/**
 * Cambia el proveedor activo
 */
const setProvider = (provider) => {
  if (provider === 'groq' || provider === 'openai') {
    settings.provider = provider;
    saveSettings(settings);
    return true;
  }
  return false;
};

// Cargar configuración al iniciar
loadSettings();

module.exports = {
  loadSettings,
  saveSettings,
  getSettings,
  getApiKeys,
  getCurrentProvider,
  setProvider
};
