import { randomUUID } from 'crypto'
import {
  TopicSchema,
  StockTopicMappingSchema,
  type Topic,
  type StockTopicMapping
} from '@shared/schema'
import { readJsonFile, writeJsonFile } from './files'

const TOPICS = 'topics.json'
const MAPPINGS = 'mappings.json'

const PALETTE = [
  '#d97706',
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#9333ea',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#0d9488',
  '#e11d48'
]

export async function listTopics(): Promise<Topic[]> {
  const raw = await readJsonFile<unknown[]>(TOPICS, [])
  return raw.map((t) => TopicSchema.parse(t))
}

export async function listMappings(): Promise<StockTopicMapping[]> {
  const raw = await readJsonFile<unknown[]>(MAPPINGS, [])
  return raw.map((m) => StockTopicMappingSchema.parse(m))
}

export async function saveTopic(input: Partial<Topic>): Promise<Topic> {
  const topics = await listTopics()
  const now = new Date().toISOString()

  if (input.id) {
    const idx = topics.findIndex((t) => t.id === input.id)
    if (idx >= 0) {
      const updated = TopicSchema.parse({ ...topics[idx], ...input, updatedAt: now })
      topics[idx] = updated
      await writeJsonFile(TOPICS, topics)
      return updated
    }
  }

  const created = TopicSchema.parse({
    id: randomUUID(),
    label: (input.label ?? 'new-topic').toLowerCase(),
    displayName: input.displayName ?? '',
    color: input.color ?? PALETTE[topics.length % PALETTE.length],
    description: input.description ?? '',
    directionPolarity: input.directionPolarity ?? 'direct',
    createdAt: now,
    updatedAt: now
  })
  topics.push(created)
  await writeJsonFile(TOPICS, topics)
  return created
}

export async function deleteTopic(id: string): Promise<void> {
  const topics = (await listTopics()).filter((t) => t.id !== id)
  const mappings = (await listMappings()).filter((m) => m.topicId !== id)
  await writeJsonFile(TOPICS, topics)
  await writeJsonFile(MAPPINGS, mappings)
}

/** Replace the full set of tickers for one topic (the editor sends the whole list). */
export async function setMappingsForTopic(
  topicId: string,
  symbols: string[]
): Promise<StockTopicMapping[]> {
  const all = await listMappings()
  const others = all.filter((m) => m.topicId !== topicId)
  const existing = all.filter((m) => m.topicId === topicId)
  const now = new Date().toISOString()

  const next = symbols.map(
    (symbol) =>
      existing.find((m) => m.symbol === symbol) ??
      StockTopicMappingSchema.parse({
        id: randomUUID(),
        topicId,
        symbol,
        weight: 1,
        polarity: 'direct',
        addedAt: now
      })
  )
  const merged = [...others, ...next]
  await writeJsonFile(MAPPINGS, merged)
  return merged
}

export interface TickerValidation {
  ok: boolean
  symbol?: string
  error?: string
}

/** Format-level ticker check (existence-check against Yahoo comes with M6 prices). */
export function validateTicker(raw: string): TickerValidation {
  const symbol = raw.trim().toUpperCase()
  if (!symbol) return { ok: false, error: 'empty' }
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(symbol)) return { ok: false, error: 'invalid symbol' }
  return { ok: true, symbol }
}
