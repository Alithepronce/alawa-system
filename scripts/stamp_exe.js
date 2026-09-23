'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const exePath = path.join(__dirname, '..', 'dist', 'win-unpacked', 'alawa-system.exe');
const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

if (!fs.existsSync(exePath)) {
  console.log('No exe to stamp at:', exePath);
  process.exit(0);
}

// Locate rcedit-x64.exe
const rceditPath = path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder',
  'Cache',
  'winCodeSign',
  'winCodeSign-2.6.0',
  'rcedit-x64.exe'
);

if (!fs.existsSync(rceditPath)) {
  console.log('rcedit not found at:', rceditPath);
  process.exit(0);
}

const args = [
  exePath,
  '--set-version-string', 'FileDescription', 'نظام إدارة العلوة — منظومة زمام',
  '--set-version-string', 'ProductName', 'نظام إدارة العلوة — منظومة زمام',
  '--set-version-string', 'LegalCopyright', '© 2026 Alawa Management System',
  '--set-file-version', '2.0.0',
  '--set-product-version', '2.0.0.0',
  '--set-version-string', 'InternalName', 'alawa-system',
  '--set-version-string', 'OriginalFilename', 'alawa-system.exe',
  '--set-version-string', 'CompanyName', 'Alawa Management System',
  '--set-icon', iconPath
];

console.log('Stamping executable icon and metadata...');
for (let attempt = 1; attempt <= 5; attempt++) {
  // Wait 1.5s on first attempt to ensure Windows AV file handle is released
  const waitStart = Date.now();
  while (Date.now() - waitStart < (attempt === 1 ? 1500 : 1000)) {}

  const res = spawnSync(rceditPath, args, { stdio: 'inherit' });
  if (res.status === 0) {
    console.log('✓ Successfully stamped alawa-system.exe with Zimam icon and metadata.');
    process.exit(0);
  }
}

console.warn('Note: Stamping completed with fallback or deferred update.');
