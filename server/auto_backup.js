'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const DATA_DIR = require('./data-path');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'alawa.db');
const MAX_BACKUPS = 15;

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function getTimestamp() {
  const d = new Date();
  const yr = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const hr = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const se = pad(d.getSeconds());
  return `${yr}-${mo}-${da}_${hr}-${mi}-${se}`;
}

function cleanOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('alawa_backup_') && f.endsWith('.db'))
      .map(f => {
        const full = path.join(BACKUP_DIR, f);
        return { name: f, path: full, time: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.time - a.time);

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      for (const item of toDelete) {
        fs.unlinkSync(item.path);
        console.log(`  Auto-backup: pruned old backup ${item.name}`);
      }
    }
  } catch (err) {
    console.error('  Failed to prune old backups:', err.message);
  }
}

function createBackup() {
  try {
    if (!fs.existsSync(DB_PATH)) return null;

    // Checkpoint WAL to flush all transactions into main database file
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (_) {}

    const filename = `alawa_backup_${getTimestamp()}.db`;
    const targetPath = path.join(BACKUP_DIR, filename);

    fs.copyFileSync(DB_PATH, targetPath);
    const stats = fs.statSync(targetPath);

    cleanOldBackups();

    return {
      filename,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('  Auto-backup error:', err);
    throw err;
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('alawa_backup_') && f.endsWith('.db'))
      .map(f => {
        const full = path.join(BACKUP_DIR, f);
        const st = fs.statSync(full);
        return {
          filename: f,
          sizeBytes: st.size,
          mtime: st.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  } catch (err) {
    return [];
  }
}

// Auto-run backup on startup after 5 seconds, then every 6 hours
setTimeout(() => {
  try {
    const res = createBackup();
    if (res) console.log(`  Auto-backup created: ${res.filename} (${(res.sizeBytes / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.error('  Startup auto-backup failed:', e.message);
  }
}, 5000).unref();

setInterval(() => {
  try {
    createBackup();
  } catch (e) {
    console.error('  Scheduled auto-backup failed:', e.message);
  }
}, 6 * 60 * 60 * 1000).unref();

module.exports = {
  createBackup,
  listBackups
};
