/**
 * ===========================================
 * PROCESADOR DE MENSAJES - FLUJO PRINCIPAL
 * ===========================================
 *
 * PUNTO DE CONTROL ÚNICO para todo mensaje entrante.
 * Implementa todos los puntos de control requeridos.
 *
 * PUNTOS DE CONTROL:
 * - Punto 1: Verificar bot_active
 * - Punto 3: Fallback obligatorio
 * - Punto 4: Control de horario (4:30 PM)
 * - Punto 5: Flujo general
 */

const logger = require('../utils/logger');
const conversationStateService = require('./conversation-state.service');
const escalationService = require('./escalation.service');
const chatService = require('./chat.service');
const whatsappProvider = require('../providers/whatsapp');
const timeSimulation = require('./time-simulation.service');
const numberControlService = require('./number-control.service');
const spamControlService = require('./spam-control.service');
const flowManager = require('../flows'); // ✅ NUEVO: Gestor de flujos

// ✅ NUEVO: Socket.IO para emitir eventos de escalación al dashboard
let io = null;

// ✅ NUEVO: Set para evitar guardar el mismo mensaje dos veces en DynamoDB
const savedMessageIds = new Set();

function setSocketIO(socketIOInstance) {
  io = socketIOInstance;
  logger.info('✅ Socket.IO inicializado en message-processor');
}

// ===========================================
// MENSAJAGES DEL SISTEMA
// ===========================================
const NO_INFO_MESSAGE = 'El asesor de NORBOY 👩‍💼 encargado de este tema le atenderá en breve...';

// ===========================================
// CONFIGURACIÓN DE HORARIO DE ATENCIÓN
// ===========================================
/**
 * Horario de atención - ahora lee de schedule-config.service.js
 * (antes estaba hardcodeado a endHour:16, endMinute:30)
 */
const scheduleConfig = require('./schedule-config.service');

// ===========================================
// ✅ NUEVO: CONFIGURACIÓN DE FLUJO DE MENÚ
// ===========================================
/**
 * Habilita el nuevo flujo de menú NORBOY
 * - true: Usa el nuevo flujo con menú de 4 opciones
 * - false: Usa el flujo original (saludo simple + consentimiento)
 */
const USE_NEW_MENU_FLOW = process.env.USE_NEW_MENU_FLOW === 'true';

// ===========================================
// PUNTO DE CONTROL 5: FLUJO GENERAL
// ===========================================

/**
 * Procesa un mensaje entrante implementando todos los puntos de control
 *
 * @param {string} userId - ID del usuario de WhatsApp
 * @param {string} message - Mensaje recibido
 * @param {Object} options - Opciones adicionales
 * @param {string} options.pushName - Nombre del contacto de WhatsApp
 * @param {string} options.realPhoneNumber - Número real del contacto (wa_id de Meta)
 * @returns {Promise<string|null>} Respuesta a enviar o null si no se debe responder
 */
