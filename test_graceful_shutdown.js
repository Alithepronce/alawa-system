'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alawa-shutdown-test-'));
process.env.ALAWA_DATA_DIR = dataDir;
const licenseFile = path.join(dataDir, '.license.json');
const licenseContents = JSON.stringify({ payload: 'signed-test-license', signature: 'test-signature' });
fs.writeFileSync(licenseFile, licenseContents);

const child = spawn(process.execPath, ['server/server.js'], {
  cwd: __dirname,
  env: { ...process.env, ALAWA_DATA_DIR: dataDir, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc']
});

let sentShutdown = false;
let backupFile = '';
let stderr = '';
const timeout = setTimeout(() => child.kill(), 12000);
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
child.stdout.on('data', chunk => {
  if (!sentShutdown && chunk.toString().includes('server is running')) {
    sentShutdown = true;
    child.send({ type: 'shutdown' });
  }
});
child.on('message', message => {
  if (message?.type === 'shutdown-complete') backupFile = message.backupFile;
  if (message?.type === 'shutdown-failed') child.kill();
});

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  try {
    assert.equal(code, 0, `server did not exit cleanly (${signal || code}): ${stderr}`);
    assert.ok(backupFile, 'server did not confirm a completed backup');
    const backupPath = path.join(dataDir, 'backups', backupFile);
    const licenseCopyPath = backupPath.replace(/\.db$/, '.license.json');
    assert.ok(fs.existsSync(backupPath), 'database backup was not created');
    assert.equal(fs.readFileSync(licenseCopyPath, 'utf8'), licenseContents, 'license was not included in shutdown backup');
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try { assert.equal(backupDb.prepare('PRAGMA integrity_check;').get().integrity_check, 'ok'); }
    finally { backupDb.close(); }
    const updater = require('./server/updater');
    const preUpdate = updater.createPreUpdateBackup();
    const preUpdateLicense = path.join(dataDir, 'pre_update_backups', `${preUpdate.backupFileName}.license.json`);
    assert.equal(fs.readFileSync(preUpdateLicense, 'utf8'), licenseContents, 'pre-update backup did not preserve the license');
    require('./server/db').close();
    console.log('Graceful shutdown, database integrity, and license backup checks passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
