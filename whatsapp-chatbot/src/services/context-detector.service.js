/**
 * ===========================================
 * DETECTOR DE CONTEXTO NORBOY
 * ===========================================
 *
 * Detecta si una pregunta está relacionada con NORBOY
 * y el proceso electoral, ANTES de buscar en RAG.
 *
 * REGLA PRINCIPAL:
 * - Si NO es sobre NORBOY → Mensaje restrictivo (no buscar en RAG)
 * - Si ES sobre NORBOY pero no hay info → ESCALAR (no inventar)
 */

const logger = require('../utils/logger');

// ===========================================
// KEYWORDS DE NORBOY (proceso electoral)
// ===========================================

const NORBOY_KEYWORDS = [
  // Proceso electoral
  'vota', 'votar', 'votacion', 'votaciones', 'voto', 'votos',
  'eleccion', 'elecciones', 'electoral', 'elegir', 'elegi',
  'delegado', 'delegados', 'delegada', 'delegadas',
  'candidato', 'candidatos', 'candidata', 'candidatas',
  'postula', 'postular', 'postulacion', 'inscri', 'inscribir', 'inscripcion',

  // Fechas y cronograma
  'fecha', 'fechas', 'cuando', 'dia', 'dias', 'cronograma',
  'febrero', 'enero', 'periodo', 'plazo', 'calendario',
  'horario', 'hora', 'horas',

  // Afiliación y asociados
  'afilia', 'afiliacion', 'afiliado', 'afiliada',
  'asociado', 'asociada', 'asociados', 'asociadas',
  'socio', 'socia', 'socios', 'miembro', 'miembros',
  'habil', 'habiles', 'habilitado', 'habilitada',

  // Proceso y documentos
  'requisito', 'requisitos', 'reglamento', 'estatuto',
  'proceso', 'procedimiento', 'democra', 'democratico',
  'resolucion', 'acta', 'formulario', 'documento',

  // Resultados y escrutinio
  'ganador', 'ganadores', 'resultado', 'resultados',
  'escrutinio', 'conteo', 'cuociente', 'residuo',
  'credencial', 'credenciales',

  // Órganos y entidades
  'norboy', 'cooperativa', 'asamblea', 'consejo',
  'junta', 'vigilancia', 'administracion', 'revisor',
  'comision', 'comite',

  // Suplentes
  'suplente', 'suplentes', 'principal', 'principales',

  // Campaña
  'campaña', 'campana', 'propaganda', 'publicidad',

  // Otros relacionados
  'elegimos', 'juntos', '2026', '2029', 'periodo',
  'representante', 'representacion', 'voz', 'derecho',
  'impugna', 'impugnacion', 'reclamo',

  // Contacto NORBOY
  'asesor', 'asesora', 'contacto', 'telefono', 'oficina', 'direccion',
  'whatsapp', 'correo', 'email', 'ayuda', 'informacion',

  // Preguntas comunes
  'como', 'donde', 'quien', 'quienes', 'cuanto', 'cuantos', 'cual', 'cuales',
  'puedo', 'puede', 'debo', 'debe', 'necesito', 'necesita',
];

// ===========================================
// KEYWORDS FUERA DE CONTEXTO (NO NORBOY)
// ===========================================

