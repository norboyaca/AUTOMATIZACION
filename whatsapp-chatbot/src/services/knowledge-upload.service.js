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
 */
async function processTxtFile(filePath, originalName) {
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    type: 'txt',
    name: originalName,
    content: content,
    chunks: extractChunks(content),
    uploadDate: new Date().toISOString()
  };
}

/**
 * Procesa un archivo PDF
 */
async function processPdfFile(filePath, originalName) {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);

    return {
      type: 'pdf',
      name: originalName,
      content: data.text,
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
 * Extrae chunks de texto para búsqueda
 *
 * ✅ MEJORADO: Limpieza mejor de caracteres especiales y formato
 */
function extractChunks(text) {
  const chunks = [];

  // ✅ NUEVO: Limpiar caracteres problemáticos del PDF antes de procesar
  const cleanedText = cleanPdfText(text);

  // Dividir por párrafos o secciones
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

  // También buscar patrones de pregunta-respuesta
  const qaPattern = /(?:pregunta|p)[:\s]*(.+?)(?:respuesta|r)[:\s]*(.+?)(?=(?:pregunta|p)[:\s]|$)/gis;
  let match;

  while ((match = qaPattern.exec(cleanedText)) !== null) {
    chunks.push({
      text: `${match[1].trim()}\n${match[2].trim()}`,
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
    [/—/g, '-'],

    // Múltiples espacios
    [/\s+/g, ' '],

    // Líneas que no terminan con punto (probables cortes de PDF)
    [/([a-z])\n([a-z])/g, '$1 $2']
  ];

  let cleaned = text;

  for (const [pattern, replacement] of replacements) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  // Normalizar espacios al final
  cleaned = cleaned.trim().replace(/\s+/g, ' ');

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
 */
async function uploadFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const fileName = `${Date.now()}_${file.originalname}`;
  const filePath = path.join(KNOWLEDGE_DIR, fileName);

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

  // Agregar al índice
  const fileEntry = {
    id: Date.now().toString(),
    fileName: fileName,
    originalName: file.originalname,
    type: ext.replace('.', ''),
    size: file.size,
    chunksCount: processedData.chunks.length,
    uploadDate: processedData.uploadDate
  };

  knowledgeIndex.files.push(fileEntry);
  saveIndex();

  // Guardar datos procesados
  const dataPath = path.join(KNOWLEDGE_DIR, `${fileEntry.id}_data.json`);
  fs.writeFileSync(dataPath, JSON.stringify(processedData, null, 2));

  logger.info(`Archivo cargado: ${file.originalname} (${processedData.chunks.length} chunks)`);

  return fileEntry;
}

/**
 * Obtiene la lista de archivos cargados
 */
function getUploadedFiles() {
  return knowledgeIndex.files;
}

/**
 * Elimina un archivo
 */
function deleteFile(fileId) {
  const fileIndex = knowledgeIndex.files.findIndex(f => f.id === fileId);

  if (fileIndex === -1) {
    throw new Error('Archivo no encontrado');
  }

  const file = knowledgeIndex.files[fileIndex];

  // Eliminar archivos físicos
  const filePath = path.join(KNOWLEDGE_DIR, file.fileName);
  const dataPath = path.join(KNOWLEDGE_DIR, `${file.id}_data.json`);

  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);

  // Eliminar del índice
  knowledgeIndex.files.splice(fileIndex, 1);
  saveIndex();

  logger.info(`Archivo eliminado: ${file.originalName}`);
  return true;
}

/**
 * Busca en todos los archivos cargados
 *
 * ✅ MEJORADO: Búsqueda más flexible e inteligente
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
    const dataPath = path.join(KNOWLEDGE_DIR, `${file.id}_data.json`);

    if (!fs.existsSync(dataPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

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
      const dataPath = path.join(KNOWLEDGE_DIR, `${file.id}_data.json`);

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

module.exports = {
  uploadFile,
  getUploadedFiles,
  deleteFile,
  searchInFiles,
  getContextFromFiles
};
