const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const hydraImport = require('hydra-bot');
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

/* ==========================
   RESOLVE HYDRA FACTORY
========================== */
function createHydraBot(config) {
  // Caso 1: default export
  if (typeof hydraImport === 'function') {
    return hydraImport(config);
  }

  // Caso 2: default dentro de objeto
  if (hydraImport?.default && typeof hydraImport.default === 'function') {
    return hydraImport.default(config);
  }

  // Caso 3: método create / init / start
  const possibleKeys = ['createBot', 'create', 'init', 'start'];
  for (const key of possibleKeys) {
    if (typeof hydraImport[key] === 'function') {
      return hydraImport[key](config);
    }
  }

  console.error('❌ Hydra-bot export:', hydraImport);
  throw new Error('Não foi possível inicializar o hydra-bot');
}

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
function startSession(socket, session, phone) {
  if (bots[session]) {
    log(socket, session, '⚠️ Sessão já ativa');
    return;
  }

  log(socket, session, '🚀 Iniciando sessão');

  let bot;
  try {
    bot = createHydraBot({
      session,
      phoneNumber: phone,
      usePairingCode: true,
      debug: true
    });
  } catch (err) {
    log(socket, session, '❌ Falha ao iniciar Hydra');
    console.error(err);
    return;
  }

  bots[session] = bot;

  /* ==========================
     DEBUG TOTAL DE EVENTOS
  ========================== */
  if (bot?.emit) {
    const originalEmit = bot.emit.bind(bot);
    bot.emit = (event, ...args) => {
      console.log(`🧠 [HYDRA EVENT] ${event}`, args);
      return originalEmit(event, ...args);
    };
  }

  /* 📲 Código */
  bot.on?.('pairing-code', code => {
    log(socket, session, `📲 Código: ${code}`);
    socket.emit('pairing-code', { session, code });
  });

  /* 🔐 Ready */
  bot.on?.('ready', async () => {
    log(socket, session, '✅ WhatsApp conectado');

    let name = 'Desconhecido';
    let number = phone;
    let groups = [];

    try {
      const info = await bot.getHostDevice?.();
      if (info) {
        name = info.pushname || name;
        number = info.id?.user || number;
      }
    } catch {}

    try {
      const chats = await bot.getAllChats?.();
      if (Array.isArray(chats)) {
        groups = chats
          .filter(c => c.isGroup)
          .map(g => ({
            name: g.name || 'Sem nome',
            participants: g.participants?.length || 0
          }));
      }
    } catch {}

    const sessionDir = path.join(__dirname, 'sessions', session);
    const zipDir = path.join(__dirname, 'zips');
    const zipPath = path.join(zipDir, `${session}.zip`);

    if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir, { recursive: true });

    try {
      await zipFolder(sessionDir, zipPath);
      log(socket, session, '🗜️ Sessão compactada');
    } catch {
      log(socket, session, '❌ Erro ao compactar sessão');
    }

    socket.emit('session-ready', {
      session,
      name,
      number,
      groups,
      downloadUrl: `/download/${session}`
    });
  });

  bot.on?.('disconnected', reason => {
    log(socket, session, '❌ Desconectado: ' + reason);
    delete bots[session];
  });

  bot.on?.('error', err => {
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
