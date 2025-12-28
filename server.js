// ========= FIX WEBCRYPTO (OBRIGATÓRIO) =========
import crypto from 'crypto'
if (!global.crypto) global.crypto = crypto.webcrypto

import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import fs from 'fs'
import archiver from 'archiver'
import baileys from '@whiskeysockets/baileys'

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = baileys

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.static('public'))

/* ========= CONFIG ========= */
const COUNTRY_CODE = '+258'   // 🔥 COM + DESDE O INÍCIO
const CODE_TTL = 60 * 1000

/* ========= LOG ========= */
function log(socket, session, msg) {
  const m = `[${session}] ${msg}`
  console.log(m)
  socket.emit('log', m)
}

/* ========= ZIP ========= */
function zipFolder(source, out) {
  return new Promise(resolve => {
    const archive = archiver('zip')
    const stream = fs.createWriteStream(out)
    archive.directory(source, false).pipe(stream)
    stream.on('close', resolve)
    archive.finalize()
  })
}

/* ========= NORMALIZA NÚMERO (FINAL) ========= */
function normalizePhone(localNumber) {
  let clean = localNumber.replace(/\D/g, '')

  // remove zero inicial se existir
  if (clean.startsWith('0')) clean = clean.slice(1)

  // 🔥 RESULTADO FINAL E.164
  return `${COUNTRY_CODE}${clean}`
}

/* ========= START SESSION ========= */
async function startSession(socket, sessionName) {
  log(socket, sessionName, '🚀 Iniciando sessão WhatsApp')

  const sessionPath = `sessions/${sessionName}`
  fs.mkdirSync(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    mobile: false
  })

  sock.ev.on('creds.update', saveCreds)

  socket.emit('request-phone')
  log(socket, sessionName, '📲 Aguardando número do telefone')

  let pairingTimer = null

  /* ===== CONEXÃO ===== */
  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      log(socket, sessionName, '✅ Conectado com sucesso')

      const me = sock.user
      const groups = await sock.groupFetchAllParticipating()

      const groupInfo = Object.values(groups).map(g => ({
        name: g.subject,
        members: g.participants.length
      }))

      fs.mkdirSync('zips', { recursive: true })
      const zipPath = `zips/${sessionName}.zip`
      await zipFolder(sessionPath, zipPath)

      socket.emit('session-ready', {
        name: me.name,
        number: me.id.split(':')[0],
        groups: groupInfo,
        downloadUrl: `/download/${sessionName}`
      })

      log(socket, sessionName, '📦 Sessão pronta e ZIP gerado')
    }
  })

  /* ===== RECEBE NÚMERO ===== */
  socket.on('send-phone', async ({ phone }) => {
    const fullNumber = normalizePhone(phone)

    // 🔥 LOG CRÍTICO
    log(socket, sessionName, `📟 Número enviado ao WhatsApp: ${fullNumber}`)

    try {
      await new Promise(r => setTimeout(r, 3000))

      const code = await sock.requestPairingCode(fullNumber)

      socket.emit('pairing-code', { code })
      log(socket, sessionName, `🔐 Código gerado: ${code}`)

      if (pairingTimer) clearTimeout(pairingTimer)
      pairingTimer = setTimeout(() => {
        socket.emit('pairing-expired')
        log(socket, sessionName, '⌛ Código expirou')
      }, CODE_TTL)

    } catch (err) {
      log(socket, sessionName, '🔥 Erro ao solicitar código')
      console.error(err)
    }
  })
}

/* ========= DOWNLOAD ========= */
app.get('/download/:session', (req, res) => {
  const file = `zips/${req.params.session}.zip`
  if (!fs.existsSync(file)) return res.sendStatus(404)
  res.download(file)
})

/* ========= SOCKET ========= */
io.on('connection', socket => {
  socket.on('start-session', sessionName => {
    startSession(socket, sessionName)
  })
})

server.listen(10000, () =>
  console.log('🌍 Servidor rodando na porta 10000')
)
