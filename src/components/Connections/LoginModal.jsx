import { useState, useEffect, useRef } from 'react'
import ConnectionAvatar from './ConnectionAvatar'

const COM_META = {
  com0326: { name: 'SAP_COM_0326', desc: 'Application Jobs' },
  com0068: { name: 'SAP_COM_0068', desc: 'Resource Stats' },
}

export default function LoginModal({ conn, existingSession, onLogin, onCancel }) {
  // All configured agreements, split by whether they already have credentials
  const allKeys    = ['com0326', 'com0068'].filter(k => conn[k]?.url)
  const pendingKeys = allKeys.filter(k => !existingSession?.[k]?.password)
  const multi      = allKeys.length > 1

  const [creds, setCreds] = useState(() =>
    Object.fromEntries(pendingKeys.map(k => [k, { user: conn[k]?.user || '', password: '' }]))
  )
  const [error, setError] = useState('')
  const firstPasswordRef = useRef(null)

  useEffect(() => { firstPasswordRef.current?.focus() }, [])

  function setField(key, field, value) {
    setCreds(p => ({ ...p, [key]: { ...p[key], [field]: value } }))
  }

  function handleSubmit(e) {
    e.preventDefault()
    for (const k of pendingKeys) {
      if (!creds[k].user)     { setError(`Usuario requerido para ${COM_META[k].name}`); return }
      if (!creds[k].password) { setError(`Contraseña requerida para ${COM_META[k].name}`); return }
    }
    onLogin(creds)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 12, padding: 28, width: 360, maxWidth: '90vw',
        boxShadow: '0 24px 48px rgba(0,0,0,.5)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <ConnectionAvatar name={conn.name} logoUrl={conn.logoUrl} size={36} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{conn.name}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>Iniciar sesión</div>
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

                  {/* Agreement label — always shown when multi */}
                  {multi && (
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 10,
                      color: authenticated ? 'var(--text3)' : 'var(--accent)' }}>
                      {COM_META[k].name} — {COM_META[k].desc}
                    </div>
                  )}

                  {authenticated ? (
                    /* Already logged in — show OK row */
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: 'rgba(52,211,153,.07)', border: '1px solid rgba(52,211,153,.2)',
                      borderRadius: 8, padding: '10px 14px',
                    }}>
                      <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
                        {existingSession[k].user}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399', letterSpacing: '.04em' }}>
                        ✓ activo
                      </span>
                    </div>
                  ) : (
                    /* Needs credentials */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <Field
                        label="Usuario"
                        name={`username-${k}`}
                        value={creds[k].user}
                        onChange={v => setField(k, 'user', v)}
                        placeholder={conn[k]?.user || 'COM_USER'}
                        autoComplete="username"
                        mono
                      />
                      <Field
                        label="Contraseña"
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
            }}>Cancelar</button>
            <button type="submit" style={{
              background: 'var(--accent)', border: 'none', borderRadius: 6,
              color: '#000', fontSize: 12, fontWeight: 700, padding: '7px 20px', cursor: 'pointer',
            }}>Ingresar</button>
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
