import { useState } from 'react'
import { upsert } from '../../services/connectionStorage'

const AMBIENTES = [
  { value: '', label: 'Seleccionar...' },
  { value: 'Calidad', label: 'Calidad' },
  { value: 'Producción', label: 'Producción' },
]

export default function ConnectionForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState({
    name:     initial?.name ? initial.name.replace(/ \((Calidad|Producción)\)$/, '') : '',
    ambiente: initial?.ambiente || '',
    jobUser:  initial?.jobUser  || '',
    logoUrl:  initial?.logoUrl  || '',
    com0326: {
      url:  initial?.com0326?.url  || '',
      user: initial?.com0326?.user || '',
    },
    com0068: {
      url:  initial?.com0068?.url  || '',
      user: initial?.com0068?.user || '',
    },
  })
  const [error, setError] = useState('')

  function setGeneral(k, v) { setForm(p => ({ ...p, [k]: v })) }
  function setAgreement(key, k, v) { setForm(p => ({ ...p, [key]: { ...p[key], [k]: v } })) }

  function validateAgreement(a, name) {
    const hasAny = a.url || a.user
    if (!hasAny) return null
    if (!a.url)  return `${name}: falta la URL`
    if (!a.user) return `${name}: falta el usuario`
    return null
  }

  function handleSave() {
    if (!form.name)    { setError('El nombre es obligatorio'); return }
    if (!form.ambiente) { setError('Selecciona un ambiente'); return }

    const err326 = validateAgreement(form.com0326, 'SAP_COM_0326')
    const err068 = validateAgreement(form.com0068, 'SAP_COM_0068')
    if (err326) { setError(err326); return }
    if (err068) { setError(err068); return }

    const conn = {
      ...(initial ? { ...initial } : {}),
      name:     `${form.name} (${form.ambiente})`,
      ambiente: form.ambiente,
      jobUser:  form.jobUser,
      logoUrl:  form.logoUrl,
    }

    const has326 = form.com0326.url || form.com0326.user
    const has068 = form.com0068.url || form.com0068.user

    if (has326) {
      conn.com0326 = { url: form.com0326.url.replace(/\/$/, ''), user: form.com0326.user }
    } else {
      delete conn.com0326
    }

    if (has068) {
      conn.com0068 = { url: form.com0068.url.replace(/\/$/, ''), user: form.com0068.user }
    } else {
      delete conn.com0068
    }

    upsert(conn)
    onSaved()
  }

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10, padding: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 20 }}>
        {initial ? 'Editar conexión' : 'Nueva conexión'}
      </div>

      {/* General */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
        <Field label="Nombre conexión" value={form.name} onChange={v => setGeneral('name', v)} placeholder="ej: IBP Cliente ABC" />
        <SelectField label="Ambiente" value={form.ambiente} onChange={v => setGeneral('ambiente', v)} options={AMBIENTES} />
        <Field label="Usuario de negocio (JobUser, opcional)" value={form.jobUser} onChange={v => setGeneral('jobUser', v)} placeholder="EXT_USUARIO" mono />
        <Field label="URL del logo (opcional)" value={form.logoUrl} onChange={v => setGeneral('logoUrl', v)} placeholder="https://empresa.com/logo.png" />
      </div>

      {/* SAP_COM_0326 */}
      <AgreementSection
        title="SAP_COM_0326 — Application Jobs"
        subtitle="Resumen · Job Templates · Job Monitor"
        values={form.com0326}
        onChange={(k, v) => setAgreement('com0326', k, v)}
      />

      {/* SAP_COM_0068 */}
      <AgreementSection
        title="SAP_COM_0068 — Resource Consumption"
        subtitle="Resource Stats"
        values={form.com0068}
        onChange={(k, v) => setAgreement('com0068', k, v)}
      />

      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text2)' }}>
        La contraseña se pedirá al iniciar sesión en cada conexión — no se guarda aquí.
      </div>

      {form.name && form.ambiente && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
          Nombre final: <strong style={{ color: 'var(--text)' }}>{form.name} ({form.ambiente})</strong>
        </div>
      )}
      {error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>✕ {error}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={{
          background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
          color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 18px',
        }}>Cancelar</button>
        <button type="button" onClick={handleSave} style={{
          background: 'var(--accent)', border: 'none', borderRadius: 6,
          color: '#000', fontSize: 12, fontWeight: 700, padding: '7px 18px',
        }}>{initial ? 'Guardar cambios' : 'Crear conexión'}</button>
      </div>
    </div>
  )
}

function AgreementSection({ title, subtitle, values, onChange }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {title}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="URL API" value={values.url} onChange={v => onChange('url', v)} placeholder="https://tenant-api.scmibp.ondemand.com/..." mono />
        <Field label="Usuario de comunicación" value={values.user} onChange={v => onChange('user', v)} placeholder="COM_USER" mono />
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

function SelectField({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em' }}>{label}</label>
      <select
        value={value} onChange={e => onChange(e.target.value)}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          color: value ? 'var(--text)' : 'var(--text3)', fontFamily: 'var(--font)',
          fontSize: 12, padding: '8px 12px', outline: 'none', cursor: 'pointer',
        }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e => e.target.style.borderColor = 'var(--border)'}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
