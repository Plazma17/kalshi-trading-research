// Register the FNSPID real-news sample as a dataset (alongside the demo).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Papa = require('papaparse')

const ws = path.join(process.env.APPDATA, 'news-trader-app', 'default-workspace')
const csv = path.resolve(__dirname, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const parsed = Papa.parse(fs.readFileSync(csv, 'utf8'), { header: true, skipEmptyLines: true })
const dates = parsed.data
  .map((r) => new Date(r.date))
  .filter((d) => !isNaN(d))
  .sort((a, b) => a - b)

const dpath = path.join(ws, 'datasets.json')
let datasets = []
try {
  datasets = JSON.parse(fs.readFileSync(dpath, 'utf8'))
} catch {}
datasets = datasets.filter((d) => d.name !== 'FNSPID Universe (real)')
datasets.push({
  id: crypto.randomUUID(),
  name: 'FNSPID Universe (real)',
  path: csv,
  source: 'fnspid',
  mapping: { headline: 'headline', date: 'date', ticker: 'ticker' },
  rows: parsed.data.length,
  dateFrom: dates[0].toISOString(),
  dateTo: dates[dates.length - 1].toISOString(),
  createdAt: new Date().toISOString()
})
fs.writeFileSync(dpath, JSON.stringify(datasets, null, 2))
console.log(`registered FNSPID Universe: ${parsed.data.length} rows, ${dates[0].toISOString().slice(0, 10)} -> ${dates[dates.length - 1].toISOString().slice(0, 10)}`)
