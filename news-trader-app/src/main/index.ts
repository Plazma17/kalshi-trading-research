import { app, shell, BrowserWindow, session, Menu } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { startGpuStats, stopGpuStats } from './stats'
import { getOrInitCurrentWorkspace } from './workspace'
import { getSettings } from './state'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

/**
 * Content-Security-Policy via response headers (not a meta tag): strict in
 * production, relaxed in dev so Vite's inline HMR/refresh scripts work. The
 * renderer never loads remote content — all network goes through the main process.
 */
function installCsp(): void {
  const policy = isDev
    ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: ws: http://localhost:*"
    : "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } })
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'news-trader',
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    startGpuStats(win)
  })

  // Scale the whole UI per the user's zoom setting (terminal density, bigger).
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(getSettings().zoom))
  win.on('closed', () => stopGpuStats())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file in prod.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null) // terminal-style: no File/Edit/View menu bar
  await getOrInitCurrentWorkspace() // load settings before the window/classify can run
  installCsp()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
