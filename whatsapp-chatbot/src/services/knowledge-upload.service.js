/**
 * ===========================================
 * SERVICIO DE CARGA DE CONOCIMIENTO
 * ===========================================
 *
 * Permite subir archivos (PDF, TXT) para alimentar
 * la base de conocimiento del chatbot.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Directorio donde se guardan los archivos de conocimiento
const KNOWLEDGE_DIR = path.join(process.cwd(), 'knowledge_files');
const KNOWLEDGE_INDEX = path.join(KNOWLEDGE_DIR, 'index.json');

// Crear directorio si no existe
if (!fs.existsSync(KNOWLEDGE_DIR)) {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

// Índice de archivos cargados
let knowledgeIndex = loadIndex();

// ✅ OPTIMIZADO: Cache en memoria de datos de archivos procesados
// Evita leer y parsear JSON del disco en cada búsqueda
// Estructura: { fileId: { data, timestamp } }
const fileDataCache = new Map();

/**
 * Carga el índice de archivos
 */
function loadIndex() {
  try {
    if (fs.existsSync(KNOWLEDGE_INDEX)) {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX, 'utf8'));
    }
  } catch (error) {
    logger.warn('Error cargando índice de conocimiento:', error.message);
  }
  return { files: [], lastUpdate: null };
}

/**
 * Guarda el índice de archivos
 */
function saveIndex() {
  try {
    knowledgeIndex.lastUpdate = new Date().toISOString();
    fs.writeFileSync(KNOWLEDGE_INDEX, JSON.stringify(knowledgeIndex, null, 2));
  } catch (error) {
    logger.error('Error guardando índice:', error.message);
  }
}

/**
 * Procesa un archivo TXT
 *
 * ✅ OPTIMIZADO: No se guarda el campo 'content' completo
 * porque es redundante con los chunks y aumenta el tamaño del JSON innecesariamente.
 * El contenido original siempre puede reconstruirse desde el archivo TXT original.
 */
async function processTxtFile(filePath, originalName) {
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    type: 'txt',
    name: originalName,
    // content: content,  // ❌ ELIMINADO: Redundante con chunks
    chunks: extractChunks(content),
    uploadDate: new Date().toISOString()
  };
}

/**
 * Procesa un archivo PDF
 *
 * ✅ OPTIMIZADO: No se guarda el campo 'content' completo
 * porque es redundante con los chunks y aumenta el tamaño del JSON innecesariamente.
 */
async function processPdfFile(filePath, originalName) {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);

    return {
      type: 'pdf',
      name: originalName,
      // content: data.text,  // ❌ ELIMINADO: Redundante con chunks
      pages: data.numpages,
      chunks: extractChunks(data.text),
      uploadDate: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Error procesando PDF:', error.message);
    throw new Error('No se pudo procesar el archivo PDF');
  }
}

/**
 * ✅ NUEVO: Detecta si el texto tiene formato Q&A con emojis (1️⃣, 2️⃣, etc.)
 */
function hasEmojiQAFormat(text) {
  // Buscar patrones como: 1️⃣ ¿Pregunta? o 1. ¿Pregunta?
  return /[\d]+️⃣\s*[¿\?]/.test(text) || /[\d]+\.\s*[¿\?]/.test(text);
}

/**
 * ✅ NUEVO: Parsea formato Q&A con emojis
 * Formato: 1️⃣ ¿Pregunta?\n\nRespuesta:\n\nTexto
 */
