/**
 * ===========================================
 * SERVICIO DE EMBEDDINGS - OPENAI
 * ===========================================
 *
 * Búsqueda vectorial ultra optimizada para recuperación de chunks.
 *
 * OPTIMIZACIONES:
 * - text-embedding-3-small (más barato y rápido)
 * - Batch processing (100 chunks por API call)
 * - Caché en memoria (evita regeneración)
 * - Retry logic con exponential backoff
 * - Rate limiting automático
 *
 * COSTOS:
 * - Generación: $0.00002 por 1K tokens
 * - 494 chunks × ~100 tokens = ~$0.001 (única vez)
 * - Por consulta: 1 embedding × ~10 tokens = $0.0000002
 */

const OpenAI = require('openai');
const logger = require('../utils/logger');
const settingsService = require('./settings.service');

// ===========================================
// CONFIGURACIÓN
// ===========================================

const EMBEDDING_CONFIG = {
  model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE) || 100,
  maxRetries: 3,
  retryDelay: 1000, // ms
  retryBackoff: 2, // multiplicador
};

// Cliente OpenAI (singleton)
let openaiClient = null;

// ===========================================
// CACHE EN MEMORIA
// ===========================================

/**
 * Cache de embeddings en memoria para evitar regeneración
 * Estructura: { chunkId: embedding }
 */
const embeddingCache = new Map();

/**
 * Chunks cargados en memoria
 * Estructura: [ { id, text, embedding, ...chunkData } ]
 */
let loadedChunks = [];

/**
 * Flag para saber si los chunks están cargados
 */
let chunksLoaded = false;

// ===========================================
// INICIALIZACIÓN
// ===========================================

/**
 * Inicializa el cliente de OpenAI
 */
function initializeClient() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY no está definida en variables de entorno');
    }

    openaiClient = new OpenAI({
      apiKey: apiKey,
      timeout: 30000, // 30 segundos
      maxRetries: EMBEDDING_CONFIG.maxRetries,
    });

    logger.info('✅ Cliente OpenAI embeddings inicializado');
  }

  return openaiClient;
}

/**
 * ✅ NUEVO: Detecta qué proveedor de embeddings usar
 *
 * Lógica de prioridad:
 * - Si ChatGPT enabled Y Grok disabled → OpenAI embeddings
 * - Si ChatGPT disabled O Grok enabled → @xenova/transformers (local)
 *
 * @returns {string} 'openai' o 'xenova'
 */
function detectEmbeddingProvider() {
  const settings = settingsService.getApiKeys();

  const chatGPTEnabled = settings.openai.enabled && settings.openai.apiKey;
  const grokEnabled = settings.groq.enabled && settings.groq.apiKey;

  // Si ChatGPT está habilitado y Grok NO está habilitado → usar OpenAI
  if (chatGPTEnabled && !grokEnabled) {
    return 'openai';
  }

  // Si ChatGPT está deshabilitado, o si ambos están habilitados (Grok activo) → usar local
  return 'xenova';
}

// ===========================================
// GENERACIÓN DE EMBEDDINGS
// ===========================================

/**
 * Genera embeddings para un batch de textos
 *
 * @param {Array<string>} texts - Textos para generar embeddings
 * @returns {Promise<Array<number[]>>} Array de embeddings
 */
