import { useState } from 'react'

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
      url:      initial?.com0326?.url      || '',
      user:     initial?.com0326?.user     || '',
      password: '',
    },
    com0068: {
      url:      initial?.com0068?.url      || '',
      user:     initial?.com0068?.user     || '',
      password: '',
      taskmon: {
        enabled: !!initial?.com0068?.taskmon?.enabled,
        url:     initial?.com0068?.taskmon?.url || '',
      },
    },
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function setGeneral(k, v) { setForm(p => ({ ...p, [k]: v })) }
  function setAgreement(key, k, v) { setForm(p => ({ ...p, [key]: { ...p[key], [k]: v } })) }
  function setTaskmon(k, v) {
    setForm(p => ({ ...p, com0068: { ...p.com0068, taskmon: { ...p.com0068.taskmon, [k]: v } } }))
  }

  function validateAgreement(a, name, isNew) {
    const hasAny = a.url || a.user || a.password
    if (!hasAny) return null // vacío completo → se omite, ok
    if (!a.url)  return `${name}: falta la URL`
    if (!a.user) return `${name}: falta el usuario`
    if (isNew && !a.password) return `${name}: la contraseña es obligatoria para conexiones nuevas`
    return null
  }

  async function handleSave() {
    if (!form.name)    { setError('El nombre es obligatorio'); return }
    if (!form.ambiente) { setError('Selecciona un ambiente'); return }

    const isNew = !initial
    const err326 = validateAgreement(form.com0326, 'SAP_COM_0326', isNew)
    const err068 = validateAgreement(form.com0068, 'SAP_COM_0068', isNew)
    if (err326) { setError(err326); return }
    if (err068) { setError(err068); return }

    setSaving(true); setError('')
    try {
      const body = {
        name:     `${form.name} (${form.ambiente})`,
        ambiente: form.ambiente,
        jobUser:  form.jobUser,
        logoUrl:  form.logoUrl,
      }
      if (initial) body.id = initial.id

      // Incluir acuerdo solo si tiene url+user (password es opcional en edición)
      if (form.com0326.url || form.com0326.user) {
        body.com0326 = {
          url:  form.com0326.url.replace(/\/$/, ''),
          user: form.com0326.user,
          ...(form.com0326.password ? { password: form.com0326.password } : {}),
        }
      } else if (initial) {
        // Edición: el usuario vació la sección → eliminar el acuerdo
        body.com0326 = null
      }

      if (form.com0068.url || form.com0068.user) {
        body.com0068 = {
          url:  form.com0068.url.replace(/\/$/, ''),
          user: form.com0068.user,
          ...(form.com0068.password ? { password: form.com0068.password } : {}),
          taskmon: {
            enabled: !!form.com0068.taskmon.enabled,
            url:     (form.com0068.taskmon.url || '').replace(/\/$/, ''),
          },
        }
      } else if (initial) {
        body.com0068 = null
      }

      const res = await fetch('/api/connections', {
        method:  initial ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
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

      {/* General */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
        <Field label="Nombre conexión" value={form.name} onChange={v => setGeneral('name', v)} placeholder="ej: IBP Cliente ABC" />
        <SelectField label="Ambiente" value={form.ambiente} onChange={v => setGeneral('ambiente', v)} options={AMBIENTES} />
        <Field label="Usuario de negocio (JobUser)" value={form.jobUser} onChange={v => setGeneral('jobUser', v)} placeholder="EXT_USUARIO" mono />
        <Field label="URL del logo (opcional)" value={form.logoUrl} onChange={v => setGeneral('logoUrl', v)} placeholder="https://empresa.com/logo.png" />
      </div>

      {/* SAP_COM_0326 */}
      <AgreementSection
        title="SAP_COM_0326 — Application Jobs"
        subtitle="Resumen · Job Templates · Job Monitor"
        values={form.com0326}
        onChange={(k, v) => setAgreement('com0326', k, v)}
        isEditing={!!initial}
        hasExisting={!!initial?.com0326?.user}
      />

      {/* SAP_COM_0068 */}
      <AgreementSection
        title="SAP_COM_0068 — Resource Consumption"
        subtitle="Resource Stats · Job Performance (opcional)"
        values={form.com0068}
        onChange={(k, v) => setAgreement('com0068', k, v)}
        isEditing={!!initial}
        hasExisting={!!initial?.com0068?.user}
      />

      {/* Task Monitor (sub-servicio de COM_0068) */}
      <div style={{
        marginLeft: 0, marginBottom: 20, padding: '12px 14px',
        background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 8,
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!form.com0068.taskmon.enabled}
            onChange={e => setTaskmon('enabled', e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>
              Habilitar Job Performance (Task Monitor)
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
              Telemetría de ejecución (CPU HANA, memoria HANA, duración real). Usa las mismas credenciales de COM_0068.
            </div>
          </div>
        </label>
        {form.com0068.taskmon.enabled && (
          <div style={{ marginTop: 12 }}>
            <Field
              label="URL del servicio TASKMON_EXT_SRV"
              value={form.com0068.taskmon.url}
              onChange={v => setTaskmon('url', v)}
              placeholder="https://tenant-api.scmibp.ondemand.com/sap/opu/odata/IBP/TASKMON_EXT_SRV"
              mono
            />
          </div>
        )}
      </div>

      {form.name && form.ambiente && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text2)' }}>
          Nombre final: <strong style={{ color: 'var(--text)' }}>{form.name} ({form.ambiente})</strong>
        </div>
      )}
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

function AgreementSection({ title, subtitle, values, onChange, isEditing, hasExisting }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {title}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
        <Field label="URL API" value={values.url} onChange={v => onChange('url', v)} placeholder="https://tenant-api.scmibp.ondemand.com/..." mono />
        <Field label="Usuario" value={values.user} onChange={v => onChange('user', v)} placeholder="COM_USER" mono />
        <Field
          label={isEditing && hasExisting ? 'Contraseña (vacío = mantener)' : 'Contraseña'}
          value={values.password}
          onChange={v => onChange('password', v)}
          type="password"
          placeholder={isEditing && hasExisting ? '••••••••' : 'Contraseña'}
        />
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