async function processIncomingMessage(userId, message, options = {}) {
  try {
    const { pushName, realPhoneNumber } = options;
    logger.info(`📨 Procesando mensaje de ${userId}: "${message.substring(0, 50)}..."`);

    // ✅ NUEVO: Flag para evitar guardar el mismo mensaje dos veces
    let userMessageSaved = false;

    // ✅ CORREGIDO: Obtener o crear conversación CON el nombre de WhatsApp y número real
    const conversation = conversationStateService.getOrCreateConversation(userId, {
      whatsappName: pushName,
      realPhoneNumber: realPhoneNumber
    });

    // Actualizar última interacción
    conversation.lastInteraction = Date.now();
    conversation.lastMessage = message;

    // ===========================================
    // PUNTO DE CONTROL -1: SALUDO INSTITUCIONAL OBLIGATORIO
    // ===========================================
    // REGLA CRÍTICA: El PRIMER mensaje del usuario SIEMPRE recibe
    // un saludo institucional, sin importar qué escriba.
    // NO se procesa contenido con RAG hasta que:
    // 1. Se envíe el saludo
    // 2. Se solicite consentimiento
    // 3. El usuario acepte

    if (!conversation.welcomeSent) {
      logger.info(`👋 PRIMER MENSAJE de ${userId} - Enviando saludo obligatorio`);
      logger.info(`   Mensaje original ignorado para RAG: "${message.substring(0, 50)}..."`);

      // Guardar mensaje del usuario (para historial)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }

      // ===========================================
      // ✅ NUEVO: ELEGIR FLUJO (NUEVO O ANTIGUO)
      // ===========================================
      if (USE_NEW_MENU_FLOW) {
        // Usar nuevo flujo de menú
        logger.info(`🆕 Usando NUEVO flujo de menú NORBOY`);

        try {
          // Iniciar flujo de menú
          const flowResult = await flowManager.startFlow(userId, 'norboy-menu', {
            userId: userId,
            originalMessage: message
          });

          // Marcar que ya se envió el saludo
          conversation.welcomeSent = true;
          conversation.interactionCount = 1;
          conversation.activeFlow = 'norboy-menu';

          // Enviar primer mensaje del flujo (saludo)
          if (flowResult.message) {
            await whatsappProvider.sendMessage(userId, flowResult.message);
            await saveMessage(userId, flowResult.message, 'bot', 'welcome');
          }

          // Enviar segundo mensaje del flujo (menú)
          if (flowResult.followUpMessage) {
            await whatsappProvider.sendMessage(userId, flowResult.followUpMessage);
            await saveMessage(userId, flowResult.followUpMessage, 'bot', 'menu');
          }

          logger.info(`✅ Saludo + Menú enviados a ${userId} (nuevo flujo)`);

          return null;
        } catch (flowError) {
          logger.error(`❌ Error iniciando flujo de menú: ${flowError.message}`);
          logger.info(`   → Volviendo al flujo original...`);

          // Si falla el flujo, usar el antiguo como fallback
        }
      }

      // ===========================================
      // FLUJO ORIGINAL (SALUDO SIMPLE)
      // ===========================================
      logger.info(`📋 Usando flujo ORIGINAL (saludo simple)`);

      // Mensaje de saludo institucional
      const welcomeMsg = `Hola! Somos el equipo NORBOY.

Bienvenido/a a nuestro canal de atención.

En un momento le solicitaremos autorización para el tratamiento de sus datos personales.

Mientras tanto, en qué podemos ayudarle?`;

      // Marcar que ya se envió el saludo
      conversation.welcomeSent = true;
      conversation.interactionCount = 1;

      // Enviar saludo
      await whatsappProvider.sendMessage(userId, welcomeMsg);
      await saveMessage(userId, welcomeMsg, 'bot', 'welcome');

      logger.info(`✅ Saludo institucional enviado a ${userId}`);

      // NO procesar más - el siguiente mensaje activará consentimiento
      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 0.5: VERIFICAR SI HAY UN FLUJO ACTIVO (ANTES DE SPAM Y NUMBER-CONTROL)
    // ===========================================
    // ✅ CORREGIDO: El flujo activo se verifica PRIMERO, antes de spam y number-control.
    // Esto evita que inputs válidos del menú ("1", "2", "si", "no") se bloqueen como spam.
    if (flowManager.hasActiveFlow(userId) && USE_NEW_MENU_FLOW) {
      logger.info(`🔄 Procesando mensaje a través del flujo activo para ${userId}`);

      try {
        // Guardar mensaje del usuario (solo una vez)
        if (!userMessageSaved) {
          await saveMessage(userId, message, 'user');
          userMessageSaved = true;
        }

        // ✅ Reiniciar estado de spam al procesar un flujo válido
        spamControlService.resetUserState(userId);

        // Procesar input a través del flujo activo
        const flowResult = await flowManager.handleInput(userId, message);

        if (flowResult) {
          // ✅ CASO 1: Si el flujo se completó o fue cancelado
          if (flowResult.isCompleted || flowResult.isCancelled) {
            // Finalizar flujo
            await flowManager.endFlow(userId);
            conversation.activeFlow = null;

            // Si el usuario rechazó el consentimiento
            if (flowResult.data && flowResult.data.consentGiven === false) {
              conversation.consentStatus = 'rejected';
              conversation.bot_active = false;

              const rejectionMsg = `Entendido, sumercé. Su decisión ha sido registrada.\n\nSi cambia de opinión, puede escribirnos nuevamente.`;

              await whatsappProvider.sendMessage(userId, rejectionMsg);
              await saveMessage(userId, rejectionMsg, 'bot', 'system');

              logger.info(`❌ Usuario rechazó consentimiento - conversación finalizada`);
            }

            return null;
          }

          // ✅ CASO 2: El flujo llegó al paso final (process) con opción seleccionada
          if (flowResult.actionRequired && flowResult.selectedOption) {
            const selectedOption = flowResult.selectedOption;
            logger.info(`📊 Opción seleccionada: ${selectedOption}`);

            if (flowResult.step === 'process') {
              conversation.consentStatus = 'accepted';
              conversation.consentMessageSent = true;

              if (selectedOption === 1) {
                // Opción 1: Enviar confirmación y permitir IA/RAG
                logger.info(`✅ Opción 1 seleccionada - Continuando con IA/RAG`);
                await whatsappProvider.sendMessage(userId, flowResult.message);
                await saveMessage(userId, flowResult.message, 'bot', 'system');

                // Finalizar flujo para que los siguientes mensajes vayan a IA
                await flowManager.endFlow(userId);
                conversation.activeFlow = null;

                return null;
              } else {
                // Opciones 2, 3, 4: Redirigir a asesor
                const advisorMsg = `El asesor de NORBOY 👩‍💼 encargado de este tema le atenderá en breve...`;

                conversation.status = 'pending_advisor';
                conversation.bot_active = false;
                conversation.needs_human = true;
                conversation.needsHumanReason = `menu_option_${selectedOption}`;
                conversation.escalationMessageSent = true;
                conversation.waitingForHuman = true;

                await whatsappProvider.sendMessage(userId, advisorMsg);
                await saveMessage(userId, advisorMsg, 'bot', 'escalation');

                // Finalizar flujo
                await flowManager.endFlow(userId);
                conversation.activeFlow = null;

                logger.info(`✅ Opción ${selectedOption} - Redirigiendo a asesor`);
                return null;
              }
            }
          }

          // ✅ CASO 3: Error en el flujo (opción inválida, respuesta inválida)
          if (flowResult.isError && flowResult.message) {
            await whatsappProvider.sendMessage(userId, flowResult.message);
            await saveMessage(userId, flowResult.message, 'bot', 'flow_error');
            return null;
          }

          // ✅ CASO 4: Mensaje normal del flujo (consent, waiting for input, etc.)
          if (flowResult.message) {
            await whatsappProvider.sendMessage(userId, flowResult.message);
            await saveMessage(userId, flowResult.message, 'bot', 'flow');
            return null;
          }
        }

        // Si el flujo retornó null, continuar con procesamiento normal
        logger.info(`🔄 Flujo procesado correctamente, continuando con procesamiento normal`);

      } catch (flowError) {
        logger.error(`❌ Error procesando flujo activo: ${flowError.message}`);
        logger.error(flowError.stack);

        // Finalizar flujo en caso de error
        await flowManager.endFlow(userId);
        conversation.activeFlow = null;
      }
    }

    // ===========================================
    // PUNTO DE CONTROL 0: CONTROL DE NÚMEROS (IA DESACTIVADA)
    // ===========================================
    // IMPORTANTE: Esta validación se ejecuta DESPUÉS de verificar flujo activo
    // Si el número está en la lista de control con IA desactivada:
    // - NO se genera respuesta con el modelo
    // - NO se consumen tokens
    // - NO se envía mensaje automático
    // El mensaje del usuario SÍ se guarda para que el asesor pueda verlo
    const iaCheck = numberControlService.shouldIARespond(userId);

    if (!iaCheck.shouldRespond) {
      logger.info(`🔴 CONTROL DE NÚMEROS: IA desactivada para ${userId}`);
      logger.info(`   Nombre: ${iaCheck.record?.name || 'Sin nombre'}`);
      logger.info(`   Motivo: ${iaCheck.reason}`);

      // Guardar mensaje del usuario (para que el asesor pueda verlo) - solo si no se guardó antes
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }

      // NO responder automáticamente
      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 0.3: ANTI-SPAM (ANTES DE CONSUMIR TOKENS)
    // ===========================================
    // Detecta mensajes repetidos consecutivos del mismo usuario
    // Si el usuario envía el mismo mensaje 4+ veces: NO se llama a IA
    const spamCheck = spamControlService.evaluateMessage(userId, message, {
      phoneNumber: conversation.phoneNumber,
      userName: conversation.whatsappName || ''
    });

    if (spamCheck.shouldBlock) {
      logger.warn(`🚫 ANTI-SPAM: Bloqueando respuesta para ${userId}`);
      logger.warn(`   Razón: ${spamCheck.reason}`);
      logger.warn(`   IA desactivada automáticamente: ${spamCheck.iaDeactivated}`);
      logger.warn(`   NO se consumen tokens de IA`);

      // Guardar mensaje del usuario (para historial) pero NO responder
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }

      // Marcar conversación como posible spam
      conversation.possibleSpam = true;
      conversation.spamConsecutiveCount = spamCheck.consecutiveCount;

      // Emitir evento al dashboard para notificar bloqueo por spam
      if (io) {
        io.emit('spam-blocked', {
          userId: userId,
          phoneNumber: conversation.phoneNumber,
          reason: spamCheck.reason,
          consecutiveCount: spamCheck.consecutiveCount,
          iaDeactivated: spamCheck.iaDeactivated,
          timestamp: Date.now()
        });
        logger.info(`📢 Evento 'spam-blocked' emitido al dashboard para ${userId}`);
      }

      return null; // NO responder, NO consumir tokens
    }

    // Si hay advertencia de spam (3 repeticiones), loguear pero dejar pasar
    if (spamCheck.isSpam && !spamCheck.shouldBlock) {
      logger.warn(`⚠️ ANTI-SPAM: Advertencia para ${userId} - ${spamCheck.reason}`);
      logger.warn(`   Próxima repetición será BLOQUEADA (sin tokens)`);
    }

    // ===========================================
    // PUNTO DE CONTROL 0.5: SOLICITAR CONSENTIMIENTO (SEGUNDO MENSAJE) - FLUJO ORIGINAL
    // ===========================================
    // Si ya se envió saludo pero NO se ha solicitado consentimiento,
    // este es el SEGUNDO mensaje - solicitar consentimiento
    if (conversation.welcomeSent &&
      !conversation.consentMessageSent &&
      conversation.consentStatus === 'pending') {

      logger.info(`📋 SEGUNDO MENSAJE de ${userId} - Solicitando consentimiento`);
      logger.info(`   Mensaje guardado como pendiente: "${message.substring(0, 50)}..."`);

      // Guardar mensaje del usuario (pendiente para después) - solo si no se guardó antes
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }

      // Guardar mensaje pendiente para responder después de aceptar
      chatService.clearPendingMessage(userId);
      // Nota: El mensaje pendiente se manejará cuando acepte

      // Mensaje de consentimiento
      const consentMsg = `👋 ¡Gracias por escribirnos!

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

1. Si
2. No`;

      // Marcar que se solicitó consentimiento
      conversation.consentMessageSent = true;
      conversation.interactionCount = 2;

      // Enviar mensaje de consentimiento
      await whatsappProvider.sendMessage(userId, consentMsg);
      await saveMessage(userId, consentMsg, 'bot', 'consent');

      logger.info(`✅ Mensaje de consentimiento enviado a ${userId}`);

      // NO procesar más - esperar respuesta de consentimiento
      return null;
    }

    // ===========================================
    // VERIFICACIÓN DE CONSENTIMIENTO (RESPUESTA)
    // ===========================================
    // Si el consentimiento está solicitado, verificar la respuesta del usuario
    if (conversation.consentMessageSent === true && conversation.consentStatus === 'pending') {
      const normalizedMessage = message.toLowerCase().trim();
      logger.info(`📋 Verificando respuesta de consentimiento: "${normalizedMessage}"`);

      // ✅ NUEVO: Guardar mensaje del usuario PRIMERO (para que aparezca en el dashboard)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user', 'consent_response');
        userMessageSaved = true;
      }

      // Verificar si acepta
      if (normalizedMessage === 'si' || normalizedMessage === 'sí' ||
        normalizedMessage === '1' || normalizedMessage.includes('acept')) {
        logger.info(`✅ Usuario ${userId} ACEPTÓ el consentimiento`);

        // ✅ NUEVO: Enviar mensaje de verificación temporal
        const verifyingMsg = `⏳ Verificando su respuesta, por favor espere...`;
        await saveMessage(userId, verifyingMsg, 'bot', 'processing');

        chatService.setConsentResponse(userId, true);
        conversation.consentStatus = 'accepted';
        conversation.consentMessageSent = false;

        // Enviar confirmación
        const confirmationMsg = `¡Perfecto, sumercé! 👍\n\nAhora puedo asesorarte.\n\n¿En qué puedo ayudarte?`;
        await whatsappProvider.sendMessage(userId, confirmationMsg);
        await saveMessage(userId, confirmationMsg, 'bot', 'system');

        return null; // No procesar más este mensaje
      }

      // Verificar si rechaza
      if (normalizedMessage === 'no' || normalizedMessage === '2' ||
        normalizedMessage.includes('rechaz')) {
        logger.info(`❌ Usuario ${userId} RECHAZÓ el consentimiento`);

        // ✅ NUEVO: Enviar mensaje de verificación temporal
        const verifyingMsg = `⏳ Verificando su respuesta, por favor espere...`;
        await saveMessage(userId, verifyingMsg, 'bot', 'processing');

        chatService.setConsentResponse(userId, false);
        conversation.consentStatus = 'rejected';
        conversation.consentMessageSent = false;
        conversation.bot_active = false; // Desactivar bot

        // Enviar mensaje de rechazo
        const rejectionMsg = `Entendido, sumercé. Su decisión ha sido registrada.\n\nSi cambia de opinión, puede escribirnos nuevamente.`;
        await whatsappProvider.sendMessage(userId, rejectionMsg);
        await saveMessage(userId, rejectionMsg, 'bot', 'system');

        return null; // No procesar más este mensaje
      }
    }

    // ✅ NUEVO: Log del estado actual al recibir mensaje
    logger.debug(`🔍 Estado INICIAL de conversación ${userId}:`);
    logger.debug(`   bot_active: ${conversation.bot_active}`);
    logger.debug(`   status: ${conversation.status}`);
    logger.debug(`   waitingForHuman: ${conversation.waitingForHuman}`);
    logger.debug(`   escalationMessageSent: ${conversation.escalationMessageSent}`);

    // ===========================================
    // PUNTO DE CONTROL 1: BOT ACTIVO?
    // ===========================================
    // Si el bot está desactivado, NO responder automáticamente
    if (conversation.bot_active === false) {
      logger.info(`🔴 Bot DESACTIVADO para ${userId}. No se responde automáticamente.`);
      logger.info(`   Razón: Estado actual = ${conversation.status}`);
      logger.info(`   Desactivado por: ${conversation.botDeactivatedBy || 'sistema'}`);
      logger.debug(`🔍 Estado conversación ${userId}:`);
      logger.debug(`   bot_active: ${conversation.bot_active}`);
      logger.debug(`   status: ${conversation.status}`);
      logger.debug(`   waitingForHuman: ${conversation.waitingForHuman}`);

      // Guardar mensaje pero NO responder (solo si no se guardó antes)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }

      // Si está en estado advisor_handled, no hacer nada más
      // El asesor está atendiendo manualmente
      return null;
    }

    // ===========================================
    // NUEVA REGLA: ESPERA POR ASESOR (evitar repetición)
    // ===========================================
    // Si ya está esperando asesor y YA se envió el mensaje de escalación,
    // NO responder nada más. Solo guardar el mensaje.
    if (conversation.waitingForHuman === true) {
      logger.info(`⏸️ Usuario ${userId} está esperando asesor. NO se responde.`);
      logger.info(`   escalationMessageSent: ${conversation.escalationMessageSent}`);
      logger.info(`   Mensaje del usuario guardado: "${message.substring(0, 50)}..."`);

      // Solo guardar el mensaje del usuario (si no se guardó antes)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }
      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 4: HORARIO DE ATENCIÓN
    // ===========================================
    if (await isOutOfHours()) {
      logger.info(`🌙 Fuera de horario para ${userId}`);

      // Solo enviar mensaje de fuera de horario si NO se ha enviado antes
      if (conversation.escalationMessageSent === true) {
        logger.info(`   Mensaje de fuera de horario ya enviado. Solo guardando mensaje.`);
        if (!userMessageSaved) {
          await saveMessage(userId, message, 'user');
          userMessageSaved = true;
        }
        return null;
      }

      const outOfHoursMsg = await getOutOfHoursMessage();

      // Actualizar estado
      conversation.status = 'out_of_hours';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.escalationMessageSent = true;
      conversation.waitingForHuman = true;
      conversation.lastEscalationMessageAt = Date.now();

      // Enviar mensaje de fuera de horario
      await whatsappProvider.sendMessage(userId, outOfHoursMsg);

      // Guardar mensajes (solo si no se guardó antes)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }
      await saveMessage(userId, outOfHoursMsg, 'bot', 'out_of_hours');

      // ✅ NUEVO: Emitir evento de escalación al dashboard
      if (io) {
        io.emit('escalation-detected', {
          userId: userId,
          phoneNumber: conversation.phoneNumber,
          reason: 'out_of_hours',
          priority: 'low',
          message: message,
          type: 'out_of_hours',
          timestamp: Date.now()
        });
        logger.info(`📢 Evento 'escalation-detected' emitido (fuera de horario) para ${userId}`);
      }

      logger.info(`✅ Mensaje fuera de horario enviado a ${userId}`);

      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 3: EVALUAR ESCALACIÓN (ANTES DE IA)
    // ===========================================
    // IMPORTANTE: Evaluar escalación ANTES de llamar a OpenAI para:
    // 1. Ahorrar tokens de OpenAI
    // 2. Responder más rápido
    // 3. Escalar correctamente cuando el usuario lo pide

    const interactionCount = conversation.interactionCount || 0;
    const escalation = escalationService.evaluateEscalation(userId, message, interactionCount);

    if (escalation.needsHuman) {
      logger.info(`🚨 Escalación detectada para ${userId}: ${escalation.reason}`);
      logger.info(`   Prioridad: ${escalation.priority}`);

      // Verificar que no se haya enviado ya el mensaje de escalación
      if (conversation.escalationMessageSent === true) {
        logger.info(`   Mensaje de escalación ya enviado. Solo guardando mensaje.`);
        if (!userMessageSaved) {
          await saveMessage(userId, message, 'user');
          userMessageSaved = true;
        }
        return null;
      }

      // Mensaje de escalación
      const escalationMsg = `El asesor de NORBOY 👩‍💼 encargado de este tema le atenderá en breve...`;

      // Actualizar estado de la conversación
      conversation.status = 'pending_advisor';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.needsHumanReason = escalation.reason;
      conversation.escalationMessageSent = true;
      conversation.waitingForHuman = true;
      conversation.lastEscalationMessageAt = Date.now();

      logger.info(`📊 Estado cambiado a: pending_advisor`);
      logger.info(`   → bot_active: false`);
      logger.info(`   → waitingForHuman: true`);

      // Guardar mensajes (solo si no se guardó antes)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }
      await saveMessage(userId, escalationMsg, 'bot', 'escalation');

      // Enviar mensaje de escalación
      await whatsappProvider.sendMessage(userId, escalationMsg);

      // ✅ NUEVO: Emitir evento de escalación al dashboard
      if (io) {
        io.emit('escalation-detected', {
          userId: userId,
          phoneNumber: conversation.phoneNumber,
          reason: escalation.reason,
          priority: escalation.priority,
          message: message,
          detectedKeyword: escalation.detectedKeyword,
          timestamp: Date.now()
        });
        logger.info(`📢 Evento 'escalation-detected' emitido al dashboard para ${userId}`);
      }

      logger.info(`✅ Mensaje de escalación enviado a ${userId}`);

      return null;
    }

    // ===========================================
    // PUNTO DE CONTROL 4: PROCESAR MENSAJE CON IA
    // ===========================================
    // NOTA: Si llegamos aquí, el usuario ya:
    // 1. Recibió saludo de bienvenida
    // 2. Aceptó el consentimiento de datos
    // Por lo tanto, skipConsent=true para evitar duplicación

    // Intentar generar respuesta con la IA
    let response;
    try {
      response = await chatService.generateTextResponse(userId, message, {
        skipConsent: true  // Consentimiento ya validado en message-processor
      });
    } catch (aiError) {
      logger.error(`Error en IA para ${userId}:`, aiError);
      response = null;
    }

    // ===========================================
    // MANEJO DE RESPUESTA DE ESCALACIÓN
    // ===========================================
    // chatService puede retornar un objeto de escalación { type, text, needsHuman }
    let responseText = null;
    let isEscalation = false;

    if (response && typeof response === 'object' &&
      (response.type === 'escalation' || response.type === 'escalation_no_info')) {

      // Es una respuesta de escalación desde chatService
      isEscalation = true;
      responseText = response.text || NO_INFO_MESSAGE;

      const escalationReason = response.escalation?.reason || 'unknown';

      logger.info(`🚨 Escalación detectada desde chatService para ${userId}`);
      logger.info(`   Razón: ${escalationReason}`);
      logger.info(`   Tipo: ${response.type}`);

      // Actualizar estado de la conversación
      if (!conversation.escalationMessageSent) {
        conversation.status = 'pending_advisor';
        conversation.bot_active = false;
        conversation.needs_human = true;
        conversation.needsHumanReason = escalationReason;
        conversation.escalationMessageSent = true;
        conversation.waitingForHuman = true;
        conversation.lastEscalationMessageAt = Date.now();

        logger.info(`📊 Estado actualizado para ${userId}:`);
        logger.info(`   → status: pending_advisor`);
        logger.info(`   → bot_active: false`);
        logger.info(`   → waitingForHuman: true`);
        logger.info(`   → escalationMessageSent: true`);
      }

      // Guardar mensajes (solo si no se guardó antes)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }

      // ✅ CORRECCIÓN: Pasar el objeto response completo si tiene type especial
      if (typeof response === 'object' && response.type) {
        await saveMessage(userId, response, 'bot', response.type);
      } else {
        await saveMessage(userId, responseText, 'bot', 'text');
      }

      // Enviar mensaje de escalación
      await whatsappProvider.sendMessage(userId, responseText);

      // ✅ NUEVO: Emitir evento de escalación al dashboard
      if (io) {
        io.emit('escalation-detected', {
          userId: userId,
          phoneNumber: conversation.phoneNumber,
          reason: escalationReason,
          priority: response.escalation?.priority || 'medium',
          message: message,
          type: response.type,
          timestamp: Date.now()
        });
        logger.info(`📢 Evento 'escalation-detected' emitido al dashboard para ${userId}`);
      }

      logger.info(`✅ Mensaje de escalación enviado a ${userId}: "${responseText}"`);

      return null; // No enviar nada más (ya se envió arriba)
    }

    // Extraer texto de la respuesta si es un objeto con propiedad 'text'
    if (response && typeof response === 'object' && response.text) {
      responseText = response.text;
    } else if (typeof response === 'string') {
      responseText = response;
    }

    // ===========================================
    // PUNTO DE CONTROL 3: FALLBACK OBLIGATORIO
    // ===========================================
    if (!responseText || responseText === null || responseText === undefined) {
      logger.warn(`⚠️ Sin respuesta para ${userId}. Activando fallback.`);
      logger.warn(`   Mensaje: "${message.substring(0, 100)}..."`);

      // IMPORTANTE: Solo enviar el mensaje de fallback si NO se ha enviado antes
      if (conversation.escalationMessageSent === true) {
        logger.info(`   Mensaje de escalación ya enviado. Solo guardando mensaje.`);
        if (!userMessageSaved) {
          await saveMessage(userId, message, 'user');
          userMessageSaved = true;
        }
        return null;
      }

      const fallbackMsg = "Su mensaje se procesará cuanto antes.";

      // Actualizar estado a pendiente de asesor
      conversation.status = 'pending_advisor';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.needsHumanReason = 'no_response_found';

      // NUEVO: Marcar que ya se envió el mensaje y está esperando
      conversation.escalationMessageSent = true;
      conversation.waitingForHuman = true;
      conversation.lastEscalationMessageAt = Date.now();

      logger.info(`📊 Estado cambiado a: pending_advisor (fallback)`);
      logger.info(`   → bot_active: false`);
      logger.info(`   → waitingForHuman: true`);

      // Enviar mensaje de fallback (SOLO UNA VEZ)
      await whatsappProvider.sendMessage(userId, fallbackMsg);

      // Guardar mensajes (solo si no se guardó antes)
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
        userMessageSaved = true;
      }
      await saveMessage(userId, fallbackMsg, 'bot', 'escalation_fallback');

      // ✅ NUEVO: Emitir evento de escalación al dashboard
      if (io) {
        io.emit('escalation-detected', {
          userId: userId,
          phoneNumber: conversation.phoneNumber,
          reason: 'no_response_found',
          priority: 'medium',
          message: message,
          type: 'escalation_fallback',
          timestamp: Date.now()
        });
        logger.info(`📢 Evento 'escalation-detected' emitido (fallback) para ${userId}`);
      }

      logger.info(`🚨 Usuario ${userId} escalado a asesor (fallback)`);

      return null;
    }

    // ===========================================
    // RESPUESTA EXITOSA
    // ===========================================
    logger.info(`✅ Respuesta generada para ${userId}: "${responseText.substring(0, 50)}..."`);

    // Guardar mensajes (solo si no se guardó antes)
    if (!userMessageSaved) {
      await saveMessage(userId, message, 'user');
      userMessageSaved = true;
    }

    // ✅ CORRECCIÓN: Pasar el objeto response completo si tiene type especial
    // Esto preserva el type 'consent', 'system', 'escalation', etc.
    if (typeof response === 'object' && response.type) {
      // Es un objeto con type especial (consent, system, escalation, etc.)
      await saveMessage(userId, response, 'bot', response.type);
    } else {
      // Es una respuesta de texto normal
      await saveMessage(userId, responseText, 'bot', 'text');
    }

    return responseText;

  } catch (error) {
    logger.error(`Error crítico procesando mensaje de ${userId}:`, error);

    // En caso de error crítico, también escalar
    try {
      const fallbackMsg = "Su mensaje se procesará cuanto antes.";

      const conversation = conversationStateService.getOrCreateConversation(userId);
      conversation.status = 'pending_advisor';
      conversation.bot_active = false;
      conversation.needs_human = true;
      conversation.needsHumanReason = 'processing_error';

      await whatsappProvider.sendMessage(userId, fallbackMsg);
      if (!userMessageSaved) {
        await saveMessage(userId, message, 'user');
      }
      await saveMessage(userId, fallbackMsg, 'bot');

      logger.error(`🚨 Usuario ${userId} escalado a asesor (error)`);

    } catch (fallbackError) {
      logger.error(`Error incluso en fallback:`, fallbackError);
    }

    return null;
  }
}

