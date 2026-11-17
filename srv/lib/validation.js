// Input validation helpers. They are deliberately strict: AI output is untrusted.

export const SUPPORTED_LANGUAGES = ['de', 'en']

/** Returns true if `tz` is a valid IANA time zone known to the runtime. */
export function isValidTimeZone (tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }) // eslint-disable-line no-new
    return true
  } catch {
    return false
  }
}

/** Normalises a language code to 'de' | 'en', or returns null if unsupported. */
export function normaliseLanguage (lang) {
  if (typeof lang !== 'string') return null
  const l = lang.trim().slice(0, 2).toLowerCase()
  return SUPPORTED_LANGUAGES.includes(l) ? l : null
}
