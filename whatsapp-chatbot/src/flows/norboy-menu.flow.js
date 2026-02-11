/**
 * ===========================================
 * FLUJO DE MENÚ PRINCIPAL NORBOY
 * ===========================================
 *
 * Responsabilidades:
 * - Mostrar menú con 4 opciones en el primer mensaje
 * - Solicitar consentimiento de datos después del menú
 * - Manejar respuesta de consentimiento
 * - Procesar consulta según opción elegida (solo opción 1)
 * - Redirigir a asesor humano (opciones 2, 3, 4)
 *
 * Flujo:
 * 1. Primer mensaje → Saludo + Menú de 4 opciones
 * 2. Segundo mensaje → Consentimiento de datos
 * 3. Si acepta (Si):
 *    - Opción 1: Procesar consulta con RAG
 *    - Opciones 2,3,4: Redirigir a asesor
 * 4. Si rechaza (No): Finalizar conversación
 */

const BaseFlow = require('./base.flow');
const logger = require('../utils/logger');
const chatService = require('../services/chat.service');

class NorboyMenuFlow extends BaseFlow {
  constructor(context = {}) {
    super(context);

    // Pasos del flujo
    this.steps = ['welcome', 'consent', 'process'];

    // Datos recolectados
    this.data = {
      selectedOption: null,
      consentGiven: null,
      originalQuery: null
    };

    // Estado interno
    this.waitingForMenuSelection = false;
    this.waitingForConsent = false;
  }

  // ===========================================
  // PASO 1: BIENVENIDA + MENÚ
  // ===========================================

  /**
   * Maneja el paso de bienvenida (primer mensaje)
   * @param {string} input - Input del usuario
   * @param {boolean} isStart - Si es el inicio del flujo
   * @returns {Object} Respuesta del flujo
   */
  async handleWelcome(input, isStart = false) {
    // Si es el inicio, enviar saludo + menú
    if (isStart || !this.welcomeSent) {
      this.welcomeSent = true;
      this.waitingForMenuSelection = true;

      logger.info(`📋 Iniciando flujo NORBOY para ${this.context.userId}`);

      // Mensaje 1: Saludo
      const message1 = `Hola, soy AntonIA Santos, su asesor en línea`;

      // Mensaje 2: Menú de opciones enumerados con negrilla
      const message2 = `Escribe el número de la opción 👇

*1.* Elegimos Juntos 2026-2029

*2.* Servicio de crédito

*3.* Cuentas de ahorro

*4.* Otras consultas`;

      return {
        message: message1,
        followUpMessage: message2,
        step: 'welcome',
        waitingForInput: true,
        inputType: 'menu_selection'
      };
    }

    // Si el usuario responde al menú, validar la opción
    const normalizedInput = input?.toLowerCase().trim();

    // Opciones válidas: 1, 2, 3, 4 o texto que coincida
    let selectedOption = null;

    // Verificar respuesta numérica
    if (normalizedInput === '1' || normalizedInput === 'uno') {
      selectedOption = 1;
    } else if (normalizedInput === '2' || normalizedInput === 'dos') {
      selectedOption = 2;
    } else if (normalizedInput === '3' || normalizedInput === 'tres') {
      selectedOption = 3;
    } else if (normalizedInput === '4' || normalizedInput === 'cuatro') {
      selectedOption = 4;
    }
    // Verificar respuesta textual
    else if (normalizedInput.includes('elegimos') || normalizedInput.includes('juntos')) {
      selectedOption = 1;
    } else if (normalizedInput.includes('crédito') || normalizedInput.includes('credito')) {
      selectedOption = 2;
    } else if (normalizedInput.includes('ahorro')) {
      selectedOption = 3;
    } else if (normalizedInput.includes('otras') || normalizedInput.includes('consulta')) {
      selectedOption = 4;
    }

    if (selectedOption === null) {
      // Opción inválida, repetir menú
      logger.info(`❌ Opción inválida: "${input}". Reenviando menú.`);

      return {
        message: `Por favor, selecciona una opción válida escribiendo el número:

*1.* Elegimos Juntos 2026-2029
*2.* Servicio de crédito
*3.* Cuentas de ahorro
*4.* Otras consultas`,
        step: 'welcome',
        isError: true,
        waitingForInput: true,
        inputType: 'menu_selection'
      };
    }

    // Opción válida seleccionada
    this.data.selectedOption = selectedOption;
    this.waitingForMenuSelection = false;
    this.waitingForConsent = true;

    logger.info(`✅ Usuario ${this.context.userId} seleccionó opción ${selectedOption}`);

    // Avanzar al siguiente paso (consentimiento)
    this.currentStepIndex++;

    // Ejecutar paso de consentimiento
    return await this.handleConsent(null, true);
  }

  // ===========================================
  // PASO 2: CONSENTIMIENTO
  // ===========================================