/**
 * Verifica si estamos fuera del horario de atención
 * Horario: hasta las 4:30 PM (16:30)
 * ✅ VERIFICA DÍAS FESTIVOS Y HORARIO (ambos controlados por el botón de horario)
 *
 * @returns {boolean} true si está fuera de horario
 */
async function isOutOfHours() {
  // ✅ NUEVO: Verificar SIEMPRE si hoy es día festivo (independientemente de la verificación de horario)
  try {
    const holidaysService = require('./holidays.service');
    const isTodayHoliday = await holidaysService.isTodayHoliday();

    if (isTodayHoliday) {
      const holidayName = await holidaysService.getHolidayName(new Date());
      logger.info(`🎉 Hoy es DÍA FESTIVO: ${holidayName}. El bot no responderá.`);
      return true; // Considerar como fuera de horario
    }
  } catch (error) {
    logger.warn('Error verificando día festivo, continuando sin esta validación:', error.message);
  }

  // ✅ NUEVO: Verificar si la verificación de horario está desactivada
  if (!timeSimulation.isScheduleCheckEnabled()) {
    logger.debug(`⏰ Verificación de horario DESACTIVADA. Se permite respuesta.`);
    return false;
  }

  // ✅ ACTUALIZADO: Lee horario de schedule-config.service.js (configurable desde dashboard)
  const time = timeSimulation.getCurrentTime();
  const currentTimeDecimal = time.decimal;
  const cfg = scheduleConfig.getConfig();

  const now = new Date();
  const day = now.getDay(); // 0=Dom, 6=Sáb

  // Domingo
  if (day === 0 && !cfg.sunday.enabled) {
    logger.debug('⏰ Hoy es domingo - Fuera de horario');
    return true;
  }

  // Sábado
  if (day === 6) {
    if (!cfg.saturday.enabled) {
      logger.debug('⏰ Hoy es sábado - No se atiende');
      return true;
    }
    const satStart = cfg.saturday.start;
    const satEndDecimal = cfg.saturday.endHour + (cfg.saturday.endMinute / 60);
    const outOfSat = currentTimeDecimal < satStart || currentTimeDecimal > satEndDecimal;
    logger.debug(`⏰ Sábado: ${time.timeString} ${outOfSat ? 'FUERA' : 'DENTRO'} de ${satStart}:00-${cfg.saturday.endHour}:${cfg.saturday.endMinute.toString().padStart(2, '0')}`);
    return outOfSat;
  }

  // Lunes a Viernes
  const startDecimal = cfg.weekdays.start;
  const endTimeDecimal = cfg.weekdays.endHour + (cfg.weekdays.endMinute / 60);
  const isOutside = currentTimeDecimal < startDecimal || currentTimeDecimal > endTimeDecimal;

  if (isOutside || timeSimulation.isSimulationActive()) {
    const timeSource = timeSimulation.isSimulationActive()
      ? `HORA SIMULADA: ${timeSimulation.getSimulatedTime()}`
      : `Horario actual: ${time.timeString} (${time.timezone})`;

    logger.debug(`⏰ ${timeSource} → ${isOutside ? 'FUERA' : 'DENTRO'} de ${cfg.weekdays.start}:00-${cfg.weekdays.endHour}:${cfg.weekdays.endMinute.toString().padStart(2, '0')}`);
  }

  return isOutside;
}

