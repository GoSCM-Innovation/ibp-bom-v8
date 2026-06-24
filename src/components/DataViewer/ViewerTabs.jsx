// ─────────────────────────────────────────────────────────────────────────────
// ViewerTabs.jsx — generic multi-tab shell for the data viewers (Ver DM / Ver DT).
//
// Lets the user keep several views open at once. The shell owns the tab list, the
// active tab and which tabs are MOUNTED; the inner viewer (passed via `renderTab`)
// owns its own selection/data. Performance/resources by design:
//   • Lazy mount — a tab's inner component is mounted only once it has been opened
//     (so restoring 8 tabs doesn't fire 8 schema reads; only the active one loads).
//   • Once mounted a tab stays mounted, so switching away preserves its state and
//     loaded page in memory — no refetch on return.
//   • Only the ACTIVE tab renders its heavy <DataGrid> into the DOM (the inner
//     viewer returns null when `active` is false), so background tabs cost ~0 DOM.
//   • Definitions are persisted per connection; data is loaded on demand, never on
//     restore — egress stays identical to the single-view viewer.
//
// Tabs auto-organise by Área → Versión → hoja with a colour accent per área and a
// separator between área groups (see tabsHelpers).
// ─────────────────────────────────────────────────────────────────────────────
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useIsMobile } from '../../hooks/useIsMobile'
import { loadTabs, saveTabs, sortTabs, areaColor, tabLabel, tabLabelParts, TAB_LIMIT } from './tabsHelpers'

const newId = () => (globalThis.crypto?.randomUUID?.() || `t${Date.now()}_${Math.round(Math.random() * 1e9)}`)

function metaEqual(a, b) {
  const x = a || {}, y = b || {}
  return x.areaId === y.areaId && x.versionId === y.versionId && x.leafLabel === y.leafLabel && !!x.dirty === !!y.dirty
}

