'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getMachineFingerprint } = require('./machine');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LICENSE_FILE = path.join(DATA_DIR, '.license');
const LICENSE_SECRET = process.env.ALAWA_LICENSE_SECRET || 'ALAWA-POS-SECURE-HARDWARE-LOCK-2026-KEY';

function activateLicense() {
  const fingerprint = getMachineFingerprint();
  const signature = crypto.createHmac('sha256', LICENSE_SECRET).update(fingerprint).digest('hex');
  const licenseData = {
    fingerprint,
    signature,
    activatedAt: new Date().toISOString(),
    system: 'Alawa Management System'
  };

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2), 'utf8');
  return { ok: true, fingerprint };
}

function verifyLicense() {
  if (!fs.existsSync(LICENSE_FILE)) {
    return { valid: false, reason: 'NOT_FOUND' };
  }

  try {
    const raw = fs.readFileSync(LICENSE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const expectedSig = crypto.createHmac('sha256', LICENSE_SECRET).update(data.fingerprint).digest('hex');

    if (data.signature !== expectedSig) {
      return { valid: false, reason: 'TAMPERED' };
    }

    const currentFP = getMachineFingerprint();
    // Allow fuzzy match on first 24 characters to tolerate minor dynamic network interface fluctuations
    if (currentFP.slice(0, 24) !== data.fingerprint.slice(0, 24)) {
      return { valid: false, reason: 'MACHINE_MISMATCH', currentFP, registeredFP: data.fingerprint };
    }

    return { valid: true, activatedAt: data.activatedAt };
  } catch (err) {
    return { valid: false, reason: 'CORRUPTED', error: err.message };
  }
}

function initLicense() {
  const status = verifyLicense();
  if (!status.valid) {
    if (status.reason === 'NOT_FOUND') {
      const act = activateLicense();
      console.log(`  [License] Initialized and bound to this computer (FP: ${act.fingerprint.slice(0, 8)}...)`);
      return true;
    } else {
      console.error('\n  ==============================================================');
      console.error('  ❌ خطأ في الترخيص: تم تفعيل البرنامج على جهاز آخر مختلف!');
      console.error('  هذه النسخة مقفلة للعمل على جهاز كمبيوتر واحد فقط.');
      console.error('  ==============================================================\n');
      return false;
    }
  } else {
    console.log('  [License] Valid machine lock verified (الترخيص سليم ومطابق للجهاز)');
    return true;
  }
}

module.exports = {
  activateLicense,
  verifyLicense,
  initLicense
};
