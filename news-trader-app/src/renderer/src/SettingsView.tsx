import { useEffect, useState } from 'react'
import type { Settings } from '@shared/schema'
import type { WorkspaceState } from './env'

const FIELDS: { key: keyof Settings; label: string; type: 'text' | 'number' }[] = [
  { key: 'ollamaHost', label: 'OLLAMA HOST', type: 'text' },
  { key: 'model', label: 'MODEL', type: 'text' },
  { key: 'keepAlive', label: 'KEEP MODEL LOADED', type: 'text' },
  { key: 'numParallel', label: 'PARALLEL REQUESTS', type: 'number' },
  { key: 'defaultHorizonDays', label: 'DEFAULT BACKTEST HORIZON (DAYS)', type: 'number' },
  { key: 'defaultTransactionCostBps', label: 'TRANSACTION COST (BASIS POINTS)', type: 'number' },
  { key: 'datasetRoot', label: 'DATASET FOLDER (BIG DATA, KEPT OUTSIDE WORKSPACE)', type: 'text' }
]

export default function SettingsView(): JSX.Element {
  const [ws, setWs] = useState<WorkspaceState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [flash, setFlash] = useState('')

  useEffect(() => {
    window.api.workspaceCurrent().then((w) => {
      setWs(w)
      setSettings(w.settings)
    })
  }, [])

  function note(msg: string): void {
    setFlash(msg)
    setTimeout(() => setFlash(''), 1500)
  }

  function adopt(w: WorkspaceState | null, msg: string): void {
    if (!w) return
    setWs(w)
    setSettings(w.settings)
    note(msg)
  }

  async function save(partial: Partial<Settings>): Promise<void> {
    const next = await window.api.settingsUpdate(partial)
    setSettings(next)
    note('saved')
  }

  function setTheme(theme: string): void {
    document.documentElement.dataset.theme = theme // apply live
    void save({ theme })
  }

  function bumpZoom(delta: number): void {
    if (!settings) return
    const next = Math.round(Math.min(3, Math.max(0.5, settings.zoom + delta)) * 100) / 100
    void save({ zoom: next }) // main applies setZoomFactor live on update
  }

  if (!ws || !settings) return <div className="body dim">loading workspace…</div>

  return (
    <div className="body">
      <div className="lbl block">WORKSPACE</div>
      <div className="kv">
        <span className="k">NAME</span>
        <span>{ws.manifest.name}</span>
      </div>
      <div className="kv">
        <span className="k">PATH</span>
        <span className="path">{ws.dir}</span>
      </div>
      <div className="kv">
        <span className="k">ID</span>
        <span className="dim">{ws.manifest.workspaceId}</span>
      </div>

      <div className="wsbtns">
        <button className="ghost" onClick={async () => adopt(await window.api.workspaceCreate(), 'created')}>
          NEW
        </button>
        <button className="ghost" onClick={async () => adopt(await window.api.workspaceOpen(), 'opened')}>
          OPEN
        </button>
        <button
          className="ghost"
          onClick={async () => {
            const p = await window.api.workspaceExport()
            if (p) note('exported')
          }}
        >
          EXPORT ZIP
        </button>
        <button className="ghost" onClick={async () => adopt(await window.api.workspaceImport(), 'imported')}>
          IMPORT ZIP
        </button>
        {flash && <span className="ok flash">{flash}</span>}
      </div>

      <div className="lbl block mt">DISPLAY</div>
      <div className="settings">
        <div className="field">
          <span className="k">THEME</span>
          <button
            className={settings.theme === 'night' ? 'ghost' : ''}
            onClick={() => setTheme('dark')}
          >
            TERMINAL
          </button>
          <button
            className={settings.theme === 'night' ? '' : 'ghost'}
            onClick={() => setTheme('night')}
          >
            NIGHT (DIM)
          </button>
          <span className="dim small">all-gray low-brightness — readable in the dark</span>
        </div>
        <div className="field">
          <span className="k">UI SIZE</span>
          <button onClick={() => bumpZoom(-0.1)} disabled={settings.zoom <= 0.5}>
            –
          </button>
          <span className="ovr" style={{ minWidth: 64, textAlign: 'center' }}>
            {Math.round(settings.zoom * 100)}%
          </span>
          <button onClick={() => bumpZoom(0.1)} disabled={settings.zoom >= 3}>
            +
          </button>
          <span className="dim small">scales all text &amp; UI elements</span>
        </div>
      </div>

      <div className="lbl block mt">SETTINGS</div>
      <div className="settings">
        {FIELDS.map((f) => (
          <label className="field" key={f.key}>
            <span className="k">{f.label}</span>
            <input
              type={f.type}
              value={String(settings[f.key] ?? '')}
              spellCheck={false}
              onChange={(e) => {
                const v = f.type === 'number' ? Number(e.target.value) : e.target.value
                setSettings({ ...settings, [f.key]: v } as Settings)
              }}
              onBlur={(e) => {
                const v = f.type === 'number' ? Number(e.target.value) : e.target.value
                save({ [f.key]: v } as Partial<Settings>)
              }}
            />
          </label>
        ))}
      </div>
      <div className="dim mt note">
        Settings live in this workspace&apos;s settings.json. Host &amp; dataset folder are
        machine-local and re-resolved when a workspace is imported on another computer.
      </div>
    </div>
  )
}
