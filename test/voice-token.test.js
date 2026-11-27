// HTTP tests for GET /api/voice-token (plain Express route in srv/server.js, mocked auth).
import cds from '@sap/cds'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = cds.test(root)

const get = (user) => fetch(server.url + '/api/voice-token', {
  headers: user ? { Authorization: 'Basic ' + Buffer.from(`${user}:${user}`).toString('base64') } : {}
})

describe('GET /api/voice-token', () => {
  it('rejects anonymous requests with 401 and offers the developer login', async () => {
    const res = await get()
    assert.equal(res.status, 401)
    assert.equal((await res.json()).devLogin, true)
  })

  it('rejects a user without the role with 403', async () => {
    assert.equal((await get('bob')).status, 403)
  })

  it('returns a token for a user with the role', async () => {
    const res = await get('alice')
    assert.equal(res.status, 200)
    assert.ok((await res.json()).token)
  })
})
