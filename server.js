import crypto from 'crypto'
if (!global.crypto) global.crypto = crypto.webcrypto

import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import fs from 'fs'
import archiver from 'archiver'

import baileys from '@whiskeysockets/baileys'
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.static('public'))

const COUNTRY_CODE = '258'
const CODE_TTL = 60 * 1000 // 60s

// ===== LOG =====
function log(socket, session, msg) {
  const m = `[${session}] ${msg}`
  console.log(m)
  socket.emit('log', m)
}

// ===== ZIP =====
function zipFolder(source, out) {
  return new Promise(resolve => {
    const archive = archiver('zip')
    const stream = fs.createWriteStream(out)
    archive.directory(source, false).pipe(stream)
    stream.on('close', resolve)
    archive.finalize()
  })
}

// ===== NORMALIZA NÚMERO =====
function normalizePhone(phone) {
  phone = phone.replace(/\D/g, '')
  if (phone.startsWith('0')) phone = phone.slice(1)
  if (!phone.startsWith(COUNTRY_CODE)) phone = COUNTRY_CODE + phone
  return phone
}

// ===== START SESSION =====
async function startSession(socket, sessionName) {
  log(socket, sessionName, '🚀 Iniciando sessão')

  const sessionPath = `sessions/${sessionName}`
  fs.mkdirSync(sessionPath, { recursive: true })

  // Criar socket novo para cada tentativa
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  let sock = makeWASocket({ version, auth: state, printQRInTerminal: false })
  sock.ev.on('creds.update', saveCreds)

  socket.emit('request-phone')
  log(socket, sessionName, '📲 Aguardando número do telefone')

  let pairingTimer = null
  let phoneNumber = null

  // ===== GERAR CÓDIGO =====
  const generatePairingCode = async () => {
    if (!phoneNumber) return
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false })
    sock.ev.on('creds.update', saveCreds)

    const code = await sock.requestPairingCode(phoneNumber)
    socket.emit('pairing-code', { code })
    log(socket, sessionName, '🔐 Código gerado')

    if (pairingTimer) clearTimeout(pairingTimer)
    pairingTimer = setTimeout(() => {
      socket.emit('pairing-expired')
      log(socket, sessionName, '⌛ Código expirou')
    }, CODE_TTL)

    // Conexão aberta
    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        log(socket, sessionName, '✅ WhatsApp conectado')

        if (pairingTimer) clearTimeout(pairingTimer)

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

  // ===== RECEBE NÚMERO =====
  socket.on('send-phone', async ({ phone }) => {
    phoneNumber = normalizePhone(phone)
    log(socket, sessionName, `📟 Número normalizado: ${phoneNumber}`)
    await generatePairingCode()
  })

  // ===== RENOVAR CÓDIGO =====
  socket.on('renew-code', async () => {
    log(socket, sessionName, '🔁 Renovando código')
    await generatePairingCode()
  })

  // ===== ENVIAR MENSAGEM =====
  socket.on('send-message', async ({ phone, message }) => {
    if (!sock) return
    const jid = normalizePhone(phone) + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: message })
    log(socket, sessionName, `💬 Mensagem enviada para ${jid}`)
  })
}

/* DOWNLOAD */
app.get('/download/:session', (req, res) => {
  const file = `zips/${req.params.session}.zip`
  if (!fs.existsSync(file)) return res.sendStatus(404)
  res.download(file)
})

/* SOCKET */
io.on('connection', socket => {
  socket.on('start-session', sessionName => {
    if (!sessionName) return
    startSession(socket, sessionName)
  })
})

server.listen(10000, () =>
  console.log('🌍 Servidor rodando na porta 10000')
)
