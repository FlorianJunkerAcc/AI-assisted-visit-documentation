// Custom CAP server bootstrap.
// CDS auto-loads this file and applies both hooks before starting to serve.
//
// 1. /api/voice-token  – authenticated browser requests a one-time WS token (GET).
// 2. /ws/voice         – WebSocket bridge registered on the HTTP server via the
//                        'listening' event (fires when the port is bound).
import cds from '@sap/cds'
import { createVoiceToken, registerVoiceBridge } from './voice-bridge.js'

const LOG = cds.log('server')

// Token endpoint.
// Routes registered in 'bootstrap' run BEFORE CAP mounts its auth middleware, so
// req.user is never populated here. We fall back to manual Basic Auth parsing against
// cds.env.requires.auth.users (the mocked-auth config for development).
cds.on('bootstrap', (app) => {
  app.get('/api/voice-token', (req, res) => {
    // If CAP's auth middleware somehow ran first, honour it.
    if (req.user?.id) {
      if (!req.user.is?.('VisitDocumenter')) return res.status(403).json({ error: 'Forbidden' })
      return res.json({ token: createVoiceToken(req.user) })
    }

    const authHeader = req.headers.authorization ?? ''
    if (!authHeader.startsWith('Basic ')) return res.status(401).json({ error: 'Unauthorized' })

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const sep = decoded.indexOf(':')
    if (sep < 1) return res.status(401).json({ error: 'Unauthorized' })
    const uid = decoded.slice(0, sep)
    const pwd = decoded.slice(sep + 1)

    const users = cds.env.requires?.auth?.users ?? {}
    const u = users[uid]
    if (!u || u.password !== pwd) return res.status(401).json({ error: 'Unauthorized' })
    if (!u.roles?.includes('VisitDocumenter')) return res.status(403).json({ error: 'Forbidden' })

    res.json({ token: createVoiceToken({ id: uid, attr: u.attr }) })
  })
})

// WebSocket bridge: attach to the raw HTTP server once it is listening.
// CAP v10 fires 'listening' with { server, url }; handle both shapes defensively.
cds.on('listening', (arg) => {
  const server = arg?.server ?? arg
  if (server && typeof server.on === 'function') {
    registerVoiceBridge(server)
  } else {
    LOG.warn('voice bridge: could not obtain HTTP server from listening event', { arg })
  }
})
