// Classify the full held-out set with the BASE model + self-disruption-check prompt, writing
// {headline: [signals]} -> selfcheck-classifications.json for the overlay A/B. No fine-tune:
// this tests whether better PROMPTING (the user's "ask if it really disrupts markets" idea)
// rivals the trained adapter as a downside detector. Resumable cache.
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import { Ollama } from 'ollama'
import { z } from 'zod'
import { SYSTEM_SELFCHECK } from './_system_selfcheck.mjs'

const ollama = new Ollama({ host: 'http://localhost:11434' })
const here = dirname(fileURLToPath(import.meta.url))
const MODEL = process.env.NT_MODEL || 'qwen2.5:14b'
const CUTOFF = process.env.NT_CUTOFF || '2019-11-25'
const CSV = process.env.NT_CSV || join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const OUT = join(here, process.env.NT_OUT || 'selfcheck-classifications.json')
const YEARCAP = Number(process.env.NT_YEARCAP || 0)  // optional per-year headline cap
const SHAPE = '\n\nRespond with ONLY this JSON object: {"disruption_check":"<one sentence>","signals":[{"topic":"<lowercase sector>","direction":"bear|down|neutral|up|bull","confidence_pct":<int 0-100>}]}. Empty signals = {"disruption_check":"...","signals":[]}. No prose, no markdown.'
const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const Sel = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })

function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(CSV, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString().slice(0, 10) }) }, complete: () => res(out), error: rej }) })
}
let rows = (await readCsv()).filter((r) => r.date > CUTOFF)
if (YEARCAP) { const per = {}; rows = rows.filter((r) => { const y = r.date.slice(0, 4); per[y] = (per[y] || 0) + 1; return per[y] <= YEARCAP }) }
const heads = [...new Set(rows.map((r) => r.headline))]
const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
console.log(`self-check classify: model=${MODEL}, ${heads.length} unique held-out headlines (${Object.keys(out).length} cached)`)
const sys = SYSTEM_SELFCHECK + SHAPE
let done = 0, t0 = Date.now()
for (const h of heads) {
  if (!out[h]) {
    try {
      const r = await ollama.chat({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: h }], format: 'json', options: { temperature: 0, num_predict: 256, stop: ['<|im_end|>'] }, keep_alive: '30m' })
      out[h] = Sel.parse(JSON.parse(r.message.content)).signals
    } catch { out[h] = [] }
    if (++done % 25 === 0) { writeFileSync(OUT, JSON.stringify(out)); const eta = ((Date.now() - t0) / done) * (heads.length - Object.keys(out).length) / 60000; console.log(`${Object.keys(out).length}/${heads.length}  (eta ${eta.toFixed(0)}m)`) }
  }
}
writeFileSync(OUT, JSON.stringify(out))
console.log(`DONE -> ${OUT}  (${Object.keys(out).length} headlines, ${Object.values(out).filter((s) => s.length).length} with >=1 signal)`)