async function generateEmbeddingsBatch(texts) {
  const client = initializeClient();

  logger.debug(`🔄 Generando embeddings para ${texts.length} textos...`);

  try {
    const response = await client.embeddings.create({
      model: EMBEDDING_CONFIG.model,
      input: texts,
      encoding_format: 'float',
    });

    const embeddings = response.data.map(item => item.embedding);

    logger.debug(`✅ Embeddings generados: ${embeddings.length}`);

    return embeddings;
  } catch (error) {
    logger.error(`❌ Error generando embeddings: ${error.message}`);

    // Retry logic con exponential backoff
    if (error.status === 429 || error.status >= 500) {
      logger.warn(`⚠️ Rate limit o error del servidor, reintentando...`);

      for (let attempt = 1; attempt <= EMBEDDING_CONFIG.maxRetries; attempt++) {
        const delay = EMBEDDING_CONFIG.retryDelay * Math.pow(EMBEDDING_CONFIG.retryBackoff, attempt - 1);

        logger.info(`🔄 Reintento ${attempt}/${EMBEDDING_CONFIG.maxRetries} en ${delay}ms...`);

        await sleep(delay);

        try {
          const response = await client.embeddings.create({
            model: EMBEDDING_CONFIG.model,
            input: texts,
          });

          const embeddings = response.data.map(item => item.embedding);

          logger.info(`✅ Embeddings generados en reintento ${attempt}`);

          return embeddings;
        } catch (retryError) {
          logger.warn(`❌ Reintento ${attempt} falló: ${retryError.message}`);

          if (attempt === EMBEDDING_CONFIG.maxRetries) {
            throw new Error(`Fallaron ${EMBEDDING_CONFIG.maxRetries} reintentos: ${retryError.message}`);
          }
        }
      }
    }

    throw error;
  }
}

// ===========================================
// ✅ NUEVO: GENERACIÓN DE EMBEDDINGS LOCALES
// ===========================================

/**
 * Cache para el pipeline de Xenova (singleton)
 */
let xenovaPipeline = null;

/**
 * Genera embeddings locales usando @xenova/transformers
 * Modelo: Xenova/all-MiniLM-L6-v2 (384 dimensiones)
 *
 * @param {Array<string>} texts - Textos para generar embeddings
 * @returns {Promise<Array<number[]>>} Array de embeddings
 */
async function generateEmbeddingsLocal(texts) {
  const { pipeline } = require('@xenova/transformers');

  // Inicializar pipeline solo una vez (lazy loading)
  if (!xenovaPipeline) {
    logger.info('🧠 Inicializando modelo de embeddings local (@xenova/transformers)...');
    logger.info('   Modelo: Xenova/all-MiniLM-L6-v2');
    logger.info('   Dimensiones: 384');

    try {
      xenovaPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        progress_callback: (progress) => {
          if (progress.status === 'downloading') {
            const percentage = progress.progress || 0;
            logger.debug(`   📥 Descargando modelo: ${percentage.toFixed(1)}%`);
          } else if (progress.status === 'loading') {
            logger.debug(`   📦 Cargando modelo en memoria...`);
          }
        }
      });

      logger.info('✅ Modelo de embeddings local inicializado correctamente');
    } catch (error) {
      logger.error('❌ Error inicializando modelo local:', error.message);
      throw new Error(`No se pudo inicializar el modelo de embeddings local: ${error.message}`);
    }
  }

  logger.debug(`🔄 Generando embeddings locales para ${texts.length} textos...`);

  try {
    const embeddings = [];

    // Generar embeddings uno por uno (más estable que batch)
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];

      // Generar embedding usando el pipeline
      const output = await xenovaPipeline(text, {
        pooling: 'mean',
        normalize: true
      });

      // Convertir Tensor a array normal
      const embedding = Array.from(output.data);
      embeddings.push(embedding);

      // Log de progreso cada 10 textos
      if ((i + 1) % 10 === 0 || (i + 1) === texts.length) {
        logger.debug(`   Progreso: ${i + 1}/${texts.length} textos procesados`);
      }
    }

    logger.debug(`✅ Embeddings locales generados: ${embeddings.length}`);
    return embeddings;
  } catch (error) {
    logger.error(`❌ Error generando embeddings locales: ${error.message}`);
    throw error;
  }
}

/**
 * Asegura que todos los chunks tengan embeddings
 * NO regenera si ya existen
 *
 * @param {Array} chunks - Array de chunks { text, embeddingGenerated?, embedding? }
 * @returns {Promise<Array>} Chunks con embeddings
 */
