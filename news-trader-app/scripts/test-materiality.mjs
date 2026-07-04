import { Ollama } from 'ollama'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { SYSTEM } from './_system.mjs'

const ollama = new Ollama({ host: 'http://localhost:11434' })
const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })

const tests = [
  'Diddy escapes prison',
  'Goldman Sachs CEO spotted eating lunch at a new restaurant',
  'US government cuts billions in funding for private prison technology',
  'Iran closes the Strait of Hormuz to oil tankers',
  'JPMorgan executives charged with insider trading by the SEC'
]
for (const h of tests) {
  const r = await ollama.chat({ model: 'qwen2.5:14b', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: h }], format: zodToJsonSchema(Lean, { $refStrategy: 'none' }), options: { temperature: 0 }, keep_alive: '30m' })
  const sigs = Lean.parse(JSON.parse(r.message.content)).signals
  console.log(`\n"${h}"`)
  if (!sigs.length) console.log('  -> (no signal — NEUTRAL) [correct for trivial news]')
  for (const s of sigs) console.log(`  -> ${s.topic} ${s.direction} ${s.confidence_pct}%`)
}
