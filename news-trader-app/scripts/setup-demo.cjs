// One-time setup: register the demo dataset + seed topics into the default
// workspace so a backtest can be run immediately. Safe to re-run (overwrites).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Papa = require('papaparse')

const ws = path.join(process.env.APPDATA, 'news-trader-app', 'default-workspace')
const csv = path.resolve(__dirname, '..', '..', 'news-trader-data', 'demo-news.csv')
const now = new Date().toISOString()

// ── dataset stats ────────────────────────────────────────────────────────────
const text = fs.readFileSync(csv, 'utf8')
const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })
const dates = parsed.data.map((r) => r.date).filter(Boolean).sort()
const datasetId = crypto.randomUUID()
const datasets = [
  {
    id: datasetId,
    name: 'Demo News (2021-2024)',
    path: csv,
    source: 'demo',
    mapping: { headline: 'headline', date: 'date', ticker: 'ticker' },
    rows: parsed.data.length,
    dateFrom: new Date(dates[0]).toISOString(),
    dateTo: new Date(dates[dates.length - 1]).toISOString(),
    createdAt: now
  }
]

// ── topics + mappings ────────────────────────────────────────────────────────
const UNIVERSE = {
  oil: { name: 'Oil & Energy', color: '#d97706', syms: ['XOM', 'CVX', 'OXY', 'SLB'] },
  semiconductors: { name: 'Semiconductors', color: '#2563eb', syms: ['NVDA', 'AMD', 'AMAT', 'MU'] },
  airlines: { name: 'Airlines', color: '#16a34a', syms: ['DAL', 'UAL', 'AAL'] },
  defense: { name: 'Defense', color: '#dc2626', syms: ['LMT', 'RTX', 'NOC'] },
  banks: { name: 'Banks', color: '#9333ea', syms: ['JPM', 'BAC', 'GS', 'KRE'] },
  gold: { name: 'Gold', color: '#ca8a04', syms: ['NEM', 'GOLD'] },
  market: { name: 'Broad Market', color: '#db2777', syms: ['SPY', 'QQQ'] }
}
const topics = []
const mappings = []
for (const [label, t] of Object.entries(UNIVERSE)) {
  const id = crypto.randomUUID()
  topics.push({
    id,
    label,
    displayName: t.name,
    color: t.color,
    description: '',
    directionPolarity: 'direct',
    createdAt: now,
    updatedAt: now
  })
  for (const symbol of t.syms) {
    mappings.push({ id: crypto.randomUUID(), topicId: id, symbol, weight: 1, polarity: 'direct', addedAt: now })
  }
}

fs.writeFileSync(path.join(ws, 'datasets.json'), JSON.stringify(datasets, null, 2))
fs.writeFileSync(path.join(ws, 'topics.json'), JSON.stringify(topics, null, 2))
fs.writeFileSync(path.join(ws, 'mappings.json'), JSON.stringify(mappings, null, 2))
console.log(`registered dataset "${datasets[0].name}" (${datasets[0].rows} rows, ${dates[0]} → ${dates[dates.length - 1]})`)
console.log(`seeded ${topics.length} topics, ${mappings.length} ticker mappings`)
