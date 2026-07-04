/**
 * Dataset entities. A DatasetRef points at an external CSV (kept OUT of the
 * workspace — it can be millions of rows) plus the column mapping needed to read
 * it as Articles. Articles are the normalized unit the classifier/backtest consume.
 */
import { z } from 'zod'

export const ColumnMappingSchema = z.object({
  headline: z.string(),
  date: z.string(),
  ticker: z.string().default('') // optional column
})
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>

export const DatasetRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(), // original CSV path (machine-local)
  source: z.string().default(''),
  mapping: ColumnMappingSchema,
  rows: z.number().default(0),
  dateFrom: z.string().default(''),
  dateTo: z.string().default(''),
  createdAt: z.string()
})
export type DatasetRef = z.infer<typeof DatasetRefSchema>

export const ArticleSchema = z.object({
  id: z.string(),
  headline: z.string(),
  body: z.string().default(''),
  source: z.string().default(''),
  tickersTagged: z.array(z.string()).default([]),
  publishedAt: z.string(), // ISO-8601
  datasetId: z.string().default('')
})
export type Article = z.infer<typeof ArticleSchema>
