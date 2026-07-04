import { randomUUID } from 'crypto'
import { FeedbackSchema, type Feedback, type FeedbackStats } from '@shared/schema'
import { appendJsonl, readJsonl } from './files'

const FEEDBACK = 'feedback.jsonl'

export async function saveFeedback(input: Omit<Feedback, 'id' | 'createdAt'>): Promise<Feedback> {
  const fb = FeedbackSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  })
  await appendJsonl(FEEDBACK, fb)
  return fb
}

export async function listFeedback(): Promise<Feedback[]> {
  const raw = await readJsonl<unknown>(FEEDBACK)
  // Tolerate the odd malformed line rather than failing the whole list.
  const out: Feedback[] = []
  for (const r of raw) {
    const p = FeedbackSchema.safeParse(r)
    if (p.success) out.push(p.data)
  }
  return out
}

export async function feedbackStats(): Promise<FeedbackStats> {
  const all = await listFeedback()
  return {
    total: all.length,
    bad: all.filter((f) => f.rating === 'bad').length,
    ok: all.filter((f) => f.rating === 'ok').length,
    good: all.filter((f) => f.rating === 'good').length
  }
}
