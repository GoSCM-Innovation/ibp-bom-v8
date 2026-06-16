// ─────────────────────────────────────────────────────────────────────────────
// TransactionalDataViewer.jsx — "Ver Dato Transaccional" tab.
//
// Placeholder for Phase 1: the transactional (key-figure) viewer is built after
// the master-data viewer is solid. It will reuse planningDataApi.js (countKf /
// readKfPage) with the same server-side pagination model.
// ─────────────────────────────────────────────────────────────────────────────
import { useI18n } from '../../context/I18nContext'

export default function TransactionalDataViewer() {
  const { t } = useI18n()
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
      {t('viewer.placeholderTrans')}
    </div>
  )
}
