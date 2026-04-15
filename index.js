const express = require('express');
const { BotFrameworkAdapter, ActivityTypes } = require('botbuilder');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3000;

const CONFIG = {
  botAppId: process.env.BOT_APP_ID || '',
  botAppPassword: process.env.BOT_APP_PASSWORD || '',
  cortexApiUrl: (process.env.CORTEX_API_URL || 'https://app-back-cortexagentshub-test.azurewebsites.net').replace(/\/$/, ''),
  cortexFlowId: process.env.CORTEX_FLOW_ID || '',
  cortexChannelId: process.env.CORTEX_CHANNEL_ID || '',
};

const adapter = new BotFrameworkAdapter({
  appId: CONFIG.botAppId,
  appPassword: CONFIG.botAppPassword,
  channelAuthTenant: '901d036d-69a0-48e1-b908-8fdc38f0030e',
});

adapter.onTurnError = async (context, error) => {
  console.error(`[Bot Error] ${error.message}`);
  try {
    await context.sendActivity('⚠️ Ocurrió un error procesando tu consulta. Por favor intenta de nuevo.');
  } catch (e) {
    console.error('[Bot Error] No se pudo enviar mensaje de error:', e.message);
  }
};

const sessionMap = new Map();

setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, val] of sessionMap.entries()) {
    if (val.lastActivity < oneHourAgo) sessionMap.delete(key);
  }
}, 3600000);

async function sendToCortex(message, userId, userName, conversationId) {
  let session = sessionMap.get(conversationId);
  if (!session) {
    session = { sessionId: `teams-piaa-${Date.now()}`, lastActivity: Date.now() };
    sessionMap.set(conversationId, session);
  }
  session.lastActivity = Date.now();

  const url = `${CONFIG.cortexApiUrl}/api/v1/messages/send`;

  const payload = {
    channelType: 'teams',
    userId: userId,
    content: message,
    metadata: {
      flowId: CONFIG.cortexFlowId,
      channelId: CONFIG.cortexChannelId,
      sessionId: session.sessionId,
      userName: userName,
    },
  };

  console.log(`[Cortex] POST ${url}`);
  console.log(`[Cortex] flowId: ${CONFIG.cortexFlowId}, channelId: ${CONFIG.cortexChannelId}`);
  console.log(`[Cortex] message: "${message.substring(0, 100)}"`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    console.log(`[Cortex] Status: ${response.status}`);
    console.log(`[Cortex] Response: ${responseText.substring(0, 500)}`);

    if (!response.ok) {
      console.error(`[Cortex] Error ${response.status}: ${responseText}`);
      return '⚠️ No pude conectar con el agente PIAA. El servicio puede estar temporalmente no disponible.';
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      return responseText || 'Respuesta recibida sin contenido.';
    }

    if (typeof data === 'string') return data;
    if (data.text) return data.text;
    if (data.message) return data.message;
    if (data.response) return data.response;
    if (data.content) return data.content;
    if (data.data?.text) return data.data.text;
    if (data.data?.message) return data.data.message;
    if (data.data?.response) return data.data.response;
    if (data.data?.content) return data.data.content;

    if (Array.isArray(data.messages)) {
      const botMsgs = data.messages
        .filter(m => m.role === 'assistant' || m.type === 'bot')
        .map(m => m.text || m.content || m.message);
      if (botMsgs.length > 0) return botMsgs.join('\n');
    }

    console.warn('[Cortex] Formato no reconocido:', JSON.stringify(data).substring(0, 300));
    return 'Recibí tu consulta pero no pude procesar la respuesta. Intenta de nuevo.';
  } catch (error) {
    console.error(`[Cortex] Fetch error: ${error.message}`);
    return '⚠️ Error de conexión con el agente PIAA. Por favor intenta en unos minutos.';
  }
}

async function onMessage(context) {
  if (context.activity.type !== ActivityTypes.Message) return;

  let userMessage = context.activity.text || '';
  userMessage = userMessage.replace(/<at>.*?<\/at>/gi, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  if (!userMessage) {
    await context.sendActivity('👋 ¡Hola! Soy Doc PIIA 🤖, tu asistente de Saludsa 🔵🔴🦥 ¿En qué te puedo ayudar hoy? 😊');
    return;
  }

  console.log(`[Teams] Mensaje de ${context.activity.from.name}: "${userMessage.substring(0, 100)}"`);
  await context.sendActivity({ type: ActivityTypes.Typing });

  const userId = context.activity.from.aadObjectId || context.activity.from.id;
  const userName = context.activity.from.name || 'Usuario';
  const conversationId = context.activity.conversation.id;

  const response = await sendToCortex(userMessage, userId, userName, conversationId);

  await context.sendActivity({ type: ActivityTypes.Message, text: response, textFormat: 'markdown' });
  console.log(`[Teams] Respuesta enviada a ${userName} (${response.length} chars)`);
}

async function onMembersAdded(context) {
  for (const member of context.activity.membersAdded) {
    if (member.id !== context.activity.recipient.id) {
      await context.sendActivity(
        '🏥 **¡Hola! Soy Doc PIIA** 🤖🔵🔴🦥\n\n' +
        'Soy tu asistente de Saludsa, especializado en Autorizaciones y Liquidaciones.\n\n' +
        '• Consultas de **cobertura** por tipo de plan\n' +
        '• Verificación de **medicamentos** en el Vademécum\n' +
        '• Reglas de **emergencias y urgencias**\n' +
        '• Lineamientos de **auditoría de reembolsos**\n\n' +
        'Escríbeme tu consulta y te ayudo. 💬'
      );
    }
  }
}

const app = express();

app.get('/', (req, res) => {
  res.json({
    agent: 'DOC PIIA',
    status: 'online',
    version: '1.1.0',
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
    if (!res.headersSent) res.status(200).json({ status: 'error' });
  }
});

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
