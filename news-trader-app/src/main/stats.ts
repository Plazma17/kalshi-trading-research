import { exec } from 'child_process'
import type { BrowserWindow } from 'electron'

export interface GpuStats {
  ok: boolean
  name?: string
  utilization?: number // %
  memUsedMb?: number
  memTotalMb?: number
  tempC?: number
  powerW?: number
  error?: string
}

let timer: ReturnType<typeof setInterval> | null = null

/** One nvidia-smi sample. Returns ok:false if the tool/GPU is unavailable. */
function queryGpu(): Promise<GpuStats> {
  return new Promise((resolve) => {
    exec(
      'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits',
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err) })
        const first = stdout.trim().split('\n')[0] ?? ''
        const c = first.split(',').map((s) => s.trim())
        if (c.length < 6) return resolve({ ok: false, error: 'unexpected nvidia-smi output' })
        resolve({
          ok: true,
          name: c[0],
          utilization: Number(c[1]),
          memUsedMb: Number(c[2]),
          memTotalMb: Number(c[3]),
          tempC: Number(c[4]),
          powerW: Number(c[5])
        })
      }
    )
  })
}

/** Poll the GPU on an interval and push samples to the renderer via `stats:gpu`. */
export function startGpuStats(win: BrowserWindow, intervalMs = 1000): void {
  stopGpuStats()
  const tick = async (): Promise<void> => {
    const s = await queryGpu()
    if (!win.isDestroyed()) win.webContents.send('stats:gpu', s)
  }
  void tick()
  timer = setInterval(() => void tick(), intervalMs)
}

export function stopGpuStats(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
