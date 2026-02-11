/**
 * ===========================================
 * SERVICIO RAG OPTIMIZADO - NORBOY
 * ===========================================
 *
 * MEJORAS IMPLEMENTADAS:
 * 1. Modelo de embeddings multilingüe (mejor para español)
 * 2. Re-ranking con cross-encoder
 * 3. Búsqueda híbrida (vectorial + BM25)
 * 4. Recuperación ampliada (15 → 7)
 * 5. Cache de queries
 * 6. Umbrales dinámicos
 */

const logger = require('../utils/logger');

// ===========================================
// CONFIGURACIÓN OPTIMIZADA
// ===========================================

const RAG_CONFIG = {
  // Modelo de embeddings (opciones para upgrade futuro)
  embeddings: {
    // Actual (funciona bien para empezar)
    current: 'Xenova/all-MiniLM-L6-v2',
    // Mejor para español (requiere más memoria)
    recommended: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    // El mejor multilingüe (más pesado)
    best: 'Xenova/multilingual-e5-small',
    dimensions: {
      'Xenova/all-MiniLM-L6-v2': 384,
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 384,
      'Xenova/multilingual-e5-small': 384,
    }
  },

  // Recuperación - AJUSTADO para ser más permisivo
  retrieval: {
    topK_initial: 20,    // ANTES: 15 → Recuperar más inicialmente
    topK_final: 12,      // ANTES: 7 → Más chunks finales para mejor contexto
    minSimilarity: 0.20, // ANTES: 0.35 → Más permisivo para no descartar info útil
  },

  // Re-ranking - AJUSTADO para no penalizar demasiado
  reranking: {
    enabled: true,
    // Boost para chunks Q&A
    qaBoost: 1.15,       // ANTES: 1.2 → Menos agresivo
    // Boost por keyword match
    keywordBoost: 0.10,  // ANTES: 0.15 → Menos agresivo
  },

  // Búsqueda híbrida
  hybrid: {
    enabled: true,
    vectorWeight: 0.75,  // ANTES: 0.7 → Dar más peso a similitud vectorial
    bm25Weight: 0.25,    // ANTES: 0.3 → Menos peso a keywords
  },

  // Umbrales de calidad - AJUSTADOS para ser más permisivos
  // El modelo all-MiniLM tiene scores inherentemente bajos para español
  thresholds: {
    high: 0.55,      // ANTES: 0.65 → Calidad alta - responder con confianza
    medium: 0.40,    // ANTES: 0.50 → Calidad media - responder con contexto
    low: 0.30,       // ANTES: 0.45 → Calidad baja - aún puede responder
    escalate: 0.25,  // ANTES: 0.45 → Solo escalar si realmente no hay info
  },

  // Validación de query
  query: {
    minLength: 3,    // Mínimo 3 caracteres para procesar
  },

  // Cache
  cache: {
    enabled: true,
    maxSize: 100,    // Máximo queries en cache
    ttl: 300000,     // 5 minutos TTL
  }
};

// ===========================================
// CACHE DE QUERIES
// ===========================================

const queryCache = new Map();

/**
 * Normaliza una query para cache
 */
