/**
 * Agent DOC PIIA — Teams Middleware
 * ==================================
 * Recibe mensajes de Microsoft Teams via Bot Framework
 * y los reenvía al agente PIAA en CortexAgentHub.
 * 
 * Variables de entorno requeridas:
 *   BOT_APP_ID          - Microsoft App ID del Azure Bot
 *   BOT_APP_PASSWORD    - Client Secret del App Registration
 *   CORTEX_API_URL      - URL del backend de AgentHub
 *   CORTEX_FLOW_ID      - UUID del agente/flow en AgentHub
 *   CORTEX_CHANNEL_ID   - UUID del canal Teams en AgentHub
 */

const express = require('express');
const { BotFrameworkAdapter, ActivityTypes, TurnContext } = require('botbuilder');
const fetch = require('node-fetch');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const PORT = process.env.PORT || 3000;

const CONFIG = {
  botAppId: process.env.BOT_APP_ID || '',
  botAppPassword: process.env.BOT_APP_PASSWORD || '',
  cortexApiUrl: (process.env.CORTEX_API_URL || 'https://app-back-cortexagentshub-test.azurewebsites.net').replace(/\/$/, ''),
  cortexFlowId: process.env.CORTEX_FLOW_ID || '',
  cortexChannelId: process.env.CORTEX_CHANNEL_ID || '',
};

// Validar config al arrancar
const missing = Object.entries(CONFIG)
  .filter(([key, val]) => !val && key !== 'cortexApiUrl')
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(`❌ Variables de entorno faltantes: ${missing.join(', ')}`);
  console.error('Configura las variables en Railway y reinicia.');
}

// ============================================================
// BOT FRAMEWORK ADAPTER
// ============================================================

const adapter = new BotFrameworkAdapter({
  channelAuthTenant: "901d036d-69a0-48e1-b908-8fdc38f0030e",
  appId: CONFIG.botAppId,
  appPassword: CONFIG.botAppPassword,
});

// Error handler
adapter.onTurnError = async (context, error) => {
  console.error(`[Bot Error] ${error.message}`);
  console.error(error.stack);
  
  try {
    await context.sendActivity('⚠️ Ocurrió un error procesando tu consulta. Por favor intenta de nuevo.');
  } catch (sendError) {
    console.error('[Bot Error] No se pudo enviar mensaje de error:', sendError.message);
  }
};

// ============================================================
// MAPA DE CONVERSACIONES (para mantener contexto)
// ============================================================

// Mapea teamsConversationId → cortexSessionId
const sessionMap = new Map();

// Limpiar sesiones viejas cada hora
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [key, val] of sessionMap.entries()) {
    if (val.lastActivity < oneHourAgo) {
      sessionMap.delete(key);
    }
  }
}, 60 * 60 * 1000);

// ============================================================
// ENVIAR MENSAJE A CORTEX AGENTHUB
// ============================================================

