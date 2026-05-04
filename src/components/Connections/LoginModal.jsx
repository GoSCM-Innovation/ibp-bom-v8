import { useState, useEffect, useRef } from 'react'
import ConnectionAvatar from './ConnectionAvatar'

export default function LoginModal({ conn, onLogin, onCancel }) {
  const defaultUser = conn.com0326?.user || conn.com0068?.user || ''
  const [user, setUser] = useState(defaultUser)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const passwordRef = useRef(null)

  useEffect(() => {
    passwordRef.current?.focus()
  }, [])

  function handleSubmit(e) {
    e.preventDefault()
    if (!user)     { setError('El usuario es obligatorio'); return }
    if (!password) { setError('La contraseña es obligatoria'); return }
    onLogin(user, password)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 12, padding: 28, width: 340, maxWidth: '90vw',
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
          {/* Hidden username field for password manager autocomplete */}
          <input type="hidden" name="connection-id" value={conn.id} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field
              label="Usuario"
              name="username"
              value={user}
              onChange={setUser}
              placeholder={defaultUser || 'COM_USER'}
              autoComplete="username"
              mono
            />
            <Field
              label="Contraseña"
              name="password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              type="password"
              autoComplete="current-password"
              inputRef={passwordRef}
            />
          </div>

          {error && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>✕ {error}</div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onCancel} style={{
              background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
              color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 16px',
            }}>Cancelar</button>
            <button type="submit" style={{
              background: 'var(--accent)', border: 'none', borderRadius: 6,
              color: '#000', fontSize: 12, fontWeight: 700, padding: '7px 20px',
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
