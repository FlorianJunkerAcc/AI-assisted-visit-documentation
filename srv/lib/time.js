// Time zone and OData date helpers (no external dependencies; uses Intl).

const partsIn = (tz, date) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).map(p => [p.type, p.value])
)

/** Offset of `tz` from UTC at instant `date`, in milliseconds. */
export function tzOffsetMs (tz, date) {
  const p = partsIn(tz, date)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** UTC instant of local wall-clock time y-m-d hh:mm in `tz`. */
export function zonedTimeToUtc (tz, y, m, d, hh = 0, mm = 0) {
  const wall = Date.UTC(y, m - 1, d, hh, mm)
  let guess = wall
  for (let i = 0; i < 3; i++) guess = wall - tzOffsetMs(tz, new Date(guess))
  return new Date(guess)
}

/** Local calendar date { y, m, d } of `date` in `tz`. */
export function localDate (tz, date = new Date()) {
  const p = partsIn(tz, date)
  return { y: +p.year, m: +p.month, d: +p.day }
}

/** [start, end) of the local calendar day containing `now`, as UTC Dates. */
export function localDayRangeUtc (tz, now = new Date()) {
  const { y, m, d } = localDate(tz, now)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return {
    start: zonedTimeToUtc(tz, y, m, d),
    end: zonedTimeToUtc(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
  }
}

/** Parses OData V2 "/Date(1794828600000)/" (optionally with offset), ISO strings and Dates. */
export function parseODataDate (value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return value
  const m = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(String(value))
  if (m) return new Date(Number(m[1]))
  const d = new Date(value)
  return isNaN(d) ? null : d
}

/** OData V2 literal for an Edm.DateTimeOffset filter value. */
export const dateTimeOffsetLiteral = (date) =>
  `datetimeoffset'${date.toISOString().replace(/\.\d{3}Z$/, 'Z')}'`

/** "HH:mm" of `date` in `tz`. */
export function formatLocalTime (tz, date) {
  if (!date) return null
  const p = partsIn(tz, date)
  return `${p.hour}:${p.minute}`
}

/** "YYYY-MM-DD" of `date` in `tz`. */
export function formatLocalDate (tz, date) {
  if (!date) return null
  const { y, m, d } = localDate(tz, date)
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