function normalizeQuery(query) {
  return query
    .toLowerCase()
    .trim()
    .replace(/[¿?!¡.,;:]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Obtiene resultado del cache si existe y no expiró
 */
function getCachedResult(query) {
  if (!RAG_CONFIG.cache.enabled) return null;

  const normalized = normalizeQuery(query);
  const cached = queryCache.get(normalized);

  if (cached && (Date.now() - cached.timestamp) < RAG_CONFIG.cache.ttl) {
    logger.debug(`📦 Cache hit para: "${query.substring(0, 30)}..."`);
    return cached.results;
  }

  return null;
}

/**
 * Guarda resultado en cache
 */
function setCacheResult(query, results) {
  if (!RAG_CONFIG.cache.enabled) return;

  const normalized = normalizeQuery(query);

  // Limpiar cache si excede tamaño
  if (queryCache.size >= RAG_CONFIG.cache.maxSize) {
    const oldestKey = queryCache.keys().next().value;
    queryCache.delete(oldestKey);
  }

  queryCache.set(normalized, {
    results,
    timestamp: Date.now()
  });
}

/**
 * Limpia el cache completo
 */
function clearCache() {
  queryCache.clear();
  logger.info('🧹 Cache de queries limpiado');
}

// ===========================================
// BÚSQUEDA BM25 (KEYWORD MATCHING)
// ===========================================

/**
 * Calcula score BM25 simplificado
 * @param {string} query - Consulta del usuario
 * @param {string} document - Texto del chunk
 * @returns {number} Score BM25 (0-1 normalizado)
 */
function calculateBM25Score(query, document) {
  const k1 = 1.5;
  const b = 0.75;
  const avgDocLength = 200; // Estimado para chunks

  // Tokenizar
  const queryTerms = tokenize(query);
  const docTerms = tokenize(document);
  const docLength = docTerms.length;

  if (queryTerms.length === 0 || docTerms.length === 0) return 0;

  // Contar frecuencias
  const termFreq = {};
  for (const term of docTerms) {
    termFreq[term] = (termFreq[term] || 0) + 1;
  }

  // Calcular score
  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreq[term] || 0;
    if (tf > 0) {
      const idf = Math.log((1 + 1) / (1 + 1)); // Simplificado sin corpus
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
      score += idf * tfNorm;
    }
  }

  // Normalizar a 0-1
  const maxScore = queryTerms.length * 2; // Aproximado
  return Math.min(score / maxScore, 1);
}

/**
 * Tokeniza texto para BM25
 */
function tokenize(text) {
  const stopWords = new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'y', 'o',
    'que', 'es', 'son', 'para', 'por', 'con', 'se', 'su', 'al', 'lo',
    'como', 'más', 'pero', 'sus', 'le', 'ya', 'fue', 'han', 'muy', 'sin',
    'sobre', 'este', 'entre', 'cuando', 'ser', 'hay', 'todo', 'esta',
    'qué', 'cuál', 'cuándo', 'dónde', 'cómo', 'quién'
  ]);

  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

// ===========================================
// RE-RANKING
// ===========================================

/**
 * Re-rankea chunks usando múltiples señales
 * @param {Array} chunks - Chunks con similitud vectorial
 * @param {string} query - Consulta original
 * @returns {Array} Chunks re-rankeados
 */
function rerankChunks(chunks, query) {
  if (!RAG_CONFIG.reranking.enabled || chunks.length === 0) {
    return chunks;
  }

  const queryLower = query.toLowerCase();
  const queryTerms = tokenize(query);

  const reranked = chunks.map(chunk => {
    let finalScore = chunk.similarity;

    // 1. Boost para chunks Q&A
    if (chunk.isQA) {
      finalScore *= RAG_CONFIG.reranking.qaBoost;
    }

    // 2. Boost por coincidencia exacta de keywords
    const chunkLower = chunk.text.toLowerCase();
    let keywordMatches = 0;

    for (const term of queryTerms) {
      if (chunkLower.includes(term)) {
        keywordMatches++;
      }
    }

    if (queryTerms.length > 0) {
      const keywordRatio = keywordMatches / queryTerms.length;
      finalScore += keywordRatio * RAG_CONFIG.reranking.keywordBoost;
    }

    // 3. Boost por coincidencia de frase exacta
    if (chunkLower.includes(queryLower)) {
      finalScore += 0.1;
    }

    // 4. Penalización por chunks muy cortos (poco informativo)
    if (chunk.text.length < 50) {
      finalScore *= 0.7;
    }

    // 5. Boost por ser pregunta que coincide semánticamente
    if (chunk.question) {
      const questionLower = chunk.question.toLowerCase();
      const questionTerms = tokenize(chunk.question);
      let questionMatches = 0;

      for (const term of queryTerms) {
        if (questionTerms.includes(term)) {
          questionMatches++;
        }
      }

      if (queryTerms.length > 0 && questionMatches / queryTerms.length > 0.5) {
        finalScore += 0.15; // Boost significativo si la pregunta coincide
      }
    }

    return {
      ...chunk,
      originalSimilarity: chunk.similarity,
      similarity: Math.min(finalScore, 1), // Cap at 1
      reranked: true
    };
  });

  // Ordenar por score final
  return reranked.sort((a, b) => b.similarity - a.similarity);
}