function parseEmojiQAFormat(text) {
  const chunks = [];

  // Normalizar line endings (Windows \r\n → \n)
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Normalizar múltiples espacios a un solo espacio
  const cleaned = normalized.replace(/[ \t]+/g, ' ').trim();

  // Extraer preguntas usando un approach línea por línea
  const lines = cleaned.split('\n');
  let currentQuestion = null;
  let currentAnswer = null;
  let qaCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detectar línea de pregunta (empieza con número + ¿)
    const questionMatch = line.match(/^\d+[^\w\s]*\s*[¿\?](.+)$/);
    if (questionMatch) {
      // Guardar Q&A anterior si existe
      if (currentQuestion && currentAnswer) {
        const cleanedAnswer = currentAnswer
          .replace(/\s*Estamos para servirle\.\s*$/gi, '')
          .trim();

        if (cleanedAnswer) {
          chunks.push({
            text: `Pregunta: ${currentQuestion}\nRespuesta: ${cleanedAnswer}`,
            keywords: extractKeywords(currentQuestion + ' ' + cleanedAnswer),
            isQA: true,
            question: currentQuestion,
            answer: cleanedAnswer
          });
          qaCount++;
        }
      }

      currentQuestion = questionMatch[1].trim();
      currentAnswer = null;
      continue;
    }

    // Detectar línea "Respuesta:"
    if (line.toLowerCase() === 'respuesta:') {
      continue; // Solo es un marcador, la respuesta viene después
    }

    // Si ya hay pregunta y la línea tiene contenido, es parte de la respuesta
    if (currentQuestion && line && !line.match(/^\d+[^\w\s]*\s*[¿\?]/)) {
      if (currentAnswer) {
        currentAnswer += ' ' + line;
      } else {
        currentAnswer = line;
      }
    }
  }

  // Guardar último Q&A
  if (currentQuestion && currentAnswer) {
    const cleanedAnswer = currentAnswer
      .replace(/\s*Estamos para servirle\.\s*$/gi, '')
      .trim();

    if (cleanedAnswer) {
      chunks.push({
        text: `Pregunta: ${currentQuestion}\nRespuesta: ${cleanedAnswer}`,
        keywords: extractKeywords(currentQuestion + ' ' + cleanedAnswer),
        isQA: true,
        question: currentQuestion,
        answer: cleanedAnswer
      });
      qaCount++;
    }
  }

  logger.info(`✅ Parseados ${qaCount} pares Q&A con formato emoji`);
  return chunks;
}

/**
 * Extrae chunks de texto para búsqueda
 *
 * ✅ MEJORADO: Limpieza mejor de caracteres especiales y formato
 * ✅ NUEVO: Soporte para formato Q&A con emojis
 */
function extractChunks(text) {
  // ✅ CRÍTICO: Normalizar line endings ANTES de cualquier procesamiento
  const normalizedLineEndings = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Limpiar caracteres problemáticos del PDF antes de procesar
  const cleanedText = cleanPdfText(normalizedLineEndings);

  // ✅ NUEVO: Detectar y procesar formato Q&A con emojis
  if (hasEmojiQAFormat(cleanedText)) {
    logger.info('🎯 Detectado formato Q&A con emojis, usando parser especializado');
    const qaChunks = parseEmojiQAFormat(cleanedText);

    if (qaChunks.length > 0) {
      logger.info(`📄 Extraídos ${qaChunks.length} chunks Q&A del texto`);
      return qaChunks;
    }
  }

  // Si no es formato Q&A con emojis, usar el método anterior
  const chunks = [];

  // Dividir por párrafos o secciones (ahora con \n normalizado)
  const paragraphs = cleanedText.split(/\n\n+/).filter(p => p.trim().length > 50);

  for (const para of paragraphs) {
    // Limpiar el texto (normalizar espacios)
    const normalized = para.trim().replace(/\s+/g, ' ');

    if (normalized.length > 0) {
      chunks.push({
        text: normalized,
        keywords: extractKeywords(normalized)
      });
    }
  }

  // También buscar patrones de pregunta-respuesta (formato antiguo)
  const qaPattern = /(?:pregunta|p)[:\s]*(.+?)(?:respuesta|r)[:\s]*(.+?)(?=(?:pregunta|p)[:\s]|$)/gis;
  let match;

  while ((match = qaPattern.exec(cleanedText)) !== null) {
    chunks.push({
      text: `Pregunta: ${match[1].trim()}\nRespuesta: ${match[2].trim()}`,
      keywords: extractKeywords(match[1] + ' ' + match[2]),
      isQA: true
    });
  }

  logger.info(`📄 Extraídos ${chunks.length} chunks del texto`);
  return chunks;
}

