'use strict';
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, execSync } = require('node:child_process');
let cachedFingerprint;
let cachedLegacyFingerprint;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function usableHardwareId(value) {
  const normalized = String(value || '').trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized.length < 8 || /^0+$/.test(normalized) || /^f+$/.test(normalized)) return '';
  if (/^(tobefilledbyoem|defaultstring|unknown|none|null)$/.test(normalized)) return '';
  return normalized;
}

function readWindowsHardwareUuid() {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID'
    ], { timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const candidate = output.split(/\r?\n/).map(line => line.trim()).find(line => usableHardwareId(line));
    if (candidate) return usableHardwareId(candidate);
  } catch (_) {}
  return '';
}

function readWindowsMachineGuid() {
  try {
    const output = execFileSync('reg.exe', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
    ], { timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    return match ? usableHardwareId(match[1]) : '';
  } catch (_) {
    return '';
  }
}

// Stable Windows identity: do not include NICs, hostname, or CPU, because they
// can change after driver/VPN/network updates or Windows configuration changes.
function getMachineFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  if (process.platform === 'win32') {
    const hardwareUuid = readWindowsHardwareUuid();
    if (hardwareUuid) return (cachedFingerprint = hash(`alawa-device-v2|windows|hardware-uuid:${hardwareUuid}`));
    const machineGuid = readWindowsMachineGuid();
    if (machineGuid) return (cachedFingerprint = hash(`alawa-device-v2|windows|machine-guid:${machineGuid}`));
  }
  return (cachedFingerprint = getLegacyMachineFingerprint());
}

// Retained only so licenses created by older releases remain valid when their
// original composite identity is still unchanged on the same machine.
function getLegacyMachineFingerprint() {
  if (cachedLegacyFingerprint) return cachedLegacyFingerprint;
  const signals = [];
  try {
    const nets = os.networkInterfaces();
    for (const ifaces of Object.values(nets)) {
      for (const iface of ifaces || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          signals.push('mac:' + iface.mac.toLowerCase());
        }
      }
    }
  } catch (_) {}
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length) signals.push('cpu:' + cpus[0].model.trim() + ':' + cpus.length);
  } catch (_) {}
  try { signals.push('host:' + os.hostname().toLowerCase()); } catch (_) {}
  if (process.platform === 'win32') {
    try {
      const uuid = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', {
        timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      }).toString().trim();
      if (uuid && uuid.length > 5) signals.push('uuid:' + uuid.toLowerCase());
    } catch (_) {
      try {
        const bios = execSync('wmic bios get serialnumber /value', {
          timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
        }).toString().match(/SerialNumber=(.+)/i)?.[1]?.trim();
        if (bios && bios !== 'To Be Filled By O.E.M.') signals.push('bios:' + bios);
      } catch (_) {}
    }
  }
  return (cachedLegacyFingerprint = hash(signals.sort().join('|')));
}

module.exports = { getMachineFingerprint, getLegacyMachineFingerprint };
