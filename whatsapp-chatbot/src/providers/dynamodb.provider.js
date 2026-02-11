/**
 * ===========================================
 * PROVEEDOR DE DYNAMODB
 * ===========================================
 * 
 * Cliente de DynamoDB configurado con credenciales de AWS
 * ✅ MEJORADO: No crashea si faltan credenciales, permite configurar desde el dashboard
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const logger = require('../utils/logger');

// Nombres de tablas desde .env
const TABLES = {
  CONVERSATIONS: process.env.DYNAMODB_CONVERSATIONS_TABLE || 'norboy-conversations',
  MESSAGES: process.env.DYNAMODB_MESSAGES_TABLE || 'norboy-messages',
  HOLIDAYS: process.env.DYNAMODB_HOLIDAYS_TABLE || 'norboy-holidays'
};

let dynamoDBClient = null;
let docClient = null;
let isConfigured = false;

// Intentar inicializar si las credenciales están disponibles
if (process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  try {
    dynamoDBClient = new DynamoDBClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });

    docClient = DynamoDBDocumentClient.from(dynamoDBClient, {
      marshallOptions: {
        convertEmptyValues: false,
        removeUndefinedValues: true,
        convertClassInstanceToMap: false
      },
      unmarshallOptions: {
        wrapNumbers: false
      }
    });

    isConfigured = true;
    logger.info(`✅ DynamoDB cliente configurado - Región: ${process.env.AWS_REGION}`);
  } catch (error) {
    logger.error(`❌ Error inicializando DynamoDB: ${error.message}`);
  }
} else {
  logger.warn('⚠️ Credenciales de AWS no configuradas - DynamoDB desactivado');
  logger.warn('   Puede configurarlas desde el dashboard o en el archivo .env');
}

module.exports = {
  dynamoDBClient,
  docClient,
  isConfigured,
  TABLES
};

