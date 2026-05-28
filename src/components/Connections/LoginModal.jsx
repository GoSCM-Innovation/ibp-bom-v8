import { useState, useEffect, useRef } from 'react'
import ConnectionAvatar from './ConnectionAvatar'
import { useI18n } from '../../context/I18nContext'
import { connDisplayName } from '../../utils/connDisplayName'

const ALL_AGREEMENTS = ['com0326', 'com0068', 'com0924', 'com0720']

const COM_META = {
  com0326: { name: 'SAP_COM_0326', desc: 'Application Jobs',   verifyPath: '/$metadata' },
  com0068: { name: 'SAP_COM_0068', desc: 'Resource Stats',     verifyPath: '/$metadata' },
  com0924: { name: 'SAP_COM_0924', desc: 'Metering Activity',  verifyPath: '/$metadata' },
  // MASTER_DATA_API_SRV/$metadata is ~4.8 MB — exceeds Vercel's response limit.
  // Use a minimal entity query instead (returns 20 bytes, same 401 on bad creds).
  com0720: { name: 'SAP_COM_0720', desc: 'Master Data',        verifyPath: '/VersionSpecificMasterDataTypes?$format=json&$top=0' },
}

async function verifyCredentials(conn, comKey, userCred) {
  const serviceRoot  = conn[comKey]?.url || ''
  const verifyPath   = COM_META[comKey]?.verifyPath ?? '/$metadata'
  const resp = await fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: serviceRoot + verifyPath,
      serviceRoot,
      user: userCred.user,
      password: userCred.password,
      method: 'GET',
    }),
  })
  return resp
}

export default function LoginModal({ conn, existingSession, onLogin, onCancel }) {
  const { t } = useI18n()

  const allKeys     = ALL_AGREEMENTS.filter(k => conn[k]?.url)
  const pendingKeys = allKeys.filter(k => !existingSession?.[k]?.password)
  const multi       = allKeys.length > 1

  const [creds, setCreds] = useState(() =>
    Object.fromEntries(pendingKeys.map(k => [k, { user: conn[k]?.user || '', password: '' }]))
  )
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const firstPasswordRef = useRef(null)

  useEffect(() => { firstPasswordRef.current?.focus() }, [])

  function setField(key, field, value) {
    setCreds(p => ({ ...p, [key]: { ...p[key], [field]: value } }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    for (const k of pendingKeys) {
      if (!creds[k].user)     { setError(t('login.errUserRequired', { name: COM_META[k].name })); return }
      if (!creds[k].password) { setError(t('login.errPwdRequired',  { name: COM_META[k].name })); return }
    }

    setError('')
    setLoading(true)
    try {
      for (const k of pendingKeys) {
        const resp = await verifyCredentials(conn, k, creds[k])
        if (!resp.ok) {
          if (resp.status === 401) {
            setError(multi
              ? t('login.err401Multi', { name: COM_META[k].name })
              : t('login.err401'))
          } else {
            let detail = ''
            try { const j = await resp.json(); detail = j?.detail || j?.error || '' } catch { /* noop */ }
            setError(detail || t('login.errConnect', { status: resp.status }))
          }
          setLoading(false)
          return
        }
      }
    } catch {
      setError(t('login.errNetwork'))
      setLoading(false)
      return
    }

    setLoading(false)
    onLogin(creds)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--overlay)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 12, padding: 28, width: 360, maxWidth: '90vw',
        boxShadow: 'var(--shadow-lg)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <ConnectionAvatar name={conn.name} logoUrl={conn.logoUrl} size={36} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{connDisplayName(conn, t)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{t('login.title')}</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} autoComplete="on">
          <input type="hidden" name="connection-id" value={conn.id} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {allKeys.map((k, i) => {
              const authenticated = !!existingSession?.[k]?.password
              return (
                <div key={k}>
                  {i > 0 && <div style={{ height: 1, background: 'var(--border)', margin: '16px 0' }} />}

                  {multi && (
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 10,
                      color: authenticated ? 'var(--text3)' : 'var(--accent)' }}>
                      {COM_META[k].name} — {COM_META[k].desc}
                    </div>
                  )}

                  {authenticated ? (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: 'color-mix(in srgb, var(--green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--green) 30%, transparent)',
                      borderRadius: 8, padding: '10px 14px',
                    }}>
                      <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
                        {existingSession[k].user}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', letterSpacing: '.04em' }}>
                        {t('login.statusActive')}
                      </span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <Field
                        label={t('login.user')}
                        name={`username-${k}`}
                        value={creds[k].user}
                        onChange={v => setField(k, 'user', v)}
                        placeholder={conn[k]?.user || 'COM_USER'}
                        autoComplete="username"
                        mono
                      />
                      <Field
                        label={t('login.password')}
                        name={`password-${k}`}
                        value={creds[k].password}
                        onChange={v => setField(k, 'password', v)}
                        placeholder="••••••••"
                        type="password"
                        autoComplete="current-password"
                        inputRef={pendingKeys.indexOf(k) === 0 ? firstPasswordRef : undefined}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {error && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>✕ {error}</div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onCancel} style={{
              background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
              color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 16px', cursor: 'pointer',
            }}>{t('login.cancel')}</button>
            <button type="submit" disabled={loading} style={{
              background: loading ? 'var(--border2)' : 'var(--accent)', border: 'none', borderRadius: 6,
              color: loading ? 'var(--text3)' : 'var(--text-on-accent)', fontSize: 12, fontWeight: 700, padding: '7px 20px',
              cursor: loading ? 'not-allowed' : 'pointer', transition: 'background .15s',
            }}>{loading ? t('login.verifying') : t('login.loginBtn')}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, name, value, onChange, placeholder, type = 'text', autoComplete, mono, inputRef }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
        {label}
      </label>
      <input
        ref={inputRef}
        type={type}
        name={name}
        value={value}
        autoComplete={autoComplete}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text)', fontFamily: mono ? 'var(--mono)' : 'var(--font)',
          fontSize: 12, padding: '8px 12px', outline: 'none',
        }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  )
}