const OUT_OF_CONTEXT_KEYWORDS = [
  // Ciencia y naturaleza
  'agua', 'aire', 'fuego', 'tierra', 'sol', 'luna', 'estrella',
  'planta', 'animal', 'celula', 'atomo', 'molecula',
  'quimica', 'fisica', 'biologia', 'matematica',
  'energia', 'electricidad', 'gravedad',

  // Clima y geografía
  'clima', 'tiempo', 'lluvia', 'nieve', 'viento', 'temperatura',
  'pais', 'continente', 'oceano', 'rio', 'montana', 'desierto',
  'ciudad', 'capital',

  // Comida y cocina
  'comida', 'receta', 'cocina', 'ingrediente', 'cocinar',
  'desayuno', 'almuerzo', 'cena', 'postre',

  // Entretenimiento
  'musica', 'pelicula', 'serie', 'libro', 'autor',
  'juego', 'videojuego', 'deporte', 'futbol', 'equipo',
  'cancion', 'artista', 'actor', 'actriz',

  // Historia y cultura
  'historia', 'guerra', 'rey', 'reina', 'imperio',
  'religion', 'dios', 'iglesia', 'biblia',

  // Tecnología general
  'computadora', 'internet', 'programa', 'aplicacion', 'app',
  'celular', 'telefono', 'redes', 'facebook', 'instagram', 'tiktok',

  // Salud general
  'enfermedad', 'medicina', 'doctor', 'hospital', 'pastilla',
  'sintoma', 'tratamiento', 'dieta', 'ejercicio',

  // Finanzas generales (no cooperativa)
  'banco', 'tarjeta', 'credito', 'debito', 'inversion',
  'accion', 'bolsa', 'mercado', 'bitcoin', 'cripto',

  // Educación general
  'escuela', 'universidad', 'colegio', 'examen', 'tarea',
  'profesor', 'estudiante', 'clase', 'curso',

  // Otros temas no relacionados
  'amor', 'novio', 'novia', 'matrimonio', 'boda',
  'trabajo', 'empleo', 'salario', 'jefe', 'empresa',
  'viaje', 'vacaciones', 'hotel', 'avion', 'carro',
  'moda', 'ropa', 'zapato', 'vestido',
  'mascotas', 'perro', 'gato', 'pajaro',
];

// ===========================================
// SALUDOS Y MENSAJES GENÉRICOS
// ===========================================

const GREETING_PATTERNS = [
  /^hola$/i, /^holi$/i, /^hey$/i, /^hi$/i, /^hello$/i,
  /^buenos?\s*(dias?|tardes?|noches?)$/i,
  /^buenas$/i, /^saludos?$/i, /^que\s*tal$/i,
  /^como\s*esta/i, /^como\s*va/i,
];

const GRATITUDE_PATTERNS = [
  /^gracias?$/i, /^muchas\s*gracias$/i, /^ok$/i, /^vale$/i,
  /^entendido$/i, /^listo$/i, /^perfecto$/i, /^genial$/i,
];

// ===========================================
// FUNCIONES DE DETECCIÓN
// ===========================================

/**
 * Normaliza texto para comparación
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .replace(/[¿?¡!.,;:'"]/g, '')    // Quitar puntuación
    .trim();
}

/**
 * Verifica si es un saludo
 */
