import * as YFNS from 'yahoo-finance2'

// yahoo-finance2 v3 needs `new YahooFinance()`. The bundled main require()s it and
// esbuild's interop can nest the class under one or more `.default`s — unwrap until
// we reach the actual constructor function.
/* eslint-disable @typescript-eslint/no-explicit-any */
let YahooFinanceCtor: any = YFNS
while (
  YahooFinanceCtor &&
  typeof YahooFinanceCtor !== 'function' &&
  (YahooFinanceCtor.YahooFinance || YahooFinanceCtor.default)
) {
  YahooFinanceCtor = YahooFinanceCtor.YahooFinance ?? YahooFinanceCtor.default
}
const yahooFinance: any = new YahooFinanceCtor()
/* eslint-enable @typescript-eslint/no-explicit-any */

// Silence the library's interactive notices in a headless app.
try {
  yahooFinance.suppressNotices?.(['yahooSurvey', 'ripHistorical'])
} catch {
  /* noop */
}

export interface Bar {
  date: string // YYYY-MM-DD
  open: number
  close: number
}

// Per-process cache: symbol -> sorted daily bars. Rebuilt per app run (not exported).
const cache = new Map<string, Bar[]>()

/** Daily bars for a symbol over [from, to]; cached. Returns [] if unavailable. */
export async function getBars(symbol: string, from: string, to: string): Promise<Bar[]> {
  const cached = cache.get(symbol)
  if (cached) return cached
  try {
    const res = (await yahooFinance.chart(symbol, {
      period1: from,
      period2: to,
      interval: '1d'
    })) as { quotes: { date: Date; open: number | null; close: number | null }[] }
    const bars: Bar[] = (res.quotes ?? [])
      .filter((q) => q.open != null && q.close != null && q.date != null)
      .map((q) => ({
        date: new Date(q.date).toISOString().slice(0, 10),
        open: q.open as number,
        close: q.close as number
      }))
      .sort((a: Bar, b: Bar) => (a.date < b.date ? -1 : 1))
    cache.set(symbol, bars)
    return bars
  } catch {
    cache.set(symbol, [])
    return []
  }
}

export function clearPriceCache(): void {
  cache.clear()
}

/** First bar strictly AFTER `isoDate` (next trading day) — the look-ahead-safe entry. */
export function nextBar(bars: Bar[], isoDate: string): Bar | null {
  const d = isoDate.slice(0, 10)
  for (const b of bars) if (b.date > d) return b
  return null
}

/** First bar on or after `isoDate` (same-day entry, optimistic). */
export function barOnOrAfter(bars: Bar[], isoDate: string): Bar | null {
  const d = isoDate.slice(0, 10)
  for (const b of bars) if (b.date >= d) return b
  return null
}

/** The bar `horizon` trading days after the one at/after `fromDate`. */
export function barAfterHorizon(bars: Bar[], fromDate: string, horizon: number): Bar | null {
  const idx = bars.findIndex((b) => b.date >= fromDate)
  if (idx < 0) return null
  const exit = bars[idx + horizon]
  return exit ?? null
}