async function ensureEmbeddings(chunks) {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  // Filtrar chunks que necesitan embeddings
  const chunksWithoutEmbeddings = chunks.filter(c => !c.embeddingGenerated && !c.embedding);

  if (chunksWithoutEmbeddings.length === 0) {
    logger.info('✅ Todos los chunks ya tienen embeddings');
    return chunks;
  }

  logger.info(`🔄 Generando embeddings para ${chunksWithoutEmbeddings.length} chunks...`);

  try {
    // ✅ NUEVO: Detectar proveedor a usar
    const provider = detectEmbeddingProvider();
    logger.info(`🤖 Proveedor de embeddings: ${provider.toUpperCase()}`);

    // Tamaño de batch según proveedor
    // OpenAI: más rápido, batches grandes (100)
    // Xenova: más lento, batches pequeños (10)
    const batchSize = provider === 'openai' ? EMBEDDING_CONFIG.batchSize : 10;

    // Procesar en batches
    const batches = chunkArray(chunksWithoutEmbeddings, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      logger.info(`📦 Procesando batch ${i + 1}/${batches.length} (${batch.length} chunks)...`);

      const texts = batch.map(c => c.text || c);

      // ✅ NUEVO: Usar proveedor detectado
      let embeddings;
      if (provider === 'openai') {
        embeddings = await generateEmbeddingsBatch(texts);
      } else {
        embeddings = await generateEmbeddingsLocal(texts);
      }

      // Asignar embeddings a chunks
      batch.forEach((chunk, j) => {
        chunk.embedding = embeddings[j];
        chunk.embeddingGenerated = true;
        chunk.embeddingDate = new Date().toISOString();
        chunk.embeddingProvider = provider; // ✅ NUEVO: Guardar qué proveedor se usó
      });

      // Rate limiting SOLO para OpenAI (Xenova no lo necesita)
      if (provider === 'openai' && i < batches.length - 1) {
        await sleep(200); // 200ms entre batches = 5 batches/segundo = 300/min (seguro)
      }
    }

    logger.info(`✅ Embeddings generados para ${chunksWithoutEmbeddings.length} chunks (proveedor: ${provider})`);

    return chunks;
  } catch (error) {
    logger.error(`❌ Error generando embeddings: ${error.message}`);
    throw error;
  }
}

// ===========================================
// BÚSQUEDA VECTORIAL
// ===========================================

/**
 * Calcula similitud coseno entre dos vectores
 *
 * @param {Array<number>} vecA - Vector A
 * @param {Array<number>} vecB - Vector B
 * @returns {number} Similitud coseno (-1 a 1)
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dotProduct / (magA * magB);
}

/**
 * Busca los chunks más relevantes usando embeddings
 *
 * @param {string} query - Pregunta del usuario
 * @param {number} limit - Cantidad de resultados (default: 15 para re-ranking)
 * @returns {Promise<Array>} Chunks más relevantes con similitud
 */
async function findRelevantChunks(query, limit = 15) {
  try {
    // Asegurar que los chunks estén cargados
    if (!chunksLoaded) {
      logger.warn('⚠️ Chunks no cargados, cargando...');
      await loadAllChunks();
    }

    if (loadedChunks.length === 0) {
      logger.warn('⚠️ No hay chunks cargados para búsqueda');
      return [];
    }

    // Generar embedding de la consulta
    logger.debug(`🔍 Generando embedding para consulta: "${query.substring(0, 50)}..."`);

    // ✅ NUEVO: Detectar proveedor para la consulta también
    const provider = detectEmbeddingProvider();
    let queryEmbeddings;

    if (provider === 'openai') {
      queryEmbeddings = await generateEmbeddingsBatch([query]);
    } else {
      queryEmbeddings = await generateEmbeddingsLocal([query]);
    }

    const queryVector = queryEmbeddings[0];

    // Calcular similitud con todos los chunks (100% local, sin API)
    logger.debug(`📊 Calculando similitud con ${loadedChunks.length} chunks...`);

    const results = loadedChunks
      .filter(chunk => chunk.embedding) // Solo chunks con embedding
      .map(chunk => ({
        ...chunk,
        similarity: cosineSimilarity(queryVector, chunk.embedding),
      }))
      .filter(result => result.similarity > 0) // Solo resultados con similitud positiva
      .sort((a, b) => b.similarity - a.similarity) // Ordenar por similitud descendente
      .slice(0, limit); // Top K

    logger.info(`✅ Encontrados ${results.length} chunks relevantes`);
    logger.debug(`📊 Top 3 similitudes: ${results.slice(0, 3).map(r => r.similarity.toFixed(4)).join(', ')}`);

    return results;
  } catch (error) {
    logger.error(`❌ Error en búsqueda vectorial: ${error.message}`);
    throw error;
  }
}

