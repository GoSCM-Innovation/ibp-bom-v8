import { useState } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useIsMobile } from '../../hooks/useIsMobile'
import Migration from './Migration'
// [release/master-data] Migración de dato transaccional (key figures) OCULTA hasta su
// propio release. El código vive intacto; para reactivarla, revertir este commit:
// restaurar el import, la pestaña 'kf' en TABS y la línea de render `mode === 'kf'`.
// import KeyFigureMigration from './KeyFigureMigration'

// Container for the Migration tab: two modes —
//   · "Dato maestro"      → existing master-data migration (Migration)
//   · "Dato transaccional" → key-figure migration (KeyFigureMigration)
export default function MigrationTabs({ connection, session }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [mode, setMode] = useState('master')

  const TABS = [
    { id: 'master', label: t('kfm.tabMaster') },
    // [release/master-data] { id: 'kf', label: t('kfm.tabKf') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', background: 'var(--bg)', padding: isMobile ? '0 12px' : '0 24px', flexShrink: 0 }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setMode(tab.id)} style={{
            padding: isMobile ? '8px 12px' : '8px 16px', fontSize: 12, background: 'none', border: 'none',
            borderBottom: mode === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
            color: mode === tab.id ? 'var(--text)' : 'var(--text2)', fontWeight: mode === tab.id ? 600 : 400,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{tab.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {mode === 'master' && <Migration connection={connection} session={session} />}
        {/* [release/master-data] {mode === 'kf' && <KeyFigureMigration connection={connection} session={session} />} */}
      </div>
    </div>
  )
}