export default function ViewerTabs({ connection, kind, renderTab }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const connId = connection.id

  // ── Tab list + active tab (restored from localStorage, or a single empty tab) ──
  const [state, setState] = useState(() => {
    const saved = loadTabs(kind, connId)
    if (saved) {
      const activeId = saved.tabs.some(x => x.id === saved.activeId) ? saved.activeId : saved.tabs[0].id
      return { tabs: saved.tabs, activeId }
    }
    const id = newId()
    return { tabs: [{ id, def: null, meta: null }], activeId: id }
  })
  const { tabs, activeId } = state

  // Which tabs have an inner component mounted. On restore only the active tab is
  // mounted (the rest mount lazily on first open → no schema reads up front).
  const [mounted, setMounted] = useState(() => ({ [state.activeId]: true }))

  // Persist definitions (selección/meta) whenever the tab set or active tab changes.
  useEffect(() => { saveTabs(kind, connId, { activeId, tabs }) }, [kind, connId, activeId, tabs])

  // ── Fullscreen — owned here (not in DataGrid) so the tab strip stays on top and
  // usable while the grid is maximised. Esc exits; body scroll locked meanwhile. ──
  const [fullscreen, setFullscreen] = useState(false)
  const toggleFullscreen = useCallback(() => setFullscreen(v => !v), [])
  useEffect(() => {
    if (!fullscreen) return
    const onKey = e => { if (e.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [fullscreen])

  const selectTab = useCallback(id => {
    setMounted(m => (m[id] ? m : { ...m, [id]: true }))
    setState(s => (s.activeId === id ? s : { ...s, activeId: id }))
  }, [])

  const addTab = useCallback(() => {
    setState(s => {
      if (s.tabs.length >= TAB_LIMIT) return s
      const id = newId()
      setMounted(m => ({ ...m, [id]: true }))
      return { tabs: [...s.tabs, { id, def: null, meta: null }], activeId: id }
    })
  }, [])

  // Duplicate a tab: clone its definition (selección + filtros + columnas + nivel) so
  // the new tab is identical but fully independent — its own id, own mounted state,
  // own inner viewer. We deep-clone the def (plain JSON) so later edits in one tab
  // never leak into the other. Data is NOT copied: the duplicate hydrates the same
  // configuration and the user presses "Mostrar datos" (no extra row read on copy).
  const duplicateTab = useCallback(id => {
    setState(s => {
      if (s.tabs.length >= TAB_LIMIT) return s
      const src = s.tabs.find(x => x.id === id)
      if (!src) return s
      const nid = newId()
      const def  = src.def ? JSON.parse(JSON.stringify(src.def)) : null
      const meta = src.meta ? { ...src.meta, dirty: false } : null   // clone starts clean
      setMounted(m => ({ ...m, [nid]: true }))
      return { tabs: [...s.tabs, { id: nid, def, meta }], activeId: nid }
    })
  }, [])

  const closeTab = useCallback(id => {
    // Only a mounted tab can hold in-memory edits; meta.dirty on a never-opened
    // restored tab is stale, so don't prompt for it.
    const tab = tabs.find(x => x.id === id)
    if (mounted[id] && tab?.meta?.dirty && !window.confirm(t('viewer.tabCloseDirty'))) return
    setState(s => {
      const remaining = s.tabs.filter(x => x.id !== id)
      // Closing the last tab → start fresh with one empty tab.
      if (!remaining.length) {
        const nid = newId()
        setMounted({ [nid]: true })
        return { tabs: [{ id: nid, def: null, meta: null }], activeId: nid }
      }
      let activeId = s.activeId
      if (activeId === id) {
        // Move to the neighbour in the *visible* (sorted) order — most intuitive.
        const sorted = sortTabs(s.tabs)
        const si = sorted.findIndex(x => x.id === id)
        const neighbour = sorted[si + 1] || sorted[si - 1]
        activeId = neighbour ? neighbour.id : remaining[0].id
        setMounted(m => (m[activeId] ? m : { ...m, [activeId]: true }))
      }
      return { tabs: remaining, activeId }
    })
  }, [tabs, mounted, t])

  // Inner viewer reports its identity/restore payload — update def+meta (and persist).
  const updateTab = useCallback((id, def, meta) => {
    setState(s => {
      const i = s.tabs.findIndex(x => x.id === id)
      if (i < 0) return s
      const cur = s.tabs[i]
      if (metaEqual(cur.meta, meta) && JSON.stringify(cur.def) === JSON.stringify(def)) return s
      const next = s.tabs.slice()
      next[i] = { ...cur, def, meta }
      return { ...s, tabs: next }
    })
  }, [])

  const sorted = useMemo(() => sortTabs(tabs), [tabs])
  const atLimit = tabs.length >= TAB_LIMIT

  // ── Styles ──
  const strip = {
    display: 'flex', alignItems: 'stretch', gap: 0, flexShrink: 0,
    background: 'var(--bg)', borderBottom: '1px solid var(--border)',
    padding: isMobile ? '4px 8px' : '4px 12px', overflowX: 'auto', whiteSpace: 'nowrap',
  }
  function tabStyle(active, color) {
    // All-longhand border props (no `border`/`borderLeft` shorthand) so React doesn't
    // warn about mixing shorthand+longhand when the accent colour updates on rerender.
    return {
      display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, maxWidth: 230,
      padding: isMobile ? '6px 8px 6px 9px' : '6px 9px 6px 10px', margin: '4px 3px',
      borderRadius: 7, borderStyle: 'solid',
      borderTopWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderLeftWidth: 3,
      borderTopColor: active ? 'var(--border)' : 'transparent',
      borderRightColor: active ? 'var(--border)' : 'transparent',
      borderBottomColor: active ? 'var(--border)' : 'transparent',
      borderLeftColor: color,
      background: active ? 'var(--bg2)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text2)',
      fontSize: 12, fontWeight: active ? 600 : 400, cursor: 'pointer',
      transition: 'background .12s', userSelect: 'none',
    }
  }
  const closeBtn = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, borderRadius: 4, border: 'none', background: 'none',
    color: 'var(--text3)', fontSize: 14, lineHeight: 1, cursor: 'pointer', flexShrink: 0,
  }
  // Duplicate button — shown only on the active tab (keeps idle tabs minimal).
  const dupBtn = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, borderRadius: 4, border: 'none', background: 'none',
    color: 'var(--text3)', fontSize: 11, lineHeight: 1,
    cursor: atLimit ? 'not-allowed' : 'pointer', flexShrink: 0,
  }
  const plusBtn = {
    flexShrink: 0, alignSelf: 'center', margin: '0 4px', width: 28, height: 28,
    borderRadius: 7, border: '1px dashed var(--border2)', background: 'none',
    color: atLimit ? 'var(--text3)' : 'var(--text2)', fontSize: 18, lineHeight: 1,
    cursor: atLimit ? 'not-allowed' : 'pointer',
  }
  // Exit-fullscreen button shown in the strip while fullscreen, so the user can
  // always leave — even on a tab with no grid (where the grid's own button is absent).
  const exitFsBtn = {
    flexShrink: 0, alignSelf: 'center', marginLeft: 'auto',
    padding: '5px 10px', borderRadius: 7, border: '1px solid var(--accent)',
    background: 'none', color: 'var(--accent)', fontSize: 11, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap',
  }

  return (
    <div style={fullscreen
      ? { display: 'flex', flexDirection: 'column', position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)' }
      : { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Tab strip */}
      <div style={strip} className="viewer-tabstrip">
        {sorted.map((tab, i) => {
          const prevArea = i > 0 ? (sorted[i - 1].meta?.areaId || '') : null
          const newGroup = i > 0 && (tab.meta?.areaId || '') !== prevArea
          const color = areaColor(tab.meta?.areaId)
          const active = tab.id === activeId
          const label = tabLabel(tab.meta, t)               // full string → tooltip
          const { primary, secondary } = tabLabelParts(tab.meta, t)
          return (
            <Fragment key={tab.id}>
              {newGroup && <div aria-hidden style={{ width: 1, background: 'var(--border)', margin: '7px 5px', flexShrink: 0 }} />}
              <div
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(tab.id)}
                style={tabStyle(active, color)}
                title={label}
              >
                <span style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, lineHeight: 1.2 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontWeight: active ? 700 : 600 }}>
                    {primary}
                  </span>
                  {secondary && (
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: 'var(--text3)' }}>
                      {secondary}
                    </span>
                  )}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                  {active && (
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); duplicateTab(tab.id) }}
                      disabled={atLimit}
                      style={dupBtn}
                      title={atLimit ? t('viewer.tabLimit', { n: TAB_LIMIT }) : t('viewer.tabDuplicate')}
                      onMouseEnter={e => { if (!atLimit) { e.currentTarget.style.background = 'var(--border)'; e.currentTarget.style.color = 'var(--accent)' } }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text3)' }}
                    >⧉</button>
                  )}
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                    style={closeBtn}
                    title={t('viewer.tabClose')}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--border)'; e.currentTarget.style.color = 'var(--red)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text3)' }}
                  >×</button>
                </span>
              </div>
            </Fragment>
          )
        })}
        <button
          type="button"
          onClick={addTab}
          disabled={atLimit}
          style={plusBtn}
          title={atLimit ? t('viewer.tabLimit', { n: TAB_LIMIT }) : t('viewer.tabNew')}
        >+</button>
        {fullscreen && (
          <button type="button" onClick={toggleFullscreen} style={exitFsBtn} title={t('viewer.exitFullscreenTitle')}>
            {t('viewer.exitFullscreen')}
          </button>
        )}
      </div>

      {/* Content — every MOUNTED tab stays in the tree (state preserved); only the
          active one is shown. The inner viewer renders null while inactive, so a
          hidden tab keeps its data in memory but holds no grid DOM. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {tabs.filter(tab => mounted[tab.id]).map(tab => {
          const active = tab.id === activeId
          return (
            <div key={tab.id} style={{ display: active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {renderTab(tab, {
                active,
                onMeta: (def, meta) => updateTab(tab.id, def, meta),
                fullscreen,
                onToggleFullscreen: toggleFullscreen,
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
