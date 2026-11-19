// Custom CAP server bootstrap.
// CDS auto-loads this file and applies both hooks before starting to serve.
//
// 1. /api/voice-token  – authenticated browser requests a one-time WS token (GET).
// 2. /ws/voice         – WebSocket bridge registered on the HTTP server via the
//                        'listening' event (fires when the port is bound).
import cds from '@sap/cds'
import { createVoiceToken, registerVoiceBridge } from './voice-bridge.js'

const LOG = cds.log('server')

// Token endpoint: add before services mount so the route is in place when auth runs.
cds.on('bootstrap', (app) => {
  app.get('/api/voice-token', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' })
    if (!req.user.is?.('VisitDocumenter')) return res.status(403).json({ error: 'Forbidden' })
    const token = createVoiceToken(req.user)
    res.json({ token })
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
