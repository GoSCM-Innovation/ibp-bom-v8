import { useState } from 'react'

export default function ConnectionForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    url: initial?.url || '',
    user: initial?.user || '',
    password: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(k, v) { setForm(p => ({ ...p, [k]: v })) }

  async function handleSave() {
    if (!form.name || !form.url || !form.user) { setError('Nombre, URL y usuario son obligatorios'); return }
    setSaving(true); setError('')
    try {
      const body = { name: form.name, url: form.url.replace(/\/$/, ''), user: form.user }
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Nombre conexión" value={form.name} onChange={v => set('name', v)} placeholder="ej: IBP Producción" />
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
        <button type="button" disabled={saving} onClick={handleSave} style={{
          background: 'var(--accent)', border: 'none', borderRadius: 6,
          color: '#000', fontSize: 12, fontWeight: 700, padding: '7px 18px',
        }}>{saving ? 'Guardando...' : initial ? 'Guardar cambios' : 'Crear conexión'}</button>
      </div>
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
