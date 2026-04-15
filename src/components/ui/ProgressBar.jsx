export default function ProgressBar({ loading }) {
  return (
    <div style={{
      position: 'absolute',
      top: 0, left: 0, right: 0,
      height: 3,
      overflow: 'hidden',
      zIndex: 10,
      opacity: loading ? 1 : 0,
      transition: 'opacity 0.3s ease',
    }}>
      {loading && <div className="progress-bar-shimmer" />}
    </div>
  )
}