// ===========================================
// GESTIÓN DE CHUNKS
// ===========================================

/**
 * Carga todos los chunks con embeddings desde archivos JSON
 */
async function loadAllChunks() {
  if (chunksLoaded) {
    logger.debug('✅ Chunks ya están cargados en memoria');
    return loadedChunks;
  }

  logger.info('📂 Cargando chunks con embeddings...');

  const knowledgeUploadService = require('./knowledge-upload.service');
  const files = knowledgeUploadService.getUploadedFiles();

  loadedChunks = [];

  for (const file of files) {
    try {
      const data = await knowledgeUploadService.getFileData(file);

      if (data && data.chunks) {
        // Agregar metadatos del archivo
        const chunksWithMeta = data.chunks.map(chunk => ({
          ...chunk,
          source: file.originalName,
          sourceId: file.id,
        }));

        loadedChunks.push(...chunksWithMeta);
      }
    } catch (error) {
      logger.warn(`⚠️ Error cargando datos de ${file.originalName}: ${error.message}`);
    }
  }

  // Filtrar solo chunks con embeddings
  const chunksWithEmbeddings = loadedChunks.filter(c => c.embedding && c.embedding.length > 0);
  const chunksWithoutEmbeddings = loadedChunks.length - chunksWithEmbeddings.length;

  logger.info(`📊 Chunks cargados: ${loadedChunks.length}`);
  logger.info(`   ✅ Con embeddings: ${chunksWithEmbeddings.length}`);
  logger.info(`   ❌ Sin embeddings: ${chunksWithoutEmbeddings}`);

  chunksLoaded = true;

  return loadedChunks;
}

/**
 * Recarga los chunks desde archivos
 */
function reloadChunks() {
  logger.info('🔄 Recargando chunks...');
  chunksLoaded = false;
  embeddingCache.clear();
  loadedChunks = [];
  return loadAllChunks();
}

/**
 * Obtiene estadísticas de embeddings
 */
function getEmbeddingStats() {
  const chunksWithEmbeddings = loadedChunks.filter(c => c.embedding && c.embedding.length > 0);
  const chunksWithoutEmbeddings = loadedChunks.length - chunksWithEmbeddings.length;

  return {
    totalChunks: loadedChunks.length,
    withEmbeddings: chunksWithEmbeddings.length,
    withoutEmbeddings: chunksWithoutEmbeddings,
    loaded: chunksLoaded,
    embeddingDimension: chunksWithEmbeddings.length > 0 ? chunksWithEmbeddings[0].embedding.length : 0,
  };
}

// ===========================================
// UTILIDADES
// ===========================================

/**
 * Divide un array en chunks de tamaño específico
 */
function chunkArray(array, size) {
  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
}

/**
 * Sleep con promesas
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===========================================
// EXPORTS
// ===========================================

module.exports = {
  // Generación
  generateEmbeddingsBatch,
  ensureEmbeddings,

  // Búsqueda
  findRelevantChunks,
  cosineSimilarity,

  // Gestión de chunks
  loadAllChunks,
  reloadChunks,
  getEmbeddingStats,

  // Configuración
  EMBEDDING_CONFIG,
};
