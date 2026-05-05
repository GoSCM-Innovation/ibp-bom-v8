import { useState, useEffect } from 'react'
import { proxyCall } from '../../services/proxyCall'

function enc(val) {
  return `%27${encodeURIComponent(val)}%27`
}

// Labels estáticos fallback (igual que StepsPanel)
const PARAM_LABEL = {
  P_ALGO: 'Planning Algorithm', P_ATD: 'Available-to-Deploy Profile', P_CBP: 'CBP Profile',
  P_DATE: 'Date', P_FLTID: 'Planning Filter', P_OPER: 'Operator Mode',
  P_PLSCOP: 'Network/Subnetwork Selection', P_PRF: 'Planning Run Profile', P_PRM: 'Generate PRM Data',
  P_REFDAY: 'Planning Start', P_SCEN: 'Scenario', P_SIMVE: 'Version or Scenario',
  P_STR: 'Planning Direction', P_SUGF: 'Generate Supply Usage and Gating Factors',
  P_TAP: 'Time Aggregation Profile', P_TYPE: 'Planning Run Type', P_TZONE: 'Time Zone',
  P_VERS: 'Version', P_WDAY: 'Weekday', S_DISPO: 'MRP Controller', S_LOCNO: 'Location',
  S_MATNR: 'Product', S_SUBN: 'Subnetwork', P_ACT: 'Operation', P_AREA: 'Planning Area',
  P_COMM: 'Comment', P_CPDATE: 'Date', P_CPMETH: 'Define By', P_CPTIME: 'Time',
  P_CPTZ: 'Time Zone', P_FRPID: 'From Period', P_NOTES: 'Planning Notes',
  P_OPID: 'Operator Profile', P_OPNAME: 'Operator Name', P_OPTYP: 'Operator Type',
  P_PPROP: 'Time Horizon', P_PROFID: 'Copy Operator Profile ID', P_SHARE: 'Share With',
  P_TIMSEL: 'Use Time Selection from Profile', P_TOPID: 'To Period',
  P_VFROM: 'From Version', P_VTO: 'To Version', S_KEYFG: 'Key Figures',
  S_KF_GRP: 'Key Figure Groups', S_MD: 'Master Data', S_RCODE: 'Reason Code',
  P_ATTFCS: 'Target Attribute', P_FM: 'Forecast Model', P_PL: 'Planning Level',
  P_SCMTP: 'S&OP Time Profile Level', S_VERS: 'Version',
}

function labelOf(name, labelMap) {
  return labelMap?.[name] ?? PARAM_LABEL[name] ?? name
}

const SECTION_ORDER = ['General', 'Control Parameters', 'Planning Start Settings', 'Planning Scope']

