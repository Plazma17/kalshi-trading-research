// Standalone smoke test of the Node -> Ollama classify path (no Electron needed).
// Mirrors src/main/ollama.ts: int 0-100 confidence grammar -> normalize to 0..1.
import { Ollama } from 'ollama'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

const Direction = z.enum(['up', 'down', 'hold'])
const LLMArticle = z.object({
  summary: z.string(),
  signals: z.array(
    z.object({
      topic: z.string(),
      direction: Direction,
      confidence_pct: z.number().int().min(0).max(100),
      rationale: z.string()
    })
  ),
  notes: z.string()
})
const SYSTEM =
  'You are a markets analyst. For a news item, list affected sector/theme groups and ' +
  'whether their stocks go up/down/hold, reasoning about CAUSAL direction (opposite-side ' +
  'stocks move opposite ways). confidence_pct is an integer 0-100.'

const client = new Ollama({ host: 'http://localhost:11434' })
const headline = process.argv.slice(2).join(' ') || 'Iran closes the Strait of Hormuz to oil tankers.'

const t0 = Date.now()
const resp = await client.chat({
  model: 'qwen2.5:14b',
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: headline }
  ],
  format: zodToJsonSchema(LLMArticle, { $refStrategy: 'none' }),
  options: { temperature: 0 },
  keep_alive: '30m'
})
const raw = LLMArticle.parse(JSON.parse(resp.message.content))
console.log(`HEADLINE: ${headline}`)
console.log(`summary : ${raw.summary}`)
for (const s of raw.signals) {
  console.log(
    `  ${s.topic.padEnd(14)} ${s.direction.padEnd(5)} conf=${(s.confidence_pct / 100).toFixed(2)}  ${s.rationale}`
  )
}
if (raw.notes) console.log(`notes   : ${raw.notes}`)
console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`)