  /**
   * Maneja el paso de consentimiento
   * @param {string} input - Input del usuario
   * @param {boolean} isStart - Si es el inicio del paso
   * @returns {Object} Respuesta del flujo
   */
  async handleConsent(input, isStart = false) {
    // Si es el inicio del paso de consentimiento, enviar mensaje
    if (isStart) {
      const consentMessage = `👋 ¡Gracias por escribirnos!

Para poder asesorarte mejor, te solicitamos autorizar el tratamiento de tus datos personales.

👉 Conócenos aquí:
https://norboy.coop/

📄 Consulta nuestras políticas:
🔒 Política de Protección de Datos Personales:
https://norboy.coop/proteccion-de-datos-personales/

💬 Uso de WhatsApp:
https://www.whatsapp.com/legal

━━━━━━━━━━━━━━━━━━
⚠️ IMPORTANTE

¿Aceptas las políticas de tratamiento de datos personales?

Por favor, digita:

Si

No`;

      return {
        message: consentMessage,
        step: 'consent',
        waitingForInput: true,
        inputType: 'consent_response'
      };
    }

    // Procesar respuesta de consentimiento
    const normalizedInput = input?.toLowerCase().trim();

    // Verificar si acepta
    if (normalizedInput === 'si' || normalizedInput === 'sí' ||
      normalizedInput === '1' || normalizedInput.includes('acept')) {
      logger.info(`✅ Usuario ${this.context.userId} ACEPTÓ el consentimiento`);
      this.data.consentGiven = true;
      this.waitingForConsent = false;

      // Avanzar al siguiente paso (procesar según opción)
      this.currentStepIndex++;

      // Ejecutar paso de procesamiento
      return await this.handleProcess(null, true);
    }

    // Verificar si rechaza
    if (normalizedInput === 'no' || normalizedInput === '2' ||
      normalizedInput.includes('rechaz')) {
      logger.info(`❌ Usuario ${this.context.userId} RECHAZÓ el consentimiento`);
      this.data.consentGiven = false;

      // Finalizar flujo (no continuar)
      return this.complete();
    }

    // Respuesta inválida
    logger.info(`❌ Respuesta de consentimiento inválida: "${input}"`);

    return {
      message: `Por favor, responde únicamente con:

Si

No`,
      step: 'consent',
      isError: true,
      waitingForInput: true,
      inputType: 'consent_response'
    };
  }

  // ===========================================
  // PASO 3: PROCESAR SEGÚN OPCIÓN
  // ===========================================

  /**
   * Maneja el paso de procesamiento según opción elegida
   * @param {string} input - Input del usuario
   * @param {boolean} isStart - Si es el inicio del paso
   * @returns {Object} Respuesta del flujo
   */
  async handleProcess(input, isStart = false) {
    if (isStart) {
      // Enviar confirmación primero
      logger.info(`⏳ Procesando consulta para ${this.context.userId}, opción ${this.data.selectedOption}`);

      const confirmationMessage = `En qué le podemos servir?`;

      return {
        message: confirmationMessage,
        step: 'process',
        isFinalStep: true,
        actionRequired: true,
        selectedOption: this.data.selectedOption
      };
    }

    // Si llegamos aquí, el flujo está completo
    return this.complete();
  }

  // ===========================================
  // MÉTODOS AUXILIARES
  // ===========================================

  /**
   * Obtiene el mensaje a mostrar según la opción elegida
   * @returns {string} Mensaje correspondiente
   */
  getResponseForOption() {
    const option = this.data.selectedOption;

    switch (option) {
      case 1:
        // Opción 1: Procesar con RAG (ya manejado en message-processor)
        return null; // Indica que se debe procesar con IA

      case 2:
      case 3:
      case 4:
        // Opciones 2, 3, 4: Redirigir a asesor
        return `Comprendo, sumercé. 👩‍💼
El asesor de NORBOY encargado de este tema le atenderá en breve...`;

      default:
        return null;
    }
  }

  /**
   * Verifica si la respuesta requiere intervención humana
   * @returns {boolean}
   */
  requiresHumanAdvisor() {
    const option = this.data.selectedOption;
    return option === 2 || option === 3 || option === 4;
  }

  /**
   * Verifica si el usuario debe responder el menú
   * @returns {boolean}
   */
  isWaitingForMenuSelection() {
    return this.waitingForMenuSelection;
  }

  /**
   * Verifica si el usuario debe responder consentimiento
   * @returns {boolean}
   */
  isWaitingForConsent() {
    return this.waitingForConsent;
  }

  /**
   * Obtiene la opción seleccionada
   * @returns {number|null}
   */
  getSelectedOption() {
    return this.data.selectedOption;
  }

  /**
   * Obtiene el estado de consentimiento
   * @returns {boolean|null}
   */
  getConsentStatus() {
    return this.data.consentGiven;
  }
}

module.exports = NorboyMenuFlow;
