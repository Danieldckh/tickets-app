# ProAgri Tickets Admin

Standalone admin SPA for the ProAgri internal ticketing system, deployed at `tickets.proagrihub.com`.

## What it does

- SSO-gated: admin users sign in via Agri360 CRM (short-lived JWT redirect), receiving an httpOnly session cookie valid for 12 hours.
- Proxies all ticket API calls to Agri360's `/api/dev-tickets*`, injecting `X-Ticket-Admin-Key` server-side.
- Board view: 4-column kanban (New / Triage / In Progress / Done) with native drag-and-drop.
- Calendar view: month grid with tickets placed on their deadline day.
- Detail drawer: full ticket info, AI triage block, screenshots gallery, editable status / priority / deadline.
- New ticket modal: manual create from the admin panel.

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `AGRI360_API_BASE` | Agri360 CRM base URL — proxy target + SSO login bounce |
| `AGRI360_PUBLIC_BASE` | Agri360 public URL exposed to SPA for attachment URLs (usually same as above) |
| `PUBLIC_URL` | Public URL of this app — used to build the SSO redirect-back URL |
| `TICKET_ADMIN_KEY` | Shared secret injected as `X-Ticket-Admin-Key` on every proxied API call |
| `SSO_SHARED_SECRET` | Verifies SSO tokens from Agri360 (must match `SSO_SHARED_SECRET` in Agri360) |
| `SESSION_SECRET` | Signs the `tk_session` session cookie (private to this app, random) |

## How SSO works

1. Browser visits `/` — no session cookie → server redirects to `agri360.proagrihub.com/sso-start.html?app=tickets&redirect=…`.
2. Agri360's `sso-start.html` calls `POST /api/auth/sso-token?app=tickets`, gets a 60-second JWT signed with `SSO_SHARED_SECRET` (audience `tickets`, issuer `agri360-crm`).
3. Browser is redirected to `GET /sso?token=<jwt>` on this app.
4. Server verifies the JWT, checks `role === 'admin'`, issues a 12-hour `tk_session` httpOnly cookie, redirects to `/`.

## Local dev

```bash
cp .env.example .env
# fill in real values
npm install
npm start
```

## Deploy (Coolify)

- Docker image built from the provided `Dockerfile`.
- Set all env vars in the Coolify service environment.
- Health check: `GET /healthz` → `200 ok`.
