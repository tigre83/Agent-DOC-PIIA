const express = require('express');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3000;

const CONFIG = {
  cortexApiUrl: (process.env.CORTEX_API_URL || 'https://app-back-cortexagentshub-test.azurewebsites.net').replace(/\/$/, ''),
  cortexChannelId: process.env.CORTEX_CHANNEL_ID || '',
};

// ============================================================
// ESTRATEGIA: Proxy transparente
// Teams → Railway → AgentHub /webhooks/teams
// AgentHub procesa el mensaje y responde a Teams directamente
// usando las credenciales del bot configuradas en el canal
// ============================================================

const app = express();

// Parse JSON body
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({
    agent: 'DOC PIIA',
    status: 'online',
    mode: 'proxy',
    version: '2.0.0',
    cortexApiUrl: CONFIG.cortexApiUrl,
    cortexChannelId: CONFIG.cortexChannelId || 'NOT SET',
    uptime: Math.floor(process.uptime()) + 's',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'DOC PIIA' });
});

// ============================================================
// POST /api/messages — Proxy de Teams → AgentHub
// ============================================================
app.post('/api/messages', async (req, res) => {
  const activity = req.body;

  // Log básico
  if (activity.type === 'message' && activity.text) {
    const cleanText = (activity.text || '').replace(/<at>.*?<\/at>/gi, '').replace(/&nbsp;/g, ' ').trim();
    console.log(`[Teams→Proxy] ${activity.from?.name || 'unknown'}: "${cleanText.substring(0, 100)}"`);
  } else {
    console.log(`[Teams→Proxy] Activity type: ${activity.type}`);
  }

  // Inyectar metadata del canal en el activity para que AgentHub sepa qué agente usar
  const enrichedActivity = {
    ...activity,
    channelData: {
      ...(activity.channelData || {}),
      cortexChannelId: CONFIG.cortexChannelId,
    },
  };

  try {
    // Forward completo al webhook nativo de AgentHub
    const webhookUrl = `${CONFIG.cortexApiUrl}/webhooks/teams`;
    console.log(`[Proxy] POST ${webhookUrl}`);

    // Forward headers de autenticación de Bot Framework
    const headers = {
      'Content-Type': 'application/json',
    };
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    const cortexResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(enrichedActivity),
    });

    const responseText = await cortexResponse.text();
    console.log(`[Proxy] AgentHub responded: ${cortexResponse.status} - ${responseText.substring(0, 200)}`);

    // Devolver la misma respuesta que AgentHub
    res.status(cortexResponse.status);
    try {
      res.json(JSON.parse(responseText));
    } catch {
      res.send(responseText);
    }
  } catch (error) {
    console.error(`[Proxy] Error forwarding to AgentHub: ${error.message}`);
    // Devolver 200 para que Teams/Bot Framework no reintente
    res.status(200).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('🏥 ===================================');
  console.log('   Agent DOC PIIA - Proxy Mode v2.0');
  console.log('   ===================================');
  console.log(`   Puerto: ${PORT}`);
  console.log(`   Cortex URL: ${CONFIG.cortexApiUrl}`);
  console.log(`   Channel ID: ${CONFIG.cortexChannelId || 'NOT SET'}`);
  console.log('   ===================================');
  console.log('');
});