function isGreeting(query) {
  const normalized = normalizeText(query);
  return GREETING_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Verifica si es agradecimiento
 */
function isGratitude(query) {
  const normalized = normalizeText(query);
  return GRATITUDE_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Verifica si contiene keywords de NORBOY
 */
function hasNorboyKeywords(query) {
  const normalized = normalizeText(query);
  const words = normalized.split(/\s+/);

  for (const keyword of NORBOY_KEYWORDS) {
    // Coincidencia exacta de palabra
    if (words.includes(keyword)) {
      return { found: true, keyword, type: 'exact' };
    }

    // Coincidencia parcial (keyword dentro de palabra)
    if (normalized.includes(keyword)) {
      return { found: true, keyword, type: 'partial' };
    }
  }

  return { found: false };
}

/**
 * Verifica si contiene keywords fuera de contexto
 */
function hasOutOfContextKeywords(query) {
  const normalized = normalizeText(query);
  const words = normalized.split(/\s+/);

  for (const keyword of OUT_OF_CONTEXT_KEYWORDS) {
    if (words.includes(keyword) || normalized.includes(keyword)) {
      return { found: true, keyword };
    }
  }

  return { found: false };
}

/**
 * FUNCIÓN PRINCIPAL: Detecta si la query está relacionada con NORBOY
 *
 * @param {string} query - Pregunta del usuario
 * @returns {Object} Resultado de detección
 */
function detectContext(query) {
  if (!query || typeof query !== 'string') {
    return {
      isNorboyRelated: false,
      type: 'invalid',
      reason: 'Query vacía o inválida',
      shouldProcess: false,
      shouldEscalate: false
    };
  }

  const normalized = normalizeText(query);

  // Log de inicio
  logger.debug(`🔍 Detectando contexto: "${query.substring(0, 50)}..."`);

  // 1. Verificar si es saludo
  if (isGreeting(query)) {
    logger.debug('   ✅ Detectado: Saludo');
    return {
      isNorboyRelated: true, // Saludos siempre se procesan
      type: 'greeting',
      reason: 'Saludo detectado',
      shouldProcess: true,
      shouldEscalate: false
    };
  }

  // 2. Verificar si es agradecimiento
  if (isGratitude(query)) {
    logger.debug('   ✅ Detectado: Agradecimiento');
    return {
      isNorboyRelated: true,
      type: 'gratitude',
      reason: 'Agradecimiento detectado',
      shouldProcess: true,
      shouldEscalate: false
    };
  }

  // 3. Verificar keywords fuera de contexto PRIMERO
  const outOfContext = hasOutOfContextKeywords(query);
  if (outOfContext.found) {
    // PERO verificar si también tiene keywords de NORBOY
    const norboyCheck = hasNorboyKeywords(query);

    if (!norboyCheck.found) {
      // Solo fuera de contexto, NO es sobre NORBOY
      logger.info(`   ❌ Fuera de contexto: keyword "${outOfContext.keyword}"`);
      return {
        isNorboyRelated: false,
        type: 'out_of_scope',
        reason: `Pregunta no relacionada con NORBOY (keyword: ${outOfContext.keyword})`,
        detectedKeyword: outOfContext.keyword,
        shouldProcess: false,
        shouldEscalate: false
      };
    }
    // Si tiene ambos, priorizar NORBOY
    logger.debug(`   ⚠️ Tiene keyword fuera de contexto pero también NORBOY`);
  }

  // 4. Verificar keywords de NORBOY
  const norboyCheck = hasNorboyKeywords(query);
  if (norboyCheck.found) {
    logger.info(`   ✅ Relacionado con NORBOY: keyword "${norboyCheck.keyword}" (${norboyCheck.type})`);
    return {
      isNorboyRelated: true,
      type: 'norboy_related',
      reason: `Keyword NORBOY detectado: ${norboyCheck.keyword}`,
      detectedKeyword: norboyCheck.keyword,
      matchType: norboyCheck.type,
      shouldProcess: true,
      shouldEscalate: false
    };
  }

  // 5. Query muy corta sin keywords reconocibles
  if (normalized.length < 10 && normalized.split(/\s+/).length < 3) {
    logger.debug('   ⚠️ Query muy corta, asumir relacionada');
    return {
      isNorboyRelated: true, // Dar beneficio de la duda
      type: 'short_query',
      reason: 'Query corta, procesando por defecto',
      shouldProcess: true,
      shouldEscalate: false
    };
  }

  // 6. Query sin keywords claros - ASUMIR NO RELACIONADA
  logger.info(`   ⚠️ Sin keywords reconocibles, asumiendo fuera de contexto`);
  return {
    isNorboyRelated: false,
    type: 'unknown',
    reason: 'No se detectaron keywords de NORBOY ni fuera de contexto',
    shouldProcess: false,
    shouldEscalate: false
  };
}

// ===========================================
// MENSAJES PREDEFINIDOS
// ===========================================

const MESSAGES = {
  outOfScope: `Sumercé, solo puedo ayudarle con información sobre las elecciones de delegados de NORBOY y el proceso "Elegimos Juntos 2026-2029".

¿Tiene alguna pregunta relacionada con el proceso electoral? 👍`,

  noInformation: `Comprendo, sumercé. 👩‍💼

No tengo información específica sobre eso en mis documentos.

El asesor de NORBOY encargado de este tema le atenderá en breve...`,

  lowConfidence: `Sumercé, no encontré información precisa sobre esa pregunta en los documentos disponibles.

Un asesor de NORBOY podrá ayudarle mejor. Le atenderán en breve... 👩‍💼`,
};

// ===========================================
// EXPORTS
// ===========================================

module.exports = {
  detectContext,
  isGreeting,
  isGratitude,
  hasNorboyKeywords,
  hasOutOfContextKeywords,
  normalizeText,
  MESSAGES,
  NORBOY_KEYWORDS,
  OUT_OF_CONTEXT_KEYWORDS,
};
