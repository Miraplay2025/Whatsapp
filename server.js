const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const hydra = require('hydra-bot');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static('public'));

const sessions = {};

/* ==========================
   LOG
========================== */
function log(socket, session, msg) {
  const m = `[${session}] ${msg}`;
  console.log(m);
  socket.emit('log', m);
}

/* ==========================
   START SESSION
========================== */
async function startSession(socket, session, phone) {
  try {
    if (sessions[session]) {
      log(socket, session, '⚠️ Sessão já ativa');
      return;
    }

    log(socket, session, '🚀 Iniciando sessão');

    const sessionDir = path.join(__dirname, 'sessions', session);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    /* 🔑 INIT CORRETO DO HYDRA */
    const client = await hydra.initWs({
      sessionName: session,
      phoneNumber: phone,
      sessionPath: sessionDir,
      usePairingCode: true,
      headless: true,
      debug: true
    });

    if (!client) {
      throw new Error('initWs não retornou cliente');
    }

    sessions[session] = client;

    /* ==========================
       POLLING DE STATUS (FORMA REAL)
    ========================== */
    const interval = setInterval(async () => {
      try {
        const state = await client.getConnectionState?.();

        if (state === 'CONNECTED') {
          clearInterval(interval);
          log(socket, session, '✅ WhatsApp conectado');

          let profile = {};
          try {
            profile = await client.getProfile?.() || {};
          } catch {}

          socket.emit('session-ready', {
            session,
            name: profile.name || 'Desconhecido',
            number: phone
          });
        }
      } catch {}
    }, 2000);

  } catch (err) {
    log(socket, session, '❌ Erro ao iniciar: ' + err.message);
    delete sessions[session];
  }
}

/* ==========================
   SOCKET
========================== */
io.on('connection', socket => {
  socket.on('start-session', data => {
    if (!data?.session || !data?.phone) {
      socket.emit('log', '❌ Sessão ou número inválido');
      return;
    }

    startSession(
      socket,
      data.session.trim(),
      data.phone.trim()
    );
  });
});

/* ==========================
   SERVER
========================== */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
