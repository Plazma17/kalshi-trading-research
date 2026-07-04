// Terminal-styled SVG/CSS chart primitives for the backtest dashboard.
const W = 620
const H = 130

/**
 * Net-worth-over-time chart with LABELED axes and a FIXED x-domain [0..1] (the full
 * run's timeline). The line starts at (0, initialNetWorth) and extends rightward as
 * the run progresses, so at the halfway point it reaches the middle of the screen.
 */
export function NetWorthChart({
  points,
  initial
}: {
  points: { x: number; v: number }[]
  initial: number
}): JSX.Element {
  const w = 660
  const h = 180
  const padL = 64
  const padR = 14
  const padT = 12
  const padB = 28
  const iw = w - padL - padR
  const ih = h - padT - padB
  const pts = [{ x: 0, v: initial }, ...points]
  const vs = pts.map((p) => p.v)
  let yMin = Math.min(...vs)
  let yMax = Math.max(...vs)
  if (yMin === yMax) {
    yMin -= 1
    yMax += 1
  }
  const padY = (yMax - yMin) * 0.08
  yMin -= padY
  yMax += padY
  const X = (x: number): number => padL + Math.max(0, Math.min(1, x)) * iw // x-domain fixed [0,1]
  const Y = (v: number): number => padT + (1 - (v - yMin) / (yMax - yMin)) * ih
  const line = pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')
  const up = pts[pts.length - 1].v >= initial
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const money = (v: number): string => '$' + Math.round(v).toLocaleString()
  return (
    <svg className="nwchart" viewBox={`0 0 ${w} ${h}`}>
      {ticks.map((t) => {
        const v = yMin + t * (yMax - yMin)
        const y = Y(v)
        return (
          <g key={'y' + t}>
            <line x1={padL} y1={y} x2={w - padR} y2={y} className="nwgrid" />
            <text x={padL - 6} y={y + 3} className="nwtick" textAnchor="end">
              {money(v)}
            </text>
          </g>
        )
      })}
      {ticks.map((t) => (
        <text key={'x' + t} x={X(t)} y={h - 9} className="nwtick" textAnchor="middle">
          {Math.round(t * 100)}%
        </text>
      ))}
      <line x1={padL} y1={Y(initial)} x2={w - padR} y2={Y(initial)} className="nwinit" />
      <line x1={padL} y1={padT} x2={padL} y2={h - padB} className="nwaxis" />
      <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} className="nwaxis" />
      <polyline points={line} className={`nwline ${up ? 'up' : 'down'}`} />
      <text x={padL + iw / 2} y={h - 0.5} className="nwaxlabel" textAnchor="middle">
        TIME (run progress) →
      </text>
      <text
        x={13}
        y={padT + ih / 2}
        className="nwaxlabel"
        textAnchor="middle"
        transform={`rotate(-90 13 ${padT + ih / 2})`}
      >
        NET WORTH
      </text>
    </svg>
  )
}

/** Cumulative line with filled area + zero baseline (equity, drawdown). */
export function LineArea({
  values,
  variant
}: {
  values: number[]
  variant: 'equity' | 'drawdown'
}): JSX.Element | null {
  if (values.length < 2) return null
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const X = (i: number): number => (i / (values.length - 1)) * W
  const Y = (v: number): number => H - ((v - min) / range) * H
  const line = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')
  const area = `0,${Y(0).toFixed(1)} ${line} ${W},${Y(0).toFixed(1)}`
  const cls = variant === 'drawdown' ? 'down' : values[values.length - 1] >= 0 ? 'up' : 'down'
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={area} className={`area ${cls}`} />
      <line x1="0" y1={Y(0)} x2={W} y2={Y(0)} className="zeroline" />
      <polyline points={line} className={`eqline ${cls}`} />
    </svg>
  )
}

/** Histogram of values, bars colored by sign, with a zero gridline. */
export function Histogram({ values, bins = 25 }: { values: number[]; bins?: number }): JSX.Element | null {
  if (values.length === 0) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const counts = new Array(bins).fill(0)
  for (const v of values) {
    let b = Math.floor(((v - lo) / span) * bins)
    if (b >= bins) b = bins - 1
    if (b < 0) b = 0
    counts[b]++
  }
  const maxC = Math.max(...counts, 1)
  const bw = W / bins
  const zeroX = lo < 0 && hi > 0 ? ((0 - lo) / span) * W : null
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {counts.map((c, i) => {
        const mid = lo + ((i + 0.5) / bins) * span
        const h = (c / maxC) * H
        return (
          <rect
            key={i}
            x={i * bw + 0.5}
            y={H - h}
            width={bw - 1}
            height={h}
            className={`vbar ${mid >= 0 ? 'up' : 'down'}`}
          />
        )
      })}
      {zeroX != null && <line x1={zeroX} y1="0" x2={zeroX} y2={H} className="zeroline" />}
    </svg>
  )
}

/** Scatter (x in 0..1, y free) — round dots, colored by hit/miss. */
export function Scatter({
  points
}: {
  points: { x: number; y: number; ok: boolean }[]
}): JSX.Element | null {
  if (points.length === 0) return null
  const ys = points.map((p) => p.y)
  const lo = Math.min(0, ...ys)
  const hi = Math.max(0, ...ys)
  const range = hi - lo || 1
  const zeroY = H - ((0 - lo) / range) * H
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} className="zeroline" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x * W}
          cy={H - ((p.y - lo) / range) * H}
          r="2.5"
          className={p.ok ? 'dot up' : 'dot down'}
        />
      ))}
    </svg>
  )
}

/** Diverging horizontal bars centered at 0 (P&L by group). */
export function SignedBars({ rows }: { rows: { label: string; value: number }[] }): JSX.Element {
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)))
  return (
    <div className="sbars">
      {rows.map((r, i) => (
        <div className="sbarrow" key={i}>
          <span className="barlabel">{r.label}</span>
          <span className="sbartrack">
            <span className="sbarmid" />
            <span
              className={`sbarfill ${r.value >= 0 ? 'up' : 'down'}`}
              style={{
                width: `${(Math.abs(r.value) / maxAbs) * 50}%`,
                left: r.value >= 0 ? '50%' : 'auto',
                right: r.value < 0 ? '50%' : 'auto'
              }}
            />
          </span>
          <span className={`barval ${r.value >= 0 ? 'ok' : 'bad'}`}>
            {r.value >= 0 ? '+' : ''}
            {r.value.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  )
}

/** Simple labeled 0..1 horizontal bars (accuracy). */
export function PctBars({
  rows,
  baseline = 0.5
}: {
  rows: { label: string; value: number; count?: number }[]
  baseline?: number
}): JSX.Element {
  return (
    <div>
      {rows.map((r, i) => (
        <div className="barrow" key={i}>
          <span className="barlabel">{r.label}</span>
          <span className="bartrack">
            <span
              className="barfill2"
              style={{ width: `${Math.round(r.value * 100)}%` }}
            />
            <span className="baseline" style={{ left: `${baseline * 100}%` }} />
          </span>
          <span className="barval">
            {(r.value * 100).toFixed(0)}%
            {r.count != null && <span className="dim"> ({r.count})</span>}
          </span>
        </div>
      ))}
    </div>
  )
}
