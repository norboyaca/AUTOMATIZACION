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
 */
function extractChunks(text) {
  const chunks = [];

  // Dividir por párrafos o secciones
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 50);

  for (const para of paragraphs) {
    // Limpiar el texto
    const cleaned = para.trim().replace(/\s+/g, ' ');

    if (cleaned.length > 0) {
      chunks.push({
        text: cleaned,
        keywords: extractKeywords(cleaned)
      });
    }
  }

  // También buscar patrones de pregunta-respuesta
  const qaPattern = /(?:pregunta|p)[:\s]*(.+?)(?:respuesta|r)[:\s]*(.+?)(?=(?:pregunta|p)[:\s]|$)/gis;
  let match;

  while ((match = qaPattern.exec(text)) !== null) {
    chunks.push({
      text: `${match[1].trim()}\n${match[2].trim()}`,
      keywords: extractKeywords(match[1] + ' ' + match[2]),
      isQA: true
    });
  }

  return chunks;
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
 */
function searchInFiles(query) {
  const results = [];
  const queryLower = query.toLowerCase();
  const queryKeywords = extractKeywords(query);

  for (const file of knowledgeIndex.files) {
    const dataPath = path.join(KNOWLEDGE_DIR, `${file.id}_data.json`);

    if (!fs.existsSync(dataPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

      for (const chunk of data.chunks) {
        // Calcular relevancia
        let score = 0;

        // Coincidencia directa en texto
        if (chunk.text.toLowerCase().includes(queryLower)) {
          score += 10;
        }

        // Coincidencia de palabras clave
        for (const keyword of queryKeywords) {
          if (chunk.keywords.includes(keyword)) {
            score += 2;
          }
          if (chunk.text.toLowerCase().includes(keyword)) {
            score += 1;
          }
        }

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

  // Ordenar por relevancia y retornar top 5
  return results.sort((a, b) => b.score - a.score).slice(0, 5);
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
