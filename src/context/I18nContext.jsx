import { createContext, useContext, useState } from 'react'
import es from '../i18n/es.json'
import en from '../i18n/en.json'

const dicts = { es, en }
const I18nContext = createContext(null)

function detect() {
  const stored = localStorage.getItem('ibp:lang')
  if (stored === 'es' || stored === 'en') return stored
  const browser = (navigator.language || 'es').slice(0, 2).toLowerCase()
  return browser === 'en' ? 'en' : 'es'
}

function resolve(lang, key, vars) {
  let val = dicts[lang]?.[key] ?? dicts['es']?.[key] ?? key
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    })
  }
  return val
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(detect)

  function setLang(newLang) {
    localStorage.setItem('ibp:lang', newLang)
    setLangState(newLang)
  }

  const t = (key, vars) => resolve(lang, key, vars)

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  return useContext(I18nContext)
}
