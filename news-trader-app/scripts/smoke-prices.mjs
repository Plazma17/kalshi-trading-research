// Verify yahoo-finance2 price fetch + the next-open / horizon logic.
import YahooFinance from 'yahoo-finance2'

const yahooFinance = new YahooFinance()
try {
  yahooFinance.suppressNotices?.(['yahooSurvey', 'ripHistorical'])
} catch {
  /* noop */
}

const res = await yahooFinance.chart('AAPL', {
  period1: '2024-04-01',
  period2: '2024-04-30',
  interval: '1d'
})
const bars = (res.quotes ?? [])
  .filter((q) => q.open != null && q.close != null)
  .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close }))

console.log(`AAPL bars fetched: ${bars.length}`)
console.log('first 3:', bars.slice(0, 3).map((b) => `${b.date} o=${b.open.toFixed(2)} c=${b.close.toFixed(2)}`).join(' | '))

// next trading day strictly after a Friday (2024-04-12) and 3-day horizon exit
const pub = '2024-04-12'
const entry = bars.find((b) => b.date > pub)
const idx = bars.findIndex((b) => b.date >= entry.date)
const exit = bars[idx + 3]
console.log(`entry (next open after ${pub}): ${entry.date} @ ${entry.open.toFixed(2)}`)
console.log(`exit (+3 trading days): ${exit.date} @ ${exit.close.toFixed(2)}`)
console.log(`forward return: ${(((exit.close / entry.open) - 1) * 100).toFixed(2)}%`)
