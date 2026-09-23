'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const db = require('./db');
const { HttpError, requireRole, logActivity } = require('./helpers');

// package.json stays inside app.asar in the desktop build, while this server
// is unpacked so Electron can launch it as a separate process.
const APP_VERSION = process.env.ALAWA_APP_VERSION || '2.0.0';
const GITHUB_REPO = 'Alithepronce/alawa-system';
const DATA_DIR = require('./data-path');
const DB_PATH = path.join(DATA_DIR, 'alawa.db');
const LICENSE_PATH = path.join(DATA_DIR, '.license');
const PRE_UPDATE_DIR = path.join(DATA_DIR, 'pre_update_backups');

/**
 * Execute WAL checkpoint and create an emergency verified pre-update backup.
 * Throws HttpError if integrity check fails.
 */
function createPreUpdateBackup() {
  if (!fs.existsSync(PRE_UPDATE_DIR)) {
    fs.mkdirSync(PRE_UPDATE_DIR, { recursive: true });
  }

  // 1. Force WAL checkpoint to flush all data to the main db file
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (err) {
    console.error('WAL checkpoint warning prior to backup:', err.message);
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backupFileName = `alawa_pre_update_v${APP_VERSION}_${stamp}.db`;
  const backupPath = path.join(PRE_UPDATE_DIR, backupFileName);

  // 2. Perform copy of the database
  fs.copyFileSync(DB_PATH, backupPath);

  // 3. Backup license if present
  if (fs.existsSync(LICENSE_PATH)) {
    const licBackup = path.join(PRE_UPDATE_DIR, `.license_${stamp}`);
    fs.copyFileSync(LICENSE_PATH, licBackup);
  }

  // 4. Verify integrity of the newly created backup file
  try {
    const { DatabaseSync } = require('node:sqlite');
    const backupDb = new DatabaseSync(backupPath);
    const result = backupDb.prepare('PRAGMA integrity_check;').get();
    backupDb.close();

    if (!result || result.integrity_check !== 'ok') {
      fs.unlinkSync(backupPath);
      throw new Error('فشل فحص سلامة النسخة الاحتياطية (PRAGMA integrity_check failed)');
    }
  } catch (err) {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    throw new HttpError(500, `تم إلغاء التحديث لحماية البيانات: فشل التحقق من سلامة النسخة الاحتياطية (${err.message})`);
  }

  return {
    backupFileName,
    backupPath,
    timestamp: now.toISOString()
  };
}

/**
 * Check for newer releases on GitHub
 */
async function checkUpdate(ctx) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: {
        'User-Agent': 'Alawa-System-Updater/' + APP_VERSION,
        'Accept': 'application/vnd.github.v3+json'
      },
      timeout: 6000
    };

    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            const latestTag = (release.tag_name || '').replace(/^v/, '');
            const hasUpdate = isNewerVersion(latestTag, APP_VERSION);
            resolve({
              data: {
                currentVersion: APP_VERSION,
                latestVersion: latestTag || APP_VERSION,
                hasUpdate,
                releaseName: release.name || `إصدار ${latestTag}`,
                releaseNotes: release.body || 'تحسينات في الأداء والأمان ودعم منظومة زمام',
                publishedAt: release.published_at,
                downloadUrl: release.html_url
              }
            });
          } catch (e) {
            resolve({
              data: {
                currentVersion: APP_VERSION,
                latestVersion: APP_VERSION,
                hasUpdate: false,
                message: 'النظام يعمل بآخر إصدار مستقر'
              }
            });
          }
        } else {
          // If repo has no releases yet or rate limited
          resolve({
            data: {
              currentVersion: APP_VERSION,
              latestVersion: APP_VERSION,
              hasUpdate: false,
              message: 'النظام يعمل بأحدث إصدار متوفر حالياً'
            }
          });
        }
      });
    });

    req.on('error', () => {
      resolve({
        data: {
          currentVersion: APP_VERSION,
          latestVersion: APP_VERSION,
          hasUpdate: false,
          message: 'تعذر الاتصال بخادم التحديثات (تأكد من اتصال الإنترنت)'
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        data: {
          currentVersion: APP_VERSION,
          latestVersion: APP_VERSION,
          hasUpdate: false,
          message: 'انتهت مهلة الاتصال بخادم التحديثات'
        }
      });
    });
  });
}

/**
 * Compare two semver strings (v1 > v2)
 */
function isNewerVersion(vLatest, vCurrent) {
  if (!vLatest) return false;
  const p1 = vLatest.split('.').map(n => parseInt(n, 10) || 0);
  const p2 = vCurrent.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

/**
 * Apply update with mandatory pre-update verified backup
 */
function applyUpdate(ctx) {
  requireRole(ctx, ['المالك']);

  // STEP 1: MUST create verified pre-update backup
  const backup = createPreUpdateBackup();

  // STEP 2: Log the safety event
  logActivity(ctx, 'تحديث النظام', `تم تأمين نسخة احتياطية في: ${backup.backupFileName}`);

  return {
    data: {
      ok: true,
      backupFile: backup.backupFileName,
      currentVersion: APP_VERSION,
      message: `تم فحص البيانات وإنشاء نسخة أمان (${backup.backupFileName}). لم يُثبّت تحديث؛ نزّل المثبت الجديد من صفحة الإصدار.`
    }
  };
}

module.exports = {
  checkUpdate,
  applyUpdate,
  createPreUpdateBackup,
  APP_VERSION
};
