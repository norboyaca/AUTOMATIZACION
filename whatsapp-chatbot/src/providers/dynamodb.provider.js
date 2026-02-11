/**
 * ===========================================
 * PROVEEDOR DE DYNAMODB
 * ===========================================
 * 
 * Cliente de DynamoDB configurado con credenciales de AWS
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const logger = require('../utils/logger');

// Verificar que las credenciales estén configuradas
if (!process.env.AWS_REGION || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  logger.error('❌ Credenciales de AWS no configuradas en .env');
  throw new Error('AWS credentials not configured');
}

// Crear cliente de DynamoDB
const dynamoDBClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// Crear Document Client (abstracción de alto nivel)
const docClient = DynamoDBDocumentClient.from(dynamoDBClient, {
  marshallOptions: {
    // Convierte undefined a null
    convertEmptyValues: false,
    // Elimina valores undefined
    removeUndefinedValues: true,
    // Convierte clases a mapas
    convertClassInstanceToMap: false
  },
  unmarshallOptions: {
    // Mantiene números como números (no los convierte a strings)
    wrapNumbers: false
  }
});

logger.info(`✅ DynamoDB cliente configurado - Región: ${process.env.AWS_REGION}`);

module.exports = {
  dynamoDBClient,
  docClient,
  // Nombres de tablas desde .env
  TABLES: {
    CONVERSATIONS: process.env.DYNAMODB_CONVERSATIONS_TABLE || 'norboy-conversations',
    MESSAGES: process.env.DYNAMODB_MESSAGES_TABLE || 'norboy-messages',
    HOLIDAYS: process.env.DYNAMODB_HOLIDAYS_TABLE || 'norboy-holidays'
  }
};
