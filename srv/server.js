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
//
// Dev-only fallback: BAS tunnels strip Authorization headers, so mocked auth never fires.
// When NODE_ENV !== 'production' and req.user is absent, ?_dev_user=alice is accepted as
// a stand-in. This path is unreachable in production because auth.kind=xsuaa is active.
cds.on('served', () => {
  cds.app.get('/api/voice-token', (req, res) => {
    let user = req.user
    if (!user?.id && cds.env.profile !== 'production' && process.env.NODE_ENV !== 'production') {
      const devUser = req.query._dev_user
      if (devUser) {
        const cfg = cds.env.requires?.auth?.users?.[devUser]
        if (cfg) {
          user = new cds.User({ id: devUser, roles: cfg.roles ?? [], attr: cfg.attr ?? {} })
        }
      }
    }
    if (!user?.id) return res.status(401).json({ error: 'Unauthorized' })
    if (!user.is('VisitDocumenter')) return res.status(403).json({ error: 'Forbidden' })
    res.json({ token: createVoiceToken(user) })
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