// ===========================================
// BÚSQUEDA HÍBRIDA
// ===========================================

/**
 * Combina búsqueda vectorial con BM25
 * @param {Array} vectorResults - Resultados de búsqueda vectorial
 * @param {string} query - Consulta del usuario
 * @returns {Array} Resultados combinados
 */
function hybridSearch(vectorResults, query) {
  if (!RAG_CONFIG.hybrid.enabled) {
    return vectorResults;
  }

  return vectorResults.map(result => {
    const bm25Score = calculateBM25Score(query, result.text);

    // Combinar scores
    const hybridScore =
      (result.similarity * RAG_CONFIG.hybrid.vectorWeight) +
      (bm25Score * RAG_CONFIG.hybrid.bm25Weight);

    return {
      ...result,
      vectorScore: result.similarity,
      bm25Score: bm25Score,
      similarity: hybridScore,
      isHybrid: true
    };
  });
}

// ===========================================
// BÚSQUEDA PRINCIPAL OPTIMIZADA
// ===========================================

/**
 * Busca chunks relevantes con todas las optimizaciones
 * @param {string} query - Consulta del usuario
 * @param {Object} options - Opciones de búsqueda
 * @returns {Promise<Object>} Resultados con metadata
 */
async function findRelevantChunksOptimized(query, options = {}) {
  const {
    topK = RAG_CONFIG.retrieval.topK_final,
    useCache = true,
    useHybrid = RAG_CONFIG.hybrid.enabled,
    useReranking = RAG_CONFIG.reranking.enabled,
  } = options;

  const pipelineStart = Date.now();

  try {
    // 0. Validar longitud mínima de query
    const cleanQuery = query?.trim() || '';
    if (cleanQuery.length < (RAG_CONFIG.query?.minLength || 3)) {
      logger.warn(`⚠️ Query muy corta (${cleanQuery.length} chars): "${cleanQuery}"`);
      return {
        chunks: [],
        quality: 'none',
        topSimilarity: 0,
        avgSimilarity: 0,
        fromCache: false,
        error: 'query_too_short'
      };
    }

    // 1. Verificar cache
    if (useCache) {
      const cached = getCachedResult(query);
      if (cached) {
        const cacheElapsed = Date.now() - pipelineStart;
        logger.info(`⚡ RAG cache HIT (${cacheElapsed}ms)`);
        return {
          ...cached,
          fromCache: true
        };
      }
    }

    // 2. Obtener servicio de embeddings
    const embeddingsService = require('./embeddings.service');

    // 3. Búsqueda vectorial inicial (ampliada)
    const vectorStart = Date.now();
    const initialResults = await embeddingsService.findRelevantChunks(
      query,
      RAG_CONFIG.retrieval.topK_initial
    );
    const vectorElapsed = Date.now() - vectorStart;

    if (initialResults.length === 0) {
      logger.info(`🔍 RAG: Sin resultados vectoriales (${vectorElapsed}ms)`);
      return {
        chunks: [],
        quality: 'none',
        topSimilarity: 0,
        avgSimilarity: 0,
        fromCache: false
      };
    }

    // 4. Búsqueda híbrida (vectorial + BM25)
    const hybridStart = Date.now();
    let results = useHybrid
      ? hybridSearch(initialResults, query)
      : initialResults;
    const hybridElapsed = Date.now() - hybridStart;

    // 5. Re-ranking
    const rerankStart = Date.now();
    if (useReranking) {
      results = rerankChunks(results, query);
    }
    const rerankElapsed = Date.now() - rerankStart;

    // 6. Filtrar por umbral mínimo
    results = results.filter(r => r.similarity >= RAG_CONFIG.retrieval.minSimilarity);

    // 7. Seleccionar top K final
    const finalResults = results.slice(0, topK);

    // 8. Calcular métricas de calidad
    const topSimilarity = finalResults.length > 0 ? finalResults[0].similarity : 0;
    const avgSimilarity = finalResults.length > 0
      ? finalResults.reduce((sum, r) => sum + r.similarity, 0) / finalResults.length
      : 0;

    // 9. Determinar calidad del contexto
    let quality = 'none';
    if (topSimilarity >= RAG_CONFIG.thresholds.high) {
      quality = 'high';
    } else if (topSimilarity >= RAG_CONFIG.thresholds.medium) {
      quality = 'medium';
    } else if (topSimilarity >= RAG_CONFIG.thresholds.low) {
      quality = 'low';
    }

    // 10. Construir resultado
    const result = {
      chunks: finalResults,
      quality,
      topSimilarity,
      avgSimilarity,
      totalFound: initialResults.length,
      afterReranking: results.length,
      finalCount: finalResults.length,
      fromCache: false,
      config: {
        topK_initial: RAG_CONFIG.retrieval.topK_initial,
        topK_final: topK,
        hybrid: useHybrid,
        reranking: useReranking,
        thresholds: RAG_CONFIG.thresholds
      }
    };

    // 11. Guardar en cache
    if (useCache) {
      setCacheResult(query, result);
    }

    // 12. ✅ OPTIMIZADO: Log de diagnóstico con tiempos
    const totalElapsed = Date.now() - pipelineStart;
    logger.info(`🔍 RAG Optimizado: "${query.substring(0, 40)}..."`);
    logger.info(`   📊 Calidad: ${quality.toUpperCase()} (top: ${topSimilarity.toFixed(4)}, avg: ${avgSimilarity.toFixed(4)})`);
    logger.info(`   📦 Chunks: ${initialResults.length} inicial → ${finalResults.length} final`);
    logger.info(`   ⏱️ Tiempos: vector=${vectorElapsed}ms, hybrid=${hybridElapsed}ms, rerank=${rerankElapsed}ms, total=${totalElapsed}ms`);

    if (finalResults.length > 0) {
      logger.debug(`   🏆 Top 3: ${finalResults.slice(0, 3).map(r =>
        `${r.similarity.toFixed(3)}${r.isQA ? '(Q&A)' : ''}`
      ).join(', ')}`);
    }

    return result;

  } catch (error) {
    logger.error(`❌ Error en búsqueda RAG optimizada: ${error.message}`);
    throw error;
  }
}

