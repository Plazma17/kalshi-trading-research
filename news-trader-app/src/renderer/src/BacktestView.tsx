import { useEffect, useMemo, useState } from 'react'
import type { BacktestParams, BacktestRun, BacktestSignalRow, DatasetRef } from '@shared/schema'
import type { BacktestProgress, BacktestTick } from './env'
import { Histogram, LineArea, PctBars, Scatter, SignedBars } from './charts'

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

export default function BacktestView(): JSX.Element {
  const [datasets, setDatasets] = useState<DatasetRef[]>([])
  const [runs, setRuns] = useState<BacktestRun[]>([])
  const [current, setCurrent] = useState<BacktestRun | null>(null)
  const [rows, setRows] = useState<BacktestSignalRow[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BacktestProgress | null>(null)
  const [feed, setFeed] = useState<BacktestTick[]>([])
  const [live, setLive] = useState<{ trades: number; accuracy: number; pnlPct: number } | null>(null)
  const [liveEq, setLiveEq] = useState<number[]>([])
  const [params, setParams] = useState<BacktestParams>({
    datasetId: '',
    dateFrom: '',
    dateTo: '',
    horizonDays: 3,
    entryRule: 'next_open',
    minConfidence: 0.7,
    includeNeutral: false,
    transactionCostBps: 5,
    maxArticles: 50,
    benchmarkSymbol: 'SPY',
    positionSizePct: 2
  })

  useEffect(() => {
    window.api.dataList().then((d) => {
      setDatasets(d)
      if (d[0]) setParams((p) => ({ ...p, datasetId: d[0].id }))
    })
    window.api.backtestList().then(setRuns)
    const off = window.api.onBacktestProgress((p) => {
      setProgress(p)
      const r = p.running
      if (r) {
        setLive({ trades: r.trades, accuracy: r.accuracy, pnlPct: r.pnlPct })
        if (r.newRows.length) setFeed((f) => [...[...r.newRows].reverse(), ...f].slice(0, 60))
        setLiveEq((e) => [...e, r.pnlPct])
      }
    })
    return off
  }, [])

  // Load signal rows whenever a completed run is selected (drives the chart grid).
  useEffect(() => {
    if (current && current.status === 'done') window.api.backtestSignalRows(current.id).then(setRows)
    else setRows([])
  }, [current])

  function set<K extends keyof BacktestParams>(k: K, v: BacktestParams[K]): void {
    setParams((p) => ({ ...p, [k]: v }))
  }

  async function run(): Promise<void> {
    if (!params.datasetId || running) return
    setRunning(true)
    setProgress(null)
    setFeed([])
    setLive(null)
    setLiveEq([])
    try {
      const r = await window.api.backtestRun(params)
      setCurrent(r)
      setRuns(await window.api.backtestList())
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const m = current?.metrics

  // ── derived chart datasets (from signal rows) ──────────────────────────────
  const equity = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1))
    let c = 0
    return sorted.map((r) => (c += r.pnlPct))
  }, [rows])
  const drawdown = useMemo(() => {
    let peak = 0
    return equity.map((v) => {
      peak = Math.max(peak, v)
      return v - peak
    })
  }, [equity])
  const mnEquity = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1))
    let c = 0
    return sorted.map((r) => (c += r.excessPct ?? 0))
  }, [rows])
  const returns = useMemo(() => rows.map((r) => r.forwardReturnPct), [rows])
  const scatter = useMemo(
    () => rows.map((r) => ({ x: r.confidence, y: r.forwardReturnPct, ok: r.correct })),
    [rows]
  )
  const pnlByTopic = useMemo(() => {
    const map: Record<string, number> = {}
    for (const r of rows) map[r.topic] = (map[r.topic] ?? 0) + r.pnlPct
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value }))
  }, [rows])
  const accByDirection = useMemo(() => {
    const c: Record<string, number> = {}
    const t: Record<string, number> = {}
    for (const r of rows) {
      t[r.direction] = (t[r.direction] ?? 0) + 1
      if (r.correct) c[r.direction] = (c[r.direction] ?? 0) + 1
    }
    return ['bull', 'up', 'neutral', 'down', 'bear']
      .filter((d) => t[d])
      .map((d) => ({ label: d, value: (c[d] ?? 0) / t[d], count: t[d] }))
  }, [rows])

  return (
    <div className="body">
      {datasets.length === 0 ? (
        <div className="dim">Import a dataset on the DATA tab first — the backtest needs headlines.</div>
      ) : (
        <div className="btconfig">
          <label className="field">
            <span className="k">DATASET</span>
            <select value={params.datasetId} onChange={(e) => set('datasetId', e.target.value)}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.rows.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="k">FROM</span>
            <input value={params.dateFrom} placeholder="YYYY-MM-DD" onChange={(e) => set('dateFrom', e.target.value)} />
          </label>
          <label className="field">
            <span className="k">TO</span>
            <input value={params.dateTo} placeholder="YYYY-MM-DD" onChange={(e) => set('dateTo', e.target.value)} />
          </label>
          <label className="field">
            <span className="k">HORIZON DAYS</span>
            <input type="number" value={params.horizonDays} onChange={(e) => set('horizonDays', Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="k">MIN CONFIDENCE</span>
            <input type="number" step="0.05" value={params.minConfidence} onChange={(e) => set('minConfidence', Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="k">MAX HEADLINES</span>
            <input type="number" value={params.maxArticles} onChange={(e) => set('maxArticles', Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="k">ENTRY</span>
            <select value={params.entryRule} onChange={(e) => set('entryRule', e.target.value as BacktestParams['entryRule'])}>
              <option value="next_open">next open (safe)</option>
              <option value="same_close">same close (optimistic)</option>
            </select>
          </label>
          <label className="field">
            <span className="k">COST (BPS)</span>
            <input type="number" value={params.transactionCostBps} onChange={(e) => set('transactionCostBps', Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="k">BENCHMARK</span>
            <input value={params.benchmarkSymbol} placeholder="SPY (blank=off)" onChange={(e) => set('benchmarkSymbol', e.target.value.toUpperCase())} />
          </label>
          <label className="field">
            <span className="k">POSITION SIZE %</span>
            <input type="number" step="0.5" value={params.positionSizePct} onChange={(e) => set('positionSizePct', Number(e.target.value))} />
          </label>
          <button onClick={run} disabled={running || !params.datasetId}>
            {running ? 'RUNNING…' : 'RUN BACKTEST'}
          </button>
        </div>
      )}

      {running && progress && (
        <div className="prog">
          <div className="track">
            <div className="fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
          <div className="progmsg">{progress.message}</div>
        </div>
      )}

      {running && live && (
        <div className="dash mt">
          <Bignums accuracy={live.accuracy} pnl={live.pnlPct} trades={live.trades} live />
          {liveEq.length > 1 && (
            <>
              <div className="lbl block mt">LIVE EQUITY (cumulative P&amp;L per trade)</div>
              <LineArea values={liveEq} variant="equity" />
            </>
          )}
          <div className="lbl block mt">LIVE TRADE FEED</div>
          <table className="sig">
            <thead>
              <tr>
                <th>DATE</th>
                <th>TOPIC</th>
                <th>DIR</th>
                <th>SYMBOL</th>
                <th>FWD RET</th>
                <th>HIT</th>
              </tr>
            </thead>
            <tbody>
              {feed.slice(0, 30).map((t, i) => (
                <tr key={i}>
                  <td className="dim">{t.entryDate}</td>
                  <td className="topic">{t.topic}</td>
                  <td className={`dir ${t.direction}`}>{t.direction.toUpperCase()}</td>
                  <td>{t.symbol}</td>
                  <td className={t.forwardReturnPct >= 0 ? 'ok' : 'bad'}>
                    {t.forwardReturnPct >= 0 ? '+' : ''}
                    {t.forwardReturnPct.toFixed(1)}%
                  </td>
                  <td className={t.correct ? 'ok' : 'bad'}>{t.correct ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {current && current.status === 'error' && (
        <div className="bad mt">backtest error: {current.errorMessage}</div>
      )}

      {!running && m && current && (
        <div className="dash mt">
          <Bignums accuracy={m.directionalAccuracy} pnl={m.simulatedPnlPct} trades={m.tradeCount} />
          <div className="bignums">
            <div className="bignum">
              <div className={`bnval ${m.marketNeutralPnlPct >= 0 ? 'ok' : 'bad'}`}>
                {m.marketNeutralPnlPct >= 0 ? '+' : ''}
                {m.marketNeutralPnlPct.toFixed(1)}%
              </div>
              <div className="bnlbl">MARKET-NEUTRAL P&amp;L (vs {current.params.benchmarkSymbol || 'none'})</div>
            </div>
            <div className="bignum">
              <div className="bnval">{pct(m.winRate)}</div>
              <div className="bnlbl">WIN RATE</div>
            </div>
            <div className="bignum">
              <div className="bnval">{pct(m.coverage)}</div>
              <div className="bnlbl">PRICE COVERAGE</div>
            </div>
          </div>
          <div className="dim small">
            {current.counts.articles} headlines · {current.counts.signals} signals ·{' '}
            {current.counts.scoredSignals} scored · 50% accuracy = coin flip
          </div>

          <div className="chartgrid">
            <div className="chartcell">
              <div className="lbl block">EQUITY CURVE (cumulative P&amp;L)</div>
              <LineArea values={equity} variant="equity" />
            </div>
            <div className="chartcell">
              <div className="lbl block">DRAWDOWN (underwater)</div>
              <LineArea values={drawdown} variant="drawdown" />
            </div>
            <div className="chartcell">
              <div className="lbl block">MARKET-NEUTRAL EQUITY (excess vs benchmark — the real edge)</div>
              <LineArea values={mnEquity} variant="equity" />
            </div>
            <div className="chartcell">
              <div className="lbl block">FORWARD-RETURN DISTRIBUTION</div>
              <Histogram values={returns} />
            </div>
            <div className="chartcell">
              <div className="lbl block">CONFIDENCE vs FORWARD RETURN</div>
              <Scatter points={scatter} />
            </div>
            <div className="chartcell">
              <div className="lbl block">P&amp;L BY TOPIC</div>
              <SignedBars rows={pnlByTopic} />
            </div>
            <div className="chartcell">
              <div className="lbl block">ACCURACY BY DIRECTION</div>
              <PctBars rows={accByDirection} />
            </div>
            <div className="chartcell">
              <div className="lbl block">CALIBRATION (accuracy by confidence — should rise →)</div>
              <PctBars
                rows={Object.keys(m.accuracyByConfidenceBucket)
                  .sort()
                  .map((b) => ({
                    label: b,
                    value: m.accuracyByConfidenceBucket[b],
                    count: m.countByConfidenceBucket[b]
                  }))}
              />
            </div>
            <div className="chartcell">
              <div className="lbl block">ACCURACY BY TOPIC</div>
              <PctBars
                rows={Object.entries(m.accuracyByTopic)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 14)
                  .map(([label, value]) => ({ label, value }))}
              />
            </div>
          </div>
        </div>
      )}

      <div className="lbl block mt">RUN HISTORY</div>
      <table className="sig">
        <thead>
          <tr>
            <th>WHEN</th>
            <th>STATUS</th>
            <th>ACCURACY</th>
            <th>P&amp;L</th>
            <th>TRADES</th>
            <th>HORIZON</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && (
            <tr>
              <td colSpan={6} className="dim">
                no runs yet
              </td>
            </tr>
          )}
          {runs.map((r) => (
            <tr key={r.id} className="clickrow" onClick={() => setCurrent(r)}>
              <td className="dim">{r.startedAt.slice(0, 16).replace('T', ' ')}</td>
              <td className={r.status === 'done' ? 'ok' : 'bad'}>{r.status}</td>
              <td>{r.metrics ? pct(r.metrics.directionalAccuracy) : '—'}</td>
              <td className={r.metrics && r.metrics.simulatedPnlPct >= 0 ? 'ok' : 'bad'}>
                {r.metrics ? `${r.metrics.simulatedPnlPct.toFixed(1)}%` : '—'}
              </td>
              <td>{r.metrics?.tradeCount ?? '—'}</td>
              <td className="dim">{r.params.horizonDays}d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Bignums({
  accuracy,
  pnl,
  trades,
  live
}: {
  accuracy: number
  pnl: number
  trades: number
  live?: boolean
}): JSX.Element {
  return (
    <div className="bignums">
      <div className="bignum">
        <div className="bnval">{(accuracy * 100).toFixed(1)}%</div>
        <div className="bnlbl">{live ? 'RUNNING ' : ''}DIRECTIONAL ACCURACY</div>
      </div>
      <div className="bignum">
        <div className={`bnval ${pnl >= 0 ? 'ok' : 'bad'}`}>
          {pnl >= 0 ? '+' : ''}
          {pnl.toFixed(1)}%
        </div>
        <div className="bnlbl">{live ? 'RUNNING ' : 'SIMULATED '}P&amp;L</div>
      </div>
      <div className="bignum">
        <div className="bnval">{trades.toLocaleString()}</div>
        <div className="bnlbl">{live ? 'TRADES SO FAR' : 'TRADES'}</div>
      </div>
    </div>
  )
}
