# Ekshfli WhatsApp Gateway (Phase 1)

Baileys-based WhatsApp Web Multi-Device service. One session per clinic.

## Setup

```bash
cd whatsapp-gateway
cp .env.example .env
# Edit GATEWAY_TOKEN and PORT
npm install
npm start
```

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default 3100) |
| `GATEWAY_TOKEN` | Shared secret with Laravel `WHATSAPP_GATEWAY_TOKEN` |
| `SESSIONS_DIR` | Auth state directory (persist across restarts) |

## Laravel `.env`

```
WHATSAPP_GATEWAY_URL=http://127.0.0.1:3100
WHATSAPP_GATEWAY_TOKEN=same-as-gateway
WHATSAPP_API_BASE_URL=https://your-domain.com/api/v1
```

Run with PM2/systemd in production. Gateway must read the same filesystem paths as Laravel for PDF sends, or use a shared storage mount.