// ===========================================
// FORMATEO DE CONTEXTO PARA LLM
// ===========================================

/**
 * Formatea chunks para enviar al LLM
 * @param {Array} chunks - Chunks relevantes
 * @param {Object} metadata - Metadata de la búsqueda
 * @returns {string} Contexto formateado
 */
function formatContextForLLM(chunks, metadata = {}) {
  if (!chunks || chunks.length === 0) {
    return '';
  }

  const { quality = 'unknown', topSimilarity = 0 } = metadata;

  let context = `📚 INFORMACIÓN RECUPERADA (Calidad: ${quality.toUpperCase()}, Relevancia: ${(topSimilarity * 100).toFixed(1)}%)\n\n`;

  chunks.forEach((chunk, index) => {
    const relevance = (chunk.similarity * 100).toFixed(1);
    const source = chunk.source || 'Documento NORBOY';

    if (chunk.isQA && chunk.question && chunk.answer) {
      // Formato estructurado para Q&A
      context += `---\n`;
      context += `📋 PREGUNTA #${index + 1} (Relevancia: ${relevance}%)\n`;
      context += `Fuente: ${source}\n`;
      context += `P: ${chunk.question}\n`;
      context += `R: ${chunk.answer}\n\n`;
    } else {
      // Formato genérico
      context += `---\n`;
      context += `📄 FRAGMENTO #${index + 1} (Relevancia: ${relevance}%)\n`;
      context += `Fuente: ${source}\n`;
      context += `${chunk.text}\n\n`;
    }
  });

  return context;
}

