'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'server.log');

let mainWindow = null;
let tray = null;
let serverProc = null;
let isQuitting = false;

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
  const req = http.get(`http://localhost:${port}/api/settings`, () => {
    callback(true);
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
    const serverScript = path.join(__dirname, 'server', 'server.js');

    // Spawn server process
    serverProc = spawn(process.execPath, [serverScript], {
      env: { ...process.env, PORT: String(PORT), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let ready = false;
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
      console.error('Failed to spawn server process:', err);
      dialog.showErrorBox('خطأ في تشغيل الخادم', `تعذر بدء خادم البيانات: ${err.message}`);
    });

    serverProc.on('exit', (code) => {
      if (!isQuitting) {
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
        onReady();
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
    minWidth: 960,
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

  mainWindow.loadURL(`http://localhost:${PORT}`);

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
    if (url.startsWith('http://localhost') || url.includes('/print/')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
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
    createMainWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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
