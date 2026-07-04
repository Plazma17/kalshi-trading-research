import { useEffect, useState } from 'react'
import type { DatasetRef } from '@shared/schema'
import type { DatasetPeek } from './env'

function guess(headers: string[], subs: string[]): string {
  const lower = headers.map((h) => h.toLowerCase())
  for (const s of subs) {
    const i = lower.findIndex((h) => h.includes(s))
    if (i >= 0) return headers[i]
  }
  return ''
}

export default function DataView(): JSX.Element {
  const [datasets, setDatasets] = useState<DatasetRef[]>([])
  const [peek, setPeek] = useState<DatasetPeek | null>(null)
  const [headline, setHeadline] = useState('')
  const [date, setDate] = useState('')
  const [ticker, setTicker] = useState('')
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState<string[]>([])

  async function reload(): Promise<void> {
    const [list, miss] = await Promise.all([window.api.dataList(), window.api.dataMissing()])
    setDatasets(list)
    setMissing(miss)
  }
  useEffect(() => {
    reload()
  }, [])

  async function relocate(id: string): Promise<void> {
    const r = await window.api.dataRelocate(id)
    if (r) await reload()
  }

  async function pick(): Promise<void> {
    const p = await window.api.dataPickAndPeek()
    if (!p) return
    setPeek(p)
    setHeadline(guess(p.headers, ['headline', 'title', 'head', 'text']))
    setDate(guess(p.headers, ['date', 'time', 'publishedat', 'timestamp']))
    setTicker(guess(p.headers, ['ticker', 'symbol', 'stock']))
    setName(p.path.split(/[\\/]/).pop() ?? 'dataset')
  }

  async function doImport(): Promise<void> {
    if (!peek || !headline || !date) return
    setBusy(true)
    try {
      await window.api.dataImport(peek.path, { headline, date, ticker }, name, source)
      setPeek(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="body">
      <div className="topicsbar">
        <button className="ghost" onClick={pick}>
          IMPORT CSV
        </button>
        <span className="dim">{datasets.length} datasets registered</span>
      </div>

      {peek && (
        <div className="importer">
          <div className="lbl block">MAP COLUMNS</div>
          <div className="maprow">
            <label className="field">
              <span className="k">HEADLINE COLUMN</span>
              <select value={headline} onChange={(e) => setHeadline(e.target.value)}>
                <option value="">— choose —</option>
                {peek.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="k">DATE COLUMN</span>
              <select value={date} onChange={(e) => setDate(e.target.value)}>
                <option value="">— choose —</option>
                {peek.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="k">TICKER COLUMN (OPTIONAL)</span>
              <select value={ticker} onChange={(e) => setTicker(e.target.value)}>
                <option value="">— none —</option>
                {peek.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="maprow">
            <label className="field">
              <span className="k">DATASET NAME</span>
              <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span className="k">SOURCE TAG</span>
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. benzinga"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="lbl block mt">PREVIEW (first rows)</div>
          <table className="sig">
            <thead>
              <tr>
                <th>DATE</th>
                <th>HEADLINE</th>
                {ticker && <th>TICKER</th>}
              </tr>
            </thead>
            <tbody>
              {peek.rows.map((r, i) => (
                <tr key={i}>
                  <td className="dim">{date ? r[date] : ''}</td>
                  <td>{headline ? r[headline] : ''}</td>
                  {ticker && <td className="topic">{r[ticker]}</td>}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="actions">
            <button onClick={doImport} disabled={busy || !headline || !date}>
              {busy ? 'IMPORTING…' : 'IMPORT'}
            </button>
            <button className="ghost" onClick={() => setPeek(null)} disabled={busy}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      <div className="lbl block mt">DATASETS</div>
      <table className="sig">
        <thead>
          <tr>
            <th>NAME</th>
            <th>ROWS</th>
            <th>FROM</th>
            <th>TO</th>
            <th>SOURCE</th>
            <th>FILE</th>
          </tr>
        </thead>
        <tbody>
          {datasets.length === 0 && (
            <tr>
              <td colSpan={6} className="dim">
                no datasets yet — import a CSV of headlines to begin
              </td>
            </tr>
          )}
          {datasets.map((d) => {
            const isMissing = missing.includes(d.id)
            return (
              <tr key={d.id}>
                <td className="topic">{d.name}</td>
                <td>{d.rows.toLocaleString()}</td>
                <td className="dim">{d.dateFrom.slice(0, 10)}</td>
                <td className="dim">{d.dateTo.slice(0, 10)}</td>
                <td className="dim">{d.source}</td>
                <td>
                  {isMissing ? (
                    <button className="segbtn bad on" onClick={() => relocate(d.id)}>
                      MISSING — LOCATE
                    </button>
                  ) : (
                    <span className="ok">✓</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
