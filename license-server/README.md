# License signing key storage

The desktop application now uses offline signed license files. The `server.js` service in this directory is retained for reference but is not required to activate customers.

Keep `license-private.pem` on the owner's trusted computer, encrypted at rest and backed up securely. It must never be committed to GitHub, included in the desktop package, or sent to customers. The matching public key is `server/license-public-key.pem` in the source tree and may be distributed.

The owner can create licenses with `../license-manager/index.html`. Use the activation request file from the customer's app, this private key, and the matching public key. The manager verifies the pair before issuing a signed file. Do not run `npm run create-key` if `license-private.pem` already exists; replacing the key invalidates licenses issued with the old one.
