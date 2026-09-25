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
let backendStopped = false;
let quitFlowStarted = false;
let closePromptOpen = false;
let shutdownPromise = null;
let backendRestartTimer = null;

// Download new releases in the background; installing still requires the owner's approval after a backup.
autoUpdater.autoDownload = true;
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
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('updates:download', async () => {
  if (!app.isPackaged || process.platform !== 'win32') throw new Error('التنزيل متاح في نسخة Windows المثبتة فقط');
  await autoUpdater.downloadUpdate();
  return { ok: true };
});
ipcMain.handle('updates:install', () => {
  if (!updateDownloaded) throw new Error('لم يكتمل تنزيل التحديث بعد');
  return requestSafeQuit({ forUpdate: true }).then(ok => {
    if (!ok) throw new Error('تعذر إغلاق قاعدة البيانات بأمان؛ أُوقف التحديث لحماية بياناتك.');
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
});

function stopBackendGracefully() {
  const child = serverProc;
  if (backendStopped || !child || child.exitCode !== null || child.signalCode) {
    backendStopped = true;
    return Promise.resolve({ ok: true });
  }
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = new Promise(resolve => {
    let settled = false;
    let receivedCompletion = false;
    const timer = setTimeout(() => {
      try { if (child.exitCode === null) child.kill(); } catch (_) {}
      finish({ ok: false, error: 'انتهت مهلة الإغلاق الآمن للخادم.' });
    }, 15000);
    timer.unref();

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.ok) backendStopped = true;
      else shutdownPromise = null;
      resolve(result);
    };

    child.on('message', message => {
      if (message?.type === 'shutdown-complete') receivedCompletion = true;
      if (message?.type === 'shutdown-failed') finish({ ok: false, error: message.error || 'فشلت النسخة الاحتياطية قبل الإغلاق.' });
    });
    child.once('exit', code => {
      if (serverProc === child) serverProc = null;
      if (receivedCompletion && code === 0) finish({ ok: true });
      else finish({ ok: false, error: 'أُغلق خادم البيانات دون تأكيد اكتمال الحفظ والنسخة الاحتياطية.' });
    });

    if (!child.connected) {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, error: 'تعذر التواصل مع خادم البيانات لإغلاقه بأمان.' });
      return;
    }
    child.send({ type: 'shutdown' }, error => {
      if (error) {
        try { child.kill(); } catch (_) {}
        finish({ ok: false, error: 'تعذر إرسال طلب الإغلاق الآمن لخادم البيانات.' });
      }
    });
  });
  return shutdownPromise;
}

async function requestSafeQuit({ forUpdate = false } = {}) {
  if (quitFlowStarted) return backendStopped;
  quitFlowStarted = true;
  isQuitting = true;
  if (backendRestartTimer) { clearTimeout(backendRestartTimer); backendRestartTimer = null; }
  const result = await stopBackendGracefully();
  if (!result.ok) {
    isQuitting = false;
    quitFlowStarted = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'error',
      title: 'تعذر الإغلاق الآمن',
      message: 'لم يتم إغلاق البرنامج حتى الآن لحماية بياناتك.',
      detail: `${result.error}\nتحقق من مساحة القرص ثم حاول الإغلاق مرة أخرى.` ,
      buttons: ['حسنًا']
    });
    return false;
  }
  if (forUpdate) return true;
  if (tray) { tray.destroy(); tray = null; }
  app.quit();
  return true;
}

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
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    backendStopped = false;
    shutdownPromise = null;

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
        backendRestartTimer = setTimeout(() => {
          backendRestartTimer = null;
          if (!isQuitting) startBackendServer(() => {});
        }, 2000);
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
    }, 20000);
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

  // Ask explicitly whether to keep the tray process running or safely exit.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      if (closePromptOpen) return;
      closePromptOpen = true;
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'إغلاق نظام العلوة',
        message: 'هل تريد إغلاق البرنامج بالكامل؟',
        detail: 'سيتم حفظ قاعدة البيانات وإنشاء نسخة احتياطية قبل الإغلاق. يمكنك اختيار الإخفاء لإبقائه يعمل في جوار الساعة.',
        buttons: ['حفظ وإغلاق بأمان', 'إخفاء إلى جوار الساعة', 'إلغاء'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      }).then(({ response }) => {
        closePromptOpen = false;
        if (response === 0) requestSafeQuit();
        else if (response === 1 && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      }).catch(() => { closePromptOpen = false; });
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
    { label: 'إخفاء إلى جوار الساعة', click: () => { if (mainWindow) mainWindow.hide(); } },
    { type: 'separator' },
    {
      label: 'حفظ وإغلاق البرنامج بأمان',
      click: () => requestSafeQuit()
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

app.on('before-quit', (event) => {
  if (serverProc && !backendStopped && serverProc.exitCode === null) {
    event.preventDefault();
    requestSafeQuit();
    return;
  }
  isQuitting = true;
});

app.on('session-end', () => {
  isQuitting = true;
  if (serverProc?.connected) {
    try { serverProc.send({ type: 'shutdown' }); } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray unless explicit quit
  }
});
