import { useEffect, useRef, useState } from 'react'
import type { ClassifyResult } from './env'
import type { Rating, FeedbackStats } from '@shared/schema'
import Tip from './Tip'

// Built-in starter queue. M5 (data import) will feed real dataset headlines here.
const QUEUE = [
  'Iran closes the Strait of Hormuz to oil tankers.',
  'Fed raises rates 25bps after a hotter-than-expected CPI report.',
  'US announces sweeping new semiconductor export controls on China.',
  'Pfizer recalls a blood pressure drug after an FDA warning.',
  'Bitcoin surges to a record high as spot ETF inflows soar.',
  'OPEC announces a surprise production cut.',
  'Nvidia reports record data-center revenue and raises guidance.',
  'A hurricane forces the shutdown of Gulf Coast refineries.',
  'The monthly jobs report comes in far weaker than expected.',
  'The EU opens an antitrust probe into Apple App Store.',
  'Gold hits an all-time high as investors seek safe havens.',
  'A major US regional bank discloses large deposit outflows.'
]

const RATINGS: Rating[] = ['bad', 'ok', 'good']

export default function ReviewView(): JSX.Element {
  const [idx, setIdx] = useState(0)
  const [results, setResults] = useState<Record<number, ClassifyResult>>({})
  const [stats, setStats] = useState<FeedbackStats>({ total: 0, bad: 0, ok: 0, good: 0 })
  const [comment, setComment] = useState('')
  const [overall, setOverall] = useState<Rating | null>(null)
  const [sigRatings, setSigRatings] = useState<Record<number, Rating>>({})
  const resultsRef = useRef<Record<number, ClassifyResult>>({})
  const inflight = useRef<Set<number>>(new Set())
  const saving = useRef(false)

  async function ensure(i: number): Promise<void> {
    if (i < 0 || i >= QUEUE.length) return
    if (resultsRef.current[i] || inflight.current.has(i)) return
    inflight.current.add(i)
    try {
      const r = await window.api.classifyArticle(QUEUE[i], false)
      resultsRef.current = { ...resultsRef.current, [i]: r }
      setResults(resultsRef.current)
    } finally {
      inflight.current.delete(i)
    }
  }

  useEffect(() => {
    window.api.feedbackStats().then(setStats)
  }, [])

  // New item: classify it + the next, and clear the rating widgets.
  useEffect(() => {
    ensure(idx)
    ensure(idx + 1)
    setOverall(null)
    setSigRatings({})
    setComment('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx])

  async function submit(): Promise<void> {
    const res = resultsRef.current[idx]
    if (!res || !overall || saving.current || idx >= QUEUE.length) return
    saving.current = true
    try {
      const signalRatings = Object.entries(sigRatings).map(([i, rating]) => {
        const s = res.classification.signals[Number(i)]
        return { topic: s.topic, direction: s.direction, rating }
      })
      await window.api.feedbackSave({
        headline: QUEUE[idx],
        classification: res.classification,
        rating: overall,
        signalRatings,
        comment,
        model: res.model
      })
      setStats(await window.api.feedbackStats())
      setIdx((i) => i + 1)
    } finally {
      saving.current = false
    }
  }

  function skip(): void {
    setIdx((i) => i + 1)
  }

  // Keyboard: <- / space / -> set the OVERALL verdict; Enter submits; s skips.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
        return
      }
      if (e.key === 'ArrowLeft' || e.key === '1') setOverall('bad')
      else if (e.key === ' ' || e.key === '2') {
        e.preventDefault()
        setOverall('ok')
      } else if (e.key === 'ArrowRight' || e.key === '3') setOverall('good')
      else if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (e.key.toLowerCase() === 's') skip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, comment, overall, sigRatings])

  const done = idx >= QUEUE.length
  const res = results[idx]

  return (
    <div className="body">
      <div className="reviewbar">
        <span className="lbl">REVIEW</span>
        <span>
          {Math.min(idx + (done ? 0 : 1), QUEUE.length)} / {QUEUE.length}
        </span>
        <span className="seg2">
          labeled <span className="ok">{stats.total}</span> ·{' '}
          <span className="bad">{stats.bad} bad</span> · <span className="warn">{stats.ok} ok</span>{' '}
          · <span className="ok">{stats.good} good</span>
        </span>
      </div>

      {done ? (
        <div className="reviewdone">
          <div>Queue complete — {stats.total} labels saved this workspace.</div>
          <button className="ghost mt" onClick={() => setIdx(0)}>
            RESTART QUEUE
          </button>
        </div>
      ) : (
        <>
          <div className="headline">{QUEUE[idx]}</div>

          {res ? (
            <table className="sig">
              <thead>
                <tr>
                  <th>TOPIC</th>
                  <th>DIRECTION</th>
                  <th>CONFIDENCE</th>
                  <th>RATE THIS CALL</th>
                </tr>
              </thead>
              <tbody>
                {res.classification.signals.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dim">
                      no clear market signal
                    </td>
                  </tr>
                )}
                {res.classification.signals.map((s, i) => (
                  <tr key={i}>
                    <td className="topic">{s.topic}</td>
                    <td className={`dir ${s.direction}`}>{s.direction.toUpperCase()}</td>
                    <td className="conf">{s.confidence.toFixed(2)}</td>
                    <td>
                      <span className="seg3">
                        {RATINGS.map((r) => (
                          <button
                            key={r}
                            className={`segbtn ${r} ${sigRatings[i] === r ? 'on' : ''}`}
                            onClick={() => setSigRatings((p) => ({ ...p, [i]: r }))}
                          >
                            {r === 'bad' ? 'BAD' : r === 'ok' ? 'OK' : 'GOOD'}
                          </button>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dim classifying">classifying…</div>
          )}

          <div className="raterow">
            <span className="lbl ovr">OVERALL</span>
            <Tip label="left arrow  ·  1">
              <button
                className={`rate bad ${overall === 'bad' ? 'on' : ''}`}
                disabled={!res}
                onClick={() => setOverall('bad')}
              >
                BAD
              </button>
            </Tip>
            <Tip label="space bar  ·  2">
              <button
                className={`rate ok ${overall === 'ok' ? 'on' : ''}`}
                disabled={!res}
                onClick={() => setOverall('ok')}
              >
                OK
              </button>
            </Tip>
            <Tip label="right arrow  ·  3">
              <button
                className={`rate good ${overall === 'good' ? 'on' : ''}`}
                disabled={!res}
                onClick={() => setOverall('good')}
              >
                GOOD
              </button>
            </Tip>
          </div>

          <div className="raterow">
            <input
              className="commentbox"
              value={comment}
              placeholder="optional note (why)"
              spellCheck={false}
              onChange={(e) => setComment(e.target.value)}
            />
            <Tip label="enter">
              <button onClick={submit} disabled={!res || !overall || saving.current}>
                SUBMIT
              </button>
            </Tip>
            <Tip label="s">
              <button className="ghost" onClick={skip}>
                SKIP
              </button>
            </Tip>
          </div>
        </>
      )}
    </div>
  )
}
