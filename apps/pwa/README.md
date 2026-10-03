## PWA (phone app)

Vite + React + TypeScript, French UI (labels from `label_fr` in `packages/schema/pages/*.json`). Login, WhatsApp-style chat, page photo upload, analysis stream, field correction and page confirmation. Offline queueing is step 9; the service worker only precaches the app shell so the app opens offline.

### Run

- `make pwa` (or `npm run dev -w @care-agent/pwa`): serves `0.0.0.0:5173`. `/api` is proxied to `API_URL` (default `http://localhost:8787`, streaming included), so start the server too (`make server`).
- HTTPS when the certificate files exist, plain HTTP otherwise. Env: `PWA_CERT`, `PWA_KEY` (default `<repo>/data/certs/{cert,key}.pem`, git-ignored). `localhost` is a secure context, so the camera and the file input work over plain HTTP on the laptop.
- `npm run build -w @care-agent/pwa`: static build in `apps/pwa/dist` (git-ignored).
- `VITE_FIXTURES=1 make pwa`: canned API and a canned analysis (one pregnancy page with flagged fields), no server or model needed. Login: any id, PIN `123456`.
- Tests: `npm test -w @care-agent/pwa` (NDJSON reader, reducer); typecheck: `npm run typecheck -w @care-agent/pwa`. Both run in `make check`.

### Phone over the LAN (HTTPS)

The phone camera and WebCrypto need a secure context, so the phone must open `https://<laptop LAN IP>:5173` with a certificate it trusts. Steps you run yourself:

1. Install [mkcert](https://github.com/FiloSottile/mkcert), then once: `mkcert -install`.
2. `make certs` writes `data/certs/{cert,key}.pem` for `localhost`, `127.0.0.1` and the IPs from `hostname -I`. Re-run it if the laptop IP changes. Restart `make pwa`.
3. Make the phone trust the mkcert root CA (`mkcert -CAROOT` shows the folder, file `rootCA.pem`). Copy it to the phone:
   - Android: Settings > Security > Encryption and credentials > Install a certificate > CA certificate, pick `rootCA.pem`.
   - iOS: open the file to install the profile (Settings > Profile Downloaded), then Settings > General > About > Certificate Trust Settings and enable full trust for the mkcert root.
4. Open `https://<laptop IP>:5173` on the phone (same Wi-Fi), log in.

Fallback without a phone: the laptop webcam or file picker on `http://localhost:5173`.

If the phone cannot reach the laptop: the Wi-Fi may isolate clients (guest networks, some routers), and the laptop firewall may block port 5173 (the phone only talks to 5173; the Vite proxy reaches the server on 8787 locally).
