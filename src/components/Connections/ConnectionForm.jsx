import { useState, useRef, useEffect } from 'react'
import EmojiPicker from 'emoji-picker-react'

export default function ConnectionForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    url: initial?.url || '',
    user: initial?.user || '',
    password: '',
    emoji: initial?.emoji || '🏢',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const pickerRef = useRef(null)

  useEffect(() => {
    if (!showPicker) return
    function handleClick(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) setShowPicker(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showPicker])

  function set(k, v) { setForm(p => ({ ...p, [k]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.name || !form.url || !form.user) { setError('Nombre, URL y usuario son obligatorios'); return }
    setSaving(true); setError('')
    try {
      const body = { name: form.name, url: form.url.replace(/\/$/, ''), user: form.user, emoji: form.emoji }
      if (form.password) body.password = form.password
      const res = await fetch(
        initial ? `/api/connections/${initial.id}` : '/api/connections',
        { method: initial ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      )
      if (!res.ok) throw new Error((await res.json()).error || 'Error')
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10, padding: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 20 }}>
        {initial ? 'Editar conexión' : 'Nueva conexión'}
      </div>
      <form onSubmit={handleSubmit}>
        {/* Emoji + Nombre */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 14 }}>
          <div style={{ flexShrink: 0 }}>
            <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em', display: 'block', marginBottom: 5 }}>Ícono</label>
            <div style={{ position: 'relative' }} ref={pickerRef}>
              <button
                type="button"
                onClick={() => setShowPicker(p => !p)}
                style={{
                  width: 48, height: 36, fontSize: 22, background: 'var(--bg)',
                  border: `1px solid ${showPicker ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 6, cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                {form.emoji}
              </button>
              {showPicker && (
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 400 }}>
                  <EmojiPicker
                    onEmojiClick={e => { set('emoji', e.emoji); setShowPicker(false) }}
                    theme="dark"
                    searchPlaceholder="Buscar emoji..."
                    height={380}
                    width={320}
                  />
                </div>
              )}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Nombre conexión" value={form.name} onChange={v => set('name', v)} placeholder="ej: IBP Producción" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label="API URL" value={form.url} onChange={v => set('url', v)} placeholder="https://my400444-api.scmibp.ondemand.com/..." mono />
          <Field label="Usuario" value={form.user} onChange={v => set('user', v)} placeholder="COMM_USER" mono />
          <Field label={initial ? 'Contraseña (dejar vacío para mantener)' : 'Contraseña'} value={form.password} onChange={v => set('password', v)} type="password" placeholder={initial ? '••••••••' : 'Contraseña'} />
        </div>

        {error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>✕ {error}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={{
            background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
            color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 18px',
          }}>Cancelar</button>
          <button type="submit" disabled={saving} style={{
            background: 'var(--accent)', border: 'none', borderRadius: 6,
            color: '#000', fontSize: 12, fontWeight: 700, padding: '7px 18px',
          }}>{saving ? 'Guardando...' : initial ? 'Guardar cambios' : 'Crear conexión'}</button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', mono }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em' }}>{label}</label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
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
