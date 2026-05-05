import { useState, useEffect, useRef } from 'react'
import { proxyCall } from '../../services/proxyCall'

function enc(val) {
  return `%27${encodeURIComponent(val)}%27`
}

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
  const [meta, setMeta]               = useState({ loading: true, params: [], error: '' })
  const [formValues, setFormValues]   = useState({})
  const [dynHidden, setDynHidden]     = useState(new Set())
  const [dynReadOnly, setDynReadOnly] = useState(new Set())
  const [showOptional, setShowOptional] = useState(false)
  const [executing, setExecuting]     = useState(false)
  const [execError, setExecError]     = useState('')

  const formValuesRef = useRef({})
  const paramsRef     = useRef([])
  formValuesRef.current = formValues

  const label = row.JobTemplateText || row.JobTemplateName

  async function doScheduleCheck(currentValues, currentParams) {
    const values = currentValues ?? formValuesRef.current
    const params = currentParams ?? paramsRef.current
    if (!params.length) return

    const checkVals = params
      .filter(p => {
        const fv = values[`${p.stepNr}|${p.name}`]
        return fv?.low?.trim() || fv?.high?.trim()
      })
      .map(p => {
        const fv = values[`${p.stepNr}|${p.name}`]
        return {
          NAME:    p.name,
          T_VALUE: [{ SIGN: fv.sign || 'I', OPTION: fv.option || 'EQ', LOW: fv.low || '', HIGH: fv.high || '' }],
        }
      })

    try {
      const r = await proxyCall({
        connection, session,
        path:   `/JobScheduleCheck?JobTemplateName=${enc(row.JobTemplateName)}&JobParameterValues=${enc(JSON.stringify({ VALUES: checkVals }))}`,
        method: 'POST',
      })
      const data = await r.json()
      const d = data?.d ?? {}

      const dp = JSON.parse(d.DynamicProperties || '[]')
      const newHidden   = new Set()
      const newReadOnly = new Set()
      dp.forEach(p => {
        if (p.hidden)   newHidden.add(p.jobParameterName)
        if (p.readOnly) newReadOnly.add(p.jobParameterName)
      })
      setDynHidden(newHidden)
      setDynReadOnly(newReadOnly)

      // Auto-fill defaults solo para campos vacíos
      if (d.ChangedInd) {
        const returned = JSON.parse(d.JobParameterValues || '{"VALUES":[]}')
        setFormValues(prev => {
          const updated = { ...prev }
          ;(returned.VALUES ?? []).forEach(v => {
            const param = params.find(p => p.name === v.NAME)
            if (!param) return
            const key   = `${param.stepNr}|${param.name}`
            const first = v.T_VALUE?.[0]
            if (!updated[key]?.low?.trim() && first?.LOW) {
              updated[key] = { low: first.LOW ?? '', high: first.HIGH ?? '', option: first.OPTION ?? 'EQ', sign: first.SIGN ?? 'I' }
            }
          })
          return updated
        })
      }
    } catch { /* silencioso */ }
  }

  useEffect(() => {
    setMeta({ loading: true, params: [], error: '' })
    setFormValues({})
    setDynHidden(new Set())
    setDynReadOnly(new Set())
    setShowOptional(false)
    setExecError('')

    const name = row.JobTemplateName

    Promise.all([
      proxyCall({ connection, session, path: `/JobTemplateRead?JobTemplateName=${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateParameterSet?$filter=JobTemplateName+eq+${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateParamGroupSet?$filter=JobTemplateName+eq+${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/TemplateValuesGet?JobTemplateName=${enc(name)}` }).then(r => r.json()),
    ]).then(([tplData, pData, gData, tvData]) => {
      const pParams = pData?.d?.results ?? pData?.value ?? []
      const groups  = gData?.d?.results ?? gData?.value ?? []

      const groupText = {}
      groups.forEach(g => { groupText[g.JobTemplateParamGroupName] = g.JobTemplateParamGroupText })

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

      // Valores pre-configurados del template (TemplateValuesGet)
      const prefilledValues = {}
      try {
        const tvParsed = JSON.parse(tvData?.d?.ParameterValues ?? 'null')
        ;(tvParsed?.VALUES ?? []).forEach(v => {
          const first = v.T_VALUE?.[0]
          if (first?.LOW) prefilledValues[v.NAME] = { low: first.LOW, high: first.HIGH ?? '', option: first.OPTION ?? 'EQ', sign: first.SIGN ?? 'I' }
        })
      } catch { /* ignorar */ }

      let tplParams = []
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

      let params = []
      if (tplParams.length > 0) {
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

      // Init form: primero vacío, luego sobreescribir con valores pre-configurados
      const init = {}
      params.forEach(p => {
        const key = `${p.stepNr}|${p.name}`
        init[key] = prefilledValues[p.name] ?? { low: '', high: '', option: 'EQ', sign: 'I' }
      })

      paramsRef.current = params
      setFormValues(init)
      setMeta({ loading: false, params, error: '' })

      // Check inicial con valores pre-configurados para mejor contexto
      doScheduleCheck(init, params)
    }).catch(e => {
      setMeta({ loading: false, params: [], error: e.message })
    })
  }, [row.JobTemplateName]) // eslint-disable-line react-hooks/exhaustive-deps

  function setField(stepNr, name, field, value) {
    const key = `${stepNr}|${name}`
    setFormValues(prev => ({ ...prev, [key]: { ...(prev[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }), [field]: value } }))
  }

  function handleBlur() {
    doScheduleCheck()
  }

  async function handleExecute() {
    const missing = meta.params.filter(p => {
      if (!p.mandatory || dynHidden.has(p.name)) return false
      const key = `${p.stepNr}|${p.name}`
      return !(formValues[key]?.low?.trim())
    })
    if (missing.length > 0) {
      setExecError(`Campos obligatorios sin valor: ${missing.map(p => p.label).join(', ')}`)
      return
    }

    setExecuting(true)
    setExecError('')

    const paramValues = meta.params
      .filter(p => {
        const key = `${p.stepNr}|${p.name}`
        const fv = formValues[key]
        return fv?.low?.trim() || fv?.high?.trim()
      })
      .map(p => {
        const key = `${p.stepNr}|${p.name}`
        const fv = formValues[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }
        return { StepNr: p.stepNr, JobParameterName: p.name, Sign: fv.sign || 'I', Option: fv.option || 'EQ', Low: fv.low ?? '', High: fv.high ?? '' }
      })

    let path = `/JobSchedule?JobTemplateName=${enc(row.JobTemplateName)}&JobText=${enc(label)}`
    if (paramValues.length > 0) path += `&JobParameterValues=${enc(JSON.stringify(paramValues))}`

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

  // Clasificar params: primarios (mandatory | pre-llenado | dinámicamente requerido) vs opcionales
  const visibleParams = (meta.params ?? []).filter(p => !dynHidden.has(p.name))

  const primaryParams   = visibleParams.filter(p => {
    const key = `${p.stepNr}|${p.name}`
    const hasPrefill = formValues[key]?.low?.trim()
    return p.mandatory || hasPrefill
  })
  const optionalParams  = visibleParams.filter(p => {
    const key = `${p.stepNr}|${p.name}`
    const hasPrefill = formValues[key]?.low?.trim()
    return !p.mandatory && !hasPrefill
  })

  // Si no hay primarios, mostrar todo directamente (sin colapsar)
  const forceShowAll = primaryParams.length === 0
  const displayParams = forceShowAll
    ? visibleParams
    : (showOptional ? visibleParams : primaryParams)

  function buildSections(params) {
    const grouped   = {}
    const ungrouped = []
    params.forEach(p => {
      if (p.group) { if (!grouped[p.group]) grouped[p.group] = []; grouped[p.group].push(p) }
      else ungrouped.push(p)
    })
    const ordered = [
      ...SECTION_ORDER.filter(s => grouped[s]),
      ...Object.keys(grouped).filter(s => !SECTION_ORDER.includes(s)),
    ]
    if (ungrouped.length) ordered.push(null)
    return { grouped, ungrouped, ordered }
  }

  const { grouped, ungrouped, ordered } = buildSections(displayParams)
  const hasParams = visibleParams.length > 0

  function renderParam(p) {
    const key     = `${p.stepNr}|${p.name}`
    const fv      = formValues[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }
    const isRange = fv.option === 'BT'
    const isRO    = p.readOnly || dynReadOnly.has(p.name)
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
            <select
              value={fv.option} disabled={isRO}
              onChange={e => setField(p.stepNr, p.name, 'option', e.target.value)}
              onBlur={handleBlur}
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text2)', fontSize: 10, padding: '5px 6px', cursor: isRO ? 'default' : 'pointer', flexShrink: 0, width: 52 }}
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
            <input
              type="text" value={fv.low} disabled={isRO}
              placeholder={p.mandatory ? 'requerido' : ''}
              onChange={e => setField(p.stepNr, p.name, 'low', e.target.value)}
              onBlur={handleBlur}
              style={{ flex: 1, background: 'var(--bg2)', border: `1px solid ${p.mandatory && !fv.low?.trim() ? 'rgba(255,107,107,.5)' : 'var(--border)'}`, borderRadius: 5, color: 'var(--text)', fontSize: 11, padding: '6px 10px', outline: 'none', opacity: isRO ? 0.5 : 1 }}
            />
            {isRange && (
              <>
                <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>→</span>
                <input
                  type="text" value={fv.high} disabled={isRO} placeholder="hasta"
                  onChange={e => setField(p.stepNr, p.name, 'high', e.target.value)}
                  onBlur={handleBlur}
                  style={{ flex: 1, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', fontSize: 11, padding: '6px 10px', outline: 'none' }}
                />
              </>
            )}
          </div>
        </label>
      </div>
    )
  }

  return (
    <>
      <div
        onClick={executing ? undefined : onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 500, backdropFilter: 'blur(2px)' }}
      />

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
              <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{row.JobTemplateName}</div>
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
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text2)', fontSize: 12 }}>Cargando parámetros…</div>
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
              {ordered.map(sec => {
                const list = sec ? grouped[sec] : ungrouped
                if (!list?.length) return null
                return (
                  <div key={sec ?? '__ungrouped'}>
                    {sec && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10, paddingBottom: 5, borderBottom: '1px solid var(--border)' }}>
                        {sec}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {list.map(renderParam)}
                    </div>
                  </div>
                )
              })}

              {/* Toggle de parámetros opcionales */}
              {!forceShowAll && optionalParams.length > 0 && (
                <button
                  onClick={() => setShowOptional(v => !v)}
                  style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                    color: 'var(--text3)', fontSize: 11, cursor: 'pointer',
                    padding: '7px 14px', textAlign: 'left',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <span style={{ fontSize: 10 }}>{showOptional ? '▲' : '▼'}</span>
                  {showOptional
                    ? `Ocultar parámetros opcionales (${optionalParams.length})`
                    : `Mostrar parámetros opcionales (${optionalParams.length})`}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {execError && (
            <div style={{ background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 6, padding: '8px 12px', color: 'var(--red)', fontSize: 11, marginBottom: 12, wordBreak: 'break-word' }}>
              ✕ {execError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              onClick={executing ? undefined : onClose} disabled={executing}
              style={{ padding: '7px 18px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 12, cursor: executing ? 'default' : 'pointer' }}
            >
              Cancelar
            </button>
            <button
              onClick={handleExecute} disabled={executing || meta.loading}
              style={{ padding: '7px 18px', borderRadius: 6, border: '1px solid rgba(34,197,94,.35)', background: 'rgba(34,197,94,.1)', color: '#22c55e', fontSize: 12, fontWeight: 600, cursor: (executing || meta.loading) ? 'default' : 'pointer', opacity: (executing || meta.loading) ? 0.6 : 1 }}
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
