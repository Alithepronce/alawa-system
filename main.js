'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = process.env.PORT || 3000;
// userData is writable after installation, unlike the files inside app.asar.
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const LOG_FILE = path.join(DATA_DIR, 'server.log');

let mainWindow = null;
let tray = null;
let serverProc = null;
let isQuitting = false;
let backendReady = false;
let updateDownloaded = false;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:status', status);
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
autoUpdater.on('update-available', info => sendUpdateStatus({ state: 'available', version: info.version, releaseNotes: info.releaseNotes || '' }));
autoUpdater.on('update-not-available', info => sendUpdateStatus({ state: 'not-available', version: info.version }));
autoUpdater.on('download-progress', progress => sendUpdateStatus({ state: 'progress', percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total }));
autoUpdater.on('update-downloaded', info => { updateDownloaded = true; sendUpdateStatus({ state: 'downloaded', version: info.version }); });
autoUpdater.on('error', error => sendUpdateStatus({ state: 'error', message: error.message }));

ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged || process.platform !== 'win32') throw new Error('التحديث التلقائي متاح في نسخة Windows المثبتة فقط');
  const result = await autoUpdater.checkForUpdates();
  return { version: result?.updateInfo?.version || null };
});
ipcMain.handle('updates:download', async () => {
  if (!app.isPackaged || process.platform !== 'win32') throw new Error('التنزيل متاح في نسخة Windows المثبتة فقط');
  await autoUpdater.downloadUpdate();
  return { ok: true };
});
ipcMain.handle('updates:install', () => {
  if (!updateDownloaded) throw new Error('لم يكتمل تنزيل التحديث بعد');
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function checkServerRunning(port, callback) {
  const req = http.get(`http://127.0.0.1:${port}/api/settings`, (res) => {
    callback(res.headers['x-alawa-system'] === 'desktop');
  });
  req.on('error', () => {
    callback(false);
  });
  req.setTimeout(800, () => {
    req.destroy();
    callback(false);
  });
}

function startBackendServer(onReady) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Check if server is already running on this port
  checkServerRunning(PORT, (running) => {
    if (running) {
      console.log(`Backend server already active on port ${PORT}`);
      onReady();
      return;
    }

    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const sourceRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : __dirname;
    const serverScript = path.join(sourceRoot, 'server', 'server.js');

    // Detect Node 22.5+ (required for built-in node:sqlite) or use Electron's Node runtime.
    let runtimeBinary = process.execPath;
    let isElectronRuntime = true;
    try {
      const { execFileSync } = require('node:child_process');
      const version = execFileSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const [major, minor] = version.split('.').map(Number);
      if (major > 22 || (major === 22 && minor >= 5)) { runtimeBinary = 'node'; isElectronRuntime = false; }
    } catch (_) {
      runtimeBinary = process.execPath;
    }

    // Spawn server process
    serverProc = spawn(runtimeBinary, [serverScript], {
      env: {
        ...process.env,
        PORT: String(PORT),
        ...(isElectronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ALAWA_DATA_DIR: DATA_DIR,
        ALAWA_APP_VERSION: app.getVersion()
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let ready = false;
    let startupFailed = false;
    serverProc.stdout.pipe(logStream);
    serverProc.stderr.pipe(logStream);

    serverProc.stdout.on('data', (chunk) => {
      const msg = chunk.toString();
      if (!ready && (msg.includes('server is running') || msg.includes('localhost:'))) {
        ready = true;
        onReady();
      }
    });

    serverProc.on('error', (err) => {
      startupFailed = true;
      console.error('Failed to spawn server process:', err);
      dialog.showErrorBox('خطأ في تشغيل الخادم', `تعذر بدء خادم البيانات: ${err.message}`);
    });

    serverProc.on('exit', (code) => {
      if (!isQuitting && !startupFailed) {
        console.warn(`Server exited with code ${code}. Restarting in 2 seconds...`);
        setTimeout(() => startBackendServer(() => {}), 2000);
      }
    });

    // Fallback: poll until server responds
    const pollInterval = setInterval(() => {
      if (ready) {
        clearInterval(pollInterval);
        return;
      }
      checkServerRunning(PORT, (isUp) => {
        if (isUp && !ready) {
          ready = true;
          clearInterval(pollInterval);
          onReady();
        }
      });
    }, 400);

    setTimeout(() => {
      clearInterval(pollInterval);
      if (!ready) {
        ready = true;
        startupFailed = true;
        dialog.showErrorBox('تعذر تشغيل النظام', `لم يبدأ خادم البيانات خلال المهلة. راجع سجل التشغيل: ${LOG_FILE}`);
        if (serverProc && !serverProc.killed) serverProc.kill();
      }
    }, 4000);
  });
}

function createMainWindow() {
  const iconFile = fs.existsSync(path.join(__dirname, 'assets', 'icon.ico'))
    ? path.join(__dirname, 'assets', 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 720,
    minHeight: 640,
    title: 'نظام إدارة العلوة — منظومة زمام',
    icon: fs.existsSync(iconFile) ? iconFile : undefined,
    backgroundColor: '#F5F2EE',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: !app.isPackaged
    },
    autoHideMenuBar: true
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Handle close to hide or quit
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // External links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === `http://127.0.0.1:${PORT}`) return { action: 'allow' };
      if (['https:', 'http:'].includes(target.protocol)) shell.openExternal(target.href);
    } catch (_) {}
    return { action: 'deny' };
  });

  setupTray();
}

function setupTray() {
  if (tray) return;

  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('نظام إدارة العلوة');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'فتح النظام', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    {
      label: 'إغلاق البرنامج كلياً',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  startBackendServer(() => {
    backendReady = true;
    createMainWindow();
  });

  app.on('activate', () => {
    if (backendReady && BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProc) {
    try {
      serverProc.kill('SIGINT');
    } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray unless explicit quit
  }
});
