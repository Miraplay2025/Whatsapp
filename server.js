import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import fs from 'fs'
import archiver from 'archiver'

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.static('public'))

const sessions = {}
const COUNTRY_CODE = '258'

function log(socket, session, msg) {
  const m = `[${session}] ${msg}`
  console.log(m)
  socket.emit('log', m)
}

/* ZIP */
function zipFolder(source, out) {
  return new Promise(resolve => {
    const archive = archiver('zip')
    const stream = fs.createWriteStream(out)
    archive.directory(source, false).pipe(stream)
    stream.on('close', resolve)
    archive.finalize()
  })
}

/* START SESSION */
async function startSession(socket, sessionName) {
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

  sessions[sessionName] = sock
  sock.ev.on('creds.update', saveCreds)

  socket.emit('request-phone')
  log(socket, sessionName, '📲 Aguardando número do telefone')

  socket.on('send-phone', async data => {
    if (state.creds.registered) return

    const fullNumber = COUNTRY_CODE + data.phone
    log(socket, sessionName, `📟 Solicitando código para ${fullNumber}`)

    const sendPairingCode = async () => {
      const code = await sock.requestPairingCode(fullNumber)
      socket.emit('pairing-code', { code })
      log(socket, sessionName, '🔐 Código de pareamento gerado')
    }

    await sendPairingCode()

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'close' && !state.creds.registered) {
        log(socket, sessionName, '🔁 Código expirado, gerando novo...')
        await sendPairingCode()
      }

      if (connection === 'open') {
        log(socket, sessionName, '✅ WhatsApp conectado')

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

        log(socket, sessionName, '📦 ZIP da sessão criado')
      }
    })
  })

  socket.on('send-message', async d => {
    const jid = `${COUNTRY_CODE}${d.phone}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: d.message })
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
  socket.on('start-session', startSession.bind(null, socket))
})

server.listen(10000, () =>
  console.log('🌍 Servidor rodando na porta 10000')
)
