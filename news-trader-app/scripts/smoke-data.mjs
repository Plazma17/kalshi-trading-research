// Verify the CSV streaming pipeline (peek headers, count rows + date range, sample
// rows -> articles) the way main/data.ts does, using the same papaparse.
import { createReadStream } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, 'sample-news.csv')
const toIso = (s) => {
  const d = new Date((s || '').trim())
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

function peek() {
  return new Promise((resolve, reject) => {
    const rows = []
    let headers = []
    Papa.parse(createReadStream(file, 'utf8'), {
      header: true,
      skipEmptyLines: true,
      step: (res, parser) => {
        if (!headers.length) headers = res.meta.fields ?? []
        rows.push(res.data)
        if (rows.length >= 3) parser.abort()
      },
      complete: () => resolve({ headers, rows }),
      error: reject
    })
  })
}

function stats(mapping) {
  return new Promise((resolve, reject) => {
    let rows = 0
    let from = ''
    let to = ''
    Papa.parse(createReadStream(file, 'utf8'), {
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
      complete: () => resolve({ rows, from, to }),
      error: reject
    })
  })
}

const p = await peek()
console.log('headers:', p.headers.join(', '))
console.log('sample row 1:', JSON.stringify(p.rows[0]))
const s = await stats({ date: 'date' })
console.log(`rows=${s.rows}  from=${s.from.slice(0, 10)}  to=${s.to.slice(0, 10)}`)