/**
 * PUNTO DE CONTROL 4: Mensaje fuera de horario
 *
 * @returns {Promise<string>} Mensaje de fuera de horario
 */
async function getOutOfHoursMessage() {
  // Generar mensaje con horarios dinámicos desde la configuración
  const sched = scheduleConfig.getFormattedSchedule();

  // Verificar si hoy es festivo para personalizar el mensaje
  try {
    const holidaysService = require('./holidays.service');
    const isTodayHoliday = await holidaysService.isTodayHoliday();

    if (isTodayHoliday) {
      const holidayName = await holidaysService.getHolidayName(new Date());
      return `🎉 Hoy es ${holidayName}\n\nNuestro horario de atención es:\n\n📅 Lunes a Viernes: ${sched.weekdaysLabel}\n📅 Sábados: ${sched.saturdayLabel}\n\nSu mensaje será atendido en el siguiente día hábil. Gracias por su comprensión.`;
    }
  } catch (error) {
    logger.warn('Error verificando festivo para mensaje:', error.message);
  }

  return `Nuestro horario de atención es:\n\n📅 Lunes a Viernes: ${sched.weekdaysLabel}\n📅 Sábados: ${sched.saturdayLabel}\n❌ Domingos: ${sched.sundayLabel}\n\nSu mensaje será atendido en el siguiente horario hábil. Gracias por su comprensión.`;
}