/**
 * ✅ NUEVO: Limpia caracteres problemáticos de PDFs
 *
 * Los PDFs extraídos con pdf-parse a veces tienen caracteres
 * codificados incorrectamente. Esta función los normaliza.
 *
 * ⚠️ IMPORTANTE: NO eliminar saltos de línea, son necesarios
 * para detectar la estructura Q&A.
 */
function cleanPdfText(text) {
  // Reemplazos comunes de caracteres mal codificados
  const replacements = [
    // Caracteres acentuados comunes mal codificados
    [/ǭ/g, 'ó'],
    [/ǧ/g, 'í'],
    [/ǯ/g, 'ú'],
    [/ń/g, 'ñ'],
    [/š/g, 'á'],
    [/ě/g, 'é'],
    [/č/g, 'í'],

    // Caracteres de reemplazo
    [/'/g, 'ó'],
    [/%/g, 'ó'],
    [/‚/g, ''],
    [/'/g, ''],
    [/"/g, '"'],
    [/"/g, '"'],
    [/–/g, '-'],
    [/—/g, '-']
  ];

  let cleaned = text;

  for (const [pattern, replacement] of replacements) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  // ✅ CORREGIDO: Solo normalizar espacios en línea, NO saltos de línea
  // Dividir por líneas, limpiar cada línea, y volver a unir
  const lines = cleaned.split('\n');
  const cleanedLines = lines.map(line => {
    // Normalizar espacios y tabs DENTRO de cada línea
    return line.replace(/[ \t]+/g, ' ').trim();
  });

  cleaned = cleanedLines.join('\n').trim();

  logger.debug(`🧹 Texto limpio: ${text.substring(0, 50)}... → ${cleaned.substring(0, 50)}...`);

  return cleaned;
}

/**
 * Extrae palabras clave de un texto
 */
function extractKeywords(text) {
  const stopWords = ['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'y', 'o', 'que', 'es', 'son', 'para', 'por', 'con', 'se', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'fue', 'han', 'muy', 'sin', 'sobre', 'este', 'entre', 'cuando', 'ser', 'hay', 'todo', 'esta', 'desde', 'nos', 'durante', 'uno', 'ni', 'contra', 'otros', 'ese', 'eso', 'ante', 'ella', 'dos', 'tan', 'poco', 'estos', 'parte'];

  const words = text.toLowerCase()
    .replace(/[^\wáéíóúüñ\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.includes(w));

  // Eliminar duplicados y retornar
  return [...new Set(words)];
}

/**
 * Sube y procesa un archivo
 * ✅ MEJORADO: Ahora acepta stageId para asociar a una etapa y guarda en carpetas
 */
async function uploadFile(file, stageId = null) {
  const ext = path.extname(file.originalname).toLowerCase();
  const fileName = `${Date.now()}_${file.originalname}`;

  // ✅ NUEVO: Determinar directorio de destino
  let targetDir = KNOWLEDGE_DIR;

  // ✅ CORREGIDO: Si hay stageId, usar la carpeta de la etapa
  // ⚠️ IMPORTANTE: NO asignar etapa por defecto - el documento debe asociarse
  // ÚNICAMENTE a la etapa que el usuario seleccionó en el frontend
  if (stageId) {
    try {
      const stagesService = require('./stages.service');
      targetDir = stagesService.getStageFolder(stageId);
      logger.info(`📁 Usando carpeta de etapa: ${targetDir} (stageId: ${stageId})`);
    } catch (e) {
      logger.warn('No se pudo obtener carpeta de etapa, usando directorio general:', e.message);
      targetDir = KNOWLEDGE_DIR;
    }
  } else {
    // ⚠️ CORREGIDO: Si no se proporciona stageId, NO asignar etapa por defecto
    // Guardar en la carpeta raíz sin asociación a etapa específica
    logger.warn('⚠️ No se proporcionó stageId - el documento se guardará sin asociación a etapa');
    logger.warn('   El frontend debe enviar siempre el stageId de la etapa activa');
  }

  const filePath = path.join(targetDir, fileName);

  // Guardar archivo
  fs.writeFileSync(filePath, file.buffer);

  let processedData;

  if (ext === '.txt') {
    processedData = await processTxtFile(filePath, file.originalname);
  } else if (ext === '.pdf') {
    processedData = await processPdfFile(filePath, file.originalname);
  } else {
    fs.unlinkSync(filePath);
    throw new Error('Tipo de archivo no soportado. Use PDF o TXT.');
  }

  // ✅ NUEVO: Guardar ruta relativa desde knowledge_files
  const relativePath = path.relative(KNOWLEDGE_DIR, filePath).replace(/\\/g, '/');

  // Agregar al índice
  const fileEntry = {
    id: Date.now().toString(),
    fileName: fileName,
    originalName: file.originalname,
    type: ext.replace('.', ''),
    size: file.size,
    chunksCount: processedData.chunks.length,
    uploadDate: processedData.uploadDate,
    // ✅ NUEVO: Asociación con etapa y ruta relativa
    stageId: stageId || null,
    relativePath: relativePath // Ruta relativa desde knowledge_files
  };

  knowledgeIndex.files.push(fileEntry);
  saveIndex();

  // ✅ NUEVO: Generar embeddings para los chunks (si no tienen)
  try {
    const embeddingsService = require('./embeddings.service');
    const chunksWithEmbeddings = await embeddingsService.ensureEmbeddings(processedData.chunks);

    // Actualizar datos procesados con embeddings
    processedData.chunks = chunksWithEmbeddings;

    logger.info(`🧠 Embeddings generados para ${chunksWithEmbeddings.length} chunks`);
  } catch (error) {
    logger.warn(`⚠️ No se pudieron generar embeddings: ${error.message}`);
    logger.warn(`   El archivo se guardará sin embeddings (se generarán en la primera búsqueda)`);
  }

  // Guardar datos procesados en la misma carpeta
  const dataPath = path.join(targetDir, `${fileEntry.id}_data.json`);
  fs.writeFileSync(dataPath, JSON.stringify(processedData, null, 2));

  logger.info(`Archivo cargado: ${file.originalname} (${processedData.chunks.length} chunks) [Etapa: ${stageId || 'Sin asignar'}] [Ruta: ${relativePath}]`);

  // ✅ NUEVO: Invalidar caché de embeddings para que se recargue
  try {
    const embeddingsService = require('./embeddings.service');
    embeddingsService.reloadChunks();
  } catch (e) {
    // Ignorar error si el servicio no está inicializado
  }

  // ✅ OPTIMIZADO: Invalidar cache de datos de archivo
  fileDataCache.delete(fileEntry.id);

  return fileEntry;
}

/**
 * Obtiene la lista de archivos cargados
 */
function getUploadedFiles() {
  return knowledgeIndex.files;
}

/**
 * ✅ NUEVO: Obtiene archivos filtrados por etapa
 */
function getFilesByStage(stageId) {
  if (!stageId) {
    return knowledgeIndex.files;
  }
  return knowledgeIndex.files.filter(f => f.stageId === stageId);
}

/**
 * Elimina un archivo
 * ✅ MEJORADO: Soporta archivos en subcarpetas de etapas
 */
function deleteFile(fileId) {
  const fileIndex = knowledgeIndex.files.findIndex(f => f.id === fileId);

  if (fileIndex === -1) {
    throw new Error('Archivo no encontrado');
  }

  const file = knowledgeIndex.files[fileIndex];

  // ✅ MEJORADO: Determinar rutas de los archivos físicos
  let filePath, dataPath;

  if (file.relativePath) {
    // Usar ruta relativa
    filePath = path.join(KNOWLEDGE_DIR, file.relativePath);
    dataPath = path.join(KNOWLEDGE_DIR, path.dirname(file.relativePath), `${file.id}_data.json`);
  } else {
    // Compatibilidad con archivos antiguos
    filePath = path.join(KNOWLEDGE_DIR, file.fileName);

    // Si no existe y tiene stageId, buscar en carpeta de etapa
    if (!fs.existsSync(filePath) && file.stageId) {
      const stagesService = require('./stages.service');
      const stageFolder = stagesService.getStageFolder(file.stageId);
      filePath = path.join(stageFolder, file.fileName);
      dataPath = path.join(stageFolder, `${file.id}_data.json`);
    } else {
      dataPath = path.join(KNOWLEDGE_DIR, `${file.id}_data.json`);
    }
  }

  // Eliminar archivos físicos
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);

  // Eliminar del índice
  knowledgeIndex.files.splice(fileIndex, 1);
  saveIndex();

  // ✅ OPTIMIZADO: Invalidar cache de datos de archivo
  fileDataCache.delete(file.id);

  logger.info(`Archivo eliminado: ${file.originalName}`);
  return true;
}

/**
 * ✅ OPTIMIZADO: Obtiene datos de archivo desde cache o disco
 * @param {string} fileId - ID del archivo
 * @param {string} dataPath - Ruta al archivo JSON en disco
 * @returns {Object|null} Datos parseados
 */
function getCachedFileData(fileId, dataPath) {
  // Verificar cache
  const cached = fileDataCache.get(fileId);
  if (cached) {
    return cached.data;
  }

  // Leer del disco y cachear
  if (!fs.existsSync(dataPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    fileDataCache.set(fileId, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    logger.warn(`Error leyendo datos de archivo ${fileId}:`, error.message);
    return null;
  }
}

/**
 * Busca en todos los archivos cargados
 *
 * ✅ OPTIMIZADO: Usa cache en memoria para evitar I/O de disco
 */
function searchInFiles(query) {
  const results = [];

  // Normalizar query de múltiples formas para ser más flexible
  const queryLower = query.toLowerCase();
  const queryUpper = query.toUpperCase();
  const queryCapitalized = query.charAt(0).toUpperCase() + query.slice(1).toLowerCase();

  // Remover espacios extras y normalizar
  const queryNormalized = query.trim().replace(/\s+/g, ' ');

  // Remover acentos para búsqueda más flexible
  const queryNoAccents = removeAccents(queryLower);

  // Extraer palabras clave
  const queryKeywords = extractKeywords(query);

  logger.debug(`🔍 Buscando: "${query}" (normalizado: "${queryNormalized}", sin acentos: "${queryNoAccents}")`);

  for (const file of knowledgeIndex.files) {
    // ✅ MEJORADO: Determinar ruta del archivo de datos
    let dataPath;

    if (file.relativePath) {
      // Usar ruta relativa
      dataPath = path.join(KNOWLEDGE_DIR, path.dirname(file.relativePath), `${file.id}_data.json`);
    } else {
      // Compatibilidad con archivos antiguos
      dataPath = path.join(KNOWLEDGE_DIR, `${file.id}_data.json`);

      // Si no existe y tiene stageId, buscar en carpeta de etapa
      if (!fs.existsSync(dataPath) && file.stageId) {
        const stagesService = require('./stages.service');
        const stageFolder = stagesService.getStageFolder(file.stageId);
        dataPath = path.join(stageFolder, `${file.id}_data.json`);
      }
    }

    // ✅ OPTIMIZADO: Usar cache en memoria
    const data = getCachedFileData(file.id, dataPath);
    if (!data) continue;

    try {
      for (const chunk of data.chunks) {
        // Calcular relevancia
        let score = 0;

        // Coincidencia directa exacta - probar múltiples variaciones
        const chunkText = chunk.text;
        const chunkTextLower = chunkText.toLowerCase();
        const chunkTextNoAccents = removeAccents(chunkTextLower);

        // Búsqueda exacta (case-sensitive) - mayor peso
        if (chunkText.includes(query)) {
          score += 30;
        }

        // Búsqueda con diferentes variaciones de mayúsculas
        if (chunkTextLower.includes(queryLower)) {
          score += 20;
        }
        if (chunkText.includes(queryUpper)) {
          score += 15;
        }
        if (chunkText.includes(queryCapitalized)) {
          score += 15;
        }

        // ✅ NUEVO: Búsqueda sin acentos (más flexible)
        if (chunkTextNoAccents.includes(queryNoAccents)) {
          score += 12;
        }

        // Coincidencia de palabras clave - aumentar peso
        for (const keyword of queryKeywords) {
          const keywordLower = keyword.toLowerCase();
          const keywordNoAccents = removeAccents(keywordLower);

          // Buscar en palabras clave del chunk
          if (chunk.keywords.includes(keyword)) {
            score += 8;
          }
          if (chunk.keywords.includes(keywordNoAccents)) {
            score += 5;
          }
          // Buscar en texto del chunk
          if (chunkTextLower.includes(keywordLower)) {
            score += 4;
          }
          if (chunkTextNoAccents.includes(keywordNoAccents)) {
            score += 3;
          }
        }

        logger.debug(`  Chunk score: ${score} (buscando "${query}")`);

        if (score > 0) {
          results.push({
            text: chunk.text,
            score: score,
            source: file.originalName,
            isQA: chunk.isQA || false
          });
        }
      }
    } catch (error) {
      logger.warn(`Error leyendo datos de ${file.originalName}:`, error.message);
    }
  }

  logger.debug(`🎯 Resultados encontrados: ${results.length}`);

  // ✅ NUEVO: Si no hay resultados exactos pero hay palabras clave, intentar búsqueda más laxa
  if (results.length === 0 && queryKeywords.length > 0) {
    logger.info(`🔄 Sin resultados exactos, intentando búsqueda laxa por palabras clave...`);

    for (const file of knowledgeIndex.files) {
      // ✅ CORREGIDO: Usar la misma lógica que la búsqueda principal
      // para encontrar archivos en subcarpetas de etapas
      let dataPath;

      if (file.relativePath) {
        // Usar ruta relativa
        dataPath = path.join(KNOWLEDGE_DIR, path.dirname(file.relativePath), `${file.id}_data.json`);
      } else {
        // Compatibilidad con archivos antiguos
        dataPath = path.join(KNOWLEDGE_DIR, `${file.id}_data.json`);

        // Si no existe y tiene stageId, buscar en carpeta de etapa
        if (!fs.existsSync(dataPath) && file.stageId) {
          try {
            const stagesService = require('./stages.service');
            const stageFolder = stagesService.getStageFolder(file.stageId);
            dataPath = path.join(stageFolder, `${file.id}_data.json`);
          } catch (e) {
            // Ignorar error y continuar
          }
        }
      }

      if (!fs.existsSync(dataPath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

        for (const chunk of data.chunks) {
          const chunkTextLower = chunk.text.toLowerCase();
          const chunkTextNoAccents = removeAccents(chunkTextLower);

          // Verificar si al menos una palabra clave está presente (incluso parcial)
          let partialScore = 0;
          for (const keyword of queryKeywords) {
            const keywordNoAccents = removeAccents(keyword.toLowerCase());

            // Búsqueda parcial de palabra clave (al menos 4 caracteres)
            if (keyword.length >= 4) {
              for (let i = 0; i <= keyword.length - 4; i++) {
                const partial = keyword.substring(i, i + 4);
                if (chunkTextNoAccents.includes(partial) || chunkTextLower.includes(partial)) {
                  partialScore += 1;
                  break; // Contar la palabra clave solo una vez
                }
              }
            }
          }

          if (partialScore > 0) {
            logger.info(`  ✅ Encontrado coincidencia parcial: score=${partialScore}`);
            results.push({
              text: chunk.text,
              score: partialScore,
              source: file.originalName,
              isQA: chunk.isQA || false,
              isPartial: true // Marcar como coincidencia parcial
            });
          }
        }
      } catch (error) {
        logger.warn(`Error en búsqueda laxa de ${file.originalName}:`, error.message);
      }
    }
  }

  // Ordenar por relevancia y retornar top 5
  const sorted = results.sort((a, b) => b.score - a.score);

  logger.info(`📊 Total resultados (incluyendo parciales): ${sorted.length}`);

  return sorted.slice(0, 5);
}

/**
 * ✅ NUEVO: Elimina acentos de una cadena para búsqueda más flexible
 */
function removeAccents(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Eliminar diacríticos
    .replace(/ñ/g, 'n') // Reemplazar ñ
    .replace(/Ñ/g, 'N'); // Reemplazar Ñ
}

/**
 * Obtiene contexto relevante de los archivos subidos
 */
function getContextFromFiles(query, maxResults = 3) {
  const results = searchInFiles(query);

  if (results.length === 0) return '';

  return results
    .slice(0, maxResults)
    .map(r => r.text)
    .join('\n\n---\n\n');
}

// ===========================================
// ✅ NUEVAS FUNCIONES PARA EMBEDDINGS
// ===========================================

/**
 * Obtiene los datos procesados de un archivo
 *
 * @param {Object} fileEntry - Entrada del archivo del índice
 * @returns {Promise<Object|null>} Datos procesados con chunks
 */
async function getFileData(fileEntry) {
  try {
    let dataPath;

    if (fileEntry.relativePath) {
      // Usar ruta relativa
      dataPath = path.join(KNOWLEDGE_DIR, path.dirname(fileEntry.relativePath), `${fileEntry.id}_data.json`);
    } else if (fileEntry.stageId) {
      // Buscar en carpeta de etapa
      try {
        const stagesService = require('./stages.service');
        const stageFolder = stagesService.getStageFolder(fileEntry.stageId);
        dataPath = path.join(stageFolder, `${fileEntry.id}_data.json`);
      } catch (e) {
        dataPath = path.join(KNOWLEDGE_DIR, `${fileEntry.id}_data.json`);
      }
    } else {
      // Compatibilidad con archivos antiguos
      dataPath = path.join(KNOWLEDGE_DIR, `${fileEntry.id}_data.json`);
    }

    if (!fs.existsSync(dataPath)) {
      logger.warn(`⚠️ Archivo de datos no encontrado: ${dataPath}`);
      return null;
    }

    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    return data;
  } catch (error) {
    logger.error(`❌ Error leyendo datos de ${fileEntry.originalName}:`, error.message);
    return null;
  }
}

/**
 * Guarda los datos procesados de un archivo (con embeddings)
 *
 * @param {Object} fileEntry - Entrada del archivo del índice
 * @param {Object} data - Datos procesados con chunks
 */
async function saveFileData(fileEntry, data) {
  try {
    let dataPath;

    if (fileEntry.relativePath) {
      dataPath = path.join(KNOWLEDGE_DIR, path.dirname(fileEntry.relativePath), `${fileEntry.id}_data.json`);
    } else if (fileEntry.stageId) {
      try {
        const stagesService = require('./stages.service');
        const stageFolder = stagesService.getStageFolder(fileEntry.stageId);
        dataPath = path.join(stageFolder, `${fileEntry.id}_data.json`);
      } catch (e) {
        dataPath = path.join(KNOWLEDGE_DIR, `${fileEntry.id}_data.json`);
      }
    } else {
      dataPath = path.join(KNOWLEDGE_DIR, `${fileEntry.id}_data.json`);
    }

    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    logger.info(`💾 Datos guardados: ${fileEntry.originalName}`);
  } catch (error) {
    logger.error(`❌ Error guardando datos de ${fileEntry.originalName}:`, error.message);
    throw error;
  }
}

module.exports = {
  uploadFile,
  getUploadedFiles,
  getFilesByStage,
  deleteFile,
  searchInFiles,
  getContextFromFiles,
  processTxtFile,  // ✅ Exportado para script de reproceso
  getFileData,     // ✅ NUEVO: Para embeddings
  saveFileData,    // ✅ NUEVO: Para embeddings
};
