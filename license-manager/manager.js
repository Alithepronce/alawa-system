'use strict';

const PRODUCT = 'alawa-system';
const form = document.getElementById('issueForm');
const message = document.getElementById('message');
const issueButton = document.getElementById('issueButton');

function showMessage(text, type) {
  message.textContent = text;
  message.className = `message ${type}`;
  message.focus();
}

function decodePem(text, label) {
  const match = text.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`));
  if (!match) throw new Error(`صيغة ملف ${label === 'PRIVATE KEY' ? 'المفتاح الخاص' : 'المفتاح العام'} غير صحيحة.`);
  const binary = atob(match[1].replace(/\s/g, ''));
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readFile(input, maxBytes = 65536) {
  const file = input.files?.[0];
  if (!file) throw new Error('أكمل اختيار الملفات المطلوبة.');
  if (file.size > maxBytes) throw new Error(`الملف ${file.name} أكبر من الحد المسموح.`);
  return file.text();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  issueButton.disabled = true;
  message.textContent = '';
  message.className = 'message';
  try {
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) throw new Error('هذا المتصفح لا يدعم التوقيع الآمن. افتح الأداة في إصدار حديث من Edge أو Chrome.');
    const request = JSON.parse(await readFile(document.getElementById('requestFile')));
    if (request.format !== 'alawa-activation-request-v1' || request.product !== PRODUCT || !/^[a-f0-9]{64}$/i.test(request.fingerprint || '') || !request.requestId) {
      throw new Error('ملف طلب التفعيل غير صالح أو لا يخص هذا البرنامج.');
    }

    const privatePem = await readFile(document.getElementById('privateKeyFile'));
    const publicPem = await readFile(document.getElementById('publicKeyFile'));
    const privateKey = await crypto.subtle.importKey('pkcs8', decodePem(privatePem, 'PRIVATE KEY'), { name: 'Ed25519' }, false, ['sign']);
    const publicKey = await crypto.subtle.importKey('spki', decodePem(publicPem, 'PUBLIC KEY'), { name: 'Ed25519' }, false, ['verify']);
    const expiryDate = document.getElementById('expiresAt').value;
    let expiresAt = null;
    if (expiryDate) {
      expiresAt = new Date(`${expiryDate}T23:59:59.999Z`).toISOString();
      if (Date.parse(expiresAt) <= Date.now()) throw new Error('تاريخ الانتهاء يجب أن يكون في المستقبل.');
    }

    const serial = crypto.getRandomValues(new Uint8Array(8));
    const licenseKey = `ALAWA-${Array.from(serial, b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    const payload = JSON.stringify({
      product: PRODUCT,
      licenseType: 'offline',
      licenseKey,
      fingerprint: request.fingerprint.toLowerCase(),
      requestId: request.requestId,
      issuedAt: new Date().toISOString(),
      expiresAt
    });
    const signatureBytes = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(payload)));
    const verifies = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signatureBytes, new TextEncoder().encode(payload));
    if (!verifies) throw new Error('المفتاح الخاص لا يطابق المفتاح العام المضمّن في التطبيق.');

    const output = JSON.stringify({ format: 'alawa-offline-license-file-v1', payload, signature: toBase64(signatureBytes) }, null, 2);
    const blobUrl = URL.createObjectURL(new Blob([output], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `${licenseKey}.alawa-license.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    document.getElementById('privateKeyFile').value = '';
    showMessage(`تم إصدار الترخيص ${licenseKey} لهذا الجهاز. أرسل ملف الترخيص الذي تم تنزيله للعميل.`, 'success');
  } catch (error) {
    showMessage(error instanceof SyntaxError ? 'ملف طلب التفعيل ليس JSON صالحاً.' : (error.message || 'تعذر إصدار الترخيص.'), 'error');
  } finally {
    issueButton.disabled = false;
  }
});
