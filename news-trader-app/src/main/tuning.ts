import { randomUUID } from 'crypto'
import { InstructionSetSchema, SYSTEM, type InstructionSet } from '@shared/schema'
import { readJsonFile, writeJsonFile } from './files'
import { listFeedback } from './feedback'
import { getSettings } from './state'
import { updateSettings } from './workspace'

const FILE = 'instruction-sets.json'

export async function listInstructionSets(): Promise<InstructionSet[]> {
  const raw = await readJsonFile<unknown[]>(FILE, [])
  const out: InstructionSet[] = []
  for (const r of raw) {
    const p = InstructionSetSchema.safeParse(r)
    if (p.success) out.push(p.data)
  }
  return out
}

/**
 * Deterministically compile the workspace's feedback into a new InstructionSet:
 * good-rated items become positive few-shot exemplars; frequently wrong per-signal
 * calls + reviewer notes become guidelines. No training — pure prompt engineering.
 */
export async function compileInstructionSet(): Promise<InstructionSet> {
  const fb = await listFeedback()
  const good = fb.filter((f) => f.rating === 'good')
  const ok = fb.filter((f) => f.rating === 'ok')
  const bad = fb.filter((f) => f.rating === 'bad')

  const fewShotExamples = good
    .slice(-8)
    .map((f) => ({ headline: f.headline, classification: f.classification }))

  const guidelines: string[] = []

  // Per-signal calls the human marked wrong, most frequent first.
  const badCounts: Record<string, number> = {}
  for (const f of fb)
    for (const sr of f.signalRatings)
      if (sr.rating === 'bad') {
        const k = `${sr.topic} → ${sr.direction}`
        badCounts[k] = (badCounts[k] ?? 0) + 1
      }
  for (const [k, c] of Object.entries(badCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    guidelines.push(`The call "${k}" was rated wrong ${c}× — only emit it with strong, specific justification.`)
  }

  // Reviewer notes are high-signal guidance — include verbatim.
  for (const f of fb) {
    const c = f.comment.trim()
    if (c) guidelines.push(`Reviewer note: ${c}`)
  }

  const uniqueGuidelines = [...new Set(guidelines)].slice(0, 25)
  const version = (await listInstructionSets()).length + 1

  const set = InstructionSetSchema.parse({
    id: randomUUID(),
    version,
    createdAt: new Date().toISOString(),
    sourceFeedbackCount: fb.length,
    guidelines: uniqueGuidelines,
    fewShotExamples,
    stats: { good: good.length, ok: ok.length, bad: bad.length }
  })

  const all = await listInstructionSets()
  await writeJsonFile(FILE, [...all, set])
  return set
}

export async function activateInstructionSet(id: string): Promise<void> {
  await updateSettings({ activeInstructionSetId: id })
}

export interface PromptParts {
  system: string
  fewShot: { role: 'user' | 'assistant'; content: string }[]
}

/**
 * Build the system prompt + few-shot turns actually sent to the model: the base
 * prompt (user override or built-in SYSTEM) plus the active instruction set's
 * guidelines, and (lean mode only) its few-shot exemplars.
 */
export async function getActivePromptParts(explain: boolean): Promise<PromptParts> {
  const s = getSettings()
  const base = s.systemPrompt?.trim() || SYSTEM
  const activeId = s.activeInstructionSetId
  if (!activeId) return { system: base, fewShot: [] }

  const set = (await listInstructionSets()).find((x) => x.id === activeId)
  if (!set) return { system: base, fewShot: [] }

  let system = base
  if (set.guidelines.length) {
    system +=
      '\n\n## Learned guidelines from human feedback (follow these):\n' +
      set.guidelines.map((g) => `- ${g}`).join('\n')
  }

  // Few-shot only in lean mode, shaped to the lean schema the model is emitting.
  const fewShot: PromptParts['fewShot'] = explain
    ? []
    : set.fewShotExamples.flatMap((ex) => [
        { role: 'user' as const, content: ex.headline },
        {
          role: 'assistant' as const,
          content: JSON.stringify({
            signals: ex.classification.signals.map((sig) => ({
              topic: sig.topic,
              direction: sig.direction,
              confidence_pct: Math.round(sig.confidence * 100)
            }))
          })
        }
      ])

  return { system, fewShot }
}
