/**
 * ===========================================
 * REPOSITORIO DE DÍAS FESTIVOS - DYNAMODB
 * ===========================================
 *
 * Responsabilidades:
 * - Abstracción de la capa de persistencia
 * - CRUD de días festivos en DynamoDB
 * - Consultas especializadas por fecha
 *
 * PATRÓN: Repository
 * Permite cambiar la implementación de almacenamiento
 * sin afectar el resto de la aplicación.
 */

const logger = require('../utils/logger');
const { Holiday } = require('../models/holiday.model');
const { docClient, TABLES } = require('../providers/dynamodb.provider');
const { PutCommand, GetCommand, UpdateCommand, DeleteCommand, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

/**
 * Repositorio de Holidays con DynamoDB
 */
class HolidayRepository {

  constructor() {
    // Nombre de la tabla de festivos
    this.tableName = process.env.DYNAMODB_HOLIDAYS_TABLE || 'norboy-holidays';
  }

  // ===========================================
  // OPERACIONES BÁSICAS CRUD
  // ===========================================

  /**
   * Busca un día festivo por ID
   * @param {string} id - ID del festivo
   * @returns {Promise<Holiday|null>}
   */
  async findById(id) {
    try {
      const command = new GetCommand({
        TableName: this.tableName,
        Key: { id }
      });

      const response = await docClient.send(command);

      if (!response.Item) {
        return null;
      }

      return new Holiday(response.Item);
    } catch (error) {
      logger.error(`Error buscando festivo ${id}:`, error);
      throw error;
    }
  }

  /**
   * Guarda un día festivo (crea o actualiza)
   * @param {Holiday} holiday
   * @returns {Promise<Holiday>}
   */
  async save(holiday) {
    try {
      if (!holiday.isValidDate()) {
        throw new Error('Fecha inválida. Debe ser formato YYYY-MM-DD');
      }

      holiday.updatedAt = new Date();

      const command = new PutCommand({
        TableName: this.tableName,
        Item: holiday.toDynamoItem()
      });

      await docClient.send(command);
      logger.info(`💾 Festivo guardado: ${holiday.date} - ${holiday.name}`);

      return holiday;
    } catch (error) {
      logger.error('Error guardando festivo:', error);
      throw error;
    }
  }

  /**
   * Actualiza un festivo existente
   * @param {string} id - ID del festivo
   * @param {object} updates - Campos a actualizar
   * @returns {Promise<Holiday>}
   */
  async update(id, updates) {
    try {
      const holiday = await this.findById(id);
      if (!holiday) {
        throw new Error('Festivo no encontrado');
      }

      // Aplicar actualizaciones
      Object.assign(holiday, updates);
      holiday.updatedAt = new Date();

      await this.save(holiday);
      return holiday;
    } catch (error) {
      logger.error(`Error actualizando festivo ${id}:`, error);
      throw error;
    }
  }

  /**
   * Elimina un festivo
   * @param {string} id - ID del festivo
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    try {
      const holiday = await this.findById(id);
      if (!holiday) {
        return false;
      }

      const command = new DeleteCommand({
        TableName: this.tableName,
        Key: { id }
      });

      await docClient.send(command);
      logger.info(`🗑️ Festivo eliminado: ${holiday.date} - ${holiday.name}`);
      return true;
    } catch (error) {
      logger.error(`Error eliminando festivo ${id}:`, error);
      throw error;
    }
  }

  // ===========================================
  // CONSULTAS ESPECIALIZADAS
  // ===========================================

  /**
   * Obtiene todos los festivos activos
   * @returns {Promise<Array<Holiday>>}
   */
  async findAllActive() {
    try {
      const command = new ScanCommand({
        TableName: this.tableName,
        FilterExpression: '#active = :active',
        ExpressionAttributeNames: {
          '#active': 'active'
        },
        ExpressionAttributeValues: {
          ':active': true
        }
      });

      const response = await docClient.send(command);
      return (response.Items || []).map(item => new Holiday(item));
    } catch (error) {
      // Si la tabla no existe, devolver array vacío
      if (error.name === 'ResourceNotFoundException' || error.$metadata?.httpStatusCode === 400) {
        logger.warn(`⚠️ Tabla ${this.tableName} no existe aún. Devolviendo array vacío.`);
        return [];
      }
      logger.error('Error obteniendo festivos activos:', error);
      return [];
    }
  }

  /**
   * Obtiene todos los festivos (incluyendo inactivos)
   * @returns {Promise<Array<Holiday>>}
   */
  async findAll() {
    try {
      const command = new ScanCommand({
        TableName: this.tableName
      });

      const response = await docClient.send(command);
      return (response.Items || []).map(item => new Holiday(item));
    } catch (error) {
      // Si la tabla no existe, devolver array vacío
      if (error.name === 'ResourceNotFoundException' || error.$metadata?.httpStatusCode === 400) {
        logger.warn(`⚠️ Tabla ${this.tableName} no existe aún. Devolviendo array vacío.`);
        return [];
      }
      logger.error('Error obteniendo todos los festivos:', error);
      return [];
    }
  }

  /**
   * Busca festivos por fecha específica
   * @param {string} date - Fecha en formato YYYY-MM-DD
   * @returns {Promise<Array<Holiday>>}
   */
  async findByDate(date) {
    try {
      const allHolidays = await this.findAllActive();
      return allHolidays.filter(h => h.date === date);
    } catch (error) {
      logger.error(`Error buscando festivos por fecha ${date}:`, error);
      throw error;
    }
  }

  /**
   * Busca festivos en un rango de fechas
   * @param {string} startDate - Fecha inicial YYYY-MM-DD
   * @param {string} endDate - Fecha final YYYY-MM-DD
   * @returns {Promise<Array<Holiday>>}
   */
  async findByDateRange(startDate, endDate) {
    try {
      const allHolidays = await this.findAllActive();
      return allHolidays.filter(h => h.date >= startDate && h.date <= endDate);
    } catch (error) {
      logger.error(`Error buscando festivos en rango ${startDate} - ${endDate}:`, error);
      throw error;
    }
  }

  /**
   * Busca festivos por mes
   * @param {number} year - Año (opcional, usa el actual si no se especifica)
   * @param {number} month - Mes (1-12)
   * @returns {Promise<Array<Holiday>>}
   */
  async findByMonth(year, month) {
    try {
      const targetYear = year || new Date().getFullYear();
      const monthStr = String(month).padStart(2, '0');
      const monthPrefix = `${targetYear}-${monthStr}`;

      const allHolidays = await this.findAllActive();

      // Filtrar: festivos del mes o recurrentes que coinciden con el mes
      return allHolidays.filter(h => {
        if (h.recurring) {
          return h.date.substring(5, 7) === monthStr;
        } else {
          return h.date.startsWith(monthPrefix);
        }
      });
    } catch (error) {
      logger.error(`Error buscando festivos del mes ${month}:`, error);
      return [];
    }
  }

  /**
   * Obtiene festivos de un año específico
   * @param {number} year - Año
   * @returns {Promise<Array<Holiday>>}
   */
  async findByYear(year) {
    try {
      const allHolidays = await this.findAllActive();

      return allHolidays.filter(h => {
        if (h.recurring) {
          return true; // Los recurrentes aplican a todos los años
        } else {
          return h.date.startsWith(String(year));
        }
      });
    } catch (error) {
      logger.error(`Error buscando festivos del año ${year}:`, error);
      throw error;
    }
  }

  /**
   * Verifica si una fecha específica es festivo
   * @param {Date|string} date - Fecha a verificar
   * @returns {Promise<boolean>}
   */
  async isHoliday(date) {
    try {
      const allHolidays = await this.findAllActive();
      return allHolidays.some(h => h.matchesDate(date) && h.isActive());
    } catch (error) {
      logger.error('Error verificando si es festivo:', error);
      return false;
    }
  }

  /**
   * Verifica si hoy es festivo
   * @returns {Promise<boolean>}
   */
  async isTodayHoliday() {
    return await this.isHoliday(new Date());
  }

  /**
   * Obtiene el próximo festivo
   * @returns {Promise<Holiday|null>}
   */
  async getNextHoliday() {
    try {
      const today = new Date();
      const allHolidays = await this.findAllActive();

      // Crear lista de fechas de festivos para este año
      const currentYear = today.getFullYear();
      const upcomingHolidays = allHolidays
        .filter(h => h.isActive())
        .map(h => {
          let holidayDate;

          if (h.recurring) {
            // Para festivos recurrentes, crear fecha con el año actual o siguiente
            const month = h.getMonth();
            const day = h.getDay();
            holidayDate = new Date(currentYear, month - 1, day);

            // Si ya pasó este año, usar el próximo año
            if (holidayDate < today) {
              holidayDate = new Date(currentYear + 1, month - 1, day);
            }
          } else {
            holidayDate = new Date(h.date);
          }

          return {
            holiday: h,
            date: holidayDate
          };
        })
        .filter(item => item.date >= today)
        .sort((a, b) => a.date - b.date);

      return upcomingHolidays.length > 0 ? upcomingHolidays[0].holiday : null;
    } catch (error) {
      logger.error('Error obteniendo próximo festivo:', error);
      return null;
    }
  }

  /**
   * Activa o desactiva un festivo
   * @param {string} id - ID del festivo
   * @param {boolean} active - Estado deseado
   * @returns {Promise<Holiday>}
   */
  async setActive(id, active) {
    return await this.update(id, { active });
  }
}

// Singleton
const holidayRepository = new HolidayRepository();

module.exports = holidayRepository;
