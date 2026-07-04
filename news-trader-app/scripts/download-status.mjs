// Stream base-model DOWNLOAD progress to the RUNNING tab (the training script only
// writes once it starts stepping, so without this the tab looks frozen during the
// ~15GB download). Exits once the download stops growing (model load begins).
import { writeFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'

const MODELDIR = process.env.NT_BLOBDIR || 'models--Qwen--Qwen2.5-7B-Instruct'
const blobs = join(process.env.USERPROFILE, '.cache', 'huggingface', 'hub', MODELDIR, 'blobs')
const STATUS = join(process.env.APPDATA, 'news-trader-app', 'default-workspace', 'running-status.json')
const TOTAL = Number(process.env.NT_TOTALGB || 15.2) * 1e9
const startedAt = new Date().toISOString()
const size = () => { try { return readdirSync(blobs).reduce((s, f) => { try { return s + statSync(join(blobs, f)).size } catch { return s } }, 0) } catch { return 0 } }

for (;;) {
  const sz = size()
  const frac = Math.min(0.99, sz / TOTAL)
  writeFileSync(STATUS, JSON.stringify({
    active: true, label: 'FINE-TUNING Qwen2.5-7B — preparing', phase: 'downloading base model',
    message: `downloading base model: ${(sz / 1e9).toFixed(2)} / ~15.2 GB (${(frac * 100).toFixed(0)}%)`,
    fraction: frac, trades: 0, accuracy: 0, pnlPct: 0, marketNeutralPct: 0,
    equity: [], feed: [], initialNetWorth: 1, startedAt, updatedAt: new Date().toISOString()
  }))
  console.log(`${new Date().toISOString().slice(11, 19)}  ${(sz / 1e9).toFixed(2)} GB`)
  if (sz > 0.96 * TOTAL) break // download essentially complete -> trainer takes over
  await new Promise((r) => setTimeout(r, 3000))
}
// hand off: show "loading model into GPU" until the training callback takes over
writeFileSync(STATUS, JSON.stringify({ active: true, label: 'FINE-TUNING Qwen2.5-7B — preparing', phase: 'loading model', message: 'download complete — loading model into GPU (4-bit)…', fraction: 1, trades: 0, accuracy: 0, pnlPct: 0, marketNeutralPct: 0, equity: [], feed: [], initialNetWorth: 1, startedAt, updatedAt: new Date().toISOString() }))
console.log('download-status: handing off to trainer')
