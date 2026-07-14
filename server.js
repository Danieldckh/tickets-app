'use strict';

/*
 * ProAgri Tickets Admin — server
 * --------------------------------
 * A standalone Express service deployed at tickets.proagrihub.com. It:
 *   (a) accepts SSO redirects from Agri360 CRM, verifies the short-lived JWT,
 *       and issues an httpOnly session cookie for admin users only.
 *   (b) proxies /api/tickets* to Agri360's /api/dev-tickets*, injecting the
 *       shared TICKET_ADMIN_KEY header server-side so the browser never sees it.
 *   (c) serves the static admin SPA from ./public.
 *
 * Node 20 has global fetch + FormData, so the only runtime deps are
 * express, cookie-parser, and jsonwebtoken.
 */

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT             = process.env.PORT || 3000;
const AGRI360_API_BASE = (process.env.AGRI360_API_BASE  || 'https://agri360.proagrihub.com').replace(/\/+$/, '');
const AGRI360_PUB_BASE = (process.env.AGRI360_PUBLIC_BASE || AGRI360_API_BASE).replace(/\/+$/, '');
const PUBLIC_URL       = (process.env.PUBLIC_URL || 'https://tickets.proagrihub.com').replace(/\/+$/, '');
const TICKET_ADMIN_KEY = process.env.TICKET_ADMIN_KEY || '';
const SSO_SECRET       = process.env.SSO_SHARED_SECRET || '';
const SESSION_SECRET   = process.env.SESSION_SECRET || '';
const SESSION_COOKIE   = 'tk_session';
const PUBLIC_DIR       = path.join(__dirname, 'public');

// Warn on boot so ops catches misconfiguration early.
if (!SSO_SECRET)       console.warn('WARNING: SSO_SHARED_SECRET is not set — SSO login will fail.');
if (!SESSION_SECRET)   console.warn('WARNING: SESSION_SECRET is not set — session cookies will not verify.');
if (!TICKET_ADMIN_KEY) console.warn('WARNING: TICKET_ADMIN_KEY is not set — Agri360 API calls will be rejected.');

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));

// ---------------------------------------------------------------------------
// Open endpoints — no session required
// ---------------------------------------------------------------------------

app.get('/healthz', (_req, res) => res.send('ok'));

// Exposes the Agri360 public base URL to the SPA so it can prefix attachment URLs.
app.get('/config.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`window.APP_CONFIG=${JSON.stringify({ agri360Base: AGRI360_PUB_BASE })};`);
});