/**
 * Guarda un mensaje en el historial
 *
 * ✅ OPCIÓN 3 - HÍBRIDA:
 * - Guarda en memoria (últimos 50) para acceso rápido
 * - Guarda en DynamoDB para persistencia real
 *
 * @param {string} userId - ID del usuario
 * @param {string|Object} message - Contenido del mensaje (objeto si tiene type especial)
 * @param {string} sender - 'user' | 'bot' | 'admin' | 'system'
 * @param {string} messageType - 'text' | 'consent' | 'system' | 'escalation' (opcional)
 */
async function saveMessage(userId, message, sender, messageType = 'text') {
  try {
    // Obtener conversación
    const conversation = conversationStateService.getConversation(userId);
    if (!conversation) {
      logger.warn(`Conversación no encontrada para ${userId}`);
      return;
    }

    // ✅ CORRECCIÓN: Extraer type del mensaje si es un objeto
    let messageText = message;
    let messageActualType = messageType;

    if (typeof message === 'object' && message !== null) {
      // Si es un objeto con propiedad 'type' (ej: consent, escalation, system)
      if (message.type) {
        messageActualType = message.type;
      }
      // Extraer el texto del mensaje
      if (message.text) {
        messageText = message.text;
      } else if (message.message) {
        messageText = message.message;
      }
    }

    // Crear objeto de mensaje
    const messageRecord = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      conversationId: userId,
      participantId: userId, // Para DynamoDB
      sender: sender,
      message: messageText,
      timestamp: Date.now(),
      type: messageActualType,
      direction: sender === 'user' ? 'incoming' : 'outgoing'
    };

    // ===========================================
    // ✅ OPCIÓN 3 - HÍBRIDA
    // ===========================================

    // 1. Guardar en memoria (últimos 50 para acceso rápido)
    if (!conversation.messages) {
      conversation.messages = [];
    }
    conversation.messages.push(messageRecord);

    // Limitar a últimos 50 en memoria
    if (conversation.messages.length > 50) {
      conversation.messages = conversation.messages.slice(-50);
    }

    // Actualizar último mensaje
    conversationStateService.updateLastMessage(userId, messageText);
    conversation.lastInteraction = Date.now();

    // 2. Guardar en DynamoDB (persistencia real) - asíncrono, no bloquea
    // ✅ DEDUP: Verificar que no se haya guardado ya este mensaje
    if (savedMessageIds.has(messageRecord.id)) {
      logger.debug(`⏭️ [DEDUP] Mensaje ya en cola para DynamoDB: ${messageRecord.id}`);
    } else {
      savedMessageIds.add(messageRecord.id);

      // Limpiar IDs antiguos para evitar memory leak
      if (savedMessageIds.size > 1000) {
        const idsArray = Array.from(savedMessageIds);
        idsArray.slice(0, 500).forEach(id => savedMessageIds.delete(id));
      }

      // Usamos setImmediate para no bloquear la respuesta del webhook
      setImmediate(async () => {
        try {
          const conversationRepository = require('../repositories/conversation.repository');

          // Crear modelo Message para DynamoDB
          const { Message } = require('../models/message.model');
          const dynamoMessage = new Message({
            id: messageRecord.id,
            conversationId: userId,
            participantId: userId,
            direction: sender === 'user' ? 'incoming' : 'outgoing',
            type: messageActualType === 'text' ? 'text' : messageActualType,
            content: { text: messageText },
            from: sender === 'user' ? userId : undefined,
            to: sender === 'bot' ? userId : undefined,
            status: 'delivered',
            metadata: {
              sender: sender,
              originalType: messageActualType
            },
            createdAt: new Date(messageRecord.timestamp),
            updatedAt: new Date()
          });

          // Guardar en DynamoDB (con protección attribute_not_exists en el repo)
          await conversationRepository.saveMessage(dynamoMessage);
          // Log se emite desde el repositorio para evitar duplicación

        } catch (dbError) {
          logger.error(`❌ [DYNAMODB] Error guardando mensaje ${messageRecord.id}:`, dbError.message);

          // No lanzamos el error para no interrumpir el flujo
        }
      });
    }

    // ✅ MEJORADO: Log detallado para depuración
    logger.info(`💾 [MEMORIA] Mensaje guardado: [${sender}] type=${messageActualType} "${messageText.substring(0, 50)}"`);
    logger.info(`   → ID: ${messageRecord.id}`);
    logger.info(`   → Usuario: ${userId}`);
    logger.info(`   → Total en memoria: ${conversation.messages.length}/50`);

    // ✅ NUEVO: Emitir evento Socket.IO para actualizar dashboard en tiempo real
    if (io) {
      io.emit('new-message', {
        userId: userId,
        phoneNumber: conversation.phoneNumber,
        whatsappName: conversation.whatsappName || '',
        message: messageRecord,
        timestamp: Date.now()
      });
      logger.info(`📡 [SOCKET] Evento 'new-message' EMITIDO para ${userId}`);
      logger.info(`   → Mensaje: "${messageText.substring(0, 50)}"`);
    } else {
      logger.warn(`⚠️ Socket.IO NO disponible - mensaje no emitido en tiempo real`);
    }
  } catch (error) {
    logger.error('Error guardando mensaje:', error);
  }
}

