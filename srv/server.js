// Custom CAP server bootstrap.
// CDS auto-loads this file and applies both hooks before starting to serve.
//
// 1. /api/voice-token  – authenticated browser requests a one-time WS token (GET).
//    Registered in 'served' so CAP's auth middleware (mocked or XSUAA) has already
//    run and req.user is populated before the handler fires.
// 2. /ws/voice         – WebSocket bridge registered on the HTTP server via the
//                        'listening' event (fires when the port is bound).
import cds from '@sap/cds'
import { createVoiceToken, registerVoiceBridge } from './voice-bridge.js'

const LOG = cds.log('server')

// Token endpoint – runs AFTER CAP's auth middleware.
// In development (mocked auth) req.user is populated from Basic Auth headers.
// In production (XSUAA) req.user is populated from the JWT forwarded by the App Router.
cds.on('served', () => {
  cds.app.get('/api/voice-token', (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' })
    if (!req.user.is('VisitDocumenter')) return res.status(403).json({ error: 'Forbidden' })
    res.json({ token: createVoiceToken(req.user) })
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
