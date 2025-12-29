 const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createBot } = require('hydra-bot');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static('public'));

const bots = {};

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
  if (bots[session]) {
    log(socket, session, '⚠️ Sessão já existe');
    return;
  }

  log(socket, session, '🚀 Iniciando sessão');

  const bot = await createBot({
    sessionName: session,
    phoneNumber: phone
  });

  bots[session] = bot;

  /* 📲 Código de autenticação */
  bot.on('pairingCode', code => {
    log(socket, session, '📲 Código gerado');
    socket.emit('pairing-code', { session, code });
  });

  /* 🔐 Conectado */
  bot.on('ready', async () => {
    const info = await bot.getHostDevice();

    log(socket, session, '✅ WhatsApp conectado');

    /* 👥 Grupos */
    const chats = await bot.getAllChats();
    const groups = chats
      .filter(c => c.isGroup)
      .map(g => ({
        name: g.name,
        participants: g.participants?.length || 0
      }));

    /* 📁 ZIP */
    const sessionDir = path.join(__dirname, 'sessions', session);
    const zipDir = path.join(__dirname, 'zips');
    const zipPath = path.join(zipDir, `${session}.zip`);

    if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir);
    await zipFolder(sessionDir, zipPath);

    socket.emit('session-ready', {
      session,
      name: info.pushname,
      number: info.id.user,
      groups,
      downloadUrl: `/download/${session}`
    });
  });

  bot.start();
}

/* ==========================
   DOWNLOAD
========================== */
app.get('/download/:session', (req, res) => {
  const zip = path.join(__dirname, 'zips', `${req.params.session}.zip`);
  if (!fs.existsSync(zip)) return res.sendStatus(404);
  res.download(zip);
});

/* ==========================
   SOCKET
========================== */
io.on('connection', socket => {
  socket.on('start-session', ({ session, phone }) => {
    if (!session || !phone) {
      socket.emit('log', '❌ Sessão ou número inválido');
      return;
    }
    startSession(socket, session, phone);
  });
});

server.listen(10000, () =>
  console.log('🚀 Servidor rodando na porta 10000')
);