// SSO landing — called by Agri360's sso-start.html with ?token=<short-lived JWT>.
app.get('/sso', (req, res) => {
  const loginUrl = `${AGRI360_API_BASE}/sso-start.html?app=tickets&redirect=${encodeURIComponent(PUBLIC_URL + '/sso')}`;

  const { token } = req.query;
  if (!token) return res.redirect(loginUrl);

  let decoded;
  try {
    decoded = jwt.verify(token, SSO_SECRET, { audience: 'tickets', issuer: 'agri360-crm' });
  } catch (err) {
    console.warn('SSO token invalid:', err.message);
    return res.redirect(loginUrl);
  }

  // Admins get the full (dev) board; managers get the managers-only board.
  // Everyone else is refused.
  const isAdmin   = decoded.role === 'admin';
  const isManager = decoded.managerAccess === true;
  if (!isAdmin && !isManager) {
    return res.status(403).send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Access denied</title>` +
      `<style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:480px;margin:auto}</style></head>` +
      `<body><h2>No access</h2><p>Your account (<strong>${decoded.email || ''}</strong>) ` +
      `does not have access to the Tickets app.</p>` +
      `<p><a href="${AGRI360_API_BASE}">Return to Agri360</a></p></body></html>`
    );
  }

  // Issue a 12-hour session cookie.
  const sessionToken = jwt.sign(
    { sub: decoded.sub, email: decoded.email, name: decoded.name, role: decoded.role, managerAccess: isManager },
    SESSION_SECRET,
    { expiresIn: '12h' }
  );

  res.cookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure:   true,
    sameSite: 'lax',
    path:     '/',
    maxAge:   12 * 60 * 60 * 1000,
  });

  // Admins land on the main (dev) board; managers on the managers board.
  return res.redirect(isAdmin ? '/' : '/managers');
});

// Logout — clear cookie and bounce to Agri360 login.
app.get('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect(`${AGRI360_API_BASE}/sso-start.html?app=tickets&redirect=${encodeURIComponent(PUBLIC_URL + '/sso')}`);
});

// ---------------------------------------------------------------------------
// Session auth middleware — applied to everything below this point
// ---------------------------------------------------------------------------
function requireSession(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return rejectSession(req, res);
  try {
    req.user = jwt.verify(token, SESSION_SECRET);
    return next();
  } catch (_err) {
    return rejectSession(req, res);
  }
}

function rejectSession(req, res) {
  const loginUrl = `${AGRI360_API_BASE}/sso-start.html?app=tickets&redirect=${encodeURIComponent(PUBLIC_URL + '/sso')}`;
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect(loginUrl);
}

app.use(requireSession);

// ---------------------------------------------------------------------------
// /api/overview → proxy to Agri360 /api/dev-tickets/overview
// ---------------------------------------------------------------------------
app.get('/api/overview', async (_req, res) => {
  const targetUrl = `${AGRI360_API_BASE}/api/dev-tickets/overview`;
  try {
    const upstream = await fetch(targetUrl, {
      method:  'GET',
      headers: { 'Accept': 'application/json', 'X-Ticket-Admin-Key': TICKET_ADMIN_KEY },
      signal:  AbortSignal.timeout(10000),
    });
    const ct = upstream.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      let data;
      try { data = await upstream.json(); } catch (_e) { data = null; }
      return res.status(upstream.status).json(data);
    }
    const text = await upstream.text();
    if (ct) res.set('Content-Type', ct);
    return res.status(upstream.status).send(text);
  } catch (err) {
    console.error('Overview proxy error:', err && err.message);
    return res.status(502).json({ error: 'Upstream API request failed' });
  }
});

// ---------------------------------------------------------------------------
// /api/tickets* → proxy to Agri360 /api/dev-tickets*
// ---------------------------------------------------------------------------
app.all('/api/tickets*', async (req, res) => {
  const suffix      = req.path.slice('/api/tickets'.length); // '' | '/123'
  const qs          = Object.keys(req.query).length
    ? '?' + new URLSearchParams(req.query).toString()
    : '';
  const targetUrl   = `${AGRI360_API_BASE}/api/dev-tickets${suffix}${qs}`;

  let fetchInit;

  if (req.method === 'POST') {
    // Admin manual create: backend expects multipart/form-data (multer).
    // Convert the JSON body from the SPA into FormData.
    const fd   = new FormData();
    const body = req.body || {};
    if (body.message)  fd.append('message',  String(body.message));
    if (body.title)    fd.append('title',    String(body.title));
    if (body.type)     fd.append('type',     String(body.type));
    if (body.priority) fd.append('priority', String(body.priority));
    if (body.deadline) fd.append('deadline', String(body.deadline));
    fetchInit = {
      method:  'POST',
      headers: { 'X-Ticket-Admin-Key': TICKET_ADMIN_KEY },
      body:    fd,
      signal:  AbortSignal.timeout(20000),
    };
  } else {
    const headers = {
      'Accept':             'application/json',
      'X-Ticket-Admin-Key': TICKET_ADMIN_KEY,
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
    }
    fetchInit = {
      method:  req.method,
      headers,
      signal:  AbortSignal.timeout(15000),
    };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchInit.body = JSON.stringify(req.body);
    }
  }

  try {
    const upstream = await fetch(targetUrl, fetchInit);
    const ct       = upstream.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      let data;
      try { data = await upstream.json(); } catch (_e) { data = null; }
      return res.status(upstream.status).json(data);
    }
    const text = await upstream.text();
    if (ct) res.set('Content-Type', ct);
    return res.status(upstream.status).send(text);
  } catch (err) {
    console.error('Ticket API proxy error:', req.method, req.path, '-', err && err.message);
    return res.status(502).json({ error: 'Upstream API request failed' });
  }
});

// ---------------------------------------------------------------------------
// Board access gating (HTML routes only) — enforced server-side so a direct
// link can't reveal a board the user isn't entitled to.
//   • The main (dev) board at '/' is ADMIN-ONLY. A non-admin manager hitting
//     it is bounced to '/managers'.
//   • The '/managers' board requires admin OR managerAccess.
// The SPA is one index.html; it detects the board from location.pathname.
// ---------------------------------------------------------------------------
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

function accessDenied(res) {
  return res.status(403).send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Access denied</title>` +
    `<style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:480px;margin:auto}</style></head>` +
    `<body><h2>No access</h2><p>You do not have access to this board.</p>` +
    `<p><a href="/managers">Go to the managers board</a></p></body></html>`
  );
}

function serveMainBoard(req, res) {
  if (req.user.role !== 'admin') {
    // A logged-in manager without admin belongs on the managers board.
    if (req.user.managerAccess) return res.redirect('/managers');
    return accessDenied(res);
  }
  return res.sendFile(INDEX_HTML);
}

// Managers board — admin or manager.
app.get(['/managers', '/managers/*'], (req, res) => {
  if (!(req.user.role === 'admin' || req.user.managerAccess)) return accessDenied(res);
  return res.sendFile(INDEX_HTML);
});

// Main (dev) board HTML entry points — admin only. Gated BEFORE express.static
// so its automatic index.html serving can't leak the board to a manager.
app.get(['/', '/index.html'], serveMainBoard);

// Static assets (app.js, app.css, images). index:false so '/' never resolves
// to index.html here — the gated routes above own the HTML entry points.
app.use(express.static(PUBLIC_DIR, { index: false }));

// Any other path = the main (dev) board (SPA fallback) → admin only.
app.get('*', serveMainBoard);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`ProAgri Tickets Admin listening on :${PORT} → ${AGRI360_API_BASE}`);
});