/**
 * Obtiene el historial de mensajes de una conversación
 *
 * @param {string} userId - ID del usuario
 * @returns {Array} Lista de mensajes
 */
function getMessages(userId) {
  const conversation = conversationStateService.getConversation(userId);

  if (!conversation) {
    return [];
  }

  // TODO: Implementar recuperación desde base de datos
  // Por ahora, retornar array vacío o desde memoria
  return conversation.messages || [];
}

/**
 * Obtiene estadísticas del procesador
 *
 * @returns {Promise<Object>} Estadísticas
 */
async function getStats() {
  const all = conversationStateService.getAllConversations();

  const botActive = all.filter(c => c.bot_active === true).length;
  const botInactive = all.filter(c => c.bot_active === false).length;
  const needsHuman = all.filter(c => c.needs_human === true).length;
  const outOfHours = all.filter(c => c.status === 'out_of_hours').length;

  return {
    total: all.length,
    botActive,
    botInactive,
    needsHuman,
    outOfHours,
    isOutOfHoursNow: await isOutOfHours(),
    businessHours: BUSINESS_HOURS
  };
}

module.exports = {
  processIncomingMessage,
  isOutOfHours,
  getOutOfHoursMessage,
  getMessages,
  getStats,
  setSocketIO  // ✅ NUEVO: Para inicializar Socket.IO
};
