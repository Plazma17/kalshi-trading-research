import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { Topic, StockTopicMapping } from '@shared/schema'

// Starter universe from the strategy playbook — one click to get going.
const SEED: { label: string; displayName: string; symbols: string[] }[] = [
  { label: 'oil', displayName: 'Oil & Energy', symbols: ['XOM', 'CVX', 'OXY', 'SLB'] },
  { label: 'defense', displayName: 'Defense', symbols: ['LMT', 'RTX', 'NOC'] },
  { label: 'airlines', displayName: 'Airlines', symbols: ['DAL', 'UAL', 'AAL'] },
  { label: 'semiconductors', displayName: 'Semiconductors', symbols: ['NVDA', 'AMD', 'AMAT', 'MU'] },
  { label: 'banks', displayName: 'Banks', symbols: ['JPM', 'BAC', 'GS'] },
  { label: 'gold', displayName: 'Gold', symbols: ['NEM', 'GOLD'] },
  { label: 'crypto', displayName: 'Crypto', symbols: ['COIN', 'MSTR', 'MARA', 'RIOT'] },
  { label: 'market', displayName: 'Broad Market', symbols: ['SPY', 'QQQ'] }
]

export default function TopicsView(): JSX.Element {
  const [topics, setTopics] = useState<Topic[]>([])
  const [mappings, setMappings] = useState<StockTopicMapping[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  async function reload(): Promise<void> {
    const [t, m] = await Promise.all([window.api.topicsList(), window.api.mappingsList()])
    setTopics(t)
    setMappings(m)
  }
  useEffect(() => {
    reload()
  }, [])

  // symbol -> number of distinct topics it appears in (the many-to-many made visible)
  const symbolTopicCount = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const m of mappings) (map[m.symbol] ??= new Set()).add(m.topicId)
    const out: Record<string, number> = {}
    for (const s in map) out[s] = map[s].size
    return out
  }, [mappings])

  const tickersOf = (topicId: string): string[] =>
    mappings
      .filter((m) => m.topicId === topicId)
      .map((m) => m.symbol)
      .sort()

  async function addTicker(topicId: string, raw: string): Promise<void> {
    const v = await window.api.tickerValidate(raw)
    if (!v.ok || !v.symbol) return
    const cur = tickersOf(topicId)
    if (cur.includes(v.symbol)) {
      setDrafts((d) => ({ ...d, [topicId]: '' }))
      return
    }
    const next = await window.api.mappingsSetForTopic(topicId, [...cur, v.symbol])
    setMappings(next)
    setDrafts((d) => ({ ...d, [topicId]: '' }))
  }

  async function removeTicker(topicId: string, symbol: string): Promise<void> {
    const next = await window.api.mappingsSetForTopic(
      topicId,
      tickersOf(topicId).filter((s) => s !== symbol)
    )
    setMappings(next)
  }

  async function saveField(topic: Topic, patch: Partial<Topic>): Promise<void> {
    const updated = await window.api.topicSave({ id: topic.id, ...patch })
    setTopics((ts) => ts.map((t) => (t.id === updated.id ? updated : t)))
  }

  async function createTopic(): Promise<void> {
    await window.api.topicSave({ label: 'new-topic', displayName: 'New Topic' })
    await reload()
  }

  async function removeTopic(id: string): Promise<void> {
    await window.api.topicDelete(id)
    await reload()
  }

  async function seed(): Promise<void> {
    for (const s of SEED) {
      const t = await window.api.topicSave({ label: s.label, displayName: s.displayName })
      await window.api.mappingsSetForTopic(t.id, s.symbols)
    }
    await reload()
  }

  const uniqueTickers = Object.keys(symbolTopicCount).length

  return (
    <div className="body">
      <div className="topicsbar">
        <button className="ghost" onClick={createTopic}>
          + NEW TOPIC
        </button>
        {topics.length === 0 && (
          <button className="ghost" onClick={seed}>
            SEED EXAMPLE TOPICS
          </button>
        )}
        <span className="dim">
          {topics.length} topics · {uniqueTickers} unique tickers · {mappings.length} mappings
        </span>
      </div>

      <div className="board">
        {topics.map((t) => (
          <div className="topicbox" key={t.id} style={{ borderTopColor: t.color }}>
            <div className="topichead">
              <input
                className="tname"
                defaultValue={t.displayName}
                placeholder="Display name"
                spellCheck={false}
                onBlur={(e) => saveField(t, { displayName: e.target.value })}
              />
              <button className="x" title="delete topic" onClick={() => removeTopic(t.id)}>
                ×
              </button>
            </div>
            <input
              className="tlabel"
              defaultValue={t.label}
              placeholder="label (classifier key)"
              spellCheck={false}
              onBlur={(e) => saveField(t, { label: e.target.value.toLowerCase() })}
            />

            <div className="chips">
              {tickersOf(t.id).map((sym) => (
                <span className="chip" key={sym}>
                  {sym}
                  {symbolTopicCount[sym] > 1 && (
                    <span className="cnt" title={`in ${symbolTopicCount[sym]} topics`}>
                      {symbolTopicCount[sym]}
                    </span>
                  )}
                  <button className="chipx" onClick={() => removeTicker(t.id, sym)}>
                    ×
                  </button>
                </span>
              ))}
            </div>

            <input
              className="addticker"
              value={drafts[t.id] ?? ''}
              placeholder="+ ticker, enter"
              spellCheck={false}
              onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') addTicker(t.id, (e.target as HTMLInputElement).value)
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