async function sendToCortex(message, userId, userName, conversationId) {
  // Obtener o crear sesión
  let session = sessionMap.get(conversationId);
  if (!session) {
    session = {
      sessionId: `teams-piaa-${conversationId}-${Date.now()}`,
      lastActivity: Date.now(),
    };
    sessionMap.set(conversationId, session);
  }
  session.lastActivity = Date.now();

  // Endpoint de AgentHub para enviar mensaje al agente
  const url = `${CONFIG.cortexApiUrl}/api/v1/channels/${CONFIG.cortexChannelId}/messages`;

  const payload = {
    message: message,
    sessionId: session.sessionId,
    flowId: CONFIG.cortexFlowId,
    sender: {
      id: userId,
      name: userName,
      platform: 'teams',
    },
    metadata: {
      source: 'teams-middleware',
      conversationId: conversationId,
    },
  };

  console.log(`[Cortex] POST ${url}`);
  console.log(`[Cortex] Payload:`, JSON.stringify({ ...payload, message: message.substring(0, 100) }));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeout: 30000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Cortex] Error ${response.status}: ${errorText}`);
      
      // Intentar endpoint alternativo si el primero falla
      return await sendToCortexAlternative(message, userId, userName, session.sessionId);
    }

    const data = await response.json();
    console.log(`[Cortex] Response OK:`, JSON.stringify(data).substring(0, 200));

    // Extraer texto de respuesta (manejar diferentes formatos de AgentHub)
    if (data.text) return data.text;
    if (data.message) return data.message;
    if (data.response) return data.response;
    if (data.data?.text) return data.data.text;
    if (data.data?.message) return data.data.message;
    if (data.data?.response) return data.data.response;
    
    // Si es un array de messages
    if (Array.isArray(data.messages) && data.messages.length > 0) {
      return data.messages
        .filter(m => m.role === 'assistant' || m.type === 'bot')
        .map(m => m.text || m.content || m.message)
        .join('\n');
    }

    console.warn('[Cortex] Formato de respuesta no reconocido:', JSON.stringify(data));
    return 'Recibí tu consulta pero no pude procesar la respuesta. Intenta de nuevo.';
    
  } catch (error) {
    console.error(`[Cortex] Fetch error: ${error.message}`);
    return await sendToCortexAlternative(message, userId, userName, session.sessionId);
  }
}

/**
 * Endpoint alternativo — intenta con /api/v1/agents/:flowId/chat
 * Útil si el endpoint de channels no funciona
 */
async function sendToCortexAlternative(message, userId, userName, sessionId) {
  const url = `${CONFIG.cortexApiUrl}/api/v1/agents/${CONFIG.cortexFlowId}/chat`;

  const payload = {
    message: message,
    sessionId: sessionId,
    user: {
      id: userId,
      name: userName,
    },
  };

  console.log(`[Cortex-Alt] POST ${url}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 30000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Cortex-Alt] Error ${response.status}: ${errorText}`);
      return '⚠️ No pude conectar con el agente PIAA. El servicio puede estar temporalmente no disponible.';
    }

    const data = await response.json();
    return data.text || data.message || data.response || 
           data.data?.text || data.data?.message ||
           'Recibí tu consulta pero no pude procesar la respuesta.';
  } catch (error) {
    console.error(`[Cortex-Alt] Error: ${error.message}`);
    return '⚠️ Error de conexión con el agente PIAA. Por favor intenta en unos minutos.';
  }
}

// ============================================================
// HANDLER DE MENSAJES
// ============================================================

async function onMessage(context) {
  // Solo procesar mensajes de texto
  if (context.activity.type !== ActivityTypes.Message) {
    return;
  }

  // Limpiar texto (remover mentions del bot)
  let userMessage = context.activity.text || '';
  
  // Remover <at>BotName</at> tags
  userMessage = userMessage.replace(/<at>.*?<\/at>/gi, '').trim();
  // Remover &nbsp; y espacios extras
  userMessage = userMessage.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  if (!userMessage) {
    await context.sendActivity('👋 ¡Hola! Soy PIAA, el asistente de auditoría médica de Saludsa. ¿En qué puedo ayudarte?');
    return;
  }

  console.log(`[Teams] Mensaje de ${context.activity.from.name}: "${userMessage.substring(0, 100)}"`);

  // Indicador de escritura
  await context.sendActivity({ type: ActivityTypes.Typing });

  // Enviar a Cortex y obtener respuesta
  const userId = context.activity.from.aadObjectId || context.activity.from.id;
  const userName = context.activity.from.name || 'Usuario';
  const conversationId = context.activity.conversation.id;

  const response = await sendToCortex(userMessage, userId, userName, conversationId);

  // Enviar respuesta a Teams
  await context.sendActivity({
    type: ActivityTypes.Message,
    text: response,
    textFormat: 'markdown',
  });

  console.log(`[Teams] Respuesta enviada a ${userName} (${response.length} chars)`);
}

// Manejar cuando agregan el bot a una conversación
async function onMembersAdded(context) {
  const membersAdded = context.activity.membersAdded;
  for (const member of membersAdded) {
    if (member.id !== context.activity.recipient.id) {
      await context.sendActivity(
        '🏥 **¡Hola! Soy PIAA** — Plan Integral de Atención y Asistencia.\n\n' +
        'Soy el asistente de auditoría médica de Saludsa. Puedo ayudarte con:\n\n' +
        '• Consultas de **cobertura** por tipo de plan\n' +
        '• Verificación de **medicamentos** en el Vademécum\n' +
        '• Reglas de **emergencias y urgencias**\n' +
        '• Lineamientos de **auditoría de reembolsos**\n' +
        '• Información sobre **terapias, vacunas, prótesis**\n' +
        '• Clasificación de **Manchester** (triaje)\n\n' +
        'Escríbeme tu consulta y te ayudo. 💬'
      );
    }
  }
}

// ============================================================
// EXPRESS SERVER
// ============================================================

const app = express();

// Health check
app.get('/', (req, res) => {
  res.json({
    agent: 'DOC PIIA',
    status: 'online',
    version: '1.0.0',
    config: {
      botAppId: CONFIG.botAppId ? '✅ set' : '❌ missing',
      botAppPassword: CONFIG.botAppPassword ? '✅ set' : '❌ missing',
      cortexFlowId: CONFIG.cortexFlowId ? '✅ set' : '❌ missing',
      cortexChannelId: CONFIG.cortexChannelId ? '✅ set' : '❌ missing',
      cortexApiUrl: CONFIG.cortexApiUrl,
    },
    uptime: Math.floor(process.uptime()) + 's',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'DOC PIIA' });
});

// Bot Framework endpoint — aquí llegan los mensajes de Teams
app.post('/api/messages', async (req, res) => {
  try {
    await adapter.process(req, res, async (context) => {
      if (context.activity.type === ActivityTypes.Message) {
        await onMessage(context);
      } else if (context.activity.type === ActivityTypes.ConversationUpdate) {
        await onMembersAdded(context);
      }
    });
  } catch (error) {
    console.error('[Express] Error en /api/messages:', error.message);
    if (!res.headersSent) {
      res.status(200).json({ status: 'error' });
    }
  }
});

// Start
app.listen(PORT, () => {
  console.log('');
  console.log('🏥 ===================================');
  console.log('   Agent DOC PIIA - Teams Middleware');
  console.log('   ===================================');
  console.log(`   Puerto: ${PORT}`);
  console.log(`   Bot App ID: ${CONFIG.botAppId || 'NOT SET'}`);
  console.log(`   Cortex URL: ${CONFIG.cortexApiUrl}`);
  console.log(`   Flow ID: ${CONFIG.cortexFlowId || 'NOT SET'}`);
  console.log(`   Channel ID: ${CONFIG.cortexChannelId || 'NOT SET'}`);
  console.log('   ===================================');
  console.log('');
});