export default function ScheduleModal({ row, connection, session, onClose, onSuccess }) {
  const [meta, setMeta]           = useState({ loading: true, params: [], error: '' })
  // formValues: { [`${stepNr}|${name}`]: { low, high, option, sign } }
  const [formValues, setFormValues] = useState({})
  const [executing, setExecuting] = useState(false)
  const [execError, setExecError] = useState('')

  const label = row.JobTemplateText || row.JobTemplateName

  useEffect(() => {
    setMeta({ loading: true, params: [], error: '' })
    setFormValues({})
    setExecError('')

    const name = row.JobTemplateName

    Promise.all([
      proxyCall({ connection, session, path: `/JobTemplateRead?JobTemplateName=${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateParameterSet?$filter=JobTemplateName+eq+${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateParamGroupSet?$filter=JobTemplateName+eq+${enc(name)}` }).then(r => r.json()),
    ]).then(([tplData, pData, gData]) => {
      const pParams = pData?.d?.results ?? pData?.value ?? []
      const groups  = gData?.d?.results ?? gData?.value ?? []

      // Group text map
      const groupText = {}
      groups.forEach(g => { groupText[g.JobTemplateParamGroupName] = g.JobTemplateParamGroupText })

      // Group by param name from JobTemplateParameterSet
      const groupByParam = {}
      const mandatorySet = new Set()
      const readOnlySet  = new Set()
      const hiddenSetApi = new Set()
      pParams.forEach(p => {
        groupByParam[p.JobTemplateParameterName] = p.JobTemplateParamGroupName
        if (p.JobTempParamMandatoryInd === 'X') mandatorySet.add(p.JobTemplateParameterName)
        if (p.JobTempParamReadOnlyInd  === 'X') readOnlySet.add(p.JobTemplateParameterName)
        if (p.JobTempParamHiddenInd    === 'X') hiddenSetApi.add(p.JobTemplateParameterName)
      })

      // Parse sequences from JobTemplateRead
      let tplParams = []  // [{stepNr, name, label, hidden}]
      try {
        const td = JSON.parse(tplData?.d?.TemplateData ?? 'null')
        const sequences = td?.templates?.[0]?.sequences ?? []
        sequences.forEach((seq, seqIdx) => {
          const stepNr = seqIdx + 1
          ;(seq.seq_param_val ?? []).forEach(p => {
            tplParams.push({ stepNr, name: p.name, label: p.label, hiddenTpl: p.hidden === true })
          })
        })
      } catch { /* fall through */ }

      // Build final param list
      let params = []
      if (tplParams.length > 0) {
        // Use order from JobTemplateRead, filter hidden
        const labelMap = {}
        tplParams.forEach(p => { if (p.label) labelMap[p.name] = p.label })
        params = tplParams
          .filter(p => !p.hiddenTpl && !hiddenSetApi.has(p.name))
          .map(p => ({
            stepNr:    p.stepNr,
            name:      p.name,
            label:     labelOf(p.name, labelMap),
            group:     groupText[groupByParam[p.name]] ?? null,
            mandatory: mandatorySet.has(p.name),
            readOnly:  readOnlySet.has(p.name),
          }))
      } else if (pParams.length > 0) {
        // Fallback: use JobTemplateParameterSet, all params at StepNr=1
        params = pParams
          .filter(p => p.JobTempParamHiddenInd !== 'X')
          .map(p => ({
            stepNr:    1,
            name:      p.JobTemplateParameterName,
            label:     labelOf(p.JobTemplateParameterName, null),
            group:     groupText[p.JobTemplateParamGroupName] ?? null,
            mandatory: p.JobTempParamMandatoryInd === 'X',
            readOnly:  p.JobTempParamReadOnlyInd  === 'X',
          }))
      }

      // Initialize form values (empty)
      const init = {}
      params.forEach(p => {
        const key = `${p.stepNr}|${p.name}`
        init[key] = { low: '', high: '', option: 'EQ', sign: 'I' }
      })
      setFormValues(init)
      setMeta({ loading: false, params, error: '' })
    }).catch(e => {
      setMeta({ loading: false, params: [], error: e.message })
    })
  }, [row.JobTemplateName]) // eslint-disable-line react-hooks/exhaustive-deps

  function setField(stepNr, name, field, value) {
    const key = `${stepNr}|${name}`
    setFormValues(prev => ({ ...prev, [key]: { ...(prev[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }), [field]: value } }))
  }

  async function handleExecute() {
    // Validate mandatory
    const missing = meta.params.filter(p => {
      if (!p.mandatory) return false
      const key = `${p.stepNr}|${p.name}`
      return !(formValues[key]?.low?.trim())
    })
    if (missing.length > 0) {
      setExecError(`Campos obligatorios sin valor: ${missing.map(p => p.label).join(', ')}`)
      return
    }

    setExecuting(true)
    setExecError('')

    // Build JobParameterValues: only params with a value or all params if none specified
    const allParams = meta.params
    const paramValues = allParams
      .filter(p => {
        const key = `${p.stepNr}|${p.name}`
        const fv = formValues[key]
        return fv?.low?.trim() || fv?.high?.trim() // only include params with a value
      })
      .map(p => {
        const key = `${p.stepNr}|${p.name}`
        const fv = formValues[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }
        return {
          StepNr:           p.stepNr,
          JobParameterName: p.name,
          Sign:             fv.sign  || 'I',
          Option:           fv.option || 'EQ',
          Low:              fv.low   ?? '',
          High:             fv.high  ?? '',
        }
      })

    let path = `/JobSchedule?JobTemplateName=${enc(row.JobTemplateName)}&JobText=${enc(label)}`
    if (paramValues.length > 0) {
      path += `&JobParameterValues=${enc(JSON.stringify(paramValues))}`
    }

    try {
      const r = await proxyCall({ connection, session, path, method: 'POST', injectJobUser: true })
      const data = await r.json()
      if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
      onSuccess?.()
      onClose()
    } catch (e) {
      setExecError(e.message)
      setExecuting(false)
    }
  }

  // Group params by section for display
  const grouped  = {}
  const ungrouped = [];
  (meta.params ?? []).forEach(p => {
    if (p.group) { if (!grouped[p.group]) grouped[p.group] = []; grouped[p.group].push(p) }
    else ungrouped.push(p)
  })
  const orderedSecs = [
    ...SECTION_ORDER.filter(s => grouped[s]),
    ...Object.keys(grouped).filter(s => !SECTION_ORDER.includes(s)),
  ]
  if (ungrouped.length) orderedSecs.push(null)

  const hasParams = meta.params.length > 0

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={executing ? undefined : onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 500, backdropFilter: 'blur(2px)' }}
      />

      {/* Modal */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(560px, 95vw)', maxHeight: '85vh',
        background: 'var(--bg)', border: '1px solid var(--border2)',
        borderRadius: 12, zIndex: 501,
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,.5)',
        animation: 'scheduleModalIn .18s ease-out',
      }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Configurar y ejecutar job</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {label}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                {row.JobTemplateName}
              </div>
            </div>
            <button
              onClick={executing ? undefined : onClose}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', fontSize: 13, cursor: 'pointer', padding: '4px 10px', lineHeight: 1, flexShrink: 0 }}
            >✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 24px' }}>

          {meta.loading && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text2)', fontSize: 12 }}>
              Cargando parámetros…
            </div>
          )}

          {meta.error && (
            <div style={{ background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 8, padding: '10px 14px', color: 'var(--red)', fontSize: 12 }}>
              ✕ {meta.error}
            </div>
          )}

          {!meta.loading && !meta.error && !hasParams && (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text2)', fontSize: 12 }}>
              Este template no tiene parámetros configurables.
            </div>
          )}

          {!meta.loading && !meta.error && hasParams && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {orderedSecs.map(sec => {
                const list = sec ? grouped[sec] : ungrouped
                if (!list?.length) return null
                return (
                  <div key={sec ?? '__ungrouped'}>
                    {sec && (
                      <div style={{
                        fontSize: 10, fontWeight: 700, color: 'var(--text3)',
                        textTransform: 'uppercase', letterSpacing: '0.07em',
                        marginBottom: 10, paddingBottom: 5,
                        borderBottom: '1px solid var(--border)',
                      }}>
                        {sec}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {list.map(p => {
                        const key = `${p.stepNr}|${p.name}`
                        const fv  = formValues[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }
                        const isRange = fv.option === 'BT'
                        return (
                          <div key={key}>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 11, color: 'var(--text)', fontWeight: 500 }}>
                                  {p.label}
                                  {p.mandatory && <span style={{ color: '#ff6b6b', marginLeft: 3 }}>*</span>}
                                </span>
                                {p.label !== p.name && (
                                  <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{p.name}</span>
                                )}
                                {meta.params.some(x => x.stepNr > 1) && (
                                  <span style={{ fontSize: 9, color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>
                                    paso {p.stepNr}
                                  </span>
                                )}
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                {/* Option selector */}
                                <select
                                  value={fv.option}
                                  disabled={p.readOnly}
                                  onChange={e => setField(p.stepNr, p.name, 'option', e.target.value)}
                                  style={{
                                    background: 'var(--bg2)', border: '1px solid var(--border)',
                                    borderRadius: 5, color: 'var(--text2)', fontSize: 10,
                                    padding: '5px 6px', cursor: p.readOnly ? 'default' : 'pointer',
                                    flexShrink: 0, width: 52,
                                  }}
                                >
                                  <option value="EQ">=</option>
                                  <option value="NE">≠</option>
                                  <option value="LT">&lt;</option>
                                  <option value="LE">≤</option>
                                  <option value="GT">&gt;</option>
                                  <option value="GE">≥</option>
                                  <option value="BT">…</option>
                                  <option value="CP">~</option>
                                </select>
                                {/* Low value */}
                                <input
                                  type="text"
                                  value={fv.low}
                                  disabled={p.readOnly}
                                  placeholder={p.mandatory ? 'requerido' : ''}
                                  onChange={e => setField(p.stepNr, p.name, 'low', e.target.value)}
                                  style={{
                                    flex: 1, background: 'var(--bg2)',
                                    border: `1px solid ${p.mandatory && !fv.low?.trim() ? 'rgba(255,107,107,.5)' : 'var(--border)'}`,
                                    borderRadius: 5, color: 'var(--text)', fontSize: 11,
                                    padding: '6px 10px', outline: 'none',
                                    opacity: p.readOnly ? 0.5 : 1,
                                  }}
                                />
                                {/* High value (only for range) */}
                                {isRange && (
                                  <>
                                    <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>→</span>
                                    <input
                                      type="text"
                                      value={fv.high}
                                      disabled={p.readOnly}
                                      placeholder="hasta"
                                      onChange={e => setField(p.stepNr, p.name, 'high', e.target.value)}
                                      style={{
                                        flex: 1, background: 'var(--bg2)',
                                        border: '1px solid var(--border)',
                                        borderRadius: 5, color: 'var(--text)', fontSize: 11,
                                        padding: '6px 10px', outline: 'none',
                                      }}
                                    />
                                  </>
                                )}
                              </div>
                            </label>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {execError && (
            <div style={{
              background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)',
              borderRadius: 6, padding: '8px 12px', color: 'var(--red)',
              fontSize: 11, marginBottom: 12, wordBreak: 'break-word',
            }}>
              ✕ {execError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              onClick={executing ? undefined : onClose}
              disabled={executing}
              style={{
                padding: '7px 18px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text2)', fontSize: 12, cursor: executing ? 'default' : 'pointer',
              }}
            >
              Cancelar
            </button>
            <button
              onClick={handleExecute}
              disabled={executing || meta.loading}
              style={{
                padding: '7px 18px', borderRadius: 6,
                border: '1px solid rgba(34,197,94,.35)',
                background: 'rgba(34,197,94,.1)', color: '#22c55e',
                fontSize: 12, fontWeight: 600,
                cursor: (executing || meta.loading) ? 'default' : 'pointer',
                opacity: (executing || meta.loading) ? 0.6 : 1,
              }}
            >
              {executing ? 'Ejecutando…' : '▶ Ejecutar'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes scheduleModalIn {
          from { opacity: 0; transform: translate(-50%, calc(-50% + 12px)); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
      `}</style>
    </>
  )
}
