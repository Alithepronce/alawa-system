'use strict';
const os = require('node:os');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

function getMachineFingerprint() {
  const signals = [];

  // 1. MAC addresses
  try {
    const nets = os.networkInterfaces();
    for (const ifaces of Object.values(nets)) {
      for (const iface of ifaces) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          signals.push('mac:' + iface.mac.toLowerCase());
        }
      }
    }
  } catch (_) {}

  // 2. CPU model and core count
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length) {
      signals.push('cpu:' + cpus[0].model.trim() + ':' + cpus.length);
    }
  } catch (_) {}

  // 3. Machine hostname
  try {
    signals.push('host:' + os.hostname().toLowerCase());
  } catch (_) {}

  // 4. Windows Hardware UUID / Motherboard Serial
  if (process.platform === 'win32') {
    try {
      const uuid = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', {
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).toString().trim();
      if (uuid && uuid.length > 5) {
        signals.push('uuid:' + uuid.toLowerCase());
      }
    } catch (_) {
      try {
        const bios = execSync('wmic bios get serialnumber /value', {
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore']
        }).toString().match(/SerialNumber=(.+)/i)?.[1]?.trim();
        if (bios && bios !== 'To Be Filled By O.E.M.') {
          signals.push('bios:' + bios);
        }
      } catch (_) {}
    }
  }

  // Generate SHA-256 fingerprint from hardware signals
  const raw = signals.sort().join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { getMachineFingerprint };
