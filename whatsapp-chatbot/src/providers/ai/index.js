/**
 * ===========================================
 * ÍNDICE DE PROVEEDORES DE IA
 * ===========================================
 *
 * Sistema con múltiples proveedores:
 * 1. Groq (primario - rápido y gratuito)
 * 2. OpenAI (fallback)
 *
 * Si Groq falla, intenta con OpenAI.
 * Si ambos fallan, el chat.service usa respuestas locales.
 */

const GroqProvider = require('./groq.provider');
const OpenAIProvider = require('./openai.provider');
const config = require('../../config');
const settingsService = require('../../services/settings.service');
const logger = require('../../utils/logger');

// ===========================================
// INSTANCIAS DE PROVEEDORES
// ===========================================

let groqProvider = null;
let openaiProvider = null;

// Inicializar Groq si hay API key
if (process.env.GROQ_API_KEY) {
  groqProvider = new GroqProvider({
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
  });
  logger.info('Groq Provider disponible');
}

// Inicializar OpenAI si hay API key
if (config.openai?.apiKey) {
  openaiProvider = new OpenAIProvider(config.openai);
  logger.info('OpenAI Provider disponible');
}

// ===========================================
// FUNCIONES CON FALLBACK
// ===========================================

/**
 * Genera una respuesta de chat (SIN fallback automático)
 * Solo usa el proveedor activo configurado
 */
const chat = async (messages, options = {}) => {
  // Obtener configuración actual
  const currentSettings = settingsService.getApiKeys();

  // Determinar qué proveedor usar según el configurado
  const activeProvider = currentSettings.provider; // 'groq' o 'openai'

  // Verificar si el proveedor activo está habilitado y tiene API key
  if (activeProvider === 'groq' && currentSettings.groq.apiKey && currentSettings.groq.enabled) {
    if (groqProvider) {
      try {
        logger.debug('Usando Groq (proveedor activo)...');
        return await groqProvider.chat(messages, options);
      } catch (error) {
        logger.error('Error con Groq:', error.message);
        throw error; // NO hacer fallback, lanzar error directamente
      }
    }
  }

  if (activeProvider === 'openai' && currentSettings.openai.apiKey && currentSettings.openai.enabled) {
    if (openaiProvider) {
      try {
        logger.debug('Usando OpenAI (proveedor activo)...');
        return await openaiProvider.chat(messages, options);
      } catch (error) {
        logger.error('Error con OpenAI:', error.message);
        throw error; // NO hacer fallback, lanzar error directamente
      }
    }
  }

  // Si el proveedor activo no está disponible, lanzar error
  throw new Error(`Proveedor ${activeProvider.toUpperCase()} no disponible o no está activado`);
};

/**
 * Analiza una imagen (solo OpenAI soporta esto)
 */
const analyzeImage = async (imageUrl, prompt) => {
  if (openaiProvider) {
    return await openaiProvider.analyzeImage(imageUrl, prompt);
  }
  throw new Error('Análisis de imágenes requiere OpenAI');
};

/**
 * Transcribe audio (solo OpenAI Whisper)
 */
const transcribeAudio = async (audioPath) => {
  if (openaiProvider) {
    return await openaiProvider.transcribeAudio(audioPath);
  }
  throw new Error('Transcripción de audio requiere OpenAI');
};

/**
 * Genera embeddings (solo OpenAI)
 */
const createEmbedding = async (text) => {
  if (openaiProvider) {
    return await openaiProvider.createEmbedding(text);
  }
  throw new Error('Embeddings requiere OpenAI');
};

// ===========================================
// EXPORTAR
// ===========================================

module.exports = {
  chat,
  analyzeImage,
  transcribeAudio,
  createEmbedding,
  groqProvider,
  openaiProvider
};
