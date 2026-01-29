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
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    enabled: true  // Habilitado por defecto
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    enabled: true  // Habilitado por defecto
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
          model: saved.groq?.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
          enabled: saved.groq?.enabled !== undefined ? saved.groq.enabled : true
        },
        openai: {
          apiKey: saved.openai?.apiKey || process.env.OPENAI_API_KEY || '',
          model: saved.openai?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
          enabled: saved.openai?.enabled !== undefined ? saved.openai.enabled : true
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
      if (newSettings.groq.apiKey !== undefined) settings.groq.apiKey = newSettings.groq.apiKey;
      if (newSettings.groq.model !== undefined) settings.groq.model = newSettings.groq.model;
      if (newSettings.groq.enabled !== undefined) settings.groq.enabled = newSettings.groq.enabled;
    }

    if (newSettings.openai) {
      if (newSettings.openai.apiKey !== undefined) settings.openai.apiKey = newSettings.openai.apiKey;
      if (newSettings.openai.model !== undefined) settings.openai.model = newSettings.openai.model;
      if (newSettings.openai.enabled !== undefined) settings.openai.enabled = newSettings.openai.enabled;
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
      model: settings.groq.model,
      enabled: settings.groq.enabled
    },
    openai: {
      apiKey: maskApiKey(settings.openai.apiKey),
      model: settings.openai.model,
      enabled: settings.openai.enabled
    },
    groqAvailable: !!settings.groq.apiKey && settings.groq.enabled,
    openaiAvailable: !!settings.openai.apiKey && settings.openai.enabled
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
