// Verify the LEAN path (topic/direction/confidence only) + 5-level direction enum,
// and compare output-token cost vs the full (explain) schema. No Electron needed.
import { Ollama } from 'ollama'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

const Direction = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const Lean = z.object({
  signals: z.array(
    z.object({ topic: z.string(), direction: Direction, confidence_pct: z.number().int().min(0).max(100) })
  )
})
const Full = z.object({
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
  'You are a markets analyst. Direction is a 5-level conviction scale: bull (strong up), ' +
  'up (moderate up), neutral (no clear/priced-in), down (moderate down), bear (strong down). ' +
  'For a news item, list affected sector/theme groups, their direction, and confidence_pct (0-100). ' +
  'Reason about causal direction; opposite-side stocks move opposite ways.'

const client = new Ollama({ host: 'http://localhost:11434' })
const headline = 'Iran closes the Strait of Hormuz to oil tankers.'

async function run(label, schema, parser) {
  const r = await client.chat({
    model: 'qwen2.5:14b',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: headline }
    ],
    format: zodToJsonSchema(schema, { $refStrategy: 'none' }),
    options: { temperature: 0 },
    keep_alive: '30m'
  })
  const parsed = parser.parse(JSON.parse(r.message.content))
  const out = r.eval_count ?? 0
  const secs = (r.eval_duration ?? 0) / 1e9
  console.log(`\n=== ${label} ===  input=${r.prompt_eval_count} output=${out} tokens  ${secs.toFixed(1)}s  ${(out / secs).toFixed(0)} tok/s`)
  for (const s of parsed.signals) {
    console.log(`  ${s.topic.padEnd(14)} ${s.direction.padEnd(7)} ${(s.confidence_pct / 100).toFixed(2)}`)
  }
}

await run('LEAN (default)', Lean, Lean)
await run('FULL (explain)', Full, Full)
