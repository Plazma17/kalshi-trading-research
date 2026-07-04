// Quick validation of the self-disruption-check prompt on a handful of held-out headlines
// (base qwen2.5:14b, no fine-tune). Prints the model's disruption_check + signals so we can
// eyeball whether the self-question actually sharpens selectivity before a full re-classify.
import { createReadStream } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import { Ollama } from 'ollama'
import { SYSTEM_SELFCHECK } from './_system_selfcheck.mjs'

const ollama = new Ollama({ host: 'http://localhost:11434' })
const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const MODEL = process.env.NT_MODEL || 'qwen2.5:14b'
const CUTOFF = '2019-11-25'
const SHAPE = '\n\nRespond with ONLY this JSON object: {"disruption_check":"<one sentence>","signals":[{"topic":"<lowercase sector>","direction":"bear|down|neutral|up|bull","confidence_pct":<int 0-100>}]}. Empty signals = {"disruption_check":"...","signals":[]}. No prose, no markdown.'

function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString().slice(0, 10), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) })
}
const rows = (await readCsv()).filter((r) => r.date > CUTOFF)
// take a spread: every Nth held-out headline, 14 samples
const N = Math.floor(rows.length / 14)
const sample = []; for (let i = 0; i < rows.length && sample.length < 14; i += N) sample.push(rows[i])

console.log(`self-check prompt test — model=${MODEL}, ${sample.length} held-out headlines\n`)
for (const r of sample) {
  let out = '(parse fail)'
  try {
    const resp = await ollama.chat({ model: MODEL, messages: [{ role: 'system', content: SYSTEM_SELFCHECK + SHAPE }, { role: 'user', content: r.headline }], format: 'json', options: { temperature: 0, num_predict: 256 }, keep_alive: '30m' })
    const j = JSON.parse(resp.message.content)
    const sigs = (j.signals || []).map((s) => `${s.topic}:${s.direction}@${s.confidence_pct}`).join(', ') || '(none)'
    out = `check="${(j.disruption_check || '').slice(0, 110)}"\n     -> ${sigs}`
  } catch (e) { out = `ERR ${e.message?.slice(0, 60)}` }
  console.log(`[${r.ticker}] ${r.headline.slice(0, 92)}\n     ${out}\n`)
}
