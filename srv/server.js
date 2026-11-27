// Custom CAP server bootstrap.
// CDS auto-loads this file and applies both hooks before starting to serve.
//
// 1. /api/voice-token  – authenticated browser requests a one-time WS token (GET).
//    This is a plain Express route, not a CDS service, so CAP's middlewares (including
//    authentication) have to be added to it explicitly.
// 2. /ws/voice         – WebSocket bridge registered on the HTTP server via the
//                        'listening' event (fires when the port is bound).
import cds from '@sap/cds'
import { createVoiceToken, registerVoiceBridge } from './voice-bridge.js'

const LOG = cds.log('server')

// Token endpoint – cds.middlewares.before runs authentication first.
// In development (mocked auth) the user comes from Basic Auth headers.
// In production (XSUAA) the user comes from the JWT forwarded by the App Router.
//
// Dev-only fallback: BAS tunnels may strip Authorization headers. Only with mocked auth and
// outside production, ?_dev_user=alice is then accepted as a stand-in.
cds.on('served', () => {
  cds.app.get('/api/voice-token', cds.middlewares.before, (req, res) => {
    // jwt/xsuaa auth only fills cds.context.user (req.user stays empty), mocked auth fills both.
    let user = cds.context?.user
    const devFallback = process.env.NODE_ENV !== 'production' && cds.env.requires?.auth?.kind === 'mocked'
    if (!user?.is('authenticated-user') && devFallback) {
      const devUser = req.query._dev_user
      if (devUser) {
        const cfg = cds.env.requires?.auth?.users?.[devUser]
        if (cfg) {
          user = new cds.User({ id: devUser, roles: cfg.roles ?? [], attr: cfg.attr ?? {} })
        }
      }
    }
    if (!user?.is('authenticated-user')) return res.status(401).json({ error: 'Unauthorized', devLogin: devFallback })
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
