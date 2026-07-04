/**
 * Topic (a universe "box") and StockTopicMapping (a many-to-many edge: a topic
 * has many tickers; a ticker can live in many topics). The classifier emits a
 * `topic` string per signal; the Topic.label is what those strings map to, and
 * the mappings expand a topic into tradeable symbols for the backtest.
 */
import { z } from 'zod'

export const Polarity = z.enum(['direct', 'inverse'])
export type Polarity = z.infer<typeof Polarity>

export const TopicSchema = z.object({
  id: z.string(),
  label: z.string(), // short lowercase key matching classifier topic strings, e.g. "oil"
  displayName: z.string().default(''),
  color: z.string().default('#2563eb'),
  description: z.string().default(''),
  // direct: topic-up => tickers up. inverse: for inverse-ETF boxes.
  directionPolarity: Polarity.default('direct'),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Topic = z.infer<typeof TopicSchema>

export const StockTopicMappingSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  symbol: z.string(),
  weight: z.number().default(1),
  polarity: Polarity.default('direct'), // per-edge override (e.g. a hedge in a box)
  addedAt: z.string()
})
export type StockTopicMapping = z.infer<typeof StockTopicMappingSchema>
