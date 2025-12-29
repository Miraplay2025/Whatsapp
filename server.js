const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const hydra = require('hydra-bot');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const cors = require('cors');

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
   ZIP
========================== */
function zipFolder(source, out) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(out);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize();
    output.on('close', resolve);
    archive.on('error', reject);
  });
}

/* ==========================
   START SESSION
========================== */
async function startSession(socket, session, phone) {
  if (sessions[session]) {
    log(socket, session, '⚠️ Sessão já ativa');
    return;
  }

  log(socket, session, '🚀 Iniciando sessão');

  const sessionDir = path.join(__dirname, 'sessions', session);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  /* 🔑 INIT REAL DO HYDRA */
  const client = await hydra.initWs({
    session: session,
    phoneNumber: phone,
    sessionDir: sessionDir,
    usePairingCode: true,
    headless: true
  });

  sessions[session] = client;

  /* ==========================
     EVENTOS REAIS
  ========================== */

  client.on('pairing-code', code => {
    log(socket, session, `📲 Código: ${code}`);
    socket.emit('pairing-code', { session, code });
  });

  client.on('ready', async () => {
    log(socket, session, '✅ WhatsApp conectado');

    let name = 'Desconhecido';
    let number = phone;
    let groups = [];

    try {
      const profile = await client.getProfile();
      name = profile?.name || name;
      number = profile?.id || number;
    } catch {}

    try {
      const allGroups = await client.getAllGroups();
      groups = allGroups.map(g => ({
        name: g.subject || 'Sem nome',
        participants: g.participants?.length || 0
      }));
    } catch {}

    /* ZIP */
    const zipDir = path.join(__dirname, 'zips');
    const zipPath = path.join(zipDir, `${session}.zip`);
    if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir);

    await zipFolder(sessionDir, zipPath);

    socket.emit('session-ready', {
      session,
      name,
      number,
      groups,
      downloadUrl: `/download/${session}`
    });
  });

  client.on('disconnected', reason => {
    log(socket, session, '❌ Desconectado: ' + reason);
    delete sessions[session];
  });

  client.on('error', err => {
    log(socket, session, '🚨 Erro: ' + err);
  });
}

/* ==========================
   DOWNLOAD
========================== */
app.get('/download/:session', (req, res) => {
  const zip = path.join(__dirname, 'zips', `${req.params.session}.zip`);
  if (!fs.existsSync(zip)) return res.status(404).send('ZIP não disponível');
  res.download(zip);
});

/* ==========================
   SOCKET
========================== */
io.on('connection', socket => {
  socket.on('start-session', data => {
    if (!data?.session || !data?.phone) {
      socket.emit('log', '❌ Sessão ou número inválido');
      return;
    }
    startSession(socket, data.session.trim(), data.phone.trim());
  });
});

/* ==========================
   SERVER
========================== */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
);
