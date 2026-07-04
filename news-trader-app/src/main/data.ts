import { createReadStream, promises as fsp } from 'fs'
import { basename } from 'path'
import { randomUUID } from 'crypto'
import Papa from 'papaparse'
import {
  ArticleSchema,
  DatasetRefSchema,
  type Article,
  type ColumnMapping,
  type DatasetRef
} from '@shared/schema'
import { readJsonFile, writeJsonFile } from './files'

const DATASETS = 'datasets.json'

type Row = Record<string, string>

function toIso(raw: string | undefined): string {
  if (!raw) return ''
  const d = new Date(raw.trim())
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

/** Read headers + a few sample rows for the column-mapping UI. */
export function peekDataset(filePath: string): Promise<{ headers: string[]; rows: Row[] }> {
  return new Promise((resolve, reject) => {
    const rows: Row[] = []
    let headers: string[] = []
    Papa.parse<Row>(createReadStream(filePath, 'utf8'), {
      header: true,
      skipEmptyLines: true,
      step: (res, parser) => {
        if (!headers.length) headers = res.meta.fields ?? []
        rows.push(res.data)
        if (rows.length >= 6) parser.abort()
      },
      complete: () => resolve({ headers, rows }),
      error: (e) => reject(e)
    })
  })
}

export async function listDatasets(): Promise<DatasetRef[]> {
  const raw = await readJsonFile<unknown[]>(DATASETS, [])
  const out: DatasetRef[] = []
  for (const r of raw) {
    const p = DatasetRefSchema.safeParse(r)
    if (p.success) out.push(p.data)
  }
  return out
}

/** Stream the whole CSV once to count rows + find the date range, then register it. */
export function importDataset(
  filePath: string,
  mapping: ColumnMapping,
  name: string,
  source: string
): Promise<DatasetRef> {
  return new Promise((resolve, reject) => {
    let rows = 0
    let from = ''
    let to = ''
    Papa.parse<Row>(createReadStream(filePath, 'utf8'), {
      header: true,
      skipEmptyLines: true,
      step: (res) => {
        rows++
        const iso = toIso(res.data[mapping.date])
        if (iso) {
          if (!from || iso < from) from = iso
          if (!to || iso > to) to = iso
        }
      },
      complete: () => {
        const ref = DatasetRefSchema.parse({
          id: randomUUID(),
          name: name || basename(filePath),
          path: filePath,
          source,
          mapping,
          rows,
          dateFrom: from,
          dateTo: to,
          createdAt: new Date().toISOString()
        })
        listDatasets()
          .then((all) => writeJsonFile(DATASETS, [...all, ref]))
          .then(() => resolve(ref))
          .catch(reject)
      },
      error: (e) => reject(e)
    })
  })
}

/** Map one CSV row to an Article via a dataset's column mapping. */
function rowToArticle(row: Row, ref: DatasetRef): Article {
  const ticker = ref.mapping.ticker ? (row[ref.mapping.ticker] ?? '').trim().toUpperCase() : ''
  return ArticleSchema.parse({
    id: randomUUID(),
    headline: (row[ref.mapping.headline] ?? '').trim(),
    source: ref.source,
    tickersTagged: ticker ? [ticker] : [],
    publishedAt: toIso(row[ref.mapping.date]),
    datasetId: ref.id
  })
}

/** IDs of datasets whose CSV no longer exists on this machine (e.g. after import). */
export async function datasetMissing(): Promise<string[]> {
  const all = await listDatasets()
  const missing: string[] = []
  for (const d of all) {
    try {
      await fsp.access(d.path)
    } catch {
      missing.push(d.id)
    }
  }
  return missing
}

/** Re-point a dataset at a CSV on this machine (used after importing a workspace). */
export async function relocateDataset(id: string, newPath: string): Promise<DatasetRef[]> {
  const all = await listDatasets()
  const idx = all.findIndex((d) => d.id === id)
  if (idx >= 0) {
    all[idx] = { ...all[idx], path: newPath }
    await writeJsonFile(DATASETS, all)
  }
  return all
}

/** Articles in a dataset within [from, to] (date-only), up to `limit` — for backtests. */
export function collectArticles(
  datasetId: string,
  opts: { from?: string; to?: string; limit: number }
): Promise<Article[]> {
  return new Promise((resolve, reject) => {
    listDatasets().then((all) => {
      const ref = all.find((d) => d.id === datasetId)
      if (!ref) return resolve([])
      const from = opts.from ? opts.from.slice(0, 10) : ''
      const to = opts.to ? opts.to.slice(0, 10) : ''
      const out: Article[] = []
      Papa.parse<Row>(createReadStream(ref.path, 'utf8'), {
        header: true,
        skipEmptyLines: true,
        step: (res, parser) => {
          const a = rowToArticle(res.data, ref)
          if (!a.headline || !a.publishedAt) return
          const d = a.publishedAt.slice(0, 10)
          if (from && d < from) return
          if (to && d > to) return
          out.push(a)
          if (out.length >= opts.limit) parser.abort()
        },
        complete: () => resolve(out),
        error: (e) => reject(e)
      })
    }, reject)
  })
}

/** First `n` articles of a dataset (for the review queue + preview). */
export function sampleArticles(datasetId: string, n: number): Promise<Article[]> {
  return new Promise((resolve, reject) => {
    listDatasets().then((all) => {
      const ref = all.find((d) => d.id === datasetId)
      if (!ref) return resolve([])
      const out: Article[] = []
      Papa.parse<Row>(createReadStream(ref.path, 'utf8'), {
        header: true,
        skipEmptyLines: true,
        step: (res, parser) => {
          const a = rowToArticle(res.data, ref)
          if (a.headline) out.push(a)
          if (out.length >= n) parser.abort()
        },
        complete: () => resolve(out),
        error: (e) => reject(e)
      })
    }, reject)
  })
}
