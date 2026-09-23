# Alawa licensing service

1. Host this service behind HTTPS (for example, on a VPS behind Nginx).
2. Run `npm run create-key` once. Keep `license-private.pem` only on the server.
3. Replace `server/license-public-key.pem` in the desktop application with the generated `license-public.pem`, then rebuild the Windows app.
4. Set a random `ADMIN_TOKEN` environment secret and start the service.
5. Create a customer key: `POST /admin/licenses` with `Authorization: Bearer <ADMIN_TOKEN>` and `{ "expiresAt": "2027-01-01T00:00:00Z" }`.
6. To move a customer to another computer, call `POST /admin/reset-device` with the same authorization and `{ "licenseKey": "..." }`.

Never expose the private key, database, or admin token in the desktop package.
