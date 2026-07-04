import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ClassifyProgress, ClassifyResult, GpuStats } from './env'
import SettingsView from './SettingsView'
import TopicsView from './TopicsView'
import ReviewView from './ReviewView'
import DataView from './DataView'
import BacktestView from './BacktestView'
import PromptView from './PromptView'
import RunningView from './RunningView'
import Tip from './Tip'

type Tab = 'running' | 'classify' | 'topics' | 'prompt' | 'tuning' | 'backtest' | 'data' | 'settings'

const SAMPLE = 'Iran closes the Strait of Hormuz to oil tankers.'

interface Session {
  count: number
  sumTps: number
  lastTps: number
  sumLatency: number
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<{ ok: boolean; models: string[]; error?: string } | null>(
    null
  )
  const [gpu, setGpu] = useState<GpuStats | null>(null)
  const [tab, setTab] = useState<Tab>('classify')
  const [text, setText] = useState(SAMPLE)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ClassifyProgress | null>(null)
  const [result, setResult] = useState<ClassifyResult | null>(null)
  const [classifiedText, setClassifiedText] = useState('')
  const [session, setSession] = useState<Session>({ count: 0, sumTps: 0, lastTps: 0, sumLatency: 0 })
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    window.api.ollamaStatus().then(setStatus)
    // Apply the persisted UI theme (e.g. 'night') on launch.
    window.api.settingsGet().then((s) => {
      document.documentElement.dataset.theme = s.theme || 'dark'
    })
    const offGpu = window.api.onGpuStats(setGpu)
    const offProg = window.api.onClassifyProgress(setProgress)
    return () => {
      offGpu()
      offProg()
    }
  }, [])

  async function runClassify(src: string, explain: boolean): Promise<void> {
    if (!src.trim() || busy) return
    setBusy(true)
    setResult(null)
    setProgress({ phase: 'connecting', message: 'Starting…', tokens: 0, fraction: 0 })
    try {
      const r = await window.api.classifyArticle(src, explain)
      setResult(r)
      setClassifiedText(src)
      setSession((s) => ({
        count: s.count + 1,
        sumTps: s.sumTps + r.metrics.tokensPerSec,
        lastTps: r.metrics.tokensPerSec,
        sumLatency: s.sumLatency + r.latencyMs
      }))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const onClassify = (): void => void runClassify(text, false)
  const onExplain = (): void => void runClassify(classifiedText, true)

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onClassify()
  }

  const modelPresent = status?.models?.some((m) => m.startsWith('qwen2.5:14b'))
  const memPct =
    gpu?.ok && gpu.memTotalMb ? Math.round((100 * (gpu.memUsedMb ?? 0)) / gpu.memTotalMb) : 0
  const avgTps = session.count ? session.sumTps / session.count : 0
  const avgLat = session.count ? session.sumLatency / session.count / 1000 : 0
  const hasRationale = (result?.classification.signals ?? []).some((s) => s.rationale)

  return (
    <div className="term">
      {/* ── live status ribbon ─────────────────────────────────────────── */}
      <div className="ribbon">
        <span className="brand">NEWS-TRADER</span>
        <span className="seg">
          <span className="lbl">OLLAMA</span>
          {status ? (
            status.ok ? (
              <span className={modelPresent ? 'ok' : 'warn'}>
                {modelPresent ? 'UP qwen2.5:14b' : `UP · qwen2.5:14b MISSING`}
              </span>
            ) : (
              <span className="bad">DOWN</span>
            )
          ) : (
            <span className="dim">…</span>
          )}
        </span>
        <span className="seg">
          <span className="lbl">GPU</span>
          {gpu?.ok ? (
            <>
              <span className={barClass(gpu.utilization ?? 0)}>
                {String(gpu.utilization ?? 0).padStart(3)}%
              </span>
              <span className="dim">{miniBar(gpu.utilization ?? 0)}</span>
            </>
          ) : (
            <span className="dim">n/a</span>
          )}
        </span>
        <span className="seg">
          <span className="lbl">VRAM</span>
          {gpu?.ok ? (
            <span>
              {fmtGb(gpu.memUsedMb)}/{fmtGb(gpu.memTotalMb)}G <span className="dim">{memPct}%</span>
            </span>
          ) : (
            <span className="dim">n/a</span>
          )}
        </span>
        <span className="seg">
          <span className="lbl">TEMPERATURE</span>
          {gpu?.ok ? <span>{gpu.tempC}C</span> : <span className="dim">not available</span>}
        </span>
        <span className="seg">
          <span className="lbl">POWER</span>
          {gpu?.ok ? (
            <span>{Math.round(gpu.powerW ?? 0)}W</span>
          ) : (
            <span className="dim">not available</span>
          )}
        </span>
        <span className="seg">
          <span className="lbl">TOKENS / SECOND</span>
          <span className="hot">{session.lastTps ? session.lastTps.toFixed(1) : '—'}</span>
        </span>
        <span className="seg">
          <span className="lbl">SESSION</span>
          <span>
            count={session.count} average={avgTps ? avgTps.toFixed(1) : '—'} tokens/second{' '}
            {avgLat ? avgLat.toFixed(1) + 's' : ''}
          </span>
        </span>
      </div>

      {/* ── tab bar (M0: only CLASSIFY active) ─────────────────────────── */}
      <div className="tabs">
        <span
          className={`tab ${tab === 'running' ? 'active' : ''}`}
          onClick={() => setTab('running')}
        >
          RUNNING
        </span>
        <span
          className={`tab ${tab === 'classify' ? 'active' : ''}`}
          onClick={() => setTab('classify')}
        >
          CLASSIFY
        </span>
        <span
          className={`tab ${tab === 'topics' ? 'active' : ''}`}
          onClick={() => setTab('topics')}
        >
          TOPICS
        </span>
        <span
          className={`tab ${tab === 'prompt' ? 'active' : ''}`}
          onClick={() => setTab('prompt')}
        >
          PROMPT
        </span>
        <span
          className={`tab ${tab === 'tuning' ? 'active' : ''}`}
          onClick={() => setTab('tuning')}
        >
          TUNING
        </span>
        <span
          className={`tab ${tab === 'backtest' ? 'active' : ''}`}
          onClick={() => setTab('backtest')}
        >
          BACKTEST
        </span>
        <span className={`tab ${tab === 'data' ? 'active' : ''}`} onClick={() => setTab('data')}>
          DATA
        </span>
        <span
          className={`tab ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
        >
          SETTINGS
        </span>
      </div>

      {/* ── body ───────────────────────────────────────────────────────── */}
      {tab === 'running' && <RunningView />}
      {tab === 'settings' && <SettingsView />}
      {tab === 'topics' && <TopicsView />}
      {tab === 'prompt' && <PromptView />}
      {tab === 'tuning' && <ReviewView />}
      {tab === 'backtest' && <BacktestView />}
      {tab === 'data' && <DataView />}

      {tab === 'classify' && (
      <div className="body">
        <div className="lbl block">HEADLINE</div>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          placeholder="paste a headline…"
        />
        <div className="actions">
          <Tip label="ctrl + enter">
            <button onClick={onClassify} disabled={busy || !text.trim()}>
              {busy ? 'CLASSIFYING…' : 'CLASSIFY'}
            </button>
          </Tip>
        </div>

        {busy && progress && (
          <div className="prog">
            <div className="track">
              <div
                className={`fill ${progress.fraction <= 0 ? 'indet' : ''}`}
                style={progress.fraction > 0 ? { width: `${Math.round(progress.fraction * 100)}%` } : undefined}
              />
            </div>
            <div className="progmsg">{progress.message}</div>
          </div>
        )}

        {result && (
          <div className="out">
            {result.classification.summary && (
              <div className="summary">
                <span className="lbl">SUMMARY</span> {result.classification.summary}
              </div>
            )}

            <table className="sig">
              <thead>
                <tr>
                  <th>TOPIC</th>
                  <th>DIRECTION</th>
                  <th>CONFIDENCE</th>
                  {hasRationale && <th>RATIONALE</th>}
                </tr>
              </thead>
              <tbody>
                {result.classification.signals.length === 0 && (
                  <tr>
                    <td colSpan={hasRationale ? 4 : 3} className="dim">
                      no clear market signal
                    </td>
                  </tr>
                )}
                {result.classification.signals.map((s, i) => (
                  <tr key={i}>
                    <td className="topic">{s.topic}</td>
                    <td className={`dir ${s.direction}`}>{s.direction.toUpperCase()}</td>
                    <td className="conf">{s.confidence.toFixed(2)}</td>
                    {hasRationale && <td className="rat">{s.rationale}</td>}
                  </tr>
                ))}
              </tbody>
            </table>

            {result.classification.notes && (
              <div className="notes">
                <span className="lbl">NOTES</span> {result.classification.notes}
              </div>
            )}

            {!hasRationale && result.classification.signals.length > 0 && (
              <div className="actions">
                <Tip label="re-run this headline with reasoning + notes (slower)">
                  <button className="ghost" onClick={onExplain} disabled={busy}>
                    EXPLAIN
                  </button>
                </Tip>
              </div>
            )}

            <div className="runmeta">
              {result.model} · {result.metrics.promptEvalCount} input tokens →{' '}
              {result.metrics.evalCount} output tokens · {result.metrics.tokensPerSec.toFixed(1)}{' '}
              tokens/second · {(result.latencyMs / 1000).toFixed(1)} seconds elapsed · model load{' '}
              {(result.metrics.loadDurationMs / 1000).toFixed(1)} seconds
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  )
}

function fmtGb(mb?: number): string {
  return mb ? (mb / 1024).toFixed(1) : '0.0'
}

function barClass(util: number): string {
  if (util >= 60) return 'hot'
  if (util >= 20) return 'warn'
  return 'dim'
}

function miniBar(util: number): string {
  const n = Math.round((util / 100) * 10)
  return '█'.repeat(n) + '░'.repeat(10 - n)
}
