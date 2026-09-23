'use strict';
const crypto = require('node:crypto'); const fs = require('node:fs');
const keys = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync('license-private.pem', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync('license-public.pem', keys.publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Keys created. Keep license-private.pem secret; copy only the public key into the desktop app.');
