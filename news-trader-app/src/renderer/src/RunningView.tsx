import { useEffect, useState } from 'react'
import type { RunStatus } from './env'
import { NetWorthChart } from './charts'

export default function RunningView(): JSX.Element {
  const [status, setStatus] = useState<RunStatus | null>(null)

  useEffect(() => {
    const poll = (): void => {
      window.api.runStatusGet().then(setStatus).catch(() => {})
    }
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [])

  if (!status) {
    return (
      <div className="body dim">
        Nothing running yet. When a backtest or analysis is launched, it streams here live
        with graphs.
      </div>
    )
  }

  const ageMs = Date.now() - new Date(status.updatedAt).getTime()
  const live = status.active && ageMs < 15000

  return (
    <div className="body">
      <div className="reviewbar">
        <span className="lbl">RUNNING</span>
        <span className={live ? 'ok' : 'dim'}>
          {live ? '● LIVE' : '○ idle (last run)'}
        </span>
        <span className="dim">{status.label}</span>
      </div>

      <div className="prog">
        <div className="track">
          <div className="fill" style={{ width: `${Math.round(status.fraction * 100)}%` }} />
        </div>
        <div className="progmsg">{status.message}</div>
      </div>

      {status.bignums && status.bignums.length > 0 && (
        <div className="bignums">
          {status.bignums.map((b, i) => (
            <div className="bignum" key={i}>
              <div className={`bnval ${b.tone ?? ''}`}>{b.value}</div>
              <div className="bnlbl">{b.label}</div>
            </div>
          ))}
        </div>
      )}

      {status.equity.length > 0 && (
        <>
          <div className="lbl block mt">{status.chartLabel ?? 'NET WORTH OVER TIME'}</div>
          <NetWorthChart points={status.equity} initial={status.initialNetWorth ?? 10000} />
        </>
      )}

      {status.feed.length > 0 && (
        <>
          <div className="lbl block mt">TRADE FEED</div>
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
              {status.feed.slice(0, 30).map((t, i) => (
                <tr key={i}>
                  <td className="dim">{t.date}</td>
                  <td className="topic">{t.topic}</td>
                  <td className={`dir ${t.direction}`}>{t.direction.toUpperCase()}</td>
                  <td>{t.symbol}</td>
                  <td className={t.fwd >= 0 ? 'ok' : 'bad'}>
                    {t.fwd >= 0 ? '+' : ''}
                    {t.fwd.toFixed(1)}%
                  </td>
                  <td className={t.correct ? 'ok' : 'bad'}>{t.correct ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
