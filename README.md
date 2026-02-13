# App-test

Applicazione login + working timer, con DB SQLite locale in `data/app.db`.

## Avvio locale

```bash
npm install
copy .env.example .env
npm run gen:secret
npm start
```

Apri `http://localhost:4173`.

## Deploy gratuito e sicuro (consigliato ora): Cloudflare Tunnel

Questa soluzione e':
- gratuita
- HTTPS pubblico
- dati persistenti sul tuo PC (SQLite)

Nota: il PC che ospita l'app deve restare acceso.

### 1) Configura `.env` per modalita' produzione

Imposta:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
TRUST_PROXY=1
JWT_SECRET=<secret lungo e random>
APP_ORIGIN=
APP_ORIGIN_REGEX=^https://[a-z0-9-]+\\.trycloudflare\\.com$
```

Perche' `APP_ORIGIN_REGEX`:
- con Quick Tunnel l'URL cambia a ogni avvio
- il server accetta solo origin `https://*.trycloudflare.com`

### 2) Avvia l'app

```bash
npm start
```

### 3) Installa Cloudflared

Su Windows (consigliato):

```bash
winget install --id Cloudflare.cloudflared -e
```

### 4) Apri tunnel HTTPS pubblico

In un secondo terminale:

```bash
cloudflared tunnel --url http://127.0.0.1:4173
```

Cloudflared mostrera' un URL tipo:
- `https://abc-def-ghi.trycloudflare.com`

Condividi quell'URL ai tuoi amici.

### 5) Uso quotidiano

Ogni volta:
1. avvia `npm start`
2. avvia `cloudflared tunnel --url http://127.0.0.1:4173`
3. condividi il nuovo URL

## Limitazioni della soluzione gratuita

- Se spegni il PC, l'app non e' raggiungibile.
- L'URL cambia a ogni avvio (quick tunnel).



## Test rapidi

```bash
npm run check
npm run test:smoke
```
