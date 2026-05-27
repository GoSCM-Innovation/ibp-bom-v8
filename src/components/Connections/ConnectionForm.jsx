import { useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useI18n } from '../../context/I18nContext'
import { upsert } from '../../services/connectionStorage'

export default function ConnectionForm({ initial, onSaved, onCancel }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
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
    com0924: {
      url:  initial?.com0924?.url  || '',
      user: initial?.com0924?.user || '',
    },
  })
  const [error, setError] = useState('')

  const AMBIENTES = [
    { value: '', label: t('form.envSelect') },
    { value: 'Calidad', label: t('form.envQuality') },
    { value: 'Producción', label: t('form.envProduction') },
  ]

  function setGeneral(k, v) { setForm(p => ({ ...p, [k]: v })) }
  function setAgreement(key, k, v) { setForm(p => ({ ...p, [key]: { ...p[key], [k]: v } })) }

  function validateAgreement(a, name) {
    const hasAny = a.url || a.user
    if (!hasAny) return null
    if (!a.url)  return t('form.errAgreeMissingUrl', { name })
    if (!a.user) return t('form.errAgreeMissingUser', { name })
    return null
  }

  function handleSave() {
    if (!form.name)    { setError(t('form.errNameRequired')); return }
    if (!form.ambiente) { setError(t('form.errEnvRequired')); return }

    const err326      = validateAgreement(form.com0326,     'SAP_COM_0326')
    const err068      = validateAgreement(form.com0068,     'SAP_COM_0068')
    const errMetering = validateAgreement(form.com0924, 'SAP_COM_0924')
    if (err326)      { setError(err326);      return }
    if (err068)      { setError(err068);      return }
    if (errMetering) { setError(errMetering); return }

    const conn = {
      ...(initial ? { ...initial } : {}),
      name:     `${form.name} (${form.ambiente})`,
      ambiente: form.ambiente,
      jobUser:  form.jobUser,
      logoUrl:  form.logoUrl,
    }

    const has326      = form.com0326.url     || form.com0326.user
    const has068      = form.com0068.url     || form.com0068.user
    const hasMetering = form.com0924.url || form.com0924.user

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

    if (hasMetering) {
      conn.com0924 = { url: form.com0924.url.replace(/\/$/, ''), user: form.com0924.user }
    } else {
      delete conn.com0924
    }

    upsert(conn)
    onSaved()
  }

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10, padding: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 20 }}>
        {initial ? t('form.editTitle') : t('form.newTitle')}
      </div>

      {/* General */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14, marginBottom: 24 }}>
        <Field label={t('form.nameLabel')} value={form.name} onChange={v => setGeneral('name', v)} placeholder="ej: IBP Cliente ABC" />
        <SelectField label={t('form.envLabel')} value={form.ambiente} onChange={v => setGeneral('ambiente', v)} options={AMBIENTES} />
        <Field label={t('form.jobUserLabel')} value={form.jobUser} onChange={v => setGeneral('jobUser', v)} placeholder="EXT_USUARIO" mono />
        <Field label={t('form.logoLabel')} value={form.logoUrl} onChange={v => setGeneral('logoUrl', v)} placeholder="https://empresa.com/logo.png" />
      </div>

      {/* SAP_COM_0326 */}
      <AgreementSection
        title={t('form.agree0326Label')}
        subtitle={t('form.agree0326Subtitle')}
        values={form.com0326}
        onChange={(k, v) => setAgreement('com0326', k, v)}
        urlLabel={t('form.agreeUrlLabel')}
        userLabel={t('form.userLabel')}
        isMobile={isMobile}
      />

      {/* SAP_COM_0068 */}
      <AgreementSection
        title={t('form.agree0068Title')}
        subtitle={t('form.agree0068Subtitle')}
        values={form.com0068}
        onChange={(k, v) => setAgreement('com0068', k, v)}
        urlLabel={t('form.agreeUrlLabel')}
        userLabel={t('form.userLabel')}
        isMobile={isMobile}
      />

      {/* SAP_COM_0924 */}
      <AgreementSection
        title={t('form.agree0924Title')}
        subtitle={t('form.agree0924Subtitle')}
        values={form.com0924}
        onChange={(k, v) => setAgreement('com0924', k, v)}
        urlPlaceholder="https://tenant-api.scmibp.ondemand.com/sap/opu/odata4/ibp/api_meteringactivity/srvd_a2x/ibp/api_meteringactivity/0001"
        urlLabel={t('form.agreeUrlLabel')}
        userLabel={t('form.userLabel')}
        isMobile={isMobile}
      />

      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text2)' }}>
        {t('form.passwordNote')}
      </div>

      {form.name && form.ambiente && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
          {t('form.finalName')} <strong style={{ color: 'var(--text)' }}>
            {form.name} ({AMBIENTES.find(o => o.value === form.ambiente)?.label || form.ambiente})
          </strong>
        </div>
      )}
      {error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>✕ {error}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={{
          background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
          color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 18px',
        }}>{t('form.cancel')}</button>
        <button type="button" onClick={handleSave} style={{
          background: 'var(--accent)', border: 'none', borderRadius: 6,
          color: 'var(--text-on-accent)', fontSize: 12, fontWeight: 700, padding: '7px 18px',
        }}>{initial ? t('form.saveBtnEdit') : t('form.saveBtnNew')}</button>
      </div>
    </div>
  )
}

function AgreementSection({ title, subtitle, values, onChange, urlPlaceholder, urlLabel, userLabel, isMobile }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {title}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
        <Field label={urlLabel} value={values.url} onChange={v => onChange('url', v)} placeholder={urlPlaceholder || 'https://tenant-api.scmibp.ondemand.com/...'} mono />
        <Field label={userLabel} value={values.user} onChange={v => onChange('user', v)} placeholder="COM_USER" mono />
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
