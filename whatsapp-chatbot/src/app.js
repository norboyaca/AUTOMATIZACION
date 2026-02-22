/**
 * ===========================================
 * CONFIGURACIÓN DE EXPRESS - NORBOY CHATBOT
 * ===========================================
 */

const express = require('express');
const path = require('path');
const { router: routes } = require('./routes');
const errorMiddleware = require('./middlewares/error.middleware');
const { apiLimiter } = require('./middlewares/rate-limit.middleware');

const app = express();

// ===========================================
// MIDDLEWARES GLOBALES
// ===========================================

// Parsear JSON
app.use(express.json());

// Parsear URL-encoded
app.use(express.urlencoded({ extended: true }));

// ===========================================
// ARCHIVOS ESTÁTICOS (Interfaz Web)
// ===========================================
app.use(express.static(path.join(__dirname, '..', 'public')));

// ===========================================
// RUTAS
// ===========================================

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// ✅ Rate limiting para todos los endpoints API (100 req/min por IP)
app.use('/api', apiLimiter);

// Rutas API
app.use('/api', routes);

// Ruta principal - Interfaz Web
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ===========================================
// MANEJO DE ERRORES
// ===========================================

// 404 solo para rutas /api que no existen
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    path: req.originalUrl
  });
});

// Middleware de errores global
app.use(errorMiddleware);

module.exports = app;
