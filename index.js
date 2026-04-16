const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const CORTEX_BASE = 'https://app-back-cortexagentshub-test.azurewebsites.net';
const CORTEX_FLOW_ID = process.env.CORTEX_FLOW_ID;
const CORTEX_CHANNEL_ID = process.env.CORTEX_CHANNEL_ID;
const CORTEX_USER = process.env.CORTEX_USER;
const CORTEX_PASS = process.env.CORTEX_PASS;

let cortexToken = null;

async function getCortexToken() {
  const res = await axios.post(`${CORTEX_BASE}/api/admin/login`, {
    username: CORTEX_USER,
    password: CORTEX_PASS
  });
  cortexToken = res.data.token;
  console.log('Token Cortex renovado OK');
  return cortexToken;
}

async function sendToCortex(userId, message) {
  if (!cortexToken) await getCortexToken();
  try {
    const res = await axios.post(`${CORTEX_BASE}/api/v1/messages/send`, {
      channelType: 'teams',
      userId,
      content: message,
      metadata: {
        flowId: CORTEX_FLOW_ID,
        channelId: CORTEX_CHANNEL_ID,
        channel_config_id: CORTEX_CHANNEL_ID
      }
    }, { headers: { Authorization: `Bearer ${cortexToken}` } });
    return res.data?.data?.response || 'Sin respuesta';
  } catch (err) {
    if (err.response?.status === 401) {
      await getCortexToken();
      const res = await axios.post(`${CORTEX_BASE}/api/v1/messages/send`, {
        channelType: 'teams',
        userId,
        content: message,
        metadata: {
          flowId: CORTEX_FLOW_ID,
          channelId: CORTEX_CHANNEL_ID,
          channel_config_id: CORTEX_CHANNEL_ID
        }
      }, { headers: { Authorization: `Bearer ${cortexToken}` } });
      return res.data?.data?.response || 'Sin respuesta';
    }
    throw err;
  }
}

async function getBFToken() {
  const res = await axios.post(
    `https://login.microsoftonline.com/901d036d-69a0-48e1-b908-8fdc38f0030e/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.BOT_APP_ID,
      client_secret: process.env.BOT_APP_PASSWORD,
      scope: 'https://api.botframework.com/.default'
    })
  );
  return res.data.access_token;
}

app.post('/api/messages', async (req, res) => {
  res.sendStatus(200);
  const activity = req.body;
  if (activity.type !== 'message' || !activity.text) return;

  const userMessage = activity.text.replace(/<at>.*?<\/at>/gi, '').replace(/&nbsp;/g, ' ').trim();
  if (!userMessage) return;

  const userId = activity.from?.id || 'teams-user';
  const serviceUrl = activity.serviceUrl;
  const conversationId = activity.conversation?.id;
  const replyToId = activity.id;

  console.log(`Mensaje: ${userMessage}`);

  try {
    const bfToken = await getBFToken();

    // Typing indicator
    await axios.post(
      `${serviceUrl}v3/conversations/${conversationId}/activities`,
      { type: 'typing', from: { id: process.env.BOT_APP_ID } },
      { headers: { Authorization: `Bearer ${bfToken}` } }
    );

    const respuesta = await sendToCortex(userId, userMessage);
    console.log(`Respuesta: ${respuesta.substring(0, 200)}`);

    await axios.post(
      `${serviceUrl}v3/conversations/${conversationId}/activities/${replyToId}`,
      { type: 'message', text: respuesta, textFormat: 'markdown' },
      { headers: { Authorization: `Bearer ${bfToken}` } }
    );
    console.log('Enviado a Teams OK');
  } catch (error) {
    console.error('Error:', JSON.stringify(error.response?.data || error.message));
  }
});

app.get('/', (req, res) => res.json({ agent: 'DOC PIIA', status: 'online', version: '3.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DOC PIIA Middleware en puerto ${PORT}`));
