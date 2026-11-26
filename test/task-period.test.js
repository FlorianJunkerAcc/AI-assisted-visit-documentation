// The Task due time named by the user must reach C4C (regression: a fixed default was written).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { taskPeriod } from '../srv/lib/c4c-client.js'
import { spokenTime } from '../srv/lib/time.js'

const ms = (v) => new Date(Number(/\d+/.exec(v)[0])).toISOString()

describe('Task period', () => {
  it('converts the local due time to UTC and starts one hour earlier', () => {
    const p = taskPeriod('2026-12-06', '14:30', 'Europe/Berlin')
    assert.equal(ms(p.DueDateTime), '2026-12-06T13:30:00.000Z')
    assert.equal(ms(p.StartDateTime), '2026-12-06T12:30:00.000Z')
  })
  it('defaults to 17:00 local time and sends nothing without a date', () => {
    assert.equal(ms(taskPeriod('2026-07-01', null, 'Europe/Berlin').DueDateTime), '2026-07-01T15:00:00.000Z')
    assert.deepEqual(taskPeriod(null, '10:00', 'Europe/Berlin'), {})
  })
  it('formats times for speech', () => {
    assert.equal(spokenTime('08:00'), '8 Uhr')
    assert.equal(spokenTime('14:30'), '14 Uhr 30')
  })
})