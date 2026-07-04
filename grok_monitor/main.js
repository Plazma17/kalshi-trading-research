// GROK MONITOR — standalone Electron status window for the local NN training run.
// Reuses the dashboard's Electron runtime. Isolated userData so it can't collide
// with the CTA dashboard singleton. Reads ..\grok\ (read-only) via the renderer.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// crash logging -> file (Electron swallows main-process errors into a GUI dialog)
const CRASHLOG = path.join(__dirname, '_crash.log');
function clog(m){ try{ fs.appendFileSync(CRASHLOG, `[${new Date().toISOString()}] ${m}\n`); }catch(e){} }
process.on('uncaughtException', e=>{ clog('uncaughtException: '+(e&&e.stack||e)); });
process.on('unhandledRejection', e=>{ clog('unhandledRejection: '+(e&&e.stack||e)); });
clog('main.js start');

// Custom userData dir so this can NEVER touch/steal the CTA dashboard singleton lock.
app.setPath('userData', path.join(__dirname, '.userdata'));
app.setName('grok-monitor');
// Extra safety: never join an existing single-instance of another app.
app.disableHardwareAcceleration();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'GROK MONITOR',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  // Self-check screenshot ~10s after load so a parent process can verify render.
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'selfcheck.png'), img.toPNG());
      } catch (e) { /* non-fatal */ }
    }, 10000);
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
