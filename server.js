// ===== FIX WEBCRYPTO (OBRIGATÓRIO) =====
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

const sessions = {}
const COUNTRY_CODE = '258'
const CODE_TTL = 60 * 1000 // 60 segundos

/* ================= LOG ================= */
function log(socket, session, msg) {
  const m = `[${session}] ${msg}`
  console.log(m)
  socket.emit('log', m)
}

/* ================= ZIP ================= */
function zipFolder(source, out) {
  return new Promise(resolve => {
    const archive = archiver('zip')
    const stream = fs.createWriteStream(out)
    archive.directory(source, false).pipe(stream)
    stream.on('close', resolve)
    archive.finalize()
  })
}

/* ================= NORMALIZA NÚMERO ================= */
function normalizePhone(phone) {
  phone = phone.replace(/\D/g, '')
  if (phone.startsWith('0')) phone = phone.slice(1)
  if (!phone.startsWith(COUNTRY_CODE)) phone = COUNTRY_CODE + phone
  return phone
}

/* ================= START SESSION ================= */
async function startSession(socket, sessionName) {
  if (sessions[sessionName]) {
    log(socket, sessionName, '⚠️ Sessão já ativa')
    return
  }

  log(socket, sessionName, '🚀 Iniciando sessão')

  const sessionPath = `sessions/${sessionName}`
  fs.mkdirSync(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  })

  sessions[sessionName] = {
    sock,
    pairingTimer: null,
    phone: null
  }

  sock.ev.on('creds.update', saveCreds)

  socket.emit('request-phone')
  log(socket, sessionName, '📲 Aguardando número do telefone')

  /* ===== GERAR CÓDIGO ===== */
  const generatePairingCode = async () => {
    const session = sessions[sessionName]
    if (!session || state.creds.registered) return

    const code = await session.sock.requestPairingCode(session.phone)

    socket.emit('pairing-code', { code })
    log(socket, sessionName, '🔐 Código de pareamento gerado')

    if (session.pairingTimer) clearTimeout(session.pairingTimer)

    session.pairingTimer = setTimeout(() => {
      socket.emit('pairing-expired')
      log(socket, sessionName, '⌛ Código expirado')
    }, CODE_TTL)
  }

  /* ===== RECEBE NÚMERO ===== */
  socket.on('send-phone', async ({ phone }) => {
    if (state.creds.registered) return

    const fullNumber = normalizePhone(phone)
    sessions[sessionName].phone = fullNumber

    log(socket, sessionName, `📟 Número confirmado: ${fullNumber}`)
    await generatePairingCode()
  })

  /* ===== RENOVAR CÓDIGO ===== */
  socket.on('renew-code', async () => {
    if (state.creds.registered) return
    log(socket, sessionName, '🔁 Renovando código de pareamento')
    await generatePairingCode()
  })

  /* ===== CONEXÃO ===== */
  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      log(socket, sessionName, '✅ WhatsApp conectado')

      if (sessions[sessionName].pairingTimer)
        clearTimeout(sessions[sessionName].pairingTimer)

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

      log(socket, sessionName, '📦 Sessão pronta e ZIP criado')
    }
  })
}

/* ================= DOWNLOAD ================= */
app.get('/download/:session', (req, res) => {
  const file = `zips/${req.params.session}.zip`
  if (!fs.existsSync(file)) return res.sendStatus(404)
  res.download(file)
})

/* ================= SOCKET ================= */
io.on('connection', socket => {
  socket.on('start-session', sessionName => {
    if (!sessionName) return
    startSession(socket, sessionName)
  })
})

server.listen(10000, () =>
  console.log('🌍 Servidor rodando na porta 10000')
)
