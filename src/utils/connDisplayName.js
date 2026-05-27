/**
 * Returns the connection name with the environment suffix translated
 * to the active language via the i18n `t` function.
 *
 * The name is stored as "Agrosuper (Calidad)" in localStorage.
 * This function replaces the raw Spanish ambiente with the translated label
 * so the UI always shows the correct language (e.g. "Agrosuper (Quality)").
 */
const ENV_KEY_MAP = {
  'Calidad':    'form.envQuality',
  'Producción': 'form.envProduction',
}

export function connDisplayName(c, t) {
  if (!c || !c.ambiente) return c?.name ?? ''
  const key = ENV_KEY_MAP[c.ambiente]
  if (!key) return c.name
  const translated = t(key)
  if (translated === c.ambiente) return c.name            // same language — no change
  return c.name.replace(`(${c.ambiente})`, `(${translated})`)
}