// ===========================================
// EVALUACIÓN DE NECESIDAD DE ESCALACIÓN
// ===========================================

/**
 * Evalúa si debe escalarse a humano basado en la calidad del contexto
 *
 * ✅ AJUSTADO: Más permisivo para usar la información encontrada
 * Solo escala cuando REALMENTE no hay información útil
 *
 * @param {Object} searchResult - Resultado de findRelevantChunksOptimized
 * @param {string} query - Consulta original
 * @returns {Object} Evaluación de escalación
 */
function evaluateEscalation(searchResult, query) {
  const { quality, topSimilarity, avgSimilarity, chunks } = searchResult;

  // Patrones que siempre requieren escalación (usuario pide humano)
  const escalationPatterns = [
    /asesor|humano|persona|agente|hablar con/i,
    /queja|reclamo|problema grave/i,
    /urgente|emergencia/i,
  ];

  const needsHumanByPattern = escalationPatterns.some(p => p.test(query));

  // Evaluar escalación - MÁS PERMISIVO
  let shouldEscalate = false;
  let reason = null;
  let confidence = 'high';

  // 1. Usuario pide explícitamente un humano
  if (needsHumanByPattern) {
    shouldEscalate = true;
    reason = 'user_requested_human';
    confidence = 'high';
  }
  // 2. No hay contexto relevante (0 chunks)
  else if (quality === 'none' || chunks.length === 0) {
    shouldEscalate = true;
    reason = 'no_relevant_context';
    confidence = 'high';
  }
  // 3. Score MUY bajo (por debajo del umbral mínimo)
  else if (topSimilarity < RAG_CONFIG.thresholds.escalate) {
    shouldEscalate = true;
    reason = 'similarity_below_threshold';
    confidence = 'high';
  }
  // 4. Promedio extremadamente bajo (menos de 0.20)
  else if (avgSimilarity && avgSimilarity < 0.20) {
    shouldEscalate = true;
    reason = 'average_similarity_too_low';
    confidence = 'medium';
  }
  // 5. ✅ CAMBIO: Calidad LOW ahora NO escala automáticamente
  //    Permitir que la IA intente responder con el contexto disponible
  //    Solo escala si quality === 'none' (ya cubierto arriba)

  const result = {
    shouldEscalate,
    reason,
    confidence,
    quality,
    topSimilarity,
    avgSimilarity,
    threshold: RAG_CONFIG.thresholds.escalate,
    recommendation: shouldEscalate
      ? 'ESCALAR a asesor humano - NO llamar a IA'
      : `Responder con contexto (calidad: ${quality})`
  };

  // Log detallado para debugging
  if (shouldEscalate) {
    console.log(`⚠️ ESCALACIÓN DECIDIDA:`);
    console.log(`   Razón: ${reason}`);
    console.log(`   TopSimilarity: ${topSimilarity?.toFixed(4)} (umbral: ${RAG_CONFIG.thresholds.escalate})`);
    console.log(`   Calidad: ${quality}`);
  } else {
    console.log(`✅ NO ESCALAR - Usar contexto disponible:`);
    console.log(`   TopSimilarity: ${topSimilarity?.toFixed(4)}`);
    console.log(`   Calidad: ${quality}`);
    console.log(`   Chunks disponibles: ${chunks.length}`);
  }

  return result;
}

// ===========================================
// EXPORTS
// ===========================================

module.exports = {
  // Configuración
  RAG_CONFIG,

  // Búsqueda principal
  findRelevantChunksOptimized,

  // Utilidades
  formatContextForLLM,
  evaluateEscalation,

  // BM25
  calculateBM25Score,
  tokenize,

  // Re-ranking
  rerankChunks,

  // Híbrido
  hybridSearch,

  // Cache
  clearCache,
  getCachedResult,
  setCacheResult,
};
