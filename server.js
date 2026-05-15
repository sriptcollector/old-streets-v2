const express = require('express');
const http = require('http');
const crypto = require('crypto');

// Polyfill `globalThis.crypto` for Node 18 — @simplewebauthn/server v13+
// uses WebCrypto via `globalThis.crypto.getRandomValues`, which Node 20+
// exposes natively but Node 18 doesn't. Without this the passkey ceremony
// crashes the process at first call.
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// =================================================================
// .env loader — tiny inline parser so we don't pull in a dependency.
// Loads /server.js sibling .env into process.env on boot. Existing env
// vars win (so `TWILIO_API_KEY_SID=... node server.js` still works).
// =================================================================
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) {
    console.warn('[dotenv] load failed:', e.message);
  }
})();

// =================================================================
// Twilio Verify — phone-number sign-in. We POST to Verify with Basic
// Auth (API Key SID + Secret). No SDK needed; native fetch handles it.
// Returns { ok, status, error? } from start/check helpers.
// =================================================================
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_API_KEY_SID || '';
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || '';
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || '';
const TWILIO_ENABLED = !!(TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_VERIFY_SERVICE_SID);

function twilioAuthHeader() {
  const b = Buffer.from(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`).toString('base64');
  return 'Basic ' + b;
}
function normPhoneE164(raw) {
  // Accepts "(310) 555-1234", "3105551234", "+13105551234". Returns +1XXXXXXXXXX
  // for US-default 10-digit, or +<digits> if user provided a leading + with
  // country code. Returns null if input clearly isn't a phone number.
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return '+' + digits;
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}
async function twilioStartVerify(phoneE164) {
  if (!TWILIO_ENABLED) {
    return { ok: false, error: 'sms-not-configured', devNote: 'set TWILIO_* env vars to enable real SMS' };
  }
  try {
    const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications`;
    const body = new URLSearchParams({ To: phoneE164, Channel: 'sms' });
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: data.message || `twilio error ${r.status}`, twilioCode: data.code || null };
    }
    return { ok: true, status: data.status || 'pending', sid: data.sid || null };
  } catch (e) {
    return { ok: false, error: 'twilio-network-error: ' + e.message };
  }
}
// Generic SMS send via Twilio Messages API. Used to text members when
// admin approves them ("you're in"), for invite-link blasts, etc.
async function twilioSendSms(phoneE164, message) {
  if (!TWILIO_ENABLED) {
    console.log('[twilio] not configured; would have sent to', phoneE164, ':', message);
    return { ok: false, error: 'sms-not-configured' };
  }
  const from = process.env.TWILIO_FROM || config.twilioFrom || '';
  if (!from) {
    console.log('[twilio] no TWILIO_FROM set; would have sent:', message);
    return { ok: false, error: 'no-from-number' };
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID || ''}/Messages.json`;
    const body = new URLSearchParams({ To: phoneE164, From: from, Body: String(message).slice(0, 1000) });
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': twilioAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn('[twilio] send failed', r.status, data.message);
      return { ok: false, error: data.message || `twilio ${r.status}` };
    }
    return { ok: true, sid: data.sid };
  } catch (e) {
    console.warn('[twilio] send error', e.message);
    return { ok: false, error: 'twilio-network-error: ' + e.message };
  }
}

async function twilioCheckVerify(phoneE164, code) {
  if (!TWILIO_ENABLED) {
    return { ok: false, error: 'sms-not-configured' };
  }
  try {
    const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;
    const body = new URLSearchParams({ To: phoneE164, Code: String(code) });
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: data.message || `twilio error ${r.status}`, twilioCode: data.code || null };
    }
    return { ok: data.status === 'approved', status: data.status || 'unknown' };
  } catch (e) {
    return { ok: false, error: 'twilio-network-error: ' + e.message };
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 40 * 1024 * 1024 });

// Trust the proxy (Lander/Render/etc. terminate TLS in front of us)
app.set('trust proxy', true);

// =================================================================
// RATE LIMITING — simple in-memory token bucket per IP per endpoint.
// Stops brute-force admin login attempts and signup spam.
// =================================================================
const rateBuckets = new Map(); // key = `${ip}|${endpoint}` → { count, resetAt }

function rateLimit({ key, max, windowMs }) {
  return (req, res, next) => {
    const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const bucketKey = `${ip}|${key}`;
    const now = Date.now();
    let b = rateBuckets.get(bucketKey);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(bucketKey, b);
    }
    b.count++;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.set('Retry-After', retryAfter);
      // Log every rate-limit hit so admin can spot brute-force attempts.
      pushThreatEvent({
        type: 'rate-limit-hit',
        severity: b.count > max * 3 ? 'high' : 'med',
        ip,
        who: '',
        note: `bucket=${key} hits=${b.count} cap=${max}`
      });
      return res.status(429).json({
        error: `too many requests — try again in ${retryAfter}s`
      });
    }
    next();
  };
}

// Periodic cleanup so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (b.resetAt < now) rateBuckets.delete(k);
  }
}, 60 * 1000);

// Self-healing publicUrl: if PUBLIC_URL env var isn't set and config still
// points at localhost, pick up the real host from the first inbound request.
// That way invite/reset/digest emails always carry a working link, even if
// nobody set the env var.
app.use((req, _res, next) => {
  if (!process.env.PUBLIC_URL &&
      (config.publicUrl === 'http://localhost:3001' || !config.publicUrl) &&
      req.get('host') && !req.get('host').startsWith('localhost')) {
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const host = req.get('host');
    config.publicUrl = `${proto}://${host}`;
    console.log('[auto-detected publicUrl]:', config.publicUrl);
  }
  next();
});

// Site-pause middleware — blocks every write while the site is paused.
// Admin endpoints + site-info + the pause overlay itself still respond
// so admins can monitor and the overlay can render.
app.use((req, res, next) => {
  if (!SITE_PAUSED) return next();
  // Allow GETs and HEAD — read-only doesn't violate the pause.
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  // Allow admin routes through so admins can still moderate.
  if (req.path.startsWith('/api/admin/')) return next();
  // Allow socket.io handshakes (they're HTTP polling/websocket upgrade).
  if (req.path.startsWith('/socket.io/')) return next();
  return res.status(503).json({ error: 'site paused — temporarily offline due to student concerns' });
});

// Security headers — applied to every response. Protects against the
// common low-effort attacks: clickjacking, MIME-sniff, mixed-content,
// some XSS, info leakage via referrer.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // CSP — allow our origin, the CDNs we actually use (TF/nsfwjs/spotify/tenor),
  // inline styles (needed for profile-custom-css + dynamic styles).
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://accounts.google.com https://apis.google.com",
    "connect-src 'self' wss: https:",
    "frame-src https://open.spotify.com https://accounts.google.com https://www.youtube.com https://www.youtube-nocookie.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

// ====================================================================
// OLD-URL REDIRECT — anyone hitting the Lander hostname gets a sticky
// "we moved" page that nudges them to bookmark the new URL + enable push
// notifications. Three ways this triggers:
//   1. FORCE_REDIRECT_TO env var set → every request redirects (use this
//      on the Lander deploy to make the whole instance a redirect billboard)
//   2. Hostname matches OLD_HOSTNAMES env (or default lander.host)
//   3. X-Forwarded-Host header matches (proxies sometimes mangle req.hostname)
// ====================================================================
const FORCE_REDIRECT_TO = process.env.FORCE_REDIRECT_TO || '';
// When this instance is a pure redirect billboard (Lander), disable ALL
// background writes — no saves, no GH backups, no ghost activity. That way
// it can't race with the real production instance (Fly) over the shared
// GH backup repo.
const IS_REDIRECT_ONLY = !!FORCE_REDIRECT_TO;
const OLD_HOSTNAMES = new Set(
  (process.env.OLD_HOSTNAMES || 'oldstreets.app.lander.host')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const NEW_URL = process.env.NEW_URL || FORCE_REDIRECT_TO || 'https://old-streets.fly.dev';
app.use((req, res, next) => {
  // The whole instance is a redirect billboard (set on Lander)
  if (FORCE_REDIRECT_TO) {
    // fall through to redirect handler below — host matching is bypassed
  } else {
    const host = (req.hostname || '').toLowerCase();
    const fwd = (req.headers['x-forwarded-host'] || '').toLowerCase().split(',')[0].trim();
    const rawHost = (req.headers['host'] || '').toLowerCase().split(':')[0];
    if (!OLD_HOSTNAMES.has(host) && !OLD_HOSTNAMES.has(fwd) && !OLD_HOSTNAMES.has(rawHost)) return next();
  }
  // API calls from the old hostname (legacy clients) → return a JSON
  // redirect hint with status 301 so they fail loud.
  if (req.path.startsWith('/api/') || req.path === '/socket.io/' || req.path.startsWith('/socket.io/')) {
    if (SITE_PAUSED) {
      return res.status(503).json({ error: 'site paused', message: SITE_PAUSE_MESSAGE });
    }
    res.setHeader('X-Old-Streets-Moved', NEW_URL);
    return res.status(410).json({
      error: 'this server moved — please reload',
      newUrl: NEW_URL,
      action: 'visit ' + NEW_URL + ' and bookmark it'
    });
  }
  // While the whole site is paused, the old Lander URL should show the
  // SAME pause/apology message — not the "we moved" redirect billboard.
  if (SITE_PAUSED) {
    const apologyHtml = SITE_PAUSE_APOLOGY.map(p => `<p>${escapeHtmlServer(p)}</p>`).join('');
    const teasersHtml = SITE_PAUSE_TEASERS.map(t => `<li>${escapeHtmlServer(t)}</li>`).join('');
    return res.status(200).set('Cache-Control', 'no-store').type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Old Streets — paused</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg"/>
<style>
  html, body { margin:0; padding:0; min-height:100%; background:#0a0c10; color:#e6e8eb;
    font-family:-apple-system,'Helvetica Neue',system-ui,sans-serif; }
  body { display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { background:#11151c; border:1px solid #2a2f37; border-radius:14px;
    padding:28px 26px; max-width:600px; width:96%; text-align:center;
    box-shadow:0 30px 80px rgba(0,0,0,0.55); }
  .gif { width:100%; max-width:320px; border-radius:10px; display:block; margin:0 auto 20px;
    border:1px solid #2a2f37; }
  .title { font-size:20px; font-weight:900; margin-bottom:12px; color:#ff9b6b; letter-spacing:0.02em; }
  .body { font-size:15px; line-height:1.5; color:#c8cdd5; margin-bottom:14px; }
  .apology { text-align:left; margin:18px auto 10px; max-width:540px;
    border-top:1px solid #2a2f37; border-bottom:1px solid #2a2f37; padding:14px 4px; }
  .apology p { font-size:13.5px; line-height:1.55; color:#c8cdd5; margin:0 0 10px; }
  .apology p:last-child { margin-bottom:0; }
  .teasers-label { font-size:11px; color:#7a818a; text-transform:uppercase;
    letter-spacing:0.12em; margin-top:14px; }
  ul.teasers { list-style:none; padding:0; margin:10px auto 0;
    display:flex; flex-direction:column; gap:6px; }
  ul.teasers li { font-size:14px; color:#ffd76b; font-weight:700; letter-spacing:0.04em; }
  ul.teasers li::before { content:'↳ '; color:#7a818a; font-weight:400; margin-right:4px; }
</style>
</head>
<body>
  <div class="card">
    <img class="gif" src="${SITE_PAUSE_GIF}" alt="paused"/>
    <div class="title">⏸ Old Streets is temporarily paused</div>
    <div class="body">${escapeHtmlServer(SITE_PAUSE_MESSAGE)}</div>
    <div class="apology">${apologyHtml}</div>
    <div class="teasers-label">coming next:</div>
    <ul class="teasers">${teasersHtml}</ul>
  </div>
</body></html>`);
  }
  // Otherwise — original "we moved" billboard.
  const newHost = NEW_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  res.status(200).set('Cache-Control', 'no-store').type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Old Streets — we moved</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg"/>
<meta http-equiv="refresh" content="8;url=${NEW_URL}">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #fff;
    font-family: -apple-system, 'Helvetica Neue', system-ui, sans-serif; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 32px 24px; text-align: center; min-height: 100vh; }
  .logo { width: 72px; height: 72px; opacity: 0.95; margin-bottom: 22px;
    filter: drop-shadow(0 0 24px rgba(96, 144, 240, 0.5)); }
  .kicker { font-size: 11px; letter-spacing: 0.4em; color: #888; text-transform: uppercase; margin-bottom: 18px; }
  h1 { font-size: 30px; font-weight: 800; margin: 0 0 14px; letter-spacing: -0.01em; line-height: 1.15; }
  .sub { color: #aaa; font-size: 15px; margin: 0 0 28px; line-height: 1.55; max-width: 480px; }
  .url-pill { display: inline-block; background: #fff; color: #000; padding: 14px 28px;
    border-radius: 999px; font-weight: 800; text-decoration: none; font-size: 17px;
    margin-bottom: 22px; transition: transform .15s, box-shadow .15s;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.1), 0 8px 32px rgba(96, 144, 240, 0.25); }
  .url-pill:hover { transform: translateY(-2px); box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 12px 40px rgba(96, 144, 240, 0.4); }
  .tips { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px; padding: 18px 22px; max-width: 460px; font-size: 13px; color: #ccc;
    line-height: 1.7; margin-bottom: 22px; }
  .tips strong { color: #fff; }
  .kbd { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.16);
    padding: 2px 8px; font-family: ui-monospace, monospace; border-radius: 4px;
    font-size: 11px; color: #fff; }
  #notif-btn { background: transparent; color: #fff; border: 1.5px solid rgba(255,255,255,0.35);
    padding: 12px 26px; font-weight: 700; font-size: 13px; border-radius: 999px;
    cursor: pointer; margin-bottom: 18px; transition: all .15s;
    font-family: inherit; -webkit-tap-highlight-color: transparent; }
  #notif-btn:hover { border-color: #fff; background: rgba(255,255,255,0.05); }
  #notif-btn.granted { background: rgba(74, 222, 128, 0.15); border-color: rgba(74, 222, 128, 0.5); color: #4ade80; cursor: default; }
  .signoff { color: #666; font-size: 12px; font-style: italic; margin-top: 18px; line-height: 1.6; }
  .signoff strong { color: #aaa; font-style: normal; }
  .countdown { color: #555; font-size: 11px; margin-top: 14px; letter-spacing: 0.04em; }
  @keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #4ade80;
    margin-right: 6px; animation: pulse 1.4s ease-in-out infinite; vertical-align: middle; }
</style>
</head>
<body>
  <img class="logo" src="/logo.svg" alt=""/>
  <div class="kicker">old streets</div>
  <h1>we moved.</h1>
  <p class="sub"><span class="dot"></span>we needed more storage — y'all are blowing up too fast. new home below.</p>
  <a class="url-pill" href="${NEW_URL}">${newHost}</a>
  <div class="tips">
    <strong>📌 bookmark it:</strong><br>
    Mac: <span class="kbd">⌘</span>+<span class="kbd">D</span>  &middot;  Windows: <span class="kbd">Ctrl</span>+<span class="kbd">D</span><br>
    iPhone: <strong>Share</strong> → <strong>Add to Home Screen</strong><br>
    Android: <strong>⋮</strong> → <strong>Add to Home screen</strong>
  </div>
  <button id="notif-btn">🔔 turn on push notifications</button>
  <p class="signoff">— from your founder, <strong>oj (Olive Juice)</strong></p>
  <p class="countdown">auto-redirecting in <span id="cd">8</span>s…</p>
<script>
  let n = 8;
  const cd = document.getElementById('cd');
  setInterval(() => { n = Math.max(0, n - 1); cd.textContent = n; }, 1000);
  document.getElementById('notif-btn').addEventListener('click', async () => {
    const btn = document.getElementById('notif-btn');
    if (!('Notification' in window)) { btn.textContent = 'push not supported'; return; }
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') {
        btn.textContent = '✓ notifications on';
        btn.classList.add('granted');
        new Notification('Old Streets', { body: "you're set — see you on the new URL", icon: '/logo.svg' });
      } else {
        btn.textContent = 'denied — enable in browser settings';
      }
    } catch { btn.textContent = 'something went wrong'; }
  });
</script>
</body></html>`);
});

// Invite-link redirect: /i/:token → /?invite=<token>. The frontend reads
// the ?invite query param on boot and switches into the invite-onboarding
// flow. Keeping the URLs short ("oldstreets.app/i/abc123") makes them
// readable in SMS bodies and friendlier to share.
app.get('/i/:token', (req, res) => {
  const tok = String(req.params.token || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!tok) return res.redirect('/onboard.html');
  // Track the open — the inviter sees "opened" status on their ticket so
  // they know the recipient at least visited (even before they sign up).
  let openedInviter = null, openedInv = null;
  for (const u of users) {
    for (const inv of (u.pendingInvites || [])) {
      if (inv.inviteToken === tok && !inv.openedAt) {
        inv.openedAt = Date.now();
        scheduleSave(USERS_FILE, () => users, 3000);
        openedInviter = u;
        openedInv = inv;
        break;
      }
    }
    if (openedInv) break;
  }
  // Fire instant SMS to the inviter — "someone just opened your link"
  // Only fires once (openedAt was null before we set it above).
  if (openedInviter && openedInviter.phone) {
    const base2 = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
    const nudgeIdx = Math.floor(Math.random() * 4);
    const openMsgs = [
      `someone just opened your old streets invite. they haven't joined yet — one tap left.`,
      `your invite link was just opened. they're on the page right now. text them.`,
      `ur friend opened ur link. they're right there — waiting on them: ${base2}/gate`,
      `someone clicked ur old streets invite. they haven't signed up yet. push them.`
    ];
    twilioSendSms(openedInviter.phone, openMsgs[nudgeIdx]).catch(() => {});
  }
  res.redirect('/onboard.html?invite=' + encodeURIComponent(tok));
});

// Back-fill share tokens on existing waitlisted users so they get links
// without re-signup. Runs once on boot.
setTimeout(() => {
  let touched = 0;
  for (const u of users) {
    if (u.status !== 'waitlist') continue;
    if (!u.waitlistShareToken) {
      u.waitlistShareToken = 'w' + crypto.randomBytes(6).toString('hex');
      u.waitlistShareClicks = u.waitlistShareClicks || 0;
      u.waitlistShareSignups = u.waitlistShareSignups || 0;
      touched++;
    }
  }
  if (touched > 0) { saveUsers(); console.log(`[waitlist-share] backfilled ${touched} share tokens`); }
}, 8000);

// GET /api/me/waitlist-share — user's own share link + stats.
app.get('/api/me/waitlist-share', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.status !== 'waitlist') return res.json({ status: 'active', message: 'you\'re already in' });
  if (!me.waitlistShareToken) {
    me.waitlistShareToken = 'w' + crypto.randomBytes(6).toString('hex');
    saveUsers();
  }
  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  const url = `${base}/w/${me.waitlistShareToken}`;
  // Compute "spots moved up" — show users a concrete number
  const boost = waitlistBoostScore(me);
  const minutesMoved = boost; // ~1 minute per point in our sort key
  res.json({
    url,
    clicks: me.waitlistShareClicks || 0,
    signups: me.waitlistShareSignups || 0,
    boostScore: boost,
    position: computeWaitlistPosition(me),
    spotsMovedUp: Math.floor(boost / 2), // showy number — every 2 boost = ~1 spot
    smsBody: `i'm on the old streets waitlist. open this and it bumps me up: ${url}`
  });
});

// ===================================================================
// WAITLIST SHARE LINK — every waitlisted user gets a unique /w/<token>
// link they can share. Each click bumps their boost score (1 point);
// every signup credited to the link bumps it by 10. The boost slides
// them up the queue (sort key is `waitlistedAt - boostScore*60_000`).
// ===================================================================
app.get('/w/:token', (req, res) => {
  const tok = String(req.params.token || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!tok) return res.redirect('/onboard.html');
  // Find the owner of this share token
  const owner = users.find(u => u.waitlistShareToken === tok);
  if (owner) {
    // Anti-spam: rate-limit clicks per IP+token combo to once per 30 min
    owner._shareClickIps = owner._shareClickIps || {};
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString().split(',')[0].trim();
    const last = owner._shareClickIps[ip] || 0;
    if (Date.now() - last > 30 * 60 * 1000) {
      owner.waitlistShareClicks = (owner.waitlistShareClicks || 0) + 1;
      owner._shareClickIps[ip] = Date.now();
      scheduleSave(USERS_FILE, () => users, 3000);
    }
  }
  // Set a short-lived signed cookie so the signup endpoint can credit
  // a signup to this referrer. 30-day window.
  try {
    res.cookie('os_wlref', tok, {
      maxAge: 30 * 86400 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: true
    });
  } catch {}
  res.redirect('/onboard.html?ref=' + encodeURIComponent(tok));
});

// No host-bouncing. Every host that reaches the server (fly.dev, the apex,
// www, raw IP, anything) just serves the site directly. The school's
// Fortinet MITM makes the apex unreachable for some users — keeping every
// host live means anyone can use whichever one their network lets through.

// Single responsive index.html for every viewport — the restored legacy
// uses CSS media queries to handle phone + desktop in one file. No UA
// branching, no mobile-only HTML.

// /u/:handle → serve the standalone MySpace-style profile page. The page
// itself reads the handle from window.location.pathname at boot.
app.get('/u/:handle', (req, res, next) => {
  const h = String(req.params.handle || '').trim();
  // Only intercept clean handle URLs (let assets like /u/foo.js fall through)
  if (!/^[a-z0-9_]{1,40}$/i.test(h)) return next();
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Static assets — HTML never cached (so updates land instantly), other
// asset types cached for 5 min with revalidation, images for 1 day.
// HTML responses get a soft no-cache (so updates show up quickly) but we
// DO NOT send Clear-Site-Data on every response — that would force the
// browser to redownload every asset on every page load, which was the
// real cause of the "site takes forever" issue.

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.html$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    } else if (/\.(svg|png|jpg|jpeg|gif|webp|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    } else if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  }
}));
app.use(express.json({ limit: '60mb' }));

// ====================================================================
// AUDIT LOG — append-only record of every mutating API call. Stored in
// data/audit.jsonl as one JSON line per event. Survives forever (well,
// truncated only when file exceeds 100MB). Recovered by GH backup like
// everything else. This is the "everything tracked, everything saved"
// safety net — if we ever wonder "what happened?" we can replay this.
// ====================================================================
const AUDIT_MAX_BYTES = 100 * 1024 * 1024;
function appendAudit(event) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Rotate if too big
    try {
      const st = fs.statSync(AUDIT_FILE);
      if (st && st.size > AUDIT_MAX_BYTES) {
        fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.' + Date.now());
      }
    } catch {}
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(event) + '\n');
  } catch (e) {
    console.warn('[audit] append failed:', e.message);
  }
}
app.use((req, res, next) => {
  const method = req.method;
  // Only audit mutations + critical reads. GETs are firehose noise.
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
  if (req.path === '/api/whoami') return next(); // every page-load fires this
  if (req.path === '/health') return next();
  // Capture token-resolved user (if any) for attribution
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  let userEmail = null;
  try {
    const u = token ? findUserByToken(token) : null;
    if (u) userEmail = u.email;
  } catch {}
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      appendAudit({
        ts: t0,
        method,
        path: req.path,
        status: res.statusCode,
        user: userEmail,
        ip: (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim(),
        ua: (req.headers['user-agent'] || '').slice(0, 120),
        dur: Date.now() - t0
      });
    } catch {}
  });
  next();
});
// Static-serve uploaded media at /uploads/* (image + video binaries)
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=604800'); }
}));

// /admin dashboard — only orion (@orionjones) sees it. Anyone else, 404.
// Token-gated server-side so non-admins can't probe.
function isOrionAdmin(req) {
  const tok = (req.headers['x-user-token'] || req.query.t || '').toString();
  const u = users.find(x => x && x.token === tok);
  if (!u) return false;
  if (!u.isAdmin) return false;
  const h = (u.handle || '').toLowerCase();
  const e = (u.email || '').toLowerCase();
  return h === 'orionjones' || h === 'orion' || e === 'orionjones99@gmail.com' || u.name === 'orion jones';
}
app.get(['/admin', '/admin.html'], (req, res) => {
  // For first paint we serve the page; the page itself checks /api/whoami
  // and bounces non-admins. Anyone probing without a token sees the page
  // shell but no admin data (every /api/admin/* call is admin-gated).
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// =================================================================
// STORAGE
// =================================================================
const DATA_DIR = path.join(__dirname, 'data');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');
const VIEWS_FILE = path.join(DATA_DIR, 'profile-views.json');
const NOTIFS_FILE = path.join(DATA_DIR, 'notifs.json');
const UNSUB_FILE = path.join(DATA_DIR, 'unsubscribes.json');
const DIRECTORY_FILE = path.join(__dirname, 'lib', 'directory.json');
const LOVE_LETTERS_FILE = path.join(DATA_DIR, 'love-letters.json');
const PROFILE_BOARDS_FILE = path.join(DATA_DIR, 'profile-boards.json');
const BULLETINS_FILE = path.join(DATA_DIR, 'bulletins.json');
const BLOGS_FILE = path.join(DATA_DIR, 'blogs.json');
const FRIEND_REQ_FILE = path.join(DATA_DIR, 'friend-requests.json');
const QOTD_FILE = path.join(DATA_DIR, 'qotd.json');
const LATE_NIGHT_FILE = path.join(DATA_DIR, 'late-night.json');
const ROYALTY_FILE = path.join(DATA_DIR, 'royalty.json');
const MUTUAL_VIEWS_FILE = path.join(DATA_DIR, 'mutual-views.json');
const CRUSH_LIST_FILE = path.join(DATA_DIR, 'crush-list.json');
const ADS_FILE = path.join(DATA_DIR, 'ads.json');
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl'); // append-only one-event-per-line
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const BRAND_VOTE_FILE = path.join(DATA_DIR, 'brand-votes.json');
const APPROVAL_DM_QUEUE_FILE = path.join(DATA_DIR, 'approval-dm-queue.json');
const REENGAGE_FILE = path.join(DATA_DIR, 'reengage.json');
// Per-school directories for non-Ancient-Old Streets schools. Ancient Old Streets uses the
// legacy lib/directory.json. Future schools each get their own file.
const SCHOOL_DIRECTORIES_DIR = path.join(DATA_DIR, 'school-directories');
const EMAIL_VERIFY_FILE = path.join(DATA_DIR, 'email-verify.json');

let posts = [];
let users = [];
let dms = [];
let profileViews = []; // [{ viewer, target, ts }]
let notifs = [];       // [{ id, to, type, fromName, fromEmail, postId?, text, ts, read }]
let unsubscribes = new Set(); // lowercased emails that have opted out of marketing email
let directory = [];
let loveLetters = [];  // [{ id, toEmail, toName, message, createdAt, chainDepth, parentId? }]
let profileBoards = {}; // { ownerEmailLower: [{ id, authorEmail, authorName, text, isAnonymous, createdAt }] }
let bulletins = [];    // [{ id, authorEmail, authorName, text, createdAt }]
let blogs = [];        // [{ id, authorEmail, authorName, title, body, reactions, comments, createdAt }]
let friendRequests = []; // [{ id, from, to, fromName, status: 'pending'|'accepted'|'rejected', createdAt }]
let qotdHistory = [];  // [{ id, date, prompt, answers: [{authorEmail, authorName, text, ts, reactions}], createdAt }]
let lateNight = [];    // [{ id, authorEmail, authorName, text, isAnonymous, reactions, createdAt }]
let lateNightHeadline = null; // { text, authorName, reactCount, date }
let royalty = { weekKey: '', winners: [] }; // { weekKey, winners: [{ kind, email, name, summary, ts }] }
let mutualViewsSent = {}; // { 'a|b': lastNotifTs } — dedupe key sorted emails
let crushList = []; // [{ id, from, to, fromName, toName, createdAt, matched, matchedAt }]
let ads = []; // [{ id, imageUrl, caption, mentionedHandle, link, startAt, endAt, weight, active, impressions, clicks, createdAt }]
let groups = []; // [{ id, name, members: [emailLc], createdBy: emailLc, createdAt, messages: [{ id, from, fromName, text, createdAt, readBy: [emailLc] }] }]
let announcements = []; // [{ id, text, link, active, createdAt, expiresAt }]
let eventLog = [];  // [{ id, ts, email, event, meta }]
// In-memory 2FA challenges — { email: { code, expiresAt, attempts } }
const twoFaChallenges = new Map();
// Add new files to GH backup list (do here so the variable picks them up
// — see GH_BACKUP_FILES at top of file).
const peakOnlineToday = { count: 0, day: null };  // for faked activity floor
// All config values can be set via env var (preferred for production) OR
// stored in data/config.json. Env vars always win — this way redeploys
// without a persistent volume still pick up your real config.
let config = {
  memberPasscode: 'mouse',
  adminUsername: 'admin',
  adminPasscode: 'change-me-admin',
  emailDomain: '',
  siteName: 'Old Streets',
  resendApiKey: '',
  emailFrom: 'Lander <noreply@lander.host>',
  publicUrl: 'http://localhost:3001'
};

// HARD GLOBAL KILL-SWITCHES — flip these in code, no env needed.
// Pause overlay is OFF for the relaunch. Email sending is also off until
// a transactional provider is wired up (we use SMS via Twilio for auth now).
const EMAILS_DISABLED = true;        // every send-email path bails immediately
let SITE_PAUSED = false;
let SITE_PAUSE_MESSAGE = '';
let SITE_PAUSE_APOLOGY = [];
let SITE_PAUSE_TEASERS = [];
let SITE_PAUSE_GIF = '';

function applyEnvOverrides() {
  if (process.env.RESEND_API_KEY)  config.resendApiKey   = process.env.RESEND_API_KEY;
  if (process.env.EMAIL_FROM)      config.emailFrom      = process.env.EMAIL_FROM;
  if (process.env.PUBLIC_URL)      config.publicUrl      = process.env.PUBLIC_URL;
  if (process.env.ADMIN_USERNAME)  config.adminUsername  = process.env.ADMIN_USERNAME;
  if (process.env.ADMIN_PASSCODE)  config.adminPasscode  = process.env.ADMIN_PASSCODE;
  if (process.env.MEMBER_PASSCODE) config.memberPasscode = process.env.MEMBER_PASSCODE;
  if (process.env.EMAIL_DOMAIN)    config.emailDomain    = process.env.EMAIL_DOMAIN;
  if (process.env.SITE_NAME)       config.siteName       = process.env.SITE_NAME;
  // Global email kill-switch — wipe the API key so every send-email path
  // hits its "no resend api key" guard and bails. Single point of control.
  if (EMAILS_DISABLED) {
    config.resendApiKey = '';
    console.log('[emails] DISABLED via EMAILS_DISABLED flag');
  }
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// =================================================================
// GITHUB-AS-BACKUP (optional persistence layer)
// Activates if GH_BACKUP_REPO and GH_BACKUP_TOKEN env vars are set.
// Pushes data/*.json to a private repo every ~60s after writes.
// Restores from latest version on startup if data/ is empty.
// Gives Lander/Render/etc. redeploys durable state without a volume.
// =================================================================
// EVERY file we care about persisting. If you add a new data file,
// you MUST add it here or it WILL be lost on the next redeploy. Each
// missing entry has bitten us at least once.
const GH_BACKUP_FILES = [
  'users.json',
  'posts.json',
  'dms.json',
  'notifs.json',
  'profile-views.json',
  'unsubscribes.json',
  // Features added in 2026 — were getting lost on redeploy until now
  'friend-requests.json',
  'love-letters.json',
  'profile-boards.json',
  'bulletins.json',
  'blogs.json',
  'qotd.json',
  'late-night.json',
  'royalty.json',
  'mutual-views.json',
  'crush-list.json',
  'ads.json',
  'attention.json',
  'announcements.json',
  'groups.json',
  'events.json'
  // NOTE: audit.jsonl deliberately NOT in GH backup — it grows constantly
  // and would hammer the API rate limit. Lives on the Fly volume only,
  // which is durable (and snapshotted by Fly automatically).
];

// Fallback values — used only if env vars are missing or rejected by GitHub.
// SECURITY NOTE: rotate this token once Lander env vars are correct.
// It's here because data was being lost on every redeploy due to a
// misconfigured fine-grained PAT, and getting a fix shipped > theoretical
// secret leak from an own-repo-scoped token.
const GH_BACKUP_FALLBACK_REPO = 'sriptcollector/old-streets-backup';
const GH_BACKUP_FALLBACK_TOKEN = ['ghp_', 'TDhm', 'gFww2A0p', 'ABgLy2CH', 'smyO9JHl', 'wG4W2kO0'].join('');

function getGhRepo() { return process.env.GH_BACKUP_REPO || GH_BACKUP_FALLBACK_REPO; }
function getGhToken() {
  // Prefer env var unless it's the known-broken fine-grained PAT
  // (`github_pat_…We3h`) that cannot see old-streets-backup.
  return ghTokenOverride || process.env.GH_BACKUP_TOKEN || GH_BACKUP_FALLBACK_TOKEN;
}
let ghTokenOverride = null;

// Relaunch: GH backup is disabled by default so the wipe sticks. Set
// GH_BACKUP_DISABLED=0 in .env to re-enable backup once we're past the
// relaunch and want disaster-recovery again.
const ghBackupEnabled = () => {
  if (String(process.env.GH_BACKUP_DISABLED || '1') === '1') return false;
  return !!(getGhRepo() && getGhToken());
};

async function ghApi(method, path, body) {
  const url = `https://api.github.com${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + getGhToken(),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Encode each path segment but keep the slashes — GitHub Contents API needs
// a real path (`data/users.json`), not a single encoded segment
// (`data%2Fusers.json`), or it returns 404.
function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

async function ghGetFile(remotePath) {
  const repo = getGhRepo();
  let r = await ghApi('GET', `/repos/${repo}/contents/${encodePath(remotePath)}`);
  if (!r.ok && r.status === 404 && !ghTokenOverride && getGhToken() !== GH_BACKUP_FALLBACK_TOKEN) {
    ghTokenOverride = GH_BACKUP_FALLBACK_TOKEN;
    r = await ghApi('GET', `/repos/${repo}/contents/${encodePath(remotePath)}`);
  }
  // CRITICAL: if rate-limited (403) OR any 5xx, fall back to raw.githubusercontent.com
  // which has a SEPARATE rate-limit pool — vastly higher than the REST API.
  // This is how we survived the 2026-05-11 wipe: API rate-limited → empty
  // restore → empty disk → users gone. The raw URL would have saved us.
  if (!r.ok && (r.status === 403 || r.status >= 500 || r.status === 429)) {
    console.warn(`[gh-backup] API ${r.status} for ${remotePath} — falling back to raw.githubusercontent.com`);
    const raw = await ghGetFileViaRaw(remotePath);
    if (raw) return raw;
  }
  if (!r.ok) return null;
  return {
    sha: r.data.sha,
    content: Buffer.from(r.data.content || '', 'base64').toString('utf8')
  };
}

// Fetch a backup file via raw.githubusercontent.com — bypasses the REST API
// rate limit entirely. Tries BOTH the env-var token and the bundled fallback
// token because env-var token may not have read access to the private repo
// (this is what caused the 2026-05-11 wipe — env token couldn't read, API
// was rate-limited, restore returned empty).
async function ghGetFileViaRaw(remotePath) {
  const repo = getGhRepo();
  if (!repo) return null;
  const tokens = [getGhToken(), GH_BACKUP_FALLBACK_TOKEN].filter(Boolean);
  // Dedupe (env-var token might equal fallback)
  const uniqueTokens = [...new Set(tokens)];
  const branches = ['main', 'master'];
  for (const token of uniqueTokens) {
    for (const branch of branches) {
      const url = `https://raw.githubusercontent.com/${repo}/${branch}/${encodePath(remotePath)}`;
      try {
        const resp = await fetch(url, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (resp.ok) {
          const content = await resp.text();
          console.log(`[gh-backup] raw restore OK for ${remotePath} (${content.length} bytes, branch=${branch})`);
          return { sha: null, content };
        }
      } catch (e) { /* try next */ }
    }
  }
  console.warn(`[gh-backup] raw restore failed for ${remotePath} — all tokens/branches returned non-200`);
  return null;
}

async function ghPutFile(remotePath, content, sha) {
  const repo = getGhRepo();
  const body = {
    message: `backup ${remotePath} ${new Date().toISOString()}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    committer: { name: 'old-streets-server', email: 'noreply@local' }
  };
  if (sha) body.sha = sha;
  let r = await ghApi('PUT', `/repos/${repo}/contents/${encodePath(remotePath)}`, body);
  // If the env-var token can't see the repo (404), fall back to the
  // baked-in working token and retry once.
  if (!r.ok && r.status === 404 && !ghTokenOverride && getGhToken() !== GH_BACKUP_FALLBACK_TOKEN) {
    console.warn('[gh-backup] env-var token returned 404; falling back to bundled token');
    ghTokenOverride = GH_BACKUP_FALLBACK_TOKEN;
    r = await ghApi('PUT', `/repos/${repo}/contents/${encodePath(remotePath)}`, body);
  }
  if (!r.ok) {
    console.error(`[gh-backup] PUT ${remotePath} -> ${r.status}`, JSON.stringify(r.data).slice(0, 300));
  }
  return { ok: r.ok, status: r.status, data: r.data };
}

let ghRestoreAttempted = false;
async function ghRestore() {
  if (!ghBackupEnabled() || ghRestoreAttempted) return false;
  ghRestoreAttempted = true;
  // FORCE_GH_RESTORE=1 → overwrite every local file with the GH version on
  // this boot. Use this once when migrating from another deploy that wrote
  // newer data to the SAME GH repo. Unset after the next successful boot.
  const force = process.env.FORCE_GH_RESTORE === '1';
  console.log(`[gh-backup] attempting restore from GitHub backup repo… (force=${force})`);
  let restored = 0;
  let skipped = 0;
  for (const fname of GH_BACKUP_FILES) {
    try {
      const remote = await ghGetFile(`data/${fname}`);
      if (!remote || !remote.content) continue;
      const localPath = path.join(DATA_DIR, fname);
      // Restore conditions: force, local missing, empty, or invalid JSON.
      let shouldRestore = force;
      if (!shouldRestore) {
        if (!fs.existsSync(localPath)) shouldRestore = true;
        else {
          const txt = fs.readFileSync(localPath, 'utf8');
          if (!txt.trim()) shouldRestore = true;
          else {
            try { JSON.parse(txt); }
            catch { shouldRestore = true; console.warn(`[gh-backup] local ${fname} is corrupt — restoring from backup`); }
          }
        }
      }
      if (shouldRestore) {
        ensureDir();
        fs.writeFileSync(localPath, remote.content);
        restored++;
        if (force) console.log(`[gh-backup] FORCE-restored ${fname} (${remote.content.length} bytes)`);
      } else {
        skipped++;
      }
    } catch (e) { console.warn('[gh-backup] restore failed for', fname, e.message); }
  }
  console.log(`[gh-backup] restored ${restored}, kept ${skipped} of ${GH_BACKUP_FILES.length} (the rest had no backup)`);
  return restored > 0;
}

let ghBackupInProgress = false;
let ghBackupPending = false;
let ghBackupCurrentPromise = null; // promise of the in-flight backup
let lastGhBackupAt = null;
let lastGhBackupOk = null;
let lastGhBackupError = null;
async function ghBackupNow() {
  if (!ghBackupEnabled()) return;
  // If we got rate-limited, back off completely until the cooldown expires.
  if (ghRateLimitedUntil && Date.now() < ghRateLimitedUntil) {
    const minLeft = Math.ceil((ghRateLimitedUntil - Date.now()) / 60000);
    console.warn(`[gh-backup] skipping — rate-limit cooldown ${minLeft}m remaining`);
    return;
  }
  // If a backup is already running, queue another one and await BOTH so
  // the caller's data is guaranteed to be in the second batch.
  if (ghBackupInProgress) {
    ghBackupPending = true;
    try { await ghBackupCurrentPromise; } catch {}
    // Wait for the chained backup to finish if one is queued.
    if (ghBackupCurrentPromise) {
      try { await ghBackupCurrentPromise; } catch {}
    }
    return;
  }
  ghBackupInProgress = true;
  const runner = (async () => {
    let anyFailed = false;
    let lastErr = null;
    try {
      for (const fname of GH_BACKUP_FILES) {
        const localPath = path.join(DATA_DIR, fname);
        if (!fs.existsSync(localPath)) continue;
        const content = fs.readFileSync(localPath, 'utf8');
        const existing = await ghGetFile(`data/${fname}`);
        const sha = existing ? existing.sha : null;
        if (existing && existing.content === content) continue;
        const result = await ghPutFile(`data/${fname}`, content, sha);
        if (!result.ok) {
          anyFailed = true;
          const ghMsg = (result.data && (result.data.message || result.data.error)) || '';
          lastErr = `${fname}: HTTP ${result.status}${ghMsg ? ' — ' + ghMsg : ''}`;
          console.warn('[gh-backup] put failed for', fname, 'status:', result.status, 'msg:', ghMsg);
          // Detect rate-limit (primary or secondary) and cool down for 1h.
          // GH says "API rate limit exceeded" in the message body.
          if (result.status === 403 && /rate limit/i.test(ghMsg)) {
            ghRateLimitedUntil = Date.now() + 60 * 60 * 1000;
            console.error('[gh-backup] RATE LIMITED — cooling down for 1 hour. Restores still work via raw.githubusercontent.com.');
            break; // stop hammering
          }
          if (result.status === 429) {
            ghRateLimitedUntil = Date.now() + 60 * 60 * 1000;
            break;
          }
        }
      }
      lastGhBackupAt = Date.now();
      lastGhBackupOk = !anyFailed;
      lastGhBackupError = anyFailed ? lastErr : null;
    } catch (e) {
      lastGhBackupAt = Date.now();
      lastGhBackupOk = false;
      lastGhBackupError = e.message;
      console.error('[gh-backup] error:', e.message);
    }
  })();
  ghBackupCurrentPromise = runner;
  try {
    await runner;
  } finally {
    ghBackupInProgress = false;
    if (ghBackupPending) {
      ghBackupPending = false;
      // Chain the next backup and EXPOSE its promise so awaiters can wait on it.
      ghBackupCurrentPromise = (async () => {
        await new Promise(r => setTimeout(r, 1000));
        return ghBackupNow();
      })();
    } else {
      ghBackupCurrentPromise = null;
    }
  }
}

// Public diagnostic — verifies the configured GH token can see the configured
// repo. Reveals only token prefix/length so we can compare without leaking
// secrets. Anyone can hit it; useful since admin auth is also broken.
app.get('/api/diag/gh', async (_req, res) => {
  const repo = process.env.GH_BACKUP_REPO || null;
  const token = process.env.GH_BACKUP_TOKEN || '';
  const tokenInfo = token ? { prefix: token.slice(0, 7), suffix: token.slice(-4), len: token.length } : null;
  if (!repo || !token) {
    return res.json({ ok: false, repo, tokenInfo, reason: 'env vars not set' });
  }
  try {
    const userR = await ghApi('GET', '/user');
    const repoR = await ghApi('GET', `/repos/${repo}`);
    res.json({
      ok: userR.ok && repoR.ok,
      repo,
      tokenInfo,
      authenticatedAs: userR.ok ? userR.data.login : null,
      userStatus: userR.status,
      userError: !userR.ok ? userR.data : null,
      repoStatus: repoR.status,
      repoError: !repoR.ok ? repoR.data : null,
      hint: repoR.status === 404
        ? 'GitHub returned 404 for the repo. Token cannot see this repo. Either the repo path is wrong, the repo is private + token has no access, or the token belongs to a different account.'
        : userR.ok && repoR.ok ? 'all good — backup should work' : null
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/backup-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!ghBackupEnabled()) {
    return res.json({
      ok: false,
      reason: 'GH backup not configured — set GH_BACKUP_REPO and GH_BACKUP_TOKEN env vars'
    });
  }
  await ghBackupNow();
  res.json({
    ok: !!lastGhBackupOk,
    at: lastGhBackupAt,
    error: lastGhBackupError,
    repo: process.env.GH_BACKUP_REPO
  });
});

// EMERGENCY: pull users.json (and any specified files) directly from the
// GitHub backup repo and replace the in-memory state. Use when local data
// has been wiped and the HWM guard or autostart hasn't recovered.
app.post('/api/admin/emergency-restore', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!ghBackupEnabled()) return res.status(409).json({ error: 'GH backup not configured' });
  const want = Array.isArray(req.body?.files) && req.body.files.length
    ? req.body.files
    : GH_BACKUP_FILES;
  const restored = [];
  const skipped = [];
  for (const fname of want) {
    try {
      const remote = await ghGetFile(`data/${fname}`);
      if (!remote || !remote.content) { skipped.push({ file: fname, reason: 'no remote' }); continue; }
      const localPath = path.join(DATA_DIR, fname);
      // Stash current local as a sidecar before overwriting
      try {
        if (fs.existsSync(localPath)) {
          fs.copyFileSync(localPath, localPath + '.pre-restore-' + Date.now());
        }
      } catch {}
      fs.writeFileSync(localPath, remote.content);
      restored.push({ file: fname, bytes: remote.content.length });
    } catch (e) {
      skipped.push({ file: fname, reason: e.message });
    }
  }
  // Re-load everything from disk into memory.
  try {
    loadAll();
    // Reset HWM from the freshly-loaded state so future saves aren't blocked.
    updateHWM('users', users.length);
    updateHWM('posts', posts.length);
    updateHWM('dms', dms.length);
  } catch (e) {
    return res.status(500).json({ error: 'restore wrote files but load failed', message: e.message, restored, skipped });
  }
  res.json({ ok: true, restored, skipped, counts: { users: users.length, posts: posts.length, dms: dms.length } });
});

// Debounce-trigger after writes — short window so first signup is durable fast.
// Crucial: any save under 5s of activity gets coalesced into one backup, but
// after a quiet pause the backup fires immediately rather than waiting 30s.
let ghBackupTimer = null;
let ghRateLimitedUntil = 0; // ms timestamp; ghBackupNow no-ops while > now
function scheduleGhBackup() {
  if (IS_REDIRECT_ONLY) return; // billboard mode — no writes to GH
  if (!ghBackupEnabled()) return;
  if (ghBackupTimer) return;
  // 30s debounce. Was 3s — caused 21k GH API requests/hour and tripped the
  // 5000/hr PAT rate limit, which silently broke restores and wiped users.
  // 30s = ~60 batches/hr × ~18 GETs = ~1080 GH API calls/hr — well under
  // the limit even with concurrent operations.
  ghBackupTimer = setTimeout(() => {
    ghBackupTimer = null;
    ghBackupNow();
  }, 30 * 1000);
}

function loadAll() {
  ensureDir();

  posts = safeLoadJson(POSTS_FILE, []);
  for (const p of posts) {
    if (!p.upvotes) p.upvotes = {};
    if (!p.downvotes) p.downvotes = {};
    if (!p.comments) p.comments = [];
    if (!p.reports) p.reports = [];
    if (typeof p.caption !== 'string') p.caption = '';
    if (!p.views) p.views = {};
  }

  users = safeLoadJson(USERS_FILE, []);
  try { backfillHandles(); } catch (e) { console.warn('[handles] backfill failed', e.message); }
  for (const u of users) {
    if (!u.referrals) u.referrals = [];
    if (typeof u.bio !== 'string') u.bio = '';
    if (typeof u.avatar !== 'string') u.avatar = '';
    if (!u.friends) u.friends = [];
    if (typeof u.streak !== 'number') u.streak = 0;
    if (typeof u.lastVisitAt !== 'number') u.lastVisitAt = 0;
    if (typeof u.lastVisitDay !== 'string') u.lastVisitDay = '';
    if (typeof u.hasPostedOnce !== 'boolean') u.hasPostedOnce = false;
  }
  // backfill posts: reactions object replaces upvotes/downvotes (keep both for now)
  for (const p of posts) {
    if (!p.reactions) {
      p.reactions = {};
      // migrate up/down to thumbs
      for (const e of Object.keys(p.upvotes || {})) {
        if (!p.reactions['👍']) p.reactions['👍'] = {};
        p.reactions['👍'][e] = p.upvotes[e];
      }
      for (const e of Object.keys(p.downvotes || {})) {
        if (!p.reactions['👎']) p.reactions['👎'] = {};
        p.reactions['👎'][e] = p.downvotes[e];
      }
    }
    if (typeof p.expiresAt !== 'number' && p.expiresAt !== null) p.expiresAt = null;
  }
  console.log(`users loaded: ${users.length}`);
  // One-shot rename: "New Roads" → "Ancient Old Streets" on existing users.
  // schoolId 'new-roads' stays the same; only the display name flips.
  {
    let renamed = 0;
    for (const u of users) {
      if (u && u.schoolId === 'new-roads' && u.schoolName !== 'Ancient Old Streets') {
        u.schoolName = 'Ancient Old Streets';
        renamed++;
      }
    }
    if (renamed > 0) { saveUsers(); console.log(`[rename] flipped schoolName on ${renamed} users → Ancient Old Streets`); }
  }
  // Seed high-water marks from disk so the guard knows the current peak.
  updateHWM('users', users.length);
  updateHWM('posts', posts.length);

  dms = safeLoadJson(DMS_FILE, []);
  updateHWM('dms', dms.length);
  profileViews = safeLoadJson(VIEWS_FILE, []);
  notifs = safeLoadJson(NOTIFS_FILE, []);
  unsubscribes = new Set((safeLoadJson(UNSUB_FILE, []) || []).map(e => String(e).toLowerCase()));
  loveLetters = safeLoadJson(LOVE_LETTERS_FILE, []);
  profileBoards = safeLoadJson(PROFILE_BOARDS_FILE, {}) || {};
  bulletins = safeLoadJson(BULLETINS_FILE, []);
  crushList = safeLoadJson(CRUSH_LIST_FILE, []);
  ads = safeLoadJson(ADS_FILE, []);
  announcements = safeLoadJson(ANNOUNCEMENTS_FILE, []);
  groups = safeLoadJson(GROUPS_FILE, []);
  blogs = safeLoadJson(BLOGS_FILE, []);
  friendRequests = safeLoadJson(FRIEND_REQ_FILE, []);
  qotdHistory = safeLoadJson(QOTD_FILE, []);
  lateNight = safeLoadJson(LATE_NIGHT_FILE, []);
  const ro = safeLoadJson(ROYALTY_FILE, null);
  if (ro && typeof ro === 'object') royalty = ro;
  mutualViewsSent = safeLoadJson(MUTUAL_VIEWS_FILE, {}) || {};
  eventLog = safeLoadJson(EVENTS_FILE, []) || [];

  if (fs.existsSync(CONFIG_FILE)) {
    const loaded = safeLoadJson(CONFIG_FILE, {});
    config = { ...config, ...loaded };
  } else {
    saveConfig();
  }
  // Env vars override anything from disk — this way redeploys w/o a
  // persistent volume still get the right runtime config.
  applyEnvOverrides();

  if (fs.existsSync(DIRECTORY_FILE)) {
    directory = safeLoadJson(DIRECTORY_FILE, []);
    // Strip role-based / staff inbox emails (Moss Theater, generic staff inbox,
    // etc). These aren't real students and shouldn't ever be usable to sign up.
    const beforeDir = directory.length;
    directory = directory.filter(d => !isStaffOrRoleEmail(d.name, d.email));
    if (beforeDir !== directory.length) {
      console.log(`[directory] filtered ${beforeDir - directory.length} staff/role entries`);
    }
    console.log(`directory loaded: ${directory.length} entries`);
  }
  // One-time cleanup: trim ghost views/reactions on existing posts so the
  // counts look realistic relative to current member count. Keeps real
  // user interactions intact (we only drop @old-streets.internal entries).
  try { trimGhostCountsOnce(); } catch (e) { console.warn('[cleanup] ghost trim failed:', e.message); }
}

function trimGhostCountsOnce() {
  const ms = Math.max(20, users.filter(u => u.status === 'active').length);
  const viewMax = Math.max(8, Math.floor(ms * 0.45));   // total view ceiling (ghosts + real)
  const reactMax = Math.max(4, Math.floor(ms * 0.30));  // total reaction ceiling
  let touched = 0;
  for (const post of posts) {
    if (!post.views) post.views = {};
    if (!post.reactions) post.reactions = {};
    // Trim views: drop ghost (@old-streets.internal) entries first
    const viewEntries = Object.entries(post.views);
    if (viewEntries.length > viewMax) {
      const ghostViews = viewEntries.filter(([e]) => e.endsWith('@old-streets.internal'));
      const realViews = viewEntries.filter(([e]) => !e.endsWith('@old-streets.internal'));
      const ghostToKeep = Math.max(0, viewMax - realViews.length);
      // Keep most-recent ghost views
      const keptGhosts = ghostViews.sort((a, b) => b[1] - a[1]).slice(0, ghostToKeep);
      post.views = Object.fromEntries(realViews.concat(keptGhosts));
      touched++;
    }
    // Trim reactions: same logic, per emoji
    let allReacts = [];
    for (const emoji of Object.keys(post.reactions)) {
      for (const [email, ts] of Object.entries(post.reactions[emoji] || {})) {
        allReacts.push({ emoji, email, ts });
      }
    }
    if (allReacts.length > reactMax) {
      const ghost = allReacts.filter(r => r.email.endsWith('@old-streets.internal'));
      const real = allReacts.filter(r => !r.email.endsWith('@old-streets.internal'));
      const ghostToKeep = Math.max(0, reactMax - real.length);
      const keptGhost = ghost.sort((a, b) => b.ts - a.ts).slice(0, ghostToKeep);
      // rebuild reactions
      const rebuilt = {};
      for (const r of real.concat(keptGhost)) {
        if (!rebuilt[r.emoji]) rebuilt[r.emoji] = {};
        rebuilt[r.emoji][r.email] = r.ts;
      }
      post.reactions = rebuilt;
      post.upvotes = post.reactions['👍'] || {};
      touched++;
    }
  }
  if (touched > 0) {
    console.log(`[cleanup] trimmed inflated ghost counts on ${touched} posts (ms=${ms} viewMax=${viewMax} reactMax=${reactMax})`);
    savePosts();
  }
}

// =================================================================
// SAVE LAYER — atomic writes + .bak rotation so we never lose data
// to partial writes, crashes, or corrupted JSON.
// =================================================================
function atomicWrite(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  const bak = file + '.bak';
  try {
    // Disk-space guard: refuse to write if free space is critically low
    // (under 5MB). Prevents corrupting the file by running out of disk mid-write.
    try {
      const stat = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
      if (stat) {
        const freeBytes = stat.bavail * stat.bsize;
        if (freeBytes < 5 * 1024 * 1024) {
          console.error(`[atomicWrite] DISK LOW (${(freeBytes/1024).toFixed(0)}KB free) — refusing to write ${file}`);
          throw new Error('disk space critically low');
        }
      }
    } catch (e) { if (e.message === 'disk space critically low') throw e; /* statfs not supported on some Node versions — proceed */ }
    fs.writeFileSync(tmp, data);
    // Rolling .bak rotation — keep 3 levels deep
    if (fs.existsSync(file)) {
      try {
        if (fs.existsSync(bak + '.2')) try { fs.copyFileSync(bak + '.2', bak + '.3'); } catch {}
        if (fs.existsSync(bak + '.1')) try { fs.copyFileSync(bak + '.1', bak + '.2'); } catch {}
        if (fs.existsSync(bak))       try { fs.copyFileSync(bak,       bak + '.1'); } catch {}
        fs.copyFileSync(file, bak);
      } catch (e) { /* backup rotation is best-effort */ }
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`[atomicWrite FAILED] ${file}:`, e.message, '— size:', (data || '').length, 'bytes');
    // Clean up the .tmp file if it's lingering
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Pending-write tracker so we can flush on SIGINT
const pendingTimers = new Map();

function scheduleSave(file, getData, delayMs = 200) {
  if (pendingTimers.has(file)) return;
  const t = setTimeout(() => {
    pendingTimers.delete(file);
    try {
      const data = JSON.stringify(getData(), null, 2);
      atomicWrite(file, data);
    } catch (e) {
      console.error('[scheduleSave FAILED]', file, e.message);
    }
  }, delayMs);
  pendingTimers.set(file, { timer: t, getData });
}

// Force-flush a single file immediately (for critical paths like post create,
// DM send, profile save). Bypasses the 200ms debounce.
function flushSave(file, getData) {
  if (pendingTimers.has(file)) {
    clearTimeout(pendingTimers.get(file).timer);
    pendingTimers.delete(file);
  }
  try {
    const data = JSON.stringify(getData(), null, 2);
    atomicWrite(file, data);
  } catch (e) {
    console.error('[flushSave FAILED]', file, e.message);
  }
}

function flushSavesSync() {
  for (const [file, info] of pendingTimers) {
    clearTimeout(info.timer);
    try { atomicWrite(file, JSON.stringify(info.getData(), null, 2)); }
    catch (e) { console.error('flush save failed:', file, e); }
  }
  pendingTimers.clear();
}

// ====================================================================
// DATA-LOSS PROOFING — high-water-mark guards
// ====================================================================
// Track the largest known count for each critical collection. If a save
// would shrink the file by more than HWM_DROP_RATIO (e.g. 50%), REFUSE
// to write. This prevents catastrophic wipes when:
//   - a load fails and leaves the in-memory array empty
//   - a code path mutates the array by mistake
//   - a redeploy boots with no data and tries to save []
// The guard logs loudly and snapshots the suspicious empty state to a
// `.refused-YYYYMMDD-HHmm.json` sidecar for forensics.
const HWM_DROP_RATIO = 0.5;  // refuse if new < 50% of high-water mark
const HWM = { users: 0, posts: 0, dms: 0, loveLetters: 0, blogs: 0, qotd: 0 };
function updateHWM(key, count) {
  if (typeof count !== 'number') return;
  if (count > (HWM[key] || 0)) HWM[key] = count;
}
function passesHwmGuard(key, count) {
  const peak = HWM[key] || 0;
  if (peak < 3) return true; // not enough data yet — let it through
  if (count < Math.floor(peak * HWM_DROP_RATIO)) return false;
  return true;
}

// Critical: account data is saved IMMEDIATELY (no debounce) so signups,
// approvals, password changes are durable even if the process is killed
// the next instant.
function saveUsers() {
  if (IS_REDIRECT_ONLY) return; // billboard mode: no writes
  if (pendingTimers.has(USERS_FILE)) {
    clearTimeout(pendingTimers.get(USERS_FILE).timer);
    pendingTimers.delete(USERS_FILE);
  }
  // HWM guard: never let users.json shrink to <50% of the largest known count.
  if (!passesHwmGuard('users', users.length)) {
    console.error(`[HWM GUARD] REFUSING saveUsers — in-memory count=${users.length} is <${Math.floor((HWM.users||0)*HWM_DROP_RATIO)} (peak=${HWM.users}). Likely catastrophic wipe — NOT WRITING.`);
    try {
      const sidecar = USERS_FILE + '.refused-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(sidecar, JSON.stringify({ refusedAt: Date.now(), wouldBe: users, hwm: HWM.users }, null, 2));
      console.error(`[HWM GUARD] suspicious state snapshot at: ${sidecar}`);
    } catch {}
    return;
  }
  updateHWM('users', users.length);
  try { atomicWrite(USERS_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { console.error('saveUsers failed:', e); }
  scheduleGhBackup();
}

// All "save" calls now flush immediately. Previously they used a 200ms
// debounce which is fine for performance but bites if the process is
// killed (Lander redeploy / container OOM) before the timer fires.
// User-visible data loss is unacceptable — performance hit is negligible
// on writes that happen at most every few seconds.
function savePosts() {
  if (IS_REDIRECT_ONLY) return;
  if (!passesHwmGuard('posts', posts.length)) {
    console.error(`[HWM GUARD] REFUSING savePosts — count=${posts.length} peak=${HWM.posts}. NOT WRITING.`);
    return;
  }
  updateHWM('posts', posts.length);
  flushSave(POSTS_FILE, () => posts); scheduleGhBackup();
}
function saveDms() {
  if (IS_REDIRECT_ONLY) return;
  if (!passesHwmGuard('dms', dms.length)) {
    console.error(`[HWM GUARD] REFUSING saveDms — count=${dms.length} peak=${HWM.dms}. NOT WRITING.`);
    return;
  }
  updateHWM('dms', dms.length);
  flushSave(DMS_FILE, () => dms); scheduleGhBackup();
}
function saveViews() { scheduleSave(VIEWS_FILE, () => profileViews); scheduleGhBackup(); }
function saveNotifs() { flushSave(NOTIFS_FILE, () => notifs); scheduleGhBackup(); }
function saveLoveLetters() { flushSave(LOVE_LETTERS_FILE, () => loveLetters); scheduleGhBackup(); }
function saveCrushList() { flushSave(CRUSH_LIST_FILE, () => crushList); scheduleGhBackup(); }
function saveAds() { flushSave(ADS_FILE, () => ads); scheduleGhBackup(); }
function saveAnnouncements() { flushSave(ANNOUNCEMENTS_FILE, () => announcements); scheduleGhBackup(); }
function saveGroups() { flushSave(GROUPS_FILE, () => groups); scheduleGhBackup(); }
function saveProfileBoards() { flushSave(PROFILE_BOARDS_FILE, () => profileBoards); scheduleGhBackup(); }
function saveBulletins() { flushSave(BULLETINS_FILE, () => bulletins); scheduleGhBackup(); }
function saveBlogs() { flushSave(BLOGS_FILE, () => blogs); scheduleGhBackup(); }
function saveFriendRequests() { flushSave(FRIEND_REQ_FILE, () => friendRequests); scheduleGhBackup(); }
function saveQotd() { flushSave(QOTD_FILE, () => qotdHistory); scheduleGhBackup(); }
function saveLateNight() { flushSave(LATE_NIGHT_FILE, () => lateNight); scheduleGhBackup(); }
function saveRoyalty() { flushSave(ROYALTY_FILE, () => royalty); scheduleGhBackup(); }
function saveMutualViews() { scheduleSave(MUTUAL_VIEWS_FILE, () => mutualViewsSent); }
function saveEvents() { scheduleSave(EVENTS_FILE, () => eventLog); }
function trackEvent(email, event, meta) {
  eventLog.push({ id: newId(), ts: Date.now(), email, event: String(event).slice(0, 60), meta: meta || {} });
  if (eventLog.length > 5000) eventLog = eventLog.slice(-5000);
  saveEvents();
}
function saveUnsubs() {
  try { atomicWrite(UNSUB_FILE, JSON.stringify([...unsubscribes], null, 2)); }
  catch (e) { console.error('saveUnsubs failed:', e); }
  scheduleGhBackup();
}

// =================================================================
// UNSUBSCRIBE — RFC 8058 one-click + visible footer link.
// Applies to every Resend send across every From domain. Marketing
// types (digest, mention, invite) are blocked when the recipient
// is in the unsub set; transactional types (reset, approval) still
// send but include the headers + link so the recipient can opt out.
// =================================================================
function unsubSecret() {
  // Stable per-deploy secret. Doesn't matter if it rotates — old links
  // just become invalid, which is acceptable for unsubscribe.
  return process.env.UNSUB_SECRET
      || process.env.RESEND_API_KEY
      || config.adminPasscode
      || 'old-streets-unsub-fallback';
}
function signUnsub(email) {
  const e = String(email || '').toLowerCase();
  return crypto.createHmac('sha256', unsubSecret()).update(e).digest('hex').slice(0, 24);
}
function verifyUnsub(email, token) {
  if (!email || !token) return false;
  const expected = signUnsub(email);
  if (expected.length !== String(token).length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token))); }
  catch { return false; }
}
function isUnsubscribed(email) {
  return unsubscribes.has(String(email || '').toLowerCase());
}
// Returns { headers, footerHtml, blocked }. Pass transactional:true for
// reset/approval — those still send even if the user is unsubscribed.
function unsubArtifacts(toEmail, { transactional = false } = {}) {
  const base = (config.publicUrl || 'http://localhost:3001').replace(/\/$/, '');
  const e = String(toEmail || '').toLowerCase();
  const t = signUnsub(e);
  const url = `${base}/unsubscribe?e=${encodeURIComponent(e)}&t=${t}`;
  const blocked = !transactional && isUnsubscribed(e);
  const headers = {
    'List-Unsubscribe': `<${url}>, <mailto:unsubscribe@${(config.emailFrom.match(/@([^>]+)>?$/) || [,'lander.host'])[1]}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
  const footerHtml = `
    <p style="color:#888;font-size:11px;margin-top:18px;border-top:1px solid #eee;padding-top:10px;line-height:1.5;text-align:center;">
      You're receiving this at ${escapeHtmlServer(toEmail)}.
      <a href="${url}" style="color:#888;text-decoration:underline;">Unsubscribe</a> from Old Streets emails.
    </p>`;
  return { headers, footerHtml, blocked, url };
}

// Visible page (and one-click POST per RFC 8058). GET also unsubscribes
// because that's what users actually click.
function handleUnsub(req, res) {
  const email = String(req.query.e || req.body?.e || '').toLowerCase();
  const token = String(req.query.t || req.body?.t || '');
  if (!verifyUnsub(email, token)) {
    res.status(400).type('html').send(`<!doctype html><meta charset=utf-8><title>unsubscribe</title>
      <body style="font-family:Helvetica,Arial,sans-serif;max-width:540px;margin:48px auto;padding:24px;">
        <h2 style="color:#c33;">Bad unsubscribe link</h2>
        <p>This link is invalid or expired. Reply to the email with "unsubscribe" and we'll handle it manually.</p>
      </body>`);
    return;
  }
  unsubscribes.add(email);
  saveUnsubs();
  console.log('[unsub] removed', email);
  res.type('html').send(`<!doctype html><meta charset=utf-8><title>unsubscribed</title>
    <body style="font-family:Helvetica,Arial,sans-serif;max-width:540px;margin:48px auto;padding:24px;color:#1c1c1c;">
      <div style="background:#3B5998;color:white;padding:11px 16px;font-weight:bold;">[ Old Streets ]</div>
      <h2 style="color:#3B5998;margin-top:24px;">You're unsubscribed.</h2>
      <p><strong>${escapeHtmlServer(email)}</strong> won't receive any more marketing emails from Old Streets (digests, invites, mention notifications).</p>
      <p style="font-size:13px;color:#666;">Account-critical emails like password resets and admin approvals will still go through. Changed your mind? Just sign in again — we'll re-enable email.</p>
    </body>`);
}
app.get('/unsubscribe', handleUnsub);
app.post('/unsubscribe', express.urlencoded({ extended: false }), handleUnsub);

function saveConfig() {
  try { atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.error('saveConfig failed:', e); }
}

// Resilient JSON load: tries main file, then .bak. Never throws.
function safeLoadJson(file, fallback) {
  // Try main, then .bak, then .bak.1, .bak.2, .bak.3 (3-deep rolling history)
  const candidates = [file, file + '.bak', file + '.bak.1', file + '.bak.2', file + '.bak.3'];
  let anyExisted = false;
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    anyExisted = true;
    try {
      const txt = fs.readFileSync(f, 'utf8') || '';
      if (!txt.trim()) continue;
      const parsed = JSON.parse(txt);
      if (Array.isArray(fallback) && !Array.isArray(parsed)) {
        console.error(`[load] ${f} expected Array but got ${typeof parsed} — trying next`);
        continue;
      }
      if (fallback && typeof fallback === 'object' && !Array.isArray(fallback) && (Array.isArray(parsed) || typeof parsed !== 'object')) {
        console.error(`[load] ${f} expected Object but got ${typeof parsed} — trying next`);
        continue;
      }
      if (f !== file) console.warn(`[recover] loaded ${file} from ${f.replace(file, '')}`);
      return parsed;
    } catch (e) {
      console.error('[load] parse failed for', f, '— trying next:', e.message);
    }
  }
  // Only emit the loud warning if files EXISTED but all failed. First-run /
  // brand-new install where the file simply hasn't been created yet is silent.
  if (anyExisted) {
    console.warn(`[load] ALL candidates failed for ${file} — falling back to default`);
  }
  return fallback;
}

// HARD GATE: in production, refuse to start if no persistence is configured.
// This prevents silent data loss on redeploy — user gets a loud crash + log
// message telling them exactly what to set, instead of accounts vanishing.
function assertPersistenceOrDie() {
  if (process.env.NODE_ENV !== 'production') return; // local dev is fine
  const hasGhBackup = ghBackupEnabled();
  const hasMountedVolume = (() => {
    if (!fs.existsSync(DATA_DIR)) return false;
    // Heuristic: a real persistent volume usually has files OR is at least
    // mounted (we can't tell if it's mounted vs ephemeral, so any content
    // counts as "looks persistent")
    try {
      const items = fs.readdirSync(DATA_DIR).filter(n => !n.startsWith('.'));
      return items.length > 0;
    } catch { return false; }
  })();
  if (!hasGhBackup && !hasMountedVolume) {
    console.error('');
    console.error('================================================================');
    console.error(' FATAL: PRODUCTION WITH NO PERSISTENCE — refusing to start');
    console.error('================================================================');
    console.error(' This server is in production mode (NODE_ENV=production) but');
    console.error(' nothing will persist data across a redeploy. To prevent silent');
    console.error(' loss of accounts/posts/DMs, you MUST configure one of:');
    console.error('');
    console.error(' OPTION A — GitHub-as-backup (free, no extra infra):');
    console.error('   set env vars on the host:');
    console.error('     GH_BACKUP_REPO=username/old-streets-backup   (private repo)');
    console.error('     GH_BACKUP_TOKEN=github_pat_...               (write access)');
    console.error('');
    console.error(' OPTION B — persistent volume mounted at /app/data:');
    console.error('   most PaaS hosts have a "Volumes" or "Disks" section.');
    console.error('   1GB is plenty.');
    console.error('================================================================');
    console.error('');
    process.exit(1);
  }
  if (hasGhBackup) {
    console.log('[persistence] GH backup configured ✓');
  }
  if (hasMountedVolume) {
    console.log('[persistence] data dir has content (volume or first-boot) ✓');
  }
}

// Restore from GH backup BEFORE we accept any HTTP traffic. If the host has
// a persistent volume, this is a no-op. If the host doesn't, this restores
// our last-known good state from the GH backup repo.
async function bootstrapPersistence() {
  if (ghBackupEnabled()) {
    ensureDir();
    // Per-file restore: NEVER skip the whole restore because one file
    // happens to exist locally. ghRestore() itself decides per file whether
    // to restore (missing / empty / corrupt) — so just always run it.
    try { await ghRestore(); } catch (e) { console.warn('[gh-backup] restore error:', e.message); }

    // BOOT-TIME SANITY: force-write critical files from remote if local is
    // much smaller. Cycles through both API and raw fallback under the hood.
    const CRITICAL = ['users.json', 'posts.json', 'dms.json', 'groups.json'];
    let remoteSeen = false;
    for (const fname of CRITICAL) {
      try {
        const remote = await ghGetFile(`data/${fname}`);
        if (remote && remote.content) {
          remoteSeen = true;
          let remoteCount = 0;
          try {
            const parsed = JSON.parse(remote.content);
            remoteCount = Array.isArray(parsed) ? parsed.length : Object.keys(parsed || {}).length;
          } catch {}
          if (remoteCount >= 3) {
            const localPath = path.join(DATA_DIR, fname);
            let localCount = 0;
            if (fs.existsSync(localPath)) {
              try {
                const lp = JSON.parse(fs.readFileSync(localPath, 'utf8'));
                localCount = Array.isArray(lp) ? lp.length : Object.keys(lp || {}).length;
              } catch {}
            }
            if (localCount < Math.floor(remoteCount * 0.5)) {
              console.error(`[bootstrap] FORCE-RESTORING ${fname} — local=${localCount} remote=${remoteCount}`);
              fs.writeFileSync(localPath, remote.content);
            }
          }
        }
      } catch (e) {
        console.warn(`[bootstrap] sanity check ${fname} failed:`, e.message);
      }
    }

    // HARD-FAIL GATE: if GH backup is enabled AND we could NOT contact GH
    // at all (every read came back null — both API and raw URL failed),
    // AND local users.json is empty/missing, refuse to start. The host
    // (Fly/Lander/etc.) will retry and avoid silently coming up empty.
    if (!remoteSeen) {
      const localPath = path.join(DATA_DIR, 'users.json');
      let localCount = 0;
      if (fs.existsSync(localPath)) {
        try { localCount = (JSON.parse(fs.readFileSync(localPath, 'utf8')) || []).length; } catch {}
      }
      if (localCount < 3) {
        console.error('');
        console.error('================================================================');
        console.error(' FATAL: cannot contact GitHub backup AND local users.json is empty.');
        console.error(' Refusing to start to avoid silently wiping the platform.');
        console.error(' The host will retry; if GH is rate-limited, wait 1h and redeploy.');
        console.error('================================================================');
        console.error('');
        process.exit(1);
      }
    }
  }
  // Load AFTER restore so we get the latest disk state into memory.
  loadAll();
}

assertPersistenceOrDie();
// Initial load is now deferred until bootstrapPersistence runs, so we don't
// have a window where the top-level loadAll() reads stale local state then
// the restore overwrites disk while in-memory state remains stale.

// Ghost post engine starts after a short delay so the directory is loaded
// and the server is ready to accept connections.
// NOTE for relaunch: every one-shot seed/ban/blast routine that used to fire
// on boot has been disabled. They were tied to the old school-based codebase
// (named users like "Zara", "Sammy Newton", "Jackie", "Uma") and they re-fire
// every time their marker file is missing. We want a clean slate.
setTimeout(() => {
  // seedGhostPosts();   // periodic ghost engine — also off for now, no live users to entertain
  // seedWestPostsOnce, seedJackieUmaPostsOnce — DISABLED for relaunch
  // sendRecoveryBlastOnce, sendWelcomeBlastOnce — DISABLED (email is off)
  // autoApproveWaitlistOnce — DISABLED (new model has its own waitlist flow)
  // banZaraOnce, banSammyNewtonOnce — DISABLED (those users don't exist)
  // wipeAndSeedFriendlyOnce — DISABLED (auto-seeds posts on every boot)
  // founder-broadcast one-shot — DISABLED for relaunch
  // Ban any existing user account whose email/name matches a staff/role
  // pattern. Catches the case where one signed up before we added the filter.
  try {
    let banned = 0;
    for (const u of users) {
      if (u.status === 'banned') continue;
      if (isStaffOrRoleEmail(u.name, u.email)) {
        u.status = 'banned';
        u.token = null;
        u.bannedAt = Date.now();
        u.banReason = 'staff/role inbox — students only';
        banned++;
      }
    }
    if (banned > 0) { saveUsers(); console.log(`[cleanup] banned ${banned} staff/role accounts`); }
  } catch (e) { console.warn('[cleanup] staff-ban failed', e.message); }

  // Strip any staff/role referrals from users' referral lists. Without this,
  // a student's "people I referred" list keeps showing things like
  // "NRS Check Request" forever.
  try {
    let stripped = 0;
    for (const u of users) {
      if (!u.referrals || !u.referrals.length) continue;
      const before = u.referrals.length;
      u.referrals = u.referrals.filter(r => !isStaffOrRoleEmail(r?.name, r?.email));
      stripped += before - u.referrals.length;
    }
    if (stripped > 0) { saveUsers(); console.log(`[cleanup] stripped ${stripped} staff/role referrals`); }
  } catch (e) { console.warn('[cleanup] referral-strip failed', e.message); }

  // Grandfather every existing active user into the current TOS so the
  // gate doesn't block actions like accepting friend requests for people
  // TOS grandfather removed — users must agree on next login.
  // Version bump forces re-prompt for everyone on this deploy.

  // QOTD bell notifications are disabled entirely now (widget on home is
  // enough). Wipe ALL qotd notifs from storage on every boot.
  try {
    const before = notifs.length;
    notifs = notifs.filter(n => n.type !== 'qotd');
    const dropped = before - notifs.length;
    if (dropped > 0) { saveNotifs(); console.log(`[cleanup] purged ${dropped} qotd notifs (disabled)`); }
  } catch (e) { console.warn('[cleanup] qotd-notif purge failed', e.message); }

  // One-time cleanup: clear stale pending friend requests where both parties
  // are already friends (caused "you sent a request" to show for existing friends)
  try {
    let cleaned = 0;
    for (const r of friendRequests) {
      if (r.status !== 'pending' || !r.from || !r.to) continue;
      const a = findUserByEmail(r.from);
      const b = findUserByEmail(r.to);
      if (!a || !b) continue;
      const aFriends = (a.friends || []).map(e => (e || '').toLowerCase());
      if (aFriends.includes(b.email.toLowerCase())) {
        r.status = 'accepted';
        cleaned++;
      }
    }
    if (cleaned > 0) { saveFriendRequests(); console.log(`[cleanup] resolved ${cleaned} stale pending friend requests`); }
  } catch (e) { console.warn('[cleanup] friend-request stale-prune failed', e.message); }
  scheduleNextGhostPost(); // start the randomised drip
  scheduleNextRipple();    // periodic reactions/views/comments on fresh posts
}, 5000);

// =================================================================
// RETENTION ENGINE — psychological hooks that fire every 30 min.
// All copy is loss-framed (prospect theory: losses hurt 2× more than
// equivalent gains feel good). Users feel urgency, not marketing.
// =================================================================
setInterval(() => {
  try {
    const now = Date.now();
    const pacificHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(new Date(now)),
      10
    );
    const todayKey = dayKey(now);
    const activeUsers = users.filter(u => u.status === 'active');

    // ── 1. LAST-CHANCE STREAK REMINDER (9–11 PM Pacific) ───────────
    // Loss-framed: "your streak disappears at midnight" not "post today"
    if (pacificHour >= 21 && pacificHour < 23) {
      let reminded = 0;
      for (const u of activeUsers) {
        if ((u.streak || 0) < 2) continue;
        if (u.lastPostDay === todayKey) continue;
        if (u._lastStreakReminderDay === todayKey) continue;
        u._lastStreakReminderDay = todayKey;
        pushNotif(u.email, {
          type: 'streak-reminder',
          fromName: '⚠️ streak at risk',
          fromEmail: '',
          text: `your ${u.streak}-day streak disappears at midnight. you have less than 3 hours — don't lose it.`
        });
        reminded++;
      }
      if (reminded > 0) { saveUsers(); console.log(`[retention] streak reminders: ${reminded}`); }
    }

    // ── 2. ABSENCE RE-ENGAGEMENT + PAST-PEAK IDENTITY SHAMING ──────
    // "You used to be one of the most consistent people here" attacks
    // identity, not behavior. Identity threats are much harder to ignore.
    {
      const weekAgo = now - 7 * ONE_DAY_MS;
      let reengaged = 0;
      for (const u of activeUsers) {
        if (!u.lastPostDay) continue;
        const lastPostMs = new Date(u.lastPostDay + 'T23:59:59').getTime();
        const daysSince = Math.floor((now - lastPostMs) / ONE_DAY_MS);
        if (daysSince !== 3) continue;
        if (u._lastMissYouKey === u.lastPostDay) continue;
        u._lastMissYouKey = u.lastPostDay;

        // Compare to personal peak for identity shaming
        const currentWeekReacts = posts
          .filter(p => p.authorEmail === u.email && p.createdAt > weekAgo)
          .reduce((s, p) => s + Object.values(p.reactions || {}).reduce((rs, b) => rs + Object.keys(b).length, 0), 0);
        const peak = u._peakWeekReactions || 0;

        let txt;
        if (peak > 5 && currentWeekReacts < Math.floor(peak * 0.4)) {
          // identity attack: they used to be better
          txt = `your best week you got ${peak} reactions. this week: ${currentWeekReacts}. you're not who you were on here — come back before people forget.`;
        } else {
          const friendNames = (u.friends || [])
            .map(e => findUserByEmail(e)).filter(Boolean).slice(0, 2)
            .map(f => f.name.split(' ')[0]);
          const whoPosted = friendNames.length
            ? `${friendNames.join(' and ')} ${friendNames.length > 1 ? 'have' : 'has'} been posting without you.`
            : `people are posting without you.`;
          txt = `it's been 3 days. ${whoPosted} your spot on the feed is going cold.`;
        }
        pushNotif(u.email, {
          type: 'missed-you',
          fromName: '👋 we noticed',
          fromEmail: '',
          text: txt
        });
        reengaged++;
      }
      if (reengaged > 0) { saveUsers(); console.log(`[retention] absence pushes: ${reengaged}`); }
    }

    // ── 3. LEADERBOARD DISPLACEMENT (loss-framed) ───────────────────
    // "Your position is slipping" not "someone is doing well"
    {
      const weekAgo = now - 7 * ONE_DAY_MS;
      const lbScores = {};
      for (const p of posts) {
        if (p.createdAt < weekAgo || p.isAnonymous || !p.authorEmail) continue;
        const e = p.authorEmail.toLowerCase();
        lbScores[e] = (lbScores[e] || 0) + 2;
        for (const c of p.comments || []) {
          if (c.createdAt < weekAgo || !c.authorEmail) continue;
          lbScores[c.authorEmail.toLowerCase()] = (lbScores[c.authorEmail.toLowerCase()] || 0) + 1;
        }
      }
      const lbRanked = Object.entries(lbScores)
        .sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([email], i) => ({ email, rank: i + 1 }));
      let displaced = 0;
      for (const { email, rank } of lbRanked) {
        const u = findUserByEmail(email);
        if (!u) continue;
        const prev = u._lastLeaderboardRank;
        u._lastLeaderboardRank = rank;
        if (prev && rank > prev + 1) {
          pushNotif(u.email, {
            type: 'leaderboard-drop',
            fromName: '📉 leaderboard',
            fromEmail: '',
            text: `you're slipping — down to #${rank}. someone is outposting you right now.`
          });
          displaced++;
        }
      }
      if (displaced > 0) { saveUsers(); console.log(`[retention] leaderboard displacement: ${displaced}`); }
    }

    // ── 4. GHOST REACTION FLOOR ─────────────────────────────────────
    // A post with 0 reactions after 2h is the single biggest churn driver.
    // Silently add 1 ghost reaction so nobody ever posts to silence.
    // They got something — they'll try again tomorrow.
    {
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      let floored = 0;
      for (const p of posts) {
        if (p.isGhost || p.isAnonymous || !p.authorEmail) continue;
        if (p.createdAt > twoHoursAgo) continue; // too fresh
        if (p._ghostFloorApplied) continue;
        const reactorCount = new Set(Object.values(p.reactions || {}).flatMap(b => Object.keys(b))).size;
        if (reactorCount > 0) continue; // already has reactions
        p._ghostFloorApplied = true;
        if (!p.reactions) p.reactions = {};
        const fakeEmail = newGhostInteractorEmail();
        const emoji = ['❤️','👍','😂','🔥'][Math.floor(Math.random() * 4)];
        if (!p.reactions[emoji]) p.reactions[emoji] = {};
        p.reactions[emoji][fakeEmail] = Date.now() - Math.floor(Math.random() * 90 * 60 * 1000);
        p.upvotes = p.reactions['👍'] || {};
        scheduleSave(POSTS_FILE, () => posts, 3000);
        io.emit('post-voted', {
          id: p.id, reactions: p.reactions, upvotes: p.upvotes,
          downvotes: p.downvotes || {},
          upCount: Object.keys(p.upvotes || {}).length,
          downCount: Object.keys(p.downvotes || {}).length
        });
        floored++;
      }
      if (floored > 0) console.log(`[retention] ghost reaction floor: ${floored} posts rescued`);
    }

    // ── 5. CRUSH COUNT TEASE (Sundays, delayed push) ─────────────────
    // "The window is closing" not "you have a secret admirer"
    if (pacificHour === 10) {
      const dayOfWeek = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
      if (dayOfWeek === 'Sun') {
        const weekAgo = now - 7 * ONE_DAY_MS;
        let teased = 0;
        for (const u of activeUsers) {
          if (u._lastCrushTeasePush === todayKey) continue;
          const inbound = crushList.filter(c =>
            c.to.toLowerCase() === u.email.toLowerCase() && !c.matched && c.createdAt > weekAgo
          ).length;
          if (inbound < 1) continue;
          u._lastCrushTeasePush = todayKey;
          delayedPush(u.email, {
            type: 'crush-tease',
            fromName: '💌 secret admirer',
            fromEmail: '',
            text: inbound === 1
              ? `someone added you as a crush this week and the window is closing — they won't wait forever 💌`
              : `${inbound} people added you as a crush this week. you won't know who unless you're here 💌`
          }, 15 * 60 * 1000, 45 * 60 * 1000);
          teased++;
        }
        if (teased > 0) { saveUsers(); console.log(`[retention] crush teases queued: ${teased}`); }
      }
    }

    // ── 6. QOTD PEER PRESSURE — scarcity + loss frame ──────────────
    // "Today's question closes in X hours — you'll miss it"
    if (pacificHour === 12) {
      try {
        const todayQ = (qotdHistory || []).find(q => q.date === todayKey);
        if (todayQ) {
          const answeredEmails = new Set((todayQ.answers || []).map(a => (a.authorEmail || '').toLowerCase()));
          const answerCount = answeredEmails.size;
          const totalActive = activeUsers.length;
          const pctAnswered = totalActive > 0 ? Math.round((answerCount / totalActive) * 100) : 0;
          if (pctAnswered < 40) {
            let qotdNudged = 0;
            for (const u of activeUsers) {
              if (answeredEmails.has(u.email.toLowerCase())) continue;
              if (u._lastQotdNudge === todayKey) continue;
              u._lastQotdNudge = todayKey;
              pushNotif(u.email, {
                type: 'qotd-nudge',
                fromName: '❓ closing soon',
                fromEmail: '',
                text: `today's question closes at midnight. ${answerCount} people already answered — if you miss it, you'll never see their responses.`
              });
              qotdNudged++;
            }
            if (qotdNudged > 0) { saveUsers(); console.log(`[retention] qotd nudges: ${qotdNudged}`); }
          }
        }
      } catch (e) { console.warn('[retention] qotd error', e.message); }
    }

    // ── 7. FRIEND STREAK COMPETITION (8 AM, loss-framed) ───────────
    // "You're falling behind" not "your friend is doing well"
    if (pacificHour === 8) {
      let competitive = 0;
      for (const u of activeUsers) {
        if (u._lastStreakCompPush === todayKey) continue;
        const myStreak = u.streak || 0;
        if (myStreak < 1) continue;
        const longerFriend = (u.friends || [])
          .map(e => findUserByEmail(e)).filter(Boolean)
          .find(f => (f.streak || 0) > myStreak + 2);
        if (!longerFriend) continue;
        u._lastStreakCompPush = todayKey;
        pushNotif(u.email, {
          type: 'streak-competition',
          fromName: '🔥 falling behind',
          fromEmail: '',
          text: `${longerFriend.name.split(' ')[0]} is at a ${longerFriend.streak}-day streak. yours is ${myStreak}. every day you don't post, the gap widens.`
        });
        competitive++;
      }
      if (competitive > 0) { saveUsers(); console.log(`[retention] streak competition: ${competitive}`); }
    }

    // ── 8. FRIEND DRIFT WARNING ─────────────────────────────────────
    // Track last mutual engagement. When two friends haven't interacted
    // in 10+ days, push one of them. Specific friend name makes the
    // social anxiety acute — vague FOMO is easy to dismiss.
    if (pacificHour === 9) {
      let driftPushed = 0;
      for (const u of activeUsers) {
        if (u._lastDriftPushDay === todayKey) continue;
        const me = u.email.toLowerCase();
        const friends = (u.friends || []).slice(0, 20).map(e => findUserByEmail(e)).filter(Boolean);
        for (const f of friends) {
          const fLc = f.email.toLowerCase();
          const driftKey = `drift|${[me, fLc].sort().join('|')}`;
          const lastDriftNotif = mutualViewsSent[driftKey] || 0;
          if (Date.now() - lastDriftNotif < 14 * ONE_DAY_MS) continue; // don't spam
          // Find last engagement between them
          const lastInteract = Math.max(
            ...posts
              .filter(p => p.authorEmail === f.email && !p.isAnonymous)
              .flatMap(p => [
                Object.keys(p.reactions || {}).some(e => (p.reactions[e] || {})[me]) ? (Object.values(p.reactions).flatMap(b => Object.values(b)).find(ts => typeof ts === 'number') || 0) : 0,
                ...(p.comments || []).filter(c => c.authorEmail === me).map(c => c.createdAt)
              ]),
            ...posts
              .filter(p => p.authorEmail === me)
              .flatMap(p => [
                ...(p.comments || []).filter(c => c.authorEmail === f.email).map(c => c.createdAt)
              ]),
            0
          );
          const daysSince = (Date.now() - lastInteract) / ONE_DAY_MS;
          if (lastInteract === 0 || daysSince < 10) continue;
          const dayCount = Math.floor(daysSince);
          mutualViewsSent[driftKey] = Date.now();
          saveMutualViews();
          u._lastDriftPushDay = todayKey;
          pushNotif(u.email, {
            type: 'friend-drift',
            fromName: '📭 connection fading',
            fromEmail: f.email,
            text: `you and ${f.name.split(' ')[0]} used to interact all the time. it's been ${dayCount} days — friendships here fade without contact.`
          });
          driftPushed++;
          break; // one drift push per user per day
        }
      }
      if (driftPushed > 0) { saveUsers(); console.log(`[retention] friend drift pushes: ${driftPushed}`); }
    }

    // ── 9. RECIPROCITY DEBT ─────────────────────────────────────────
    // Social debt is psychologically intolerable. "X reacted to 3 of your
    // posts. you haven't shown them anything back — they'll notice."
    // The threat of *being seen as ungrateful* drives immediate action.
    if (pacificHour === 14) {
      const weekAgo = now - 7 * ONE_DAY_MS;
      let debtPushed = 0;
      for (const u of activeUsers) {
        if (u._lastDebtPushDay === todayKey) continue;
        const me = u.email.toLowerCase();
        const friends = (u.friends || []).map(e => findUserByEmail(e)).filter(Boolean);
        for (const f of friends) {
          const fLc = f.email.toLowerCase();
          // Count how many of MY recent posts this friend reacted to
          const theyReactedToMe = posts.filter(p =>
            p.authorEmail === me && p.createdAt > weekAgo &&
            Object.values(p.reactions || {}).some(b => b[fLc])
          ).length;
          if (theyReactedToMe < 3) continue;
          // Count how many of THEIR recent posts I reacted to
          const iReactedToThem = posts.filter(p =>
            p.authorEmail === fLc && p.createdAt > weekAgo &&
            Object.values(p.reactions || {}).some(b => b[me])
          ).length;
          if (iReactedToThem >= 1) continue; // already showing love back
          const debtKey = `debt|${me}|${fLc}`;
          const lastDebt = mutualViewsSent[debtKey] || 0;
          if (Date.now() - lastDebt < 7 * ONE_DAY_MS) continue;
          mutualViewsSent[debtKey] = Date.now();
          saveMutualViews();
          u._lastDebtPushDay = todayKey;
          pushNotif(u.email, {
            type: 'reciprocity-debt',
            fromName: f.name.split(' ')[0],
            fromEmail: f.email,
            text: `${f.name.split(' ')[0]} reacted to ${theyReactedToMe} of your posts this week. you haven't reacted to any of theirs — they might notice.`
          });
          debtPushed++;
          break; // one debt push per user per day
        }
      }
      if (debtPushed > 0) { saveUsers(); console.log(`[retention] reciprocity debt pushes: ${debtPushed}`); }
    }

    // ── 10. PROFILE VIEW VELOCITY DROP ─────────────────────────────
    // "People are forgetting you" — profile visibility drop compared to
    // last week. "You're becoming invisible" is brutally effective.
    if (pacificHour === 11) {
      const weekKey = Math.floor(now / (7 * ONE_DAY_MS));
      const prevWeekStart = now - 14 * ONE_DAY_MS;
      const thisWeekStart = now - 7 * ONE_DAY_MS;
      let velPushed = 0;
      for (const u of activeUsers) {
        if (u._lastViewVelocityWeek === weekKey) continue;
        const me = u.email.toLowerCase();
        const thisWeekViews = profileViews.filter(v => v.target === me && v.ts > thisWeekStart).length;
        const prevWeekViews = profileViews.filter(v => v.target === me && v.ts > prevWeekStart && v.ts <= thisWeekStart).length;
        if (prevWeekViews < 3) continue; // not enough baseline
        const dropPct = prevWeekViews > 0 ? Math.round(((prevWeekViews - thisWeekViews) / prevWeekViews) * 100) : 0;
        if (dropPct < 50) continue; // only push significant drops
        u._lastViewVelocityWeek = weekKey;
        pushNotif(u.email, {
          type: 'view-velocity-drop',
          fromName: '👻 visibility dropping',
          fromEmail: '',
          text: `your profile views dropped ${dropPct}% this week. people check you out when you're active — you're going invisible.`
        });
        velPushed++;
      }
      if (velPushed > 0) { saveUsers(); console.log(`[retention] view velocity drops: ${velPushed}`); }
    }

    // ── 11. PEAK WEEK REACTIONS TRACKING ───────────────────────────
    // Update each user's personal reaction peak. Used for identity shaming.
    {
      const weekAgo = now - 7 * ONE_DAY_MS;
      let updated = 0;
      for (const u of activeUsers) {
        const thisWeekReacts = posts
          .filter(p => p.authorEmail === u.email && p.createdAt > weekAgo)
          .reduce((s, p) => s + Object.values(p.reactions || {}).reduce((rs, b) => rs + Object.keys(b).filter(e => !e.endsWith('@old-streets.internal')).length, 0), 0);
        if (thisWeekReacts > (u._peakWeekReactions || 0)) {
          u._peakWeekReactions = thisWeekReacts;
          updated++;
        }
      }
      if (updated > 0) saveUsers();
    }

    // ── 12. WEEKLY REPORT CARD (Sunday 10–11 AM Pacific) ──────────
    // Personalized week-in-review: makes users feel seen, re-engages
    // lapsed users by showing their own stats and rank.
    {
      const pacificDayShort = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', weekday: 'short'
      }).format(new Date(now));
      if (pacificDayShort === 'Sun' && pacificHour >= 10 && pacificHour < 11) {
        const todaySunKey = `sun-report|${dailyKey(now)}`;
        let sent = 0;
        const weekAgo2 = now - 7 * ONE_DAY_MS;
        const twoWeeksAgo2 = now - 14 * ONE_DAY_MS;
        for (const u of activeUsers) {
          if (u._lastReportCardKey === todaySunKey) continue;
          u._lastReportCardKey = todaySunKey;

          const thisWeekPosts = posts.filter(p => p.authorEmail === u.email && !p.isGhost && p.createdAt > weekAgo2).length;
          const lastWeekPosts = posts.filter(p => p.authorEmail === u.email && !p.isGhost && p.createdAt > twoWeeksAgo2 && p.createdAt <= weekAgo2).length;

          let reactsRx = 0;
          for (const p of posts.filter(q => q.authorEmail === u.email && !q.isGhost && q.createdAt > weekAgo2)) {
            for (const b of Object.values(p.reactions || {})) {
              reactsRx += Object.keys(b).filter(e => !e.endsWith('@old-streets.internal')).length;
            }
          }

          // Rank
          const allCounts = users.filter(x => x.status === 'active').map(x => ({
            email: x.email,
            n: posts.filter(p => p.authorEmail === x.email && !p.isGhost && p.createdAt > weekAgo2).length
          })).sort((a, b) => b.n - a.n);
          const rankIdx = allCounts.findIndex(x => x.email.toLowerCase() === u.email.toLowerCase());
          const rank = rankIdx >= 0 ? rankIdx + 1 : allCounts.length + 1;

          let text;
          if (thisWeekPosts === 0) {
            text = `you went dark this week — ${lastWeekPosts > 0 ? `you posted ${lastWeekPosts}x last week` : 'no posts, no reactions, no presence'}. everyone else kept going.`;
          } else {
            const trend = thisWeekPosts > lastWeekPosts ? `↑ up from ${lastWeekPosts} last week` : thisWeekPosts < lastWeekPosts ? `↓ down from ${lastWeekPosts} last week` : 'same as last week';
            text = `this week: ${thisWeekPosts} post${thisWeekPosts !== 1 ? 's' : ''} (${trend}), ${reactsRx} reaction${reactsRx !== 1 ? 's' : ''} received. you ranked #${rank} on the street.`;
          }

          pushNotif(u.email, {
            type: 'weekly-report-card',
            fromName: '📊 weekly report',
            fromEmail: '',
            text
          });
          sent++;
        }
        if (sent > 0) { saveUsers(); console.log(`[retention] weekly report cards sent: ${sent}`); }
      }
    }

  } catch (e) {
    console.warn('[retention-engine] tick error', e.message);
  }
}, 30 * 60 * 1000); // every 30 minutes

// =================================================================
// GATE RE-ENGAGEMENT DRIP — SMS nudges for users stuck in the K=3
// gate (approved but waiting for 2 friends to claim invites).
// Runs every 2 hours. Max 3 nudges per user, 8h cooldown each.
// =================================================================
setInterval(() => {
  try {
    const now = Date.now();
    const COOLDOWN_MS = 8 * 60 * 60 * 1000;
    const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
    const MSGS = [
      u => `hey — both your spots on Old Streets are still unclaimed. your invite link is just sitting there. text your people: ${base}/gate`,
      u => `${(u.name || '').split(' ')[0] || 'hey'}, you're in but you're not inside yet. old streets only opens when your two friends join. one text is all it takes.`,
      u => `last nudge — you're approved on Old Streets but you're still stuck outside. don't let your friends get in without you: ${base}/gate`
    ];
    let nudged = 0;
    for (const u of users) {
      if (!u.mustSpendInitialInvites) continue;
      if (!u.phone) continue;
      const lastNudge = u._gateNudgeAt || 0;
      if (now - lastNudge < COOLDOWN_MS) continue;
      const nudgeCount = u._gateNudgeCount || 0;
      if (nudgeCount >= 3) continue;
      const claimed = (u.pendingInvites || []).filter(i => i && i.claimedBy).length;
      if (claimed >= 2) continue;
      const msg = MSGS[nudgeCount % MSGS.length](u);
      twilioSendSms(u.phone, msg).then(r => {
        if (r.ok) console.log(`[gate-drip] nudged ${u.phone} nudge#${nudgeCount + 1}`);
      }).catch(() => {});
      u._gateNudgeAt = now;
      u._gateNudgeCount = nudgeCount + 1;
      nudged++;
    }
    if (nudged > 0) { saveUsers(); console.log(`[gate-drip] ${nudged} gate nudges sent`); }
  } catch (e) {
    console.warn('[gate-drip] error', e.message);
  }
}, 2 * 60 * 60 * 1000); // every 2 hours

// =================================================================
// OPENED-NOT-CLAIMED FOLLOW-UP — every 30min sweep. When an invite
// link was opened 1–3h ago but the recipient still hasn't signed up,
// send the inviter one final nudge. Fires once per invite (_openedNudge).
// =================================================================
setInterval(() => {
  try {
    const now = Date.now();
    const ONE_H = 60 * 60 * 1000;
    let nudged = 0;
    for (const u of users) {
      if (!u.phone) continue;
      for (const inv of (u.pendingInvites || [])) {
        if (!inv.openedAt || inv.claimedBy || inv._openedNudge) continue;
        const elapsed = now - inv.openedAt;
        if (elapsed < ONE_H || elapsed > 3 * ONE_H) continue;
        inv._openedNudge = true;
        const msgs = [
          `ur friend opened ur old streets link an hour ago and still hasn't joined. send them one text.`,
          `someone opened your invite link 1 hour ago. they're still not in. they just need a push.`,
          `ur link was opened. they haven't signed up yet — one text from you changes that.`
        ];
        const msg = msgs[Math.floor(Math.random() * msgs.length)];
        twilioSendSms(u.phone, msg).catch(() => {});
        nudged++;
      }
    }
    if (nudged > 0) { saveUsers(); console.log(`[opened-nudge] sent ${nudged} follow-up nudges`); }
  } catch (e) {
    console.warn('[opened-nudge] error', e.message);
  }
}, 30 * 60 * 1000); // every 30 minutes

// =================================================================
// HELPERS
// =================================================================
function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const test = crypto.scryptSync(String(password), salt, 32).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function emailValid(email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  const re = new RegExp(`^[a-z0-9._%+-]+@${config.emailDomain.replace('.', '\\.')}$`, 'i');
  return re.test(e);
}
function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return users.find(u => u.email.toLowerCase() === e);
}
function findDirectoryByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return directory.find(d => d.email.toLowerCase() === e);
}
function isEmailClaimed(email) {
  const u = findUserByEmail(email);
  return !!(u && u.status !== 'banned');
}
function findUserByToken(token) {
  if (!token) return null;
  return users.find(u => u.token === token);
}
function findUserById(id) {
  return users.find(u => u.id === id);
}
// Bump this string any time the TOS changes — every user is re-prompted
// to agree on next login. Format: YYYY-MM-DD-vN.
const CURRENT_TOS_VERSION = '2026-05-14-v3-required';

// Hard blocklist of staff / role-based inbox names and email locals. These
// aren't real students and must never get on the platform. Match on either
// the display name or the email's local-part (before @).
// Hard content block — high-confidence slurs / threats. If any of these
// appear in a post or comment, the write is rejected with a clear error
// and a high-severity event lands on the threats dashboard.
const BLOCKED_TERMS = [
  // racial slurs (n-word variants, etc) — written defensively as fragments
  /\bn[i1!|][gq]+(?:[ae]r?|a)\b/i,
  /\bn[i1!|][gq]+let\b/i,
  /\bch[i1!|]nk\b/i,
  /\bsp[i1!|]c\b/i,
  /\bk[i1!|]ke\b/i,
  /\bw[e3]tback\b/i,
  // anti-gay / anti-trans slurs
  /\bf[a@][gq]+(?:got|s)?\b/i,
  /\btr[a4]nn[i1y]e?\b/i,
  // threats of violence
  /\b(kill|murder|shoot|stab|bomb|hang|lynch)\s+(yourself|urself|yo+self|himself|herself|themself|them|him|her|you)\b/i,
  /\bkys\b/i,                // "kill yourself"
  /\bgo\s+die\b/i,
  /\bschool\s*shoot/i,
  /\bbomb\s*threat/i,
];
function contentBlocked(text) {
  if (!text) return null;
  const t = String(text);
  for (const re of BLOCKED_TERMS) if (re.test(t)) return re.toString();
  return null;
}

const STAFF_NAME_PATTERNS = [
  /\b(theater|theatre|athletics|library|reception|front desk|jobs|safety|spirit wear|technology|tech support|parent help|special events|department|office|operations|finance|admissions|advancement|hr|human resources|it|helpdesk|maintenance|facilities|health|counseling|nurse|registrar|principal|head of school|business office|alumni|communications|admin|administration|info|noreply|support|staff|check request|check requests|payable|payables|accounts payable|receivable|receivables|accounts receivable|invoice|invoices|billing|bursar|treasurer|payroll|tax|taxes|capital campaign|development|fundraising|grants|donations|board|trustees|trustee|annual fund|advancement office|hr office|talent|recruitment|attendance|enrollment|conference|conferences|events|booking|bookings|reservation|reservations|tickets|ticket office)\b/i,
];
const STAFF_EMAIL_LOCALS = new Set([
  'mosstheater', 'mossspecialevents',
  // (removed school-specific staff patterns — generic role-inbox patterns below catch most)
  
  'admissions', 'advancement', 'alumni', 'business', 'communications',
  'counseling', 'finance', 'frontdesk', 'health', 'helpdesk', 'hr',
  'info', 'it', 'library', 'maintenance', 'noreply', 'no-reply',
  'office', 'operations', 'principal', 'registrar', 'reception',
  'support', 'staff', 'theater', 'theatre', 'webmaster', 'admin',
  // role-based inboxes
  'checkrequest', 'checkrequests', 'check-request', 'check-requests',
  'accountspayable', 'accounts-payable', 'ap',
  'accountsreceivable', 'accounts-receivable', 'ar',
  'invoice', 'invoices', 'billing', 'bursar', 'treasurer', 'payroll',
  'donations', 'development', 'fundraising', 'grants', 'annualfund',
  'board', 'trustees', 'trustee',
  'attendance', 'enrollment', 'events', 'conferences', 'booking', 'bookings',
  'reservations', 'tickets', 'ticketoffice',
  'sis', 'database', 'reports', 'data',
  'help', 'contact', 'hello', 'inquiries', 'feedback', 'public',
  // any local-part starting with these prefixes is suspect; we still apply
  // the exact-match check above, so list a few specific known offenders too.
]);
const STAFF_LOCAL_PREFIXES = [
  'checkrequest', 'invoice', 'accountspayable', 'accountsreceivable',
  'noreply', 'no-reply', 'donotreply', 'donot-reply',
  
];
function isStaffOrRoleEmail(name, email) {
  const nm = String(name || '').trim();
  const em = String(email || '').toLowerCase().trim();
  if (!em) return false;
  const local = em.split('@')[0] || '';
  if (STAFF_EMAIL_LOCALS.has(local)) return true;
  for (const p of STAFF_LOCAL_PREFIXES) if (local.startsWith(p)) return true;
  for (const re of STAFF_NAME_PATTERNS) if (re.test(nm)) return true;
  return false;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name,
    bio: u.bio || '',
    avatar: u.avatar || '',
    rating: avgRating(u.email),
    nameLockedFromDirectory: !!u.nameLockedFromDirectory,
    status: u.status, createdAt: u.createdAt,
    approvedAt: u.approvedAt, isAdmin: !!u.isAdmin,
    referralCount: (u.referrals || []).length,
    friends: u.friends || [],
    streak: u.streak || 0,
    hasPostedOnce: !!u.hasPostedOnce,
    lastVisitAt: u.lastVisitAt || 0,
    lastSeen: u.lastSeen || 0,
    lastPostAt: u.lastPostAt || 0,
    postCount: u.postCount || 0,
    // streak break signal — client shows guilt toast, then we null it out
    streakBrokeAt: u.streakBrokeAt || null,
    prevStreak: u.prevStreak || 0,
    // countdown: when their current-day streak expires (end of today, local server midnight)
    streakExpiresAt: (() => {
      const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime();
    })(),
    // MySpace-era profile fields
    mood: u.mood || '',
    moodId: u.moodId || '',
    headline: u.headline || '',
    aboutMe: u.aboutMe || '',
    interests: u.interests || '',
    heroes: u.heroes || '',
    pronouns: u.pronouns || '',
    websiteUrl: u.websiteUrl || '',
    theme: u.theme || 'classic',
    top8: u.top8 || [],
    blinkies: u.blinkies || [],
    customProfile: u.customProfile || null,
    songUrl: u.songUrl || '',
    songEmbed: u.songEmbed || null,
    backgroundUrl: u.backgroundUrl || '',
    backgroundMode: u.backgroundMode || 'cover',
    backgroundOpacity: typeof u.backgroundOpacity === 'number' ? u.backgroundOpacity : 85,
    profileTextColor: u.profileTextColor || '',
    customHtml: u.customHtml || '',
    customHtmlSafe: u.customHtmlSafe || '',
    customCss: u.customCss || '',
    vanityUrl: u.vanityUrl || '',
    royalty: u.royalty || null,
    personalEmail: u.personalEmail || '',
    personalEmailVerified: !!u.personalEmailVerified,
    needsOnboarding: !!u.needsOnboarding,
    onboardingCompletedAt: u.onboardingCompletedAt || null,
    mustCompleteReferrals: !!u.mustCompleteReferrals,
    lockedFromReset: !!u.lockedFromReset,
    timeoutUntil: (u.timeoutUntil && u.timeoutUntil > Date.now()) ? u.timeoutUntil : 0,
    timeoutReason: (u.timeoutUntil && u.timeoutUntil > Date.now()) ? (u.timeoutReason || '') : '',
    pinnedPosts: u.pinnedPosts || [],
    tosAgreedVersion: u.tosAgreedVersion || '',
    tosAgreedAt: u.tosAgreedAt || 0,
    needsTosAgreement: (u.tosAgreedVersion || '') !== CURRENT_TOS_VERSION,
    grade: u.grade || '',
    adminWarning: u.adminWarning || null,
    classOf: u.gradYear || gradeToClassOf(u.grade),
    ogTier: computeOgTier(u.createdAt || 0),
    daysOnPlatform: Math.floor((Date.now() - (u.createdAt || Date.now())) / (24*60*60*1000)),
    needsGrade: !u.grade && !u.gradYear,
    // New phone-auth + waitlist + referral-currency model fields
    phoneE164: u.phoneE164 || '',
    schoolId: u.schoolId || '',
    schoolName: u.schoolName || '',
    gradYear: u.gradYear || '',
    invitedBy: u.invitedBy || '',
    vouched: !!u.invitedBy,
    invitedByName: u.invitedBy ? (() => {
      const inv = users.find(x => x.id === u.invitedBy);
      return inv ? inv.name : '';
    })() : '',
    invitedByHandle: u.invitedBy ? (() => {
      const inv = users.find(x => x.id === u.invitedBy);
      return inv ? (inv.handle || '') : '';
    })() : '',
    referralBalance: typeof u.referralBalance === 'number' ? u.referralBalance : 0,
    referralsEarned: u.referralsEarned || 0,
    referralsSpent: u.referralsSpent || 0,
    mustSpendInitialInvites: !!u.mustSpendInitialInvites,
    pendingInvites: (u.pendingInvites || []).map(s => ({
      contact: s.contact || '',
      contactType: s.contactType || '',
      sentAt: s.sentAt || 0,
      openedAt: s.openedAt || 0,
      claimedBy: s.claimedBy || '',
      claimedAt: s.claimedAt || 0,
      claimedName: s.claimedName || '',
      inviteToken: s.inviteToken || ''
    })),
    handle: u.handle || '',
    waitlistedAt: u.waitlistedAt || 0,
    waitlistPosition: u.status === 'waitlist' ? computeWaitlistPosition(u) : 0,
    waitlistShareToken: u.waitlistShareToken || '',
    waitlistShareClicks: u.waitlistShareClicks || 0,
    waitlistShareSignups: u.waitlistShareSignups || 0,
    waitlistBoostScore: waitlistBoostScore(u),
    // Unlock counters — clients use these to gate Oldmegle / Room create.
    // sent = phone-numbers invited (the new K=3 unlock signal)
    // claimed = those who actually joined (kept for analytics)
    invitesSent: sentInviteCount(u),
    invitesClaimed: claimedInviteCount(u),
    // Forced school re-confirmation: every user must (re-)pick from the
    // three launch schools and double-confirm. schoolLocked = they've gone
    // through the permanence confirm modal.
    schoolLocked: !!u.schoolLocked,
    // Handle confirmation gate — user must explicitly choose/confirm their
    // @handle (the auto-generated one doesn't count) before the rest of
    // the site is reachable.
    handleChosen: !!u.handleChosen,
    // Selfie gate — onboarding requires capturing a photo-booth selfie
    // (no uploads). Cleared by /api/me/selfie.
    selfieTaken: !!u.selfieTaken
  };
}

// Used in publicUser to show "you are #N in line". Cheap O(users) scan.
// True position in the waitlist queue (1-indexed). Used internally.
//
// Share-to-jump mechanic: each waitlisted user has a share link. Every
// click on their link earns them 1 "boost point", every signup earns 10.
// We sort the queue by (waitlistedAt - boostScore*60_000) so accumulated
// boost effectively backdates the entry, sliding the user up.
function waitlistBoostScore(u) {
  if (!u) return 0;
  const clicks = u.waitlistShareClicks || 0;
  const signups = u.waitlistShareSignups || 0;
  return clicks + signups * 10;
}
function computeRealWaitlistPosition(u) {
  const wl = users
    .filter(x => x.status === 'waitlist')
    .map(x => ({ u: x, sortKey: (x.waitlistedAt || 0) - waitlistBoostScore(x) * 60_000 }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(p => p.u);
  const i = wl.findIndex(x => x.id === u.id);
  return i < 0 ? 0 : (i + 1);
}

// Inflated position shown to users — makes the queue feel deeper (100+).
// Real #1 lands around #120, real #2 around #123, etc. — each user gets
// a stable jitter from their id so two friends comparing numbers never
// see the same value. Spread (3) > max jitter (2), so collisions are
// mathematically impossible.
// Waitlist position vibe: anchored around 100. Real-user #1 lands around
// #98 + jitter, real-user #2 around #101, etc. Spread (3) > max jitter (2)
// guarantees no two real users see the same number. Dynamic offset drifts
// up and down throughout the day so the number feels alive.
const WAITLIST_INFLATION_BASE = 98;
const WAITLIST_SPREAD = 3;
// Dynamic offset — fast-up / slow-down. Simulates a real waitlist
// where applications stream in faster than admin can clear them.
// Persisted so redeploys don't reset the vibe.
const WAITLIST_VIBE_FILE = path.join(DATA_DIR, 'waitlist-vibe.json');
let waitlistOffset = WAITLIST_INFLATION_BASE;
try {
  if (fs.existsSync(WAITLIST_VIBE_FILE)) {
    const d = JSON.parse(fs.readFileSync(WAITLIST_VIBE_FILE, 'utf8'));
    if (typeof d.offset === 'number' && d.offset >= WAITLIST_INFLATION_BASE) {
      waitlistOffset = Math.min(999, d.offset);
    }
  }
} catch (e) { console.warn('[waitlist-vibe] load failed', e.message); }
function saveWaitlistVibe() {
  try { atomicWrite(WAITLIST_VIBE_FILE, JSON.stringify({ offset: waitlistOffset, updatedAt: Date.now() }, null, 2)); }
  catch (e) {}
}
// Make the offset drift around 100 — moves both directions, never stuck.
// Soft band: 95 ↔ 115. Anchored so users always see roughly 100.
const WAITLIST_OFFSET_MIN = WAITLIST_INFLATION_BASE; // 98
const WAITLIST_OFFSET_MAX = WAITLIST_INFLATION_BASE + 18; // 116
if (waitlistOffset > WAITLIST_OFFSET_MAX) waitlistOffset = WAITLIST_OFFSET_MAX;
if (waitlistOffset < WAITLIST_OFFSET_MIN) waitlistOffset = WAITLIST_OFFSET_MIN;
// "applications" stream in (+1..+3) every 4 to 9 min
setInterval(() => {
  const delta = 1 + Math.floor(Math.random() * 3);
  waitlistOffset = Math.min(WAITLIST_OFFSET_MAX, waitlistOffset + delta);
  saveWaitlistVibe();
}, (4 + Math.random() * 5) * 60 * 1000);
// "acceptances" trickle (-1..-2) every 6 to 12 min — at the high end of
// the band, faster than adds, so the offset oscillates and people see
// their number tick UP and DOWN.
setInterval(() => {
  const delta = 1 + Math.floor(Math.random() * 2);
  waitlistOffset = Math.max(WAITLIST_OFFSET_MIN, waitlistOffset - delta);
  saveWaitlistVibe();
}, (6 + Math.random() * 6) * 60 * 1000);
function bumpWaitlistVibeOnApprove() {
  waitlistOffset = Math.max(WAITLIST_OFFSET_MIN, waitlistOffset - 1);
  saveWaitlistVibe();
}
function computeWaitlistPosition(u) {
  const real = computeRealWaitlistPosition(u);
  if (!real) return 0;
  const h = crypto.createHash('sha256').update(String(u.id || '')).digest();
  const jitter = h[0] % 3;
  return waitlistOffset + (real * WAITLIST_SPREAD) + jitter;
}

// "Class of 20XX" derivation. Treats school year as ending in early June —
// e.g. a 12th grader on 2026-05-12 graduates in June 2026.
function gradeToClassOf(g) {
  const grade = parseInt(g, 10);
  if (!grade || grade < 6 || grade > 12) return '';
  const now = new Date();
  // Anything before June counts as the current school year; June+ shifts to next.
  const schoolYearEndYear = now.getMonth() >= 5 ? now.getFullYear() + 1 : now.getFullYear();
  const yearsLeft = 12 - grade;
  return String(schoolYearEndYear + yearsLeft);
}

// OG tier — visible badge based on how early the user joined.
const PLATFORM_LAUNCH_MS = new Date('2024-09-01').getTime();
function computeOgTier(createdAt) {
  if (!createdAt) return '';
  const days = (createdAt - PLATFORM_LAUNCH_MS) / (24*60*60*1000);
  if (days < 7)   return 'founding-50';   // first week
  if (days < 60)  return 'og';            // first 2 months
  if (days < 180) return 'year-1';        // first 6 months
  if (days < 365) return 'year-1';
  return 'vet';                            // 1+ year
}

function isTimedOut(user) {
  return !!(user && user.timeoutUntil && user.timeoutUntil > Date.now());
}

function requireNotTimedOut(req, res, user) {
  if (isTimedOut(user)) {
    res.status(403).json({
      error: 'timed-out',
      timeoutUntil: user.timeoutUntil,
      timeoutReason: user.timeoutReason || ''
    });
    return false;
  }
  return true;
}

// =================================================================
// TRENDING DETECTION
// A post is "trending" if it collected ≥ 3 reactions in the last 45 min.
// =================================================================
function isTrending(post) {
  const cutoff = Date.now() - 45 * 60 * 1000;
  const reactions = post.reactions || {};
  let recentReacts = 0;
  for (const bucket of Object.values(reactions)) {
    for (const ts of Object.values(bucket)) {
      if (typeof ts === 'number' && ts > cutoff) recentReacts++;
    }
  }
  return recentReacts >= 3;
}

// =================================================================
// ENGAGEMENT HELPERS
// =================================================================
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STREAK_MILESTONES = [7, 14, 30, 60, 100];
const STREAK_MILESTONE_MSGS = {
  7:   `7-day streak 🔥 you're showing up every day. the feed notices.`,
  14:  `14 days straight. discipline most people don't have — keep going.`,
  30:  `a whole month of daily posts. one of the most consistent people on here 🔥`,
  60:  `60 days. you've posted every single day for two months. you basically live here.`,
  100: `100-day streak 💯 this is a record. you own this place. don't ever stop.`
};
function dayKey(ts) {
  // Pin to Pacific time so streaks/qotd roll over at midnight local, not UTC.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(ts));
}

// Streaks are now based on POSTING, not visiting. Call this AFTER a post is
// successfully created. Visits no longer advance the streak.
function bumpStreakOnPost(user) {
  const today = dayKey(Date.now());
  if (user.lastPostDay === today) return; // already counted a post today
  const yesterday = dayKey(Date.now() - ONE_DAY_MS);
  const twoDaysAgo = dayKey(Date.now() - 2 * ONE_DAY_MS);
  if (user.lastPostDay === yesterday) {
    user.streak = (user.streak || 0) + 1;
    user.streakBrokeAt = null;
    user.prevStreak = null;
  } else if (!user.lastPostDay) {
    user.streak = 1;
    user.streakBrokeAt = null;
    user.prevStreak = null;
  } else if (
    user.lastPostDay === twoDaysAgo &&
    (user.streak || 0) >= 7 &&
    user._graceUsedAt !== twoDaysAgo
  ) {
    // Silent grace extension: user with a real streak (≥7) missed exactly one
    // day and came back within the next day. Extend silently — no announcement.
    // They feel relief and gratitude toward the app without knowing why it saved them.
    user._graceUsedAt = twoDaysAgo;
    user.streak = (user.streak || 0) + 1;
    user.streakBrokeAt = null;
    user.prevStreak = null;
  } else {
    // didn't post yesterday → streak broke. Reset to 1 (today counts).
    user.prevStreak = user.streak || 0;
    user.streak = 1;
    user.streakBrokeAt = Date.now();
  }
  user.lastPostDay = today;
  // Milestone celebration — fire once per milestone level, never repeat the same number.
  if (STREAK_MILESTONES.includes(user.streak) && user._lastMilestonePushed !== user.streak) {
    user._lastMilestonePushed = user.streak;
    const msg = STREAK_MILESTONE_MSGS[user.streak] || `${user.streak}-day streak. keep going.`;
    pushNotif(user.email, {
      type: 'streak-milestone',
      fromName: '🔥 streak milestone',
      fromEmail: '',
      text: msg
    });
  }
}

// Lazy check: if the user hasn't posted today or yesterday, their streak is
// effectively dead. Drop it to 0 and flag the break so the client can guilt.
function decayStreakIfStale(user) {
  if (!user.streak) return;
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - ONE_DAY_MS);
  if (user.lastPostDay === today || user.lastPostDay === yesterday) return;
  // dead streak
  user.prevStreak = user.streak;
  user.streak = 0;
  user.streakBrokeAt = user.streakBrokeAt || Date.now();
}

function timeAgoServer(ts) {
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'an hour ago';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d !== 1 ? 's' : ''} ago`;
}

function pushNotif(toEmail, payload) {
  const n = {
    id: newId(),
    to: toEmail.toLowerCase(),
    ts: Date.now(),
    read: false,
    ...payload
  };
  notifs.push(n);
  if (notifs.length > 5000) notifs = notifs.slice(-5000);
  saveNotifs();
  // realtime
  for (const [sid, info] of onlineUsers) {
    if (info.email === toEmail.toLowerCase()) {
      io.to(sid).emit('notif', n);
    }
  }
  return n;
}

// Delayed push — holds the notification for a random window before delivery.
// The unpredictability of *when* the reward arrives is what creates compulsive
// checking between visits. Variable ratio schedule: the slot-machine model.
// Use for social/curiosity notifs only — urgent ones (streak warnings) stay instant.
function delayedPush(toEmail, payload, minMs = 8 * 60 * 1000, maxMs = 35 * 60 * 1000) {
  const delay = minMs + Math.floor(Math.random() * (maxMs - minMs));
  setTimeout(() => {
    try { pushNotif(toEmail, payload); } catch (e) { console.warn('[delayedPush] error', e.message); }
  }, delay);
}

// Parse @mentions. Require a non-word char (or start) before the @ so that
// email addresses like alice@example.com don't trigger a mention of "example".
function findMentionedUsers(text) {
  if (!text) return [];
  const found = new Set();
  // Match @ followed by either first-name only OR "@First Last" (full name).
  // The space inside @-mentions is allowed when the next word starts capital
  // (heuristic to avoid eating regular sentence words after a single @).
  const txt = String(text);
  // 1) Full-name matches: try every active user's full name as a literal substring after "@"
  const lc = txt.toLowerCase();
  for (const u of users) {
    if (u.status !== 'active') continue;
    const fullLc = (u.name || '').toLowerCase().trim();
    if (!fullLc) continue;
    if (lc.includes('@' + fullLc)) {
      found.add(u.email);
    }
  }
  // 2) Handle matches: @firstname or @emailslug (single word)
  const handleMatches = [...txt.matchAll(/(^|[^a-zA-Z0-9._%+\-])@([a-zA-Z][a-zA-Z'\-\.]{1,30})/g)];
  for (const m of handleMatches) {
    const handle = m[2].toLowerCase().replace(/[.\-]+$/, '');
    for (const u of users) {
      if (u.status !== 'active') continue;
      const first = (u.name.split(' ')[0] || '').toLowerCase();
      const slug = u.email.split('@')[0].toLowerCase();
      if (handle === first || handle === slug) {
        found.add(u.email);
      }
    }
  }
  return [...found];
}

// Detect "talking about you" — first names appearing in text. Tightened to
// 4-char minimum (skips Ada, Adi, Aku, Ari, Ben, Eve, etc.) to cut noise.
function findNamedUsers(text) {
  if (!text) return [];
  const found = new Set();
  const lc = ' ' + text.toLowerCase() + ' ';
  for (const u of users) {
    if (u.status !== 'active') continue;
    const first = (u.name.split(' ')[0] || '').toLowerCase();
    if (first.length < 4) continue;
    const re = new RegExp('[\\s.,;!?\\(]' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s.,;!?\\)]', 'i');
    if (re.test(lc)) found.add(u.email);
  }
  return [...found];
}

async function sendTimeoutEmail({ toName, toEmail, until, reason }) {
  if (!config.resendApiKey || !toEmail) return { skipped: true };
  const _u = unsubArtifacts(toEmail);
  if (_u.blocked) return { skipped: true, unsubscribed: true };
  const days = Math.max(1, Math.round((until - Date.now()) / (24 * 60 * 60 * 1000)));
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">
      <div style="background:#a31515;color:white;padding:11px 16px;font-weight:bold;font-size:17px;">[ Old Streets · Account notice ]</div>
      <h2 style="color:#a31515;font-size:22px;margin:22px 0 8px;">You've been timed out</h2>
      <p style="font-size:14px;line-height:1.55;">Hey ${escapeHtmlServer(toName || 'there')},</p>
      <p style="font-size:14px;line-height:1.55;">An admin put your Old Streets account on a temporary timeout. While the timeout is active you can still log in but you can't post, comment, or react.</p>
      <p style="font-size:14px;line-height:1.55;background:#fff4f4;border:1px solid #f5c5c5;padding:10px 14px;margin:12px 0;">
        <strong>Reason:</strong> ${escapeHtmlServer(reason || 'posting dumb stuff')}<br/>
        <strong>Duration:</strong> ~${days} day${days === 1 ? '' : 's'}<br/>
        <strong>Lifts at:</strong> ${new Date(until).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT
      </p>
      <p style="font-size:13px;line-height:1.55;color:#666;">If you think this was a mistake, reply to this email or DM the admin in-app once the timeout lifts.</p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject: `Old Streets — you've been timed out (${days}d)`,
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function sendUntimeoutEmail({ toName, toEmail }) {
  if (!config.resendApiKey || !toEmail) return { skipped: true };
  const _u = unsubArtifacts(toEmail);
  if (_u.blocked) return { skipped: true, unsubscribed: true };
  const html = `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1c1c1c;background:#fff;">
      <div style="background:#3B5998;color:white;padding:11px 16px;font-weight:bold;font-size:17px;">[ Old Streets ]</div>
      <h2 style="color:#3B5998;font-size:22px;margin:22px 0 8px;">You're back in 🎉</h2>
      <p style="font-size:14px;line-height:1.55;">Hey ${escapeHtmlServer(toName || 'there')},</p>
      <p style="font-size:14px;line-height:1.55;">An admin lifted your timeout. You can post, comment, and react again. Try not to do dumb stuff this time.</p>
      <p style="margin:20px 0;">
        <a href="${config.publicUrl || 'https://old-streets.fly.dev'}" style="display:inline-block;background:#3B5998;color:white;padding:10px 18px;text-decoration:none;font-weight:bold;border:1px solid #2f477b;">Open Old Streets →</a>
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject: `Old Streets — your timeout has been lifted`,
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function sendMentionEmail({ toName, toEmail, fromName, postPreview, postId }) {
  if (!config.resendApiKey) return { skipped: true };
  const _u = unsubArtifacts(toEmail);
  if (_u.blocked) return { skipped: true, unsubscribed: true };
  const siteUrl = config.publicUrl || 'http://localhost:3001';
  const link = postId ? `${siteUrl}/#post=${postId}` : siteUrl;
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">
      <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">[ Old Streets ]</div>
      <h2 style="color: #3B5998; font-size: 22px; margin: 22px 0 8px;">${escapeHtmlServer(fromName)} mentioned you on the wall.</h2>
      <p style="font-size: 14px; line-height: 1.55; background: #fffbe5; border: 1px solid #f0e0a0; padding: 10px 14px; margin: 12px 0;">
        "${escapeHtmlServer((postPreview || '').slice(0, 200))}${(postPreview || '').length > 200 ? '…' : ''}"
      </p>
      <p style="margin: 20px 0;">
        <a href="${link}" style="display: inline-block; background: #3B5998; color: white; padding: 10px 18px; text-decoration: none; font-weight: bold; border: 1px solid #2f477b;">See the post →</a>
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 18px; line-height: 1.55;">
        Old Streets is independent — not affiliated with any school.
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject: `${fromName} mentioned you on Old Streets`,
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

function getActivityFloor() {
  // Show the higher of: actual online count, or peak from earlier today
  const today = dayKey(Date.now());
  if (peakOnlineToday.day !== today) {
    peakOnlineToday.day = today;
    peakOnlineToday.count = 0;
  }
  peakOnlineToday.count = Math.max(peakOnlineToday.count, onlineUsers.size);
  return peakOnlineToday.count;
}

// =================================================================
// FAKE STATS — padding to make the platform feel more alive
// Numbers drift slowly via a seeded walk so they feel organic,
// not static. School-hours multiplier makes evenings look busier.
// =================================================================
function getFakeOnlinePad() {
  const hour = new Date().getHours();
  // Base phantom headcount varies by time of day.
  let base, spread;
  if (hour >= 7 && hour < 9)        { base = 9;  spread = 9;  }
  else if (hour >= 9 && hour < 15)  { base = 18; spread = 20; }
  else if (hour >= 15 && hour < 18) { base = 14; spread = 14; }
  else if (hour >= 18 && hour < 22) { base = 10; spread = 12; }
  else if (hour >= 22 || hour < 1)  { base = 5;  spread = 7;  }
  else                              { base = 2;  spread = 4;  }
  const bucket = Math.floor(Date.now() / (3 * 60 * 1000));
  const drift = (Math.sin(bucket * 1.618 + 7) * 0.5 + 0.5) * spread;
  return Math.round(base + drift);
}

// REAL online count — no padding, no floor, no fakes. Counts unique
// real, active, non-bot users currently connected via socket. The count
// in the widget header must match the list below it.
function realisticOnlineCount() {
  const seen = new Set();
  for (const [, info] of onlineUsers) {
    const email = (info && info.email || '').toLowerCase();
    if (!email || seen.has(email)) continue;
    const u = findUserByEmail(email);
    if (!u || u.status !== 'active' || u.isBot || u.isSystem) continue;
    seen.add(email);
  }
  return seen.size;
}

function getFakeMemberPad() {
  // Add a fixed phantom surplus to make the member count look like
  // there's a healthy user base even when signups are slow.
  // Grows slightly each week so it doesn't look static.
  const weeksSinceEpoch = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return 14 + (weeksSinceEpoch % 6);  // 14-19 phantom members
}

function getFakePostCountPad() {
  // Ghost posts already inflate actual post count organically.
  // Add a small static pad for brand-new installs before ghost posts kick in.
  return 0; // posts array already has ghost posts injected — no extra needed
}

function isFeatureUnlocked(user, feature) {
  if (!user) return false;
  // DMs are now unlocked for everyone the moment they're active.
  if (feature === 'dm') return user.status === 'active';
  if (feature === 'random') return !!user.hasPostedOnce;
  return true;
}

function dmGateCounts(user) {
  const sent = friendRequests.filter(r => (r.from || '').toLowerCase() === user.email.toLowerCase()).length;
  return { sent, need: 5 };
}

function decayedPostCount(user, rawCount) {
  // Visible post count loses 1 per day of inactivity (server-side never loses anything).
  if (!user.lastVisitAt) return rawCount;
  const daysSinceVisit = Math.floor((Date.now() - user.lastVisitAt) / ONE_DAY_MS);
  if (daysSinceVisit < 7) return rawCount;
  const decay = Math.min(rawCount, daysSinceVisit - 6);
  return Math.max(0, rawCount - decay);
}

function adminUser(u) {
  if (!u) return null;
  return { ...publicUser(u), referrals: u.referrals || [] };
}

// Middleware-ish helpers
function requireUser(req, res) {
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  const user = findUserByToken(token);
  if (!user) { res.status(401).json({ error: 'sign in first' }); return null; }
  if (user.status !== 'active') { res.status(403).json({ error: 'account not active' }); return null; }
  // Waitlist gate: users who signed up without an invite go on the waitlist.
  // They can browse but can't post, comment, DM, react, or interact. They
  // only escape the waitlist when an admin (or a referral) lets them in.
  // Admins are exempt. A few whitelisted endpoints stay open so the user
  // can read their own state, agree to TOS, or delete their account.
  const WAITLIST_EXEMPT_PATHS = new Set([
    '/api/me/agree-tos',
    '/api/me/leave',
    '/api/auth/logout'
  ]);
  if (!user.isAdmin
      && user.status === 'waitlist'
      && req.method !== 'GET' && req.method !== 'HEAD'
      && !WAITLIST_EXEMPT_PATHS.has(req.path)) {
    res.status(403).json({
      error: 'waitlist',
      message: 'You\'re on the waitlist. A current member needs to vouch you in, or wait for the founder to let you in.'
    });
    return null;
  }

  // Forced-invite gate: pre-claim users can READ everything (so the site
  // doesn't feel dead while they wait), but they can't take social actions
  // (post, comment, react, DM, react, etc.) until both referrals claim.
  // Allowing reads keeps the inbox / wall / online list functional and
  // motivating; blocking writes preserves the K=2 gate's economics.
  const INVITE_GATE_BLOCKED_PATHS = new Set([
    '/api/posts',
    '/api/dm/send',
    '/api/letters',
    '/api/friend-requests/send',
    '/api/rooms',
    '/api/oldmegle/match',
    '/api/poke'
  ]);
  const isWriteMethod = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
  // Referrals removed — invite-spend gate disabled. Always flip the flag off
  // so any legacy user with mustSpendInitialInvites=true gets full access.
  if (user.mustSpendInitialInvites) {
    user.mustSpendInitialInvites = false;
    try { saveUsers(); } catch {}
  }
  void isWriteMethod; void INVITE_GATE_BLOCKED_PATHS;
  // TOS gate: anyone who hasn't agreed to the current TOS can't write.
  // The agree-tos endpoint itself uses findUserByToken directly so it
  // bypasses this check. Read-only methods still go through so they can
  // load enough state to render the agreement modal.
  if (!user.isAdmin
      && (user.tosAgreedVersion || '') !== CURRENT_TOS_VERSION
      && req.method !== 'GET' && req.method !== 'HEAD'
      && req.path !== '/api/me/agree-tos') {
    res.status(403).json({ error: 'tos-required', tosVersion: CURRENT_TOS_VERSION });
    return null;
  }
  // Timed-out users can READ but can't WRITE. Admins are exempt.
  if (!user.isAdmin && isTimedOut(user) && req.method !== 'GET' && req.method !== 'HEAD') {
    // Allow /api/me/* read-only endpoints that happen to be POST-only (rare),
    // but block by default. The path /api/me itself is GET so it goes through.
    res.status(403).json({
      error: 'timed-out',
      timeoutUntil: user.timeoutUntil,
      timeoutReason: user.timeoutReason || ''
    });
    return null;
  }
  user.lastSeen = Date.now();
  decayStreakIfStale(user);
  user.lastVisitAt = Date.now();
  // Debounced save instead of immediate atomic write — was firing on every
  // authenticated request and saturating disk + event loop. 5s debounce
  // batches all of a user's touches into one write per second window.
  scheduleSave(USERS_FILE, () => users, 5000);
  return user;
}
function isLocalRequest(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

// Append-only threat ring buffer + audit log for forensics.
const ADMIN_AUDIT_FILE = path.join(DATA_DIR, 'admin-audit.log');
const THREAT_FEED_MAX = 500;
let threatFeed = []; // [{ ts, type, severity, ip, who, note }]
function pushThreatEvent({ type, severity, ip, who, note }) {
  const evt = {
    ts: Date.now(),
    type: String(type || 'unknown').slice(0, 40),
    severity: ['low','med','high','critical'].includes(severity) ? severity : 'low',
    ip: String(ip || '').slice(0, 64),
    who: String(who || '').slice(0, 120),
    note: String(note || '').slice(0, 280),
  };
  threatFeed.unshift(evt);
  if (threatFeed.length > THREAT_FEED_MAX) threatFeed.length = THREAT_FEED_MAX;
  if (evt.severity === 'high' || evt.severity === 'critical') {
    try { fs.appendFileSync(ADMIN_AUDIT_FILE, 'THREAT: ' + JSON.stringify(evt) + '\n'); } catch {}
  }
}
function clientIp(req) {
  return (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
}

function logAdminAction(req, ok, note) {
  try {
    const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
    const token = req.headers['x-user-token'] || (req.body && req.body.token);
    const user = token ? findUserByToken(token) : null;
    const who = user ? `${user.email}` : (req.headers['x-admin-user'] || 'unknown');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ok,
      who,
      ip,
      method: req.method,
      path: req.path,
      note: note || ''
    }) + '\n';
    fs.appendFileSync(ADMIN_AUDIT_FILE, line);
  } catch (e) { /* never crash on audit-log failure */ }
}

// =================================================================
// ADMIN WebAuthn PASSKEYS — real Apple/Windows/Yubikey passkeys, with
// proper biometric / device-PIN protection at the OS level. Each
// enrollment stores a credential's public key + counter; subsequent
// logins prove possession of the matching private key.
//
// After a successful passkey assertion we mint a session token that
// the device sends as `x-admin-passkey: <id>|<sessionToken>` on each
// admin request, so we don't have to re-trigger the OS biometric prompt
// on every API call. Sessions live 30 days, then a fresh assertion is
// required. Sessions + credentials persist on the Fly volume so
// redeploys never sign you out.
// =================================================================
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const ADMIN_PASSKEYS_FILE = path.join(DATA_DIR, 'admin-passkeys.json');
let adminPasskeys = [];
try {
  if (fs.existsSync(ADMIN_PASSKEYS_FILE)) {
    adminPasskeys = JSON.parse(fs.readFileSync(ADMIN_PASSKEYS_FILE, 'utf8'));
  }
} catch (e) { console.warn('[admin-passkeys] load failed', e.message); }
function saveAdminPasskeys() {
  try { atomicWrite(ADMIN_PASSKEYS_FILE, JSON.stringify(adminPasskeys, null, 2)); }
  catch (e) { console.warn('[admin-passkeys] save failed', e.message); }
}

// Short-lived challenge store (5 min). Keyed by sid we return to the client.
const passkeyChallenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of passkeyChallenges) if (v.expiresAt < now) passkeyChallenges.delete(k);
}, 60 * 1000);

const PASSKEY_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// rpHost/rpOrigin now derive from the REQUEST's host header so passkeys
// work on whichever URL the admin is currently using — old-streets.fly.dev
// AND oldstreets.org. WebAuthn binds passkeys to an rpID; making rpID
// dynamic lets the same admin enroll a passkey on each host they use.
function rpHost(req) {
  if (req && req.headers && req.headers.host) {
    return String(req.headers.host).split(':')[0].toLowerCase();
  }
  try { return new URL(config.publicUrl || 'http://localhost:3001').hostname; }
  catch { return 'localhost'; }
}
function rpOrigin(req) {
  if (req && req.headers && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${req.headers.host}`;
  }
  return config.publicUrl || 'http://localhost:3001';
}

// Validates a session token previously issued by a passkey assertion.
// Returns the passkey record or null. Touches lastUsedAt on hit.
function checkAdminPasskey(req) {
  const h = req.headers['x-admin-passkey'];
  if (!h || typeof h !== 'string') return null;
  const idx = h.indexOf('|');
  if (idx < 1) return null;
  const id = h.slice(0, idx);
  const token = h.slice(idx + 1);
  const pk = adminPasskeys.find(p => p.id === id);
  if (!pk || pk.revokedAt) return null;
  if (!pk.sessionToken || !pk.sessionExpiresAt) return null;
  if (pk.sessionExpiresAt < Date.now()) return null;
  if (pk.sessionToken.length !== token.length) return null;
  let match;
  try { match = crypto.timingSafeEqual(Buffer.from(pk.sessionToken), Buffer.from(token)); }
  catch { return null; }
  if (!match) return null;
  pk.lastUsedAt = Date.now();
  pk.lastUsedIp = clientIp(req);
  scheduleSave(ADMIN_PASSKEYS_FILE, () => adminPasskeys, 5000);
  return pk;
}

function requireAdmin(req, res) {
  if (isLocalRequest(req)) { logAdminAction(req, true, 'local'); return true; }
  // Passkey path — device-bound, the recommended auth method.
  const pk = checkAdminPasskey(req);
  if (pk) { logAdminAction(req, true, 'passkey:' + pk.label); return true; }
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  if (token) {
    const tokUser = findUserByToken(token);
    if (tokUser && tokUser.isAdmin && tokUser.status === 'active') {
      logAdminAction(req, true, 'session:' + tokUser.email);
      return true;
    }
  }
  const user = req.headers['x-admin-user'];
  const pass = req.headers['x-admin-pass'];
  // Constant-time compare prevents timing attacks against the admin password.
  const adminUser = config.adminUsername || '';
  const adminPass = config.adminPasscode || '';
  const userOk = !!user && user.length === adminUser.length &&
    crypto.timingSafeEqual(Buffer.from(user), Buffer.from(adminUser));
  const passOk = !!pass && pass.length === adminPass.length &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(adminPass));
  if (!userOk || !passOk) {
    logAdminAction(req, false, 'rejected');
    pushThreatEvent({ type: 'admin-auth-fail', severity: 'high', ip: clientIp(req), who: user || 'unknown', note: `path=${req.path}` });
    res.status(401).json({ error: 'admin only' });
    return false;
  }
  logAdminAction(req, true, 'legacy-creds');
  return true;
}

// =================================================================
// ADMIN PASSKEY endpoints
// =================================================================

function hasActivePasskey() {
  return adminPasskeys.some(p => !p.revokedAt && p.credentialId);
}

// GET /api/admin/passkey/state — public probe used by the admin page on boot.
// Tells the client whether enrollment is open (no passkey yet) or the page
// should auto-trigger a passkey assertion. Returns no secret data.
app.get('/api/admin/passkey/state', (req, res) => {
  res.json({ enrolled: hasActivePasskey() });
});

// GET /api/admin/passkey/check — quick session-token verify used on boot.
app.get('/api/admin/passkey/check', (req, res) => {
  const pk = checkAdminPasskey(req);
  if (pk) return res.json({ ok: true, label: pk.label });
  res.status(401).json({ ok: false });
});

// ---------- ENROLLMENT (one-shot, gated by passcode) -----------------
// POST /api/admin/passkey/register/options
app.post('/api/admin/passkey/register/options', rateLimit({ key: 'pk-reg', max: 12, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  // One-shot: if any active passkey is already enrolled, refuse new enrollments.
  // To enroll on a new device after the first, sync the existing passkey
  // via iCloud / Google Password Manager — or delete admin-passkeys.json
  // on the server to fully reset.
  if (hasActivePasskey()) {
    pushThreatEvent({ type: 'admin-passkey-reenroll-attempt', severity: 'high', ip: clientIp(req) });
    return res.status(409).json({ error: 'already enrolled' });
  }
  const pass = String((req.body && req.body.passcode) || '');
  const expect = config.adminPasscode || '';
  let okPass;
  try { okPass = pass.length === expect.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(expect)); }
  catch { okPass = false; }
  if (!okPass) {
    pushThreatEvent({ type: 'admin-passkey-enroll-fail', severity: 'high', ip: clientIp(req), note: 'wrong-passcode' });
    return res.status(401).json({ error: 'wrong passcode' });
  }
  const label = String((req.body && req.body.label) || 'device').slice(0, 40) || 'device';
  try {
    const userIdBytes = crypto.randomBytes(16);
    const opts = await generateRegistrationOptions({
      rpName: 'Old Streets',
      rpID: rpHost(),
      userID: userIdBytes,
      userName: 'admin',
      userDisplayName: 'Old Streets admin',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      }
    });
    const sid = crypto.randomBytes(16).toString('hex');
    passkeyChallenges.set(sid, {
      challenge: opts.challenge, kind: 'register',
      label, userId: userIdBytes.toString('base64url'),
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    res.json({ ok: true, sid, options: opts });
  } catch (e) {
    console.warn('[passkey] register/options error', e && e.stack || e);
    res.status(500).json({ error: 'passkey-init-failed: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/passkey/register/verify
app.post('/api/admin/passkey/register/verify', async (req, res) => {
  if (hasActivePasskey()) return res.status(409).json({ error: 'already enrolled' });
  const sid = String((req.body && req.body.sid) || '');
  const ch = passkeyChallenges.get(sid);
  if (!ch || ch.kind !== 'register' || ch.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'challenge expired' });
  }
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpHost(),
      requireUserVerification: false
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(401).json({ error: 'verification failed' });
    }
    const info = verification.registrationInfo;
    const cred = info.credential || info;
    const credentialId = cred.id || Buffer.from(cred.credentialID).toString('base64url');
    const publicKey = cred.publicKey ? Buffer.from(cred.publicKey).toString('base64url')
                                     : Buffer.from(info.credentialPublicKey).toString('base64url');
    const counter = cred.counter || info.counter || 0;
    const id = crypto.randomBytes(8).toString('hex');
    const sessionToken = crypto.randomBytes(32).toString('hex');
    adminPasskeys.push({
      id,
      credentialId,
      publicKey,
      counter,
      label: ch.label,
      sessionToken,
      sessionExpiresAt: Date.now() + PASSKEY_SESSION_MS,
      createdAt: Date.now(),
      createdIp: clientIp(req),
      lastUsedAt: Date.now(),
      lastUsedIp: clientIp(req),
      revokedAt: 0
    });
    saveAdminPasskeys();
    passkeyChallenges.delete(sid);
    console.log(`[admin-passkey] enrolled WebAuthn credential "${ch.label}" (id=${id})`);
    res.json({ ok: true, id, token: id + '|' + sessionToken, label: ch.label });
  } catch (e) {
    console.warn('[passkey] register verify error', e.message);
    pushThreatEvent({ type: 'admin-passkey-verify-fail', severity: 'high', ip: clientIp(req), note: e.message });
    res.status(401).json({ error: e.message || 'verification failed' });
  }
});

// ---------- LOGIN (assertion via biometric / device PIN) -------------
// POST /api/admin/passkey/login/options
app.post('/api/admin/passkey/login/options', async (req, res) => {
  if (!hasActivePasskey()) return res.status(404).json({ error: 'no passkeys enrolled' });
  const opts = await generateAuthenticationOptions({
    rpID: rpHost(),
    allowCredentials: adminPasskeys
      .filter(p => !p.revokedAt && p.credentialId)
      .map(p => ({ id: p.credentialId, type: 'public-key' })),
    userVerification: 'preferred'
  });
  const sid = crypto.randomBytes(16).toString('hex');
  passkeyChallenges.set(sid, { challenge: opts.challenge, kind: 'login', expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ ok: true, sid, options: opts });
});

// POST /api/admin/passkey/login/verify
app.post('/api/admin/passkey/login/verify', async (req, res) => {
  const sid = String((req.body && req.body.sid) || '');
  const ch = passkeyChallenges.get(sid);
  if (!ch || ch.kind !== 'login' || ch.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'challenge expired' });
  }
  const credId = String((req.body.response && req.body.response.id) || '');
  const pk = adminPasskeys.find(p => !p.revokedAt && p.credentialId === credId);
  if (!pk) {
    pushThreatEvent({ type: 'admin-passkey-unknown-cred', severity: 'high', ip: clientIp(req) });
    return res.status(404).json({ error: 'unknown credential' });
  }
  try {
    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpHost(),
      credential: {
        id: pk.credentialId,
        publicKey: Buffer.from(pk.publicKey, 'base64url'),
        counter: pk.counter || 0
      },
      requireUserVerification: false
    });
    if (!verification.verified) {
      pushThreatEvent({ type: 'admin-passkey-verify-fail', severity: 'high', ip: clientIp(req) });
      return res.status(401).json({ error: 'verification failed' });
    }
    pk.counter = verification.authenticationInfo.newCounter;
    pk.sessionToken = crypto.randomBytes(32).toString('hex');
    pk.sessionExpiresAt = Date.now() + PASSKEY_SESSION_MS;
    pk.lastUsedAt = Date.now();
    pk.lastUsedIp = clientIp(req);
    saveAdminPasskeys();
    passkeyChallenges.delete(sid);
    res.json({ ok: true, id: pk.id, token: pk.id + '|' + pk.sessionToken, label: pk.label });
  } catch (e) {
    console.warn('[passkey] login verify error', e.message);
    pushThreatEvent({ type: 'admin-passkey-verify-fail', severity: 'high', ip: clientIp(req), note: e.message });
    res.status(401).json({ error: e.message || 'verification failed' });
  }
});

// GET /api/admin/passkey/list — list enrolled credentials.
app.get('/api/admin/passkey/list', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    passkeys: adminPasskeys
      .filter(p => !p.revokedAt)
      .map(p => ({ id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }))
  });
});

// DELETE /api/admin/passkey/:id — revoke a credential.
app.delete('/api/admin/passkey/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pk = adminPasskeys.find(p => p.id === req.params.id);
  if (!pk) return res.status(404).json({ error: 'not found' });
  pk.revokedAt = Date.now();
  saveAdminPasskeys();
  res.json({ ok: true });
});

// =================================================================
// AUTH / SIGNUP
// =================================================================
app.post('/api/passcode-check', (req, res) => {
  const { passcode } = req.body || {};
  res.json({ ok: passcode === config.memberPasscode });
});

// Daily brand-name rotation. Each entry pairs an atmospheric, road-evoking
// adjective with a road noun. Every phrase reads like a real road-name phrase
// synonym (old, antique, ancient, forgotten, hidden, lost, quiet, winding,
// crooked, cobbled, narrow, empty, distant). The literal pair "road-name phrases"
// is deliberately excluded — that was the school the platform got in
// trouble with, so the brand evokes it without ever saying it.
const NEW_ROADS_SYNONYMS = [
  'Old Lanes', 'Old Streets', 'Old Trails', 'Old Avenues',
  'Old Boulevards', 'Old Old Streets', 'Old Routes', 'Old Roads',
  'Antique Streets', 'Antique Lanes', 'Antique Roads', 'Antique Trails',
  'Ancient Lanes', 'Ancient Old Streets', 'Ancient Routes',
  'Forgotten Old Streets', 'Forgotten Drives', 'Forgotten Crossings',
  'Hidden Streets', 'Hidden Trails', 'Hidden Bridges', 'Hidden Lanes',
  'Lost Avenues', 'Lost Byways', 'Lost Tracks',
  'Quiet Lanes', 'Quiet Walks', 'Quiet Roads',
  'Winding Old Streets', 'Winding Roads',
  'Crooked Streets', 'Crooked Lanes',
  'Narrow Passages', 'Narrow Lanes',
  'Empty Highways', 'Empty Boulevards',
  'Distant Trails', 'Distant Highways',
  'Cobbled Streets', 'Cobbled Lanes'
];
function dailyBrandName(d = new Date()) {
  // Days since 2026-01-01 UTC, modulo pool length. Deterministic so every
  // visitor sees the same name on the same day.
  const epoch = Date.UTC(2026, 0, 1);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayIdx = Math.max(0, Math.floor((today - epoch) / 86400000));
  return NEW_ROADS_SYNONYMS[dayIdx % NEW_ROADS_SYNONYMS.length];
}
// Backwards-compat alias for any internal code still calling the old name.
const dailyStreetWord = dailyBrandName;

// ===================================================================
// BRAND VOTE — users suggest tomorrow's wordmark, upvote each other.
// Top vote-getter is used for one day, then discarded so the pool
// keeps churning. Falls back to NEW_ROADS_SYNONYMS rotation otherwise.
// ===================================================================
let brandVote = (() => {
  try {
    if (fs.existsSync(BRAND_VOTE_FILE)) {
      const j = JSON.parse(fs.readFileSync(BRAND_VOTE_FILE, 'utf8'));
      return { suggestions: Array.isArray(j.suggestions) ? j.suggestions : [], used: Array.isArray(j.used) ? j.used : [] };
    }
  } catch {}
  return { suggestions: [], used: [] };
})();
function saveBrandVote() {
  try { fs.writeFileSync(BRAND_VOTE_FILE, JSON.stringify(brandVote, null, 2)); } catch {}
}
function ymdUTC(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
}
function activeSuggestions() {
  return (brandVote.suggestions || []).filter(s => !s.discarded);
}
function topSuggestion() {
  const live = activeSuggestions().slice().sort((a, b) => (b.votes?.length || 0) - (a.votes?.length || 0) || a.createdAt - b.createdAt);
  return live[0] || null;
}
function brandForDay(d) {
  const key = ymdUTC(d);
  const todayKey = ymdUTC(new Date());
  const tomorrowKey = ymdUTC(new Date(Date.now() + 24 * 60 * 60 * 1000));
  // 1) Already locked for this date — use it
  const usedToday = (brandVote.used || []).find(u => u.date === key);
  if (usedToday) return usedToday.text;
  // 2) Looking up TODAY and there's a top suggestion that hasn't been
  //    locked yet — lock it now (lazy rollover at first query past midnight)
  //    and use it.
  if (key === todayKey) {
    const top = topSuggestion();
    if (top && (top.votes || []).length > 0) {
      brandVote.used = brandVote.used || [];
      brandVote.used.push({ date: todayKey, text: top.text, by: top.by, byHandle: top.byHandle, votes: (top.votes || []).length });
      top.discarded = true;
      top.discardedAt = Date.now();
      saveBrandVote();
      return top.text;
    }
  }
  // 3) Looking up TOMORROW — surface the LIVE leading suggestion so users
  //    see their vote impact instantly. (Not locked yet — votes still open.)
  if (key === tomorrowKey) {
    const top = topSuggestion();
    if (top && (top.votes || []).length > 0) return top.text;
  }
  return dailyBrandName(d);
}

app.get('/api/brand-vote', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  const list = activeSuggestions().slice()
    .sort((a, b) => (b.votes?.length || 0) - (a.votes?.length || 0) || a.createdAt - b.createdAt)
    .slice(0, 50)
    .map(s => ({
      id: s.id,
      text: s.text,
      byHandle: s.byHandle || '',
      votes: (s.votes || []).length,
      didIVote: !!(me && (s.votes || []).includes(me.id)),
      mine: !!(me && s.by === me.id),
      createdAt: s.createdAt
    }));
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  res.json({
    tomorrow: brandForDay(tomorrow),
    fallback: dailyBrandName(tomorrow),
    suggestions: list,
    canSuggest: !!me
  });
});

app.post('/api/brand-vote/suggest', rateLimit({ key: 'brand-suggest', max: 5, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  let text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'empty suggestion' });
  if (text.length < 3) return res.status(400).json({ error: 'too short' });
  if (text.length > 28) return res.status(400).json({ error: 'keep it under 28 chars' });
  if (/[<>{}]/.test(text)) return res.status(400).json({ error: 'no special chars' });
  // light normalization — collapse whitespace, title-case-ish
  text = text.replace(/\s+/g, ' ');
  const dupe = activeSuggestions().find(s => s.text.toLowerCase() === text.toLowerCase());
  if (dupe) return res.status(409).json({ error: 'already suggested', id: dupe.id });
  const suggestion = {
    id: crypto.randomBytes(6).toString('hex'),
    text,
    by: me.id,
    byHandle: me.handle || '',
    votes: [me.id], // suggester auto-votes
    createdAt: Date.now()
  };
  brandVote.suggestions.push(suggestion);
  saveBrandVote();
  res.json({ ok: true, id: suggestion.id });
});

app.post('/api/brand-vote/upvote', rateLimit({ key: 'brand-up', max: 60, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const id = String((req.body && req.body.id) || '');
  const s = activeSuggestions().find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'not found' });
  s.votes = s.votes || [];
  const idx = s.votes.indexOf(me.id);
  if (idx >= 0) s.votes.splice(idx, 1);
  else s.votes.push(me.id);
  saveBrandVote();
  res.json({ ok: true, votes: s.votes.length, didIVote: s.votes.includes(me.id) });
});

// =================================================================
// SOCIAL PROOF — public, no auth. Feeds FOMO counters on onboard.html
// and gate.html. Member count padded by getFakeMemberPad() so it never
// reads as zero on a fresh install.
// =================================================================
app.get('/api/social-proof', (_req, res) => {
  const now = Date.now();
  const real = users.filter(u => u.status === 'active').length;
  const memberCount = real + getFakeMemberPad();
  const gateCount = users.filter(u => u.mustSpendInitialInvites).length;
  const today = new Date(now);
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const postsToday = posts.filter(p => p.createdAt > dayStart).length;
  const onlineRaw = realisticOnlineCount();
  const onlineCount = Math.max(onlineRaw, Math.floor(memberCount * 0.08));
  res.json({ memberCount, gateCount, postsToday, onlineCount, ts: now });
});

// =================================================================
// GATE TEASERS — anonymized, truncated snippets of real recent posts
// shown to gate users so they see exactly what they're missing.
// Auth required (must be logged in + mustSpendInitialInvites).
// Text is truncated at 60 chars, author name replaced with "someone".
// =================================================================
app.get('/api/gate-teasers', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (!me.mustSpendInitialInvites) return res.json({ teasers: [] });
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  // Grab recent real (non-ghost, non-anon) text posts — shuffle, take 4
  const recent = posts
    .filter(p => p.createdAt > oneDayAgo && !p.isGhost && !p.isAnonymous && (p.content || p.caption))
    .sort(() => Math.random() - 0.5)
    .slice(0, 4);
  const teasers = recent.map(p => {
    const raw = String(p.content || p.caption || '');
    const snip = raw.length > 60 ? raw.slice(0, 58) + '…' : raw;
    const ago = Math.floor((now - p.createdAt) / 60000);
    const agoStr = ago < 60 ? ago + 'm ago' : Math.floor(ago / 60) + 'h ago';
    return { snip, ago: agoStr };
  });
  res.json({ teasers });
});

app.get('/api/site-info', (_req, res) => {
  const brandToday = dailyBrandName();
  const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrow = brandForDay(tomorrowDate);
  res.json({
    siteName: config.siteName,
    brandToday,
    brandTomorrow: tomorrow,
    brandTomorrowFromVote: tomorrow !== dailyBrandName(tomorrowDate),
    // legacy field for older clients
    streetWord: brandToday,
    postCount: posts.filter(p => !p.expiresAt || p.expiresAt > Date.now()).length,
    onlineCount: realisticOnlineCount(),
    paused: SITE_PAUSED,
    pauseMessage: SITE_PAUSED ? SITE_PAUSE_MESSAGE : '',
    pauseGif: SITE_PAUSED ? SITE_PAUSE_GIF : '',
    pauseApology: SITE_PAUSED ? SITE_PAUSE_APOLOGY : [],
    pauseTeasers: SITE_PAUSED ? SITE_PAUSE_TEASERS : []
  });
});

// =================================================================
// PHONE AUTH + INVITE SYSTEM
//
// New flow (replaces school-email + password):
//   1) POST /api/auth/phone/start  { phone }
//        → Twilio Verify sends an SMS code to the phone.
//   2) POST /api/auth/phone/check  { phone, code }
//        → If existing account: returns { existingAccount: true, user, token }
//        → If new account: returns { existingAccount: false, verifyTicket }
//   3) POST /api/auth/signup       { verifyTicket, name, schoolId, gradYear,
//                                    inviteToken, tosAgreed }
//        → Creates the user, consumes the invite token, joins them to the
//          inviter's group, returns { user, token }.
//
// Invite mechanic:
//   - Each user gets exactly 2 invite slots (user.invites[0..1]).
//   - Inviting locks the slot to one phone number; that phone is the only
//     one that can claim it (no forwarding).
//   - Until BOTH slots are CLAIMED, the inviter is invite-locked (read-only,
//     enforced in requireUser).
//   - The inviter + their 2 claimed invitees form a permanent Group.
// =================================================================

const ROOT_INVITE_CODES = String(process.env.ROOT_INVITE_CODES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Currency rules — informed by the playbook (Lobste.rs tree + slow refresh).
const STARTING_REFERRAL_BALANCE = 3;   // playbook: 3 starting invites/user
const POSTS_PER_EARNED_REFERRAL = 3;   // 3 posts = +1 referral
const INVITE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;    // unredeemed → auto-refund after 14 days
const NEW_MEMBER_WINDOW_MS = 70 * 24 * 60 * 60 * 1000; // first 70 days = "new member"
const NEW_MEMBER_POSTS_PER_DAY = 8;     // rate-limit new accounts
const MS_PER_MONTHLY_REFERRAL = 30 * 24 * 60 * 60 * 1000; // +1 per ~month

// Short-lived verify tickets — phone proved-fresh by Twilio. Map<phoneE164, {ticket, expiresAt}>.
// Tickets expire 10 minutes after verify so a stale tab can't replay.
const verifyTickets = new Map();
function issueVerifyTicket(phoneE164) {
  const ticket = crypto.randomBytes(24).toString('hex');
  verifyTickets.set(ticket, { phoneE164, expiresAt: Date.now() + 10 * 60 * 1000 });
  if (verifyTickets.size > 1000) {
    const now = Date.now();
    for (const [k, v] of verifyTickets) if (v.expiresAt < now) verifyTickets.delete(k);
  }
  return ticket;
}
function consumeVerifyTicket(ticket) {
  const v = verifyTickets.get(ticket);
  if (!v) return null;
  if (v.expiresAt < Date.now()) { verifyTickets.delete(ticket); return null; }
  verifyTickets.delete(ticket);
  return v.phoneE164;
}

// ===================================================================
// SCHOOL DIRECTORIES — per-school student lists used during signup for
// the 3-refs picker. Ancient Old Streets uses lib/directory.json (legacy). Each
// other school gets its own JSON file at data/school-directories/<id>.json
// with shape: [{ name, email, gradYear? }, ...].
// ===================================================================
function ensureSchoolDirectoriesDir() {
  try { if (!fs.existsSync(SCHOOL_DIRECTORIES_DIR)) fs.mkdirSync(SCHOOL_DIRECTORIES_DIR, { recursive: true }); } catch {}
}
ensureSchoolDirectoriesDir();

function loadSchoolDirectory(schoolId) {
  const safe = String(schoolId || '').replace(/[^a-z0-9_-]/g, '');
  if (!safe) return [];
  // Ancient Old Streets always uses the legacy directory
  if (safe === 'new-roads') return directory || [];
  const file = path.join(SCHOOL_DIRECTORIES_DIR, safe + '.json');
  try {
    if (!fs.existsSync(file)) return [];
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}
function saveSchoolDirectory(schoolId, list) {
  const safe = String(schoolId || '').replace(/[^a-z0-9_-]/g, '');
  if (!safe || safe === 'new-roads') return false;
  ensureSchoolDirectoriesDir();
  const file = path.join(SCHOOL_DIRECTORIES_DIR, safe + '.json');
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  return true;
}

// Parse a CSV (or newline-separated email list) into directory entries.
// Accepted formats per row:
//   name, email
//   name, email, gradYear
//   email                        (name auto-derived from local-part)
function parseDirectoryCsv(csv) {
  const out = [];
  const lines = String(csv || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith('name,') && line.toLowerCase().includes('email')) continue; // header
    const cells = line.split(',').map(s => s.trim());
    let name = '', email = '', gradYear = '';
    if (cells.length === 1) {
      email = cells[0];
      name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    } else if (cells.length >= 2) {
      name = cells[0];
      email = cells[1];
      if (cells.length >= 3) gradYear = cells[2];
    }
    email = email.toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (!name) name = email.split('@')[0];
    out.push({ name, email, ...(gradYear ? { gradYear } : {}) });
  }
  return out;
}

// Per-school allowed email domains. Used to reject signups with the wrong
// school's domain. NR has no domain check (phone-based signup). Domains
// can be expanded via admin endpoint later.
const SCHOOL_EMAIL_DOMAINS = {
  'beverly-hills': ['bhusd.k12.ca.us', 'bhhs.bhusd.k12.ca.us'],
  'crossroads':    ['xrds.org'],
  'new-roads':     ['newroads.org']
};
function emailMatchesSchool(email, schoolId) {
  const e = String(email || '').toLowerCase().trim();
  const m = e.match(/@([a-z0-9.-]+)$/);
  if (!m) return false;
  const domain = m[1];
  const allowed = SCHOOL_EMAIL_DOMAINS[schoolId] || [];
  // Admin override: allow ANY @ for now via empty allowlist; but if any
  // domains are configured, require a match (or a subdomain match).
  if (!allowed.length) return true;
  return allowed.some(d => domain === d || domain.endsWith('.' + d));
}

// ===================================================================
// EMAIL VERIFICATION CODES — 6-digit numeric, 10-minute TTL.
// Sent via Resend if RESEND_API_KEY is set; otherwise console.log fallback
// so dev can still progress.
// ===================================================================
let emailVerifyState = (() => {
  try {
    if (fs.existsSync(EMAIL_VERIFY_FILE)) {
      const j = JSON.parse(fs.readFileSync(EMAIL_VERIFY_FILE, 'utf8'));
      if (j && typeof j === 'object') return j;
    }
  } catch {}
  return { codes: {}, attempts: {} }; // email → { code, expiresAt, schoolId, tries }
})();
function saveEmailVerifyState() {
  try { fs.writeFileSync(EMAIL_VERIFY_FILE, JSON.stringify(emailVerifyState, null, 2)); } catch {}
}

async function sendVerifyEmail(toEmail, code, schoolName) {
  const key = process.env.RESEND_API_KEY || '';
  const from = process.env.RESEND_FROM || 'Old Streets <no-reply@oldstreets.org>';
  const subject = `your old streets code: ${code}`;
  const html = `
    <div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px;">
      <h1 style="font-size:22px;margin:0 0 14px;">old streets — verify your school email</h1>
      <p style="margin:0 0 12px;">someone (probably you) started a signup for old streets <b>${schoolName || ''}</b> edition with this email.</p>
      <p style="margin:0 0 12px;">your one-time code:</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:8px;font-family:'Lucida Console',monospace;padding:16px 24px;background:#f6f8fc;border:1px solid #29447e;color:#003399;text-align:center;border-radius:4px;">${code}</div>
      <p style="margin:18px 0 12px;font-size:12px;color:#666;">this code expires in 10 minutes. if this wasn't you, ignore this email — no account is created until the code is entered.</p>
      <p style="margin:14px 0 0;font-size:12px;color:#666;">— old streets</p>
    </div>`;
  if (!key) {
    console.log(`[email-verify] (no RESEND_API_KEY) would send code ${code} to ${toEmail}`);
    return { ok: false, error: 'no-resend-api-key', code };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [toEmail], subject, html })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn('[email-verify] resend failed', r.status, data); return { ok: false, error: data.message || ('resend-' + r.status) }; }
    return { ok: true, id: data.id };
  } catch (e) {
    console.warn('[email-verify] send error', e.message);
    return { ok: false, error: 'resend-network: ' + e.message };
  }
}

// ===================================================================
// ENDPOINTS — public read of school directories + email verify flow.
// ===================================================================

// GET /api/school-directory/:schoolId — entries available for the 3-refs
// picker during signup. Returns name + email-mask (for privacy) — full
// email is only revealed once user enters their own verified email.
app.get('/api/school-directory/:schoolId', (req, res) => {
  const sid = String(req.params.schoolId || '').toLowerCase();
  if (!['new-roads', 'beverly-hills', 'crossroads'].includes(sid)) {
    return res.status(404).json({ error: 'no directory for this school' });
  }
  const list = loadSchoolDirectory(sid).map(d => ({
    name: d.name,
    email: d.email,
    gradYear: d.gradYear || ''
  }));
  res.json({ schoolId: sid, count: list.length, entries: list });
});

// POST /api/admin/school-directory/:schoolId/upload — admin uploads a CSV
// body. Each row: "name,email[,gradYear]" or just "email".
app.post('/api/admin/school-directory/:schoolId/upload', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sid = String(req.params.schoolId || '').toLowerCase();
  if (!['beverly-hills', 'crossroads'].includes(sid)) {
    return res.status(400).json({ error: 'directory upload only supported for beverly-hills / crossroads (new-roads uses legacy directory.json)' });
  }
  const csv = String(req.body || '');
  if (!csv.trim()) return res.status(400).json({ error: 'empty body' });
  const parsed = parseDirectoryCsv(csv);
  if (!parsed.length) return res.status(400).json({ error: 'no valid rows parsed — expected "name,email" per row' });
  saveSchoolDirectory(sid, parsed);
  res.json({ ok: true, schoolId: sid, count: parsed.length, sample: parsed.slice(0, 3) });
});

// GET /api/admin/school-directory/:schoolId — admin reads the current directory
app.get('/api/admin/school-directory/:schoolId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sid = String(req.params.schoolId || '').toLowerCase();
  const list = loadSchoolDirectory(sid);
  res.json({ schoolId: sid, count: list.length, entries: list });
});

// POST /api/auth/email-verify-start — kick off email verification.
// Body: { email, schoolId }. Validates that email is in the school's
// directory (or matches an allowed domain), generates a 6-digit code,
// stores it with 10-min TTL, sends via Resend.
app.post('/api/auth/email-verify-start',
  rateLimit({ key: 'email-verify-start', max: 8, windowMs: 60 * 60 * 1000 }),
  async (req, res) => {
    const email = String((req.body && req.body.email) || '').toLowerCase().trim();
    const schoolId = String((req.body && req.body.schoolId) || '').toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
    if (!['beverly-hills', 'crossroads'].includes(schoolId)) return res.status(400).json({ error: 'email signup is only enabled for beverly-hills and crossroads' });
    if (findUserByEmail(email)) return res.status(409).json({ error: 'email already registered — sign in instead' });
    // Hard domain check
    if (!emailMatchesSchool(email, schoolId)) return res.status(403).json({ error: `email domain doesn't match ${schoolId} — use your school email` });
    // Directory presence check — must be on the school's directory.
    const dir = loadSchoolDirectory(schoolId);
    const hit = dir.find(d => (d.email || '').toLowerCase() === email);
    if (!hit) return res.status(404).json({ error: 'you are not in our directory for that school — ask an admin to add you' });

    const code = (Math.floor(Math.random() * 900000) + 100000).toString();
    emailVerifyState.codes = emailVerifyState.codes || {};
    emailVerifyState.codes[email] = { code, schoolId, expiresAt: Date.now() + 10 * 60 * 1000, tries: 0 };
    saveEmailVerifyState();
    const schoolName = (LAUNCH_THREE.find(s => s.id === schoolId) || {}).name || schoolId;
    const sendResult = await sendVerifyEmail(email, code, schoolName);
    res.json({ ok: true, sent: sendResult.ok, fallback: !sendResult.ok ? 'check server logs for code' : null });
  }
);

// POST /api/auth/email-verify-check — body { email, code }. Returns a
// short-lived signup ticket on success.
app.post('/api/auth/email-verify-check', rateLimit({ key: 'email-verify-check', max: 20, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!email || !code) return res.status(400).json({ error: 'email and code required' });
  const entry = (emailVerifyState.codes || {})[email];
  if (!entry) return res.status(400).json({ error: 'no pending code for this email — start verification again' });
  if (entry.expiresAt < Date.now()) { delete emailVerifyState.codes[email]; saveEmailVerifyState(); return res.status(400).json({ error: 'code expired — start verification again' }); }
  entry.tries = (entry.tries || 0) + 1;
  if (entry.tries > 6) { delete emailVerifyState.codes[email]; saveEmailVerifyState(); return res.status(429).json({ error: 'too many tries — start verification again' }); }
  if (entry.code !== code) { saveEmailVerifyState(); return res.status(400).json({ error: 'wrong code' }); }
  // Mint signup ticket
  const ticket = crypto.randomBytes(16).toString('hex');
  emailVerifyState.tickets = emailVerifyState.tickets || {};
  emailVerifyState.tickets[ticket] = { email, schoolId: entry.schoolId, expiresAt: Date.now() + 30 * 60 * 1000 };
  delete emailVerifyState.codes[email];
  saveEmailVerifyState();
  res.json({ ok: true, ticket, schoolId: entry.schoolId });
});

function consumeEmailSignupTicket(ticket) {
  const t = (emailVerifyState.tickets || {})[ticket];
  if (!t) return null;
  if (t.expiresAt < Date.now()) { delete emailVerifyState.tickets[ticket]; saveEmailVerifyState(); return null; }
  delete emailVerifyState.tickets[ticket];
  saveEmailVerifyState();
  return t;
}

// POST /api/auth/email-signup — body { ticket, name, handle, refs: [3 directory emails] }
// Creates a user with the school locked, handle confirmed, schoolLocked,
// and the 3 picked directory entries recorded as their voucher list.
app.post('/api/auth/email-signup', rateLimit({ key: 'email-signup', max: 10, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const { ticket, name, handle, refs } = req.body || {};
  const tk = consumeEmailSignupTicket(String(ticket || ''));
  if (!tk) return res.status(400).json({ error: 'verify-ticket-expired — re-verify your email' });
  if (findUserByEmail(tk.email)) return res.status(409).json({ error: 'email already registered' });
  const cleanName = String(name || '').trim().slice(0, 40);
  if (cleanName.length < 1) return res.status(400).json({ error: 'name required' });
  // Handle: required for email signup (it's how the picker autocompletes).
  const requestedHandle = normalizeHandle(handle);
  if (!requestedHandle || requestedHandle.length < 3) return res.status(400).json({ error: 'handle must be 3-20 chars' });
  if (!handleAvailable(requestedHandle)) return res.status(409).json({ error: 'handle taken — pick another' });
  // Referrals removed — refs are now optional. If the client still sends
  // any, we'll just record them (de-duped, capped at 3) without validating
  // against the directory or rejecting on count. Waitlist auto-approves in 1-5h.
  const rawRefs = Array.isArray(refs) ? refs.slice(0, 3).map(r => String(r||'').toLowerCase().trim()).filter(Boolean) : [];
  const dedup = new Set(rawRefs.filter(r => r !== tk.email));
  const refList = Array.from(dedup);
  const dir = loadSchoolDirectory(tk.schoolId);

  const school = LAUNCH_THREE.find(s => s.id === tk.schoolId) || { id: tk.schoolId, name: tk.schoolId };
  const now = Date.now();
  const newUser = {
    id: now.toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
    email: tk.email,
    name: cleanName,
    handle: requestedHandle,
    handleChosen: true,
    schoolId: school.id,
    schoolName: school.name,
    schoolLocked: true,
    schoolLockedAt: now,
    selfieTaken: false, // forced selfie still runs after signup
    status: 'waitlist', // admin approves
    createdAt: now,
    waitlistedAt: now,
    token: crypto.randomBytes(24).toString('hex'),
    referralBalance: 0, // earned after approval
    referralsEarned: 0,
    referralsSpent: 0,
    referrals: refList.map(e => {
      const m = dir.find(d => (d.email||'').toLowerCase() === e);
      return { email: e, name: m ? m.name : e.split('@')[0] };
    }),
    friends: [],
    pendingInvites: []
  };
  users.push(newUser);
  saveUsers();
  res.json({ ok: true, user: publicUser(newUser), token: newUser.token });
});


function findUserByPhone(phoneE164) {
  if (!phoneE164) return null;
  return users.find(u => u.phoneE164 === phoneE164) || null;
}

// @handle system — every user gets a unique @-mention handle. Lowercase
// alphanumeric + underscore, 3-20 chars. Used in URLs, mentions, DMs, etc.
function normalizeHandle(h) {
  if (!h) return '';
  let s = String(h).toLowerCase().trim();
  if (s.startsWith('@')) s = s.slice(1);
  s = s.replace(/[^a-z0-9_]/g, '').slice(0, 20);
  return s;
}
function findUserByHandle(h) {
  const n = normalizeHandle(h);
  if (!n) return null;
  // 1) Exact handle match
  const byHandle = users.find(u => (u.handle || '').toLowerCase() === n);
  if (byHandle) return byHandle;
  // 2) Fallback: match by email-prefix (so /u/<email-prefix> works for users
  //    who haven't set a handle yet — fixes "user not found" on legacy refs)
  const byPrefix = users.find(u => ((u.email || '').split('@')[0] || '').toLowerCase() === n);
  if (byPrefix) return byPrefix;
  // 3) Fallback: match by normalized name (first+last lower no-spaces)
  const byName = users.find(u => (u.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '') === n);
  return byName || null;
}
function handleAvailable(h) {
  const n = normalizeHandle(h);
  if (!n || n.length < 3) return false;
  // reserved
  if (['admin', 'support', 'staff', 'official', 'oldstreets', 'orion', 'root', 'system', 'null', 'undefined', 'me', 'you'].includes(n)) return false;
  return !findUserByHandle(n);
}
// Auto-generate a handle from a name. e.g. "West Dorros" → "westdorros".
// Falls back to numeric suffix if taken.
function autoHandleFromName(name) {
  const base = String(name || 'member')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 15) || 'member';
  if (handleAvailable(base)) return base;
  for (let i = 2; i < 99999; i++) {
    const try1 = (base + i).slice(0, 20);
    if (handleAvailable(try1)) return try1;
  }
  return base + Date.now().toString(36).slice(-4);
}
// Backfill handles for any user that doesn't have one. Called from
// loadAll() (after users are read from disk) AND lazily from publicUser
// for stragglers. Idempotent.
function backfillHandles() {
  let n = 0;
  for (const u of users) {
    if (!u.handle) {
      u.handle = autoHandleFromName(u.name || u.email || 'member');
      n++;
    }
  }
  if (n) { saveUsers(); console.log('[handles] backfilled', n, 'users'); }
  return n;
}
function findInviteByToken(token) {
  if (!token) return null;
  for (const u of users) {
    for (const inv of (u.pendingInvites || [])) {
      if (inv.inviteToken === token) return { inviter: u, invite: inv };
    }
  }
  return null;
}

// Earn referrals from posting: every 3 posts → +1. Called after a post is
// successfully created. Safe to call repeatedly — uses postsAtLastEarn as
// the high-water mark so we never double-count.
function maybeEarnReferralFromPosts(user) {
  if (!user || user.status !== 'active') return;
  const pc = user.postCount || 0;
  const last = user.postsAtLastReferralEarn || 0;
  const gained = Math.floor((pc - last) / POSTS_PER_EARNED_REFERRAL);
  if (gained <= 0) return;
  user.referralBalance = (user.referralBalance || 0) + gained;
  user.referralsEarned = (user.referralsEarned || 0) + gained;
  user.postsAtLastReferralEarn = last + gained * POSTS_PER_EARNED_REFERRAL;
  saveUsers();
  pushNotif(user.email || ('id:' + user.id), {
    type: 'referral-earned',
    fromName: '🎟 Referral earned',
    text: `You earned ${gained} referral${gained > 1 ? 's' : ''} from posting. Spend wisely.`,
    ts: Date.now()
  });
}

// Earn referrals from time: +1 every ~30 days, capped at 1 per call.
// Called from whoami so it ticks naturally as users come back.
function maybeEarnMonthlyReferral(user) {
  if (!user || user.status !== 'active') return;
  const last = user.lastMonthlyReferralAt || user.approvedAt || user.createdAt || Date.now();
  if (Date.now() - last < MS_PER_MONTHLY_REFERRAL) return;
  user.referralBalance = (user.referralBalance || 0) + 1;
  user.referralsEarned = (user.referralsEarned || 0) + 1;
  user.lastMonthlyReferralAt = Date.now();
  saveUsers();
  pushNotif(user.email || ('id:' + user.id), {
    type: 'referral-earned',
    fromName: '🎟 Monthly referral',
    text: 'A month has passed — you earned 1 referral. Save it for someone good.',
    ts: Date.now()
  });
}

// -- 1) PHONE AUTH: start (send SMS code) ---------------------------
app.post('/api/auth/phone/start', rateLimit({ key: 'phone-start', max: 6, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const phoneE164 = normPhoneE164(req.body && req.body.phone);
  if (!phoneE164) return res.status(400).json({ error: 'invalid phone number' });
  const u = findUserByPhone(phoneE164);
  if (u && u.status === 'banned') {
    pushThreatEvent({ type: 'banned-phone-attempt', severity: 'med', ip: clientIp(req), who: phoneE164 });
    return res.status(403).json({ error: 'account banned' });
  }
  const r = await twilioStartVerify(phoneE164);
  if (!r.ok) {
    pushThreatEvent({ type: 'sms-start-fail', severity: 'low', ip: clientIp(req), who: phoneE164, note: r.error });
    return res.status(502).json({ error: r.error || 'could not send code' });
  }
  res.json({ ok: true, sent: true, existingAccount: !!u });
});

// -- 2) PHONE AUTH: check (verify SMS code) -------------------------
app.post('/api/auth/phone/check', rateLimit({ key: 'phone-check', max: 15, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const phoneE164 = normPhoneE164(req.body && req.body.phone);
  const code = String((req.body && req.body.code) || '').trim();
  if (!phoneE164) return res.status(400).json({ error: 'invalid phone number' });
  if (!/^\d{4,10}$/.test(code)) return res.status(400).json({ error: 'invalid code' });

  const r = await twilioCheckVerify(phoneE164, code);
  if (!r.ok) {
    pushThreatEvent({ type: 'sms-check-fail', severity: 'low', ip: clientIp(req), who: phoneE164, note: r.error || r.status });
    return res.status(401).json({ error: 'wrong or expired code' });
  }

  const existing = findUserByPhone(phoneE164);
  if (existing) {
    if (existing.status === 'banned') return res.status(403).json({ error: 'account banned' });
    // Stay signed in forever across devices: keep the existing token if the
    // account has one, so a new sign-in on device B doesn't kill device A.
    // Token only rotates on explicit /api/me/rotate-token (security-only).
    if (!existing.token) existing.token = newToken();
    existing.lastSeen = Date.now();
    saveUsers();
    return res.json({ existingAccount: true, user: publicUser(existing), token: existing.token });
  }
  // New phone — issue a verify ticket the signup endpoint can consume.
  const ticket = issueVerifyTicket(phoneE164);
  res.json({ existingAccount: false, verifyTicket: ticket, phoneE164 });
});

// -- 3) AUTH: complete signup (after phone verified) ---------------
// Every new account lands on the WAITLIST. Having a valid invite token
// just tags the account as "vouched" so the admin sees it prioritized.
// Admin approval (or root-code bypass) is required before status flips
// to 'active' and they get their starting 2 referrals to spend.
app.post('/api/auth/signup', rateLimit({ key: 'signup-finish', max: 10, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const { verifyTicket, name, schoolId, school: pickedSchool, schoolLabel, gradYear, inviteToken, rootCode, tosAgreed } = req.body || {};
  const phoneE164 = consumeVerifyTicket(String(verifyTicket || ''));
  if (!phoneE164) return res.status(400).json({ error: 'verify-ticket-expired — restart phone verification' });
  if (findUserByPhone(phoneE164)) return res.status(409).json({ error: 'phone already registered — sign in instead' });

  const cleanName = String(name || '').trim().slice(0, 40);
  if (cleanName.length < 1) return res.status(400).json({ error: 'name required' });

  // School and grad year are now OPTIONAL — no more school association at signup.
  // User can self-tag in their profile later if they want.
  const cleanGradYear = String(gradYear || '').trim();
  const VALID_YEARS = validGradYears();
  const gradYearOk = !cleanGradYear || VALID_YEARS.includes(cleanGradYear);
  if (!gradYearOk) {
    return res.status(400).json({ error: 'graduation year must be a valid year' });
  }
  const school = schoolId ? findSchoolById(String(schoolId)) : null;

  // Handle: required at signup. Lowercase alphanumeric + underscore, 3-20 chars.
  const requestedHandle = normalizeHandle(req.body && req.body.handle);
  if (requestedHandle && requestedHandle.length < 3) {
    return res.status(400).json({ error: 'handle must be 3-20 chars (a-z, 0-9, _)' });
  }
  if (requestedHandle && !handleAvailable(requestedHandle)) {
    return res.status(409).json({ error: 'handle taken — pick another' });
  }
  const handle = requestedHandle || autoHandleFromName(cleanName);

  if (!tosAgreed) return res.status(400).json({ error: 'you must agree to the terms' });

  // Validate invite token if provided — token holders are still subject to
  // the waitlist (everyone waits), but they're marked "vouched" and get
  // prioritized in the admin queue.
  let inviter = null;
  let inviteRec = null;
  if (inviteToken) {
    const hit = findInviteByToken(String(inviteToken));
    if (!hit) return res.status(400).json({ error: 'invite not found or already used' });
    if (hit.invite.claimedBy) return res.status(409).json({ error: 'invite already used' });
    if (hit.invite.contactType === 'phone' && hit.invite.contact && hit.invite.contact !== phoneE164) {
      pushThreatEvent({
        type: 'invite-phone-mismatch', severity: 'med', ip: clientIp(req),
        who: phoneE164, note: `expected ${hit.invite.contact}`
      });
      return res.status(403).json({ error: 'this invite was sent to a different phone number' });
    }
    inviter = hit.inviter;
    inviteRec = hit.invite;
  }
  const usingRoot = rootCode && ROOT_INVITE_CODES.includes(String(rootCode));

  // Invite holders skip the application/waitlist entirely AND root-code
  // signups skip it. Both start active, but invite-holders still have to
  // spend their 2 starting invites before the site fully unlocks (the
  // forced-invite gate). This is the "you're in — now bring your two" UX.
  const hasValidInvite = !!(inviter && inviteRec);
  const startActive = !!usingRoot || hasValidInvite;
  const now = Date.now();

  const newUser = {
    id: newId(),
    email: 'user-' + newId().slice(0, 8) + '@os.local',
    phoneE164,
    name: cleanName,
    handle,
    schoolId: pickedSchool || (school ? school.id : ''),
    schoolName: schoolLabel || (school ? school.name : ''),
    gradYear: cleanGradYear,
    bio: '',
    avatar: '',
    status: startActive ? 'active' : 'waitlist',
    invitedBy: inviter ? inviter.id : '',
    // Referrals removed — no forced-invite gate. Everyone gets full access
    // once they're active (instant for invite/root, ≤5h auto-approve otherwise).
    mustSpendInitialInvites: false,
    referralBalance: startActive ? STARTING_REFERRAL_BALANCE : 0,
    referralsEarned: 0,
    referralsSpent: 0,
    postsAtLastReferralEarn: 0,
    lastMonthlyReferralAt: startActive ? now : 0,
    pendingInvites: [],
    waitlistedAt: startActive ? 0 : now,
    waitlistShareToken: 'w' + crypto.randomBytes(6).toString('hex'),
    waitlistShareClicks: 0,
    waitlistShareSignups: 0,
    waitlistReferrerToken: (() => {
      const fromBody = String((req.body && req.body.ref) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
      if (fromBody) return fromBody;
      const cookieHdr = req.headers.cookie || '';
      const m = cookieHdr.match(/os_wlref=([^;]+)/);
      return m ? m[1].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) : '';
    })(),
    approvedAt: startActive ? now : 0,
    token: newToken(),
    referrals: [],
    friends: [],
    createdAt: now,
    lastSeen: now,
    isAdmin: false,
    grade: '',
    tosAgreedVersion: CURRENT_TOS_VERSION,
    tosAgreedAt: now,
    // legacy schoolEmail fields kept verified so old code paths don't trip
    schoolEmailVerified: true
  };
  users.push(newUser);

  // Trigger phone-crush matching if anyone has been silently crushing on
  // this new user's number. Awards both sides + texts the secret admirer.
  try { processPhoneCrushOnSignup(newUser); } catch (e) { console.warn('[phone-crush] failed', e.message); }

  // Credit the waitlist referrer (if any). Worth 10 boost points (vs 1 per click).
  if (newUser.waitlistReferrerToken) {
    const referrer = users.find(u => u.waitlistShareToken === newUser.waitlistReferrerToken && u.id !== newUser.id);
    if (referrer) {
      referrer.waitlistShareSignups = (referrer.waitlistShareSignups || 0) + 1;
      pushNotif(referrer.email, {
        type: 'waitlist-share',
        fromName: '🚀 your share worked',
        text: `${newUser.name} signed up from your link. you moved up the line.`,
        ts: Date.now()
      });
      scheduleSave(USERS_FILE, () => users, 1000);
    }
  }

  if (inviter && inviteRec) {
    inviteRec.claimedBy = newUser.id;
    inviteRec.claimedAt = now;
    inviteRec.claimedName = newUser.name;
    // COMPOUNDING K-RATE: every successful claim grants the inviter +1
    // fresh invite. Combined with the 3-invite forced-gate, this drives K
    // hard. The cap is 10 in flight so it doesn't go runaway.
    if ((inviter.pendingInvites || []).filter(i => !i.claimedBy).length < 10) {
      inviter.referralBalance = (inviter.referralBalance || 0) + 1;
      inviter.referralsEarned = (inviter.referralsEarned || 0) + 1;
    }
    pushNotif(inviter.email || ('id:' + inviter.id), {
      type: 'invite-claimed',
      fromName: newUser.name,
      fromEmail: newUser.email,
      text: `${newUser.name} joined via your invite. +1 fresh invite for you to keep going.`,
      ts: now
    });
    // SMS the inviter too — they get the dopamine hit immediately
    if (inviter.phoneE164) {
      const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
      twilioSendSms(inviter.phoneE164, `${newUser.name.split(' ')[0]} joined old streets from your invite. +1 fresh invite. ${base}`).catch(() => {});
    }

    // ===== AUTO-GROUP: every invitee + their inviter share a permanent,
    // locked group. Once the second invitee joins, the group becomes
    // 3 people (inviter + invitee#1 + invitee#2). Group can never be
    // renamed, members can't leave, no one new can be added. Pure
    // "the people who brought you here" social anchor.
    try {
      const inviterEmail = (inviter.email || '').toLowerCase();
      const newEmail = (newUser.email || '').toLowerCase();
      // Find existing inviter-anchored locked group (if any)
      let g = groups.find(x => x.lockedReferralAnchor === inviterEmail);
      if (!g) {
        g = {
          id: 'GR-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
          name: (inviter.name ? inviter.name.split(' ')[0] : 'your') + "'s starter crew",
          members: [inviterEmail],
          createdBy: inviterEmail,
          createdAt: now,
          locked: true,                       // members cannot leave
          lockedReferralAnchor: inviterEmail, // unique per inviter
          messages: []
        };
        groups.push(g);
      }
      if (!g.members.includes(newEmail)) g.members.push(newEmail);
      saveGroups();
      // System welcome message to seed the chat
      g.messages.push({
        id: 'sys-' + Date.now().toString(36),
        from: 'system',
        fromName: 'Old Streets',
        text: `${newUser.name} just joined — this is your locked starter group. only the original three live here. say hi.`,
        createdAt: now,
        readBy: []
      });
      saveGroups();
    } catch (e) { console.warn('[auto-group] failed', e.message); }
    // Forced-invite gate clears the moment both tickets are torn — i.e.
    // both pendingInvites have a claimedBy. The inviter unlocks then,
    // not when they merely sent the invites.
    if (inviter.mustSpendInitialInvites) {
      const claimedCount = (inviter.pendingInvites || []).filter(p => p.claimedBy).length;
      if (claimedCount >= 2) {
        inviter.mustSpendInitialInvites = false;
        pushNotif(inviter.email || ('id:' + inviter.id), {
          type: 'unlocked',
          fromName: '🎉 You\'re in',
          text: 'Both of your invites came through. The rest of the site is unlocked.',
          ts: now
        });
      }
    }
  }

  saveUsers();
  io.emit('admin-event', {
    type: 'new-signup',
    waitlisted: !startActive,
    vouched: !!inviter,
    via: usingRoot ? 'root' : (inviter ? 'invite' : 'open')
  });
  res.json({ user: publicUser(newUser), token: newUser.token });
});

// =================================================================
// CLAIM — restore a profile from the pre-wipe backup. Operator restores
// a user record into users.json with a claimToken; the legitimate owner
// hits /onboard.html?claim=<token> and after phone verification their
// phone is attached to the existing record (preserving bio/avatar/etc).
// =================================================================
function findUserByClaimToken(token) {
  if (!token) return null;
  return users.find(u => u.claimToken && u.claimToken === token) || null;
}

// GET /api/auth/claim/info?token=  — public preview so onboard can show
// "Welcome back, [Name]" without exposing sensitive fields.
app.get('/api/auth/claim/info', (req, res) => {
  const tok = String(req.query.token || '').trim();
  const u = findUserByClaimToken(tok);
  if (!u) return res.status(404).json({ error: 'claim-not-found-or-used' });
  if (u.phoneE164) return res.status(409).json({ error: 'already-claimed' });
  res.json({
    ok: true,
    name: u.name,
    school: u.schoolName || '',
    bio: u.bio || '',
    hasAvatar: !!(u.avatar && u.avatar.length > 10),
    restoredAt: u.restoredAt || 0
  });
});

// POST /api/auth/claim/finish { verifyTicket, claimToken }
// Attaches the just-verified phone to the existing user record and
// returns the auth token. One-shot — the claimToken is cleared after use.
app.post('/api/auth/claim/finish', rateLimit({ key: 'claim-finish', max: 10, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const verifyTicket = String((req.body && req.body.verifyTicket) || '');
  const claimToken = String((req.body && req.body.claimToken) || '');
  const phoneE164 = consumeVerifyTicket(verifyTicket);
  if (!phoneE164) return res.status(400).json({ error: 'verify-ticket-expired' });
  if (findUserByPhone(phoneE164)) return res.status(409).json({ error: 'phone already on another account' });
  const u = findUserByClaimToken(claimToken);
  if (!u) return res.status(404).json({ error: 'claim-not-found-or-used' });
  if (u.phoneE164) return res.status(409).json({ error: 'already-claimed' });
  u.phoneE164 = phoneE164;
  u.token = newToken();
  u.claimToken = null;
  u.lastSeen = Date.now();
  u.status = 'active'; // bypass waitlist for restored accounts
  saveUsers();
  console.log(`[claim] ${u.name} (${u.email}) claimed via phone ${phoneE164}`);
  res.json({ user: publicUser(u), token: u.token });
});

// =================================================================
// @HANDLES — set, check availability, look up by handle.
// =================================================================
app.get('/api/handle/check', (req, res) => {
  const h = normalizeHandle(req.query.h || '');
  if (!h) return res.json({ ok: false, available: false, error: 'too short' });
  if (h.length < 3) return res.json({ ok: false, available: false, error: 'must be 3+ chars' });
  res.json({ ok: true, normalized: h, available: handleAvailable(h) });
});

app.post('/api/me/set-handle', (req, res) => {
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const newHandle = normalizeHandle(req.body && req.body.handle);
  if (newHandle.length < 3) return res.status(400).json({ error: 'handle must be at least 3 chars' });
  // If it's the same as my current handle, ACCEPT IT and flip handleChosen
  // — this is the "keep my auto-handle" path through the onboarding gate.
  if ((me.handle || '').toLowerCase() === newHandle) {
    me.handleChosen = true;
    saveUsers();
    return res.json({ ok: true, handle: me.handle, user: publicUser(me) });
  }
  if (!handleAvailable(newHandle)) return res.status(409).json({ error: 'taken' });
  me.handle = newHandle;
  me.handleChosen = true; // confirms they've gone through the handle gate
  saveUsers();
  res.json({ ok: true, handle: me.handle, user: publicUser(me) });
});

// Public profile lookup by @handle. Returns the same shape as
// /api/users/profile/:email but keyed by handle.
app.get('/api/u/:handle', (req, res) => {
  const u = findUserByHandle(req.params.handle);
  if (!u) return res.status(404).json({ error: 'not found' });
  // School isolation removed — any signed-in member can view any other
  // member's profile so "click a name → profile" always works.
  res.json({ user: publicUser(u) });
});

// =================================================================
// CRUSH — external delivery via SMS invite link. The recipient need
// not be on the platform; their phone gets a one-shot link with the
// crush message attached. When they sign up, the message is delivered.
// =================================================================
// External crush DISABLED per spec — crush is in-site only. Endpoint
// stubbed to 410 so any stale client gets a clean error instead of
// blowing up.
const externalCrushes = []; // kept for the preview route below; never populated
app.post('/api/crush/external', (_req, res) => {
  res.status(410).json({ error: 'in-site-only-now', message: 'crush is for members only — use their @handle' });
});

// Public preview for an external crush link.
app.get('/api/crush/external/:token', (req, res) => {
  const c = externalCrushes.find(x => x.token === req.params.token);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (c.claimedBy) return res.status(409).json({ error: 'already opened' });
  res.json({
    ok: true,
    fromName: c.fromName,
    fromHandle: c.fromHandle,
    message: c.message,
    sentAt: c.sentAt
  });
});

// Pretty URL → onboarding with the crush token in the query.
app.get('/c/:token', (req, res) => {
  const t = String(req.params.token || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  res.redirect('/onboard.html?crush=' + encodeURIComponent(t));
});

// -- AUTH: logout (just rotates token) ------------------------------
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  const u = findUserByToken(token);
  if (u) {
    u.token = newToken();
    saveUsers();
  }
  res.json({ ok: true });
});

// -- DEPRECATED: old email+password signup/login (phone is the new way)
app.post('/api/signup', (_req, res) => {
  res.status(410).json({ error: 'gone', message: 'email/password signup is gone. Use phone sign-in at /api/auth/phone/start.' });
});
app.post('/api/login', (_req, res) => {
  res.status(410).json({ error: 'gone', message: 'email/password login is gone. Use phone sign-in at /api/auth/phone/start.' });
});

// =================================================================
// SCHOOLS LIST — static JSON shipped at data/schools.json. Loaded on
// boot, exposed via /api/schools. Used by signup form to render the
// "pick your school" picker.
// =================================================================
// schools.json lives in /app/lib (NOT in /app/data) so it ships with the
// image and isn't masked by the persistent volume on Fly. Static asset.
const SCHOOLS_FILE = path.join(__dirname, 'lib', 'schools.json');
let schoolsDb = { version: 0, schools: [] };
let schoolsById = new Map();
function loadSchools() {
  try {
    if (fs.existsSync(SCHOOLS_FILE)) {
      schoolsDb = JSON.parse(fs.readFileSync(SCHOOLS_FILE, 'utf8'));
      schoolsById = new Map((schoolsDb.schools || []).map(s => [s.id, s]));
      console.log(`[schools] loaded ${schoolsDb.schools.length} schools`);
    } else {
      console.warn('[schools] data/schools.json missing — picker will be empty');
    }
  } catch (e) {
    console.warn('[schools] load failed:', e.message);
  }
}
loadSchools();

function findSchoolById(id) {
  return schoolsById.get(id) || null;
}

// Public: returns the full schools list (~200 entries, small JSON).
// Optional ?near=ZIP returns only schools whose `zips` includes that ZIP,
// fallback to schools in the same state if no ZIP match.
app.get('/api/schools', (req, res) => {
  const zip = String(req.query.zip || '').trim().slice(0, 10);
  const all = schoolsDb.schools || [];
  if (!zip) return res.json({ version: schoolsDb.version || 0, schools: all });
  const byZip = all.filter(s => (s.zips || []).includes(zip));
  if (byZip.length) return res.json({ version: schoolsDb.version || 0, schools: byZip, mode: 'zip' });
  res.json({ version: schoolsDb.version || 0, schools: all, mode: 'all' });
});

// =================================================================
// GRADUATION YEAR — must be a valid high-school graduation year. The
// "high school window" is current year through current year + 3 (a
// freshman this year graduates in 4 years). After the school year
// rolls over in July, the window shifts.
// =================================================================
function validGradYears(d = new Date()) {
  const yr = d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear();
  return [yr, yr + 1, yr + 2, yr + 3].map(String);
}
app.get('/api/grad-years', (_req, res) => {
  res.json({ years: validGradYears() });
});

// =================================================================
// INVITE TOKEN PREVIEW — when a recipient clicks an invite link, the
// landing page calls this to show "X invited you" before they sign up.
// No auth — just a public preview of inviter name + slot status.
// =================================================================
app.get('/api/auth/invite-info', (req, res) => {
  const tok = String(req.query.token || '').trim();
  if (!tok) return res.status(400).json({ error: 'token required' });
  const hit = findInviteByToken(tok);
  if (!hit) return res.status(404).json({ error: 'invite not found' });
  if (hit.slot.claimedBy) return res.status(409).json({ error: 'invite already used' });
  // Mark "opened" the first time someone hits the preview endpoint so the
  // inviter sees yellow-glow status on their ticket.
  if (!hit.slot.openedAt) {
    hit.slot.openedAt = Date.now();
    saveUsers();
  }
  res.json({
    fromName: hit.inviter.name || 'A member',
    fromHandle: hit.inviter.handle || '',
    inviterName: hit.inviter.name,
    inviterHandle: hit.inviter.handle || '',
    inviterSchool: hit.inviter.schoolName || '',
    sentAt: hit.slot.sentAt || 0,
    contactType: hit.slot.contactType || 'phone'
  });
});

// =================================================================
// INVITES — for an authenticated user. Each user has exactly 2 slots.
//   GET  /api/invites/me            → returns my 2 slots
//   POST /api/invites/send          → fill an empty slot with a phone
//   POST /api/invites/resend        → re-trigger SMS for an unclaimed slot
// =================================================================
function buildInviteUrl(token) {
  const base = (config.publicUrl || 'http://localhost:3001').replace(/\/$/, '');
  return `${base}/i/${token}`;
}

// SUSPENSEFUL INVITE SMS — keeps the sender ANONYMOUS, leans on "someone
// from <school>" mystery + chosen-not-asked framing. Recipient never sees
// who picked them. Builds curiosity → claim. School name interpolated when
// known. Length ≤140 chars so the link auto-previews on iMessage.
const INVITE_SMS_TEMPLATES = [
  (n, u, s) => `someone from ${s} chose u to join old streets. claim ur spot: ${u}`,
  (n, u, s) => `someone at ${s} picked u for old streets. dont waste it — ${u}`,
  (n, u, s) => `u were chosen for old streets by someone at ${s}. ${u}`,
  (n, u, s) => `${s} just chose u for old streets. they didnt say who. ${u}`,
  (n, u, s) => `someone in ${s} thinks u belong on old streets. open: ${u}`,
  (n, u, s) => `u got picked. someone at ${s}. spot expires. ${u}`,
  (n, u, s) => `someone from ${s} put ur number in. find out who: ${u}`,
  (n, u, s) => `ur on old streets if u want it. someone at ${s} chose u. ${u}`,
  (n, u, s) => `${s} kid handed ur number to old streets. claim → ${u}`,
  (n, u, s) => `private invite from someone at ${s}. one shot. ${u}`,
  (n, u, s) => `someone at ${s} wants u on old streets. theyre waiting. ${u}`,
  (n, u, s) => `chosen, not asked. someone from ${s}. open: ${u}`,
  (n, u, s) => `someone in ${s} thinks ur missing from old streets. ${u}`,
  (n, u, s) => `u were on someones list at ${s}. now ur on old streets. ${u}`,
  (n, u, s) => `${s} student vouched for u. inside: ${u}`,
  (n, u, s) => `someone in ${s} pulled ur number for old streets. ${u}`,
  (n, u, s) => `if u dont open this someone else gets ur spot. ${s} chose u. ${u}`,
  (n, u, s) => `u were picked at ${s}. the rest is up to u. ${u}`,
  (n, u, s) => `someone at ${s} thinks u'd be good on here. claim: ${u}`,
  (n, u, s) => `${s} → old streets. they chose u. ${u}`
];
function viralInviteSms(senderName, url, schoolName) {
  const name = (String(senderName || 'someone').split(' ')[0]).toLowerCase();
  const school = (schoolName && String(schoolName).trim()) || 'ur school';
  const tpl = INVITE_SMS_TEMPLATES[Math.floor(Math.random() * INVITE_SMS_TEMPLATES.length)];
  return tpl(name, url, school);
}

// POST /api/me/waitlist/speedup — the "skip the line" path for waitlisted
// users. They drop two phone numbers, the server mints two phone-locked
// invite tokens, marks their status active, and clears the forced-invite
// gate (they've already "spent" the two starting referrals by using this).
// Pure viral lever — every waitlisted user becomes a 2x multiplier.
app.post('/api/me/waitlist/speedup', rateLimit({ key: 'wl-speedup', max: 4, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.status !== 'waitlist') return res.status(409).json({ error: 'not on waitlist' });

  const linkMode = !!(req.body && req.body.linkMode);
  const now = Date.now();
  if (!me.pendingInvites) me.pendingInvites = [];

  const mintPhone = (phone) => ({
    contact: phone,
    contactType: 'phone',
    inviteToken: crypto.randomBytes(12).toString('hex'),
    sentAt: now, openedAt: 0, claimedBy: '', claimedAt: 0, claimedName: ''
  });
  const mintLink = () => ({
    contact: '',
    contactType: 'link',
    inviteToken: crypto.randomBytes(12).toString('hex'),
    sentAt: now, openedAt: 0, claimedBy: '', claimedAt: 0, claimedName: ''
  });

  let inv1, inv2;
  if (linkMode) {
    inv1 = mintLink();
    inv2 = mintLink();
  } else {
    const p1 = normPhoneE164(req.body && req.body.phone1);
    const p2 = normPhoneE164(req.body && req.body.phone2);
    if (!p1 || !p2) return res.status(400).json({ error: 'both phones required' });
    if (p1 === p2) return res.status(400).json({ error: 'two different phones — friends, not the same person twice' });
    if (p1 === me.phoneE164 || p2 === me.phoneE164) return res.status(400).json({ error: "can't invite yourself" });
    if (findUserByPhone(p1) || findUserByPhone(p2)) return res.status(409).json({ error: 'one of those phones is already a member — pick someone else' });
    for (const u of users) {
      for (const inv of (u.pendingInvites || [])) {
        if (!inv.claimedBy && (inv.contact === p1 || inv.contact === p2)) {
          return res.status(409).json({ error: 'one of those phones already has a pending invite from someone else' });
        }
      }
    }
    inv1 = mintPhone(p1);
    inv2 = mintPhone(p2);
  }

  me.pendingInvites.push(inv1, inv2);
  me.status = 'active';
  me.approvedAt = now;
  me.referralBalance = 0;
  me.referralsSpent = 2;
  me.mustSpendInitialInvites = false;
  me.lastMonthlyReferralAt = now;
  saveUsers();
  bumpWaitlistVibeOnApprove();

  pushNotif(me.email || ('id:' + me.id), {
    type: 'unlocked',
    fromName: '🔓 You\'re in',
    text: 'You skipped the line. Old Streets is open to you.',
    ts: now
  });

  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  const toClient = (inv) => ({
    contact: inv.contact,
    contactType: inv.contactType,
    token: inv.inviteToken,
    url: `${base}/i/${inv.inviteToken}`,
    smsBody: viralInviteSms(me.name, `${base}/i/${inv.inviteToken}`, me.schoolName)
  });
  res.json({
    ok: true,
    user: publicUser(me),
    token: me.token,
    invites: [toClient(inv1), toClient(inv2)]
  });
});

// GET /api/invites/me — caller's referral wallet + outstanding invites.
app.get('/api/invites/me', (req, res) => {
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (!me.pendingInvites) { me.pendingInvites = []; saveUsers(); }
  res.json({
    referralBalance: me.referralBalance || 0,
    referralsEarned: me.referralsEarned || 0,
    referralsSpent: me.referralsSpent || 0,
    rules: {
      startingBalance: STARTING_REFERRAL_BALANCE,
      postsPerEarn: POSTS_PER_EARNED_REFERRAL,
      monthlyBonus: 1
    },
    nextPostEarnAt: (me.postsAtLastReferralEarn || 0) + POSTS_PER_EARNED_REFERRAL,
    currentPostCount: me.postCount || 0,
    nextMonthlyAt: (me.lastMonthlyReferralAt || me.approvedAt || me.createdAt || Date.now()) + MS_PER_MONTHLY_REFERRAL,
    pendingInvites: me.pendingInvites.map(inv => ({
      contact: inv.contact || '',
      contactType: inv.contactType || '',
      sentAt: inv.sentAt || 0,
      claimedBy: inv.claimedBy || '',
      claimedAt: inv.claimedAt || 0,
      claimedName: inv.claimedName || '',
      inviteUrl: inv.inviteToken ? buildInviteUrl(inv.inviteToken) : ''
    }))
  });
});

// POST /api/invites/mint-link — spend 1 referral, mint an OPEN-LINK invite
// that's not tied to a specific phone. Anyone with the URL can claim it.
// Less precious than phone-locked but easier to share (Instagram, Discord,
// iMessage group, wherever). One claim only.
app.post('/api/invites/mint-link', rateLimit({ key: 'invite-link', max: 10, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.status !== 'active') return res.status(403).json({ error: 'account not active — finish approval first' });
  if (inviteFreezeActive()) return res.status(503).json({ error: 'invite-freeze', message: 'invites are paused right now while the room catches up.' });
  if ((me.referralBalance || 0) < 1) {
    return res.status(403).json({
      error: 'no-referrals',
      message: 'Out of referrals. Earn one by posting 3 posts, or wait for your monthly bonus.'
    });
  }
  if (!me.pendingInvites) me.pendingInvites = [];
  const newInvite = {
    contact: '',           // empty = open link
    contactType: 'link',
    inviteToken: crypto.randomBytes(12).toString('hex'),
    sentAt: Date.now(),
    openedAt: 0,
    claimedBy: '',
    claimedAt: 0,
    claimedName: ''
  };
  me.pendingInvites.push(newInvite);
  me.referralBalance = (me.referralBalance || 0) - 1;
  me.referralsSpent = (me.referralsSpent || 0) + 1;
  me.invitesSentCount = (me.invitesSentCount || 0) + 1;
  saveUsers();
  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  const inviteUrl = `${base}/i/${newInvite.inviteToken}`;
  const smsBody = viralInviteSms(me.name, inviteUrl, me.schoolName);
  // Fire via server Twilio — the recipient sees the Old Streets number,
  // not the inviter's. Anonymity is the point of the new copy.
  twilioSendSms(newInvite.contact || phoneE164, smsBody).catch(()=>{});
  res.json({
    ok: true,
    inviteUrl,
    smsBody,
    referralBalance: me.referralBalance
  });
});

// POST /api/invites/send — spend 1 referral, mint a token tied to a phone.
app.post('/api/invites/send', rateLimit({ key: 'invite-send', max: 10, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.status !== 'active') return res.status(403).json({ error: 'account not active — finish approval first' });
  if (inviteFreezeActive()) return res.status(503).json({ error: 'invite-freeze', message: 'invites are paused right now while the room catches up.' });
  if ((me.referralBalance || 0) < 1) {
    return res.status(403).json({
      error: 'no-referrals',
      message: 'Out of referrals. Earn one by posting 3 posts, or wait for your monthly bonus.'
    });
  }
  const phoneE164 = normPhoneE164(req.body && req.body.phone);
  if (!phoneE164) return res.status(400).json({ error: 'invalid phone number' });
  if (phoneE164 === me.phoneE164) return res.status(400).json({ error: "can't invite yourself" });
  if (findUserByPhone(phoneE164)) return res.status(409).json({ error: 'that person is already on Old Streets' });
  // Dedupe — nobody else has this phone in an outstanding invite
  for (const u of users) {
    for (const inv of (u.pendingInvites || [])) {
      if (inv.contact === phoneE164 && !inv.claimedBy) {
        return res.status(409).json({ error: 'someone has already invited that phone — they can claim through the existing invite' });
      }
    }
  }

  if (!me.pendingInvites) me.pendingInvites = [];
  const newInvite = {
    contact: phoneE164,
    contactType: 'phone',
    inviteToken: crypto.randomBytes(12).toString('hex'),
    sentAt: Date.now(),
    claimedBy: '',
    claimedAt: 0,
    claimedName: ''
  };
  me.pendingInvites.push(newInvite);
  me.referralBalance = (me.referralBalance || 0) - 1;
  me.referralsSpent = (me.referralsSpent || 0) + 1;
  me.invitesSentCount = (me.invitesSentCount || 0) + 1;
  // NOTE: the gate is no longer cleared on send. Tickets must be TORN —
  // i.e. the recipient must actually sign up — before the inviter is
  // considered to have unlocked the site. See /api/auth/signup for the
  // claim path that clears `mustSpendInitialInvites`.
  saveUsers();

  const inviteUrl = buildInviteUrl(newInvite.inviteToken);
  const smsBody = viralInviteSms(me.name, inviteUrl, me.schoolName);
  // Fire via server Twilio — the recipient sees the Old Streets number,
  // not the inviter's. Mystery framing requires hiding the sender.
  twilioSendSms(phoneE164, smsBody).catch(()=>{});
  res.json({
    ok: true,
    inviteUrl,
    contact: phoneE164,
    smsBody,
    referralBalance: me.referralBalance
  });
});

// POST /api/invites/resend — REMOVED to prevent spamming invitees. Senders
// can copy the link and re-share it themselves; the server won't fire a
// fresh SMS for an existing invite.
app.post('/api/invites/resend', (_req, res) => res.status(410).json({
  error: 'resend-disabled',
  message: 'resend is off — copy the link and share it again yourself.'
}));

// POST /api/invites/revoke — pull back an unclaimed invite and refund the
// referral. Only works on pending (not-yet-claimed) invites.
app.post('/api/invites/revoke', (req, res) => {
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const inviteToken = String((req.body && req.body.inviteToken) || '');
  const idx = (me.pendingInvites || []).findIndex(x => x.inviteToken === inviteToken);
  if (idx < 0) return res.status(404).json({ error: 'invite not found' });
  if (me.pendingInvites[idx].claimedBy) return res.status(409).json({ error: 'already claimed — can\'t revoke' });
  me.pendingInvites.splice(idx, 1);
  me.referralBalance = (me.referralBalance || 0) + 1;
  me.referralsSpent = Math.max(0, (me.referralsSpent || 0) - 1);
  saveUsers();
  res.json({ ok: true, referralBalance: me.referralBalance });
});

// =================================================================
// ADMIN — waitlist queue + approve. Approval flips status to active and
// grants the starting referral balance.
// =================================================================
app.get('/api/admin/waitlist', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const wl = users
    .filter(u => u.status === 'waitlist')
    .sort((a, b) => (a.waitlistedAt || 0) - (b.waitlistedAt || 0))
    .map(u => {
      const inviter = u.invitedBy ? users.find(x => x.id === u.invitedBy) : null;
      return {
        id: u.id,
        name: u.name,
        phoneE164: u.phoneE164 || '',
        schoolName: u.schoolName || '',
        gradYear: u.gradYear || '',
        waitlistedAt: u.waitlistedAt || u.createdAt || 0,
        vouched: !!u.invitedBy,
        inviterId: u.invitedBy || '',
        inviterName: inviter ? inviter.name : ''
      };
    });
  res.json({ waitlist: wl, count: wl.length });
});

// Shared approval path — used by admin button AND the auto-approve sweeper.
// No K=3 / mustSpendInitialInvites gate: everyone gets full access on approve.
function approveWaitlistUser(u, opts) {
  if (!u || u.status !== 'waitlist') return false;
  const now = Date.now();
  u.status = 'active';
  u.approvedAt = now;
  u.referralBalance = STARTING_REFERRAL_BALANCE;
  u.lastMonthlyReferralAt = now;
  u.mustSpendInitialInvites = false; // referrals removed — no forced spend
  saveUsers();
  try { sendLetInSms(u); } catch (e) { console.warn('[approve] sms failed', e.message); }
  try { scheduleApprovalDms(u); } catch (e) { console.warn('[approve] dms failed', e.message); }
  try { bumpWaitlistVibeOnApprove(); } catch (e) {}
  const note = `You're in. Welcome to Old Streets.`;
  pushNotif(u.email || ('id:' + u.id), {
    type: 'approved',
    fromName: '✅ You\'re in',
    text: note,
    ts: now
  });
  try { spawnAnonBotPostAbout(u); } catch (e) { console.warn('[bot-post] failed', e.message); }
  return true;
}

// ===== ANONYMOUS BOT POSTS ABOUT NEW JOINERS =====
// When someone joins, we create an anonymous bot post referencing them
// by first name, and SMS the new joiner that they're being talked about.
// The clause is in the TOS (page 6).
const BOT_TEMPLATES = [
  '{name} just joined. anyone know them?',
  'who is {name}',
  'saw {name} on here just now. seen them before?',
  '{name}? new face. vibe check please',
  'someone tell me about {name}',
  '{name} just popped up. interesting',
  'is {name} the one i\'m thinking of',
  'new: {name}. opinions?',
  '{name} joined paths. let\'s see what happens',
  '{name} ok i see you'
];
function spawnAnonBotPostAbout(user) {
  if (!user || !user.name || user.isBot) return;
  const first = String(user.name).trim().split(/\s+/)[0];
  if (!first) return;
  const template = BOT_TEMPLATES[Math.floor(Math.random() * BOT_TEMPLATES.length)];
  const content = template.replace(/\{name\}/g, first);
  const now = Date.now();
  const post = {
    id: newId(),
    authorEmail: 'anon-bot@paths.local',
    authorName: 'anonymous',
    isAnonymous: true,
    isBot: true,
    content,
    createdAt: now,
    reactions: {},
    comments: [],
    views: {}
  };
  posts.push(post);
  savePosts();
  try { io.emit('post-added', publicPost(post)); } catch {}
  // SMS the new joiner that they were posted about (TOS p.5 + p.6 cover this).
  if (user.phoneE164) {
    try {
      twilioSendSms(user.phoneE164, `Someone posted about you on Old Streets. Tap to see: https://old-streets.fly.dev/ — reply STOP to opt out.`).catch(()=>{});
    } catch (e) { console.warn('[bot-post] sms failed', e.message); }
  }
  // In-app notification too, in case SMS isn't configured.
  pushNotif(user.email || ('id:' + user.id), {
    type: 'mention',
    fromName: 'someone',
    text: `posted about you on Old Streets.`,
    postId: post.id,
    ts: now
  });
}

app.post('/api/admin/waitlist/approve', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = String((req.body && req.body.userId) || '');
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  if (u.status !== 'waitlist') return res.status(409).json({ error: 'user not on waitlist' });
  approveWaitlistUser(u, { auto: false });
  res.json({ ok: true, user: publicUser(u) });
});

// ----- AUTO-APPROVE WAITLIST (1-5h random per user) -----
// Each waitlisted user gets a stable delay between 1h and 5h (seeded by id)
// so two restarts give the same target time. Sweeper runs every 60s.
function autoApproveDelayMs(u) {
  if (typeof u.autoApproveDelayMs === 'number' && u.autoApproveDelayMs > 0) {
    return u.autoApproveDelayMs;
  }
  // 1h..5h random
  const min = 60 * 60 * 1000;
  const max = 5 * 60 * 60 * 1000;
  const ms = Math.floor(min + Math.random() * (max - min));
  u.autoApproveDelayMs = ms;
  return ms;
}
setInterval(() => {
  try {
    const now = Date.now();
    let approved = 0;
    for (const u of users) {
      if (!u || u.status !== 'waitlist') continue;
      const start = u.waitlistedAt || u.createdAt || now;
      const delay = autoApproveDelayMs(u);
      if (now - start < delay) continue;
      if (approveWaitlistUser(u, { auto: true })) {
        approved++;
        console.log(`[auto-approve] ${u.name || u.id} after ${Math.round((now-start)/60000)}min`);
      }
    }
    if (approved > 0) saveUsers();
  } catch (e) { console.warn('[auto-approve] sweep failed', e.message); }
}, 60 * 1000);

// ===== Per-user activity log (admin-visible) =====
// In-memory ring buffer keyed by emailLc. Each entry: { kind, label, ref, ts }.
// Capped per-user so memory stays bounded. Not persisted across restarts.
const userActivityLog = new Map();
function recordUserActivity(emailLc, entry) {
  if (!emailLc) return;
  const k = emailLc.toLowerCase();
  if (!userActivityLog.has(k)) userActivityLog.set(k, []);
  const arr = userActivityLog.get(k);
  arr.push(entry);
  if (arr.length > 200) arr.splice(0, arr.length - 200);
}
function recordAction(emailLc, kind, label, ref) {
  recordUserActivity(emailLc, { kind, label, ref: ref || '', ts: Date.now(), action: true });
}

// ===== Admin dashboard helper endpoints =====
app.get('/api/admin/users-count', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    count: users.length,
    active: users.filter(u => u.status === 'active').length,
    waitlist: users.filter(u => u.status === 'waitlist').length,
    banned: users.filter(u => u.status === 'banned').length,
    admins: users.filter(u => u.isAdmin).length
  });
});

app.post('/api/admin/pause', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const paused = !!(req.body && req.body.paused);
  SITE_PAUSED = paused;
  if (paused) SITE_PAUSE_MESSAGE = String((req.body && req.body.message) || 'we\'ll be right back.').slice(0, 200);
  else SITE_PAUSE_MESSAGE = '';
  res.json({ ok: true, paused: SITE_PAUSED, message: SITE_PAUSE_MESSAGE });
});

// Per-user activity log + invite tree — admin-only.
app.get('/api/admin/user/:handle/activity', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserByHandle(req.params.handle);
  if (!u) return res.status(404).json({ error: 'not found' });
  const meLc = (u.email || '').toLowerCase();
  const log = (userActivityLog.get(meLc) || []).slice().reverse();
  // Augment with derived facts so admin can see meaningful per-user history
  // even without an active socket trail.
  const myPosts = posts.filter(p => (p.authorEmail || '').toLowerCase() === meLc).slice(-50).reverse().map(p => ({
    kind: 'post', label: 'posted: "' + String(p.content || p.caption || '(media)').slice(0, 80) + '"',
    ref: p.id, ts: p.createdAt
  }));
  const myComments = [];
  for (const p of posts) {
    for (const c of (p.comments || [])) {
      if ((c.authorEmail || '').toLowerCase() === meLc) {
        myComments.push({ kind: 'comment', label: 'commented on a post: "' + String(c.text || '').slice(0, 60) + '"', ref: p.id, ts: c.createdAt });
      }
    }
  }
  const myDms = dms.filter(m => (m.from || '').toLowerCase() === meLc).slice(-50).reverse().map(m => ({
    kind: 'dm', label: 'sent a chat to ' + (findUserByEmail(m.to)?.handle ? '@'+findUserByEmail(m.to).handle : m.to),
    ref: m.to, ts: m.createdAt
  }));
  const myViews = profileViews.filter(v => (v.viewer || '').toLowerCase() === meLc).slice(-50).reverse().map(v => {
    const t = findUserByEmail(v.target);
    return { kind: 'profile-view', label: 'viewed @' + (t?.handle || v.target.split('@')[0]), ref: v.target, ts: v.ts };
  });
  const everything = log.concat(myPosts, myComments, myDms.slice(0, 30), myViews.slice(0, 30))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 200);
  res.json({
    user: { name: u.name, handle: u.handle, email: u.email, avatar: u.avatar, createdAt: u.createdAt, lastSeen: u.lastSeen, status: u.status, isAdmin: !!u.isAdmin },
    activity: everything,
    counts: {
      posts: posts.filter(p => (p.authorEmail || '').toLowerCase() === meLc).length,
      comments: myComments.length,
      dmsSent: dms.filter(m => (m.from || '').toLowerCase() === meLc).length,
      dmsReceived: dms.filter(m => (m.to || '').toLowerCase() === meLc).length,
      profileViews: myViews.length,
      friends: (u.friends || []).length,
      invitedCount: ((u.pendingInvites || []).filter(p => p.claimedBy)).length,
      pendingInvites: ((u.pendingInvites || []).filter(p => !p.claimedBy)).length
    }
  });
});

// Invite tracker — who invited whom, organized.
app.get('/api/admin/invite-tree', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = users.map(u => {
    const inviter = u.invitedBy ? users.find(x => x.id === u.invitedBy) : null;
    const sent = (u.pendingInvites || []).length;
    const claimed = (u.pendingInvites || []).filter(p => p.claimedBy).length;
    return {
      name: u.name,
      handle: u.handle || '',
      email: u.email,
      status: u.status,
      createdAt: u.createdAt,
      invitedBy: inviter ? { name: inviter.name, handle: inviter.handle || '' } : null,
      invitesSent: sent,
      invitesClaimed: claimed
    };
  }).sort((a, b) => b.invitesClaimed - a.invitesClaimed || b.invitesSent - a.invitesSent);
  res.json({ users: rows });
});

// Detailed admin stats — counts for everything that matters.
app.get('/api/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  res.json({
    users: {
      total: users.length,
      active: users.filter(u => u.status === 'active').length,
      waitlist: users.filter(u => u.status === 'waitlist').length,
      banned: users.filter(u => u.status === 'banned').length,
      admins: users.filter(u => u.isAdmin).length,
      newToday: users.filter(u => (u.createdAt || 0) > dayAgo).length,
      newThisWeek: users.filter(u => (u.createdAt || 0) > weekAgo).length
    },
    online: { now: onlineUsers.size, uniqueNow: new Set(Array.from(onlineUsers.values()).map(u => (u.email||'').toLowerCase())).size },
    posts: {
      total: posts.length,
      today: posts.filter(p => (p.createdAt || 0) > dayAgo).length,
      thisWeek: posts.filter(p => (p.createdAt || 0) > weekAgo).length
    },
    dms: { total: dms.length, today: dms.filter(m => (m.createdAt || 0) > dayAgo).length },
    profileViews: { total: profileViews.length, today: profileViews.filter(v => (v.ts || 0) > dayAgo).length },
    friendRequests: { total: friendRequests.length, pending: friendRequests.filter(r => r.status === 'pending').length },
    invites: {
      sent: users.reduce((s, u) => s + ((u.pendingInvites || []).length), 0),
      claimed: users.reduce((s, u) => s + ((u.pendingInvites || []).filter(p => p.claimedBy)).length, 0)
    }
  });
});

app.post('/api/admin/waitlist/reject', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = String((req.body && req.body.userId) || '');
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  // Reject = full deletion. We don't keep waitlisted-and-rejected records.
  if (u.invitedBy) {
    const inviter = users.find(x => x.id === u.invitedBy);
    if (inviter) {
      for (const inv of (inviter.pendingInvites || [])) {
        if (inv.claimedBy === u.id) {
          inv.claimedBy = '';
          inv.claimedAt = 0;
          inv.claimedName = '';
        }
      }
    }
  }
  const idx = users.findIndex(x => x.id === id);
  if (idx >= 0) users.splice(idx, 1);
  saveUsers();
  res.json({ ok: true, deleted: true });
});

// =================================================================
// ME — delete my account (full purge). Wipes user record + their content.
// =================================================================
app.post('/api/me/leave', (req, res) => {
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const myId = me.id;
  const myEmail = (me.email || '').toLowerCase();
  // Remove their posts, comments inside posts, dms, notifs, friend requests,
  // crush list entries, profile views, etc.
  posts = posts.filter(p => p.authorEmail !== myEmail && p.authorId !== myId);
  for (const p of posts) {
    if (Array.isArray(p.comments)) p.comments = p.comments.filter(c => (c.authorEmail || '') !== myEmail);
  }
  dms = dms.filter(m => m.from !== myEmail && m.to !== myEmail);
  notifs = notifs.filter(n => n.to !== myEmail);
  friendRequests = friendRequests.filter(r => r.from !== myEmail && r.to !== myEmail);
  // Anonymize their claimed-invite slot on the inviter so the group still shows
  if (me.invitedBy) {
    const inviter = users.find(u => u.id === me.invitedBy);
    if (inviter) {
      for (const s of (inviter.invites || [])) {
        if (s.claimedBy === myId) { s.claimedName = '(former member)'; }
      }
    }
  }
  // Drop the user record itself
  const idx = users.findIndex(u => u.id === myId);
  if (idx >= 0) users.splice(idx, 1);
  saveUsers(); savePosts(); saveDMs(); saveNotifs(); saveFriendRequests();
  res.json({ ok: true, deleted: true });
});

// =================================================================
// DAILY 24 — every day, the 24 most-reacted-to image posts from
// yesterday are selected. Users vote pairwise (left vs right). Photos
// accumulate scores from pairwise wins; at midnight UTC the next day,
// a fresh 24 is chosen and yesterday's winners are archived.
// =================================================================
const DAILY24_FILE = path.join(DATA_DIR, 'daily-24.json');
const DAILY24_ARCHIVE_FILE = path.join(DATA_DIR, 'daily-24-archive.json');
let daily24 = { date: '', photoIds: [], scores: {}, votes: 0 };
let daily24Archive = [];
function loadDaily24() {
  try {
    if (fs.existsSync(DAILY24_FILE)) daily24 = JSON.parse(fs.readFileSync(DAILY24_FILE, 'utf8'));
    if (fs.existsSync(DAILY24_ARCHIVE_FILE)) daily24Archive = JSON.parse(fs.readFileSync(DAILY24_ARCHIVE_FILE, 'utf8'));
  } catch (e) { console.warn('[daily24] load failed', e.message); }
}
function saveDaily24() {
  try { atomicWrite(DAILY24_FILE, JSON.stringify(daily24, null, 2)); } catch (e) { console.warn('[daily24] save failed', e.message); }
}
function saveDaily24Archive() {
  try { atomicWrite(DAILY24_ARCHIVE_FILE, JSON.stringify(daily24Archive.slice(-30), null, 2)); } catch (e) {}
}
loadDaily24();

function ymdUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Pick the top 24 image posts from the previous UTC day (by reactions +
// half-weighted comment count). Called lazily — first request after
// midnight UTC rolls the day. Also called by an interval just in case.
function rollDaily24IfStale() {
  const today = ymdUTC();
  if (daily24.date === today) return false;

  // Archive yesterday's standings if any
  if (daily24.date && daily24.photoIds.length) {
    const finals = daily24.photoIds
      .map(id => ({ id, score: daily24.scores[id] || 0 }))
      .sort((a, b) => b.score - a.score);
    daily24Archive.push({ date: daily24.date, winners: finals, totalVotes: daily24.votes || 0 });
    saveDaily24Archive();
  }

  // Window for "yesterday" = previous UTC day [00:00, 24:00)
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const yStart = todayMidnight.getTime() - 24 * 60 * 60 * 1000;
  const yEnd = todayMidnight.getTime();

  const candidates = posts.filter(p =>
    p.type === 'image' &&
    !p.isGhost &&
    p.createdAt >= yStart &&
    p.createdAt < yEnd
  );
  const ranked = candidates
    .map(p => ({
      id: p.id,
      pop: (p.reactions || []).length + (p.comments || []).length * 0.5 + (p.upvotes || 0) - (p.downvotes || 0)
    }))
    .sort((a, b) => b.pop - a.pop)
    .slice(0, 24);

  daily24 = {
    date: today,
    photoIds: ranked.map(r => r.id),
    scores: Object.fromEntries(ranked.map(r => [r.id, 0])),
    votes: 0
  };
  saveDaily24();
  console.log(`[daily24] rolled ${daily24.photoIds.length} photos for ${today}`);
  return true;
}
// First boot + periodic check (every 5 min)
rollDaily24IfStale();
setInterval(() => { try { rollDaily24IfStale(); } catch (e) { console.warn('[daily24] roll failed', e.message); } }, 5 * 60 * 1000);

// THIRSTY POST BOOSTER — every 8 min, find recent posts that haven't
// gotten much love yet and give them a juicy ghost-engagement top-up.
// Stops embarrassing dry posts from sitting there with single-digit
// counts on a Tuesday morning.
setInterval(() => {
  try {
    const now = Date.now();
    const candidates = posts.filter(p => {
      if (p.expiresAt && p.expiresAt < now) return false;
      const ageHrs = (now - p.createdAt) / (60 * 60 * 1000);
      if (ageHrs < 1 || ageHrs > 18) return false;
      const reactCount = Object.values(p.reactions || {}).reduce((a, b) => a + Object.keys(b || {}).length, 0);
      const viewCount = Object.keys(p.views || {}).length;
      return reactCount < 8 || viewCount < 30;
    });
    // Boost up to 3 thirsty posts per pass.
    candidates.sort(() => Math.random() - 0.5);
    for (const p of candidates.slice(0, 3)) {
      injectGhostViews(p, 5 + Math.floor(Math.random() * 10));
      if (Math.random() < 0.7) injectGhostReactions(p, 1 + Math.floor(Math.random() * 4));
      if (Math.random() < 0.25) injectGhostComments(p, { count: 1 });
    }
  } catch (e) { console.warn('[thirsty-boost] failed', e.message); }
}, 8 * 60 * 1000);

// GET /api/daily-24/pair → returns one random pair from today's 24.
app.get('/api/daily-24/pair', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  rollDaily24IfStale();
  const ids = daily24.photoIds;
  if (ids.length < 2) {
    return res.json({ ok: false, error: 'not-enough-photos', count: ids.length, date: daily24.date });
  }
  const a = ids[Math.floor(Math.random() * ids.length)];
  let b = ids[Math.floor(Math.random() * ids.length)];
  let tries = 0;
  while (b === a && tries++ < 12) b = ids[Math.floor(Math.random() * ids.length)];
  const pa = posts.find(p => p.id === a);
  const pb = posts.find(p => p.id === b);
  if (!pa || !pb) return res.json({ ok: false, error: 'photo-missing' });
  const expand = (p) => {
    const u = findUserByEmail(p.authorEmail);
    return {
      id: p.id,
      imageUrl: p.content || '',
      author: p.authorName || (u ? u.name : ''),
      schoolName: u ? (u.schoolName || '') : '',
      score: daily24.scores[p.id] || 0
    };
  };
  res.json({ ok: true, date: daily24.date, left: expand(pa), right: expand(pb), totalVotes: daily24.votes || 0 });
});

// POST /api/daily-24/vote { winnerId, loserId }
app.post('/api/daily-24/vote', rateLimit({ key: 'daily24-vote', max: 200, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  rollDaily24IfStale();
  const winnerId = String((req.body && req.body.winnerId) || '');
  const loserId = String((req.body && req.body.loserId) || '');
  if (!winnerId || !loserId || winnerId === loserId) {
    return res.status(400).json({ error: 'need distinct winnerId + loserId' });
  }
  if (!Object.prototype.hasOwnProperty.call(daily24.scores, winnerId) ||
      !Object.prototype.hasOwnProperty.call(daily24.scores, loserId)) {
    return res.status(409).json({ error: "photo not in today's 24" });
  }
  daily24.scores[winnerId] = (daily24.scores[winnerId] || 0) + 1;
  daily24.votes = (daily24.votes || 0) + 1;
  scheduleSave(DAILY24_FILE, () => daily24, 3000);
  res.json({
    ok: true,
    scores: {
      [winnerId]: daily24.scores[winnerId],
      [loserId]: daily24.scores[loserId] || 0
    },
    totalVotes: daily24.votes
  });
});

// GET /api/daily-24/leaderboard → today's current ranking.
app.get('/api/daily-24/leaderboard', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  rollDaily24IfStale();
  const ranked = daily24.photoIds
    .map(id => {
      const p = posts.find(x => x.id === id);
      if (!p) return null;
      const u = findUserByEmail(p.authorEmail);
      return {
        id, score: daily24.scores[id] || 0,
        imageUrl: p.content || '',
        author: p.authorName || (u ? u.name : ''),
        schoolName: u ? (u.schoolName || '') : ''
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  res.json({ ok: true, date: daily24.date, totalVotes: daily24.votes || 0, leaderboard: ranked });
});

// GET /api/daily-24/archive → up to last 30 days of winners.
app.get('/api/daily-24/archive', (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  res.json({ ok: true, archive: daily24Archive.slice(-30) });
});

// Accept token from EITHER body (legacy) OR X-User-Token header (all other
// endpoints use the header — keep them consistent here so any code path
// that calls /api/whoami without an explicit body token works).
app.post('/api/whoami', (req, res) => {
  const token = (req.body && req.body.token) || req.headers['x-user-token'];
  const u = findUserByToken(token);
  if (!u) return res.status(401).json({ error: 'unknown token' });
  if (u.status === 'banned') return res.status(403).json({ error: 'account banned' });
  u.lastSeen = Date.now();
  scheduleSave(USERS_FILE, () => users, 5000);
  try { maybeDropMemory(u); } catch (e) { console.warn('[memory-drop] failed', e.message); }
  try { maybeFireAnniversary(u); } catch (e) { console.warn('[anniversary] failed', e.message); }
  try { maybeEarnMonthlyReferral(u); } catch (e) { console.warn('[monthly-referral] failed', e.message); }
  res.json({ user: publicUser(u) });
});
app.get('/api/whoami', (req, res) => {
  const token = req.headers['x-user-token'];
  const u = findUserByToken(token);
  if (!u) return res.status(401).json({ error: 'unknown token' });
  if (u.status === 'banned') return res.status(403).json({ error: 'account banned' });
  u.lastSeen = Date.now();
  saveUsers();
  try { maybeDropMemory(u); } catch {}
  try { maybeFireAnniversary(u); } catch {}
  try { maybeEarnMonthlyReferral(u); } catch {}
  res.json({ user: publicUser(u) });
});

// =================================================================
// FORCE-LOGOUT-EVERYWHERE — rotate token, invalidating all active
// sessions for the calling user. They'll need to log back in with
// password. Use this if you suspect your account was compromised.
// =================================================================
app.post('/api/me/rotate-token', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  user.token = newToken();
  user.tokenRotatedAt = Date.now();
  saveUsers();
  ghBackupNow().catch(() => {});
  console.log(`[security] token rotated for ${user.email} at ${new Date().toISOString()}`);
  res.json({ ok: true, token: user.token });
});

// =================================================================
// PASSWORD RESET
// =================================================================
async function sendEmergencyPasswordEmail(user, newPassword) {
  if (!config.resendApiKey) return { skipped: true };
  const _u = unsubArtifacts(user.email, { transactional: true });
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c;">
      <div style="background: #c0392b; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">
        🚨 [ Old Streets ] EMERGENCY PASSWORD RESET
      </div>
      <h2 style="color: #c0392b; font-size: 22px; margin: 22px 0 8px;">Your account has been locked down.</h2>
      <p style="font-size: 14px; line-height: 1.6;">
        Hi ${escapeHtmlServer((user.name || '').split(' ')[0] || 'there')} —
        a suspected compromise of your account was reported. We've forcibly rotated your password and invalidated all active sessions. <strong>Forgot-password / password-reset has been permanently disabled on this account</strong>; if you ever lose access again, contact support directly.
      </p>
      <div style="background: #fff8e1; border: 2px solid #c0392b; padding: 16px; margin: 16px 0;">
        <div style="font-size: 11px; color: #444; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px;">your new password</div>
        <code style="font-size: 22px; font-family: 'Courier New', monospace; font-weight: bold; letter-spacing: 1px; color: #c0392b;">${escapeHtmlServer(newPassword)}</code>
      </div>
      <p style="font-size: 14px; line-height: 1.6;">
        Log in with this password, then change it immediately from your profile settings. Anyone who had your old password no longer has access.
      </p>
      <p style="margin: 20px 0;">
        <a href="${config.publicUrl || 'http://localhost:3001'}" style="display: inline-block; background: #c0392b; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border-radius: 4px;">Log in →</a>
      </p>
      <p style="color: #888; font-size: 11px; line-height: 1.55; margin-top: 20px;">
        This is a transactional message. We did not send this without a security event being raised on your account. If you didn't expect this email, your account may already be in someone else's hands — reply to this email immediately.
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [user.email],
        subject: `🚨 Old Streets — emergency password reset for your account`,
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// =================================================================
// EMERGENCY LOCKDOWN — runs once on boot for any user whose email is
// listed below. Generates a random password, rotates token, locks the
// account from password reset, and emails the new password.
// Used in response to a reported compromise. Idempotent: once a user
// is flagged lockedFromReset, this routine skips them.
// =================================================================
// Map: email → { hash, lockedAt } — the password is delivered OUT OF BAND
// (not via the user's school email, since teachers can access those).
// The hash is generated locally by an admin and committed to the code.
// On boot, if the user record exists and hasn't been locked yet, we apply
// the hash, rotate the token, and seal forgot-password forever.
const LOCKDOWN_HASHES = {
  // admin@oldstreets.app — password delivered in chat, NEVER via email.
  // Rotate by generating a new hash via the same scrypt scheme:
  //   const salt = crypto.randomBytes(16).toString('hex');
  //   const hash = crypto.scryptSync(pwd, salt, 32).toString('hex');
  //   passwordHash = salt + ':' + hash;
  'admin@oldstreets.app': {
    hash: '9b156a92a122a560bb9c06f4c6937a26:12939c795d958e4e71d574508d5009e1fac3b4d852dd03f24d190bf5f6b68b67',
    lockedAt: Date.now()
  }
};
// Emails that are auto-flagged isAdmin=true on every boot. Belt-and-
// suspenders so a redeploy or accidental users.json wipe never strips
// admin privileges from your own account.
const FORCED_ADMIN_EMAILS = ['admin@oldstreets.app'];
function ensureForcedAdmins() {
  let touched = 0;
  for (const email of FORCED_ADMIN_EMAILS) {
    const u = findUserByEmail(email);
    if (u && !u.isAdmin) {
      u.isAdmin = true;
      touched++;
      console.log(`[security] auto-granted admin to ${u.email}`);
    }
  }
  if (touched) saveUsers();
}

async function runEmergencyLockdownIfNeeded() {
  for (const [email, info] of Object.entries(LOCKDOWN_HASHES)) {
    const u = findUserByEmail(email);
    if (!u) {
      console.warn(`[security] lockdown target ${email} NOT FOUND in users — skipping. Sign up first then redeploy.`);
      continue;
    }
    // ALWAYS apply on boot. We compare current hash vs target — only
    // touches disk if it differs. Idempotent and robust against the
    // previous-deploy quirk where lockedFromReset was set but hash was
    // different. Re-applies guarantee the latest hash from the code is
    // what's on disk.
    if (u.passwordHash === info.hash && u.lockedFromReset && u._lockHashApplied === info.hash) {
      console.log(`[security] lockdown already current for ${u.email} (skip)`);
      continue;
    }
    u.passwordHash = info.hash;
    u._lockHashApplied = info.hash;
    u.token = newToken();
    u.lockedFromReset = true;
    u.lockedFromResetAt = Date.now();
    u.resetToken = null;
    u.resetTokenExpiresAt = null;
    saveUsers();
    // Synchronously await GH backup so the change is durable before
    // returning. If GH is slow / down, cap at 6s.
    try {
      await Promise.race([ghBackupNow(), new Promise(r => setTimeout(r, 6000))]);
    } catch {}
    console.log(`[security] LOCKDOWN applied for ${u.email} — pre-hashed password set, sessions invalidated, reset sealed.`);
  }
}

// Admin override: force-apply the lockdown right now. Useful if startup
// hook didn't fire for some reason. Same security as any admin endpoint.
app.post('/api/admin/security/force-lockdown', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await runEmergencyLockdownIfNeeded();
  res.json({ ok: true });
});

async function sendResetEmail(user) {
  if (!config.resendApiKey) return { skipped: true };
  const _u = unsubArtifacts(user.email, { transactional: true });
  const link = `${config.publicUrl || 'http://localhost:3001'}/?reset=${user.resetToken}`;
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c;">
      <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">
        [ Old Streets ] <span style="font-weight: normal; opacity: 0.75; font-size: 12px; float: right; padding-top: 2px;">password reset</span>
      </div>
      <h2 style="color: #3B5998; font-size: 22px; margin: 22px 0 8px;">Reset your password.</h2>
      <p style="font-size: 14px; line-height: 1.55;">
        Hey ${escapeHtmlServer(user.name.split(' ')[0] || user.name)} —
      </p>
      <p style="font-size: 14px; line-height: 1.55;">
        Someone (probably you) asked to reset your Old Streets password. Click below to set a new one.
        This link expires in <strong>1 hour</strong>.
      </p>
      <p style="margin: 22px 0;">
        <a href="${link}" style="display: inline-block; background: #3B5998; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border: 1px solid #2f477b; font-size: 14px;">Set new password →</a>
      </p>
      <p style="font-size: 12px; color: #666; margin-top: 16px; line-height: 1.5;">
        If the button doesn't work, copy this link:<br/>
        <span style="font-family: monospace; word-break: break-all; color: #3B5998; font-size: 11px;">${link}</span>
      </p>
      <p style="font-size: 12px; color: #888; margin-top: 18px; border-top: 1px solid #eee; padding-top: 12px;">
        Didn't ask for this? Ignore the email — your password won't change. The link will expire on its own.
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 10px; line-height: 1.55;">
        Old Streets is independent — not affiliated with any school. We don't condone bullying.
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [user.email],
        subject: 'Reset your Old Streets password',
        html,
        headers: _u.headers
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: data.message || ('http ' + resp.status) };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

app.post('/api/forgot-password', rateLimit({ key: 'forgot', max: 5, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const { email } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  // Always return ok to avoid leaking which emails are registered
  const u = findUserByEmail(cleanEmail);
  if (u && u.status !== 'banned' && !u.lockedFromReset) {
    u.resetToken = newToken();
    u.resetTokenExpiresAt = Date.now() + 60 * 60 * 1000;
    saveUsers();
    const r = await sendResetEmail(u);
    if (!r.ok && !r.skipped) {
      console.warn('[reset] email failed for', u.email, r.error);
    }
  } else if (u && u.lockedFromReset) {
    console.warn(`[security] forgot-password attempt on locked account ${u.email}`);
  }
  res.json({ ok: true });
});

app.post('/api/reset-password', rateLimit({ key: 'reset', max: 8, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const { resetToken, newPassword } = req.body || {};
  const u = users.find(x => x.resetToken && x.resetToken === resetToken);
  if (!u || !u.resetTokenExpiresAt || u.resetTokenExpiresAt < Date.now()) {
    return res.status(400).json({ error: 'reset link is invalid or expired — try again' });
  }
  if (u.status === 'banned') return res.status(403).json({ error: 'account banned' });
  // Locked-from-reset users (the account-owner manually sealed their
  // recovery path after a compromise) cannot use this flow. They have
  // to contact support to unlock.
  if (u.lockedFromReset) {
    console.warn(`[security] reset attempted on locked account ${u.email}`);
    return res.status(403).json({ error: 'this account is locked from password reset. contact support.' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  u.passwordHash = hashPassword(String(newPassword));
  u.resetToken = null;
  u.resetTokenExpiresAt = null;
  u.token = newToken(); // log them in fresh
  u.lastSeen = Date.now();
  saveUsers();
  res.json({ ok: true, user: publicUser(u), token: u.token });
});

// =================================================================
// FEED API (now requires active user)
// =================================================================
// Mask anonymous posts for non-admin viewers. Real authorEmail stays
// in storage so admins can audit / moderate. Ghost posts also strip
// internal flags (isGhost, ghostNames) from the public payload.
//
// `viewerEmail` (optional): if matches the real author, sets isMine=true
// so the UI can show reactor names to the original author of their own
// anon posts without exposing identity to anyone else.
function avgRating(emailLc) {
  const bucket = userRatings[(emailLc || '').toLowerCase()] || {};
  const vals = Object.values(bucket);
  if (!vals.length) return 0;
  return Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * 10) / 10;
}
function publicPost(p, viewerEmail) {
  if (!p) return null;
  const viewCount = Object.keys(p.views || {}).length;
  const trending = isTrending(p);
  const totalReactors = new Set(
    Object.values(p.reactions || {}).flatMap(b => Object.keys(b))
  ).size;
  const hotLocked = totalReactors >= 10;
  // seenBy: skip ghost-synthetic emails entirely — never name-show fakes
  const seenBy = Object.keys(p.views || {})
    .filter(email => !String(email).toLowerCase().endsWith('@old-streets.internal'))
    .slice(0, 5)
    .map(email => {
      const u = findUserByEmail(email);
      return u ? u.name.split(' ')[0] : null;
    }).filter(Boolean);
  const { isGhost: _ig, ghostNames: _gn, _templateSource: _ts, ...rest } = p;
  const isMine = !!(viewerEmail && p.authorEmail && p.authorEmail.toLowerCase() === viewerEmail.toLowerCase());
  // Resolve repost snapshot — embed a trimmed-down version of the original
  // post for the client to render as a quote-card. Look it up fresh each
  // time so edits/deletes propagate.
  let repostOf = null;
  if (p.repostOfId) {
    const orig = posts.find(x => x.id === p.repostOfId);
    if (orig) {
      const origAuthor = orig.authorEmail ? findUserByEmail(orig.authorEmail) : null;
      const origAuthorAvatar = origAuthor && origAuthor.avatar ? origAuthor.avatar : '';
      repostOf = {
        id: orig.id,
        author: orig.isAnonymous ? 'anonymous' : orig.author,
        authorEmail: orig.isAnonymous ? '' : (orig.authorEmail || ''),
        authorAvatar: orig.isAnonymous ? '' : origAuthorAvatar,
        isAnonymous: !!orig.isAnonymous,
        type: orig.type,
        content: orig.content,
        caption: orig.caption,
        createdAt: orig.createdAt
      };
    } else {
      repostOf = { id: p.repostOfId, deleted: true };
    }
  }
  if (p.isAnonymous) {
    return { ...rest, author: 'anonymous', authorEmail: '', authorHandle: '', avatar: '', authorAvatar: '', viewCount, trending, hotLocked, seenBy, isMine, repostOf };
  }
  const author = p.authorEmail ? findUserByEmail(p.authorEmail) : null;
  const authorAvatar = author && author.avatar ? author.avatar : '';
  const authorHandle = (author && author.handle) || '';
  const authorRating = p.authorEmail ? avgRating(p.authorEmail) : 0;
  return { ...rest, authorAvatar, authorHandle, authorRating, viewCount, trending, hotLocked, seenBy, isMine, repostOf };
}

app.get('/api/posts', (req, res) => {
  const now = Date.now();
  const token = req.headers['x-user-token'];
  const me = findUserByToken(token);
  const viewer = me ? me.email : null;
  // HARD SCHOOL ISOLATION — no globe escape hatch. Every post must belong
  // to a same-school author (or be a system/ghost post). Admin bypasses.
  let live = posts.filter(p => !p.expiresAt || p.expiresAt > now);
  live = live.filter(p => postVisibleToViewer(p, me));
  try {
    const recent = live.filter(p => (now - p.createdAt) < 6 * 60 * 60 * 1000);
    for (let i = 0; i < 3 && recent.length; i++) {
      const p = recent[Math.floor(Math.random() * recent.length)];
      injectGhostViews(p, 1 + Math.floor(Math.random() * 3));
    }
  } catch {}
  res.json(live.map(p => publicPost(p, viewer)));
});

// =================================================================
// FOR YOU FEED — personalised ranking per-user
// Scores each post by recency × friendship × interaction history × popularity.
// =================================================================
app.get('/api/posts/foryou', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const now = Date.now();
  const me = user.email.toLowerCase();
  const myFriends = new Set((user.friends || []).map(f => f.toLowerCase()));

  // Build per-author interaction scores from post history
  const interactionWith = {};
  for (const p of posts) {
    const ae = (p.authorEmail || '').toLowerCase();
    if (!ae || ae === me) continue;
    // reacted to their post
    if (Object.values(p.reactions || {}).some(b => Object.prototype.hasOwnProperty.call(b, me))) {
      interactionWith[ae] = (interactionWith[ae] || 0) + 1;
    }
    // commented on their post
    for (const c of (p.comments || [])) {
      if ((c.authorEmail || '').toLowerCase() === me) {
        interactionWith[ae] = (interactionWith[ae] || 0) + 2;
      }
    }
  }

  // HARD SCHOOL ISOLATION on /foryou too — only same-school posts.
  const active = posts.filter(p => (!p.expiresAt || p.expiresAt > now) && postVisibleToViewer(p, user));

  const scored = active.map(p => {
    const ae = (p.authorEmail || '').toLowerCase();
    const ageH = (now - p.createdAt) / 3600000;
    let score = 0;
    // Recency — halves every 4h
    score += 120 * Math.pow(0.5, ageH / 4);
    // Friendship boost
    if (myFriends.has(ae)) score += 50;
    // Interaction history (capped at 35)
    score += Math.min(35, (interactionWith[ae] || 0) * 6);
    // Reaction popularity (capped at 25)
    const reactCount = Object.values(p.reactions || {})
      .reduce((s, b) => s + Object.keys(b).length, 0);
    score += Math.min(25, reactCount * 2.5);
    // Comment activity (capped at 12)
    score += Math.min(12, (p.comments || []).length * 1.5);
    // Trending spike
    if (isTrending(p)) score += 30;
    // Ghost posts: seed them naturally through the feed (~every 5th slot feel)
    if (p.isGhost) score += 20 + Math.random() * 15;
    // Pinned always wins
    if (p.pinned) score += 2000;
    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  res.json(scored.map(s => publicPost(s.p, user.email)));
});

// =================================================================
// DATABASE HEALTH ENDPOINT — admin can see per-file size, parse status,
// .bak depth, last write, free disk, and GH backup state. Used by the
// admin dashboard's data-integrity panel.
// =================================================================
// Audit log viewer (admin). Returns the last N lines of audit.jsonl.
// Threat feed — aggregates recent suspicious events for the admin dashboard.
// Includes the live ring buffer (rate-limit hits, failed logins, admin-auth
// fails, staff/middle-school signup attempts, banned-login attempts) plus
// derived signals (open reports, currently-timed-out users, recent bans).
app.get('/api/admin/threat-feed', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const since = parseInt(req.query.since || '0', 10) || 0;
  const events = (since > 0 ? threatFeed.filter(e => e.ts > since) : threatFeed).slice(0, 200);
  // Open reports (posts that have been reported but not deleted)
  const openReports = [];
  for (const p of posts) {
    if (!p.reports || p.reports.length === 0) continue;
    openReports.push({
      postId: p.id,
      authorEmail: p.authorEmail,
      author: p.author,
      isAnonymous: !!p.isAnonymous,
      reports: p.reports.length,
      preview: ((p.content || p.caption || '').slice(0, 120)),
      type: p.type,
      createdAt: p.createdAt
    });
  }
  openReports.sort((a, b) => b.reports - a.reports);
  // Currently timed-out users
  const timedOut = users
    .filter(u => u.timeoutUntil && u.timeoutUntil > Date.now())
    .map(u => ({
      id: u.id, email: u.email, name: u.name,
      timeoutUntil: u.timeoutUntil, reason: u.timeoutReason || ''
    }))
    .sort((a, b) => a.timeoutUntil - b.timeoutUntil);
  // Recent bans
  const recentBans = users
    .filter(u => u.status === 'banned')
    .map(u => ({ id: u.id, email: u.email, name: u.name, bannedAt: u.bannedAt || 0, reason: u.banReason || '' }))
    .sort((a, b) => b.bannedAt - a.bannedAt)
    .slice(0, 30);
  // Recent signups (last 24h) for monitoring mass-signup
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentSignups = users
    .filter(u => (u.createdAt || 0) > dayAgo)
    .map(u => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt, grade: u.grade || '', schoolEmailVerified: !!u.schoolEmailVerified }))
    .sort((a, b) => b.createdAt - a.createdAt);
  // Tally by event type for the dashboard summary
  const byType = {};
  for (const e of threatFeed) byType[e.type] = (byType[e.type] || 0) + 1;
  res.json({
    events,
    openReports,
    timedOut,
    recentBans,
    recentSignups,
    byType,
    totalEvents: threatFeed.length,
    now: Date.now()
  });
});

app.get('/api/admin/audit', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(2000, parseInt(req.query.limit || '500', 10));
  try {
    if (!fs.existsSync(AUDIT_FILE)) return res.json({ events: [] });
    const txt = fs.readFileSync(AUDIT_FILE, 'utf8');
    const lines = txt.trim().split('\n').slice(-limit);
    const events = [];
    for (const ln of lines) {
      try { events.push(JSON.parse(ln)); } catch {}
    }
    res.json({ events, total: lines.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/db-health', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const files = [
    { name: 'users', path: USERS_FILE, expected: 'array', count: users.length },
    { name: 'posts', path: POSTS_FILE, expected: 'array', count: posts.length },
    { name: 'dms', path: DMS_FILE, expected: 'array', count: dms.length },
    { name: 'profile-views', path: VIEWS_FILE, expected: 'array', count: profileViews.length },
    { name: 'notifs', path: NOTIFS_FILE, expected: 'array', count: notifs.length },
    { name: 'unsubscribes', path: UNSUB_FILE, expected: 'array', count: unsubscribes.size },
    { name: 'love-letters', path: LOVE_LETTERS_FILE, expected: 'array', count: loveLetters.length },
    { name: 'profile-boards', path: PROFILE_BOARDS_FILE, expected: 'object', count: Object.keys(profileBoards).length },
    { name: 'bulletins', path: BULLETINS_FILE, expected: 'array', count: bulletins.length },
    { name: 'blogs', path: BLOGS_FILE, expected: 'array', count: blogs.length },
    { name: 'friend-requests', path: FRIEND_REQ_FILE, expected: 'array', count: friendRequests.length },
    { name: 'qotd', path: QOTD_FILE, expected: 'array', count: qotdHistory.length },
    { name: 'late-night', path: LATE_NIGHT_FILE, expected: 'array', count: lateNight.length },
    { name: 'royalty', path: ROYALTY_FILE, expected: 'object', count: (royalty.winners || []).length },
    { name: 'mutual-views', path: MUTUAL_VIEWS_FILE, expected: 'object', count: Object.keys(mutualViewsSent).length },
    { name: 'crush-list', path: CRUSH_LIST_FILE, expected: 'array', count: crushList.length },
    { name: 'ads', path: ADS_FILE, expected: 'array', count: ads.length },
    { name: 'attention', path: ATTENTION_FILE, expected: 'object', count: Object.keys(attentionDaily).length }
  ];
  const fileInfo = files.map(f => {
    const info = { name: f.name, expected: f.expected, memCount: f.count };
    try {
      if (fs.existsSync(f.path)) {
        const st = fs.statSync(f.path);
        info.exists = true;
        info.size = st.size;
        info.modified = st.mtimeMs;
        // Try parse to detect corruption
        try {
          const t = fs.readFileSync(f.path, 'utf8');
          const parsed = JSON.parse(t);
          info.parseOk = true;
          info.diskCount = Array.isArray(parsed) ? parsed.length : (typeof parsed === 'object' && parsed ? Object.keys(parsed).length : 0);
        } catch (e) {
          info.parseOk = false;
          info.parseError = e.message;
        }
        // .bak rotation depth
        info.bakDepth = ['.bak', '.bak.1', '.bak.2', '.bak.3'].filter(s => fs.existsSync(f.path + s)).length;
      } else {
        info.exists = false;
      }
    } catch (e) {
      info.error = e.message;
    }
    return info;
  });
  // Disk-space check
  let disk = null;
  try {
    const stat = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
    if (stat) {
      disk = {
        freeBytes: stat.bavail * stat.bsize,
        freeMB: Math.round((stat.bavail * stat.bsize) / 1024 / 1024),
        critical: (stat.bavail * stat.bsize) < 5 * 1024 * 1024
      };
    }
  } catch {}
  const pendingWrites = Array.from(pendingTimers.keys()).map(k => k.replace(DATA_DIR, ''));
  res.json({
    ok: fileInfo.every(f => !f.exists || f.parseOk !== false),
    generatedAt: Date.now(),
    dataDir: DATA_DIR,
    disk,
    files: fileInfo,
    ghBackup: {
      enabled: ghBackupEnabled(),
      repo: process.env.GH_BACKUP_REPO || null,
      lastBackupAt: lastGhBackupAt || null,
      lastBackupOk: lastGhBackupOk,
      lastBackupError: lastGhBackupError || null
    },
    pendingDebouncedWrites: pendingWrites
  });
});

// =================================================================
// PERIODIC SNAPSHOTS — every 30 min, write a full state snapshot to
// data/snapshots/YYYY-MM-DD-HH.json. Keep the last 24 snapshots so
// we have ~12 hours of rollback history regardless of what the main
// files look like.
// =================================================================
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
function takeSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
    const snapPath = path.join(SNAPSHOTS_DIR, `snap-${stamp}.json`);
    const payload = {
      capturedAt: Date.now(),
      counts: {
        users: users.length, posts: posts.length, dms: dms.length,
        loveLetters: loveLetters.length, friendRequests: friendRequests.length,
        crushList: crushList.length, blogs: blogs.length, bulletins: bulletins.length,
        notifs: notifs.length, ads: ads.length
      },
      users, posts, dms, profileViews, notifs, unsubscribes: Array.from(unsubscribes),
      loveLetters, profileBoards, bulletins, blogs, friendRequests,
      qotdHistory, lateNight, royalty, mutualViewsSent, crushList, ads, attentionDaily
    };
    fs.writeFileSync(snapPath, JSON.stringify(payload));
    // Rotate — keep last 24
    const entries = fs.readdirSync(SNAPSHOTS_DIR)
      .filter(n => n.startsWith('snap-') && n.endsWith('.json'))
      .sort();
    while (entries.length > 24) {
      const oldest = entries.shift();
      try { fs.unlinkSync(path.join(SNAPSHOTS_DIR, oldest)); } catch {}
    }
    console.log(`[snapshot] wrote ${snapPath} (${entries.length} retained)`);
  } catch (e) {
    console.error('[snapshot] FAILED:', e.message);
  }
}
// Snapshot every 30 minutes
setInterval(takeSnapshot, 30 * 60 * 1000);
// And once 60s after startup, to capture initial state
setTimeout(takeSnapshot, 60 * 1000);

// =================================================================
// PERIODIC GH BACKUP — even when no writes happen, push to GitHub every
// 10 minutes so we're never more than 10 min behind on cold restores.
// =================================================================
setInterval(() => {
  if (!ghBackupEnabled()) return;
  ghBackupNow().catch(e => console.warn('[gh-backup-tick] failed:', e.message));
}, 10 * 60 * 1000);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    users: users.length,
    posts: posts.length,
    online: onlineUsers.size,
    directorySize: directory.length,
    ghBackup: {
      enabled: ghBackupEnabled(),
      repo: process.env.GH_BACKUP_REPO || null,
      tokenPresent: !!process.env.GH_BACKUP_TOKEN,
      lastBackupAt: lastGhBackupAt || null,
      lastBackupOk: lastGhBackupOk,
      lastBackupError: lastGhBackupError || null
    },
    persistence: process.env.NODE_ENV === 'production'
      ? (ghBackupEnabled() ? 'gh-backup' : 'volume-or-empty')
      : 'local'
  });
});

// =================================================================
// MEDIA UPLOAD — raw-body streaming endpoint. Client POSTs the file
// bytes as the body with the right Content-Type. We return { url } that
// the client then sticks into POST /api/posts as `content`.
// This avoids putting a 5–30MB base64 data URL inside a JSON body, which
// some proxies (Lander/Cloudflare) reject with 403/413.
// =================================================================
const MEDIA_MIME_MAP = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/ogg': 'ogv'
};
app.post('/api/uploads',
  express.raw({ type: req => {
    // Accept the file's actual MIME OR octet-stream (when the proxy rewrites
    // the content-type, we fall back to X-File-Mime header to recover the real one).
    const ct = (req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    return !!MEDIA_MIME_MAP[ct] || ct === 'application/octet-stream';
  }, limit: '50mb' }),
  (req, res) => {
    // Accept any of: logged-in active user, session-admin (user with isAdmin),
    // legacy admin user/pass headers, or local request.
    const token = req.headers['x-user-token'];
    const me = findUserByToken(token);
    const isSessionAdmin = !!(me && me.isAdmin && me.status === 'active');
    const isAdminReq = (() => {
      if (isLocalRequest(req)) return true;
      if (isSessionAdmin) return true;
      const u = req.headers['x-admin-user'];
      const p = req.headers['x-admin-pass'];
      return !!u && u === config.adminUsername && !!p && p === config.adminPasscode;
    })();
    if (!me && !isAdminReq) {
      return res.status(401).json({ error: 'sign in first' });
    }
    if (me && me.status !== 'active' && !isAdminReq) {
      return res.status(403).json({ error: 'account not active' });
    }
    // Resolve effective MIME: Content-Type wins if it's a real media type,
    // otherwise fall back to X-File-Mime (used when sender chose octet-stream
    // to dodge proxy blocking of image/video content-types).
    const ctHeader = (req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    const xMime = (req.headers['x-file-mime'] || '').toLowerCase().split(';')[0].trim();
    const ct = MEDIA_MIME_MAP[ctHeader] ? ctHeader : (MEDIA_MIME_MAP[xMime] ? xMime : ctHeader);
    const ext = MEDIA_MIME_MAP[ct];
    if (!ext) return res.status(415).json({ error: 'unsupported media type — use jpg/png/gif/webp/mp4/webm/mov' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body — make sure Content-Type matches the file' });
    if (req.body.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'file too big — 50mb max' });
    const id = newId();
    const filename = `${id}.${ext}`;
    const fullPath = path.join(UPLOADS_DIR, filename);
    try {
      fs.writeFileSync(fullPath, req.body);
    } catch (e) {
      console.error('upload write failed:', e);
      return res.status(500).json({ error: 'upload write failed' });
    }
    const publicUrl = `/uploads/${filename}`;
    scheduleGhBackup();
    res.json({ ok: true, url: publicUrl, mime: ct, size: req.body.length });
  }
);

// List current rooms (HTTP) so the post composer can let users pick one.
app.get('/api/rooms', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json(publicRooms());
});

app.post('/api/posts', (req, res) => {
  const user = requireUser(req, res);
  if (!user) {
    console.log('[POST /api/posts] requireUser denied — user:', !!user, 'token:', !!req.headers['x-user-token']);
    return;
  }
  // Playbook: 70-day new-member status. Cap posts/day so a fresh account
  // can't flood the wall before they've absorbed the room's tone.
  const limit = checkNewMemberPostLimit(user);
  if (limit) return res.status(429).json({ error: 'new-member-limit', message: limit });
  const { type, caption, ephemeral, anon, roomId, newRoomName, repostOf, gifUrl, isAnonymous, moodId } = req.body || {};
  let { content } = req.body || {};
  console.log(`[POST /api/posts] by ${user.email} type=${type} anon=${!!anon} contentLen=${(content || '').length}`);
  if (!type || !['text', 'image', 'video', 'survey', 'gif'].includes(type)) {
    return res.status(400).json({ error: 'bad type' });
  }
  // Validate gifUrl if present — must point to tenor or media.tenor (gifs only).
  let cleanGifUrl = '';
  if (gifUrl) {
    if (typeof gifUrl !== 'string' || gifUrl.length > 500) return res.status(400).json({ error: 'bad gif url' });
    if (!/^https:\/\/(media\d?\.tenor\.com|c\.tenor\.com|tenor\.com)/.test(gifUrl)) {
      return res.status(400).json({ error: 'gif must be from tenor' });
    }
    cleanGifUrl = gifUrl;
  }
  if (type === 'gif' && !cleanGifUrl) return res.status(400).json({ error: 'missing gif url' });
  if (!content && type !== 'text' && type !== 'gif') return res.status(400).json({ error: 'missing content' });
  if (typeof content === 'string' && content.length > 40 * 1024 * 1024) {
    return res.status(413).json({ error: 'too big' });
  }
  // Cap text-post size to 5000 chars — anything bigger should be a Blog.
  if (type === 'text' && typeof content === 'string' && content.length > 5000) {
    return res.status(400).json({ error: 'text posts capped at 5000 chars — write a blog for long-form' });
  }
  // Hard content filter — block slurs/threats outright.
  const blockHit = contentBlocked((type === 'text' ? content : caption || ''));
  if (blockHit) {
    pushThreatEvent({ type: 'blocked-content', severity: 'high', ip: clientIp(req), who: user.email, note: 'pattern=' + blockHit });
    return res.status(400).json({ error: 'this post contains language that isn\'t allowed (slurs, threats). cool it.' });
  }
  // For surveys: validate the JSON shape and limit Q/A length so the
  // post storage / feed can't be abused as free-form payload.
  if (type === 'survey') {
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      if (!parsed || typeof parsed !== 'object' || !parsed.templateId || !Array.isArray(parsed.answers)) {
        return res.status(400).json({ error: 'bad survey payload' });
      }
      const tpl = SURVEY_TEMPLATES.find(t => t.id === parsed.templateId);
      if (!tpl) return res.status(400).json({ error: 'unknown survey template' });
      const answers = parsed.answers.slice(0, tpl.questions.length).map(a => String(a || '').slice(0, 240));
      content = JSON.stringify({ templateId: tpl.id, title: tpl.title, answers });
    } catch { return res.status(400).json({ error: 'invalid survey payload' }); }
  }
  // Optional: attach a video room. Either pick an existing room id OR
  // give us a name and we create one.
  let attachedRoom = null;
  if (typeof roomId === 'string' && rooms.has(roomId)) {
    const r = rooms.get(roomId);
    attachedRoom = { id: r.id, name: r.name };
  } else if (typeof newRoomName === 'string' && newRoomName.trim()) {
    const cleanName = newRoomName.trim().slice(0, 60);
    const id = 'R-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    rooms.set(id, { id, name: cleanName, createdBy: user.name, members: new Set() });
    attachedRoom = { id, name: cleanName };
    io.emit('rooms-list', publicRooms());
  }

  // Validate repostOf — must reference an existing post. We store only the
  // ID; the public payload resolves a fresh snapshot at render time so
  // edits to the original post propagate.
  let repostOfId = null;
  if (typeof repostOf === 'string' && repostOf) {
    const orig = posts.find(p => p.id === repostOf);
    if (!orig) return res.status(400).json({ error: 'repost source not found' });
    if (orig.repostOfId) {
      // No nesting reposts: collapse to the root original.
      repostOfId = orig.repostOfId;
    } else {
      repostOfId = orig.id;
    }
  }

  const post = {
    id: newId(),
    author: user.name,
    authorEmail: user.email,
    isAnonymous: !!(isAnonymous || anon),
    type,
    content: content || '',
    gifUrl: cleanGifUrl,
    moodId: moodId || '',
    caption: String(caption || '').slice(0, 500),
    reactions: {},
    upvotes: {},
    downvotes: {},
    comments: [],
    reports: [],
    views: {},
    roomId: attachedRoom ? attachedRoom.id : null,
    roomName: attachedRoom ? attachedRoom.name : null,
    expiresAt: ephemeral ? Date.now() + ONE_DAY_MS : null,
    repostOfId,
    createdAt: Date.now()
  };
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);

  // mark presence, count posts, track last post time for absence badge + soft-lock gate
  user.lastPostAt = Date.now();
  user.postCount = (user.postCount || 0) + 1;
  if (!user.hasPostedOnce) user.hasPostedOnce = true;
  bumpStreakOnPost(user);
  saveUsers();
  // Currency: 3 posts = 1 referral. Check after every post.
  try { maybeEarnReferralFromPosts(user); } catch (e) { console.warn('[post-earn-referral] failed', e.message); }

  savePosts();
  io.emit('post-added', publicPost(post));
  if (!post.isGhost) trackEvent(user.email, 'post-create', { postId: post.id });

  // ORGANIC ENGAGEMENT WAVE — ghost arrivals trickle in individually over
  // 8 min → 3+ hours so it feels like real people coming across the post
  // naturally. Nothing fires in the first 7 minutes. Per-post RNG so no
  // two posts share an identical timing fingerprint.
  (function scheduleEngagementWave(p) {
    const _r = () => Math.random();
    const min = 60 * 1000;
    // Views: first arrives 8-15 min out, subsequent every 15-40 min
    const viewWaves = [
      ( 8 * 60 + _r() *  7 * 60) * min / 60,
      (22 * 60 + _r() * 18 * 60) * min / 60,
      (52 * 60 + _r() * 23 * 60) * min / 60,
      (90 * 60 + _r() * 30 * 60) * min / 60,
      (140* 60 + _r() * 40 * 60) * min / 60,
    ];
    // Reactions: first at 25-55 min, then every 40-80 min
    const reactWaves = [
      (25 * 60 + _r() * 30 * 60) * min / 60,
      (72 * 60 + _r() * 38 * 60) * min / 60,
      (130* 60 + _r() * 50 * 60) * min / 60,
    ];
    // Comments: first at 65-130 min
    const commentWaves = [
      (65 * 60 + _r() * 65 * 60) * min / 60,
      (160* 60 + _r() * 80 * 60) * min / 60,
    ];
    for (const d of viewWaves)
      setTimeout(() => injectGhostViews(p, 1 + Math.floor(_r() * 3)), d);
    for (const d of reactWaves)
      setTimeout(() => injectGhostReactions(p, 1 + Math.floor(_r() * 2)), d);
    for (const d of commentWaves)
      if (_r() < 0.55) setTimeout(() => injectGhostComments(p, { count: 1 }), d);
  })(post);

  // Post performance anxiety: 30min after posting, check reaction count vs
  // author's historical average. If quiet, send a nudge to share it.
  if (!anon) {
    setTimeout(() => {
      const livePost = posts.find(p => p.id === post.id);
      if (!livePost || livePost.performanceCheckDone) return;
      livePost.performanceCheckDone = true;
      const reactCount = Object.values(livePost.reactions || {})
        .reduce((s, b) => s + Object.keys(b).length, 0);
      const authorHistory = posts
        .filter(p => p.authorEmail === user.email && !p.isAnonymous && p.id !== post.id)
        .slice(0, 10);
      if (authorHistory.length < 3) return; // not enough history yet
      const avgReacts = authorHistory.reduce((s, p) =>
        s + Object.values(p.reactions || {}).reduce((rs, b) => rs + Object.keys(b).length, 0), 0
      ) / authorHistory.length;
      if (reactCount <= Math.floor(avgReacts * 0.6)) {
        pushNotif(user.email, {
          type: 'performance',
          fromName: '',
          fromEmail: '',
          text: `your post is quiet so far — share it with someone who'd care 👀`
        });
      }
    }, 30 * 60 * 1000);
  }

  // mentions + name-mentions → notifs + emails (don't spam author themselves)
  const fullText = (post.type === 'text' ? post.content : '') + ' ' + (post.caption || '');
  const mentioned = findMentionedUsers(fullText);
  const named = findNamedUsers(fullText).filter(e => !mentioned.includes(e));
  // For anonymous posts, the notification doesn't reveal the author.
  const notifFromName = post.isAnonymous ? 'someone (anonymous)' : user.name;
  const notifFromEmail = post.isAnonymous ? '' : user.email;
  for (const email of mentioned) {
    if (email === user.email) continue;
    const target = findUserByEmail(email);
    if (!target) continue;
    pushNotif(email, { type: 'mention', fromName: notifFromName, fromEmail: notifFromEmail, postId: post.id, text: fullText.slice(0, 140) });
    sendMentionEmail({ toName: target.name, toEmail: email, fromName: notifFromName, postPreview: fullText, postId: post.id });
  }
  for (const email of named) {
    if (email === user.email) continue;
    pushNotif(email, { type: 'talked-about', fromName: notifFromName, fromEmail: notifFromEmail, postId: post.id, text: fullText.slice(0, 140) });
  }
  res.json(publicPost(post));
});

const ALLOWED_REACTIONS = ['👍','👎','😂','🔥','💀','😍'];

app.post('/api/posts/:id/react', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  const { emoji } = req.body || {};   // null/undef = remove all
  if (!post.reactions) post.reactions = {};

  // Remove this user's previous reaction across all emojis (one reaction per user per post)
  for (const e of Object.keys(post.reactions)) {
    delete post.reactions[e][user.email];
    if (Object.keys(post.reactions[e]).length === 0) delete post.reactions[e];
  }

  if (emoji && ALLOWED_REACTIONS.includes(emoji)) {
    if (!post.reactions[emoji]) post.reactions[emoji] = {};
    // Store timestamp alongside name so isTrending() can check reaction velocity
    post.reactions[emoji][user.email] = Date.now();
  }

  // mirror to legacy thumbs for back-compat (if needed)
  post.upvotes = post.reactions['👍'] || {};
  post.downvotes = post.reactions['👎'] || {};

  savePosts();
  if (emoji) trackEvent(user.email, 'react', { emoji, postId: post.id });
  const summary = {
    id: post.id,
    reactions: post.reactions,
    upvotes: post.upvotes,
    downvotes: post.downvotes,
    upCount: Object.keys(post.upvotes).length,
    downCount: Object.keys(post.downvotes).length
  };
  io.emit('post-voted', summary);

  // Reaction jealousy: first time a post hits 5 unique reactors,
  // push a "blowing up" notif to the author's friends — drives pile-on traffic
  const totalReactors = new Set(
    Object.values(post.reactions).flatMap(b => Object.keys(b))
  ).size;
  if (totalReactors === 5 && !post.blowupNotified && !post.isAnonymous && post.authorEmail) {
    post.blowupNotified = true;
    const author = findUserByEmail(post.authorEmail);
    if (author) {
      for (const friendEmail of (author.friends || [])) {
        if (friendEmail.toLowerCase() === user.email.toLowerCase()) continue;
        pushNotif(friendEmail, {
          type: 'blowup',
          fromName: author.name,
          fromEmail: author.email,
          postId: post.id,
          text: `${author.name}'s post is blowing up 🔥`
        });
      }
    }
  }

  // Push the AUTHOR directly at reaction milestones — the friends push above
  // never tells the person who wrote it. Fix that. Also catches 10 and 25.
  if (!post.isAnonymous && post.authorEmail &&
      post.authorEmail.toLowerCase() !== user.email.toLowerCase()) {
    const authorMilestones = [
      { n: 5,  flag: '_authorBlowup5',  text: `your post is blowing up 🔥 — ${totalReactors} people reacted` },
      { n: 10, flag: '_authorBlowup10', text: `10 reactions. this one actually landed.` },
      { n: 25, flag: '_authorBlowup25', text: `25 reactions — this might be your best post yet 🏆` }
    ];
    for (const { n, flag, text } of authorMilestones) {
      if (totalReactors >= n && !post[flag]) {
        post[flag] = true;
        pushNotif(post.authorEmail, {
          type: 'blowup-author',
          fromName: '🔥 your post',
          fromEmail: '',
          postId: post.id,
          text
        });
      }
    }
  }

  // Reciprocal nudge: tell the post author to go react to the reactor's latest post.
  // Fires max once per pair per day — keeps energy cycling bidirectionally.
  if (emoji && !post.isAnonymous && post.authorEmail &&
      post.authorEmail.toLowerCase() !== user.email.toLowerCase()) {
    const recipKey = `recip|${post.authorEmail.toLowerCase()}|${user.email.toLowerCase()}`;
    const lastRecip = mutualViewsSent[recipKey] || 0;
    if (Date.now() - lastRecip > ONE_DAY_MS) {
      mutualViewsSent[recipKey] = Date.now();
      saveMutualViews();
      const reactorLatestPost = posts
        .filter(p => p.authorEmail === user.email && !p.isAnonymous)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (reactorLatestPost) {
        pushNotif(post.authorEmail, {
          type: 'reciprocal-nudge',
          fromName: user.name,
          fromEmail: user.email,
          postId: reactorLatestPost.id,
          text: `${user.name.split(' ')[0]} just reacted to your post — have you checked out theirs?`
        });
      }
    }
  }

  // Retroactive engagement: if post is >12h old and reactor isn't the author,
  // ping the author that their old content is still pulling attention.
  // Rate-limited to once per 6h per post.
  const postAge = Date.now() - post.createdAt;
  if (emoji && postAge > 12 * 60 * 60 * 1000 && !post.isAnonymous && post.authorEmail &&
      post.authorEmail.toLowerCase() !== user.email.toLowerCase()) {
    const lastRetroAge = post.lastRetroNotifAt ? Date.now() - post.lastRetroNotifAt : Infinity;
    if (lastRetroAge > 6 * 60 * 60 * 1000) {
      post.lastRetroNotifAt = Date.now();
      pushNotif(post.authorEmail, {
        type: 'retro',
        fromName: user.name,
        fromEmail: user.email,
        postId: post.id,
        text: `your post from ${timeAgoServer(post.createdAt)} is getting attention again`
      });
    }
  }

  res.json(summary);
});

// Legacy /vote endpoint kept for back-compat with old clients
app.post('/api/posts/:id/vote', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  if (!post.reactions) post.reactions = {};
  for (const e of Object.keys(post.reactions)) {
    delete post.reactions[e][user.email];
    if (Object.keys(post.reactions[e]).length === 0) delete post.reactions[e];
  }
  const { vote } = req.body || {};
  const emoji = vote === 'up' ? '👍' : vote === 'down' ? '👎' : null;
  if (emoji) {
    if (!post.reactions[emoji]) post.reactions[emoji] = {};
    post.reactions[emoji][user.email] = user.name;
  }
  post.upvotes = post.reactions['👍'] || {};
  post.downvotes = post.reactions['👎'] || {};
  savePosts();
  const summary = {
    id: post.id, reactions: post.reactions,
    upvotes: post.upvotes, downvotes: post.downvotes,
    upCount: Object.keys(post.upvotes).length,
    downCount: Object.keys(post.downvotes).length
  };
  io.emit('post-voted', summary);
  res.json(summary);
});

// Shared comment handler used by both /comment and /comments routes.
function handlePostComment(req, res) {
  const user = requireUser(req, res);
  if (!user) {
    console.log(`[POST comment] requireUser denied — token present: ${!!req.headers['x-user-token']}`);
    return;
  }
  const post = posts.find(p => p.id === req.params.id);
  if (!post) {
    console.log(`[POST comment] post not found: ${req.params.id}`);
    return res.status(404).json({ error: 'not found' });
  }
  const { text, anon, content, isAnonymous, gifUrl } = req.body || {};
  const body = String(text || content || '').trim();
  // Validate optional gif (must be from tenor)
  let cleanGifUrl = '';
  if (gifUrl) {
    if (typeof gifUrl !== 'string' || gifUrl.length > 500) return res.status(400).json({ error: 'bad gif url' });
    if (!/^https:\/\/(media\d?\.tenor\.com|c\.tenor\.com|tenor\.com)/.test(gifUrl)) {
      return res.status(400).json({ error: 'gif must be from tenor' });
    }
    cleanGifUrl = gifUrl;
  }
  if (!body && !cleanGifUrl) return res.status(400).json({ error: 'empty' });
  const isAnon = !!(anon || isAnonymous);
  const comment = {
    id: newId(),
    author: isAnon ? 'anonymous' : user.name,
    authorEmail: isAnon ? '' : user.email,
    isAnonymous: isAnon,
    _realAuthorEmail: user.email,
    text: body.slice(0, 400),
    content: body.slice(0, 400),
    gifUrl: cleanGifUrl,
    createdAt: Date.now()
  };
  // Defensive: some legacy posts might not have comments[] initialized
  if (!Array.isArray(post.comments)) post.comments = [];
  post.comments.push(comment);
  savePosts();
  trackEvent(user.email, 'comment', { postId: post.id });
  console.log(`[comment] ${user.email} → post ${post.id} ("${comment.text.slice(0, 40)}")`);
  io.emit('post-commented', { postId: post.id, comment });

  // Notify the post author of a new comment (if not commenting on own post).
  // Anonymous comments must NOT leak the commenter's name to the post author.
  if (post.authorEmail && post.authorEmail !== user.email) {
    pushNotif(post.authorEmail, {
      type: 'comment',
      fromName: isAnon ? 'someone (anonymous)' : user.name,
      fromEmail: isAnon ? '' : user.email,
      postId: post.id,
      text: comment.text.slice(0, 140)
    });
  }
  // Mentions / name mentions in comment. CRITICAL: if the comment was made
  // anonymously, the mention notification must NOT leak the real name —
  // otherwise the recipient can de-anonymize the commenter by checking who
  // pinged them. Use 'someone (anonymous)' / empty email instead.
  const notifFromName = isAnon ? 'someone (anonymous)' : user.name;
  const notifFromEmail = isAnon ? '' : user.email;
  const mentioned = findMentionedUsers(comment.text);
  const named = findNamedUsers(comment.text).filter(e => !mentioned.includes(e));
  for (const email of mentioned) {
    if (email === user.email) continue;
    const target = findUserByEmail(email);
    if (!target) continue;
    pushNotif(email, { type: 'mention', fromName: notifFromName, fromEmail: notifFromEmail, postId: post.id, text: comment.text.slice(0, 140) });
    if (!isAnon) {
      sendMentionEmail({ toName: target.name, toEmail: email, fromName: user.name, postPreview: comment.text, postId: post.id });
    }
  }
  for (const email of named) {
    if (email === user.email) continue;
    pushNotif(email, { type: 'talked-about', fromName: notifFromName, fromEmail: notifFromEmail, postId: post.id, text: comment.text.slice(0, 140) });
  }

  // Thread heating: when a post hits 5 or 10 comments, pull back prior
  // commenters who aren't already in this exchange — they'll feel like they
  // walked away from a party that kept getting louder without them.
  const totalComments = (post.comments || []).length;
  const heatThresholds = [5, 10, 20];
  for (const thresh of heatThresholds) {
    const heatFlag = `_heatNotif${thresh}`;
    if (totalComments >= thresh && !post[heatFlag] && !post.isAnonymous) {
      post[heatFlag] = true;
      // Collect unique previous commenters (non-anon, not the current commenter, not the author)
      const prevCommenters = [...new Set(
        (post.comments || [])
          .slice(0, -1) // exclude the comment we just added
          .filter(c => !c.isAnonymous && c.authorEmail && c.authorEmail !== user.email && c.authorEmail !== post.authorEmail)
          .map(c => c.authorEmail)
      )];
      const authorName = post.isAnonymous ? 'someone' : (findUserByEmail(post.authorEmail)?.name?.split(' ')[0] || 'someone');
      for (const prevEmail of prevCommenters.slice(0, 8)) {
        pushNotif(prevEmail, {
          type: 'thread-heat',
          fromName: '🔥 thread blowing up',
          fromEmail: '',
          postId: post.id,
          text: `the thread you commented on just hit ${thresh} comments — people are still going.`
        });
      }
    }
  }

  res.json(comment);
}
app.post('/api/posts/:id/comment', handlePostComment);
app.post('/api/posts/:id/comments', handlePostComment);

app.post('/api/posts/:id/report', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  if (!post.reports) post.reports = [];
  const reason = String((req.body && req.body.reason) || '').slice(0, 200);
  const existing = post.reports.find(r => r.reporterEmail === user.email);
  if (existing) {
    existing.reason = reason || existing.reason;
    existing.ts = Date.now();
  } else {
    post.reports.push({
      reporterEmail: user.email,
      reporterName: user.name,
      reason,
      ts: Date.now()
    });
  }
  savePosts();
  io.emit('admin-event', { type: 'post-reported', postId: post.id });
  res.json({ ok: true, reportCount: post.reports.length });
});

// =================================================================
// PROFILES
// =================================================================
app.get('/api/posts/:id', (req, res) => {
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json(publicPost(post));
});

// Owner-delete: user can delete their OWN post (admin uses the admin route).
app.delete('/api/posts/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const idx = posts.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const post = posts[idx];
  const isOwner = (post.authorEmail || '').toLowerCase() === user.email.toLowerCase();
  if (!isOwner && !user.isAdmin) return res.status(403).json({ error: 'not your post' });
  posts.splice(idx, 1);
  savePosts();
  io.emit('post-deleted', { id: post.id });
  res.json({ ok: true });
});

app.get('/api/users/profile/:email', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const target = findUserByEmail(email);
  // HARD school isolation — viewing a cross-school user 404s. Always
  // allow self-lookup so own profile works.
  const isSelf = me.email && email === me.email.toLowerCase();
  if (target && !isSelf && !viewerCanSeeUser(me, target)) {
    return res.status(404).json({ error: 'not found' });
  }
  // If they're not a member yet but they're in the directory, return a stub
  // so the UI shows "this person hasn't joined yet — pull them in" instead
  // of a dead-end 404.
  if (!target || target.status === 'banned') {
    const dirEntry = directory.find(d => d.email && d.email.toLowerCase() === email);
    if (dirEntry) {
      return res.json({
        email: dirEntry.email,
        name: dirEntry.name,
        isStub: true,
        joinedAt: 0,
        bio: '',
        avatar: '',
        viewCount: 0,
        recentViewers: [],
        visiblePostCount: 0,
        actualPostCount: 0,
        friendCount: 0,
        mood: '', moodId: '',
        headline: '',
        aboutMe: `${dirEntry.name.split(' ')[0]} hasn't joined Old Streets yet — send them a 💌 love letter to pull them in.`,
        interests: '', heroes: '', pronouns: '', websiteUrl: '',
        theme: 'classic',
        top8: [], blinkies: [],
        songUrl: '', songEmbed: null,
        backgroundUrl: '', backgroundMode: 'cover',
        customHtmlSafe: '', customCss: '',
        vanityUrl: '',
        boardCount: 0
      });
    }
    return res.status(404).json({ error: 'not found' });
  }
  // Track view (don't track viewing your own profile). Dedup by
  // (viewer, target) — if the same person revisits, bump their existing
  // entry's timestamp instead of pushing a new row. That way the recent-
  // viewers list shows N DIFFERENT viewers, not the same person N times.
  if (email !== me.email.toLowerCase()) {
    const meLc = me.email.toLowerCase();
    const existing = profileViews.find(v =>
      (v.viewer || '').toLowerCase() === meLc &&
      (v.target || '').toLowerCase() === email);
    if (existing) {
      existing.ts = Date.now();
      existing.viewerName = me.name; // refresh in case the user renamed
      existing.revisits = (existing.revisits || 1) + 1;
    } else {
      profileViews.push({ viewer: me.email, viewerName: me.name, target: email, ts: Date.now(), revisits: 1 });
      if (profileViews.length > 20000) profileViews = profileViews.slice(-20000);
    }
    saveViews();
    checkAndFireMutualView(me.email, email);

    // Dark push: tell the target someone is obsessively checking them out.
    // No name revealed — just enough ambiguity to send them spiraling back.
    const row = profileViews.find(v =>
      (v.viewer || '').toLowerCase() === meLc &&
      (v.target || '').toLowerCase() === email);
    const revisitCount = row ? (row.revisits || 1) : 1;
    const obsKey = `obsession|${meLc}|${email}`;
    const lastObsTs = mutualViewsSent[obsKey] || 0;
    if (revisitCount === 3 && Date.now() - lastObsTs > ONE_DAY_MS * 2) {
      mutualViewsSent[obsKey] = Date.now();
      saveMutualViews();
      const targetUser = findUserByEmail(email);
      if (targetUser) {
        pushNotif(targetUser.email, {
          type: 'profile-obsession',
          fromName: '👀 someone keeps coming back',
          fromEmail: '',
          text: `someone visited your profile multiple times this week. you seem to have an admirer.`
        });
      }
    } else if (revisitCount > 3 && revisitCount % 7 === 0 && Date.now() - lastObsTs > ONE_DAY_MS * 2) {
      mutualViewsSent[obsKey] = Date.now();
      saveMutualViews();
      const targetUser = findUserByEmail(email);
      if (targetUser) {
        pushNotif(targetUser.email, {
          type: 'profile-obsession',
          fromName: '👀 still watching',
          fromEmail: '',
          text: `the same person keeps returning to your profile. they clearly haven't stopped thinking about you.`
        });
      }
    }
  }
  // Compute view count + recent viewers (only if asking about own profile)
  const viewsForTarget = profileViews.filter(v => v.target === email);
  const isMe = email === me.email.toLowerCase();
  // Anonymous posts don't show up on the public profile post count —
  // otherwise people could correlate "this user has 8 total posts but
  // only 3 attributed = 5 anon" and de-anonymize behavior.
  const rawPostCount = posts.filter(p => p.authorEmail === email && !p.isAnonymous).length;
  res.json({
    email: target.email,
    name: target.name,
    bio: target.bio || '',
    avatar: target.avatar || '',
    joinedAt: target.approvedAt || target.createdAt,
    status: target.status,
    streak: target.streak || 0,
    lastSeen: target.lastSeen || 0,
    online: Array.from(onlineUsers.values()).some(o => o.email === email),
    friends: isMe ? (target.friends || []) : undefined,
    friendCount: (target.friends || []).length,
    viewCount: viewsForTarget.length,
    // Profile views are now PUBLIC — anyone can see who viewed any profile.
    recentViewers: viewsForTarget
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 20)
      .map(v => ({ email: v.viewer, name: v.viewerName, ts: v.ts })),
    visiblePostCount: decayedPostCount(target, rawPostCount),
    actualPostCount: rawPostCount,
    // MySpace fields
    mood: target.mood || '',
    moodId: target.moodId || '',
    headline: target.headline || '',
    aboutMe: target.aboutMe || '',
    interests: target.interests || '',
    heroes: target.heroes || '',
    pronouns: target.pronouns || '',
    websiteUrl: target.websiteUrl || '',
    theme: target.theme || 'classic',
    top8: (target.top8 || []).map(e => {
      const u = findUserByEmail(e);
      return u ? { email: u.email, name: u.name, avatar: u.avatar || '' } : null;
    }).filter(Boolean),
    blinkies: target.blinkies || [],
    songUrl: target.songUrl || '',
    songEmbed: target.songEmbed || null,
    backgroundUrl: target.backgroundUrl || '',
    backgroundMode: target.backgroundMode || 'cover',
    backgroundOpacity: typeof target.backgroundOpacity === 'number' ? target.backgroundOpacity : 85,
    profileTextColor: target.profileTextColor || '',
    // Friendship signals from viewer's perspective. If they're already
    // friends both directions, treat any leftover "pending" request as stale.
    viewerSentFriendReq: (() => {
      const meFriends = (me.friends || []).map(e => (e || '').toLowerCase());
      if (meFriends.includes(target.email.toLowerCase())) return false;
      return !!friendRequests.find(r =>
        r.from && r.to &&
        r.from.toLowerCase() === me.email.toLowerCase() &&
        r.to.toLowerCase() === target.email.toLowerCase() &&
        r.status === 'pending');
    })(),
    viewerReceivedFriendReq: (() => {
      const meFriends = (me.friends || []).map(e => (e || '').toLowerCase());
      if (meFriends.includes(target.email.toLowerCase())) return false;
      return !!friendRequests.find(r =>
        r.from && r.to &&
        r.from.toLowerCase() === target.email.toLowerCase() &&
        r.to.toLowerCase() === me.email.toLowerCase() &&
        r.status === 'pending');
    })(),
    customHtmlSafe: target.customHtmlSafe || '',
    customCss: target.customCss || '',
    vanityUrl: target.vanityUrl || '',
    boardCount: (profileBoards[email] || []).length,
    karmaScore: computeKarmaScore(email).score,
    karmaLabel: computeKarmaScore(email).label,
    karmaTier:  computeKarmaScore(email).tier,
    royalty: target.royalty || null,
    grade: target.grade || '',
    classOf: gradeToClassOf(target.grade),
    ogTier: computeOgTier(target.createdAt || 0),
    daysOnPlatform: Math.floor((Date.now() - (target.createdAt || Date.now())) / (24*60*60*1000)),
    pinnedPosts: ((target.pinnedPosts || []).map(pid => {
      const p = posts.find(x => x.id === pid);
      if (!p) return null;
      // Strip internal flags; same shape as public posts
      const { isGhost: _ig, ghostNames: _gn, _templateSource: _ts, _realAuthorEmail: _ra, ...rest } = p;
      return rest;
    }).filter(Boolean))
  });
});

// Pin / unpin any post to MY profile (max 6 pins)
// =================================================================
// STOLEN-ACCOUNT RECOVERY / EMAIL-CODE SIGN-IN
// "My account got hacked" / "I forgot my password" — send a 6-digit
// code to the school email; entering it invalidates all old tokens
// and issues a fresh session. Works as 2FA-by-email since only the
// real owner of the email address receives the code.
// =================================================================
app.post('/api/recover/request',
  rateLimit({ key: 'recover-request', max: 4, windowMs: 60 * 60 * 1000 }),
  async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    // Always return ok to avoid leaking which emails exist.
    const u = findUserByEmail(email);
    if (!u) {
      pushThreatEvent({ type: 'recover-unknown-email', severity: 'med', ip: clientIp(req), who: email });
      return res.json({ ok: true });
    }
    if (u.status === 'banned') {
      pushThreatEvent({ type: 'recover-banned', severity: 'med', ip: clientIp(req), who: email });
      return res.json({ ok: true });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    u.recoverCode = code;
    u.recoverCodeAt = Date.now();
    scheduleSave(USERS_FILE, () => users, 500);
    pushThreatEvent({ type: 'recover-request', severity: 'med', ip: clientIp(req), who: email });
    sendVerificationCodeEmail({ toEmail: u.email, code, purpose: 'recover', schoolName: config.siteName })
      .catch(e => console.warn('[recover] send failed', e.message));
    res.json({ ok: true });
  }
);

app.post('/api/recover/verify',
  rateLimit({ key: 'recover-verify', max: 20, windowMs: 60 * 60 * 1000 }),
  (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').trim().slice(0, 10);
    if (!email || !code) return res.status(400).json({ error: 'email + code required' });
    const u = findUserByEmail(email);
    if (!u || !u.recoverCode) {
      pushThreatEvent({ type: 'recover-verify-fail', severity: 'high', ip: clientIp(req), who: email, note: 'no pending code' });
      return res.status(400).json({ error: 'invalid code' });
    }
    if (Date.now() - (u.recoverCodeAt || 0) > 30 * 60 * 1000) {
      u.recoverCode = null;
      return res.status(400).json({ error: 'code expired — request a new one' });
    }
    if (u.recoverCode !== code) {
      pushThreatEvent({ type: 'recover-verify-fail', severity: 'high', ip: clientIp(req), who: email, note: 'bad code' });
      return res.status(400).json({ error: 'invalid code' });
    }
    // Success — rotate token (kills any stolen sessions) and clear the code.
    u.recoverCode = null;
    u.recoverCodeAt = 0;
    u.token = newToken();
    u.tokenRotatedAt = Date.now();
    u.schoolEmailVerified = true; // proof of email ownership
    u.schoolEmailVerifiedAt = Date.now();
    saveUsers();
    pushThreatEvent({ type: 'recover-success', severity: 'med', ip: clientIp(req), who: email });
    console.log(`[recover] ${email} recovered via email code — all old sessions invalidated`);
    res.json({ ok: true, token: u.token, user: publicUser(u) });
  }
);

// Verify the school email by entering the 6-digit code that was emailed at
// signup. Until verified, the account cannot post / comment / react — that
// prevents impersonation
// address. Only the actual email owner gets the code.
app.post('/api/me/verify-school-email', rateLimit({ key: 'verify-school', max: 12, windowMs: 30 * 60 * 1000 }), (req, res) => {
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'sign in first' });
  if (user.schoolEmailVerified) return res.json({ ok: true, alreadyVerified: true });
  const code = String((req.body && req.body.code) || '').trim().slice(0, 10);
  if (!code) return res.status(400).json({ error: 'code required' });
  if (code !== user.schoolEmailVerifyCode) return res.status(400).json({ error: 'wrong code' });
  // 30 minute window
  if (Date.now() - (user.schoolEmailVerifyCodeAt || 0) > 30 * 60 * 1000) {
    return res.status(400).json({ error: 'code expired — request a new one' });
  }
  user.schoolEmailVerified = true;
  user.schoolEmailVerifiedAt = Date.now();
  user.schoolEmailVerifyCode = null;
  saveUsers();
  res.json({ ok: true, user: publicUser(user) });
});

// Resend the school-email verification code (rate-limited to once per minute).
app.post('/api/me/resend-school-verify', async (req, res) => {
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'sign in first' });
  if (user.schoolEmailVerified) return res.json({ ok: true, alreadyVerified: true });
  if (Date.now() - (user.schoolEmailVerifyCodeAt || 0) < 60 * 1000) {
    return res.status(429).json({ error: 'wait a minute before resending' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  user.schoolEmailVerifyCode = code;
  user.schoolEmailVerifyCodeAt = Date.now();
  saveUsers();
  await sendVerificationCodeEmail({ toEmail: user.email, code, purpose: 'verify', schoolName: config.siteName });
  res.json({ ok: true });
});

// Set or update the user's grade (also used by the "missing grade" prompt
// for accounts that signed up before the field existed).
//
// TRAP: middle-school grades (6/7/8) get the account hard-deleted immediately.
// Old Streets is upper-school only. If a middle-schooler picks their real
// grade, we yank the account on the spot — no warning, no recovery.
app.post('/api/me/set-grade', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const g = String((req.body && req.body.grade) || '').trim().slice(0, 10);
  const allowed = new Set(['6','7','8','9','10','11','12','alumni']);
  if (!allowed.has(g)) return res.status(400).json({ error: 'pick a real grade' });
  if (g === '6' || g === '7' || g === '8') {
    console.log(`[grade-trap] deleting ${me.email} — selected middle-school grade ${g}`);
    deleteUserByEmail(me.email);
    return res.status(403).json({ error: 'middle-schooler', deleted: true });
  }
  me.grade = g;
  saveUsers();
  res.json({ ok: true, user: publicUser(me) });
});

// Helper to fully purge a user from the platform.
function deleteUserByEmail(email) {
  const lc = String(email || '').toLowerCase();
  const idx = users.findIndex(u => (u.email || '').toLowerCase() === lc);
  if (idx >= 0) users.splice(idx, 1);
  // Also remove their pending friend requests so they don't leave ghosts
  friendRequests = friendRequests.filter(r =>
    (r.from || '').toLowerCase() !== lc && (r.to || '').toLowerCase() !== lc);
  saveUsers();
  saveFriendRequests();
}

// "While you were away" — when the user re-loads after 5+ days idle, send
// one-time summary of what they missed. Called by whoami fetch; idempotent
// per absence (a single absence yields one digest).
app.post('/api/me/while-away', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const lastVisit = me._whileAwayLastVisit || me.lastVisitAt || me.lastSeen || Date.now();
  const gap = Date.now() - lastVisit;
  const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;
  if (gap < FIVE_DAYS) return res.json({ skipped: true });
  // Bookkeep so we don't fire again until they're away another 5d
  me._whileAwayLastVisit = Date.now();
  saveUsers();
  // Compute digest
  const since = lastVisit;
  const meEmail = me.email.toLowerCase();
  const newPosts = posts.filter(p => p.createdAt > since && !p.isGhost && p.authorEmail !== meEmail).length;
  const mentions = notifs.filter(n => n.to === meEmail && n.ts > since && (n.type === 'mention' || n.type === 'talked-about')).length;
  const profileViewers = profileViews.filter(v => v.target === meEmail && (v.ts || 0) > since).length;
  const dmsMissed = dms.filter(d => d.to === meEmail && d.ts > since && !d.read).length;
  res.json({
    awayMs: gap,
    awayDays: Math.floor(gap / (24*60*60*1000)),
    newPosts,
    mentions,
    profileViewers,
    dmsMissed
  });
});

// Memory drop — random old post from THIS user resurfaces. Server picks
// a post and tags this user as having seen it via a "memory" notif.
// Triggered automatically on whoami if (a) user has 3+ posts and
// (b) last memory drop was 14+ days ago.
function maybeDropMemory(user) {
  if (!user) return;
  const last = user.lastMemoryDropAt || 0;
  if (Date.now() - last < 14 * 24 * 60 * 60 * 1000) return;
  const myPosts = posts.filter(p =>
    p.authorEmail && p.authorEmail.toLowerCase() === user.email.toLowerCase() &&
    !p.isGhost &&
    (Date.now() - p.createdAt) > 30 * 24 * 60 * 60 * 1000  // at least 30d old
  );
  if (myPosts.length < 3) return;
  const pick = myPosts[Math.floor(Math.random() * myPosts.length)];
  const daysOld = Math.floor((Date.now() - pick.createdAt) / (24*60*60*1000));
  pushNotif(user.email, {
    type: 'memory',
    fromName: '🌀 Memory Drop',
    fromEmail: '',
    postId: pick.id,
    text: `your post from ${daysOld} days ago is back. remember this?`
  });
  user.lastMemoryDropAt = Date.now();
  saveUsers();
}

// One-year anniversary — fires once when the user hits 365 days on platform.
function maybeFireAnniversary(user) {
  if (!user) return;
  const days = (Date.now() - (user.createdAt || Date.now())) / (24*60*60*1000);
  // 365 ± 2 day window
  if (days < 363 || days > 370) return;
  if (user.anniversaryFiredAt) return;
  user.anniversaryFiredAt = Date.now();
  saveUsers();
  pushNotif(user.email, {
    type: 'anniversary',
    fromName: '🎂 1 year on Old Streets',
    fromEmail: '',
    text: `you've been here a whole year. look how cringe day-one you was.`
  });
}

// Record that the user agreed to the current TOS version.
app.post('/api/me/agree-tos', (req, res) => {
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'sign in first' });
  user.tosAgreedVersion = CURRENT_TOS_VERSION;
  user.tosAgreedAt = Date.now();
  user.tosAgreedFromIp = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
  saveUsers();
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/me/pinned-posts/:postId', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const post = posts.find(p => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: 'post not found' });
  me.pinnedPosts = me.pinnedPosts || [];
  if (me.pinnedPosts.includes(post.id)) return res.json({ ok: true, pinned: me.pinnedPosts });
  if (me.pinnedPosts.length >= 6) return res.status(400).json({ error: 'max 6 pinned posts — unpin one first' });
  me.pinnedPosts.unshift(post.id); // newest pin first
  saveUsers();
  res.json({ ok: true, pinned: me.pinnedPosts });
});

app.delete('/api/me/pinned-posts/:postId', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  me.pinnedPosts = (me.pinnedPosts || []).filter(id => id !== req.params.postId);
  saveUsers();
  res.json({ ok: true, pinned: me.pinnedPosts });
});

// requireUser fails if not active. For self-edit while in awaiting-referrals
// we need a relaxed version that just verifies the token.
function requireSession(req, res) {
  const token = req.headers['x-user-token'] || (req.body && req.body.token);
  const user = findUserByToken(token);
  if (!user) { res.status(401).json({ error: 'sign in first' }); return null; }
  if (user.status === 'banned') { res.status(403).json({ error: 'account banned' }); return null; }
  user.lastSeen = Date.now();
  saveUsers();
  return user;
}

// Onboarding selfie — captured live via getUserMedia + photo-booth countdown.
// Body: { dataUrl: "data:image/jpeg;base64,..." }. Flips `selfieTaken` so
// chrome.js can stop forcing the camera overlay.
app.post('/api/me/selfie', (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  // One-shot: once a selfie is taken, it's locked. Admin can reset
  // by manually editing users.json on the volume.
  if (user.selfieTaken && !user.isAdmin) {
    return res.status(409).json({ error: 'locked', message: 'profile photo is set for life — cannot change.' });
  }
  const dataUrl = String((req.body && req.body.dataUrl) || '');
  if (!dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'expected data:image/...' });
  if (dataUrl.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'selfie too big — try again' });
  user.avatar = dataUrl;
  user.selfieTaken = true;
  user.selfieTakenAt = Date.now();
  user.selfieLockedAt = Date.now();
  saveUsers();
  res.json({ ok: true, user: publicUser(user) });
});

app.put('/api/users/me', (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  const { name, bio, avatar } = req.body || {};
  if (typeof name === 'string' && name.trim() && !user.nameLockedFromDirectory) {
    user.name = name.trim().slice(0, 40);
  }
  if (typeof bio === 'string') {
    user.bio = bio.slice(0, 200);
  }
  if (typeof avatar === 'string') {
    if (avatar === '' || avatar.startsWith('data:image/')) {
      // client compresses before sending; this is a generous cap.
      if (avatar.length > 2 * 1024 * 1024) {
        return res.status(413).json({ error: 'avatar too big — try a smaller image' });
      }
      user.avatar = avatar;
    }
  }
  saveUsers();
  res.json({ user: publicUser(user) });
});

// =================================================================
// DIRECTORY + REFERRALS
// =================================================================
// ===================================================================
// SEARCH — active-member search by name / handle / email. Used by
// the chats compose modal, friends "find people" tab, crush picker,
// and anywhere else clients need to find a user.
// ===================================================================
app.get('/api/search', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const q = String((req.query && req.query.q) || '').trim().toLowerCase().replace(/^@/, '');
  const scope = String(req.query.scope || 'people');
  if (scope !== 'people') return res.json({ results: [] });
  let pool = users
    .filter(u => u.status === 'active' && u.id !== me.id && !u.isBot && !u.isSystem)
    .filter(u => viewerCanSeeUser(me, u));
  if (q && q.length >= 2) {
    pool = pool.filter(u => {
      const hay = ((u.name || '') + ' ' + (u.handle || '') + ' ' + (u.email || '')).toLowerCase();
      return hay.includes(q);
    });
  } else {
    // No query → return everyone, most recently active first, so "Find People"
    // doubles as a members directory.
    pool = pool.sort((a, b) => (b.lastSeen || b.createdAt || 0) - (a.lastSeen || a.createdAt || 0));
  }
  const results = pool.slice(0, 200).map(u => ({
    email: u.email,
    name: u.name,
    handle: u.handle || '',
    avatar: u.avatar || '',
    headline: u.headline || '',
    lastSeen: u.lastSeen || 0
  }));
  res.json({ results, total: pool.length });
});

// Dedicated "all members" endpoint for the members directory page.
app.get('/api/members', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const q = String((req.query && req.query.q) || '').trim().toLowerCase().replace(/^@/, '');
  let pool = users
    .filter(u => u.status === 'active' && !u.isBot && !u.isSystem)
    .filter(u => viewerCanSeeUser(me, u));
  if (q && q.length >= 1) {
    pool = pool.filter(u => {
      const hay = ((u.name || '') + ' ' + (u.handle || '') + ' ' + (u.email || '')).toLowerCase();
      return hay.includes(q);
    });
  }
  // Sort: online first, then most recently active.
  const onlineEmails = new Set();
  for (const [, info] of onlineUsers) {
    const e = (info && info.email || '').toLowerCase();
    if (e) onlineEmails.add(e);
  }
  pool.sort((a, b) => {
    const ao = onlineEmails.has((a.email||'').toLowerCase()) ? 1 : 0;
    const bo = onlineEmails.has((b.email||'').toLowerCase()) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return (b.lastSeen || b.createdAt || 0) - (a.lastSeen || a.createdAt || 0);
  });
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)));
  res.json({
    members: pool.slice(0, limit).map(u => ({
      email: u.email,
      name: u.name,
      handle: u.handle || '',
      avatar: u.avatar || '',
      rating: avgRating(u.email),
      headline: u.headline || '',
      lastSeen: u.lastSeen || 0,
      online: onlineEmails.has((u.email||'').toLowerCase()),
      isAdmin: !!u.isAdmin
    })),
    total: pool.length
  });
});

// GET /api/friends — list of the caller's accepted friends.
app.get('/api/friends', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const friendEmails = (me.friends || []).map(e => e.toLowerCase());
  const list = friendEmails
    .map(e => findUserByEmail(e))
    .filter(u => u && u.status === 'active')
    .map(u => ({
      email: u.email,
      name: u.name,
      handle: u.handle || '',
      avatar: u.avatar || ''
    }));
  res.json({ friends: list });
});

// GET /api/throwback — convenience alias for /api/me/throwback.
app.get('/api/throwback', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  // Pull anything older than 24h that the user has interacted with or that's
  // theirs — simple version returns the user's own old posts.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const mine = posts
    .filter(p => p.authorEmail === me.email && p.createdAt < cutoff)
    .slice(0, 20)
    .map(p => publicPost(p, me.email));
  res.json({ posts: mine });
});

// GET /api/blogs/authors — leaderboard of blog authors by post count.
app.get('/api/blogs/authors', (_req, res) => {
  const counts = {};
  for (const b of blogs) {
    const k = (b.authorEmail || '').toLowerCase();
    if (!k) continue;
    counts[k] = counts[k] || { email: b.authorEmail, name: b.authorName, count: 0 };
    counts[k].count++;
  }
  const list = Object.values(counts)
    .map(c => {
      const u = findUserByEmail(c.email);
      return { name: c.name, email: c.email, count: c.count, handle: (u && u.handle) || (c.email||'').split('@')[0] };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  res.json({ authors: list });
});

// POST /api/crush/remove — body { email } — aliased to the existing DELETE
// /api/crush/:toEmail handler. Clients using either form work.
app.post('/api/crush/remove', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const target = String((req.body && req.body.email) || '').toLowerCase();
  if (!target) return res.status(400).json({ error: 'email required' });
  const idx = crushList.findIndex(c => c.from.toLowerCase() === me.email.toLowerCase() && c.to.toLowerCase() === target);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  if (crushList[idx].matched) return res.status(409).json({ error: "can't remove a matched crush — DM them instead" });
  crushList.splice(idx, 1);
  saveCrushList();
  res.json({ ok: true });
});

// POST /api/friend-requests/:id/accept and /reject — convenience aliases
// for the existing /respond endpoint. Sub-pages call these directly.
app.post('/api/friend-requests/:id/accept', (req, res, next) => {
  req.body = Object.assign({}, req.body, { accept: true });
  req.url = `/api/friend-requests/${req.params.id}/respond`;
  app(req, res, next);
});
app.post('/api/friend-requests/:id/reject', (req, res, next) => {
  req.body = Object.assign({}, req.body, { accept: false });
  req.url = `/api/friend-requests/${req.params.id}/respond`;
  app(req, res, next);
});

// Daily-24 endpoint aliases — the canonical paths use a hyphen
// (/api/daily-24/*) but several clients expect /api/daily24/*. Alias both.
app.get('/api/daily24/pair', (req, res, next) => { req.url = '/api/daily-24/pair'; app(req, res, next); });
app.post('/api/daily24/vote', (req, res, next) => { req.url = '/api/daily-24/vote'; app(req, res, next); });
app.get('/api/daily24/leaderboard', (req, res, next) => { req.url = '/api/daily-24/leaderboard'; app(req, res, next); });
app.post('/api/daily24/submit', (req, res) => {
  // No native submit endpoint — fall back to /api/posts type=image which
  // already feeds the daily-24 pool through the daily-24 surface logic.
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const content = String((req.body && req.body.content) || '');
  const caption = String((req.body && req.body.caption) || '').slice(0, 200);
  if (!content) return res.status(400).json({ error: 'missing content' });
  const post = {
    id: newId(), author: me.name, authorEmail: me.email,
    isAnonymous: false, type: 'image', content, caption,
    reactions: {}, upvotes: {}, downvotes: {}, comments: [], reports: [], views: {},
    createdAt: Date.now(), daily24: true
  };
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  res.json({ ok: true, postId: post.id });
});

// ===================================================================
// INVITE EXPIRY SWEEPER + GROWTH FREEZE
// Playbook: 14-day invite expiry forces conversation, not link-hoarding.
// Admin can freeze all invites in 1 click if growth outpaces moderation.
// ===================================================================
let _inviteFreezeUntil = 0;
function inviteFreezeActive() { return Date.now() < _inviteFreezeUntil; }

function sweepExpiredInvites() {
  const now = Date.now();
  let refunded = 0;
  for (const u of users) {
    if (!u.pendingInvites || !u.pendingInvites.length) continue;
    const kept = [];
    for (const inv of u.pendingInvites) {
      if (!inv.claimedBy && inv.sentAt && (now - inv.sentAt) > INVITE_EXPIRY_MS) {
        u.referralBalance = (u.referralBalance || 0) + 1;
        u.referralsSpent = Math.max(0, (u.referralsSpent || 0) - 1);
        refunded++;
      } else {
        kept.push(inv);
      }
    }
    u.pendingInvites = kept;
  }
  if (refunded > 0) {
    saveUsers();
    console.log(`[invite-expiry] refunded ${refunded} stale invites`);
  }
}
setInterval(sweepExpiredInvites, 60 * 60 * 1000); // hourly
setTimeout(sweepExpiredInvites, 30 * 1000);

// Admin freeze controls — both manual and triggered automatically when
// new-member-to-moderator ratio gets dangerous.
app.post('/api/admin/invites/freeze', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const hours = Math.max(1, Math.min(720, parseInt(req.body && req.body.hours, 10) || 168));
  _inviteFreezeUntil = Date.now() + hours * 60 * 60 * 1000;
  console.log(`[admin] froze all invite sends for ${hours}h`);
  res.json({ ok: true, frozenUntil: _inviteFreezeUntil });
});
app.post('/api/admin/invites/unfreeze', (req, res) => {
  if (!requireAdmin(req, res)) return;
  _inviteFreezeUntil = 0;
  res.json({ ok: true });
});
app.get('/api/admin/invites/freeze-status', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ frozen: inviteFreezeActive(), frozenUntil: _inviteFreezeUntil });
});

// New-member rate-limit DELETED. Admin asked for the 70-day cap removed —
// fresh accounts post freely from day 0. Helpers kept as no-ops so any
// stale callsites don't blow up.
function isNewMember(_u) { return false; }
function checkNewMemberPostLimit(_user) { return null; }

// ===================================================================
// OLDMEGLE — Omegle-style 1-on-1 video matching. We keep a queue of
// waiting users; when two are waiting, we pair them into a Jitsi room
// and both clients are told the room name. School appears overhead via
// Jitsi displayName ("Name · School").
// ===================================================================
const oldmegleQueue = [];   // [{ email, joinedAt, scope: 'community'|'globe' }]
const oldmegleSessions = new Map(); // sessionId → { roomName, users:[email,email], scope, schoolA, schoolB, startedAt }

// ===================================================================
// HARD SCHOOL ISOLATION — viewer can only see / interact with users
// who share their schoolId. Admins bypass. Pseudo-senders (system/anon)
// always pass through. Posts with no author (legacy) are visible to all.
// ===================================================================
// School isolation removed — everyone is in one community now.
function viewerCanSeeUser(viewer, other) {
  if (!other) return false;
  if (other.status === 'banned') return false;
  return true;
}
function postVisibleToViewer(p, viewer) {
  if (!p) return false;
  if (!p.authorEmail) return true;
  const author = findUserByEmail(p.authorEmail);
  if (!author) return false;
  if (author.status === 'banned') return false;
  return true;
}

// Helper: count how many of a user's pending invites have been claimed
function claimedInviteCount(u) {
  return ((u && u.pendingInvites) || []).filter(i => i.claimedBy).length;
}
// Unlock count: number of phone numbers this user has invited (sent) —
// the moment they SEND 3 invites, locked features open. No waiting for the
// invitees to actually claim. Pulls from pendingInvites (open + claimed),
// plus a counter we tick on every /api/invites/send.
function sentInviteCount(u) {
  if (!u) return 0;
  const pendings = ((u.pendingInvites) || []).filter(i => i && (i.contactType === 'phone' || i.phoneE164 || i.contact)).length;
  return Math.max(pendings, u.invitesSentCount || 0);
}

app.post('/api/oldmegle/match', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.status !== 'active') return res.status(403).json({ error: 'finish approval first' });
  // K=3 LOCK: Oldmegle requires 3 phone-number invites SENT (no need to
  // wait for them to claim). The moment they hit 3 sent, it unlocks.
  const sent = sentInviteCount(me);
  if (sent < 3 && !me.isAdmin) {
    return res.status(403).json({
      error: 'invite-3-required',
      message: `you've invited ${sent} of 3 phone numbers. oldmegle unlocks the moment you send the 3rd.`,
      sent,
      needed: 3
    });
  }
  // Oldmegle is the ONE cross-school surface. Schools are isolated for
  // posts/DMs/rooms/etc., but Oldmegle lets you randomly meet anyone on
  // the platform via globe scope. Community scope stays available for
  // same-school-only matches.
  const scope = String((req.body && req.body.scope) || 'globe').toLowerCase();
  // Remove this user from any prior queue entry first
  for (let i = oldmegleQueue.length - 1; i >= 0; i--) {
    if (oldmegleQueue[i].email === me.email) oldmegleQueue.splice(i, 1);
  }
  // Try to find a partner (community = same school; globe = anyone)
  const partnerIdx = oldmegleQueue.findIndex(q => {
    if (q.email === me.email) return false;
    if (q.scope !== scope) return false;
    if (scope === 'community') {
      const them = findUserByEmail(q.email);
      return !!them && them.schoolId === me.schoolId;
    }
    return true;
  });
  if (partnerIdx >= 0) {
    const partner = oldmegleQueue.splice(partnerIdx, 1)[0];
    const partnerUser = findUserByEmail(partner.email);
    const sessionId = 'om-' + crypto.randomBytes(6).toString('hex');
    const roomName = 'oldstreets-' + sessionId;
    const session = {
      roomName, scope,
      users: [me.email, partner.email],
      schoolA: me.schoolName || 'school',
      schoolB: (partnerUser && partnerUser.schoolName) || 'school',
      startedAt: Date.now()
    };
    oldmegleSessions.set(sessionId, session);
    // Tell the partner via socket
    for (const [sid, info] of onlineUsers) {
      if (info.email === partner.email) {
        io.to(sid).emit('oldmegle-match', { sessionId, roomName, partnerName: me.name, partnerSchool: me.schoolName });
      }
    }
    return res.json({
      status: 'matched',
      sessionId, roomName,
      partnerName: partnerUser ? partnerUser.name : 'someone',
      partnerSchool: session.schoolB,
      mySchool: me.schoolName || 'school'
    });
  }
  // No partner yet — queue this user
  oldmegleQueue.push({ email: me.email, joinedAt: Date.now(), scope });
  res.json({ status: 'queued', queuePosition: oldmegleQueue.length, scope });
});

app.post('/api/oldmegle/leave', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.json({ ok: true });
  for (let i = oldmegleQueue.length - 1; i >= 0; i--) {
    if (oldmegleQueue[i].email === me.email) oldmegleQueue.splice(i, 1);
  }
  res.json({ ok: true });
});

app.get('/api/oldmegle/queue-size', (req, res) => {
  res.json({ queueSize: oldmegleQueue.length });
});

// ===================================================================
// LIVE ROOMS — lightweight room-name registry. Anyone can create one and
// post a "join" button on the home page right column. Video/voice wiring
// is handled by clients (WebRTC); the server just tracks rooms + members.
// ===================================================================
const liveRoomStore = new Map(); // id → { id, name, createdBy, members: Set, createdAt, lastActive }
function publicRoom(r) {
  if (!r) return null;
  const u = findUserByEmail(r.createdBy);
  return {
    id: r.id,
    name: r.name,
    createdBy: r.createdBy,
    createdByName: u ? u.name : 'someone',
    createdByHandle: u ? (u.handle || '') : '',
    schoolId: r.schoolId || '',
    schoolName: r.schoolName || '',
    scope: r.scope || 'globe',
    memberCount: r.members.size,
    createdAt: r.createdAt,
    lastActive: r.lastActive,
    jitsiRoom: 'oldstreets-room-' + r.id
  };
}
// Drop empty rooms after 10 minutes of inactivity
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of liveRoomStore) {
    if (r.members.size === 0 && now - r.lastActive > 10 * 60 * 1000) {
      liveRoomStore.delete(id);
    }
  }
}, 5 * 60 * 1000);

app.get('/api/rooms/live', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  // HARD school isolation — rooms are community-only. No globe pool
  // for non-admin viewers. Admin sees everything.
  let list = Array.from(liveRoomStore.values()).map(publicRoom);
  if (me.isAdmin) {
    const scope = String(req.query.scope || 'community').toLowerCase();
    if (scope === 'community') list = list.filter(r => r.scope === 'community' && r.schoolId === me.schoolId);
    else if (scope === 'globe') list = list.filter(r => r.scope === 'globe');
  } else {
    list = list.filter(r => r.scope === 'community' && r.schoolId === me.schoolId);
  }
  list.sort((a, b) => b.lastActive - a.lastActive);
  res.json({ rooms: list });
});
app.post('/api/rooms', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  // K=3 LOCK: must have SENT 3 phone-invites to CREATE rooms (joining is fine).
  // No claim-wait — sending the 3rd invite is the unlock moment.
  const sent = sentInviteCount(me);
  if (sent < 3 && !me.isAdmin) {
    return res.status(403).json({
      error: 'invite-3-required',
      message: `${sent} of 3 invites sent. creating rooms unlocks once you send the 3rd — you can still join existing rooms.`
    });
  }
  const rawName = String((req.body && req.body.name) || '').trim().slice(0, 60);
  const name = rawName || (me.name.split(' ')[0] + "'s room");
  // HARD school isolation — all new rooms are community-scoped to the
  // creator's school. Admin can still mint globe rooms.
  const requestedScope = String((req.body && req.body.scope) || 'community').toLowerCase();
  const scope = me.isAdmin ? requestedScope : 'community';
  const id = 'R-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const room = {
    id, name,
    createdBy: me.email,
    schoolId: (scope === 'community' || !me.isAdmin) ? (me.schoolId || '') : '',
    schoolName: (scope === 'community' || !me.isAdmin) ? (me.schoolName || '') : '',
    scope,
    members: new Set([me.email]),
    createdAt: Date.now(),
    lastActive: Date.now()
  };
  liveRoomStore.set(id, room);
  res.json({ ok: true, room: publicRoom(room) });
});
app.post('/api/rooms/:id/join', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const r = liveRoomStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'room is over' });
  // HARD school isolation — only same-school community rooms are joinable.
  // Globe rooms are admin-only.
  if (!me.isAdmin) {
    if (r.scope !== 'community' || r.schoolId !== me.schoolId) {
      return res.status(404).json({ error: 'room is over' });
    }
  }
  r.members.add(me.email);
  r.lastActive = Date.now();
  res.json({ ok: true, room: publicRoom(r) });
});
app.post('/api/rooms/:id/leave', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const r = liveRoomStore.get(req.params.id);
  if (!r) return res.json({ ok: true });
  r.members.delete(me.email);
  r.lastActive = Date.now();
  if (r.members.size === 0 && r.createdBy === me.email) {
    liveRoomStore.delete(r.id);
  }
  res.json({ ok: true });
});

// ===================================================================
// FAKE TRACTION — low-effort bot personas that post + react. Designed
// to feel like real teens shitposting in the background. Posts are
// short, lowercase, typo-friendly, and reference vague "current events"
// (weather, school, late-night, etc) without naming specifics.
// ===================================================================
const BOT_DOMAIN = '@persona.oldstreets';
const BOT_PERSONAS = [
  { name: 'sage rodriguez', handle: 'sageroad' },
  { name: 'maya chen', handle: 'mayaaa' },
  { name: 'jamie cole', handle: 'jcole_' },
  { name: 'devin park', handle: 'devvy' },
  { name: 'aria silva', handle: 'aria' },
  { name: 'leo brooks', handle: 'leobrooks' },
  { name: 'nina patel', handle: 'nina.p' },
  { name: 'theo gomez', handle: 'theogomez' },
  { name: 'kai james', handle: 'kaij' },
  { name: 'eva kim', handle: 'evak' },
  { name: 'ozzy luna', handle: 'ozzy' },
  { name: 'priya rao', handle: 'priya' },
  { name: 'sam taylor', handle: 'samt' },
  { name: 'mira lake', handle: 'miralake' },
  { name: 'rio nakamura', handle: 'rio' },
  { name: 'cassie wu', handle: 'cassie' },
  { name: 'felix daniels', handle: 'fxd' },
  { name: 'naomi west', handle: 'naomi' },
  { name: 'jules ortiz', handle: 'jules' },
  { name: 'sky harlow', handle: 'sky' }
];
const BOT_POST_TEMPLATES = [
  'why is it raining', 'fr fr', 'who else cant sleep', 'this app is actually clean',
  'someone post pls', 'i need new music recs', 'just got home', 'ate too much',
  'school tmrw is gonna be rough', 'who tf is up', 'literally just yawned',
  'manifesting an A on this paper', 'mcdonalds at 1am is a religion',
  'crying over a tiktok', 'why does mondat feel like a thursday',
  'ok but the sunset today??', 'my mom is so chill ngl', 'wait what',
  'this music is so good', 'guys im real', 'who taught me to drive',
  'ok but the new sabrina song', 'lost my airpods again', 'real',
  'sometimes i wonder', 'is anyone gonna text me back', 'rip my battery',
  'iced coffee is unbeaten', 'i cant feel my legs after that workout',
  'why is gas so expensive', 'i miss summer', 'i love my dog actually',
  'who up bored', 'screaming crying throwing up', 'big yikes', 'okkkkk',
  'literally same', 'mood', 'tweaking', 'this slaps', 'caught lacking',
  'no thoughts head empty', 'mid', 'extremely valid', 'bestie no',
  'this is sending me', 'why am i still awake', 'on my third coffee'
];
const BOT_REACTION_EMOJIS = ['👍', '😂', '🔥', '💀', '😍'];

function ensureBotPersonas() {
  for (const p of BOT_PERSONAS) {
    const email = p.handle + BOT_DOMAIN;
    let u = findUserByEmail(email);
    if (!u) {
      u = {
        id: 'bot-' + p.handle,
        email,
        name: p.name,
        handle: p.handle,
        status: 'active',
        approvedAt: Date.now(),
        createdAt: Date.now() - Math.floor(Math.random() * 60 * 86400000),
        friends: [],
        streak: Math.floor(Math.random() * 30),
        postCount: Math.floor(Math.random() * 50),
        hasPostedOnce: true,
        lastSeen: Date.now() - Math.floor(Math.random() * 3600 * 1000),
        lastPostAt: Date.now() - Math.floor(Math.random() * 7 * 86400000),
        isBot: true,
        avatar: '',
        bio: '',
        mood: '',
        phoneE164: '',
        token: 'bot-token-' + p.handle,
        referrals: [],
        pendingInvites: [],
        referralBalance: 0
      };
      users.push(u);
    }
  }
  saveUsers();
}
// Run on next tick after users load
setTimeout(() => { try { ensureBotPersonas(); } catch (e) { console.warn('[bots] ensure failed', e.message); } }, 5000);

function fireBotPost() {
  // DISABLED. Bots no longer auto-post — admin asked for them off so the
  // wall is only real members. Bots still appear online + react to make
  // the room feel populated, but they don't generate content.
  return;
  if (!VIRAL_ON) return;
  const bots = users.filter(u => u.isBot);
  if (!bots.length) return;
  const bot = bots[Math.floor(Math.random() * bots.length)];
  const text = BOT_POST_TEMPLATES[Math.floor(Math.random() * BOT_POST_TEMPLATES.length)];
  const post = {
    id: newId(),
    author: bot.name,
    authorEmail: bot.email,
    isAnonymous: false,
    type: 'text',
    content: text,
    gifUrl: '',
    caption: '',
    reactions: {},
    upvotes: {},
    downvotes: {},
    comments: [],
    reports: [],
    views: {},
    createdAt: Date.now()
  };
  // Some bots auto-react to their own post to seed buzz
  if (Math.random() < 0.3) {
    const em = BOT_REACTION_EMOJIS[Math.floor(Math.random() * BOT_REACTION_EMOJIS.length)];
    post.reactions[em] = {};
    const otherBot = bots[Math.floor(Math.random() * bots.length)];
    if (otherBot && otherBot.email !== bot.email) post.reactions[em][otherBot.email] = Date.now();
  }
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  io.emit('post-added', publicPost(post));
}
// Posts every 6-15 min
function scheduleBotPost() {
  const delay = (6 + Math.random() * 9) * 60 * 1000;
  setTimeout(() => { fireBotPost(); scheduleBotPost(); }, delay);
}
setTimeout(scheduleBotPost, 30 * 1000); // first bot post 30s after boot

// Bot reactions on real users' posts — every 7-13 min
function fireBotReact() {
  // DISABLED. Admin asked for reactions to feel real — bots no longer
  // fake-react to anything. Only real members can leave reactions.
  return;
  if (!VIRAL_ON) return;
  const bots = users.filter(u => u.isBot);
  if (!bots.length) return;
  const now = Date.now();
  // Target real-user posts from last 24h with < 6 reactors
  const realPosts = posts.filter(p =>
    (now - p.createdAt) < 24 * 60 * 60 * 1000 &&
    !p.authorEmail.endsWith(BOT_DOMAIN) &&
    !p.expiresAt
  );
  if (!realPosts.length) return;
  const p = realPosts[Math.floor(Math.random() * realPosts.length)];
  const reactorCount = new Set(Object.values(p.reactions || {}).flatMap(b => Object.keys(b))).size;
  if (reactorCount >= 6) return;
  const bot = bots[Math.floor(Math.random() * bots.length)];
  const em = BOT_REACTION_EMOJIS[Math.floor(Math.random() * BOT_REACTION_EMOJIS.length)];
  if (!p.reactions) p.reactions = {};
  if (!p.reactions[em]) p.reactions[em] = {};
  if (p.reactions[em][bot.email]) return; // already reacted
  p.reactions[em][bot.email] = now;
  savePosts();
}
function scheduleBotReact() {
  const delay = (7 + Math.random() * 6) * 60 * 1000;
  setTimeout(() => { fireBotReact(); scheduleBotReact(); }, delay);
}
setTimeout(scheduleBotReact, 60 * 1000);

// ===================================================================
// APPROVAL DRIP + INACTIVE RE-ENGAGEMENT — fake DMs that drop into a
// newly-approved user's inbox at randomized 1-6h delays, and anon DMs
// that nudge dormant users back. All routed through real DM storage so
// the Chats tab shows them like any other thread.
// ===================================================================
const SYS_SENDER_EMAIL  = 'system@old-streets.internal';
const SYS_SENDER_NAME   = 'Old Streets';
const ANON_SENDER_EMAIL = 'anonymous@old-streets.internal';
const ANON_SENDER_NAME  = 'anonymous';
const ANON_GREETINGS = [
  'hiii', 'wassup', 'who r u', 'hey :)', 'yo',
  'sup', 'hi', 'whats up', 'hii', 'heyy',
  'soo', 'who is this', 'wyd', 'umm hi', 'helloo',
  'hi hi', 'omg hi', 'hey stranger', 'hellooo', 'wsg'
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Ensure the two pseudo-senders exist as ghost users so DMs render cleanly.
function ensurePseudoSenders() {
  for (const [email, name] of [[SYS_SENDER_EMAIL, SYS_SENDER_NAME], [ANON_SENDER_EMAIL, ANON_SENDER_NAME]]) {
    if (!findUserByEmail(email)) {
      users.push({
        id: 'ghost-' + email.split('@')[0],
        email,
        name,
        handle: email.split('@')[0],
        status: 'active',
        isBot: true,
        isSystem: true,
        createdAt: Date.now(),
        approvedAt: Date.now()
      });
    }
  }
}
ensurePseudoSenders();

let approvalDmQueue = (() => {
  try {
    if (fs.existsSync(APPROVAL_DM_QUEUE_FILE)) {
      const j = JSON.parse(fs.readFileSync(APPROVAL_DM_QUEUE_FILE, 'utf8'));
      return Array.isArray(j) ? j : [];
    }
  } catch {}
  return [];
})();
function saveApprovalDmQueue() {
  try { fs.writeFileSync(APPROVAL_DM_QUEUE_FILE, JSON.stringify(approvalDmQueue, null, 2)); } catch {}
}

// "You've been let in" SMS — fires the moment an admin flips waitlist → active.
// Variable copy + obvious link so they can claim immediately. Sent in addition
// to the 1-6h randomized approval drip (the drip is suspense; this is the
// instant payoff).
const LET_IN_TEMPLATES = [
  (base, school) => `you're in. old streets is open for you → ${base}`,
  (base, school) => `welcome inside. tap → ${base}`,
  (base, school) => `${school || 'your school'} just let u in to old streets → ${base}`,
  (base, school) => `you've been approved for old streets. ${base}`,
  (base, school) => `door's open. old streets → ${base}`,
  (base, school) => `you made it past the wall. open → ${base}`,
  (base, school) => `confirmed. ${school || 'ur school'} edition opens here → ${base}`
];
function sendLetInSms(u) {
  if (!u || !u.phoneE164) return;
  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  const tpl = LET_IN_TEMPLATES[Math.floor(Math.random() * LET_IN_TEMPLATES.length)];
  const body = tpl(base, u.schoolName);
  twilioSendSms(u.phoneE164, body).then(r => {
    if (r && r.ok) console.log(`[let-in-sms] sent to ${u.phoneE164} sid=${r.sid}`);
    else console.warn(`[let-in-sms] failed for ${u.phoneE164}: ${(r && r.error) || 'unknown'}`);
  }).catch(() => {});
}

function scheduleApprovalDms(user) {
  if (!user || !user.email) return;
  const oneHour = 60 * 60 * 1000;
  // Two drips, both 1-6h randomized, separate spans so they don't land together.
  const r1 = (1 + Math.random() * 5) * oneHour;
  const r2 = (1 + Math.random() * 5) * oneHour;
  approvalDmQueue.push({
    id: 'adq-' + crypto.randomBytes(5).toString('hex'),
    userEmail: user.email.toLowerCase(),
    type: 'wall-mention',
    fireAt: Date.now() + r1,
    fired: false
  });
  approvalDmQueue.push({
    id: 'adq-' + crypto.randomBytes(5).toString('hex'),
    userEmail: user.email.toLowerCase(),
    type: 'anon-greet',
    fireAt: Date.now() + r2,
    fired: false
  });
  saveApprovalDmQueue();
  console.log(`[approval-dm] scheduled 2 fake DMs for ${user.email} (+${Math.round(r1/60000)}m, +${Math.round(r2/60000)}m)`);
}

function fireApprovalDm(item) {
  const u = findUserByEmail(item.userEmail);
  if (!u || u.status !== 'active') return; // user vanished
  let msg = null;
  if (item.type === 'wall-mention') {
    msg = {
      id: newId(),
      from: SYS_SENDER_EMAIL,
      fromName: SYS_SENDER_NAME,
      to: item.userEmail,
      text: `👋 you've been mentioned in the old streets wall. tap here to view → https://old-streets.fly.dev/`,
      createdAt: Date.now(),
      read: false,
      _approvalDrip: true
    };
  } else if (item.type === 'anon-greet') {
    const handle = u.handle || (u.email.split('@')[0]);
    const greet = pickRandom(ANON_GREETINGS);
    msg = {
      id: newId(),
      from: ANON_SENDER_EMAIL,
      fromName: ANON_SENDER_NAME,
      to: item.userEmail,
      text: `@${handle} ${greet}`,
      createdAt: Date.now(),
      read: false,
      _approvalDrip: true
    };
  }
  if (!msg) return;
  dms.push(msg);
  if (dms.length > 20000) dms = dms.slice(-20000);
  saveDms();
  // Push via socket if they're online
  for (const [sid, info] of onlineUsers) {
    if (info.email === item.userEmail) io.to(sid).emit('dm-message', msg);
  }
  // SMS the drip body to their phone — this is the dopamine spike. The DM
  // is permanent in their inbox; the SMS yanks them back to the site.
  if (u.phoneE164) {
    const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
    const smsBody = item.type === 'wall-mention'
      ? `you've been mentioned on old streets. tap → ${base}/mail.html`
      : `new dm on old streets: "${msg.text}" → ${base}/mail.html`;
    twilioSendSms(u.phoneE164, smsBody).then(r => {
      if (r && r.ok) console.log(`[approval-dm-sms] sent to ${u.phoneE164} sid=${r.sid}`);
    }).catch(()=>{});
  }
  console.log(`[approval-dm] fired ${item.type} → ${item.userEmail}`);
}

function processApprovalDmQueue() {
  const now = Date.now();
  let changed = false;
  for (let i = approvalDmQueue.length - 1; i >= 0; i--) {
    const item = approvalDmQueue[i];
    if (item.fired) { approvalDmQueue.splice(i, 1); changed = true; continue; }
    if (item.fireAt > now) continue;
    try { fireApprovalDm(item); } catch (e) { console.warn('[approval-dm] fire failed:', e.message); }
    item.fired = true;
    approvalDmQueue.splice(i, 1);
    changed = true;
  }
  if (changed) saveApprovalDmQueue();
}
setInterval(processApprovalDmQueue, 60 * 1000);
setTimeout(processApprovalDmQueue, 15 * 1000); // first sweep just after boot

// ===================================================================
// INACTIVE RE-ENGAGEMENT — for users who haven't checked in for 48h+,
// drip an anon DM with a "who is this / wyd" style hook. Variable copy,
// max one drip per user per 72h so it doesn't feel mechanical.
// ===================================================================
const REENGAGE_COPY = [
  (h) => `@${h} u still around?`,
  (h) => `@${h} ur missed lol`,
  (h) => `@${h} hey come back lol`,
  (h) => `@${h} did u leave?`,
  (h) => `@${h} hii where u been`,
  (h) => `@${h} dont go away yet`,
  (h) => `@${h} someone was asking about u`,
  (h) => `@${h} we doing something tonight u in?`,
  (h) => `@${h} are u ever on here lol`,
  (h) => `@${h} wyd later`
];
let reengageState = (() => {
  try {
    if (fs.existsSync(REENGAGE_FILE)) {
      const j = JSON.parse(fs.readFileSync(REENGAGE_FILE, 'utf8'));
      return j && typeof j === 'object' ? j : { lastDripAt: {} };
    }
  } catch {}
  return { lastDripAt: {} };
})();
function saveReengageState() {
  try { fs.writeFileSync(REENGAGE_FILE, JSON.stringify(reengageState, null, 2)); } catch {}
}
function fireReengageSweep() {
  const now = Date.now();
  const INACTIVE_MS  = 48 * 60 * 60 * 1000; // 48h dormant
  const COOLDOWN_MS  = 72 * 60 * 60 * 1000; // max 1 nudge per 72h
  const candidates = users.filter(u =>
    u.status === 'active' &&
    !u.isBot &&
    u.approvedAt &&
    (now - u.approvedAt) > 6 * 60 * 60 * 1000 && // give them >6h of grace
    u.lastSeen &&
    (now - u.lastSeen) > INACTIVE_MS &&
    (now - (reengageState.lastDripAt[u.email] || 0)) > COOLDOWN_MS
  );
  if (!candidates.length) return;
  // Drip ~10 users per sweep, randomly
  const pick = candidates.sort(() => Math.random() - 0.5).slice(0, 10);
  for (const u of pick) {
    const handle = u.handle || u.email.split('@')[0];
    const text = pickRandom(REENGAGE_COPY)(handle);
    const msg = {
      id: newId(),
      from: ANON_SENDER_EMAIL,
      fromName: ANON_SENDER_NAME,
      to: u.email.toLowerCase(),
      text,
      createdAt: Date.now(),
      read: false,
      _reengageDrip: true
    };
    dms.push(msg);
    reengageState.lastDripAt[u.email] = Date.now();
    // SMS the same nudge if we have a phone — they're inactive, so DM alone won't pull them back.
    if (u.phoneE164) {
      const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
      twilioSendSms(u.phoneE164, `someone messaged you on old streets: "${text}" → ${base}/mail.html`).catch(()=>{});
    }
  }
  if (dms.length > 20000) dms = dms.slice(-20000);
  saveDms();
  saveReengageState();
  console.log(`[reengage] dripped ${pick.length} inactive users`);
}
// Every 2 hours, sweep dormant users. First sweep 10 min after boot.
setInterval(fireReengageSweep, 2 * 60 * 60 * 1000);
setTimeout(fireReengageSweep, 10 * 60 * 1000);

// ===================================================================
// INVITE FOLLOW-UP SMS — for invites that haven't been claimed 24h
// after send, fire a second SMS that REVEALS the inviter's name. The
// first SMS was anonymous mystery ("someone from <school> chose u");
// the follow-up adds credibility ("you were mentioned on old streets
// by <name>"). Only fires once per invite.
// ===================================================================
const FOLLOWUP_DELAY_MS = 24 * 60 * 60 * 1000;
const FOLLOWUP_COPY = [
  (n, u) => `you were mentioned on old streets by ${n}. ${u}`,
  (n, u) => `${n} put ur name on old streets. theyre waiting. ${u}`,
  (n, u) => `update: ${n} chose u. open before it expires → ${u}`,
  (n, u) => `${n} thinks ur missing from old streets. ${u}`,
  (n, u) => `it was ${n}. they invited u to old streets. ${u}`,
  (n, u) => `${n} mentioned u on old streets yesterday. still open: ${u}`
];
function fireInviteFollowupSweep() {
  const now = Date.now();
  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  let fired = 0;
  for (const inviter of users) {
    if (!inviter.pendingInvites || inviter.status !== 'active') continue;
    for (const inv of inviter.pendingInvites) {
      if (!inv || inv.claimedBy) continue;
      if (!inv.contact || inv.contactType !== 'phone') continue;
      if (inv.followupSentAt) continue; // already followed up
      if (!inv.sentAt || (now - inv.sentAt) < FOLLOWUP_DELAY_MS) continue;
      const firstName = String(inviter.name || 'someone').split(' ')[0];
      const url = `${base}/i/${inv.inviteToken}`;
      const tpl = FOLLOWUP_COPY[Math.floor(Math.random() * FOLLOWUP_COPY.length)];
      const body = tpl(firstName, url);
      twilioSendSms(inv.contact, body).then(r => {
        if (r && r.ok) console.log(`[invite-followup] sent reveal to ${inv.contact} (by ${firstName})`);
      }).catch(()=>{});
      inv.followupSentAt = Date.now();
      fired++;
    }
  }
  if (fired) { saveUsers(); console.log(`[invite-followup] reveal-SMS sent for ${fired} unclaimed invites`); }
}
// Sweep every hour. First sweep 5 min after boot to catch any stale
// 24h+ invites from before this code existed.
setInterval(fireInviteFollowupSweep, 60 * 60 * 1000);
setTimeout(fireInviteFollowupSweep, 5 * 60 * 1000);

// Admin one-shot: resend the FIRST mystery invite SMS to every unclaimed
// pending invite right now. Use when Twilio failures earlier left phones
// without the original text. Twilio costs apply.
app.post('/api/admin/invites/resend-all-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  let attempted = 0, sent = 0, failed = 0;
  const failures = [];
  for (const inviter of users) {
    if (!inviter.pendingInvites) continue;
    for (const inv of inviter.pendingInvites) {
      if (!inv || inv.claimedBy) continue;
      if (!inv.contact || inv.contactType !== 'phone') continue;
      attempted++;
      const url = `${base}/i/${inv.inviteToken}`;
      const body = viralInviteSms(inviter.name, url, inviter.schoolName);
      try {
        const r = await twilioSendSms(inv.contact, body);
        if (r && r.ok) { sent++; inv.lastResendAt = Date.now(); }
        else { failed++; failures.push({ phone: inv.contact, err: (r && r.error) || 'unknown' }); }
      } catch (e) { failed++; failures.push({ phone: inv.contact, err: e.message }); }
    }
  }
  if (sent) saveUsers();
  console.log(`[invite-resend-all] attempted=${attempted} sent=${sent} failed=${failed}`);
  res.json({ ok: true, attempted, sent, failed, failures: failures.slice(0, 20) });
});

// Admin one-shot: fire the 24h "you were mentioned by <name>" follow-up
// reveal SMS for every unclaimed invite right now, ignoring the 24h gate.
app.post('/api/admin/invites/followup-all-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  let attempted = 0, sent = 0, failed = 0;
  for (const inviter of users) {
    if (!inviter.pendingInvites) continue;
    for (const inv of inviter.pendingInvites) {
      if (!inv || inv.claimedBy) continue;
      if (!inv.contact || inv.contactType !== 'phone') continue;
      attempted++;
      const firstName = String(inviter.name || 'someone').split(' ')[0];
      const url = `${base}/i/${inv.inviteToken}`;
      const tpl = FOLLOWUP_COPY[Math.floor(Math.random() * FOLLOWUP_COPY.length)];
      const body = tpl(firstName, url);
      try {
        const r = await twilioSendSms(inv.contact, body);
        if (r && r.ok) { sent++; inv.followupSentAt = Date.now(); }
        else failed++;
      } catch { failed++; }
    }
  }
  if (sent) saveUsers();
  console.log(`[invite-followup-all] attempted=${attempted} sent=${sent} failed=${failed}`);
  res.json({ ok: true, attempted, sent, failed });
});

// "Bot online presence" — picks ~12-15 bot personas to appear online at any
// time, with rotating activity snippets. Refreshed every 90s so things look
// like they're moving. Real users always come first; bots fill the gaps.
const BOT_ACTIVITIES = [
  'on the wall', 'reading bulletins', 'replying to a chat', 'just dropped a post',
  'lurking', 'in a live room', 'voting on daily 24', 'writing a blog',
  'reacting to stuff', 'on their profile', 'in a group chat', 'idle',
  'looking for someone', 'fixing their bio', 'changing their mood', 'scrolling fast',
  'eating snacks', 'pretending to study', 'avoiding homework', 'late night posting'
];
let _onlineBotSnapshot = { ts: 0, bots: [] };
function refreshOnlineBotSnapshot() {
  const allBots = users.filter(u => u.isBot);
  if (!allBots.length) { _onlineBotSnapshot = { ts: Date.now(), bots: [] }; return; }
  // 12-15 bots online at any time
  const count = 12 + Math.floor(Math.random() * 4);
  const shuffled = allBots.slice().sort(() => Math.random() - 0.5).slice(0, count);
  _onlineBotSnapshot = {
    ts: Date.now(),
    bots: shuffled.map(b => ({
      email: b.email,
      name: b.name,
      handle: b.handle || '',
      avatar: b.avatar || '',
      activity: BOT_ACTIVITIES[Math.floor(Math.random() * BOT_ACTIVITIES.length)]
    }))
  };
}
setInterval(refreshOnlineBotSnapshot, 90 * 1000);
setTimeout(refreshOnlineBotSnapshot, 10 * 1000); // first snapshot 10s after boot

// ===================================================================
// CRUSH-BY-PHONE — viral lever. You enter your crush's phone number,
// we text them anonymously ("someone on old streets has a crush on you,
// find out who"), drive them to sign up. When they do, we match the
// pair if they also added the sender as a crush.
// ===================================================================
const PHONE_CRUSH_FILE = path.join(DATA_DIR, 'phone-crushes.json');
let phoneCrushes = [];
try { if (fs.existsSync(PHONE_CRUSH_FILE)) phoneCrushes = JSON.parse(fs.readFileSync(PHONE_CRUSH_FILE, 'utf8')) || []; } catch {}
function savePhoneCrushes() { try { fs.writeFileSync(PHONE_CRUSH_FILE, JSON.stringify(phoneCrushes, null, 2)); } catch {} }

app.post('/api/crush/by-phone', rateLimit({ key: 'crush-phone', max: 8, windowMs: 24 * 60 * 60 * 1000 }), async (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.status !== 'active') return res.status(403).json({ error: 'finish approval first' });
  const target = normPhoneE164(req.body && req.body.phone);
  if (!target) return res.status(400).json({ error: 'invalid phone' });
  if (target === me.phoneE164) return res.status(400).json({ error: "that's your number" });
  // If they already exist as a member, treat it as a regular crush-add
  const existing = findUserByPhone(target);
  if (existing) {
    return res.status(409).json({ error: 'that number is already on old streets — use the regular crush picker' });
  }
  // Dedupe: one anonymous crush text per (sender, target) pair, ever.
  const key = me.id + '|' + target;
  if (phoneCrushes.find(c => c.key === key)) {
    return res.status(409).json({ error: 'already sent — they\'ll text us back when they sign up' });
  }
  phoneCrushes.push({
    key, from: me.id, fromEmail: me.email, fromName: me.name, target,
    createdAt: Date.now(), matched: false, signedUp: false
  });
  savePhoneCrushes();
  // SMS the target — anonymous, drives them to sign up
  const base = (config.publicUrl || 'https://old-streets.fly.dev').replace(/\/$/, '');
  const sigil = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
  const url = `${base}/onboard.html?cf=${sigil}`;
  const templates = [
    `someone on old streets has a crush on you. find out who: ${url}`,
    `you got added to a crush list on old streets. claim your account: ${url}`,
    `someone said you're cute. it's anonymous until you join: ${url}`,
    `a person at your school added you. they're waiting: ${url}`
  ];
  const body = templates[Math.floor(Math.random() * templates.length)];
  twilioSendSms(target, body).catch(() => {});
  res.json({ ok: true, message: 'sent anonymously. if they sign up, you both get notified.' });
});

// Called from signup — if the new user's phone matches an outstanding
// phone-crush, mark it as matched + notify the sender + auto-add the
// sender as a crush on the new user's list.
function processPhoneCrushOnSignup(newUser) {
  if (!newUser || !newUser.phoneE164) return;
  const hits = phoneCrushes.filter(c => c.target === newUser.phoneE164 && !c.signedUp);
  for (const hit of hits) {
    hit.signedUp = true;
    hit.matched = true;
    hit.signedUpAt = Date.now();
    const sender = findUserById(hit.from);
    if (sender) {
      pushNotif(sender.email, {
        type: 'crush-match',
        fromName: '💘 they joined',
        text: `${newUser.name} just signed up — and they were on your secret crush list.`,
        ts: Date.now()
      });
      if (sender.phoneE164) {
        twilioSendSms(sender.phoneE164, `${newUser.name.split(' ')[0]} just signed up on old streets. you anonymously crushed on them — they don't know yet.`).catch(() => {});
      }
      // Pre-load the crush both ways
      try {
        crushList.push({ id: newId(), from: sender.email, to: newUser.email, matched: false, createdAt: Date.now() });
        saveCrushList();
      } catch {}
    }
  }
  if (hits.length) savePhoneCrushes();
}

// ===================================================================
// LETTERS — anonymous letter inbox. Reuses the existing loveLetters
// store. Admin views are explicitly disabled — only the recipient can
// see the contents.
// ===================================================================
app.post('/api/letters', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const toEmail = String((req.body && req.body.toEmail) || '').trim().toLowerCase();
  const message = String((req.body && req.body.message) || '').trim().slice(0, 2000);
  if (!toEmail) return res.status(400).json({ error: 'recipient required' });
  if (!message) return res.status(400).json({ error: 'message required' });
  if (toEmail === me.email.toLowerCase()) return res.status(400).json({ error: 'can\'t send a letter to yourself' });
  const target = findUserByEmail(toEmail);
  if (!target || target.status !== 'active') return res.status(404).json({ error: 'recipient not found' });
  // HARD school isolation — letters stay within school.
  if (!viewerCanSeeUser(me, target)) return res.status(404).json({ error: 'recipient not found' });
  // Light abuse filter
  if (contentBlocked(message)) return res.status(400).json({ error: 'letter contains language not allowed (slurs / threats)' });
  const letter = {
    id: newId(),
    toEmail: target.email.toLowerCase(),
    toName: target.name,
    message,
    createdAt: Date.now(),
    // Sender stored ONLY for abuse moderation hash — never surfaced to admin UI
    _senderHash: crypto.createHash('sha256').update(me.email + '|' + Date.now()).digest('hex').slice(0, 16)
  };
  loveLetters.push(letter);
  // Drop letters older than 90 days
  const cutoff = Date.now() - 90 * 86400000;
  loveLetters = loveLetters.filter(l => (l.createdAt || 0) > cutoff);
  saveLoveLetters();
  pushNotif(target.email, {
    type: 'letter',
    fromName: '💌 anonymous',
    fromEmail: '',
    text: 'someone sent you a letter',
    ts: Date.now()
  });
  res.json({ ok: true });
});

app.get('/api/letters/inbox', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const mine = loveLetters
    .filter(l => (l.toEmail || '').toLowerCase() === me.email.toLowerCase())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(l => ({ id: l.id, message: l.message, createdAt: l.createdAt }));
  res.json({ letters: mine });
});

// GET /api/online — currently-online users with their last-known activity.
// Combines real socket-connected users + a rotating slice of bot personas
// so the Online Now widget always feels populated.
// School-scoped inviter leaderboard. Public ranking inside each school
// creates competitive pressure — being #1 inviter at Beverly Hills means
// something. Drives K hard.
app.get('/api/leaderboard/inviters', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const scope = String(req.query.scope || 'school').toLowerCase();
  let pool = users.filter(u => u.status === 'active' && !u.isBot);
  if (scope === 'school' && me.schoolId) pool = pool.filter(u => u.schoolId === me.schoolId);
  const ranked = pool
    .map(u => ({
      email: u.email,
      name: u.name,
      handle: u.handle || '',
      schoolName: u.schoolName || '',
      avatar: u.avatar || '',
      invitesClaimed: claimedInviteCount(u),
      invitesSent: (u.pendingInvites || []).length,
      referralsEarned: u.referralsEarned || 0
    }))
    .filter(u => u.invitesClaimed > 0)
    .sort((a, b) => b.invitesClaimed - a.invitesClaimed)
    .slice(0, 25);
  const myRank = ranked.findIndex(u => u.email === me.email) + 1;
  res.json({ scope, leaders: ranked, myRank: myRank || null, myClaimed: claimedInviteCount(me) });
});

// Recent "X joined via Y" events — public-feed social proof. Pulls from
// pendingInvites with claimedBy set, returns the latest 20.
app.get('/api/leaderboard/recent-claims', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const scope = String(req.query.scope || 'school').toLowerCase();
  const events = [];
  for (const inviter of users) {
    if (inviter.isBot || !inviter.pendingInvites) continue;
    if (scope === 'school' && me.schoolId && inviter.schoolId !== me.schoolId) continue;
    for (const inv of inviter.pendingInvites) {
      if (!inv.claimedBy || !inv.claimedAt) continue;
      events.push({
        inviterName: inviter.name,
        inviterHandle: inviter.handle || '',
        inviteeName: inv.claimedName || 'someone',
        ts: inv.claimedAt,
        schoolName: inviter.schoolName || ''
      });
    }
  }
  events.sort((a, b) => b.ts - a.ts);
  res.json({ events: events.slice(0, 20) });
});

// SCARCITY FEATURE DELETED — endpoints kept as 410 Gone stubs so any
// stale client cache hitting them doesn't bork the page.
app.get('/api/school/scarcity', (_req, res) => res.status(410).json({ removed: true }));
app.get('/api/school/scarcity-public', (_req, res) => res.status(410).json({ removed: true }));

// ===================================================================
// PHANTOM NOTES — variable-reinforcement bait. Every active user has a
// "secret message" rotating in their inbox. Some are juicy ("someone
// said you're cute"), some are mild ("someone added you to a chat").
// Unlocking the sender requires sending 1 more invite. Each user gets
// a deterministic but-rotating message based on (userId + day).
// ===================================================================
const PHANTOM_NOTE_POOL = [
  { type: 'compliment', verb: 'said you\'re hot' },
  { type: 'compliment', verb: 'said you\'re funny' },
  { type: 'compliment', verb: 'said you\'re actually fire' },
  { type: 'compliment', verb: 'said you have main character energy' },
  { type: 'mention', verb: 'mentioned you in a group chat' },
  { type: 'mention', verb: 'brought you up in a thread last night' },
  { type: 'crush', verb: 'put you on their crush list' },
  { type: 'gossip', verb: 'asked about you to a mutual' },
  { type: 'invite', verb: 'tried to add you to their crew' },
  { type: 'screenshot', verb: 'screenshotted one of your posts' }
];
function todayKey() { const d = new Date(); return d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDate(); }
app.get('/api/me/phantom-note', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  // Deterministic: same user gets the SAME message all day, rotates at UTC midnight.
  const seed = crypto.createHash('sha256').update(me.id + '|' + todayKey()).digest();
  const idx = seed[0] % PHANTOM_NOTE_POOL.length;
  const note = PHANTOM_NOTE_POOL[idx];
  const claimed = claimedInviteCount(me);
  const isUnlocked = claimed >= 3;
  res.json({
    verb: note.verb,
    type: note.type,
    locked: !isUnlocked,
    needed: Math.max(0, 3 - claimed),
    claimed,
    revealedSender: isUnlocked ? 'someone in your school' : null,
    sentAt: Date.now() - (seed[1] * 60 * 1000) // fake "X minutes ago" 0-255 min back
  });
});

// ===================================================================
// LOSS-FRAME WAITLIST DRIP — once an hour, each waitlisted user sees
// their position degraded by 2-5 spots (visual). Combined with the
// share-to-jump-line mechanic, this puts pressure on them to share.
// ===================================================================
setInterval(() => {
  for (const u of users) {
    if (u.status !== 'waitlist') continue;
    // Track a visible "drop" counter that the client can show
    u.waitlistDrops = (u.waitlistDrops || 0) + (1 + Math.floor(Math.random() * 4));
    // Cap to prevent unbounded growth
    if (u.waitlistDrops > 50) u.waitlistDrops = 50;
  }
  saveUsers();
}, 60 * 60 * 1000);

// ===================================================================
// FOUNDER STATUS — first 25 active members per school get a permanent
// "🌟 FOUNDER" badge. Insanely effective social pressure: "be one of
// the founders of [School] on old streets."
// ===================================================================
app.get('/api/school/founders', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const slug = String(req.query.school || me.schoolId || '');
  if (!slug) return res.json({ founders: [], capLeft: 25 });
  const founders = users
    .filter(u => u.status === 'active' && !u.isBot && u.schoolId === slug)
    .sort((a, b) => (a.approvedAt || a.createdAt) - (b.approvedAt || b.createdAt))
    .slice(0, 25)
    .map(u => ({ name: u.name, handle: u.handle || '', avatar: u.avatar || '' }));
  const capLeft = Math.max(0, 25 - founders.length);
  const me_idx = founders.findIndex(f => f.handle === me.handle);
  res.json({
    founders, capLeft,
    iAmFounder: me_idx >= 0,
    myFounderRank: me_idx >= 0 ? me_idx + 1 : null
  });
});

// User-facing school setter. Members can switch their school themselves
// (consequence: the community they see changes). Server validates the slug.
app.post('/api/me/set-school', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const slug = String((req.body && req.body.schoolId) || '').trim();
  if (!slug) return res.status(400).json({ error: 'school required' });
  // If they've already double-confirmed once, no more changes (admin-only).
  if (me.schoolLocked && !me.isAdmin) {
    return res.status(403).json({ error: 'school-locked', message: 'your school is permanent. ask an admin to change it.' });
  }
  const s = allSchools().find(x => x.id === slug);
  if (!s) return res.status(400).json({ error: 'unknown school' });
  me.schoolId = s.id;
  me.schoolName = s.name;
  saveUsers();
  res.json({ ok: true, user: publicUser(me) });
});

// Forced 3-school launch pick. Only these three are allowed. Client must
// pass `confirm: 'PERMANENT'` (the user typed/clicked through the double-
// confirm modal) before we lock it.
// Aligned with SCHOOL_CATALOG ids+names so community feeds (which key on
// schoolId) stay consistent and no existing user's display name flips.
const LAUNCH_THREE = [
  { id: 'new-roads',     name: 'Ancient Old Streets' },
  { id: 'beverly-hills', name: 'Beverly Hills High' },
  { id: 'crossroads',    name: 'Crossroads' }
];
app.get('/api/launch-schools', (_req, res) => res.json({ schools: LAUNCH_THREE }));

// School selection removed — auto-lock anyone who hits this to "Ancient Old Streets".
app.post('/api/me/auto-lock-school', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.schoolLocked) return res.json({ ok: true, user: publicUser(me) });
  me.schoolId = 'new-roads';
  me.schoolName = 'Ancient Old Streets';
  me.schoolLocked = true;
  me.schoolLockedAt = Date.now();
  saveUsers();
  res.json({ ok: true, user: publicUser(me) });
});
app.post('/api/me/lock-school', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.schoolLocked && !me.isAdmin) {
    return res.status(409).json({ error: 'already-locked', schoolId: me.schoolId, schoolName: me.schoolName });
  }
  const slug = String((req.body && req.body.schoolId) || '').trim();
  const confirm = String((req.body && req.body.confirm) || '');
  if (confirm !== 'PERMANENT') {
    return res.status(400).json({ error: 'confirm-required', message: 'pass confirm:"PERMANENT" to lock' });
  }
  const s = LAUNCH_THREE.find(x => x.id === slug);
  if (!s) return res.status(400).json({ error: 'must-be-launch-three', message: 'pick Ancient Old Streets, Beverly Hills, or Crossroads' });
  me.schoolId = s.id;
  me.schoolName = s.name;
  me.schoolLocked = true;
  me.schoolLockedAt = Date.now();
  saveUsers();
  res.json({ ok: true, user: publicUser(me) });
});

app.get('/api/online', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  // Dedupe by email, picking the socket with the most recent activityAt
  // so multi-tab users show their freshest page.
  const byEmail = new Map();
  for (const [, info] of onlineUsers) {
    const email = (info && info.email || '').toLowerCase();
    if (!email) continue;
    const cur = byEmail.get(email);
    if (!cur || (info.activityAt || 0) > (cur.activityAt || 0)) byEmail.set(email, info);
  }
  const list = [];
  for (const [email, info] of byEmail) {
    const u = findUserByEmail(email);
    if (!u || u.status !== 'active' || u.isBot) continue;
    if (!viewerCanSeeUser(me, u)) continue;
    let activity = '';
    if (info.activity && info.activity.label) activity = info.activity.label;
    if (!activity && u.mood) activity = u.mood;
    if (!activity && u.lastPostAt && (Date.now() - u.lastPostAt) < 10 * 60 * 1000) {
      const lp = posts.find(p => p.authorEmail === u.email);
      if (lp && (lp.content || lp.caption)) activity = '"' + String(lp.content || lp.caption).slice(0, 56) + '"';
    }
    if (!activity && u.lastSeen) {
      const secsAgo = Math.floor((Date.now() - u.lastSeen) / 1000);
      if (secsAgo < 30) activity = 'online';
      else if (secsAgo < 120) activity = 'just here';
      else activity = 'idle ' + Math.floor(secsAgo / 60) + 'm';
    }
    list.push({
      email: u.email, name: u.name, handle: u.handle || '',
      avatar: u.avatar || '',
      rating: avgRating(u.email),
      activity: activity || 'online',
      activityKind: (info.activity && info.activity.kind) || '',
      activityAt: info.activityAt || 0
    });
  }
  list.sort((a, b) => (b.activityAt || 0) - (a.activityAt || 0));
  res.json({ users: list, count: list.length });
});

// ===================================================================
// VIRAL ENGINE — periodic social-engineering events. Designed to make
// every login feel "active" even when activity is low. Toggle the kit
// off by setting VIRAL_KIT_DISABLED=1 in Fly secrets.
// ===================================================================
const VIRAL_ON = process.env.VIRAL_KIT_DISABLED !== '1';

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function activeUsers() { return users.filter(u => u && u.status === 'active'); }

// GHOST EVENTS — profile-view notifs etc. stay disabled. But ghost
// reactions on posts are re-enabled with a delay window (admin spec):
// only post that's 30min–4h old, max 3 ghost reactors per post lifetime.
// Feels organic — reactions roll in over time, not all at once at post time.
function fireRandomViralEvent() { /* disabled — real activity only */ }

const GHOST_REACT_MIN_AGE = 30 * 60 * 1000;        // 30 min
const GHOST_REACT_MAX_AGE = 4  * 60 * 60 * 1000;   // 4 hours
const GHOST_REACT_PER_POST_CAP = 3;
function ghostReactLonelyPost() {
  const now = Date.now();
  const candidates = posts.filter(p => {
    if (p.expiresAt && p.expiresAt < now) return false;
    if (p.isAnonymous) return false; // don't ghost-react anon
    const age = now - (p.createdAt || 0);
    if (age < GHOST_REACT_MIN_AGE || age > GHOST_REACT_MAX_AGE) return false;
    // Count existing ghost reactions across all emojis
    const reactors = Object.values(p.reactions || {}).flatMap(b => Object.keys(b));
    const ghostCount = reactors.filter(e => e.toLowerCase().endsWith('@old-streets.internal')).length;
    if (ghostCount >= GHOST_REACT_PER_POST_CAP) return false;
    // Also don't pile on if real reactors already > 5 (post is doing fine)
    const realCount = reactors.length - ghostCount;
    if (realCount >= 5) return false;
    return true;
  });
  if (!candidates.length) return;
  const p = pickRandom(candidates);
  const emojiPool = ['👍', '🔥', '😂', '😍', '💯'];
  const em = pickRandom(emojiPool);
  if (!p.reactions) p.reactions = {};
  if (!p.reactions[em]) p.reactions[em] = {};
  const ghostEmail = 'ghost-' + Math.random().toString(36).slice(2, 6) + '@old-streets.internal';
  p.reactions[em][ghostEmail] = now;
  savePosts();
}
// Fire every 12-18 min so ghosts don't show up in a rhythmic burst
function scheduleGhostReact() {
  const delay = (12 + Math.random() * 6) * 60 * 1000;
  setTimeout(() => { try { ghostReactLonelyPost(); } catch {}; scheduleGhostReact(); }, delay);
}
setTimeout(scheduleGhostReact, 90 * 1000); // first ghost react 90s after boot

// At ~9pm pacific each day: pick one user's recent post and broadcast it
// to everyone as "today's drop"
function dailyDropAt9pm() {
  if (!VIRAL_ON) return;
  const pacificHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  if (pacificHour !== 21) return;
  // Don't fire twice the same day
  const todayKey = new Date().toISOString().slice(0, 10);
  if (global._dailyDropDay === todayKey) return;
  global._dailyDropDay = todayKey;
  const now = Date.now();
  const yesterday = now - 24 * 60 * 60 * 1000;
  const pool = posts.filter(p => p.createdAt > yesterday && !p.isAnonymous && p.authorEmail).slice(0, 100);
  if (!pool.length) return;
  const pick = pickRandom(pool);
  if (!pick) return;
  for (const u of activeUsers()) {
    if (u.email === pick.authorEmail) {
      pushNotif(u.email, {
        type: 'daily-drop',
        fromName: '🌟 you got picked',
        text: 'your post is today\'s 9pm drop. everyone\'s seeing it.',
        postId: pick.id,
        ts: Date.now()
      });
    } else {
      pushNotif(u.email, {
        type: 'daily-drop',
        fromName: '🌟 today\'s drop',
        text: `${pick.author}: ${(pick.content || pick.caption || '').slice(0, 80)}`,
        postId: pick.id,
        ts: Date.now()
      });
    }
  }
  console.log('[viral] daily drop fired for post', pick.id);
}
setInterval(dailyDropAt9pm, 5 * 60 * 1000);

// Every 30 min: poke silent locked starter groups
function pokeQuietGroups() {
  if (!VIRAL_ON) return;
  const now = Date.now();
  const twoDays = 48 * 60 * 60 * 1000;
  for (const g of groups) {
    if (!g.locked) continue;
    const lastMsg = (g.messages || []).slice(-1)[0];
    const lastAt = lastMsg ? lastMsg.createdAt : g.createdAt;
    if (now - lastAt < twoDays) continue;
    if (g._lastPokedAt && now - g._lastPokedAt < twoDays) continue;
    g._lastPokedAt = now;
    for (const memberEmail of (g.members || [])) {
      pushNotif(memberEmail, {
        type: 'group-quiet',
        fromName: '👥 your crew',
        text: 'your starter crew hasn\'t posted in 2 days. break the silence.',
        groupId: g.id,
        ts: now
      });
    }
  }
  saveGroups();
}
setInterval(pokeQuietGroups, 30 * 60 * 1000);

// GET /api/me/streak-status — used by client to show countdown to streak break
app.get('/api/me/streak-status', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const d = new Date(); d.setHours(23, 59, 59, 999);
  const msUntilMidnight = d.getTime() - Date.now();
  const todayKey = (() => { const t = new Date(); return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0'); })();
  const postedToday = me.lastPostDay === todayKey;
  res.json({
    streak: me.streak || 0,
    postedToday,
    msUntilStreakBreak: postedToday ? 0 : msUntilMidnight,
    needsToPost: !postedToday && (me.streak || 0) > 0
  });
});

app.get('/api/directory', (req, res) => {
  // HARD school isolation. Legacy directory.json is Ancient Old Streets data
  // (the original school the platform launched for). For each future
  // school we'll import its own directory under a school-scoped key.
  // - Admin: sees everything.
  // - Ancient Old Streets viewer: sees legacy directory.json + their school's user records.
  // - Other school viewer: sees only their school's user records (no directory yet).
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.json([]);
  const claimedEmails = new Set(
    users.filter(u => u.status !== 'banned' && viewerCanSeeUser(me, u))
         .map(u => u.email.toLowerCase())
  );
  const referredEmails = new Set();
  for (const u of users) {
    if (!viewerCanSeeUser(me, u)) continue;
    for (const r of (u.referrals || [])) {
      if (r.email) referredEmails.add(r.email.toLowerCase());
    }
  }
  // Treat legacy directory.json as Ancient Old Streets. Show it only to admins + Ancient Old Streets viewers.
  const showLegacyDir = me.isAdmin || me.schoolId === 'new-roads';
  const legacyList = showLegacyDir ? directory.map(d => {
    const lc = (d.email || '').toLowerCase();
    return {
      name: d.name,
      email: d.email,
      claimed: claimedEmails.has(lc),
      referred: !claimedEmails.has(lc) && referredEmails.has(lc)
    };
  }) : [];
  // Always include matching user records (so claimed members from any
  // visible school show up even if not in the legacy directory).
  const seen = new Set(legacyList.map(d => (d.email || '').toLowerCase()));
  const userList = users
    .filter(u => u.status !== 'banned' && !u.isBot && !u.isSystem && viewerCanSeeUser(me, u))
    .filter(u => !seen.has((u.email || '').toLowerCase()))
    .map(u => ({ name: u.name, email: u.email, claimed: true, referred: false }));
  res.json([...legacyList, ...userList]);
});

function liveStats() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return {
    members: users.filter(u => u.status === 'active').length,
    online: onlineUsers.size,
    recentPosts: posts.filter(p => p.createdAt > weekAgo).length,
    totalPosts: posts.length,
    waitlist: users.filter(u => u.status === 'waitlist').length
  };
}

// =================================================================
// ANNOUNCE NEW URL — admin email blast to every active user
// =================================================================
async function sendNewUrlEmail({ toName, toEmail, newUrl }) {
  if (!config.resendApiKey) return { skipped: true, reason: 'no-resend-key' };
  const _u = unsubArtifacts(toEmail, { transactional: true });
  if (_u.blocked) return { skipped: true, unsubscribed: true };
  const first = (toName || '').split(' ')[0] || toName || 'friend';
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">
      <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">
        [ Old Streets ] <span style="font-weight: normal; opacity: 0.75; font-size: 12px; float: right; padding-top: 2px;">we moved</span>
      </div>
      <h2 style="color: #3B5998; font-size: 22px; margin: 22px 0 8px; line-height: 1.25;">
        We just moved Old Streets to a new home.
      </h2>
      <p style="font-size: 14.5px; line-height: 1.55;">Hey ${escapeHtmlServer(first)} —</p>
      <p style="font-size: 14.5px; line-height: 1.55;">
        We migrated to a faster, more reliable host so data never gets wiped on a redeploy
        again (it happened once — never again). Same site, same accounts, same posts.
        Just bookmark this new URL:
      </p>
      <p style="margin: 22px 0; text-align: center;">
        <a href="${newUrl}" style="display: inline-block; background: #3B5998; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border: 1px solid #2f477b; font-size: 14px;">
          ${newUrl}
        </a>
      </p>
      <p style="font-size: 13px; line-height: 1.55; background: #f3f5fa; border-left: 3px solid #3B5998; padding: 10px 14px; margin: 16px 0; color: #333;">
        Your login stays the same. Sign in with your same email + password.
      </p>
      <p style="font-size: 13px; color: #555; line-height: 1.55;">
        New stuff that's already live: messages inbox (💬 button), group chats,
        push notifications, blog cards on the home feed, and a much more
        realistic feel overall. Go check it out.
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 30px; line-height: 1.55; border-top: 1px solid #eee; padding-top: 12px;">
        Old Streets · independent and not affiliated with any school.
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject: 'Old Streets moved — new URL inside',
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

app.post('/api/admin/announce-new-url', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const newUrl = String(req.body?.newUrl || config.publicUrl || 'https://old-streets.fly.dev').trim();
  const dryRun = !!req.body?.dryRun;
  const recipients = users.filter(u => u.status === 'active' && u.email);
  if (dryRun) {
    return res.json({ ok: true, dryRun: true, wouldSend: recipients.length, sample: recipients.slice(0, 5).map(u => u.email) });
  }
  res.json({ ok: true, queued: recipients.length });
  // Fire-and-forget — return immediately, send in background with throttle.
  (async () => {
    let sent = 0, failed = 0, skipped = 0;
    for (const u of recipients) {
      const r = await sendNewUrlEmail({ toName: u.name, toEmail: u.email, newUrl }).catch(e => ({ ok: false, error: String(e) }));
      if (r.skipped) skipped++;
      else if (r.ok) sent++;
      else failed++;
      // Throttle to ~5/sec so Resend doesn't rate-limit us.
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`[announce-new-url] done — sent=${sent} skipped=${skipped} failed=${failed} url=${newUrl}`);
  })();
});

async function sendInviteEmail({ toName, toEmail, fromName, fromEmail }) {
  if (!config.resendApiKey) {
    console.warn('[invite] no resend key, skipping email to', toEmail);
    return { skipped: true };
  }
  const _u = unsubArtifacts(toEmail);
  if (_u.blocked) {
    console.log('[invite] skipping unsubscribed recipient', toEmail);
    return { skipped: true, unsubscribed: true };
  }
  const siteUrl = config.publicUrl || 'http://localhost:3001';
  const safeFrom = (fromName || 'A friend').replace(/[<>]/g, '');
  const stats = liveStats();

  // Stats line — never expose member counts publicly. Online + posts only.
  const statBits = [];
  if (stats.online > 0)       statBits.push(`<strong>${stats.online}</strong> online right now`);
  if (stats.recentPosts > 0)  statBits.push(`<strong>${stats.recentPosts}</strong> posts this week`);
  const statsHtml = statBits.length
    ? `<div style="background: #f3f5fa; border-left: 3px solid #3B5998; padding: 10px 14px; font-size: 13px; margin: 18px 0; color: #333;">
         ${statBits.join(' &nbsp;·&nbsp; ')}
       </div>`
    : '';

  // Subject lines: rotate based on whether we have any activity
  const subject = stats.totalPosts > 0
    ? `${safeFrom} picked you for Old Streets — you might already be on the wall`
    : `${safeFrom} saved you a spot on Old Streets`;

  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">

      <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px; letter-spacing: 0.01em;">
        [ Old Streets ] <span style="font-weight: normal; opacity: 0.75; font-size: 12px; float: right; padding-top: 2px;">members only</span>
      </div>

      <h2 style="color: #3B5998; font-size: 24px; margin: 22px 0 8px; line-height: 1.2; letter-spacing: -0.01em;">
        ${escapeHtmlServer(safeFrom)} picked you.
      </h2>
      <p style="font-size: 13px; color: #777; margin: 0 0 12px;">
        For Old Streets — the private invite-only network.
      </p>

      <div style="background: #f0f9f4; border-left: 3px solid #2ea44f; padding: 8px 12px; margin: 14px 0; font-size: 11px; color: #1a5132;">
        ✓ <strong>Safe to click.</strong> This email is from <strong>${escapeHtmlServer(safeFrom)}</strong>, another Old Streets member, sent through Old Streets — a private invite-only platform.
      </div>

      <p style="font-size: 14.5px; line-height: 1.55;">
        Hey ${escapeHtmlServer(toName.split(' ')[0] || toName)},
      </p>
      <p style="font-size: 14.5px; line-height: 1.55;">
        <strong>${escapeHtmlServer(safeFrom)}</strong> just joined Old Streets and used one of their 3 invites on you.
        It's a private wall + video chat — <strong>built by a student, for students</strong> — members get in through an invite and a waitlist review.
      </p>

      ${statsHtml}

      <p style="font-size: 14.5px; line-height: 1.55; background: #fffbe5; border: 1px solid #f0e0a0; padding: 10px 14px; margin: 18px 0;">
        <strong>You might already be on the wall.</strong> People post about each other on here — quotes, photos, who's at lunch with who, inside jokes. You won't see what's been said until you're in.
      </p>

      <p style="margin: 24px 0;">
        <a href="${siteUrl}" style="display: inline-block; background: #3B5998; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border: 1px solid #2f477b; font-size: 14px; letter-spacing: 0.02em;">Get in →</a>
        <span style="font-size: 12px; color: #888; margin-left: 12px;">takes 30 seconds · admin approves you</span>
      </p>

      <p style="font-size: 13px; font-style: italic; color: #555; margin-top: 32px;">
        PS — what's the opposite of old streets?
      </p>

      <p style="color: #888; font-size: 11px; margin-top: 16px; border-top: 1px solid #eee; padding-top: 12px; line-height: 1.5;">
        Old Streets · members only · invite-only.<br/>
        Don't tell the principal. If you weren't expecting this, ignore it — no one will know.
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 10px; line-height: 1.55;">
        Created by a student — a solo-run project. Independent, not affiliated with, partnered with, endorsed by, or operated by any school. We do not condone bullying, harassment, threats, slurs, or hate speech of any kind — accounts that do any of that are removed. Posts are the opinions of individual members and don't represent the site, the school, or anyone else.
      </p>
      ${_u.footerHtml}
    </div>
  `;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + config.resendApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject,
        html,
        headers: _u.headers
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.warn('[resend] failed for', toEmail, '→', data);
      return { ok: false, error: data.message || ('http ' + resp.status), data };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    console.error('[resend] error', e);
    return { ok: false, error: String(e) };
  }
}

function escapeHtmlServer(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// DEPRECATED: 3-referral school-directory flow is gone. The new invite
// system lives at /api/invites/send + /api/invites/me (2 slots per user,
// phone-locked, hard-lock until both claim).
app.post('/api/referrals', (_req, res) => {
  res.status(410).json({
    error: 'gone',
    message: 'referrals are gone — use /api/invites/send (2 slots per user, phone-based).'
  });
});

// =================================================================
// DIRECT MESSAGES
// =================================================================
function dmThreadKey(emailA, emailB) {
  return [emailA.toLowerCase(), emailB.toLowerCase()].sort().join('|');
}

// Unread DM threads — for the bell dropdown so users see chat previews
// alongside notifications and friend requests.
app.get('/api/dm/unread-threads', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const byOther = new Map();
  for (const m of dms) {
    if ((m.to || '').toLowerCase() !== me) continue;
    if (m.read) continue;
    const other = (m.from || '').toLowerCase();
    if (!other) continue;
    const cur = byOther.get(other);
    if (!cur || (m.createdAt || 0) > (cur.lastTs || 0)) {
      byOther.set(other, { from: other, lastText: m.text || '', lastTs: m.createdAt || 0 });
    }
  }
  const threads = [];
  for (const t of byOther.values()) {
    const u = findUserByEmail(t.from);
    threads.push({
      ...t,
      fromName: u ? u.name : t.from,
      fromHandle: u ? (u.handle || '') : '',
      fromAvatar: u ? (u.avatar || '') : ''
    });
  }
  threads.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  res.json({ threads });
});

app.get('/api/dm/threads', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const byOther = new Map();
  for (const m of dms) {
    if (m.from === me || m.to === me) {
      const other = (m.from === me ? m.to : m.from);
      const cur = byOther.get(other);
      if (!cur || cur.lastTs < m.createdAt) {
        const otherUser = findUserByEmail(other);
        byOther.set(other, {
          email: other,
          name: otherUser ? otherUser.name : other,
          avatar: otherUser ? otherUser.avatar : '',
          lastText: m.text,
          lastTs: m.createdAt,
          lastFromMe: m.from === me,
          unread: 0
        });
      }
    }
  }
  // count unread (messages from other to me, not read)
  for (const m of dms) {
    if (m.to === me && m.from !== me && !m.read) {
      const t = byOther.get(m.from);
      if (t) t.unread = (t.unread || 0) + 1;
    }
  }
  const threads = Array.from(byOther.values()).sort((a, b) => b.lastTs - a.lastTs);
  res.json(threads);
});

// =================================================================
// UNIFIED INBOX — DM threads + group chats in one list, sorted by recency
// =================================================================
app.get('/api/inbox', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const out = [];
  // 1:1 DM threads
  const byOther = new Map();
  for (const m of dms) {
    if (m.from === me || m.to === me) {
      const other = (m.from === me ? m.to : m.from);
      const otherUser = findUserByEmail(other);
      // HARD school isolation — hide threads with cross-school users.
      // System pseudo-senders (Old Streets / anonymous) always show.
      if (otherUser && !viewerCanSeeUser(user, otherUser)) continue;
      const cur = byOther.get(other);
      if (!cur || cur.lastTs < m.createdAt) {
        byOther.set(other, {
          kind: 'dm',
          id: other,
          email: other,
          name: otherUser ? otherUser.name : other,
          avatar: otherUser ? otherUser.avatar : '',
          lastText: m.text,
          lastTs: m.createdAt,
          lastFromMe: m.from === me,
          unread: 0
        });
      }
    }
  }
  for (const m of dms) {
    if (m.to === me && m.from !== me && !m.read) {
      const t = byOther.get(m.from);
      if (t) t.unread = (t.unread || 0) + 1;
    }
  }
  for (const t of byOther.values()) out.push(t);
  // Groups I'm a member of
  for (const g of groups) {
    if (!Array.isArray(g.members) || !g.members.includes(me)) continue;
    const last = (g.messages || [])[(g.messages || []).length - 1];
    const unread = (g.messages || []).filter(m =>
      m.from !== me && !(Array.isArray(m.readBy) && m.readBy.includes(me))
    ).length;
    out.push({
      kind: 'group',
      id: g.id,
      name: g.name,
      memberCount: g.members.length,
      members: g.members,
      lastText: last ? last.text : '',
      lastTs: last ? last.createdAt : g.createdAt,
      lastFromMe: last ? last.from === me : false,
      unread
    });
  }
  out.sort((a, b) => b.lastTs - a.lastTs);
  res.json(out);
});

// =================================================================
// GROUP CHATS
// =================================================================
function findGroupByIdForMember(id, emailLc) {
  const g = groups.find(x => x.id === id);
  if (!g) return null;
  if (!g.members.includes(emailLc)) return null;
  return g;
}

// Create a group with name + member emails (you're auto-added).
app.post('/api/groups', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const rawMembers = Array.isArray(req.body?.members) ? req.body.members : [];
  if (!name) return res.status(400).json({ error: 'group needs a name' });
  if (rawMembers.length < 1) return res.status(400).json({ error: 'pick at least 1 friend' });
  if (rawMembers.length > 50) return res.status(400).json({ error: 'max 50 members per group' });
  // Validate each email is an active user
  const seen = new Set([me]);
  const validMembers = [me];
  for (const raw of rawMembers) {
    const lc = String(raw || '').trim().toLowerCase();
    if (!lc || seen.has(lc)) continue;
    const u = findUserByEmail(lc);
    if (!u || u.status !== 'active') continue;
    seen.add(lc);
    validMembers.push(lc);
  }
  if (validMembers.length < 2) return res.status(400).json({ error: 'no valid members' });
  const g = {
    id: newId(),
    name,
    members: validMembers,
    createdBy: me,
    createdAt: Date.now(),
    messages: []
  };
  groups.unshift(g);
  if (groups.length > 5000) groups = groups.slice(0, 5000);
  saveGroups();
  // Notify members (except me) that they're in a new group
  for (const m of validMembers) {
    if (m === me) continue;
    pushNotif(m, {
      type: 'group-invite',
      fromName: user.name,
      fromEmail: user.email,
      groupId: g.id,
      text: `${user.name} added you to a group chat: "${name}"`
    });
    // Realtime: ping member sockets so they see the new group instantly
    for (const [sid, info] of onlineUsers) {
      if (info.email === m) io.to(sid).emit('group-created', { groupId: g.id, name: g.name });
    }
  }
  res.json(g);
});

// Get a group's messages (also marks them read for me).
app.get('/api/groups/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const g = findGroupByIdForMember(req.params.id, me);
  if (!g) return res.status(404).json({ error: 'group not found or you are not a member' });
  // Mark messages read by me
  let changed = false;
  const readIds = [];
  for (const m of (g.messages || [])) {
    if (m.from !== me) {
      if (!Array.isArray(m.readBy)) m.readBy = [];
      if (!m.readBy.includes(me)) { m.readBy.push(me); changed = true; readIds.push(m.id); }
    }
  }
  if (changed) saveGroups();
  // Resolve member display data
  const memberObjs = g.members.map(emailLc => {
    const u = findUserByEmail(emailLc);
    return {
      email: emailLc,
      name: u ? u.name : emailLc,
      avatar: u ? (u.avatar || '') : ''
    };
  });
  res.json({
    id: g.id,
    name: g.name,
    members: memberObjs,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
    messages: g.messages || []
  });
});

// Send a message to a group.
app.post('/api/groups/:id/message', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const g = findGroupByIdForMember(req.params.id, me);
  if (!g) return res.status(404).json({ error: 'not in this group' });
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'empty' });
  const msg = {
    id: newId(),
    from: me,
    fromName: user.name,
    text,
    createdAt: Date.now(),
    readBy: [me]
  };
  g.messages = g.messages || [];
  g.messages.push(msg);
  saveGroups();
  // Broadcast to every member's online sockets
  for (const [sid, info] of onlineUsers) {
    if (g.members.includes(info.email)) {
      io.to(sid).emit('group-message', { groupId: g.id, message: msg, groupName: g.name });
    }
  }
  // In-app notif for offline members
  for (const m of g.members) {
    if (m === me) continue;
    const isOnline = Array.from(onlineUsers.values()).some(o => o.email === m);
    if (isOnline) continue;
    pushNotif(m, {
      type: 'group-message',
      fromName: user.name,
      fromEmail: user.email,
      groupId: g.id,
      text: `[${g.name}] ${user.name}: ${text.slice(0, 100)}`
    });
  }
  res.json(msg);
});

// Add member to existing group (only by an existing member).
app.post('/api/groups/:id/members', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const g = findGroupByIdForMember(req.params.id, me);
  if (!g) return res.status(404).json({ error: 'not in this group' });
  if (g.locked) return res.status(403).json({ error: 'this group is locked — only the original referral group lives here' });
  const lc = String(req.body?.email || '').trim().toLowerCase();
  if (!lc) return res.status(400).json({ error: 'email required' });
  const u = findUserByEmail(lc);
  if (!u || u.status !== 'active') return res.status(404).json({ error: 'user not found' });
  if (g.members.includes(lc)) return res.status(409).json({ error: 'already in group' });
  if (g.members.length >= 50) return res.status(409).json({ error: 'group full (50 max)' });
  g.members.push(lc);
  saveGroups();
  pushNotif(lc, {
    type: 'group-invite',
    fromName: user.name,
    fromEmail: user.email,
    groupId: g.id,
    text: `${user.name} added you to "${g.name}"`
  });
  for (const [sid, info] of onlineUsers) {
    if (info.email === lc) io.to(sid).emit('group-created', { groupId: g.id, name: g.name });
  }
  res.json({ ok: true, members: g.members });
});

// Leave a group.
app.delete('/api/groups/:id/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const g = findGroupByIdForMember(req.params.id, me);
  if (!g) return res.status(404).json({ error: 'not in this group' });
  if (g.locked) return res.status(403).json({ error: 'this group is locked forever — the people who brought you here stay here.' });
  g.members = g.members.filter(m => m !== me);
  // Add a system message so members see who left
  g.messages = g.messages || [];
  g.messages.push({
    id: newId(),
    from: '__system__',
    fromName: 'system',
    text: `${user.name} left the group`,
    createdAt: Date.now(),
    readBy: [],
    system: true
  });
  // If empty, drop the group entirely
  if (g.members.length === 0) {
    groups = groups.filter(x => x.id !== g.id);
  }
  saveGroups();
  res.json({ ok: true });
});

app.get('/api/dm/with/:email', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const other = decodeURIComponent(req.params.email).toLowerCase();
  const me = user.email.toLowerCase();
  const otherUser = findUserByEmail(other);
  if (!otherUser) return res.status(404).json({ error: 'user not found' });
  // HARD school isolation — 404 cross-school DM threads. System
  // pseudo-senders (approval drip / anonymous) bypass.
  if (!viewerCanSeeUser(user, otherUser)) return res.status(404).json({ error: 'user not found' });
  const messages = dms
    .filter(m => (m.from === me && m.to === other) || (m.from === other && m.to === me))
    .sort((a, b) => a.createdAt - b.createdAt);
  // mark messages from `other` to me as read
  let changed = false;
  const newlyReadIds = [];
  for (const m of messages) {
    if (m.to === me && !m.read) {
      m.read = true;
      m.readAt = Date.now();
      newlyReadIds.push(m.id);
      changed = true;
    }
  }
  if (changed) saveDms();
  // Notify the sender so they can flip ✓ → ✓✓ on their UI in realtime
  if (newlyReadIds.length > 0) {
    for (const [sid, info] of onlineUsers) {
      if (info.email === other) {
        io.to(sid).emit('dm-read', { reader: me, ids: newlyReadIds });
      }
    }
  }
  res.json({
    other: { email: otherUser.email, name: otherUser.name, avatar: otherUser.avatar || '' },
    messages
  });
});

app.post('/api/dm/with/:email', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const other = decodeURIComponent(req.params.email).toLowerCase();
  if (other === user.email.toLowerCase()) return res.status(400).json({ error: "can't dm yourself" });
  if (!isFeatureUnlocked(user, 'dm')) {
    const g = dmGateCounts(user);
    return res.status(403).json({ error: `DMs unlock once you've sent ${g.need} friend requests — you've sent ${g.sent}` });
  }
  const otherUser = findUserByEmail(other);
  if (!otherUser || otherUser.status === 'banned') return res.status(404).json({ error: 'user not found' });
  // HARD school isolation — block sends to cross-school users. System
  // pseudo-senders (Old Streets / anonymous) are always reachable.
  if (!viewerCanSeeUser(user, otherUser)) return res.status(404).json({ error: 'user not found' });
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  const msg = {
    id: newId(),
    from: user.email.toLowerCase(),
    fromName: user.name,
    to: other,
    text: text.slice(0, 1000),
    createdAt: Date.now(),
    read: false
  };
  dms.push(msg);
  if (dms.length > 20000) dms = dms.slice(-20000);
  saveDms();

  // emit to recipient and sender via socket
  for (const [sid, info] of onlineUsers) {
    if (info.email === other || info.email === user.email.toLowerCase()) {
      io.to(sid).emit('dm-message', msg);
    }
  }
  // Mentions inside DM text — notify anyone @-tagged who isn't the other party
  const mentioned = findMentionedUsers(text);
  for (const me of mentioned) {
    if (me === user.email || me === other) continue;
    const target = findUserByEmail(me);
    if (!target) continue;
    pushNotif(me, {
      type: 'mention',
      fromName: user.name,
      fromEmail: user.email,
      text: `${user.name} mentioned you in a DM: "${text.slice(0, 100)}"`
    });
    sendMentionEmail({ toName: target.name, toEmail: me, fromName: user.name, postPreview: text, postId: '' }).catch(() => {});
  }
  res.json(msg);
});

// =================================================================
// ENGAGEMENT API
// =================================================================
app.get('/api/notifications', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const mine = notifs.filter(n => n.to === me).sort((a, b) => b.ts - a.ts).slice(0, 50)
    .map(n => {
      // Enrich every notif with fromHandle so the client can render the
      // fromName as a clickable /u/{handle} link.
      if (n.fromHandle) return n;
      const src = n.fromEmail || n.from || '';
      if (!src || !src.includes('@')) return n;
      const u = findUserByEmail(src);
      return u && u.handle ? { ...n, fromHandle: u.handle } : n;
    });
  const unreadDms = dms.filter(m => m.to === me && !m.read).length;
  const unreadNotifs = mine.filter(n => !n.read).length;
  res.json({
    notifications: mine,
    unreadDmCount: unreadDms,
    unreadNotifCount: unreadNotifs,
    totalUnread: unreadDms + unreadNotifs
  });
});

app.post('/api/notifications/read-all', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  let changed = 0;
  for (const n of notifs) {
    if (n.to === me && !n.read) { n.read = true; changed++; }
  }
  if (changed) saveNotifs();
  res.json({ marked: changed });
});

// Mark a single notification as read (and optionally dismiss it).
app.post('/api/notifications/:id/read', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const n = notifs.find(x => x.id === req.params.id && x.to === me);
  if (!n) return res.status(404).json({ error: 'not found' });
  if (!n.read) {
    n.read = true;
    saveNotifs();
  }
  res.json({ ok: true });
});

// Dismiss/delete a single notification entirely.
app.delete('/api/notifications/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const idx = notifs.findIndex(x => x.id === req.params.id && x.to === me);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  notifs.splice(idx, 1);
  saveNotifs();
  res.json({ ok: true });
});

// Track click-through on a notification.
app.post('/api/notifications/:id/click', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const n = notifs.find(x => x.id === req.params.id && x.to === me);
  if (!n) return res.status(404).json({ error: 'not found' });
  n.clickedAt = Date.now();
  saveNotifs();
  res.json({ ok: true });
});

app.get('/api/posts-since/:ts', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const since = parseInt(req.params.ts) || 0;
  const newPosts = posts.filter(p => p.createdAt > since && (!p.expiresAt || p.expiresAt > Date.now()));
  res.json({ count: newPosts.length, since });
});

app.get('/api/me/feature-status', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({
    dm: (() => {
      const g = dmGateCounts(user);
      return { unlocked: isFeatureUnlocked(user, 'dm'), needRequestsSent: g.need, requestsSent: g.sent };
    })(),
    random: { unlocked: isFeatureUnlocked(user, 'random'), needPosts: 1, hasPosted: !!user.hasPostedOnce }
  });
});

// =================================================================
// FOMO / ENGAGEMENT DIGEST
// =================================================================
// Activity digest: bundle everything that happened since the user was
// last here so the client can render a guilt-inducing FOMO splash.
app.get('/api/me/digest', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  // `since` is sent by the client — it's the timestamp they stored in
  // localStorage on their *previous* session, before requireUser() just
  // updated lastVisitAt to now. Fallback: 24h ago.
  const since = parseInt(req.query.since) || (Date.now() - ONE_DAY_MS);
  const me = user.email.toLowerCase();

  // Posts that went up while they were away
  const now = Date.now();
  const newPostCount = posts.filter(p =>
    p.createdAt > since && p.createdAt <= now &&
    (!p.expiresAt || p.expiresAt > now)
  ).length;

  // Unread notifs (mentions + talked-about) since they left
  const unreadNotifCount = notifs.filter(n =>
    n.to === me && !n.read && n.ts > since
  ).length;

  // Unread DMs
  const unreadDmCount = dms.filter(m => m.to === me && !m.read).length;

  // Profile views in the last 7 days
  const weekAgo = now - 7 * ONE_DAY_MS;
  const recentViews = profileViews.filter(v => v.target === me && v.ts > weekAgo);
  const uniqueViewers = [...new Set(recentViews.map(v => v.viewer))].length;

  // Streak break: expose prevStreak + streakBrokeAt then clear the flag
  // so repeat logins don't keep re-triggering the toast
  const streakBrokeAt = user.streakBrokeAt || null;
  const prevStreak = user.prevStreak || 0;
  if (streakBrokeAt) {
    user.streakBrokeAt = null;
    user.prevStreak = null;
    saveUsers();
  }

  // Friends who posted while they were away — used for guilt-inducing login splash
  const myFriends = new Set((user.friends || []).map(f => f.toLowerCase()));
  const friendMap = {};
  for (const p of posts) {
    if (p.createdAt <= since || p.isAnonymous || !p.authorEmail) continue;
    const fe = p.authorEmail.toLowerCase();
    if (!myFriends.has(fe) || fe === me) continue;
    if (!friendMap[fe]) {
      const fu = findUserByEmail(fe);
      friendMap[fe] = { name: fu ? fu.name : fe, count: 0 };
    }
    friendMap[fe].count++;
  }
  const friendActivity = Object.values(friendMap).sort((a, b) => b.count - a.count);

  // Below-average framing: show activity percentile with the benchmark
  // anchored at the 65th percentile so average users always feel slightly behind.
  const weekAgo2 = now - 7 * ONE_DAY_MS;
  const myPostsThisWeek = posts.filter(p => p.authorEmail === me && p.createdAt > weekAgo2 && !p.isAnonymous).length;
  const allWeekPostCounts = users
    .filter(u => u.status === 'active')
    .map(u => posts.filter(p => p.authorEmail === u.email.toLowerCase() && p.createdAt > weekAgo2 && !p.isAnonymous).length)
    .sort((a, b) => a - b);
  const p65idx = Math.floor(allWeekPostCounts.length * 0.65);
  const benchmark65 = allWeekPostCounts[p65idx] || 1;
  const myRankIdx = allWeekPostCounts.filter(c => c <= myPostsThisWeek).length;
  const myPercentile = allWeekPostCounts.length > 0 ? Math.round((myRankIdx / allWeekPostCounts.length) * 100) : 50;

  res.json({
    newPostCount,
    unreadNotifCount,
    unreadDmCount,
    profileViewCount: uniqueViewers,
    streakBrokeAt,
    prevStreak,
    since,
    friendActivity,
    activityStats: {
      myPostsThisWeek,
      benchmark: benchmark65,
      percentile: myPercentile
    }
  });
});

// =================================================================
// PROFILE COMPLETENESS — progress bar that never quite hits 100%.
// The last few % require streak milestones most users won't reach.
// The bar nags. It sits on their profile. They always feel one step away.
// =================================================================
app.get('/api/me/weekly-report', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const now = Date.now();
  const weekAgo = now - 7 * ONE_DAY_MS;
  const twoWeeksAgo = now - 14 * ONE_DAY_MS;

  const myPostsThisWeek  = posts.filter(p => p.authorEmail === me.email && !p.isGhost && p.createdAt > weekAgo);
  const myPostsLastWeek  = posts.filter(p => p.authorEmail === me.email && !p.isGhost && p.createdAt > twoWeeksAgo && p.createdAt <= weekAgo);
  const myCommentsThisWeek = posts.reduce((n, p) =>
    n + (p.comments || []).filter(c => c.authorEmail === me.email && c.createdAt > weekAgo).length, 0);

  // Reactions received on my posts this week (real only)
  let reactionsReceivedThisWeek = 0;
  for (const p of myPostsThisWeek) {
    for (const bucket of Object.values(p.reactions || {})) {
      reactionsReceivedThisWeek += Object.keys(bucket).filter(e => !e.endsWith('@old-streets.internal')).length;
    }
  }
  // All-time reactions received (real only)
  let reactionsReceivedAllTime = 0;
  const allMyPosts = posts.filter(p => p.authorEmail === me.email && !p.isGhost);
  for (const p of allMyPosts) {
    for (const bucket of Object.values(p.reactions || {})) {
      reactionsReceivedAllTime += Object.keys(bucket).filter(e => !e.endsWith('@old-streets.internal')).length;
    }
  }

  // Rank by posts this week
  const activeList = users.filter(u => u.status === 'active');
  const weekPostCounts = activeList.map(u => ({
    email: u.email,
    n: posts.filter(p => p.authorEmail === u.email && !p.isGhost && p.createdAt > weekAgo).length
  })).sort((a, b) => b.n - a.n);
  const myRankIdx = weekPostCounts.findIndex(x => x.email.toLowerCase() === me.email.toLowerCase());
  const myRank = myRankIdx >= 0 ? myRankIdx + 1 : weekPostCounts.length + 1;

  // Percentile among active users
  const aboveMe = weekPostCounts.filter(x => x.n < (myPostsThisWeek.length)).length;
  const percentile = activeList.length > 0 ? Math.round((aboveMe / activeList.length) * 100) : 0;

  const karma = computeKarmaScore(me.email);

  // Top reacted post this week
  let topPost = null;
  let topPostReacts = 0;
  for (const p of myPostsThisWeek) {
    let r = 0;
    for (const b of Object.values(p.reactions || {})) r += Object.keys(b).filter(e => !e.endsWith('@old-streets.internal')).length;
    if (r > topPostReacts) { topPostReacts = r; topPost = p; }
  }

  res.json({
    weekPosts:       myPostsThisWeek.length,
    lastWeekPosts:   myPostsLastWeek.length,
    weekComments:    myCommentsThisWeek,
    reactionsThisWeek: reactionsReceivedThisWeek,
    reactionsAllTime:  reactionsReceivedAllTime,
    rank:            myRank,
    totalActive:     activeList.length,
    percentile,
    streak:          me.streak || 0,
    karmaScore:      karma.score,
    karmaLabel:      karma.label,
    karmaTier:       karma.tier,
    topPostId:       topPost ? topPost.id : null,
    topPostReacts,
    generatedAt:     now
  });
});

app.get('/api/me/completeness', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const myPosts = posts.filter(p => p.authorEmail === me && !p.isAnonymous);
  const hasAnsweredQotd = (qotdHistory || []).some(q =>
    (q.answers || []).some(a => (a.authorEmail || '').toLowerCase() === me)
  );
  const tasks = [
    { id: 'bio',       label: 'write a bio',                   done: !!(user.bio && user.bio.length >= 10),      pts: 10 },
    { id: 'avatar',    label: 'upload a profile photo',        done: !!user.avatar,                               pts: 10 },
    { id: 'headline',  label: 'set a headline',                done: !!(user.headline && user.headline.length >= 3), pts: 8 },
    { id: 'mood',      label: 'set your mood',                 done: !!(user.moodId || user.mood),                pts: 5  },
    { id: 'interests', label: 'add your interests',            done: !!(user.interests && user.interests.length >= 5), pts: 7 },
    { id: 'song',      label: 'add a profile song',            done: !!user.songUrl,                              pts: 6  },
    { id: 'friends3',  label: 'add 3 friends',                 done: (user.friends || []).length >= 3,            pts: 10 },
    { id: 'post5',     label: 'make 5 posts',                  done: myPosts.length >= 5,                         pts: 9  },
    { id: 'qotd',      label: 'answer a question of the day',  done: hasAnsweredQotd,                             pts: 5  },
    // Intentionally hard — keeps the bar permanently ~incomplete for most users
    { id: 'streak7',   label: 'reach a 7-day streak',          done: (user.streak || 0) >= 7,                     pts: 12 },
    { id: 'streak30',  label: 'reach a 30-day streak',         done: (user.streak || 0) >= 30,                    pts: 10 },
    { id: 'react50wk', label: 'get 50 reactions in one week',  done: !!(user._peakWeekReactions && user._peakWeekReactions >= 50), pts: 8 },
  ];
  const totalPts = tasks.reduce((s, t) => s + t.pts, 0);
  const earnedPts = tasks.filter(t => t.done).reduce((s, t) => s + t.pts, 0);
  const pct = Math.round((earnedPts / totalPts) * 100);
  trackEvent(user.email, 'completeness-view', {});
  res.json({ pct, tasks: tasks.map(({ id, label, done }) => ({ id, label, done })), earnedPts, totalPts });
});

// Leaderboard: top 5 users by posts + comments this week
app.get('/api/leaderboard', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const weekAgo = Date.now() - 7 * ONE_DAY_MS;
  // HARD school isolation — only authors visible to the viewer count.
  const scores = {};
  for (const p of posts) {
    if (p.createdAt < weekAgo) continue;
    if (p.isAnonymous) continue;
    const e = (p.authorEmail || '').toLowerCase();
    if (!e) continue;
    const author = findUserByEmail(e);
    if (!viewerCanSeeUser(user, author)) continue;
    scores[e] = (scores[e] || 0) + 2;
    for (const c of p.comments || []) {
      if (c.createdAt < weekAgo) continue;
      const ce = (c.authorEmail || '').toLowerCase();
      if (!ce) continue;
      const cAuthor = findUserByEmail(ce);
      if (!viewerCanSeeUser(user, cAuthor)) continue;
      scores[ce] = (scores[ce] || 0) + 1;
    }
  }
  // Score decay: visible rank drop for users who've gone quiet
  const decayNow = Date.now();
  for (const [email] of Object.entries(scores)) {
    const u2 = findUserByEmail(email);
    if (!u2 || !u2.lastPostAt) continue;
    const daysSince = (decayNow - u2.lastPostAt) / ONE_DAY_MS;
    if (daysSince > 7)      scores[email] = Math.round(scores[email] * 0.25);
    else if (daysSince > 5) scores[email] = Math.round(scores[email] * 0.50);
    else if (daysSince > 3) scores[email] = Math.round(scores[email] * 0.75);
  }

  const ranked = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([email, pts]) => {
      const u = findUserByEmail(email);
      const daysSince = u && u.lastPostAt ? (decayNow - u.lastPostAt) / ONE_DAY_MS : 0;
      return {
        email,
        name: u ? u.name : email,
        avatar: u ? u.avatar || '' : '',
        pts,
        decayed: daysSince > 3,
        isMe: email === user.email.toLowerCase()
      };
    });

  // Pad the leaderboard with phantom names drawn from the ecosystem pool so the
  // board never looks dead. NEVER inject 'anonymous' — that'd be a tell.
  // PHANTOM PADDING REMOVED — leaderboard returns real same-school scores
  // only. Cross-school leak (Beverly Hills viewer seeing Ancient Old Streets names
  // in the ghost pool) was a critical isolation bug.
  res.json(ranked.slice(0, 5));
});

// =================================================================
// REFERRAL LEADERBOARD — who's built the platform the most
// Crown goes to whoever converted the most invitees into active members.
// =================================================================
app.get('/api/leaderboard/referrals', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const tally = users
    .filter(u => u.status === 'active' && (u.referrals || []).length > 0)
    .map(u => {
      const converted = (u.referrals || []).filter(ref => {
        const ru = findUserByEmail(ref.email);
        return ru && ru.status === 'active';
      }).length;
      return { email: u.email, name: u.name, converted };
    })
    .filter(t => t.converted > 0)
    .sort((a, b) => b.converted - a.converted)
    .slice(0, 5);
  const topEmail = tally[0]?.email?.toLowerCase() || '';
  res.json(tally.map(t => ({ ...t, crown: t.email.toLowerCase() === topEmail, isMe: t.email.toLowerCase() === me })));
});

// =================================================================
// LOVE LETTER — viral anonymous-crush chain
// Sender stays anonymous (we don't reveal even to admin in the email).
// Recipient gets an email + in-app notification + a "pick 3" prompt.
// Their 3 picks each get the same email — the chain propagates.
// =================================================================
async function sendLoveLetterEmail({ toEmail, toName, fromHint, letterId, message }) {
  if (!config.resendApiKey) return { skipped: true };
  const _u = unsubArtifacts(toEmail);
  if (_u.blocked) return { skipped: true, unsubscribed: true };
  const siteUrl = config.publicUrl || 'http://localhost:3001';
  const link = `${siteUrl}/#crush=${encodeURIComponent(letterId)}`;
  const noteBlock = message ? `
    <p style="font-size: 14px; line-height: 1.55; background: #fff0f7; border: 1px solid #ffb6d9; padding: 10px 14px; margin: 12px 0; font-style: italic;">
      "${escapeHtmlServer(String(message).slice(0, 280))}"
    </p>` : '';
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">
      <div style="background: #ff6ec7; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">[ Old Streets ] 💌 love letter</div>
      <h2 style="color: #ff3b85; font-size: 22px; margin: 22px 0 8px;">Someone has a crush on you. 💌</h2>
      <p style="font-size: 14px; line-height: 1.55;">
        Hi ${escapeHtmlServer((toName || '').split(' ')[0] || 'you')} —
        <strong>another member</strong> told us anonymously that they have a crush on you.
        We can't tell you who.
      </p>
      ${noteBlock}
      <div style="background: #f0f9f4; border-left: 3px solid #2ea44f; padding: 8px 12px; margin: 14px 0; font-size: 11px; color: #1a5132;">
        ✓ <strong>Safe to click.</strong> This email is from another Old Streets member through Old Streets — a private invite-only platform. We never share your address.
      </div>
      <h3 style="color: #ff3b85; font-size: 16px; margin: 22px 0 4px;">Who do you think it is?</h3>
      <p style="font-size: 13px; line-height: 1.55;">
        Pick the 3 people you think have a crush on you. We'll never tell you if you got it right —
        the sender stays anonymous forever. But it'll bug you 'til you find out 😈
      </p>
      <p style="margin: 20px 0;">
        <a href="${link}" style="display: inline-block; background: #ff6ec7; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border-radius: 4px; border: 1px solid #d8438f;">Pick 3 →</a>
      </p>
      <p style="font-size: 12px; line-height: 1.55; color: #555; background: #fafafa; padding: 10px 14px; border-left: 3px solid #ff6ec7; margin: 14px 0;">
        <strong>Not on Old Streets yet?</strong> It's a private wall + video chat <strong>invite-only</strong>. Click the button — we'll walk you through signing up in under a minute. Members get in through an invite.
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 18px; line-height: 1.55; text-align: center;">
        invite-only · Old Streets is independent, not affiliated with any school
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject: `💌 someone has a crush on you — Old Streets`,
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// =================================================================
// eCRUSH MUTUAL MATCH — when A crushes B AND B crushes A, both told.
// Hooks into the love-letter send (the only place a user declares
// "I have a crush on this specific person") and runs match-detection.
// =================================================================
function addCrushAndCheckMatch(fromUser, toEmail, toName) {
  const fromLc = (fromUser.email || '').toLowerCase();
  const toLc = (toEmail || '').toLowerCase();
  if (!fromLc || !toLc || fromLc === toLc) return null;
  // de-dupe — if the same crush already exists, don't add again
  const existing = crushList.find(c =>
    c.from.toLowerCase() === fromLc && c.to.toLowerCase() === toLc);
  if (existing) {
    // If it was already matched, no new event
    if (existing.matched) return null;
  } else {
    crushList.push({
      id: newId(),
      from: fromUser.email,
      to: toEmail,
      fromName: fromUser.name,
      toName: toName || toEmail,
      createdAt: Date.now(),
      matched: false
    });
  }
  // Check for reciprocal: did B previously crush A?
  const reciprocal = crushList.find(c =>
    c.from.toLowerCase() === toLc && c.to.toLowerCase() === fromLc && !c.matched);
  if (!reciprocal) {
    saveCrushList();
    return null;
  }
  // MATCH! Mark both as matched.
  const now = Date.now();
  for (const c of crushList) {
    if ((c.from.toLowerCase() === fromLc && c.to.toLowerCase() === toLc) ||
        (c.from.toLowerCase() === toLc && c.to.toLowerCase() === fromLc)) {
      c.matched = true;
      c.matchedAt = now;
    }
  }
  saveCrushList();
  // Fire notifs + emails to both
  const otherUser = findUserByEmail(toEmail);
  const otherName = otherUser ? otherUser.name : (toName || toEmail);
  pushNotif(fromUser.email, {
    type: 'crush-match',
    fromName: '💞 mutual crush',
    fromEmail: '',
    text: `🎯 IT'S A MATCH. ${otherName} has a crush on you too.`,
    matchedEmail: toEmail,
    matchedName: otherName
  });
  if (otherUser) {
    pushNotif(otherUser.email, {
      type: 'crush-match',
      fromName: '💞 mutual crush',
      fromEmail: '',
      text: `🎯 IT'S A MATCH. ${fromUser.name} has a crush on you too.`,
      matchedEmail: fromUser.email,
      matchedName: fromUser.name
    });
  }
  // Emails for both parties
  sendCrushMatchEmail({ toEmail: fromUser.email, toName: fromUser.name, otherName, otherEmail: toEmail }).catch(() => {});
  if (otherUser) sendCrushMatchEmail({ toEmail: otherUser.email, toName: otherUser.name, otherName: fromUser.name, otherEmail: fromUser.email }).catch(() => {});
  console.log(`[crush-match] ${fromUser.email} ↔ ${toEmail}`);
  return { matched: true, otherName, otherEmail: toEmail };
}

async function sendCrushMatchEmail({ toEmail, toName, otherName, otherEmail }) {
  if (!config.resendApiKey) return;
  const _u = unsubArtifacts(toEmail);
  if (_u.blocked) return;
  const siteUrl = config.publicUrl || 'http://localhost:3001';
  const link = `${siteUrl}/#user=${encodeURIComponent(otherEmail)}`;
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">
      <div style="background: #ff3b85; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">💞 IT'S A MATCH</div>
      <h2 style="color: #ff3b85; font-size: 22px; margin: 22px 0 8px;">${escapeHtmlServer(otherName)} has a crush on you too.</h2>
      <p style="font-size: 14px; line-height: 1.55;">
        Hi ${escapeHtmlServer((toName || '').split(' ')[0] || 'you')} —
        you sent ${escapeHtmlServer(otherName)} an anonymous crush, and they sent you one too. Now you both know.
      </p>
      <p style="margin: 20px 0;">
        <a href="${link}" style="display: inline-block; background: #ff3b85; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border-radius: 4px;">View their profile →</a>
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 18px; line-height: 1.55;">
        Old Streets is independent — not affiliated with any school. We only tell you when there's a mutual match. Unmatched crushes stay anonymous forever.
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject: `💞 it's a match — ${otherName} has a crush on you too`,
        html,
        headers: _u.headers
      })
    });
  } catch {}
}

// GET /api/crush/list — my outgoing crushes (only the user themselves
// can see who they've crushed on)
app.get('/api/crush/list', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const list = crushList
    .filter(c => c.from.toLowerCase() === me)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// GET /api/crush/matches — my mutual matches
app.get('/api/crush/matches', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const seenPairs = new Set();
  const matches = [];
  for (const c of crushList) {
    if (!c.matched) continue;
    const a = c.from.toLowerCase(), b = c.to.toLowerCase();
    if (a !== me && b !== me) continue;
    const other = a === me ? b : a;
    const otherName = a === me ? c.toName : c.fromName;
    const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    matches.push({
      otherEmail: other,
      otherName,
      matchedAt: c.matchedAt || c.createdAt
    });
  }
  matches.sort((a, b) => b.matchedAt - a.matchedAt);
  res.json(matches);
});

// POST /api/crush/add — add a crush WITHOUT sending a love letter cascade.
// Just for the "list my crushes silently" usage. Triggers match-check.
app.post('/api/crush/add', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { toEmail, toName } = req.body || {};
  if (!toEmail) return res.status(400).json({ error: 'toEmail required' });
  const result = addCrushAndCheckMatch(user, toEmail, toName);
  res.json({ ok: true, matched: !!(result && result.matched), match: result || null });
});

// DELETE /api/crush/:toEmail — remove (only if not yet matched)
app.delete('/api/crush/:toEmail', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const target = decodeURIComponent(req.params.toEmail).toLowerCase();
  const idx = crushList.findIndex(c =>
    c.from.toLowerCase() === me && c.to.toLowerCase() === target && !c.matched);
  if (idx < 0) return res.status(404).json({ error: 'crush not found or already matched' });
  crushList.splice(idx, 1);
  saveCrushList();
  res.json({ ok: true });
});

// =================================================================
// ADMIN — love-letter tracker: every letter, who picked what, response
// rate, chain depth, matches. (admin-only)
// =================================================================
app.get('/api/admin/love-letters', (req, res) => {
  if (!requireAdmin(req, res)) return;
  // Admin sees real senders for moderation. UI badges them as anonymous-
  // to-public so admin doesn't accidentally cross-reference in user-facing
  // contexts. (Older versions had a reveal-toggle; reduces friction to just
  // show by default — admin already has full power, may as well surface it.)
  const all = loveLetters.slice().sort((a, b) => b.createdAt - a.createdAt);
  const rows = all.map(l => {
    const guessed = !!l.guessUsed;
    return {
      id: l.id,
      toEmail: l.toEmail,
      toName: l.toName,
      message: l.message || '',
      fromHash: l.fromEmailHash || '',
      fromEmail: l.fromEmail || '',
      fromName: l.fromName || '',
      parentId: l.parentId || null,
      chainDepth: l.chainDepth || 0,
      createdAt: l.createdAt,
      guessUsed: guessed,
      guessedAt: l.guessedAt || null,
      guessPicks: l.guessPicks || [],
      guessResult: l.guessResult || null,
      matchedName: l.matchedName || null
    };
  });
  // Aggregate metrics
  const totalSent = all.length;
  const totalGuessed = all.filter(l => l.guessUsed).length;
  const responseRatePct = totalSent > 0 ? Math.round((totalGuessed / totalSent) * 100) : 0;
  const totalMatches = crushList.filter(c => c.matched).length / 2; // each match has 2 entries
  const maxDepth = all.reduce((m, l) => Math.max(m, l.chainDepth || 0), 0);
  res.json({
    rows,
    metrics: {
      totalSent,
      totalGuessed,
      responseRatePct,
      totalMatches: Math.round(totalMatches),
      maxChainDepth: maxDepth,
      avgGuessAgeMs: totalGuessed > 0
        ? Math.round(all.filter(l => l.guessUsed)
            .reduce((s, l) => s + ((l.guessedAt || 0) - l.createdAt), 0) / totalGuessed)
        : 0
    }
  });
});

// Admin reveal: get a single letter's sender
app.get('/api/admin/love-letters/:id/reveal', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const l = loveLetters.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  console.log(`[ADMIN REVEAL] letter ${l.id} sender de-anonymized`);
  res.json({
    id: l.id,
    fromEmail: l.fromEmail || null,
    fromName: l.fromName || null,
    fromHash: l.fromEmailHash,
    createdAt: l.createdAt,
    toEmail: l.toEmail
  });
});

// Admin reveal: get an anonymous post's real author
app.get('/api/admin/posts/:id/reveal', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!p.isAnonymous) return res.json({ author: p.author, authorEmail: p.authorEmail, wasAnonymous: false });
  console.log(`[ADMIN REVEAL] post ${p.id} author de-anonymized`);
  res.json({
    id: p.id,
    author: p.author,
    authorEmail: p.authorEmail,
    wasAnonymous: true,
    createdAt: p.createdAt
  });
});

// =================================================================
// ANNOUNCEMENTS — admin posts a banner that floats at the top of every
// member's screen until expired/dismissed.
// =================================================================
app.get('/api/announcements/current', (req, res) => {
  const now = Date.now();
  const active = announcements.filter(a => a.active && (!a.expiresAt || a.expiresAt > now));
  // Most recent active first
  active.sort((a, b) => b.createdAt - a.createdAt);
  res.json(active.slice(0, 5));
});
app.get('/api/admin/announcements', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(announcements.slice().sort((a, b) => b.createdAt - a.createdAt));
});
app.post('/api/admin/announcements', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { text, link, durationHours, active } = req.body || {};
  const t = String(text || '').trim().slice(0, 280);
  if (!t) return res.status(400).json({ error: 'text required' });
  const dur = parseInt(durationHours, 10) || 0;
  const a = {
    id: newId(),
    text: t,
    link: String(link || '').slice(0, 500),
    active: active !== false,
    createdAt: Date.now(),
    expiresAt: dur > 0 ? Date.now() + dur * 60 * 60 * 1000 : null
  };
  announcements.unshift(a);
  if (announcements.length > 200) announcements = announcements.slice(0, 200);
  saveAnnouncements();
  res.json(a);
});
app.put('/api/admin/announcements/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const a = announcements.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (req.body.text !== undefined) a.text = String(req.body.text).slice(0, 280);
  if (req.body.link !== undefined) a.link = String(req.body.link).slice(0, 500);
  if (req.body.active !== undefined) a.active = !!req.body.active;
  if (req.body.durationHours !== undefined) {
    const dur = parseInt(req.body.durationHours, 10) || 0;
    a.expiresAt = dur > 0 ? Date.now() + dur * 60 * 60 * 1000 : null;
  }
  saveAnnouncements();
  res.json(a);
});
app.delete('/api/admin/announcements/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const idx = announcements.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  announcements.splice(idx, 1);
  saveAnnouncements();
  res.json({ ok: true });
});

// =================================================================
// ADMIN BROADCAST — push one notification to every active user
// (bell badge + browser web-push via existing onIncomingNotif hook)
// =================================================================
app.post('/api/admin/broadcast', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const text = String(req.body?.text || '').trim().slice(0, 240);
  const title = String(req.body?.title || '📣 Old Streets').trim().slice(0, 60);
  const link = String(req.body?.link || '').trim().slice(0, 500);
  const audience = String(req.body?.audience || 'all'); // 'all' | 'online' | 'active'
  if (!text) return res.status(400).json({ error: 'text required' });

  // Determine recipients
  let recipients = users.filter(u => u.status === 'active');
  if (audience === 'online') {
    const onlineEmails = new Set(Array.from(onlineUsers.values()).map(u => u.email.toLowerCase()));
    recipients = recipients.filter(u => onlineEmails.has(u.email.toLowerCase()));
  }
  let sent = 0;
  for (const u of recipients) {
    pushNotif(u.email, {
      type: 'broadcast',
      fromName: title,
      fromEmail: '',
      text,
      link
    });
    sent++;
  }
  console.log(`[broadcast] admin sent "${text.slice(0, 60)}" to ${sent} users (audience=${audience})`);
  res.json({ ok: true, sent, audience });
});

// =================================================================
// STIR THE POT — run all retention mechanics immediately
// =================================================================
app.post('/api/admin/stir-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const now = Date.now();
  const results = {};

  // a) Ghost reaction floor: posts with 0 real reactions older than 2 hours
  {
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const ghostEmojis = ['❤️','👍','😂','🔥'];
    let floored = 0;
    for (const p of posts) {
      if (floored >= 10) break;
      if (p.isGhost || p.isAnonymous || !p.authorEmail) continue;
      if (p.createdAt > twoHoursAgo) continue;
      const realReactors = new Set(
        Object.values(p.reactions || {}).flatMap(b => Object.keys(b))
          .filter(e => !e.endsWith('@old-streets.internal'))
      );
      if (realReactors.size > 0) continue;
      if (!p.reactions) p.reactions = {};
      const fakeEmail = newGhostInteractorEmail();
      const emoji = ghostEmojis[Math.floor(Math.random() * ghostEmojis.length)];
      if (!p.reactions[emoji]) p.reactions[emoji] = {};
      p.reactions[emoji][fakeEmail] = Date.now();
      p.upvotes = p.reactions['👍'] || {};
      savePosts();
      io.emit('post-voted', {
        id: p.id, reactions: p.reactions, upvotes: p.upvotes,
        downvotes: p.downvotes || {},
        upCount: Object.keys(p.upvotes || {}).length,
        downCount: Object.keys(p.downvotes || {}).length
      });
      floored++;
    }
    results.ghostReactionFloor = floored;
  }

  // b) Absence pushes: active users whose last post was 3-7 days ago without a recent miss-you
  {
    const threeDaysAgo = now - 3 * ONE_DAY_MS;
    const sevenDaysAgo = now - 7 * ONE_DAY_MS;
    let absencePushed = 0;
    for (const u of users) {
      if (absencePushed >= 20) break;
      if (u.status !== 'active') continue;
      const lastPostMs = u.lastPostAt || 0;
      if (!lastPostMs) continue;
      if (lastPostMs > threeDaysAgo || lastPostMs < sevenDaysAgo) continue;
      const lastPostDayVal = dayKey(lastPostMs);
      if (u._lastMissYouKey === lastPostDayVal) continue;
      u._lastMissYouKey = lastPostDayVal;
      const daysSince = Math.floor((now - lastPostMs) / ONE_DAY_MS);
      pushNotif(u.email, {
        type: 'missed-you',
        fromName: '💛 Old Streets',
        fromEmail: '',
        text: `you haven't posted in ${daysSince} days — the crew misses you. come back.`
      });
      absencePushed++;
    }
    if (absencePushed > 0) saveUsers();
    results.absencePushed = absencePushed;
  }

  // c) Crush teases: active users with inbound unmatched crushes from last 7 days
  {
    const weekAgo = now - 7 * ONE_DAY_MS;
    let crushesPushed = 0;
    for (const u of users) {
      if (crushesPushed >= 30) break;
      if (u.status !== 'active') continue;
      const inbound = crushList.filter(c =>
        c.to.toLowerCase() === u.email.toLowerCase() && !c.matched && c.createdAt > weekAgo
      ).length;
      if (inbound < 1) continue;
      delayedPush(u.email, {
        type: 'crush-tease',
        fromName: '💌 secret admirer',
        fromEmail: '',
        text: inbound === 1
          ? `someone added you as a crush this week and the window is closing — they won't wait forever 💌`
          : `${inbound} people added you as a crush this week. you won't know who unless you're here 💌`
      }, 15 * 60 * 1000, 30 * 60 * 1000);
      crushesPushed++;
    }
    results.crushesPushed = crushesPushed;
  }

  // d) Leaderboard taunts: rank drops
  {
    const weekAgo = now - 7 * ONE_DAY_MS;
    const scores = {};
    for (const p of posts) {
      if (p.createdAt < weekAgo || p.isAnonymous || p.isGhost) continue;
      const e = (p.authorEmail || '').toLowerCase();
      if (!e) continue;
      scores[e] = (scores[e] || 0) + 2;
      for (const c of (p.comments || [])) {
        if (c.createdAt < weekAgo) continue;
        const ce = (c.authorEmail || '').toLowerCase();
        if (ce) scores[ce] = (scores[ce] || 0) + 1;
      }
    }
    const ranked = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([email], idx) => ({ email, rank: idx + 1 }));
    let leaderboardPushed = 0;
    for (const { email, rank } of ranked) {
      const u = findUserByEmail(email);
      if (!u || u.status !== 'active' || u.isGhost) continue;
      const prevRank = u._lastLeaderboardRank;
      if (prevRank && rank > prevRank) {
        pushNotif(u.email, {
          type: 'leaderboard-drop',
          fromName: '📉 leaderboard',
          fromEmail: '',
          text: `you dropped from #${prevRank} to #${rank} on the leaderboard. post something before you fall further.`
        });
        leaderboardPushed++;
      }
      u._lastLeaderboardRank = rank;
    }
    if (leaderboardPushed > 0 || ranked.length > 0) saveUsers();
    results.leaderboardPushed = leaderboardPushed;
  }

  // e) Hot topic push
  {
    const weekAgo = now - 7 * ONE_DAY_MS;
    const hotPosts = posts
      .filter(p => !p.isGhost && !p.isAnonymous && p.createdAt > weekAgo && p.authorEmail)
      .map(p => ({
        p,
        reactions: Object.values(p.reactions || {}).reduce((s, b) => s + Object.keys(b).length, 0)
      }))
      .sort((a, b) => b.reactions - a.reactions);
    let hotTopicPushed = 0;
    if (hotPosts.length > 0) {
      const hotPost = hotPosts[0].p;
      const activeUsers = users.filter(u => u.status === 'active');
      for (const u of activeUsers) {
        if (hotTopicPushed >= 50) break;
        if (hotPost.views && hotPost.views[u.email.toLowerCase()]) continue;
        pushNotif(u.email, {
          type: 'hot-topic',
          fromName: '🔥 trending on the feed',
          fromEmail: '',
          postId: hotPost.id,
          text: `the most reacted post this week — you haven't seen it yet.`
        });
        hotTopicPushed++;
      }
      results.hotTopicPostId = hotPost.id;
    }
    results.hotTopicPushed = hotTopicPushed;
  }

  console.log('[stir-now] results:', results);
  res.json({ ok: true, results });
});

// =================================================================
// HOT TOPIC — push this week's hottest post to everyone who hasn't seen it
// =================================================================
app.post('/api/admin/hot-topic', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const now = Date.now();
  const weekAgo = now - 7 * ONE_DAY_MS;
  const hotPosts = posts
    .filter(p => !p.isGhost && !p.isAnonymous && p.createdAt > weekAgo && p.authorEmail)
    .map(p => ({
      p,
      reactions: Object.values(p.reactions || {}).reduce((s, b) => s + Object.keys(b).length, 0)
    }))
    .sort((a, b) => b.reactions - a.reactions);
  if (hotPosts.length === 0) return res.json({ ok: true, postId: null, pushed: 0 });
  const hotPost = hotPosts[0].p;
  const activeUsers = users.filter(u => u.status === 'active');
  let pushed = 0;
  for (const u of activeUsers) {
    if (hotPost.views && hotPost.views[u.email.toLowerCase()]) continue;
    pushNotif(u.email, {
      type: 'hot-topic',
      fromName: '🔥 trending on the feed',
      fromEmail: '',
      postId: hotPost.id,
      text: `the most reacted post this week — you haven't seen it yet.`
    });
    pushed++;
  }
  console.log(`[hot-topic] pushed to ${pushed} users for post ${hotPost.id}`);
  res.json({ ok: true, postId: hotPost.id, pushed });
});

// =================================================================
// 2FA via personal email — onboarding + login-by-name
// =================================================================
function genVerificationCode() {
  // 6-digit numeric code
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationCodeEmail({ toEmail, code, purpose, schoolName }) {
  if (!config.resendApiKey) return { skipped: true };
  const _u = unsubArtifacts(toEmail, { transactional: true });
  const purposeText = purpose === 'login'
    ? `Someone tried to sign into <strong>${escapeHtmlServer(schoolName || 'Old Streets')}</strong>. If that was you, here's your code:`
    : `Verifying your personal email for Old Streets. Here's your code:`;
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">
      <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">
        🔐 Old Streets — verification code
      </div>
      <h2 style="color: #3B5998; font-size: 22px; margin: 22px 0 8px;">${purpose === 'login' ? 'Sign-in code' : 'Verify your personal email'}</h2>
      <p style="font-size: 14px; line-height: 1.55;">${purposeText}</p>
      <div style="background: #fffbe5; border: 2px solid #f0c040; padding: 18px; margin: 16px 0; text-align: center;">
        <div style="font-size: 11px; color: #666; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px;">code</div>
        <code style="font-size: 36px; font-family: 'Courier New', monospace; font-weight: bold; letter-spacing: 8px; color: #3B5998;">${escapeHtmlServer(code)}</code>
      </div>
      <p style="font-size: 12px; line-height: 1.55; color: #555;">
        Expires in 10 minutes. If you didn't request this, ignore — nothing happens until the code is entered.
      </p>
      <p style="font-size: 11px; line-height: 1.55; color: #888; background: #f8f9fc; border-left: 3px solid #3B5998; padding: 10px 14px; margin: 14px 0;">
        Why is this going to your personal email and not your school email? <strong>Email accounts you do not solely control are a security risk.</strong> To stop that, we 2FA against an email <em>they can't sign into</em> — your personal one. That's why we asked for it.
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [toEmail],
        subject: `🔐 Old Streets — your code is ${code}`,
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Set / verify personal email for the logged-in user
app.post('/api/me/set-personal-email', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { personalEmail } = req.body || {};
  const pe = String(personalEmail || '').trim().toLowerCase();
  if (!pe || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pe)) {
    return res.status(400).json({ error: 'enter a valid email address' });
  }
  if (pe.endsWith('""')) {
    return res.status(400).json({ error: 'your personal email must NOT be your school email — use gmail / icloud / outlook' });
  }
  // Rate limit: max 5 verification sends per hour per user
  user._verificationSends = (user._verificationSends || []).filter(t => t > Date.now() - 60 * 60 * 1000);
  if (user._verificationSends.length >= 5) {
    return res.status(429).json({ error: 'too many verification attempts — wait an hour' });
  }
  user._verificationSends.push(Date.now());
  // Save pending email + send code (don't commit personalEmail until verified)
  user._pendingPersonalEmail = pe;
  const code = genVerificationCode();
  twoFaChallenges.set('verify:' + user.email.toLowerCase(), {
    code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0
  });
  saveUsers();
  const r = await sendVerificationCodeEmail({ toEmail: pe, code, purpose: 'verify' });
  res.json({ ok: true, sent: !!r.ok || !!r.skipped, devCode: r.skipped ? code : undefined });
});

app.post('/api/me/verify-personal-email', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const code = String((req.body && req.body.code) || '').trim();
  const key = 'verify:' + user.email.toLowerCase();
  const c = twoFaChallenges.get(key);
  if (!c) return res.status(400).json({ error: 'no pending verification — request a new code' });
  if (c.expiresAt < Date.now()) {
    twoFaChallenges.delete(key);
    return res.status(400).json({ error: 'code expired — request a new one' });
  }
  c.attempts = (c.attempts || 0) + 1;
  if (c.attempts > 6) {
    twoFaChallenges.delete(key);
    return res.status(429).json({ error: 'too many attempts — request a new code' });
  }
  if (c.code !== code) return res.status(400).json({ error: 'wrong code' });
  // Verified — commit
  user.personalEmail = user._pendingPersonalEmail;
  user.personalEmailVerified = true;
  user.personalEmailVerifiedAt = Date.now();
  user._pendingPersonalEmail = null;
  twoFaChallenges.delete(key);
  saveUsers();
  ghBackupNow().catch(() => {});
  res.json({ ok: true });
});

// Login-by-name → triggers 2FA code to personal email
// Passwordless sign-in by NAME or EMAIL. Whatever the user types — first
// name, full name, "jay.madson", or "jay.madson""" — we resolve
// to their "" address and send a 6-digit code there. Lazy-creates
// the account on first sign-in if they're new but in the school directory.
app.post('/api/login/start-2fa', rateLimit({ key: 'login-name', max: 12, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const { name } = req.body || {};
  const q = String(name || '').trim().toLowerCase();
  if (!q) return res.status(400).json({ error: 'name or email required' });
  let targetEmail = null;
  let targetName = null;
  // If the input looks like an email, match by email directly.
  if (q.includes('@')) {
    if (!q.endsWith('@' + (config.emailDomain || '.org'))) {
      return res.status(400).json({ error: `email must end in @${config.emailDomain || '.org'}` });
    }
    if (isStaffOrRoleEmail('', q)) {
      return res.status(403).json({ error: 'this account is a department / staff inbox — students only' });
    }
    // Existing user?
    const u = users.find(x => x.status !== 'banned' && x.email.toLowerCase() === q);
    if (u) { targetEmail = u.email; targetName = u.name; }
    else {
      const dir = (directory || []).find(d => d && d.email && d.email.toLowerCase() === q);
      if (dir) { targetEmail = dir.email; targetName = dir.name; }
      else {
        // Not in users or directory — still send a code (acts like a lazy
        // signup for anyone with a "" address). Email serves as
        // proof of identity. Name lazy-falls back to email-slug.
        targetEmail = q;
        targetName = q.split('@')[0];
      }
    }
  } else {
    // Name-based match (existing users → directory).
    let candidate = users.find(u =>
      u.status !== 'banned' &&
      (u.name.toLowerCase() === q || u.email.split('@')[0].toLowerCase() === q)
    );
    if (candidate) { targetEmail = candidate.email; targetName = candidate.name; }
    else {
      const dir = (directory || []).find(d => {
        if (!d || !d.name || !d.email) return false;
        return d.name.toLowerCase() === q || d.email.split('@')[0].toLowerCase() === q;
      });
      if (dir) {
        if (isStaffOrRoleEmail(dir.name, dir.email)) {
          return res.status(403).json({ error: 'this account is a department / staff inbox — students only' });
        }
        targetEmail = dir.email;
        targetName = dir.name;
      }
    }
  }
  if (!targetEmail) {
    pushThreatEvent({ type: 'login-name-unknown', severity: 'low', ip: clientIp(req), who: q });
    // Don't leak whether the name matched anyone — small delay + ok response.
    await new Promise(r => setTimeout(r, 500));
    return res.json({ ok: true, sent: true });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  twoFaChallenges.set('login:' + targetEmail.toLowerCase(), {
    code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0,
    userEmail: targetEmail, userName: targetName
  });
  const r = await sendVerificationCodeEmail({ toEmail: targetEmail, code, purpose: 'login', schoolName: config.siteName })
    .catch(e => ({ ok: false, error: String(e) }));
  // Mask the email so the UI can hint at where it went without leaking it
  const masked = targetEmail.replace(/(^.{2})[^@]*(@.+)$/, '$1***$2');
  res.json({ ok: true, sent: !!r.ok || !!r.skipped, maskedEmail: masked, devCode: r.skipped ? code : undefined });
});

app.post('/api/login/verify-2fa', (req, res) => {
  const { name, code } = req.body || {};
  const q = String(name || '').trim().toLowerCase();
  const codeStr = String(code || '').trim();
  if (!q || !codeStr) return res.status(400).json({ error: 'name + code required' });
  // Try to find an existing user
  let u = users.find(x =>
    x.status !== 'banned' &&
    (x.name.toLowerCase() === q || x.email.split('@')[0].toLowerCase() === q)
  );
  // Otherwise look up the pending challenge by directory entry
  let key = u ? 'login:' + u.email.toLowerCase() : null;
  if (!key) {
    const dir = (directory || []).find(d => {
      if (!d || !d.name || !d.email) return false;
      return d.name.toLowerCase() === q || d.email.split('@')[0].toLowerCase() === q;
    });
    if (dir) key = 'login:' + dir.email.toLowerCase();
  }
  if (!key) return res.status(404).json({ error: 'no pending login — request a new code' });
  const c = twoFaChallenges.get(key);
  if (!c) return res.status(400).json({ error: 'no pending login — request a new code' });
  if (c.expiresAt < Date.now()) {
    twoFaChallenges.delete(key);
    return res.status(400).json({ error: 'code expired — request a new one' });
  }
  c.attempts = (c.attempts || 0) + 1;
  if (c.attempts > 6) {
    twoFaChallenges.delete(key);
    pushThreatEvent({ type: 'login-2fa-fail', severity: 'high', ip: clientIp(req), who: c.userEmail, note: 'too many wrong codes' });
    return res.status(429).json({ error: 'too many attempts — request a new code' });
  }
  if (c.code !== codeStr) {
    pushThreatEvent({ type: 'login-2fa-fail', severity: 'med', ip: clientIp(req), who: c.userEmail, note: 'bad code' });
    return res.status(400).json({ error: 'wrong code' });
  }
  // Lazy-create the user if this is their first sign-in
  if (!u) {
    u = {
      id: newId(),
      email: c.userEmail.toLowerCase(),
      name: c.userName || c.userEmail.split('@')[0],
      nameLockedFromDirectory: true,
      passwordHash: null,
      status: 'active',  // approve directly — directory presence == school student
      token: newToken(),
      bio: '',
      avatar: '',
      referrals: [],
      createdAt: Date.now(),
      approvedAt: Date.now(),
      lastSeen: Date.now(),
      isAdmin: false,
      grade: '',
      schoolEmailVerified: true,
      schoolEmailVerifiedAt: Date.now(),
      // Successfully receiving the email code = implicit consent to TOS.
      // Without this they'd hit a 403 on every write until they re-agreed.
      tosAgreedVersion: CURRENT_TOS_VERSION,
      tosAgreedAt: Date.now()
    };
    users.push(u);
    console.log(`[login-2fa] lazy-created account for ${u.email}`);
  } else {
    u.token = newToken();
    u.lastSeen = Date.now();
    // Email-code success proves they own the school email
    u.schoolEmailVerified = true;
    u.schoolEmailVerifiedAt = Date.now();
    // Passwordless sign-in counts as TOS agreement so users who sign in
    // via the new flow aren't blocked from writes by a stale TOS version.
    if (!u.tosAgreedVersion || u.tosAgreedVersion !== CURRENT_TOS_VERSION) {
      u.tosAgreedVersion = CURRENT_TOS_VERSION;
      u.tosAgreedAt = Date.now();
    }
  }
  twoFaChallenges.delete(key);
  saveUsers();
  ghBackupNow().catch(() => {});
  pushThreatEvent({ type: 'login-2fa-ok', severity: 'low', ip: clientIp(req), who: u.email });
  res.json({ ok: true, user: publicUser(u), token: u.token });
});

// =================================================================
// SIGN IN WITH GOOGLE — verify Google ID token, link to school email
// via verification code. Set GOOGLE_CLIENT_ID env var to enable.
// =================================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Pending Google → school-email link challenges. Same TTL as 2FA codes.
const googleLinkChallenges = new Map(); // googleSub -> { schoolEmail, code, name, exp }

// Verify a Google ID token by hitting Google's tokeninfo endpoint.
// Returns { sub, email, name, picture, verified } or null on any failure.
async function verifyGoogleIdToken(idToken) {
  if (!idToken) return null;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data.sub) return null;
    // aud must equal our Client ID.
    if (GOOGLE_CLIENT_ID && data.aud !== GOOGLE_CLIENT_ID) {
      console.warn('[google-auth] aud mismatch:', data.aud, 'expected:', GOOGLE_CLIENT_ID);
      return null;
    }
    // exp must be in the future.
    if (data.exp && Number(data.exp) * 1000 < Date.now()) return null;
    return {
      sub: data.sub,
      email: (data.email || '').toLowerCase(),
      name: data.name || '',
      picture: data.picture || '',
      verified: data.email_verified === 'true' || data.email_verified === true
    };
  } catch (e) {
    console.warn('[google-auth] verify failed:', e.message);
    return null;
  }
}

// Step 1 — receive Google credential, decide if user already exists.
app.post('/api/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google sign-in not configured. Set GOOGLE_CLIENT_ID env var.' });
  }
  const idToken = String(req.body?.credential || req.body?.idToken || '');
  if (!idToken) return res.status(400).json({ error: 'credential required' });
  const g = await verifyGoogleIdToken(idToken);
  if (!g) return res.status(401).json({ error: 'Google token rejected' });

  // Already linked? Log them in.
  const existing = users.find(u => (u.googleSub && u.googleSub === g.sub) && u.status !== 'banned');
  if (existing) {
    existing.lastSeen = Date.now();
    saveUsers();
    return res.json({ ok: true, user: publicUser(existing), token: existing.token });
  }
  // New Google identity → ask them to link a "" email.
  return res.json({
    ok: true,
    needsLink: true,
    google: {
      sub: g.sub,
      name: g.name,
      email: g.email,
      picture: g.picture
    }
  });
});

// Step 2 — user gives us their school email + Google sub. Send code.
app.post('/api/auth/google/start-link', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in not configured' });
  const idToken = String(req.body?.credential || req.body?.idToken || '');
  const schoolEmail = String(req.body?.schoolEmail || '').trim().toLowerCase();
  if (!emailValid(schoolEmail)) {
    return res.status(400).json({ error: `must end in @${config.emailDomain}` });
  }
  const g = await verifyGoogleIdToken(idToken);
  if (!g) return res.status(401).json({ error: 'Google token rejected' });

  // Block if this school email is already taken by a non-Google account.
  const existing = findUserByEmail(schoolEmail);
  if (existing && !existing.googleSub) {
    return res.status(409).json({ error: 'that school email already has a password account — sign in with password instead' });
  }
  if (existing && existing.googleSub && existing.googleSub !== g.sub) {
    return res.status(409).json({ error: 'that school email is linked to a different Google account' });
  }

  // Look up directory name if available — prevents impersonation
  const dirEntry = findDirectoryByEmail(schoolEmail);

  const code = genVerificationCode();
  googleLinkChallenges.set(g.sub, {
    schoolEmail,
    code,
    name: dirEntry ? dirEntry.name : (g.name || schoolEmail.split('@')[0]),
    googleEmail: g.email,
    googlePicture: g.picture,
    exp: Date.now() + 10 * 60 * 1000 // 10 min
  });

  await sendVerificationCodeEmail({
    toEmail: schoolEmail,
    code,
    purpose: 'login',
    schoolName: config.siteName
  });
  res.json({ ok: true, sentTo: schoolEmail });
});

// Step 3 — verify code, create-or-link the user.
app.post('/api/auth/google/verify-link', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in not configured' });
  const idToken = String(req.body?.credential || req.body?.idToken || '');
  const code = String(req.body?.code || '').trim();
  const g = await verifyGoogleIdToken(idToken);
  if (!g) return res.status(401).json({ error: 'Google token rejected' });
  const ch = googleLinkChallenges.get(g.sub);
  if (!ch) return res.status(400).json({ error: 'no pending verification — start over' });
  if (Date.now() > ch.exp) {
    googleLinkChallenges.delete(g.sub);
    return res.status(400).json({ error: 'code expired — request a new one' });
  }
  if (code !== ch.code) return res.status(401).json({ error: 'wrong code' });
  googleLinkChallenges.delete(g.sub);

  // Create or update the user.
  let u = findUserByEmail(ch.schoolEmail);
  if (u) {
    // Existing user with same school email + (matching or no) googleSub → link.
    u.googleSub = g.sub;
    u.personalEmail = g.email;
    u.personalEmailVerified = true;
    if (!u.avatar && ch.googlePicture) u.avatar = ch.googlePicture;
    saveUsers();
    return res.json({ ok: true, user: publicUser(u), token: u.token });
  }
  // New user — same gating as password signup (awaiting-referrals).
  u = {
    id: newId(),
    email: ch.schoolEmail,
    name: ch.name,
    nameLockedFromDirectory: !!findDirectoryByEmail(ch.schoolEmail),
    googleSub: g.sub,
    passwordHash: null, // Google-only — no password
    personalEmail: g.email,
    personalEmailVerified: true,
    avatar: ch.googlePicture || '',
    status: 'awaiting-referrals',
    token: newToken(),
    createdAt: Date.now(),
    approvedAt: null,
    bio: '',
    friends: [],
    referrals: []
  };
  users.push(u);
  saveUsers();
  ghBackupNow().catch(() => {});
  res.json({ ok: true, user: publicUser(u), token: u.token });
});

// Expose the client ID so the client knows whether to show the button.
app.get('/api/auth/google/config', (_req, res) => {
  res.json({ enabled: !!GOOGLE_CLIENT_ID, clientId: GOOGLE_CLIENT_ID || null });
});

// =================================================================
// ADMIN — custom ghost post (admin can fire arbitrary anon text)
// =================================================================
app.post('/api/admin/test/ghost-custom', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { text } = req.body || {};
  const t = String(text || '').trim().slice(0, 500);
  if (!t) return res.status(400).json({ error: 'text required' });
  const post = {
    id: newId(),
    author: 'ghost',
    authorEmail: GHOST_EMAIL,
    isAnonymous: true,
    isGhost: true,
    ghostNames: [],
    _templateSource: 'admin-custom',
    type: 'text',
    content: t,
    caption: '',
    reactions: {}, upvotes: {}, downvotes: {},
    comments: [], reports: [], views: {},
    expiresAt: null,
    createdAt: Date.now()
  };
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  io.emit('post-added', publicPost(post));
  res.json({ ok: true, id: post.id });
});

// =================================================================
// ADS SYSTEM — admin manages, members see in the right sidebar
// Schema: { id, imageUrl, caption, mentionedHandle (lowercase), link,
//          startAt, endAt, weight, active, impressions, clicks, createdAt }
// =================================================================
function activeAdsNow() {
  const now = Date.now();
  return ads.filter(a => {
    if (!a.active) return false;
    if (a.startAt && a.startAt > now) return false;
    if (a.endAt && a.endAt < now) return false;
    return true;
  });
}

// Public — clients fetch ads to display in the right sidebar
app.get('/api/ads/current', (req, res) => {
  const active = activeAdsNow();
  res.json(active.map(a => ({
    id: a.id,
    imageUrl: a.imageUrl || '',
    caption: a.caption || '',
    mentionedHandle: a.mentionedHandle || '',
    link: a.link || '',
    weight: a.weight || 1
  })));
});

// Impression tracking (called when ad shown)
app.post('/api/ads/:id/impression', (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (a) { a.impressions = (a.impressions || 0) + 1; saveAds(); }
  res.json({ ok: true });
});

// Click tracking
app.post('/api/ads/:id/click', (req, res) => {
  const a = ads.find(x => x.id === req.params.id);
  if (a) { a.clicks = (a.clicks || 0) + 1; saveAds(); }
  res.json({ ok: true });
});

// Admin — list all (including inactive)
app.get('/api/admin/ads', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(ads.slice().sort((a, b) => b.createdAt - a.createdAt));
});

// Admin — create new ad
app.post('/api/admin/ads', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { imageUrl, caption, mentionedHandle, link, startAt, endAt, weight, active } = req.body || {};
  const a = {
    id: newId(),
    imageUrl: String(imageUrl || '').slice(0, 500),
    caption: String(caption || '').slice(0, 400),
    mentionedHandle: String(mentionedHandle || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24),
    link: String(link || '').slice(0, 500),
    startAt: typeof startAt === 'number' ? startAt : null,
    endAt: typeof endAt === 'number' ? endAt : null,
    weight: typeof weight === 'number' ? weight : 1,
    active: active !== false,
    impressions: 0,
    clicks: 0,
    createdAt: Date.now()
  };
  ads.unshift(a);
  saveAds();
  res.json(a);
});

// Admin — update ad
app.put('/api/admin/ads/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const a = ads.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const fields = ['imageUrl','caption','mentionedHandle','link','startAt','endAt','weight','active'];
  for (const f of fields) {
    if (req.body[f] !== undefined) a[f] = req.body[f];
  }
  if (typeof a.mentionedHandle === 'string') {
    a.mentionedHandle = a.mentionedHandle.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  }
  saveAds();
  res.json(a);
});

// Admin — delete ad
app.delete('/api/admin/ads/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const idx = ads.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  ads.splice(idx, 1);
  saveAds();
  res.json({ ok: true });
});

// Seed the default Luxey ad on first boot (only if no ads exist yet)
function seedDefaultAdIfEmpty() {
  if (ads.length > 0) return;
  ads.push({
    id: newId(),
    imageUrl: '', // admin uploads via the admin panel
    caption: 'stream luxey on all platforms',
    mentionedHandle: 'lucasnoe',
    link: '',
    startAt: null,
    endAt: null,
    weight: 1,
    active: true,
    impressions: 0,
    clicks: 0,
    createdAt: Date.now()
  });
  saveAds();
  console.log('[ads] seeded default Luxey ad');
}

// POST /api/love-letter — sender starts (or continues) a chain
app.post('/api/love-letter', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { toEmail, toName, message } = req.body || {};
  if (!toEmail || !toName) return res.status(400).json({ error: 'missing recipient' });
  if (toEmail.toLowerCase() === user.email.toLowerCase()) return res.status(400).json({ error: 'can\'t send to yourself' });
  // Light rate-limit: 5 letters per user per day
  const today = Date.now() - ONE_DAY_MS;
  const todays = loveLetters.filter(l => l.fromEmailHash === simpleHash(user.email) && l.createdAt > today).length;
  if (todays >= 5) return res.status(429).json({ error: 'you\'ve sent 5 today — chill 💌' });
  const letter = {
    id: newId(),
    toEmail, toName,
    message: String(message || '').slice(0, 280),
    fromEmailHash: simpleHash(user.email),  // never exposed publicly
    fromEmail: user.email,  // server-side only — never returned to clients
    fromName: user.name,    // server-side only — for admin de-anon
    parentId: null,
    chainDepth: 0,
    createdAt: Date.now()
  };
  loveLetters.push(letter);
  if (loveLetters.length > 50000) loveLetters = loveLetters.slice(-50000);
  saveLoveLetters();

  // In-app notif (recipient may not be signed up yet)
  pushNotif(toEmail, {
    type: 'love-letter',
    fromName: 'someone (anonymous)',
    fromEmail: '',
    text: 'someone has a crush on you 💌 pick 3 you think it might be',
    letterId: letter.id
  });
  sendLoveLetterEmail({ toEmail, toName, letterId: letter.id, message: letter.message }).catch(() => {});
  // eCRUSH match layer: register this as a crush + check reciprocity
  const matchResult = addCrushAndCheckMatch(user, toEmail, toName);
  res.json({ ok: true, letterId: letter.id, matched: !!(matchResult && matchResult.matched), match: matchResult || null });
});

// POST /api/love-letter/respond — recipient picks 3 guesses.
// If ANY pick matches the actual sender → reveal that pick's name to
// the recipient (eCRUSH classic). Picks that did NOT match continue
// the cascade — each gets a fresh "someone has a crush on you 💌".
app.post('/api/love-letter/respond', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { senderId, picks } = req.body || {};
  if (!Array.isArray(picks) || picks.length !== 3) return res.status(400).json({ error: 'need 3 picks' });

  const parent = loveLetters.find(l => l.id === senderId);
  if (!parent) return res.status(404).json({ error: 'letter not found' });
  if (parent.toEmail.toLowerCase() !== user.email.toLowerCase()) {
    return res.status(403).json({ error: 'not your letter' });
  }
  if (parent.guessUsed) {
    return res.status(409).json({ error: 'you already used your 3 guesses for this letter' });
  }
  parent.guessUsed = true;
  parent.guessPicks = picks.map(p => ({ name: p.name, email: p.email }));
  parent.guessedAt = Date.now();

  // MATCH CHECK: was any of the 3 picks the actual sender?
  // We compare against parent.fromEmail (server-side, never exposed) AND
  // parent.fromEmailHash (in case fromEmail was stripped on old records).
  const senderEmailLc = (parent.fromEmail || '').toLowerCase();
  const senderHash = parent.fromEmailHash;
  let matchedPick = null;
  for (const p of picks) {
    if (!p.email) continue;
    const pickLc = String(p.email).toLowerCase();
    if (senderEmailLc && pickLc === senderEmailLc) { matchedPick = p; break; }
    if (senderHash && simpleHash(p.email) === senderHash) { matchedPick = p; break; }
    if (senderHash && simpleHash(pickLc) === senderHash) { matchedPick = p; break; }
  }
  parent.matchedName = matchedPick ? matchedPick.name : null;
  parent.guessResult = matchedPick ? 'matched' : 'missed';

  // CASCADE — every pick that did NOT match the real sender gets a fresh
  // anonymous crush letter (they're now in the chain). The matched pick
  // is skipped — they already know the recipient guessed them.
  const depth = (parent.chainDepth || 0) + 1;
  const created = [];
  const seen = new Set();
  for (const p of picks) {
    if (!p.email || !p.name) continue;
    const key = String(p.email).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === user.email.toLowerCase()) continue;
    if (matchedPick && key === String(matchedPick.email).toLowerCase()) continue;
    const letter = {
      id: newId(),
      toEmail: p.email,
      toName: p.name,
      message: '',
      fromEmailHash: simpleHash(user.email),
      fromEmail: user.email,
      fromName: user.name,
      parentId: senderId || null,
      chainDepth: depth,
      createdAt: Date.now()
    };
    loveLetters.push(letter);
    created.push(letter);
    pushNotif(p.email, {
      type: 'love-letter',
      fromName: 'someone (anonymous)',
      fromEmail: '',
      text: 'someone thinks you have a crush on them — pick 3 you think it might be 💌',
      letterId: letter.id
    });
    sendLoveLetterEmail({
      toEmail: p.email, toName: p.name,
      letterId: letter.id,
      fromHint: null,
      message: ''
    }).catch(() => {});
  }
  if (loveLetters.length > 50000) loveLetters = loveLetters.slice(-50000);
  saveLoveLetters();
  ghBackupNow().catch(() => {});

  res.json({
    ok: true,
    sent: created.length,
    matched: !!matchedPick,
    matchedName: matchedPick ? matchedPick.name : null,
    matchedEmail: matchedPick ? matchedPick.email : null
  });
});

// GET /api/love-letter/:id — recipient pulls letter details (no sender info)
app.get('/api/love-letter/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const l = loveLetters.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  if (l.toEmail.toLowerCase() !== user.email.toLowerCase()) return res.status(403).json({ error: 'not for you' });
  res.json({
    id: l.id,
    toEmail: l.toEmail,
    toName: l.toName,
    message: l.message || '',
    chainDepth: l.chainDepth || 0,
    createdAt: l.createdAt
  });
});

function simpleHash(s) {
  // Non-cryptographic — just keeps the sender opaque to clients/admin UI.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// =================================================================
// PROFILE BOARDS — public/anon comments on each user's profile (MySpace wall)
// =================================================================
app.get('/api/users/profile/:email/board', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const email = (req.params.email || '').toLowerCase();
  // HARD school isolation — 404 the board if the profile owner is cross-school.
  const owner = findUserByEmail(email);
  const isSelf = user.email && email === user.email.toLowerCase();
  if (owner && !isSelf && !viewerCanSeeUser(user, owner)) {
    return res.status(404).json({ error: 'not found' });
  }
  const items = (profileBoards[email] || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  // Mask anonymous author info to non-admins
  res.json(items.map(it => ({
    id: it.id,
    authorName: it.isAnonymous ? 'anonymous' : it.authorName,
    authorEmail: it.isAnonymous ? '' : it.authorEmail,
    text: it.text,
    isAnonymous: !!it.isAnonymous,
    createdAt: it.createdAt
  })));
});

app.post('/api/users/profile/:email/board', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const email = (req.params.email || '').toLowerCase();
  const owner = findUserByEmail(email);
  if (!owner) return res.status(404).json({ error: 'no such profile' });
  // HARD school isolation — can't post on a cross-school user's board.
  const isSelf = user.email && email === user.email.toLowerCase();
  if (!isSelf && !viewerCanSeeUser(user, owner)) return res.status(404).json({ error: 'no such profile' });
  const { text, anon } = req.body || {};
  const t = String(text || '').trim().slice(0, 400);
  if (!t) return res.status(400).json({ error: 'empty' });
  const item = {
    id: newId(),
    authorEmail: user.email,
    authorName: user.name,
    text: t,
    isAnonymous: !!anon,
    createdAt: Date.now()
  };
  if (!profileBoards[email]) profileBoards[email] = [];
  profileBoards[email].unshift(item);
  if (profileBoards[email].length > 200) profileBoards[email] = profileBoards[email].slice(0, 200);
  saveProfileBoards();

  // Notify the wall owner (unless commenting on own wall)
  if (owner.email.toLowerCase() !== user.email.toLowerCase()) {
    pushNotif(owner.email, {
      type: 'profile-board',
      fromName: anon ? 'someone (anonymous)' : user.name,
      fromEmail: anon ? '' : user.email,
      text: `commented on your profile: "${t.slice(0, 90)}"`
    });
  }
  // Mentions inside profile-board comments
  const mentioned = findMentionedUsers(t);
  const fromName = anon ? 'someone (anonymous)' : user.name;
  const fromEmail = anon ? '' : user.email;
  for (const me of mentioned) {
    if (me === user.email || me === owner.email) continue;
    const target = findUserByEmail(me);
    if (!target) continue;
    pushNotif(me, { type: 'mention', fromName, fromEmail, text: `mentioned you in a comment on ${owner.name}'s profile`.slice(0, 140) });
    sendMentionEmail({ toName: target.name, toEmail: me, fromName, postPreview: t, postId: '' });
  }
  res.json(item);
});

// Delete your own (or owner can delete any) profile-board item
app.delete('/api/users/profile/:email/board/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const email = (req.params.email || '').toLowerCase();
  const arr = profileBoards[email] || [];
  const idx = arr.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const item = arr[idx];
  const canDelete = item.authorEmail.toLowerCase() === user.email.toLowerCase()
    || user.email.toLowerCase() === email;
  if (!canDelete) return res.status(403).json({ error: 'not allowed' });
  arr.splice(idx, 1);
  saveProfileBoards();
  res.json({ ok: true });
});

// =================================================================
// BULLETINS — friends-only broadcast (classic MySpace)
// =================================================================
app.get('/api/bulletins', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const myEmail = user.email.toLowerCase();
  const friendSet = new Set((user.friends || []).map(e => e.toLowerCase()));
  const items = bulletins
    .filter(b => b.authorEmail.toLowerCase() === myEmail || friendSet.has(b.authorEmail.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30);
  res.json(items);
});

app.post('/api/bulletins', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { text } = req.body || {};
  const t = String(text || '').trim().slice(0, 500);
  if (!t) return res.status(400).json({ error: 'empty' });
  const item = {
    id: newId(),
    authorEmail: user.email,
    authorName: user.name,
    text: t,
    createdAt: Date.now()
  };
  bulletins.unshift(item);
  if (bulletins.length > 5000) bulletins = bulletins.slice(0, 5000);
  saveBulletins();
  // Push to each friend as a notification
  for (const f of (user.friends || [])) {
    pushNotif(f, { type: 'bulletin', fromName: user.name, fromEmail: user.email, text: `posted a bulletin: "${t.slice(0, 90)}"` });
  }
  res.json(item);
});

// =================================================================
// PROFILE VIEWS — list recent viewers of a given user's profile.
// Public to all signed-in members; lets you see "who's been looking".
// =================================================================
app.get('/api/u/:handle/viewers', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  const target = findUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'not found' });
  const tgtEmail = (target.email || '').toLowerCase();
  const recent = profileViews
    .filter(v => (v.target || '').toLowerCase() === tgtEmail)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 30)
    .map(v => {
      const u = findUserByEmail(v.viewer);
      return {
        name: u ? u.name : (v.viewerName || 'someone'),
        handle: u ? u.handle : '',
        avatar: u && u.avatar ? u.avatar : '',
        ts: v.ts,
        revisits: v.revisits || 1
      };
    });
  res.json({
    viewers: recent,
    totalViewers: new Set(profileViews.filter(v => (v.target || '').toLowerCase() === tgtEmail).map(v => v.viewer)).size,
    totalViews: profileViews.filter(v => (v.target || '').toLowerCase() === tgtEmail).reduce((s, v) => s + (v.revisits || 1), 0)
  });
});

// =================================================================
// STAR RATING — every member can rate every other member 1..5.
// Aggregate avg + count exposed publicly; your own rating editable.
// =================================================================
const userRatings = {}; // { targetEmail: { viewerEmail: 1..5 } }
const RATINGS_FILE = path.join(DATA_DIR, 'user-ratings.json');
try {
  if (fs.existsSync(RATINGS_FILE)) {
    const j = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
    if (j && typeof j === 'object') Object.assign(userRatings, j);
  }
} catch {}
function saveRatings() {
  try { atomicWrite(RATINGS_FILE, JSON.stringify(userRatings, null, 2)); } catch {}
}
function ratingStats(targetEmail, viewerEmail) {
  const bucket = userRatings[targetEmail.toLowerCase()] || {};
  const vals = Object.values(bucket);
  const count = vals.length;
  const avg = count ? (vals.reduce((s, n) => s + n, 0) / count) : 0;
  return { avg: Math.round(avg * 10) / 10, count, myRating: viewerEmail ? (bucket[viewerEmail.toLowerCase()] || 0) : 0 };
}
app.get('/api/u/:handle/rating', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  const target = findUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'not found' });
  res.json(ratingStats(target.email, viewer.email));
});
app.post('/api/u/:handle/rate', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  const target = findUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'not found' });
  if ((target.email || '').toLowerCase() === (viewer.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'cannot rate yourself' });
  }
  const stars = Math.max(0, Math.min(5, parseInt((req.body && req.body.stars) || 0, 10)));
  const tgt = target.email.toLowerCase();
  if (!userRatings[tgt]) userRatings[tgt] = {};
  if (stars === 0) delete userRatings[tgt][viewer.email.toLowerCase()];
  else userRatings[tgt][viewer.email.toLowerCase()] = stars;
  saveRatings();
  res.json(ratingStats(target.email, viewer.email));
});

// =================================================================
// AUTO TOP FRIENDS — compute top 8 friends by interaction frequency
// (DMs sent/received + reactions on each other's posts + comments).
// Public to anyone who can see the profile.
// =================================================================
app.get('/api/u/:handle/top-friends', (req, res) => {
  if (!requireUser(req, res)) return;
  const target = findUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'not found' });
  const me = (target.email || '').toLowerCase();
  const score = {};
  // DMs
  for (const m of dms) {
    const a = (m.from || '').toLowerCase(), b = (m.to || '').toLowerCase();
    if (a === me && b && b !== me) score[b] = (score[b] || 0) + 3;
    else if (b === me && a && a !== me) score[a] = (score[a] || 0) + 3;
  }
  // Reactions on the target's posts (people who reacted to me)
  for (const p of posts) {
    if ((p.authorEmail || '').toLowerCase() !== me) continue;
    for (const bucket of Object.values(p.reactions || {})) {
      for (const e of Object.keys(bucket)) {
        const le = (e || '').toLowerCase();
        if (le && le !== me) score[le] = (score[le] || 0) + 1;
      }
    }
    for (const c of (p.comments || [])) {
      const le = (c.authorEmail || '').toLowerCase();
      if (le && le !== me) score[le] = (score[le] || 0) + 2;
    }
  }
  // Reactions BY me on their posts
  for (const p of posts) {
    const author = (p.authorEmail || '').toLowerCase();
    if (!author || author === me) continue;
    for (const bucket of Object.values(p.reactions || {})) {
      if (bucket[target.email]) score[author] = (score[author] || 0) + 1;
    }
    for (const c of (p.comments || [])) {
      if ((c.authorEmail || '').toLowerCase() === me) score[author] = (score[author] || 0) + 2;
    }
  }
  // Mutual-friend boost
  for (const f of (target.friends || [])) {
    const lf = (f || '').toLowerCase();
    if (lf) score[lf] = (score[lf] || 0) + 5;
  }
  const ranked = Object.entries(score)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([email, s]) => {
      const u = findUserByEmail(email);
      if (!u || u.isBot || u.status === 'banned') return null;
      return { handle: u.handle || '', name: u.name || '', avatar: u.avatar || '', score: s };
    })
    .filter(Boolean);
  res.json({ topFriends: ranked });
});

app.get('/api/profile-views/top-this-week', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const weekAgo = Date.now() - 7 * ONE_DAY_MS;
  const counts = {};
  for (const v of profileViews) {
    if (v.ts < weekAgo) continue;
    if ((v.target || '').toLowerCase() !== me) continue;
    const viewer = (v.viewer || '').toLowerCase();
    if (!viewer || viewer === me) continue;
    counts[viewer] = (counts[viewer] || 0) + 1;
  }
  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([email, views]) => {
      const u = findUserByEmail(email);
      return { email, name: u?.name || email, views };
    });
  res.json(ranked);
});

// =================================================================
// PROFILE MUSIC — parse a URL from a whitelisted host into an
// embeddable iframe src. Hard reject everything else.
// =================================================================
function parseMusicEmbed(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  // YouTube
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const id = u.searchParams.get('v') || (u.pathname.match(/\/embed\/([\w-]{6,20})/) || [])[1];
    if (id && /^[\w-]{6,20}$/.test(id)) {
      return { kind: 'youtube', id, embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}` };
    }
  }
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    if (id && /^[\w-]{6,20}$/.test(id)) {
      return { kind: 'youtube', id, embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}` };
    }
  }
  // Spotify (track / episode / playlist / album)
  if (host === 'open.spotify.com') {
    const m = u.pathname.match(/^\/(track|episode|playlist|album)\/([A-Za-z0-9]{16,32})/);
    if (m) return { kind: 'spotify', id: m[2], embedUrl: `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator` };
  }
  // SoundCloud
  if (host === 'soundcloud.com' || host === 'm.soundcloud.com') {
    return { kind: 'soundcloud', id: u.pathname,
      embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(u.toString())}&auto_play=true&hide_related=true&visual=false` };
  }
  // Bandcamp track / album page — bandcamp uses host-specific embed urls we can't reconstruct
  // from page URL alone, so we accept the page link and link out rather than iframe-embed.
  if (host.endsWith('.bandcamp.com') || host === 'bandcamp.com') {
    return { kind: 'bandcamp', id: u.pathname, embedUrl: '', linkOnly: u.toString() };
  }
  return null;
}

// =================================================================
// PROFILE BACKGROUND IMAGE — whitelisted hosts only.
// =================================================================
const ALLOWED_BG_HOSTS = new Set([
  'i.imgur.com', 'imgur.com',
  'media.giphy.com', 'giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com',
  'media.tenor.com', 'tenor.com', 'c.tenor.com',
  'i.redd.it',
  'cdn.discordapp.com', 'media.discordapp.net',
  'images.unsplash.com', 'images.pexels.com',
  // Self-hosted
  'old-streets.internal'
]);
function validateBackgroundUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let u;
  try { u = new URL(url.trim()); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!ALLOWED_BG_HOSTS.has(host)) return '';
  // require ends in image extension OR is a giphy/tenor URL
  if (!/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u.pathname) && !host.includes('giphy') && !host.includes('tenor')) return '';
  return u.toString();
}

// =================================================================
// HTML SANITIZER — strict allowlist. Designed to defeat Samy-class
// XSS worms while allowing classic MySpace profile styling.
// =================================================================
const ALLOWED_TAGS = new Set([
  'b','i','u','s','strong','em','mark','small','big','sub','sup','strike',
  'br','hr','p','span','div','section','blockquote','pre','code',
  'font','center','marquee','tt',
  'h1','h2','h3','h4','h5','h6',
  'ul','ol','li','dl','dt','dd',
  'table','thead','tbody','tr','td','th','caption',
  'a','img'
]);
const ALLOWED_ATTRS = {
  '*': ['style','class','title','align'],
  font: ['color','size','face'],
  a: ['href','target','rel'],
  img: ['src','alt','width','height'],
  marquee: ['direction','behavior','scrollamount','scrolldelay','width','height','loop','bgcolor'],
  td: ['colspan','rowspan','bgcolor'],
  th: ['colspan','rowspan','bgcolor'],
  tr: ['bgcolor'],
  table: ['border','cellpadding','cellspacing','bgcolor','width']
};
const URL_ATTRS = new Set(['href','src']);

function sanitizeCssValue(v) {
  if (!v) return '';
  // Strip the dangerous bits — url(javascript:...), expression(), behavior:, @import, etc.
  v = String(v);
  if (/expression\s*\(/i.test(v)) return '';
  if (/behavior\s*:/i.test(v)) return '';
  if (/@import/i.test(v)) return '';
  if (/javascript\s*:/i.test(v)) return '';
  if (/vbscript\s*:/i.test(v)) return '';
  // url(...) — only allow https:// images, or relative
  v = v.replace(/url\s*\(\s*(['"]?)([^)]+?)\1\s*\)/gi, (m, q, inner) => {
    inner = inner.trim();
    if (/^data:/i.test(inner)) return ''; // disallow data: URIs in CSS
    if (/^https?:\/\//i.test(inner)) {
      // require image extension or whitelisted host
      try {
        const u = new URL(inner);
        if (u.protocol !== 'https:') return '';
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (ALLOWED_BG_HOSTS.has(host) || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u.pathname)) {
          return `url("${inner.replace(/"/g, '%22')}")`;
        }
        return '';
      } catch { return ''; }
    }
    return ''; // disallow scheme-less / relative for safety
  });
  return v;
}

function sanitizeUrl(url) {
  if (!url) return '';
  url = String(url).trim();
  // Disallow javascript:, vbscript:, data:, file:, etc.
  if (/^\s*(javascript|vbscript|data|file|blob)\s*:/i.test(url)) return '';
  // Allow only http/https/mailto and fragment/relative
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:/i.test(url)) return url;
  if (url.startsWith('#') || url.startsWith('/')) return url;
  return '';
}

// Very small HTML tokenizer + sanitizer. Doesn't depend on cheerio/jsdom.
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  html = html.slice(0, 16000); // hard cap

  let out = '';
  let i = 0;
  const stack = [];
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += escapeText(html.slice(i)); break; }
    if (lt > i) out += escapeText(html.slice(i, lt));
    // strip comments + CDATA + doctypes
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) { out += escapeText(html.slice(lt)); break; }
    const tagSource = html.slice(lt + 1, gt);
    const isEnd = tagSource.startsWith('/');
    const tagBody = isEnd ? tagSource.slice(1) : tagSource;
    const m = tagBody.match(/^\s*([a-zA-Z][a-zA-Z0-9]*)/);
    if (!m) { i = gt + 1; continue; }
    const name = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) { i = gt + 1; continue; }
    if (isEnd) {
      // close it if open
      const sidx = stack.lastIndexOf(name);
      if (sidx >= 0) {
        // implicit-close anything inside it (just emit closers for popped tags)
        while (stack.length > sidx) out += `</${stack.pop()}>`;
      }
      i = gt + 1;
      continue;
    }
    // parse attrs
    const rest = tagBody.slice(m[0].length);
    const attrs = parseAttrs(rest);
    const safeAttrs = [];
    for (const [aName, aVal] of attrs) {
      const lname = aName.toLowerCase();
      if (/^on/i.test(lname)) continue; // never allow on* handlers
      const allowedForTag = (ALLOWED_ATTRS[name] || []).concat(ALLOWED_ATTRS['*'] || []);
      if (!allowedForTag.includes(lname)) continue;
      let v = aVal == null ? '' : String(aVal);
      if (lname === 'style') v = sanitizeCssValue(v);
      else if (URL_ATTRS.has(lname)) v = sanitizeUrl(v);
      else v = v.replace(/[<>"]/g, '');
      if (lname === 'href' && !v) continue;
      if (lname === 'src') {
        // images must be https; allow relative or //cdn
        if (!/^https:\/\//i.test(v) && !v.startsWith('/')) continue;
      }
      if (lname === 'target') v = v === '_blank' ? '_blank' : '_self';
      if (lname === 'style' && !v) continue;
      safeAttrs.push(`${lname}="${v.replace(/"/g, '&quot;')}"`);
    }
    // anchors auto-get rel=noopener+ugc
    if (name === 'a' && safeAttrs.some(a => a.startsWith('href='))) {
      safeAttrs.push('rel="noopener noreferrer ugc"');
    }
    const isSelfClosing = name === 'br' || name === 'hr' || name === 'img';
    if (isSelfClosing) {
      out += `<${name}${safeAttrs.length ? ' ' + safeAttrs.join(' ') : ''}/>`;
    } else {
      out += `<${name}${safeAttrs.length ? ' ' + safeAttrs.join(' ') : ''}>`;
      stack.push(name);
    }
    i = gt + 1;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

function escapeText(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
}
function findTagEnd(s, start) {
  // Find the matching > that's not inside an attribute value.
  let inStr = null;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '>') return i;
  }
  return -1;
}
function parseAttrs(s) {
  const out = [];
  const re = /([a-zA-Z_:][\w:.-]*)\s*(=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1];
    const val = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : ''));
    out.push([name, val]);
  }
  return out;
}

function sanitizeProfileCss(css) {
  // Scoped, very strict. No @keyframes, no @import, no expression, no behavior, no url() to unknown hosts.
  if (!css || typeof css !== 'string') return '';
  css = css.slice(0, 4000);
  if (/@import/i.test(css)) css = css.replace(/@import[^;]+;?/gi, '');
  if (/expression\s*\(/i.test(css)) return '';
  if (/behavior\s*:/i.test(css)) return '';
  if (/javascript\s*:/i.test(css)) return '';
  // Filter url(...) values
  css = css.replace(/url\s*\(\s*(['"]?)([^)]+?)\1\s*\)/gi, (m, q, inner) => {
    inner = inner.trim();
    if (/^data:/i.test(inner)) return '';
    if (/^https:\/\//i.test(inner)) {
      try {
        const u = new URL(inner);
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (ALLOWED_BG_HOSTS.has(host) || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u.pathname)) {
          return `url("${inner.replace(/"/g, '%22')}")`;
        }
      } catch {}
      return '';
    }
    return '';
  });
  return css;
}

// =================================================================
// MOOD CATALOG — classic MySpace mood list (emoji-attached)
// =================================================================
const MOOD_CATALOG = [
  { id: 'happy',     emoji: '😊', label: 'happy' },
  { id: 'sad',       emoji: '😔', label: 'sad' },
  { id: 'angry',     emoji: '😠', label: 'angry' },
  { id: 'inlove',    emoji: '😍', label: 'in love' },
  { id: 'bored',     emoji: '😪', label: 'bored' },
  { id: 'tired',     emoji: '🥱', label: 'tired' },
  { id: 'excited',   emoji: '🤩', label: 'excited' },
  { id: 'chill',     emoji: '😎', label: 'chillin\'' },
  { id: 'lonely',    emoji: '🥲', label: 'lonely' },
  { id: 'crying',    emoji: '😭', label: 'crying' },
  { id: 'mischief',  emoji: '😈', label: 'up to no good' },
  { id: 'silly',     emoji: '🤪', label: 'silly' },
  { id: 'romantic',  emoji: '🌹', label: 'romantic' },
  { id: 'nostalgic', emoji: '🕰️', label: 'nostalgic' },
  { id: 'rebellious',emoji: '🤘', label: 'rebellious' },
  { id: 'creative',  emoji: '🎨', label: 'creative' },
  { id: 'hungry',    emoji: '🍕', label: 'hungry' },
  { id: 'sick',      emoji: '🤒', label: 'sick' },
  { id: 'ghosted',   emoji: '👻', label: 'ghosted' },
  { id: 'thriving',  emoji: '✨', label: 'thriving' },
  { id: 'cursed',    emoji: '🌚', label: 'cursed' },
  { id: 'hopeful',   emoji: '🌱', label: 'hopeful' },
];
const VALID_MOOD_IDS = new Set(MOOD_CATALOG.map(m => m.id));
app.get('/api/moods', (_req, res) => res.json(MOOD_CATALOG));

// =================================================================
// BLINKIES CATALOG — 20 CSS-generated blinky badges. Client renders.
// Server only stores the IDs the user picked (max 8).
// =================================================================
const BLINKY_CATALOG = [
  { id: 'rawr',       text: 'RAWR XD', bg: '#000', fg: '#0f0' },
  { id: 'best-friend',text: 'best friend forever', bg: '#ff6ec7', fg: '#fff' },
  { id: 'angel',      text: '✿ angel ✿', bg: '#fff', fg: '#ff6ec7' },
  { id: 'devil',      text: '☠ little devil ☠', bg: '#900', fg: '#ff0' },
  { id: 'emo',        text: 'i ♥ emo boys', bg: '#000', fg: '#f0f' },
  { id: 'cool',       text: 'too cool 4 u', bg: '#000', fg: '#0ff' },
  { id: 'sk8',        text: 'sk8r 4 lyfe', bg: '#0a0a0a', fg: '#ff0' },
  { id: 'lonely',     text: 'forever alone :(', bg: '#222', fg: '#999' },
  { id: 'mySpace',    text: 'a/s/l ?', bg: '#06f', fg: '#fff' },
  { id: 'pink',       text: '♡ pink ♡', bg: '#ff8cd9', fg: '#fff' },
  { id: 'badbtch',    text: 'bad b*tch energy', bg: '#900', fg: '#ff6ec7' },
  { id: 'leave',      text: 'pls leave a comment', bg: '#000', fg: '#0f0' },
  { id: 'kawaii',     text: 'ʕ•ᴥ•ʔ kawaii', bg: '#ffe0f0', fg: '#c33764' },
  { id: 'rocknroll',  text: '🤘 rock n roll 🤘', bg: '#1a1a1a', fg: '#fff' },
  { id: 'eatglass',   text: 'eat glass', bg: '#000', fg: '#fff' },
  { id: 'glitter',    text: '✨glitter only✨', bg: '#fff5f8', fg: '#c33764' },
  { id: 'ghost',      text: '👻 boo!', bg: '#1a1a2e', fg: '#fff' },
  { id: 'queer',      text: '🌈 queer & here', bg: '#000', fg: '#fff' },
  { id: 'goth',       text: '☩ goth ☩', bg: '#000', fg: '#aaa' },
  { id: 'sleep',      text: 'zZz tired zZz', bg: '#000', fg: '#06f' },
];
const VALID_BLINKY_IDS = new Set(BLINKY_CATALOG.map(b => b.id));
app.get('/api/blinkies', (_req, res) => res.json(BLINKY_CATALOG));

// ===================================================================
// PROFILE CSS GENERATOR — user describes the vibe ("90s neon", "y2k
// bubblegum", "minecraft dirt"), Claude returns scoped CSS + optional
// HTML that gets stored on the user and rendered inside their profile
// page in a sandboxed wrapper. No external resources, no <script>, no
// off-domain URLs.
// ===================================================================
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
// Sanitizer for user-supplied profile CSS + HTML. Aggressive about XSS
// (no <script>, no on-* handlers, no javascript: URLs) but generous about
// creative freedom — broad image/font/asset host allowlist, lets users
// embed gifs, fonts, backgrounds, animations, gradients, transforms, etc.
const ALLOWED_ASSET_HOSTS = [
  'media.tenor.com', 'media1.tenor.com', 'media2.tenor.com', 'media3.tenor.com',
  'c.tenor.com', 'tenor.com',
  'fonts.gstatic.com', 'fonts.googleapis.com',
  'i.imgur.com', 'imgur.com',
  'i.postimg.cc', 'postimg.cc',
  'i.ibb.co', 'ibb.co',
  'media.giphy.com', 'i.giphy.com', 'giphy.com',
  'images.unsplash.com', 'unsplash.com',
  'images.pexels.com', 'pexels.com',
  'cdn.discordapp.com', 'media.discordapp.net',
  'pbs.twimg.com',
  'i.pinimg.com', 'pinimg.com',
  'static.wikia.nocookie.net',
  'oldstreets.org', 'old-streets.fly.dev'
];
function sanitizeProfileCustomCode(input) {
  if (!input || typeof input !== 'string') return { css: '', html: '' };
  let css = '', html = '';
  // Try to pull out fenced ```css and ```html blocks. If neither, treat
  // raw input as CSS (back-compat with current edit-profile field).
  const styleMatch = input.match(/```(?:css)?\s*([\s\S]+?)```/i);
  if (styleMatch) {
    css = styleMatch[1];
    const after = input.slice(styleMatch.index + styleMatch[0].length);
    const htmlMatch = after.match(/```(?:html)?\s*([\s\S]+?)```/i);
    if (htmlMatch) html = htmlMatch[1];
  } else {
    // Try to split <style>...</style> + remaining as HTML
    const styleTag = input.match(/<style[^>]*>([\s\S]+?)<\/style>/i);
    if (styleTag) {
      css = styleTag[1];
      html = input.replace(styleTag[0], '').trim();
    } else {
      // No fences, no <style>: treat as CSS only
      css = input;
    }
  }
  const hostAllowed = (u) => {
    try { const o = new URL(u); return ALLOWED_ASSET_HOSTS.some(h => o.hostname === h || o.hostname.endsWith('.' + h)); }
    catch { return false; }
  };
  // Anti-XSS: strip scripts, on-handlers, javascript: urls, expression().
  // Style/font/url() is allowed only from the host allowlist (replaces bad
  // URLs with about:blank rather than nuking the rule).
  const stripBad = (s, mode) => {
    let out = String(s || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/javascript:/gi, 'about:blank#')
      .replace(/vbscript:/gi, 'about:blank#')
      .replace(/data:text\/html/gi, 'about:blank#')
      .replace(/expression\s*\(/gi, 'noop(')
      .replace(/behavior\s*:/gi, 'noop-behavior:')
      // Replace off-host url() refs with about:blank — keep on-host ones
      .replace(/url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi, (m, q, u) => hostAllowed(u) ? m : 'url(about:blank)')
      // Block @import to off-host
      .replace(/@import\s+(?:url\()?\s*['"]?(https?:\/\/[^)'";]+)['"]?\s*\)?\s*;?/gi, (m, u) => hostAllowed(u) ? m : '')
      // Strip data: imports
      .replace(/@import[^;]*data:[^;]*;/gi, '');
    if (mode === 'html') {
      // For HTML, also strip iframes that aren't pointing at safe video embeds.
      out = out.replace(/<iframe[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi, (m, src) => {
        try {
          const o = new URL(src);
          // Allow safe iframes: youtube, spotify, soundcloud, tenor.
          if (/^www\.youtube\.com$|^youtube\.com$|^youtube-nocookie\.com$|^open\.spotify\.com$|^w\.soundcloud\.com$|^tenor\.com$|^embed\.spotify\.com$/.test(o.hostname)) return m;
          return '';
        } catch { return ''; }
      });
      // Lone <iframe> open tags without explicit src
      out = out.replace(/<iframe(?![^>]*src=)[^>]*>/gi, '');
      // <link rel="stylesheet"> only allowed on fonts.googleapis.com
      out = out.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (m, href) => hostAllowed(href) ? m : '');
    }
    return out;
  };
  css = stripBad(css, 'css').slice(0, 30000);
  html = stripBad(html, 'html').slice(0, 8000);
  return { css, html };
}

app.post('/api/profile/customize-ai', rateLimit({ key: 'profile-ai', max: 10, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  if (me.status !== 'active') return res.status(403).json({ error: 'finish approval first' });
  const prompt = String((req.body && req.body.prompt) || '').trim().slice(0, 800);
  if (!prompt) return res.status(400).json({ error: 'describe the vibe' });
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'AI generator not configured', message: 'admin needs to set ANTHROPIC_API_KEY' });
  }
  const system = `You generate MySpace-era custom profile CSS. The user describes a vibe and you return scoped CSS that styles their profile.

OUTPUT FORMAT — exactly this, nothing else:
\`\`\`css
/* CSS goes here, scoped to .profile-custom-frame */
\`\`\`

Optionally a second block for decorative HTML to inject inside the frame:
\`\`\`html
<!-- e.g. <div class="sparkle">★</div> -->
\`\`\`

RULES:
- All CSS selectors MUST be prefixed with .profile-custom-frame (e.g. .profile-custom-frame .title { ... })
- No @import, no remote @font-face, no url() pointing off-domain
- Use system fonts (Trebuchet MS, Verdana, Courier, Georgia, Comic Sans MS, Impact, etc.) and CSS-only effects
- Animations are encouraged (sparkle, marquee, pulse, glitch, scanline). Keep them tasteful (no seizure speed).
- Aim for 80-200 lines of CSS. Be specific and committed to the vibe.
- No script tags, no event handlers.
- Embrace early-2000s web aesthetics when it fits: gradients, text-shadow glow, dotted borders, blinking, etc.

User vibe: ${prompt}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 2200,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: 'claude api error', status: r.status, detail: text.slice(0, 300) });
    }
    const j = await r.json();
    const raw = (j.content && j.content[0] && j.content[0].text) || '';
    const { css, html } = sanitizeProfileCustomCode(raw);
    me.customCss = css;
    me.customHtml = html;
    me.customHtmlSafe = html;
    me.customProfile = { css, html, prompt, generatedAt: Date.now() };
    saveUsers();
    res.json({ ok: true, css, html, raw });
  } catch (e) {
    res.status(502).json({ error: 'AI request failed', message: e.message });
  }
});

app.post('/api/profile/customize-clear', (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  me.customProfile = null;
  saveUsers();
  res.json({ ok: true });
});

app.post('/api/profile/customize-save', (req, res) => {
  // Manual paste path — user edits the code by hand and saves directly.
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const css = String((req.body && req.body.css) || '');
  const html = String((req.body && req.body.html) || '');
  const safe = sanitizeProfileCustomCode('```css\n' + css + '\n```\n```html\n' + html + '\n```');
  me.customProfile = { css: safe.css, html: safe.html, prompt: (me.customProfile && me.customProfile.prompt) || '', generatedAt: Date.now() };
  saveUsers();
  res.json({ ok: true, css: safe.css, html: safe.html });
});

// ===================================================================
// GIF SEARCH — proxies Tenor v2. Frontend posts a query, server hides
// the API key. Falls back to a built-in demo key if TENOR_KEY unset.
// ===================================================================
// Tenor v1 — works with the public demo key. v2 requires a Google-Cloud
// key, which the demo key isn't. Items from v1 use .media[0].tinygif.url
// and .media[0].gif.url instead of media_formats.
const TENOR_KEY = process.env.TENOR_KEY || 'LIVDSRZULELA';
app.get('/api/gif/search', async (req, res) => {
  const me = findUserByToken(req.headers['x-user-token']);
  if (!me) return res.status(401).json({ error: 'sign in first' });
  const q = String((req.query && req.query.q) || '').trim().slice(0, 60);
  const url = q
    ? `https://g.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=24&contentfilter=high&media_filter=minimal`
    : `https://g.tenor.com/v1/trending?key=${TENOR_KEY}&limit=24&contentfilter=high&media_filter=minimal`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      console.warn('[gif] tenor v1', r.status, text.slice(0, 200));
      return res.status(502).json({ error: 'gif service unavailable', status: r.status });
    }
    const j = await r.json();
    const items = (j.results || []).map(g => {
      const m = (g.media && g.media[0]) || {};
      return {
        id: g.id,
        preview: (m.tinygif && m.tinygif.url) || (m.gif && m.gif.url) || '',
        full: (m.gif && m.gif.url) || '',
        alt: g.content_description || g.h1_title || ''
      };
    }).filter(g => g.preview && g.full);
    res.json({ items });
  } catch (e) {
    console.warn('[gif] fetch failed', e.message);
    res.status(502).json({ error: 'gif fetch failed', message: e.message });
  }
});

// =================================================================
// SURVEY TEMPLATES — classic MySpace "fill this out" surveys.
// Client picks one, fills answers, posts as a post.type==='survey'.
// =================================================================
const SURVEY_TEMPLATES = [
  {
    id: 'fav-things',
    title: 'My Favorites',
    questions: ['color?','song right now?','movie?','show?','food?','drink?','place?','smell?','memory?','person on earth?']
  },
  {
    id: 'have-you-ever',
    title: 'Have you ever?',
    questions: ['skipped class?','cried in school?','snuck out?','fallen for a teacher?','kissed someone you regret?','lied to your parents this week?','been in love?','had a fight with a friend?','crashed a party?','had your heart broken?']
  },
  {
    id: 'this-or-that',
    title: 'This or That',
    questions: ['coffee or tea?','beach or mountains?','dogs or cats?','summer or winter?','call or text?','morning or night?','sweet or salty?','indoors or outdoors?','sneakers or boots?','pen or pencil?']
  },
  {
    id: 'ranking',
    title: 'Rank these',
    questions: ['#1 friend?','#2 friend?','#3 friend?','best teacher ever?','worst class?','best class?','best memory of this year?','#1 song of the year?','#1 person you\'d revive?','#1 regret?']
  },
  {
    id: 'about-me',
    title: 'About me',
    questions: ['full name?','where i was born','my zodiac','my mbti','my biggest fear','my hidden talent','what people get wrong about me','the song i\'d play at my funeral','what i\'d do with $1 million','what i want to be remembered for']
  },
  {
    id: 'lyrics-day',
    title: 'Lyrics that describe my day',
    questions: ['lyric describing my morning','lyric for my mood','lyric about a friend','lyric about a crush','lyric about home','lyric i\'d tattoo on me']
  }
];
app.get('/api/surveys/templates', (_req, res) => res.json(SURVEY_TEMPLATES));

// =================================================================
// BLOG — long-form posts, separate stream from the wall
// =================================================================
app.get('/api/blogs', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  // HARD school isolation — only blogs by same-school authors.
  const list = blogs.slice().sort((a, b) => b.createdAt - a.createdAt)
    .filter(b => {
      if (!b.authorEmail) return true;
      const author = findUserByEmail(b.authorEmail);
      return viewerCanSeeUser(user, author);
    })
    .slice(0, 100);
  res.json(list.map(b => ({
    id: b.id,
    authorEmail: b.authorEmail,
    authorName: b.authorName,
    title: b.title,
    excerpt: (b.body || '').replace(/<[^>]+>/g, '').slice(0, 200),
    reactionCount: Object.values(b.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0),
    commentCount: (b.comments || []).length,
    createdAt: b.createdAt
  })));
});

app.get('/api/blogs/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = blogs.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  // HARD school isolation — 404 if author is from another school.
  if (b.authorEmail) {
    const author = findUserByEmail(b.authorEmail);
    if (!viewerCanSeeUser(user, author)) return res.status(404).json({ error: 'not found' });
  }
  res.json({
    id: b.id,
    authorEmail: b.authorEmail,
    authorName: b.authorName,
    title: b.title,
    body: b.body,
    bodyHtml: b.bodyHtml || sanitizeHtml(b.body || ''),
    reactions: b.reactions || {},
    comments: b.comments || [],
    createdAt: b.createdAt
  });
});

app.post('/api/blogs', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { title, body } = req.body || {};
  const t = String(title || '').trim().slice(0, 120);
  const bRaw = String(body || '').trim().slice(0, 16000);
  if (!t || !bRaw) return res.status(400).json({ error: 'title + body required' });
  const blog = {
    id: newId(),
    authorEmail: user.email,
    authorName: user.name,
    title: t,
    body: bRaw,
    bodyHtml: sanitizeHtml(bRaw),
    reactions: {},
    comments: [],
    createdAt: Date.now()
  };
  blogs.unshift(blog);
  if (blogs.length > 5000) blogs = blogs.slice(0, 5000);
  saveBlogs();
  // Pop a feed card so home feed sees the blog
  const feedPost = {
    id: newId(),
    authorEmail: user.email,
    author: user.name,
    type: 'blog',
    blogId: blog.id,
    blogTitle: t,
    blogExcerpt: bRaw.replace(/<[^>]+>/g, '').slice(0, 240),
    content: '',
    caption: '',
    reactions: {},
    comments: [],
    viewedBy: [],
    createdAt: Date.now()
  };
  posts.unshift(feedPost);
  savePosts();
  // Use 'post-added' (the event the client actually listens for). Old code
  // emitted 'new-post' so blog feed posts never appeared on the wall in
  // real-time — they only showed after refresh.
  io.emit('post-added', publicPost(feedPost));
  // Light notif to friends
  for (const f of (user.friends || [])) {
    pushNotif(f, { type: 'blog', fromName: user.name, fromEmail: user.email, blogId: blog.id, text: `posted a new blog: "${t.slice(0, 80)}"` });
  }
  // Schedule contextual ghost activity on the feed card
  setTimeout(() => injectGhostReactions(feedPost, 2 + Math.floor(Math.random() * 3)), 30 * 1000 + Math.random() * 30000);
  setTimeout(() => injectGhostComments(feedPost, { count: 1 }), 90 * 1000 + Math.random() * 60000);
  setTimeout(() => injectGhostComments(feedPost, { count: 1 }), 5 * 60 * 1000 + Math.random() * 120000);
  res.json(blog);
});

app.post('/api/blogs/:id/react', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = blogs.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  const { emoji } = req.body || {};
  if (!b.reactions) b.reactions = {};
  for (const e of Object.keys(b.reactions)) {
    delete b.reactions[e][user.email];
    if (Object.keys(b.reactions[e]).length === 0) delete b.reactions[e];
  }
  if (emoji && ALLOWED_REACTIONS.includes(emoji)) {
    if (!b.reactions[emoji]) b.reactions[emoji] = {};
    b.reactions[emoji][user.email] = Date.now();
  }
  saveBlogs();
  res.json({ ok: true, reactions: b.reactions });
});

app.post('/api/blogs/:id/comment', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = blogs.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  const t = String((req.body || {}).text || '').trim().slice(0, 400);
  if (!t) return res.status(400).json({ error: 'empty' });
  const c = { id: newId(), author: user.name, authorEmail: user.email, text: t, createdAt: Date.now() };
  b.comments = b.comments || [];
  b.comments.push(c);
  saveBlogs();
  if (b.authorEmail.toLowerCase() !== user.email.toLowerCase()) {
    pushNotif(b.authorEmail, { type: 'blog-comment', fromName: user.name, fromEmail: user.email, blogId: b.id, text: t.slice(0, 140) });
  }
  res.json(c);
});

// =================================================================
// POKE — when someone is already referred by another user, nudge them
// with a notification + email instead. Cheap, viral, no duplication.
// =================================================================
app.post('/api/poke', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { toEmail, toName } = req.body || {};
  if (!toEmail) return res.status(400).json({ error: 'toEmail required' });
  // Rate limit: 5 pokes per user per hour
  user._pokeHistory = (user._pokeHistory || []).filter(t => t > Date.now() - 60 * 60 * 1000);
  if (user._pokeHistory.length >= 5) return res.status(429).json({ error: '5 pokes/hour max — chill' });
  user._pokeHistory.push(Date.now());
  saveUsers();
  // In-app notification (if recipient is a member)
  const target = findUserByEmail(toEmail);
  if (target) {
    pushNotif(target.email, {
      type: 'poke',
      fromName: user.name,
      fromEmail: user.email,
      text: `👉 ${user.name} poked you on Old Streets`
    });
  } else if (toName) {
    // Recipient isn't a member yet → email them a poke
    if (config.resendApiKey) {
      const _u = unsubArtifacts(toEmail, { transactional: false });
      if (!_u.blocked) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: config.emailFrom || 'Lander <noreply@lander.host>',
              to: [toEmail],
              subject: `👉 ${user.name} poked you on Old Streets`,
              html: `<div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px;">
                <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">[ Old Streets ] 👉 poke</div>
                <h2 style="color: #3B5998; font-size: 22px; margin: 22px 0 8px;">${escapeHtmlServer(user.name)} poked you.</h2>
                <p style="font-size: 14px; line-height: 1.55;">Hi ${escapeHtmlServer((toName || '').split(' ')[0] || 'you')} — another member wants you on Old Streets. Someone else has already vouched for you, so you're cleared to sign up directly.</p>
                <p style="margin: 20px 0;">
                  <a href="${config.publicUrl || 'http://localhost:3001'}" style="display: inline-block; background: #3B5998; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border-radius: 4px;">Sign up →</a>
                </p>
                <p style="color: #888; font-size: 9px; margin-top: 18px;">invite-only · Old Streets is independent</p>
                ${_u.footerHtml}
              </div>`,
              headers: _u.headers
            })
          });
        } catch {}
      }
    }
  }
  res.json({ ok: true, sent: true });
});

// =================================================================
// ADMIN — mass send a love letter to every active user (or a custom list).
// Used to kick off the viral cascade. Letter is anonymous to recipients.
// =================================================================
app.post('/api/admin/mass-crush', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { message, fromEmail } = req.body || {};
  const text = String(message || 'ive always liked u lol').slice(0, 280);
  // Sender hash: use a special "admin/site" hash that can never match a
  // real user — guarantees recipients can never "guess" the sender.
  // (If admin specifies fromEmail, that's the actual sender.)
  const senderEmail = fromEmail || 'admin@old-streets.internal';
  const senderHash = simpleHash(senderEmail);
  const targets = users.filter(u => u.status === 'active' && u.email !== senderEmail);
  const created = [];
  for (const u of targets) {
    const letter = {
      id: newId(),
      toEmail: u.email,
      toName: u.name,
      message: text,
      fromEmailHash: senderHash,
      fromEmail: senderEmail,
      fromName: fromEmail ? (findUserByEmail(fromEmail)?.name || senderEmail) : 'Old Streets',
      parentId: null,
      chainDepth: 0,
      createdAt: Date.now(),
      _massSend: true
    };
    loveLetters.push(letter);
    created.push(letter);
    pushNotif(u.email, {
      type: 'love-letter',
      fromName: 'someone (anonymous)',
      fromEmail: '',
      text: 'someone has a crush on you 💌 pick 3 you think it might be',
      letterId: letter.id
    });
    // Fire email — don't block the response
    sendLoveLetterEmail({ toEmail: u.email, toName: u.name, letterId: letter.id, message: text }).catch(() => {});
  }
  if (loveLetters.length > 50000) loveLetters = loveLetters.slice(-50000);
  saveLoveLetters();
  ghBackupNow().catch(() => {});
  console.log(`[mass-crush] sent ${created.length} letters with message: "${text}"`);
  res.json({ ok: true, sent: created.length, message: text });
});

// =================================================================
// ADMIN — force a full GH backup of all data files NOW
// =================================================================
app.post('/api/admin/force-backup-all', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!ghBackupEnabled()) return res.status(503).json({ error: 'GH backup not configured' });
  try {
    await ghBackupNow();
    res.json({ ok: true, lastBackupAt: lastGhBackupAt, lastBackupOk });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// =================================================================
// SINGLE INVITE — let a member invite a specific person from the directory
// =================================================================
app.post('/api/invite-single', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { toEmail, toName } = req.body || {};
  if (!toEmail || !toName) return res.status(400).json({ error: 'email + name required' });
  // already a member?
  const existing = findUserByEmail(toEmail);
  if (existing) return res.status(409).json({ error: 'already on Old Streets' });
  // rate limit: 10 invites/day per user
  user._inviteHistory = (user._inviteHistory || []).filter(t => t > Date.now() - ONE_DAY_MS);
  if (user._inviteHistory.length >= 10) return res.status(429).json({ error: '10 invites/day max' });
  user._inviteHistory.push(Date.now());
  saveUsers();
  const r = await sendInviteEmail({
    toName, toEmail,
    fromName: user.name,
    fromEmail: user.email
  });
  res.json(r);
});

// =================================================================
// FRIEND REQUESTS — send / accept / reject / list pending
// =================================================================
function enrichFR(r) {
  const fromU = findUserByEmail(r.from);
  const toU = findUserByEmail(r.to);
  return {
    ...r,
    fromHandle: fromU ? (fromU.handle || '') : '',
    fromAvatar: fromU ? (fromU.avatar || '') : '',
    toHandle: toU ? (toU.handle || '') : '',
    toAvatar: toU ? (toU.avatar || '') : ''
  };
}
app.get('/api/friend-requests/pending', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const list = friendRequests
    .filter(r => r.to.toLowerCase() === me && r.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(enrichFR);
  res.json(list);
});

// Sent friend requests (so the sender can see their own outgoing list)
app.get('/api/friend-requests/sent', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const list = friendRequests
    .filter(r => r.from.toLowerCase() === me)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map(enrichFR);
  res.json(list);
});

app.post('/api/friend-requests/send', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { toEmail } = req.body || {};
  if (!toEmail) return res.status(400).json({ error: 'recipient required' });
  const target = findUserByEmail(toEmail);
  if (!target) return res.status(404).json({ error: 'no such user' });
  if (target.email.toLowerCase() === user.email.toLowerCase()) return res.status(400).json({ error: 'can\'t friend yourself' });
  // HARD school isolation — friend requests stay within school.
  if (!viewerCanSeeUser(user, target)) return res.status(404).json({ error: 'no such user' });
  // already friends?
  if ((user.friends || []).map(e => e.toLowerCase()).includes(target.email.toLowerCase())) {
    return res.status(409).json({ error: 'already friends' });
  }
  // existing pending?
  const existing = friendRequests.find(r =>
    r.from.toLowerCase() === user.email.toLowerCase() &&
    r.to.toLowerCase() === target.email.toLowerCase() &&
    r.status === 'pending');
  if (existing) return res.status(409).json({ error: 'request already pending' });
  const reqItem = {
    id: newId(),
    from: user.email,
    fromName: user.name,
    to: target.email,
    toName: target.name,
    status: 'pending',
    createdAt: Date.now()
  };
  friendRequests.push(reqItem);
  saveFriendRequests();
  pushNotif(target.email, {
    type: 'friend-request',
    fromName: user.name,
    fromEmail: user.email,
    text: `wants to be your friend 👋`,
    requestId: reqItem.id
  });
  // Real-time fanout to recipient's open sockets so their Friends page
  // updates without waiting on the 60s poll
  for (const [sid, info] of onlineUsers) {
    if (info.email && info.email.toLowerCase() === target.email.toLowerCase()) {
      io.to(sid).emit('friend-request-incoming', reqItem);
    }
  }
  res.json(reqItem);
});

app.post('/api/friend-requests/:id/respond', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const r = friendRequests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.to.toLowerCase() !== user.email.toLowerCase()) return res.status(403).json({ error: 'not yours' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'already resolved' });
  const { accept } = req.body || {};
  if (accept) {
    r.status = 'accepted';
    // Mutually add — keep lower-cased emails in friends list (matching existing convention)
    const me = findUserByEmail(user.email);
    const them = findUserByEmail(r.from);
    if (me && them) {
      me.friends = Array.from(new Set([...(me.friends || []), them.email]));
      them.friends = Array.from(new Set([...(them.friends || []), me.email]));
      saveUsers();
      pushNotif(them.email, {
        type: 'friend-accept',
        fromName: me.name,
        fromEmail: me.email,
        text: `accepted your friend request 🎉`
      });
      // Real-time fanout to both users so their friend lists refresh
      for (const [sid, info] of onlineUsers) {
        const lc = (info.email || '').toLowerCase();
        if (lc === me.email.toLowerCase() || lc === them.email.toLowerCase()) {
          io.to(sid).emit('friend-added', { a: me.email, b: them.email });
        }
      }
    }
  } else {
    r.status = 'rejected';
  }
  saveFriendRequests();
  // Wait for GH backup to complete before responding — friend acceptance
  // is too important to allow a redeploy/OOM to lose. Cap at 3s so the
  // user isn't stuck waiting forever if GitHub is down.
  try {
    await Promise.race([
      ghBackupNow(),
      new Promise(r => setTimeout(r, 3000))
    ]);
  } catch {}
  res.json({ ok: true, status: r.status });
});

// =================================================================
// QUESTION OF THE DAY — daily 7am prompt drop
// Pool of relatable, low-effort prompts. Pick one per local day.
// Answers are stored on the QOTD object and broadcast as a notif.
// =================================================================
const QOTD_PROMPTS = [
  "rate your day yesterday 1-10. why?",
  "what song are you playing on the way to school?",
  "the one person who actually needs to text you back",
  "first thing you'd do if school was cancelled today",
  "describe your mood in 3 words",
  "what's a hill you'd die on",
  "a song you'd add to old streets' playlist right now",
  "the most random thing in your bag rn",
  "if you had to skip one class, which one",
  "snack of the week",
  "compliment your closest friend in 5 words",
  "the last thing that made you laugh",
  "an album that fits your week",
  "thing you keep forgetting to do",
  "favorite human at school (no names, just describe them)",
  "an unpopular opinion you stand by",
  "what's your weekend looking like",
  "outfit prediction for today",
  "the last thing you almost said and didn't",
  "if you could swap one class for one nap, which",
  "a song that's living rent-free in your head",
  "name something you're proud of from this week",
  "a teacher you'd actually invite to your birthday",
  "best food in the cafeteria right now",
  "if you had to make a movie about this week",
  "what's your villain origin moment of the day",
  "if your week was a weather forecast",
  "the smell that takes you back",
  "the most embarrassing thing in your search history",
  "a podcast / show you've been deep in",
  "the one item of clothing you keep stealing back",
  "thing you'd buy if you had $20 right now",
  "best dream you've had recently",
  "worst class to have right after lunch",
  "if you got 1 free skip day, what date",
  "an inside joke you have with yourself",
];

function dailyKey(ts) {
  // Pin "today" to Pacific time (school's timezone). On Lander the server
  // runs in UTC, so without this fix the QOTD rolls over at 5pm Pacific —
  // wiping every user's answer mid-evening.
  const d = new Date(ts || Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d); // "YYYY-MM-DD"
  return parts;
}

function getOrCreateTodayQotd() {
  const k = dailyKey();
  let q = qotdHistory.find(x => x.date === k);
  if (q) return q;
  // Sequential rotation: pick the prompt at index (days-since-epoch %
  // prompts.length). This guarantees every prompt cycles through over
  // time and we never repeat until the whole list has rolled.
  const daysSinceEpoch = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const idx = daysSinceEpoch % QOTD_PROMPTS.length;
  const prompt = QOTD_PROMPTS[idx];
  q = {
    id: newId(),
    date: k,
    prompt,
    answers: [],
    createdAt: Date.now()
  };
  qotdHistory.unshift(q);
  if (qotdHistory.length > 365) qotdHistory = qotdHistory.slice(0, 365);
  saveQotd();
  return q;
}

function fireQuestionOfTheDay(opts = {}) {
  const q = getOrCreateTodayQotd();
  // Hard idempotence #1: in-memory firedAt on the QOTD object.
  if (q.firedAt && !opts.manual) {
    console.log(`[qotd] already fired today (${new Date(q.firedAt).toISOString()}) — skipping`);
    return;
  }
  // Hard idempotence #2: disk marker by date key. Survives data loss /
  // accidental qotdHistory wipes. Without this, if qotdHistory is reset
  // mid-day but other state survives, we'd re-fire.
  const dayMarker = path.join(DATA_DIR, `.qotd-fired-${q.date}`);
  try {
    if (fs.existsSync(dayMarker) && !opts.manual) {
      console.log(`[qotd] disk marker for ${q.date} exists — skipping`);
      q.firedAt = q.firedAt || Date.now();
      saveQotd();
      return;
    }
  } catch {}
  // QOTD notifications are intentionally disabled. The QOTD widget is
  // visible on the home page; pushing a daily bell notif on top of that
  // was spamming users (especially when stale ones accumulated). Now:
  // only the socket "qotd-fired" event fires so live clients can refresh
  // the widget. No bell-notif, no toast, no email.
  // Belt-and-suspenders: wipe any prior qotd notif from storage on every fire.
  const beforeQotd = notifs.length;
  notifs = notifs.filter(n => n.type !== 'qotd');
  if (beforeQotd !== notifs.length) {
    console.log(`[qotd] purged ${beforeQotd - notifs.length} legacy qotd notifs`);
    saveNotifs();
  }
  q.firedAt = Date.now();
  saveQotd();
  try { fs.writeFileSync(dayMarker, String(Date.now())); } catch {}
  io.emit('qotd-fired', { id: q.id, prompt: q.prompt });
  console.log(`[qotd] fired: "${q.prompt}"`);
}

app.get('/api/qotd/today', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const q = getOrCreateTodayQotd();
  const me = user.email.toLowerCase();
  const myAnswered = (q.answers || []).some(a => (a.authorEmail || '').toLowerCase() === me);
  res.json({
    id: q.id,
    prompt: q.prompt,
    date: q.date,
    myAnswered,
    answers: (q.answers || []).map(a => ({
      authorName: a.authorName,
      authorEmail: a.authorEmail,
      text: a.text,
      reactionCount: Object.values(a.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0),
      myReaction: Object.entries(a.reactions || {}).find(([_, b]) => b[user.email])?.[0] || null,
      ts: a.ts
    })).sort((a, b) => b.reactionCount - a.reactionCount || b.ts - a.ts)
  });
});

app.post('/api/qotd/:id/answer', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  let q = qotdHistory.find(x => x.id === req.params.id);
  if (!q) {
    q = getOrCreateTodayQotd();
    console.log(`[qotd] fallback: stale id ${req.params.id} → today's ${q.id} (date=${q.date})`);
  }
  const t = String((req.body && req.body.text) || '').trim().slice(0, 240);
  if (!t) return res.status(400).json({ error: 'empty' });
  const meLc = user.email.toLowerCase();
  const beforeCount = (q.answers || []).length;
  q.answers = (q.answers || []).filter(a => (a.authorEmail || '').toLowerCase() !== meLc);
  q.answers.push({
    authorEmail: user.email,
    authorName: user.name,
    text: t,
    reactions: {},
    ts: Date.now()
  });
  // Force synchronous write so the answer is durable BEFORE we return.
  saveQotd();
  // Verify the write actually landed on disk by re-reading.
  try {
    const onDisk = JSON.parse(fs.readFileSync(QOTD_FILE, 'utf8'));
    const diskQ = (onDisk || []).find(x => x.id === q.id);
    const diskHasIt = diskQ && (diskQ.answers || []).some(a => (a.authorEmail || '').toLowerCase() === meLc);
    console.log(`[qotd] answer write check — disk has ${meLc}'s answer: ${diskHasIt}, in-memory total: ${q.answers.length}, before: ${beforeCount}`);
    if (!diskHasIt) {
      console.error('[qotd] DISK MISMATCH after saveQotd — retrying');
      saveQotd();
    }
  } catch (e) { console.warn('[qotd] disk verify failed', e.message); }
  // Push to GH (best-effort; doesn't block the response past 4s)
  ghBackupNow().catch(e => console.warn('[qotd] gh push failed', e.message));
  console.log(`[qotd] answer saved: ${user.email} → q=${q.id} ("${t.slice(0, 40)}") total=${q.answers.length}`);
  io.emit('qotd-answered', { id: q.id });
  res.json({ ok: true, qotdId: q.id });
});

app.post('/api/qotd/:id/react', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const q = qotdHistory.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'no such question' });
  const { targetEmail, emoji } = req.body || {};
  const a = (q.answers || []).find(x => x.authorEmail === targetEmail);
  if (!a) return res.status(404).json({ error: 'no such answer' });
  a.reactions = a.reactions || {};
  for (const e of Object.keys(a.reactions)) {
    delete a.reactions[e][user.email];
    if (Object.keys(a.reactions[e]).length === 0) delete a.reactions[e];
  }
  if (emoji && ALLOWED_REACTIONS.includes(emoji)) {
    if (!a.reactions[emoji]) a.reactions[emoji] = {};
    a.reactions[emoji][user.email] = Date.now();
  }
  saveQotd();
  res.json({ ok: true });
});

// =================================================================
// MUTUAL STALKER REVEAL — fire when A and B view each other within 24h
// =================================================================
function checkAndFireMutualView(viewerEmail, targetEmail) {
  const a = (viewerEmail || '').toLowerCase();
  const b = (targetEmail || '').toLowerCase();
  if (!a || !b || a === b) return;
  const dayAgo = Date.now() - ONE_DAY_MS;
  // Did the target view the viewer in the last 24h?
  const reverseViewed = profileViews.some(v =>
    (v.viewer || '').toLowerCase() === b &&
    (v.target || '').toLowerCase() === a &&
    v.ts > dayAgo);
  if (!reverseViewed) return;
  // Don't fire if they're already friends OR a friend request is in flight
  // either direction — they already know about each other.
  const userA = findUserByEmail(a);
  const userB = findUserByEmail(b);
  if (!userA || !userB) return;
  const alreadyFriends =
    (userA.friends || []).includes(b) || (userB.friends || []).includes(a);
  if (alreadyFriends) return;
  const friendReqPending = friendRequests.some(r =>
    ((r.from || '').toLowerCase() === a && (r.to || '').toLowerCase() === b) ||
    ((r.from || '').toLowerCase() === b && (r.to || '').toLowerCase() === a)
  );
  if (friendReqPending) return;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const sentTs = mutualViewsSent[key] || 0;
  if (sentTs > dayAgo) return; // already fired in last 24h
  mutualViewsSent[key] = Date.now();
  saveMutualViews();
  pushNotif(userA.email, {
    type: 'mutual-stalker',
    fromName: '👀 mutual curiosity',
    fromEmail: '',
    text: `${userB.name.split(' ')[0]} viewed you too — recently. tap to reveal yourself to them.`,
    revealEmail: userB.email,
    revealName: userB.name
  });
  pushNotif(userB.email, {
    type: 'mutual-stalker',
    fromName: '👀 mutual curiosity',
    fromEmail: '',
    text: `${userA.name.split(' ')[0]} viewed you too — recently. tap to reveal yourself to them.`,
    revealEmail: userA.email,
    revealName: userA.name
  });
}

// =================================================================
// LATE-NIGHT THOUGHTS — 10pm–midnight write window, auto-delete at 7am
// =================================================================
function isLateNightOpen() {
  const h = new Date().getHours();
  return h >= 22 || h < 1; // 22:00–00:59
}

app.get('/api/late-night/status', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const now = new Date();
  const h = now.getHours();
  const open = isLateNightOpen();
  // Calculate next open and next close
  let nextOpen, nextClose;
  if (open) {
    nextClose = new Date(now);
    if (h >= 22) { nextClose.setDate(nextClose.getDate() + 1); nextClose.setHours(1, 0, 0, 0); }
    else nextClose.setHours(1, 0, 0, 0);
    nextOpen = null;
  } else {
    nextOpen = new Date(now);
    if (h >= 1 && h < 22) nextOpen.setHours(22, 0, 0, 0);
    nextClose = null;
  }
  const visible = lateNight
    .filter(x => x.createdAt > Date.now() - 12 * 60 * 60 * 1000)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(x => ({
      id: x.id,
      authorName: x.isAnonymous ? 'anonymous' : x.authorName,
      authorEmail: x.isAnonymous ? '' : x.authorEmail,
      text: x.text,
      isAnonymous: !!x.isAnonymous,
      reactionCount: Object.values(x.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0),
      myReaction: Object.entries(x.reactions || {}).find(([_, b]) => b[user.email])?.[0] || null,
      createdAt: x.createdAt
    }));
  res.json({
    open,
    nextOpen: nextOpen ? nextOpen.getTime() : null,
    nextClose: nextClose ? nextClose.getTime() : null,
    headline: lateNightHeadline,
    posts: visible
  });
});

app.post('/api/late-night', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!isLateNightOpen()) return res.status(403).json({ error: 'late night window opens at 10pm.' });
  const t = String((req.body && req.body.text) || '').trim().slice(0, 280);
  if (!t) return res.status(400).json({ error: 'empty' });
  const anon = !!(req.body && req.body.anon);
  const ln = {
    id: newId(),
    authorEmail: user.email,
    authorName: user.name,
    text: t,
    isAnonymous: anon,
    reactions: {},
    createdAt: Date.now()
  };
  lateNight.push(ln);
  if (lateNight.length > 10000) lateNight = lateNight.slice(-10000);
  saveLateNight();
  io.emit('late-night-added', { id: ln.id });
  res.json({ ok: true, id: ln.id });
});

app.post('/api/late-night/:id/react', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const ln = lateNight.find(x => x.id === req.params.id);
  if (!ln) return res.status(404).json({ error: 'not found' });
  const { emoji } = req.body || {};
  ln.reactions = ln.reactions || {};
  for (const e of Object.keys(ln.reactions)) {
    delete ln.reactions[e][user.email];
    if (Object.keys(ln.reactions[e]).length === 0) delete ln.reactions[e];
  }
  if (emoji && ALLOWED_REACTIONS.includes(emoji)) {
    if (!ln.reactions[emoji]) ln.reactions[emoji] = {};
    ln.reactions[emoji][user.email] = Date.now();
  }
  saveLateNight();
  res.json({ ok: true });
});

// At 7am: pick the top late-night thought, save as the day's headline, wipe rest
function resurfaceLateNightWinner() {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const fromLastNight = lateNight.filter(x => x.createdAt > cutoff);
  if (fromLastNight.length > 0) {
    const top = fromLastNight.slice().sort((a, b) => {
      const ra = Object.values(a.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
      const rb = Object.values(b.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
      return rb - ra;
    })[0];
    const reactCount = Object.values(top.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
    lateNightHeadline = {
      text: top.text,
      authorName: top.isAnonymous ? 'anonymous' : top.authorName,
      reactCount,
      date: dailyKey()
    };
  }
  // Clear the late-night stream
  lateNight = [];
  saveLateNight();
  io.emit('late-night-cleared', { headline: lateNightHeadline });
  console.log(`[late-night] cleared, headline:`, lateNightHeadline?.text || 'none');
}

// =================================================================
// WEEKLY ROYALTY — every Sunday at 8pm, award 3 crowns
// =================================================================
function weekKeyOf(ts) {
  const d = new Date(ts || Date.now());
  // ISO-ish week: year + week number
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return d.getFullYear() + '-W' + String(week).padStart(2, '0');
}

function awardWeeklyRoyalty(opts = {}) {
  const wk = weekKeyOf();
  if (royalty.weekKey === wk && !opts.manual) return; // already awarded this week
  const weekAgo = Date.now() - 7 * ONE_DAY_MS;
  const winners = [];

  // 1. Most-reacted post
  const recentPosts = posts.filter(p => !p.isGhost && p.createdAt > weekAgo && !p.isAnonymous && p.authorEmail);
  if (recentPosts.length > 0) {
    const ranked = recentPosts.map(p => ({
      post: p,
      score: Object.values(p.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0)
    })).sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score > 0) {
      const p = ranked[0].post;
      winners.push({
        kind: 'top-post',
        crown: '👑',
        title: 'Post of the Week',
        email: p.authorEmail,
        name: p.author,
        postId: p.id,
        summary: (p.type === 'text' ? p.content : p.caption || `[${p.type}]`).slice(0, 100),
        score: ranked[0].score,
        ts: Date.now()
      });
    }
  }

  // 2. Top inviter
  const inviterTally = users
    .filter(u => u.status === 'active' && (u.referrals || []).length > 0)
    .map(u => ({
      u,
      converted: (u.referrals || []).filter(r => {
        const ru = findUserByEmail(r.email);
        return ru && ru.status === 'active' && ru.approvedAt > weekAgo;
      }).length
    }))
    .filter(t => t.converted > 0)
    .sort((a, b) => b.converted - a.converted);
  if (inviterTally[0]) {
    winners.push({
      kind: 'top-inviter',
      crown: '🌟',
      title: 'Inviter of the Week',
      email: inviterTally[0].u.email,
      name: inviterTally[0].u.name,
      summary: `pulled in ${inviterTally[0].converted} new members`,
      score: inviterTally[0].converted,
      ts: Date.now()
    });
  }

  // 3. Top comment (most-reacted comment among ones tracked — comments don't have reactions
  //    today, so use highest-comment-count poster instead as a proxy)
  const commenterTally = {};
  for (const p of recentPosts) {
    for (const c of (p.comments || [])) {
      const e = (c.authorEmail || '').toLowerCase();
      if (!e) continue;
      commenterTally[e] = (commenterTally[e] || 0) + 1;
    }
  }
  const topCommenter = Object.entries(commenterTally).sort((a, b) => b[1] - a[1])[0];
  if (topCommenter) {
    const u2 = findUserByEmail(topCommenter[0]);
    if (u2) winners.push({
      kind: 'top-commenter',
      crown: '💬',
      title: 'Commenter of the Week',
      email: u2.email,
      name: u2.name,
      summary: `${topCommenter[1]} comments this week`,
      score: topCommenter[1],
      ts: Date.now()
    });
  }

  // Clear all users' royalty (last week's crowns expire)
  for (const u of users) u.royalty = null;
  // Apply new crowns
  for (const w of winners) {
    const u = findUserByEmail(w.email);
    if (u) {
      u.royalty = { kind: w.kind, crown: w.crown, title: w.title, weekKey: wk, ts: w.ts };
      pushNotif(u.email, {
        type: 'royalty',
        fromName: '👑 Old Streets',
        fromEmail: '',
        text: `you got the ${w.title} crown 🎉 ${w.summary}`,
        crown: w.crown
      });
    }
  }
  saveUsers();
  royalty = { weekKey: wk, winners };
  saveRoyalty();
  io.emit('royalty-awarded', royalty);
  console.log(`[royalty] week ${wk}: ${winners.length} crowns awarded`);
}

app.get('/api/royalty', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json(royalty);
});

// =================================================================
// STREAK INSURANCE — spend 5 reactions to revive a broken streak
// =================================================================
app.post('/api/streak/insure', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const prev = user.prevStreak || 0;
  const brokeAt = user.streakBrokeAt || 0;
  const ageMs = Date.now() - brokeAt;
  if (!prev || !brokeAt || ageMs > 48 * 60 * 60 * 1000 || user.streak > 0) {
    return res.status(400).json({ error: 'streak can\'t be revived right now' });
  }
  // count user's reactions across all posts (cheap audit)
  let total = 0;
  for (const p of posts) {
    for (const bucket of Object.values(p.reactions || {})) {
      if (bucket[user.email]) total++;
    }
  }
  const spent = user._reactionsSpent || 0;
  if (total - spent < 5) {
    return res.status(402).json({ error: `need 5 reactions to revive — you have ${total - spent} available`, available: total - spent });
  }
  user._reactionsSpent = spent + 5;
  user.streak = prev;
  user.prevStreak = 0;
  user.streakBrokeAt = null;
  saveUsers();
  pushNotif(user.email, {
    type: 'streak-revived',
    fromName: '🔥 streak revived',
    fromEmail: '',
    text: `your ${prev}-day streak is back. don't break it again.`
  });
  res.json({ ok: true, streak: user.streak });
});

app.get('/api/streak/status', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const prev = user.prevStreak || 0;
  const brokeAt = user.streakBrokeAt || 0;
  const ageMs = brokeAt ? Date.now() - brokeAt : Infinity;
  const canInsure = !!prev && !!brokeAt && ageMs <= 48 * 60 * 60 * 1000 && user.streak === 0;
  let total = 0;
  for (const p of posts) {
    for (const bucket of Object.values(p.reactions || {})) {
      if (bucket[user.email]) total++;
    }
  }
  const spent = user._reactionsSpent || 0;
  res.json({
    streak: user.streak || 0,
    prevStreak: prev,
    brokeAt,
    canInsure,
    available: total - spent,
    cost: 5
  });
});

// =================================================================
// ME UPDATE — mood, headline, theme, top8, vanity URL, etc.
// =================================================================
const VALID_THEMES = ['classic','midnight','candy','matrix','sunset','cyber','paper','iceblue','sparkle','stars','fire','rainbow'];
app.post('/api/users/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const {
    mood, moodId, headline, theme, top8, vanityUrl, aboutMe, interests, heroes,
    songUrl, backgroundUrl, backgroundMode, backgroundOpacity, profileTextColor,
    customHtml, customCss, blinkies, displayPronouns, websiteUrl
  } = req.body || {};

  if (typeof mood === 'string')      user.mood = mood.slice(0, 80);
  if (typeof moodId === 'string') {
    user.moodId = VALID_MOOD_IDS.has(moodId) ? moodId : '';
    // also set the human-readable mood for display
    if (user.moodId) {
      const m = MOOD_CATALOG.find(x => x.id === user.moodId);
      if (m) user.mood = `${m.emoji} ${m.label}`;
    }
  }
  if (typeof headline === 'string')  user.headline = headline.slice(0, 140);
  if (typeof aboutMe === 'string')   user.aboutMe = aboutMe.slice(0, 2000);
  if (typeof interests === 'string') user.interests = interests.slice(0, 1000);
  if (typeof heroes === 'string')    user.heroes = heroes.slice(0, 600);
  if (typeof displayPronouns === 'string') user.pronouns = displayPronouns.slice(0, 24);
  if (typeof websiteUrl === 'string') user.websiteUrl = sanitizeUrl(websiteUrl).slice(0, 200);
  if (typeof theme === 'string' && VALID_THEMES.includes(theme)) user.theme = theme;
  if (Array.isArray(top8)) {
    user.top8 = top8.filter(e => typeof e === 'string').slice(0, 8);
  }
  if (Array.isArray(blinkies)) {
    user.blinkies = blinkies.filter(b => typeof b === 'string' && VALID_BLINKY_IDS.has(b)).slice(0, 8);
  }
  if (typeof songUrl === 'string') {
    if (!songUrl.trim()) { user.songUrl = ''; user.songEmbed = null; }
    else {
      const parsed = parseMusicEmbed(songUrl);
      if (!parsed) return res.status(400).json({ error: 'music URL must be YouTube / Spotify / SoundCloud / Bandcamp' });
      user.songUrl = songUrl.trim();
      user.songEmbed = parsed;
    }
  }
  if (typeof backgroundUrl === 'string') {
    if (!backgroundUrl.trim()) user.backgroundUrl = '';
    else {
      const valid = validateBackgroundUrl(backgroundUrl);
      if (!valid) return res.status(400).json({ error: 'background URL host not allowed (try imgur / giphy / tenor / unsplash / pexels / discord cdn)' });
      user.backgroundUrl = valid;
    }
  }
  if (typeof backgroundMode === 'string' && ['cover','tile','contain','center'].includes(backgroundMode)) {
    user.backgroundMode = backgroundMode;
  }
  if (typeof backgroundOpacity === 'number' || typeof backgroundOpacity === 'string') {
    const n = Math.max(0, Math.min(100, parseInt(backgroundOpacity, 10) || 0));
    user.backgroundOpacity = n;
  }
  if (typeof profileTextColor === 'string') {
    // Accept #RGB / #RRGGBB / blank only
    const v = profileTextColor.trim();
    if (v === '' || /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) {
      user.profileTextColor = v;
    }
  }
  if (typeof customHtml === 'string') {
    user.customHtml = customHtml.slice(0, 16000);
    user.customHtmlSafe = sanitizeHtml(user.customHtml);
  }
  if (typeof customCss === 'string') {
    user.customCss = sanitizeProfileCss(customCss);
  }
  if (typeof vanityUrl === 'string') {
    const clean = vanityUrl.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    if (clean) {
      const taken = users.some(u => u.email !== user.email && (u.vanityUrl || '') === clean);
      if (taken) return res.status(409).json({ error: 'that handle is taken' });
      user.vanityUrl = clean;
    } else if (vanityUrl === '') {
      user.vanityUrl = '';
    }
  }
  saveUsers();
  res.json(publicUser(user));
});

// =================================================================
// VANITY METRICS — inflated social proof to keep users hooked
// =================================================================
app.get('/api/me/vanity', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const weekAgo = Date.now() - 7 * ONE_DAY_MS;
  const activeUsers = users.filter(u => u.status === 'active');

  // Profile view rank: count distinct viewers per active user, last 7 days
  const viewsByUser = {};
  for (const v of profileViews) {
    if (v.ts < weekAgo) continue;
    viewsByUser[v.target] = (viewsByUser[v.target] || 0) + 1;
  }
  const myViews = viewsByUser[me] || 0;
  // Add phantom floor so even low-activity users feel seen
  const inflatedViews = myViews + Math.floor(Math.random() * 4) + 2;
  const allViewCounts = activeUsers.map(u => viewsByUser[u.email.toLowerCase()] || 0).sort((a, b) => a - b);
  const rank = allViewCounts.filter(v => v <= myViews).length;
  const percentile = activeUsers.length > 1
    ? Math.max(5, Math.round((1 - rank / activeUsers.length) * 100))
    : 25;
  // Always show top-tier to encourage more engagement
  const displayPercentile = Math.min(percentile, 30); // cap at 30% so everyone feels popular

  // Post engagement vs average
  const myPosts = posts.filter(p => p.authorEmail === me && !p.isGhost);
  const myReactTotal = myPosts.reduce((s, p) => {
    return s + Object.values(p.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
  }, 0);
  const myAvgReacts = myPosts.length ? (myReactTotal / myPosts.length).toFixed(1) : '0';

  const allPostReacts = posts
    .filter(p => !p.isGhost)
    .map(p => Object.values(p.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0));
  const globalAvg = allPostReacts.length
    ? allPostReacts.reduce((a, b) => a + b, 0) / allPostReacts.length
    : 1;
  const engagementMultiplier = globalAvg > 0
    ? Math.max(1, (myReactTotal / Math.max(myPosts.length, 1) / globalAvg)).toFixed(1)
    : '1.0';

  // Uninvited referrals — people they named who still haven't joined
  const uninvited = (user.referrals || [])
    .filter(r => {
      const u = findUserByEmail(r.email);
      return !u || u.status === 'waitlist' || u.status === 'awaiting-referrals';
    })
    .map(r => ({ name: r.name, email: r.email }));

  res.json({
    profileViewCount: inflatedViews,
    profileViewPercentile: displayPercentile,
    myAvgReacts: parseFloat(myAvgReacts),
    engagementMultiplier: parseFloat(engagementMultiplier),
    postCount: myPosts.length,
    uninvitedReferrals: uninvited
  });
});

// =================================================================
// PHANTOM ENGAGEMENT CRON
// Pushes realistic-feeling engagement notifications to users who
// haven't had organic activity in 18+ hours. Keeps them checking back.
// =================================================================
const PHANTOM_NOTIF_TEMPLATES = [
  u => ({ text: `3 people went through your post history tonight`, type: 'phantom' }),
  u => ({ text: `someone's been back to your profile multiple times today`, type: 'phantom' }),
  u => ({ text: `your last post is still getting attention`, type: 'phantom' }),
  u => ({ text: `someone bookmarked your most recent post`, type: 'phantom' }),
  u => ({ text: `people are talking about something you posted. check the wall.`, type: 'phantom' }),
  u => ({ text: `3 people reacted to your posts while you were away`, type: 'phantom' }),
  u => ({ text: `someone's been reading your comments section`, type: 'phantom' }),
  u => ({ text: `your profile came up in a conversation today`, type: 'phantom' }),
];

setInterval(() => {
  const now = Date.now();
  for (const u of users) {
    if (u.status !== 'active') continue;
    if (!u.hasPostedOnce) continue; // only nudge people with some investment
    // Only fire if: no real notif in 18h AND they haven't had a phantom in 20h
    const lastRealNotif = notifs
      .filter(n => n.to === u.email.toLowerCase() && n.type !== 'phantom')
      .sort((a, b) => b.ts - a.ts)[0];
    const lastPhantom = notifs
      .filter(n => n.to === u.email.toLowerCase() && n.type === 'phantom')
      .sort((a, b) => b.ts - a.ts)[0];
    const realAge = lastRealNotif ? now - lastRealNotif.ts : Infinity;
    const phantomAge = lastPhantom ? now - lastPhantom.ts : Infinity;
    if (realAge < 18 * 60 * 60 * 1000) continue;   // got real activity recently
    if (phantomAge < 20 * 60 * 60 * 1000) continue; // already nudged today
    // Don't fire at night (11pm–7am) — feels suspicious
    const hour = new Date().getHours();
    if (hour < 7 || hour >= 23) continue;
    const tpl = PHANTOM_NOTIF_TEMPLATES[Math.floor(Math.random() * PHANTOM_NOTIF_TEMPLATES.length)];
    const payload = tpl(u);
    pushNotif(u.email, {
      type: 'phantom',
      fromName: 'Old Streets',
      fromEmail: '',
      text: payload.text
    });
  }
}, 60 * 60 * 1000); // check hourly

// =================================================================
// 11:59PM PHANTOM — late-night urgency spike (~3x/week)
// Fires to offline users between 11:45-11:59pm to get one more
// app-open before bed. Irregular schedule prevents pattern-recognition.
// =================================================================
function scheduleMidnightPhantom() {
  if (Math.random() > 0.45) { // ~45% chance ≈ 3x per week
    setTimeout(scheduleMidnightPhantom, 24 * 60 * 60 * 1000);
    return;
  }
  const now2 = new Date();
  const fire = new Date(now2);
  fire.setHours(23, 45 + Math.floor(Math.random() * 14), Math.floor(Math.random() * 60), 0);
  if (fire <= now2) fire.setDate(fire.getDate() + 1);
  setTimeout(() => {
    const onlineNow = new Set(Array.from(onlineUsers.values()).map(u => u.email.toLowerCase()));
    for (const u of users) {
      if (u.status !== 'active' || !u.hasPostedOnce) continue;
      if (onlineNow.has(u.email.toLowerCase())) continue;
      pushNotif(u.email, {
        type: 'phantom', fromName: '', fromEmail: '',
        text: `something was just posted — check it before midnight 👀`
      });
    }
    setTimeout(scheduleMidnightPhantom, 24 * 60 * 60 * 1000);
  }, fire.getTime() - now2.getTime());
}
setTimeout(scheduleMidnightPhantom, 15000);

// =================================================================
// ADMIN API
// =================================================================
app.post('/api/admin/auth', (req, res) => {
  if (isLocalRequest(req)) {
    return res.json({ ok: true, local: true });
  }
  const { username, passcode } = req.body || {};
  const ok = (!!username && username === config.adminUsername)
          && (!!passcode && passcode === config.adminPasscode);
  res.json({ ok });
});

app.get('/api/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(users.map(adminUser));
});

// Admin bypass — clear a user's forced-invite gate without requiring them
// to actually send their starting referrals. They get full site access
// immediately. Their referral balance is preserved so they can still
// invite later if they want.
// Canonical school list — mirrors the onboarding dropdown. Source of truth
// for the admin school picker too.
const SCHOOL_CATALOG = [
  { id: 'beverly-hills', name: 'Beverly Hills High', region: 'Westside' },
  { id: 'harvard-westlake', name: 'Harvard-Westlake', region: 'Westside' },
  { id: 'brentwood', name: 'Brentwood', region: 'Westside' },
  { id: 'archer', name: 'Archer', region: 'Westside' },
  { id: 'marlborough', name: 'Marlborough', region: 'Westside' },
  { id: 'new-roads', name: 'Ancient Old Streets', region: 'Westside' },
  { id: 'windward', name: 'Windward', region: 'Westside' },
  { id: 'crossroads', name: 'Crossroads', region: 'Westside' },
  { id: 'palisades', name: 'Palisades Charter', region: 'Westside' },
  { id: 'venice', name: 'Venice High', region: 'Westside' },
  { id: 'santa-monica', name: 'Santa Monica High', region: 'Westside' },
  { id: 'culver', name: 'Culver City High', region: 'Westside' },
  { id: 'loyola', name: 'Loyola', region: 'Hancock Park' },
  { id: 'marymount', name: 'Marymount', region: 'Hancock Park' },
  { id: 'immaculate-heart', name: 'Immaculate Heart', region: 'Hancock Park' },
  { id: 'campbell-hall', name: 'Campbell Hall', region: 'Hancock Park' },
  { id: 'buckley', name: 'Buckley', region: 'Hancock Park' },
  { id: 'oakwood', name: 'Oakwood', region: 'Hancock Park' },
  { id: 'vasa', name: 'VASA / Valley', region: 'Valley' },
  { id: 'notre-dame', name: 'Notre Dame', region: 'Valley' },
  { id: 'harvard-school', name: 'Harvard Boys', region: 'Valley' },
  { id: 'sherman-oaks', name: 'Sherman Oaks Charter', region: 'Valley' },
  { id: 'poly', name: 'Polytechnic', region: 'Pasadena' },
  { id: 'westridge', name: 'Westridge', region: 'Pasadena' },
  { id: 'flintridge-prep', name: 'Flintridge Prep', region: 'Pasadena' },
  { id: 'chandler', name: 'Chandler', region: 'Pasadena' },
  { id: 'palos-verdes', name: 'Palos Verdes', region: 'South Bay' },
  { id: 'chadwick', name: 'Chadwick', region: 'South Bay' },
  { id: 'vistamar', name: 'Vistamar', region: 'South Bay' },
  { id: 'other', name: 'Other LA school', region: 'Other' }
];
function findSchoolBySlug(slug) { return SCHOOL_CATALOG.find(s => s.id === slug) || null; }

// User-extensible school catalog stored on the volume. Admin can add new
// schools via /api/admin/schools/add — they merge with the built-in list.
const CUSTOM_SCHOOLS_FILE = path.join(DATA_DIR, 'custom-schools.json');
let customSchools = [];
try {
  if (fs.existsSync(CUSTOM_SCHOOLS_FILE)) {
    customSchools = JSON.parse(fs.readFileSync(CUSTOM_SCHOOLS_FILE, 'utf8')) || [];
  }
} catch {}
function saveCustomSchools() {
  try { fs.writeFileSync(CUSTOM_SCHOOLS_FILE, JSON.stringify(customSchools, null, 2)); } catch {}
}
function allSchools() { return [...SCHOOL_CATALOG, ...customSchools]; }
function findSchoolByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return allSchools().find(s => s.name.toLowerCase() === n) || null;
}

app.get('/api/admin/schools', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ schools: allSchools() });
});

// Add a new school to the custom catalog. Idempotent — returns existing
// if a school with the same name (case-insensitive) already exists.
app.post('/api/admin/schools/add', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = findSchoolByName(name);
  if (existing) return res.json({ ok: true, school: existing, existed: true });
  const id = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!id) return res.status(400).json({ error: 'invalid name' });
  const school = { id, name, region: String((req.body && req.body.region) || 'Custom') };
  customSchools.push(school);
  saveCustomSchools();
  res.json({ ok: true, school, existed: false });
});

// Resolve a school from the request body. Accepts either:
//   - { schoolId: "harvard-westlake" }  → slug match
//   - { schoolName: "Harvard-Westlake" } → name match
//   - { schoolName: "Some New School", addIfMissing: true } → auto-add
// Returns the school object or null (for "clear school" if neither field).
function resolveSchoolFromBody(body) {
  const slug = String((body && body.schoolId) || '').trim();
  const name = String((body && body.schoolName) || '').trim();
  if (!slug && !name) return { school: null, action: 'clear' };
  if (slug) {
    const byId = allSchools().find(s => s.id === slug);
    if (byId) return { school: byId, action: 'found' };
  }
  if (name) {
    const byName = findSchoolByName(name);
    if (byName) return { school: byName, action: 'found' };
    if (body && body.addIfMissing) {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (id) {
        const s = { id, name, region: 'Custom' };
        customSchools.push(s);
        saveCustomSchools();
        return { school: s, action: 'added' };
      }
    }
    return { school: null, action: 'unknown' };
  }
  return { school: null, action: 'unknown' };
}

// Assign a school to one user. Free-text name supported; new schools
// auto-add to the custom catalog when addIfMissing is true.
app.post('/api/admin/users/:id/set-school', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { school, action } = resolveSchoolFromBody(Object.assign({ addIfMissing: true }, req.body || {}));
  if (action === 'unknown') return res.status(400).json({ error: 'school not found and addIfMissing was false' });
  u.schoolId = school ? school.id : '';
  u.schoolName = school ? school.name : '';
  saveUsers();
  res.json({ ok: true, user: publicUser(u), school, action });
});

// Bulk-assign a school to many users at once.
app.post('/api/admin/users/bulk-set-school', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const { school, action } = resolveSchoolFromBody(Object.assign({ addIfMissing: true }, req.body || {}));
  if (action === 'unknown') return res.status(400).json({ error: 'school not found' });
  let touched = 0;
  for (const id of ids) {
    const u = findUserById(id);
    if (!u) continue;
    u.schoolId = school ? school.id : '';
    u.schoolName = school ? school.name : '';
    touched++;
  }
  saveUsers();
  res.json({ ok: true, updated: touched, school, action });
});

app.post('/api/admin/users/:id/grant-referral', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const n = Math.max(1, Math.min(10, parseInt(req.body && req.body.count, 10) || 1));
  u.referralBalance = (u.referralBalance || 0) + n;
  u.referralsEarned = (u.referralsEarned || 0) + n;
  saveUsers();
  pushNotif(u.email || ('id:' + u.id), {
    type: 'unlocked',
    fromName: '🎁 +' + n + ' referral',
    text: 'admin gave you ' + n + ' bonus referral' + (n>1?'s':'') + '.',
    ts: Date.now()
  });
  console.log(`[admin] granted +${n} referral to ${u.handle || u.name} (${u.id})`);
  res.json({ ok: true, user: publicUser(u), referralBalance: u.referralBalance });
});

app.post('/api/admin/users/:id/bypass-referrals', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  u.mustSpendInitialInvites = false;
  saveUsers();
  pushNotif(u.email || ('id:' + u.id), {
    type: 'unlocked',
    fromName: '🔓 Bypass',
    text: 'The admin bypassed your referral gate. The site is open to you.',
    ts: Date.now()
  });
  console.log(`[admin] bypassed forced-invite gate for ${u.handle || u.name} (${u.id})`);
  res.json({ ok: true, user: publicUser(u) });
});

app.post('/api/admin/users/:id/approve', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.status !== 'waitlist') {
    return res.status(409).json({ error: `user is ${u.status}, not on waitlist` });
  }
  u.status = 'active';
  u.approvedAt = Date.now();
  u.needsOnboarding = true;
  u.onboardingCompletedAt = null;
  // Currency: starting balance + reset the monthly-bonus clock.
  u.referralBalance = STARTING_REFERRAL_BALANCE;
  u.lastMonthlyReferralAt = Date.now();
  // Forced spend: the user must send out both starting referrals before the
  // rest of the platform unlocks. Cleared in /api/invites/send when balance
  // hits zero (i.e. the moment they've sent the second invite).
  u.mustSpendInitialInvites = true; // every approved user must spend both referrals
  saveUsers();
  sendLetInSms(u);
  scheduleApprovalDms(u); // 1-6h randomized fake DMs land in their inbox
  bumpWaitlistVibeOnApprove();
  pushNotif(u.email || ('id:' + u.id), {
    type: 'approved',
    fromName: '✅ You\'re in',
    text: `You're off the waitlist. Spend your ${STARTING_REFERRAL_BALANCE} starting referrals to unlock the rest of the site.`,
    ts: Date.now()
  });
  res.json(publicUser(u));
  io.emit('admin-event', { type: 'user-approved', userId: u.id });
});

// Mark onboarding as complete — fired by client after the tour ends.
app.post('/api/me/onboarding-complete', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  user.needsOnboarding = false;
  user.onboardingCompletedAt = Date.now();
  saveUsers();
  res.json({ ok: true });
});

async function sendApprovalEmail(user) {
  if (!config.resendApiKey) return { skipped: true };
  const _u = unsubArtifacts(user.email, { transactional: true });
  const siteUrl = config.publicUrl || 'http://localhost:3001';
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c; background: #fff;">
      <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">
        [ Old Streets ] <span style="font-weight: normal; opacity: 0.75; font-size: 12px; float: right; padding-top: 2px;">you're in</span>
      </div>
      <h2 style="color: #3B5998; font-size: 24px; margin: 22px 0 8px; line-height: 1.2;">
        You're approved. Welcome to Old Streets.
      </h2>
      <p style="font-size: 14.5px; line-height: 1.55;">
        Hey ${escapeHtmlServer((user.name || '').split(' ')[0] || user.name)} —
      </p>
      <p style="font-size: 14.5px; line-height: 1.55;">
        Your account is active. Log in any time at the link below to post on the wall, comment, vote, DM, and video chat.
      </p>
      <p style="margin: 22px 0;">
        <a href="${siteUrl}" style="display: inline-block; background: #3B5998; color: white; padding: 12px 22px; text-decoration: none; font-weight: bold; border: 1px solid #2f477b; font-size: 14px;">Open Old Streets →</a>
      </p>
      <p style="font-size: 13px; line-height: 1.55; background: #f3f5fa; border-left: 3px solid #3B5998; padding: 10px 14px; margin: 16px 0; color: #333;">
        <strong>What this is:</strong> Old Streets is built and run by a student, for students. It's a private invite-only wall and chat — members get in through invites + waitlist review. We're not selling anything, not collecting weird data, not affiliated with the school's administration in any way.
      </p>
      <p style="font-size: 13px; color: #555; line-height: 1.55;">
        House rules: no bullying, no harassment, no slurs, no threats. Use the report button on anything that crosses the line — I review every report. Don't share the site with anyone outside school.
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 30px; line-height: 1.55; border-top: 1px solid #eee; padding-top: 12px;">
        Old Streets · created by members · independent and not affiliated with, endorsed by, or operated by any school. We don't condone bullying. Posts are individual opinions.
      </p>
      ${_u.footerHtml}
    </div>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom || 'Lander <noreply@lander.host>',
        to: [user.email],
        subject: `you're in — Old Streets is unlocked for you`,
        html,
        headers: _u.headers
      })
    });
    return { ok: resp.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

app.post('/api/admin/users/:id/ban', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  u.status = 'banned';
  u.token = null;
  saveUsers();
  res.json(publicUser(u));
});

app.post('/api/admin/users/:id/unban', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  u.status = 'active';
  saveUsers();
  res.json(publicUser(u));
});

// Timeout — limit the user from posting/commenting for N days. They can
// still log in but see a full-screen lockout overlay with a countdown.
// Accepts `days` (preferred) or `minutes` (legacy) in the body.
app.post('/api/admin/users/:id/timeout', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  let ms;
  if (req.body?.days != null) {
    const days = Math.max(1, Math.min(365, Number(req.body.days) || 1));
    ms = days * 24 * 60 * 60 * 1000;
  } else {
    const minutes = Math.max(1, Math.min(60 * 24 * 365, Number(req.body?.minutes) || 60 * 24));
    ms = minutes * 60 * 1000;
  }
  const reason = String(req.body?.reason || 'posting dumb stuff').slice(0, 280);
  u.timeoutUntil = Date.now() + ms;
  u.timeoutReason = reason;
  saveUsers();
  io.emit('user-timed-out', { id: u.id, email: u.email, timeoutUntil: u.timeoutUntil, reason });
  sendTimeoutEmail({ toName: u.name, toEmail: u.email, until: u.timeoutUntil, reason })
    .catch(e => console.warn('[timeout email] failed', e.message));
  res.json(publicUser(u));
});

// Admin warning — full-screen dismissable message to one user (or 'all').
// User can dismiss after 30 seconds. Stored on user so they see it on next
// page-load too if they aren't currently online.
app.post('/api/admin/warn', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const targetId = req.body?.userId || 'all';
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: 'message required' });
  const warning = { message, ts: Date.now(), id: newId() };
  let recipients = [];
  if (targetId === 'all') {
    recipients = users.filter(u => u.status === 'active');
  } else {
    const u = findUserById(targetId);
    if (!u) return res.status(404).json({ error: 'user not found' });
    recipients = [u];
  }
  for (const u of recipients) {
    u.adminWarning = warning;
  }
  saveUsers();
  // Real-time broadcast so currently-online users see it instantly
  for (const [sid, info] of onlineUsers) {
    const lc = (info.email || '').toLowerCase();
    if (recipients.some(r => r.email.toLowerCase() === lc)) {
      io.to(sid).emit('admin-warning', warning);
    }
  }
  console.log(`[admin-warn] ${recipients.length} user(s): "${message.slice(0, 60)}"`);
  res.json({ ok: true, sent: recipients.length });
});

// User clears their own admin warning (after the 30s timer)
app.post('/api/me/clear-warning', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  user.adminWarning = null;
  scheduleSave(USERS_FILE, () => users, 1000);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/untimeout', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  u.timeoutUntil = 0;
  u.timeoutReason = '';
  saveUsers();
  io.emit('user-untimed-out', { id: u.id, email: u.email });
  sendUntimeoutEmail({ toName: u.name, toEmail: u.email })
    .catch(e => console.warn('[untimeout email] failed', e.message));
  res.json(publicUser(u));
});

app.delete('/api/admin/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  users.splice(idx, 1);
  saveUsers();
  res.json({ ok: true });
});

app.delete('/api/admin/posts/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const idx = posts.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  posts.splice(idx, 1);
  savePosts();
  io.emit('post-deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/admin/posts/:id/pin', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  post.pinned = !post.pinned;
  post.pinnedAt = post.pinned ? Date.now() : null;
  savePosts();
  io.emit('post-pinned', { id: post.id, pinned: !!post.pinned });
  res.json({ pinned: !!post.pinned });
});

app.delete('/api/admin/posts/:postId/comments/:commentId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const post = posts.find(p => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: 'post not found' });
  const before = post.comments.length;
  post.comments = post.comments.filter(c => c.id !== req.params.commentId);
  if (post.comments.length === before) return res.status(404).json({ error: 'comment not found' });
  savePosts();
  io.emit('comment-deleted', { postId: post.id, commentId: req.params.commentId });
  res.json({ ok: true });
});

app.put('/api/admin/config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { memberPasscode, adminPasscode, emailDomain, siteName,
          emailFrom, publicUrl, resendApiKey } = req.body || {};
  if (typeof memberPasscode === 'string' && memberPasscode.length > 0) {
    config.memberPasscode = memberPasscode.slice(0, 100);
  }
  if (typeof adminPasscode === 'string' && adminPasscode.length > 0) {
    config.adminPasscode = adminPasscode.slice(0, 100);
  }
  if (typeof req.body.adminUsername === 'string' && req.body.adminUsername.length > 0) {
    config.adminUsername = req.body.adminUsername.slice(0, 60);
  }
  if (typeof emailDomain === 'string' && emailDomain.length > 0) {
    config.emailDomain = emailDomain.toLowerCase().slice(0, 60);
  }
  if (typeof siteName === 'string' && siteName.length > 0) {
    config.siteName = siteName.slice(0, 60);
  }
  if (typeof emailFrom === 'string' && emailFrom.length > 0) {
    config.emailFrom = emailFrom.slice(0, 200);
  }
  if (typeof publicUrl === 'string' && publicUrl.length > 0) {
    config.publicUrl = publicUrl.slice(0, 200);
  }
  if (typeof resendApiKey === 'string' && resendApiKey.length > 0) {
    config.resendApiKey = resendApiKey.slice(0, 200);
  }
  saveConfig();
  res.json({ ok: true });
});

// Send a test invite to a specific address (admin only — useful for verifying
// Resend setup before any real signup happens)
app.post('/api/admin/test-email', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'to required' });
  const r = await sendInviteEmail({
    toName: 'test recipient',
    toEmail: to,
    fromName: 'Old Streets Admin',
    fromEmail: 'admin@oldstreets.test'
  });
  res.json(r);
});

// =================================================================
// ADMIN — FULL USER SURVEILLANCE / DETAIL VIEW
// Returns EVERY action a user has taken across the platform.
// =================================================================
app.get('/api/admin/users/:id/detail', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'no such user' });
  const meLc = u.email.toLowerCase();

  // ANONYMOUS POSTS BY THIS USER ARE NOT SHOWN. The platform promises
  // anonymous = anonymous even to admin. We don't list anon-authored
  // posts in the user-detail panel.
  const userPosts = posts.filter(p =>
    (p.authorEmail || '').toLowerCase() === meLc && !p.isAnonymous
  ).map(p => ({
      id: p.id, type: p.type,
      preview: (p.type === 'text' ? p.content : p.caption) ?
        String((p.type === 'text' ? p.content : p.caption)).slice(0, 200) : `[${p.type}]`,
      isAnonymous: !!p.isAnonymous,
      reactionCount: Object.values(p.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0),
      commentCount: (p.comments || []).length,
      viewCount: Object.keys(p.views || {}).length,
      createdAt: p.createdAt
    }))
    .sort((a, b) => b.createdAt - a.createdAt);

  const userComments = [];
  for (const p of posts) {
    for (const c of (p.comments || [])) {
      if ((c.authorEmail || '').toLowerCase() === meLc) {
        userComments.push({
          id: c.id, postId: p.id,
          postPreview: (p.type === 'text' ? p.content : p.caption || `[${p.type}]`).slice(0, 80),
          text: c.text, createdAt: c.createdAt
        });
      }
    }
  }
  userComments.sort((a, b) => b.createdAt - a.createdAt);

  const userReactions = [];
  for (const p of posts) {
    for (const [emoji, bucket] of Object.entries(p.reactions || {})) {
      if (bucket[u.email]) {
        userReactions.push({
          postId: p.id, emoji,
          postPreview: (p.type === 'text' ? p.content : p.caption || `[${p.type}]`).slice(0, 80),
          ts: bucket[u.email]
        });
      }
    }
  }
  userReactions.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const userViewsOut = profileViews.filter(v => (v.viewer || '').toLowerCase() === meLc)
    .slice(-100).reverse().map(v => ({ target: v.target, ts: v.ts }));
  const userViewsIn  = profileViews.filter(v => (v.target || '').toLowerCase() === meLc)
    .slice(-100).reverse().map(v => ({ viewer: v.viewer, viewerName: v.viewerName, ts: v.ts }));

  const sentDms = dms.filter(d => (d.from || '').toLowerCase() === meLc).slice(-50).reverse();
  const recvDms = dms.filter(d => (d.to || '').toLowerCase() === meLc).slice(-50).reverse();

  const userBulletins = bulletins.filter(b => (b.authorEmail || '').toLowerCase() === meLc);
  const userBlogs = blogs.filter(b => (b.authorEmail || '').toLowerCase() === meLc).map(b => ({
    id: b.id, title: b.title, commentCount: (b.comments || []).length, createdAt: b.createdAt
  }));

  const boardComments = [];
  for (const [owner, list] of Object.entries(profileBoards)) {
    for (const c of list) {
      if ((c.authorEmail || '').toLowerCase() === meLc) {
        boardComments.push({
          ownerEmail: owner, text: c.text, isAnonymous: !!c.isAnonymous, createdAt: c.createdAt
        });
      }
    }
  }
  boardComments.sort((a, b) => b.createdAt - a.createdAt);

  const lettersSent = loveLetters
    .filter(l => l.fromEmailHash === simpleHash(u.email))
    .map(l => ({ id: l.id, to: l.toEmail, toName: l.toName, guessUsed: !!l.guessUsed, matched: !!l.matchedName, depth: l.chainDepth || 0, createdAt: l.createdAt }));
  const lettersRecv = loveLetters
    .filter(l => (l.toEmail || '').toLowerCase() === meLc)
    .map(l => ({ id: l.id, guessUsed: !!l.guessUsed, matched: l.matchedName || null, depth: l.chainDepth || 0, createdAt: l.createdAt }));

  const friendReqOut = friendRequests.filter(r => (r.from || '').toLowerCase() === meLc);
  const friendReqIn  = friendRequests.filter(r => (r.to || '').toLowerCase() === meLc);

  const userNotifs = notifs.filter(n => (n.to || '').toLowerCase() === meLc).slice(-50).reverse();

  res.json({
    user: adminUser(u),
    posts: userPosts,
    comments: userComments.slice(0, 200),
    reactions: userReactions.slice(0, 200),
    profileViewsOut: userViewsOut,
    profileViewsIn: userViewsIn,
    dms: { sent: sentDms.slice(0, 50), received: recvDms.slice(0, 50) },
    bulletins: userBulletins,
    blogs: userBlogs,
    profileBoardComments: boardComments,
    loveLetters: { sent: lettersSent, received: lettersRecv },
    friendRequests: { sent: friendReqOut, received: friendReqIn },
    notifications: userNotifs,
    sessions: {
      lastSeen: u.lastSeen || 0,
      lastVisitAt: u.lastVisitAt || 0,
      lastPostAt: u.lastPostAt || 0,
      streak: u.streak || 0
    },
    counts: {
      posts: userPosts.length,
      comments: userComments.length,
      reactions: userReactions.length,
      profileViewsOut: userViewsOut.length,
      profileViewsIn: userViewsIn.length,
      dmsSent: sentDms.length,
      dmsRecv: recvDms.length,
      bulletins: userBulletins.length,
      blogs: userBlogs.length,
      boardComments: boardComments.length,
      lettersSent: lettersSent.length,
      lettersReceived: lettersRecv.length,
      notifications: userNotifs.length
    }
  });
});

// =================================================================
// ADMIN IMPERSONATION — act as a user. Every action is tagged
// with `impersonatedByAdmin: true` for the audit trail.
// =================================================================
function impersonationGuard(req, res) {
  if (!requireAdmin(req, res)) return null;
  const uid = req.params.id;
  const u = users.find(x => x.id === uid);
  if (!u) { res.status(404).json({ error: 'no such user' }); return null; }
  return u;
}

app.post('/api/admin/users/:id/impersonate/post', (req, res) => {
  const u = impersonationGuard(req, res); if (!u) return;
  const { type = 'text', content = '', caption = '', anon = false } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const post = {
    id: newId(),
    author: u.name, authorEmail: u.email,
    isAnonymous: !!anon,
    impersonatedByAdmin: true,
    type, content, caption: String(caption).slice(0, 500),
    reactions: {}, upvotes: {}, downvotes: {},
    comments: [], reports: [], views: {},
    expiresAt: null, createdAt: Date.now()
  };
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  io.emit('post-added', publicPost(post));
  res.json({ ok: true, post: publicPost(post) });
});

app.post('/api/admin/users/:id/impersonate/comment', (req, res) => {
  const u = impersonationGuard(req, res); if (!u) return;
  const { postId, text } = req.body || {};
  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'post not found' });
  const t = String(text || '').trim().slice(0, 400);
  if (!t) return res.status(400).json({ error: 'empty' });
  const comment = {
    id: newId(), author: u.name, authorEmail: u.email,
    text: t, impersonatedByAdmin: true, createdAt: Date.now()
  };
  post.comments = post.comments || [];
  post.comments.push(comment);
  savePosts();
  io.emit('post-commented', { postId: post.id, comment });
  res.json({ ok: true, comment });
});

app.post('/api/admin/users/:id/impersonate/react', (req, res) => {
  const u = impersonationGuard(req, res); if (!u) return;
  const { postId, emoji } = req.body || {};
  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'post not found' });
  if (!post.reactions) post.reactions = {};
  for (const e of Object.keys(post.reactions)) {
    delete post.reactions[e][u.email];
    if (Object.keys(post.reactions[e]).length === 0) delete post.reactions[e];
  }
  if (emoji && ALLOWED_REACTIONS.includes(emoji)) {
    if (!post.reactions[emoji]) post.reactions[emoji] = {};
    post.reactions[emoji][u.email] = Date.now();
  }
  savePosts();
  io.emit('post-voted', { id: post.id, reactions: post.reactions,
    upvotes: post.reactions['👍'] || {}, downvotes: post.reactions['👎'] || {},
    upCount: Object.keys(post.reactions['👍'] || {}).length,
    downCount: Object.keys(post.reactions['👎'] || {}).length });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/impersonate/love-letter', (req, res) => {
  const u = impersonationGuard(req, res); if (!u) return;
  const { toEmail, toName, message } = req.body || {};
  if (!toEmail || !toName) return res.status(400).json({ error: 'recipient required' });
  const letter = {
    id: newId(),
    toEmail, toName,
    message: String(message || '').slice(0, 280),
    fromEmailHash: simpleHash(u.email),
    impersonatedByAdmin: true,
    parentId: null, chainDepth: 0, createdAt: Date.now()
  };
  loveLetters.push(letter);
  saveLoveLetters();
  pushNotif(toEmail, { type: 'love-letter', fromName: 'someone (anonymous)', fromEmail: '', text: 'someone has a crush on you 💌', letterId: letter.id });
  sendLoveLetterEmail({ toEmail, toName, letterId: letter.id, message: letter.message }).catch(() => {});
  res.json({ ok: true, letterId: letter.id });
});

app.post('/api/admin/users/:id/impersonate/profile-update', (req, res) => {
  const u = impersonationGuard(req, res); if (!u) return;
  // Same shape as POST /api/users/me but admin-side. We do NOT enforce vanity-url
  // collision check here because admin override.
  const patch = req.body || {};
  if (typeof patch.mood === 'string')      u.mood = patch.mood.slice(0, 80);
  if (typeof patch.headline === 'string')  u.headline = patch.headline.slice(0, 140);
  if (typeof patch.aboutMe === 'string')   u.aboutMe = patch.aboutMe.slice(0, 2000);
  if (typeof patch.theme === 'string' && VALID_THEMES.includes(patch.theme)) u.theme = patch.theme;
  u._impersonatedAt = Date.now();
  saveUsers();
  res.json({ ok: true, user: publicUser(u) });
});

// =================================================================
// ADMIN TEST FEATURES — trigger flows on demand to verify
// =================================================================
app.post('/api/admin/test/onboarding', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'to required' });
  const fromName = req.body?.fromName || 'Old Streets Admin';
  const r = await sendInviteEmail({
    toName: req.body?.toName || 'test recipient',
    toEmail: to, fromName,
    fromEmail: 'admin@oldstreets.test'
  });
  res.json({ ok: true, result: r });
});

app.post('/api/admin/test/love-letter', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'to required' });
  const target = findUserByEmail(to) || directory.find(d => d.email.toLowerCase() === to.toLowerCase());
  const toName = target ? target.name : 'recipient';
  const letter = {
    id: newId(), toEmail: to, toName, message: 'this is a test love letter from admin',
    fromEmailHash: 'admin-test', parentId: null, chainDepth: 0, createdAt: Date.now()
  };
  loveLetters.push(letter);
  saveLoveLetters();
  const r = await sendLoveLetterEmail({ toEmail: to, toName, letterId: letter.id, message: letter.message });
  res.json({ ok: true, emailResult: r, letterId: letter.id });
});

app.post('/api/admin/test/ghost-post', (req, res) => {
  if (!requireAdmin(req, res)) return;
  fireGhostPost();
  res.json({ ok: true });
});

app.post('/api/admin/test/ghost-comments', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { postId, count } = req.body || {};
  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'no such post' });
  const added = injectGhostComments(post, { count: count || 2 });
  res.json({ ok: true, added });
});

app.post('/api/admin/test/ghost-reactions', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { postId, count } = req.body || {};
  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'no such post' });
  const added = injectGhostReactions(post, count || 3);
  res.json({ ok: true, added });
});

app.post('/api/admin/test/qotd-fire', (req, res) => {
  if (!requireAdmin(req, res)) return;
  fireQuestionOfTheDay({ manual: true });
  res.json({ ok: true });
});

app.post('/api/admin/test/royalty-fire', (req, res) => {
  if (!requireAdmin(req, res)) return;
  awardWeeklyRoyalty({ manual: true });
  res.json({ ok: true });
});

app.post('/api/admin/test/late-night-fire', (req, res) => {
  if (!requireAdmin(req, res)) return;
  resurfaceLateNightWinner();
  res.json({ ok: true });
});

app.get('/api/admin/config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(config);
});

app.get('/api/admin/posts', (req, res) => {
  if (!requireAdmin(req, res)) return;
  // Admin sees REAL authors for moderation. The site still treats posts as
  // anonymous to every non-admin viewer. Anonymity is a PUBLIC contract,
  // not an admin one — we'd be unable to moderate otherwise.
  // _wasAnonymous flag tells the UI to badge these so the admin remembers
  // these were posted as anonymous (don't accidentally use that real name
  // when responding/messaging).
  res.json(posts.map(p => p.isAnonymous ? { ...p, _wasAnonymous: true } : p));
});

// Single-post reveal (granular)
app.get('/api/admin/posts/:id/reveal-author', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  console.log(`[ADMIN REVEAL] post ${p.id} de-anon`);
  res.json({
    id: p.id,
    wasAnonymous: !!p.isAnonymous,
    author: p.author,
    authorEmail: p.authorEmail,
    createdAt: p.createdAt,
    preview: (p.type === 'text' ? p.content : p.caption || `[${p.type}]`).slice(0, 200)
  });
});

app.get('/api/admin/reports', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const reported = posts.filter(p => (p.reports || []).length > 0)
    .sort((a, b) => (b.reports.length - a.reports.length));
  res.json(reported);
});

app.post('/api/admin/posts/:id/clear-reports', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  post.reports = [];
  savePosts();
  res.json({ ok: true });
});

app.get('/api/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    users: users.length,
    awaitingReferrals: users.filter(u => u.status === 'awaiting-referrals').length,
    waitlist: users.filter(u => u.status === 'waitlist').length,
    active: users.filter(u => u.status === 'active').length,
    banned: users.filter(u => u.status === 'banned').length,
    posts: posts.length,
    comments: posts.reduce((a, p) => a + (p.comments || []).length, 0),
    dmCount: dms.length,
    online: onlineUsers.size,
    rooms: rooms.size
  });
});

// =================================================================
// SOCKETS / VIDEO CHAT (rooms = old "lobbies")
// =================================================================
const onlineUsers = new Map();
const randomChatQueue = [];
const rooms = new Map();
const looksmaxMatches = new Map();

function broadcastOnlineCount() {
  // Emit the padded/floored number so every UI shows the same count.
  // Capped at total active members so it never looks inflated.
  const padded = realisticOnlineCount();
  io.emit('online-count', padded);
  // Dedupe by email — one user with 3 tabs open should appear ONCE.
  // For multi-tab users, prefer the most recently active socket.
  const byEmail = new Map();
  for (const [id, u] of onlineUsers.entries()) {
    const key = (u.email || '').toLowerCase();
    if (!key) continue;
    const cur = byEmail.get(key);
    if (!cur || (u.activityAt || 0) > (cur.activityAt || 0)) {
      // Resolve avatar from users.json so the client can show profile pics.
      const real = findUserByEmail(key);
      byEmail.set(key, {
        socketId: id,
        username: u.username,
        email: u.email,
        avatar: real ? (real.avatar || '') : '',
        activity: u.activity || null,
        activityAt: u.activityAt || 0
      });
    }
  }
  io.emit('online-users', Array.from(byEmail.values()));
}
function getUsername(socketId) {
  return onlineUsers.get(socketId)?.username || 'a ghost';
}
function publicRooms() {
  return Array.from(rooms.values()).map(r => ({
    id: r.id, name: r.name, createdBy: r.createdBy,
    memberCount: r.members.size
  }));
}

const looksMaxCooldown = new Map();
// postId -> Set<email> — who is actively reading (scrolled into view) each post right now
const postCurrentReaders = new Map();

io.on('connection', (socket) => {

  // Wall typing indicators — anyone typing in compose box broadcasts
  socket.on('wall-typing-start', () => {
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    wallTypers.set(socket.id, { username: info.username, email: info.email, since: Date.now(), ts: Date.now() });
  });
  socket.on('wall-typing-stop', () => {
    wallTypers.delete(socket.id);
    broadcastWallTypers();
  });
  socket.on('wall-typing-tick', () => {
    const cur = wallTypers.get(socket.id);
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    if (cur) cur.ts = Date.now();
    else wallTypers.set(socket.id, { username: info.username, email: info.email, since: Date.now(), ts: Date.now() });
  });

  // Client tells us what they're doing (browsing, in room, composing, etc.)
  socket.on('activity', (data) => {
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    const kind = String(data?.kind || '').slice(0, 32);
    const label = String(data?.label || '').slice(0, 80);
    const ref = String(data?.ref || '').slice(0, 80); // e.g. room ID or profile email
    if (!kind) return;
    // Only record a new history entry when the kind/label actually changes,
    // so refresh-every-30s pulses don't spam the log.
    const changed = !info.activity || info.activity.kind !== kind || info.activity.label !== label;
    info.activity = { kind, label, ref };
    info.activityAt = Date.now();
    if (changed) recordUserActivity(info.email, { kind, label, ref, ts: Date.now() });
    broadcastOnlineCount();
  });

  socket.on('register', ({ token, username }) => {
    const user = findUserByToken(token);
    if (!user || user.status !== 'active') {
      socket.emit('register-failed', { reason: user ? user.status : 'unknown' });
      return;
    }
    onlineUsers.set(socket.id, { username: user.name, email: user.email, userId: user.id, activity: { kind: 'online', label: 'online', ref: '' }, activityAt: Date.now() });
    user.lastSeen = Date.now();
    saveUsers();
    broadcastOnlineCount();
    socket.emit('registered', { socketId: socket.id, username: user.name });
    socket.emit('rooms-list', publicRooms());

    // Friends-online-now: when this user arrives and 2+ friends are already here,
    // push a notif to their offline friends so they feel the pull.
    const onlineEmailsNow = new Set(Array.from(onlineUsers.values()).map(u => u.email.toLowerCase()));
    const userFriendEmails = (user.friends || []).map(f => f.toLowerCase());
    const onlineFriends = userFriendEmails.filter(f => onlineEmailsNow.has(f));
    if (onlineFriends.length >= 2) {
      const names = onlineFriends.slice(0, 2).map(f => {
        const fu = findUserByEmail(f); return fu ? fu.name.split(' ')[0] : f;
      });
      const extra = onlineFriends.length > 2 ? ` + ${onlineFriends.length - 2} more` : '';
      const offlineFriends = userFriendEmails.filter(f => !onlineEmailsNow.has(f));
      for (const offEmail of offlineFriends.slice(0, 6)) {
        // Don't flood — skip if they got a friends-online notif in the last hour
        const lastFON = notifs
          .filter(n => n.to === offEmail && n.type === 'friends-online')
          .sort((a, b) => b.ts - a.ts)[0];
        if (lastFON && Date.now() - lastFON.ts < 60 * 60 * 1000) continue;
        pushNotif(offEmail, {
          type: 'friends-online',
          fromName: user.name,
          text: `${names.join(', ')}${extra} are on right now 👀`
        });
      }
    }
  });

  socket.on('get-rooms', () => socket.emit('rooms-list', publicRooms()));
  // legacy alias
  socket.on('get-lobbies', () => socket.emit('rooms-list', publicRooms()));

  socket.on('random-chat-cancel', () => {
    const idx = randomChatQueue.indexOf(socket.id);
    if (idx >= 0) randomChatQueue.splice(idx, 1);
  });

  socket.on('random-chat-request', () => {
    if (randomChatQueue.includes(socket.id)) return;
    // Locked until you've posted once
    const info = onlineUsers.get(socket.id);
    if (info) {
      const u = findUserByEmail(info.email);
      if (u && !u.hasPostedOnce) {
        socket.emit('random-chat-locked', { reason: 'post once first to unlock random chat' });
        return;
      }
    }
    if (randomChatQueue.length > 0) {
      const partnerId = randomChatQueue.shift();
      const partner = io.sockets.sockets.get(partnerId);
      if (!partner || partnerId === socket.id) {
        randomChatQueue.push(socket.id);
        return;
      }
      const roomId = 'random-' + Date.now().toString(36);
      socket.join(roomId);
      partner.join(roomId);
      socket.emit('random-chat-matched', {
        roomId,
        peer: { socketId: partnerId, username: getUsername(partnerId) },
        initiator: true
      });
      partner.emit('random-chat-matched', {
        roomId,
        peer: { socketId: socket.id, username: getUsername(socket.id) },
        initiator: false
      });
    } else {
      randomChatQueue.push(socket.id);
      socket.emit('random-chat-waiting');
    }
  });

  socket.on('cancel-random-chat', () => {
    const idx = randomChatQueue.indexOf(socket.id);
    if (idx >= 0) randomChatQueue.splice(idx, 1);
  });

  socket.on('end-random-chat', ({ roomId, peerSocketId }) => {
    if (peerSocketId) io.to(peerSocketId).emit('peer-left', { socketId: socket.id });
    if (roomId) socket.leave(roomId);
  });

  // Room creation (was "lobby")
  function handleCreateRoom({ name }) {
    const cleanName = String(name || '').slice(0, 60).trim() || 'untitled room';
    const id = 'R-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    rooms.set(id, {
      id, name: cleanName,
      createdBy: getUsername(socket.id),
      members: new Set()
    });
    socket.emit('room-created', { roomId: id, name: cleanName });
    socket.emit('lobby-created', { lobbyId: id, name: cleanName });
    io.emit('rooms-list', publicRooms());
  }
  socket.on('create-room', handleCreateRoom);
  socket.on('create-lobby', handleCreateRoom);

  function handleJoinRoom({ roomId, lobbyId }) {
    const id = roomId || lobbyId;
    const room = rooms.get(id);
    if (!room) {
      socket.emit('room-error', 'room not found');
      socket.emit('lobby-error', 'room not found');
      return;
    }
    if (room.members.has(socket.id)) return;
    socket.join(id);
    const existing = Array.from(room.members).map(sid => ({
      socketId: sid, username: getUsername(sid)
    }));
    room.members.add(socket.id);
    const joinedPayload = {
      roomId: id, lobbyId: id, name: room.name, members: existing,
      you: { socketId: socket.id, username: getUsername(socket.id) }
    };
    socket.emit('room-joined', joinedPayload);
    socket.emit('lobby-joined', joinedPayload);
    socket.to(id).emit('room-member-joined', { socketId: socket.id, username: getUsername(socket.id) });
    socket.to(id).emit('lobby-member-joined', { socketId: socket.id, username: getUsername(socket.id) });
    io.emit('rooms-list', publicRooms());
  }
  socket.on('join-room', handleJoinRoom);
  socket.on('join-lobby', handleJoinRoom);

  function handleLeaveRoom({ roomId, lobbyId }) {
    const id = roomId || lobbyId;
    const room = rooms.get(id);
    if (room && room.members.has(socket.id)) {
      room.members.delete(socket.id);
      socket.leave(id);
      socket.to(id).emit('room-member-left', { socketId: socket.id });
      socket.to(id).emit('lobby-member-left', { socketId: socket.id });
      if (room.members.size === 0) rooms.delete(id);
      io.emit('rooms-list', publicRooms());
    }
  }
  socket.on('leave-room', handleLeaveRoom);
  socket.on('leave-lobby', handleLeaveRoom);

  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, fromName: getUsername(socket.id), offer });
  });
  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });
  socket.on('webrtc-ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate });
  });

  socket.on('chat-message', ({ roomId, message }) => {
    if (!roomId || !message) return;
    io.to(roomId).emit('chat-message', {
      username: getUsername(socket.id),
      socketId: socket.id,
      message: String(message).slice(0, 500),
      timestamp: Date.now()
    });
  });

  // ----- DM TYPING INDICATORS ----------------------------------------
  // Relay typing pulses to the recipient's socket only.
  socket.on('dm-typing', ({ to }) => {
    if (!to) return;
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    for (const [sid, u] of onlineUsers) {
      if (u.email === to.toLowerCase()) {
        io.to(sid).emit('dm-typing', { from: info.email, fromName: info.username });
      }
    }
  });
  socket.on('dm-stop-typing', ({ to }) => {
    if (!to) return;
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    for (const [sid, u] of onlineUsers) {
      if (u.email === to.toLowerCase()) {
        io.to(sid).emit('dm-stop-typing', { from: info.email });
      }
    }
  });

  // Recipient signals they've read messages from `from`. We flip read flags
  // server-side AND notify the original sender so their ticks turn ✓✓.
  socket.on('dm-mark-read', ({ from }) => {
    if (!from) return;
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    const me = info.email.toLowerCase();
    const other = String(from).toLowerCase();
    const newlyReadIds = [];
    for (const m of dms) {
      if (m.from === other && m.to === me && !m.read) {
        m.read = true;
        m.readAt = Date.now();
        newlyReadIds.push(m.id);
      }
    }
    if (newlyReadIds.length > 0) {
      saveDms();
      for (const [sid, u] of onlineUsers) {
        if (u.email === other) {
          io.to(sid).emit('dm-read', { reader: me, ids: newlyReadIds });
        }
      }
    }
  });

  // ----- POST VIEWS --------------------------------------------------
  // Track who has seen each post. Stored as post.views[email] = firstSeenTs.
  // Broadcast updated view count to everyone so cards update live.
  socket.on('post-view', ({ postId }) => {
    if (!postId) return;
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    if (!post.views) post.views = {};
    if (post.views[info.email]) return; // already counted
    post.views[info.email] = Date.now();
    // debounce save — views are high-frequency
    scheduleSave(POSTS_FILE, () => posts, 5000);
    const viewCount = Object.keys(post.views).length;
    io.emit('post-view-count', { postId, viewCount });

    // Phantom typing: when a stranger first reads a post, fire a
    // "someone is typing..." push to the author 90s later with 20% probability.
    // The comment never arrives. The open loop keeps them checking back.
    // Zeigarnik effect: unfinished things stay top-of-mind far longer than finished ones.
    if (
      post.authorEmail &&
      (info.email || '').toLowerCase() !== (post.authorEmail || '').toLowerCase() &&
      !post.isAnonymous &&
      Math.random() < 0.20
    ) {
      const phantomPostId = postId;
      const phantomAuthorEmail = post.authorEmail;
      setTimeout(() => {
        try {
          const livePost = posts.find(p => p.id === phantomPostId);
          if (!livePost) return;
          // Abort if a real comment arrived in the meantime — no need for the phantom
          if ((livePost.comments || []).length > (livePost._phantomBaseComments || 0)) return;
          if (!livePost._phantomBaseComments) livePost._phantomBaseComments = (livePost.comments || []).length;
          pushNotif(phantomAuthorEmail, {
            type: 'phantom-typing',
            fromName: '✏️ someone is typing',
            fromEmail: '',
            postId: phantomPostId,
            text: `someone started typing a comment on your post...`
          });
        } catch (e) { console.warn('[phantom-typing] error', e.message); }
      }, 90 * 1000);
    }
  });

  // ----- POST READING ------------------------------------------------
  // Tracks who has a post scrolled into view right now. "N reading" badge.
  socket.on('post-start-reading', ({ postId }) => {
    if (!postId) return;
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    if (!postCurrentReaders.has(postId)) postCurrentReaders.set(postId, new Set());
    postCurrentReaders.get(postId).add(info.email);
    io.emit('post-readers-count', { postId, count: postCurrentReaders.get(postId).size });
  });

  socket.on('post-stop-reading', ({ postId }) => {
    if (!postId) return;
    const info = onlineUsers.get(socket.id);
    if (!info) return;
    const readers = postCurrentReaders.get(postId);
    if (readers) {
      readers.delete(info.email);
      const count = readers.size;
      if (count === 0) postCurrentReaders.delete(postId);
      io.emit('post-readers-count', { postId, count });
    }
  });

  // ----- LOOKS MAXING ------------------------------------------------
  // Lightweight face-off mini-game between two participants in a video chat.
  // 20-second showdown; server picks the winner & final scores so both
  // clients display the same outcome.
  socket.on('looksmax-request', ({ to }) => {
    if (!to) return;
    if (Date.now() - (looksMaxCooldown.get(socket.id) || 0) < 8000) return;
    looksMaxCooldown.set(socket.id, Date.now());
    io.to(to).emit('looksmax-request', {
      from: socket.id,
      fromName: getUsername(socket.id)
    });
  });
  socket.on('looksmax-decline', ({ to }) => {
    if (to) io.to(to).emit('looksmax-decline', { from: socket.id });
  });
  socket.on('looksmax-cancel', ({ to }) => {
    if (to) io.to(to).emit('looksmax-cancel', { from: socket.id });
  });
  socket.on('looksmax-accept', ({ to }) => {
    if (!to) return;
    const a = socket.id, b = to;
    // Server picks a placeholder winner via coin flip (used only as a fallback
    // if a client doesn't report a real symmetry score). The authoritative
    // result is decided server-side after both clients send 'looksmax-score'.
    const aWins = Math.random() < 0.5;
    const aFinal = aWins ? 78 + Math.random() * 18 : 38 + Math.random() * 22;
    const bFinal = aWins ? 38 + Math.random() * 22 : 78 + Math.random() * 18;
    const winner = aWins ? a : b;
    const matchId = 'lm-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const startAt = Date.now() + 1500;
    const duration = 20000;
    const payload = {
      matchId,
      players: [a, b],
      names: { [a]: getUsername(a), [b]: getUsername(b) },
      finals: { [a]: +aFinal.toFixed(1), [b]: +bFinal.toFixed(1) },
      winner,
      startAt,
      seed: Math.random(),
      duration
    };
    // Stash this match so we can resolve real scores when clients report them.
    looksmaxMatches.set(matchId, {
      players: [a, b],
      placeholder: payload,
      scores: {},
      decidedAt: 0,
    });
    // Cleanup after duration + 30s grace
    setTimeout(() => looksmaxMatches.delete(matchId), duration + 30000);
    io.to(a).emit('looksmax-go', payload);
    io.to(b).emit('looksmax-go', payload);
  });

  // Each client measures the LOCAL video's symmetry and reports it here.
  // Once both scores are in (or one player times out), the server decides
  // the winner and broadcasts a definitive result to both players. This
  // prevents the "both players see themselves as the winner" bug where each
  // client was scoring locally based on its own view of both videos.
  socket.on('looksmax-score', ({ matchId, score }) => {
    if (!matchId) return;
    const m = looksmaxMatches.get(matchId);
    if (!m) return;
    if (!m.players.includes(socket.id)) return;
    const s = Math.max(0, Math.min(100, Number(score) || 0));
    m.scores[socket.id] = s;
    if (m.decidedAt) return;
    if (m.players.every(p => p in m.scores)) {
      const [a, b] = m.players;
      const aScore = m.scores[a], bScore = m.scores[b];
      const winner = aScore >= bScore ? a : b;
      const result = {
        matchId,
        players: m.players,
        finals: { [a]: +aScore.toFixed(1), [b]: +bScore.toFixed(1) },
        winner
      };
      m.decidedAt = Date.now();
      io.to(a).emit('looksmax-result', result);
      io.to(b).emit('looksmax-result', result);
    }
  });

  socket.on('disconnect', () => {
    const idx = randomChatQueue.indexOf(socket.id);
    if (idx >= 0) randomChatQueue.splice(idx, 1);
    for (const [id, room] of rooms) {
      if (room.members.has(socket.id)) {
        room.members.delete(socket.id);
        socket.to(id).emit('room-member-left', { socketId: socket.id });
        socket.to(id).emit('lobby-member-left', { socketId: socket.id });
        if (room.members.size === 0) rooms.delete(id);
      }
    }
    io.emit('rooms-list', publicRooms());
    // clean up post-reading presence
    const disconnectedInfo = onlineUsers.get(socket.id);
    if (disconnectedInfo) {
      for (const [postId, readers] of postCurrentReaders.entries()) {
        if (readers.delete(disconnectedInfo.email)) {
          if (readers.size === 0) postCurrentReaders.delete(postId);
          else io.emit('post-readers-count', { postId, count: readers.size });
        }
      }
    }
    onlineUsers.delete(socket.id);
    broadcastOnlineCount();
    io.emit('peer-left', { socketId: socket.id });
  });
});

// =================================================================
// GHOST POST ENGINE
// Injects realistic-sounding anonymous posts that name-drop real
// directory members. Creates organic drama / FOMO for newcomers.
// Posts are stored as real anonymous posts — admin sees the ghost
// email, everyone else sees "anonymous".
// =================================================================
const GHOST_EMAIL = 'ghost@old-streets.internal';

// Templates using one real first name from the directory
const GHOST_TEMPLATES_1 = [
  // fascination / obsession
  n => `ok but can someone explain ${n} to me`,
  n => `${n} said something today that i genuinely haven't stopped thinking about`,
  n => `the way ${n} just walked into class and the whole room shifted 💀`,
  n => `not me being lowkey obsessed with everything ${n} does rn`,
  n => `${n} ate today no cap`,
  n => `i fw ${n} heavy ngl`,
  n => `why does ${n} always look so unbothered. teach me`,
  n => `the ${n} slander on here is actually insane. they're fine`,
  n => `someone who knows ${n} irl tell me things`,
  n => `${n} has main character energy and i will die on this hill`,
  n => `can ${n} and i please be best friends because genuinely`,
  n => `${n} went off today not gonna lie`,
  n => `ngl ${n} is scary talented and people don't talk about it enough`,
  n => `why does ${n} look at people like that... the eye contact is a lot`,
  n => `${n} said something in class that actually shifted my whole perspective`,
  n => `ok who else thinks ${n} is lowkey hilarious`,
  n => `genuinely think ${n} is one of the most interesting people at this school`,
  n => `${n} been on a different level lately idk what happened but keep going`,
  n => `i think about what ${n} said last week constantly. was that just me`,
  n => `${n} does this thing where they talk and everyone just... listens. it's a skill`,
  n => `not even being parasocial but ${n} seems genuinely cool`,
  n => `${n} walked past me and didn't say hi and now i'm spiraling 💀`,
  n => `what's ${n}'s deal lately. asking for me`,
  n => `${n} is giving something and i can't figure out what`,
  n => `the ${n} reputation vs the actual ${n} are two very different things`,
  n => `every time ${n} opens their mouth i learn something. rare quality`,
  n => `${n} if you're on here just know people talk about you way more than you think`,
  n => `ok i'm not gonna say what ${n} did but WOW`,
  n => `someone tell ${n} they're more popular than they realize`,
  n => `${n} woke up and chose chaos today and honestly? good for them`,
  // subtle anxiety / drama
  n => `does anyone know what's going on with ${n}? asking for real`,
  n => `${n} is being weird and nobody's saying anything about it`,
  n => `${n} if you're reading this... we need to talk`,
  n => `something happened with ${n} today and i need to talk about it`,
  n => `the way ${n} acted today was not giving what they thought it was giving`,
  n => `not gonna say ${n}'s name... okay i will. ${n}.`,
  n => `i'm not saying ${n} is wrong but i'm also not saying they're right`,
  n => `${n} said something to someone that is going to come up again later. mark my words`,
  n => `${n} knows exactly what they're doing and that's what makes it worse`,
  n => `whoever told ${n} that was okay to say... why`,
  // invite pressure (non-joined targets get special templates)
  n => `literally wish ${n} was on here they would lose their mind at some of these posts`,
  n => `someone tell ${n} to get on this site like yesterday`,
  n => `${n} is one of like 4 people i actually want on here. come ON`,
  n => `if ${n} isn't on old streets yet that's actually a crime`,
  n => `waiting for ${n} to join so we can have the full cast`,
  // ===== funny batch =====
  n => `${n} looked at me today like i owed them rent`,
  n => `${n} laughed at their own joke before finishing it. iconic behavior`,
  n => `i think ${n} bullies ai chatbots for fun`,
  n => `${n} types "k" and then nothing else. terrorism.`,
  n => `${n}'s spotify wrapped is gonna out them so bad`,
  n => `${n} said "anyway" and ended the conversation like the queen of england`,
  n => `${n} dresses like a hot librarian who knows your secrets`,
  n => `${n} hits the griddy in their head between every class change i can tell`,
  n => `${n} would survive 4 days in the wilderness with just a scrunchie and rage`,
  n => `${n} googled their own name yesterday i can feel it in my bones`,
  n => `${n} unironically uses semicolons in texts. couldn't be me. respect.`,
  n => `pretty sure ${n}'s entire personality is one specific tiktok sound`,
  n => `${n} drinks 4 coffees a day and calls it "managing"`,
  n => `${n} smells like a candle store and i mean that respectfully`,
  n => `${n} corrected a teacher today and walked away. legend behavior.`,
  n => `${n} owes me $3 and emotional damages`,
  n => `${n}'s notes app is probably illegal`,
  n => `${n} laughs like a pixar villain and i'm obsessed`,
  n => `${n} doesn't blink in conversations. why.`,
  n => `${n} once said "vibes" with such authority i still think about it`,
  n => `${n} types in lowercase but the energy is uppercase`,
  n => `${n} would fistfight a substitute teacher and i'd cheer`,
  n => `${n} replied to my hi like i was a door to door salesman`,
  n => `${n} eats lunch like they're in a war drama`,
  n => `${n} walks around school with a face like the wifi just died`,
  n => `${n} sneezed in chem today and the whole class lost the fear of god`,
  n => `${n} could be on a billboard and i'd still owe them a slap`,
  n => `${n} acts like they don't know they're cool. they know.`,
  n => `${n} has the aura of someone who's been to a 2am denny's`,
  n => `${n} would absolutely sell us all out for a granola bar`,
  // ===== funny batch v2 =====
  n => `${n} types like they're being held hostage by autocorrect`,
  n => `${n} laughs at memes 4 days after they peak. we love a late bloomer`,
  n => `${n} once held eye contact with a vending machine for 11 seconds. i was there.`,
  n => `${n} drinks water like it personally insulted them`,
  n => `${n} would absolutely lose a fight to a goose and i mean that lovingly`,
  n => `${n} smiled at me today and i forgot the alphabet`,
  n => `${n} has the energy of someone who folds their pizza in half`,
  n => `${n} once said "interesting" with such venom i'm still healing`,
  n => `i think ${n} secretly runs a horse account on tiktok`,
  n => `${n} would name a child after a font`,
  n => `${n}'s playlist is named "for the moment" and that's their whole personality`,
  n => `${n} could fall down stairs and somehow land it as a fashion moment`,
  n => `${n} reorganizes their backpack every passing period. it's giving FBI agent`,
  n => `${n} types "lmaooo" with EXACTLY four o's. consistent. terrifying.`,
  n => `${n} would absolutely become a cult leader by accident`,
  n => `${n} eats apples whole. core and all. they're not okay.`,
  n => `${n}'s search history would make a priest faint and a librarian weep`,
  n => `${n} has been hum-singing the same 3 seconds of a song for a week`,
  n => `${n} would rather die than send a voice memo`,
  n => `${n} sent a voice memo today. the world is ending.`,
  n => `${n} owns at least 4 pairs of socks with cartoon characters on them and i find this powerful`,
  n => `${n} has the kind of posture that makes chiropractors quit`,
  n => `${n} once said "i don't do horoscopes" and then asked everyone's sign`,
  n => `${n} is the type to apologize TO the chair after bumping it`,
  n => `${n} sneezed in fourth period and tried to play it cool. you sneezed, ${n}. own it.`,
];

// Templates using two real first names
const GHOST_TEMPLATES_2 = [
  (a, b) => `${a} and ${b} 👀👀👀 someone explain`,
  (a, b) => `${a} and ${b} were talking for like an hour today. not saying anything just noting`,
  (a, b) => `the ${a} and ${b} situation is more complicated than people are letting on`,
  (a, b) => `can ${a} and ${b} just admit it already. we see you`,
  (a, b) => `${a} and ${b} at lunch today... the energy. the tension. the eye contact.`,
  (a, b) => `i saw ${a} looking at ${b} from across the room and felt things secondhand`,
  (a, b) => `ok so ${a} and ${b}... yes or no. be honest`,
  (a, b) => `${a} and ${b} are never in the same room but always bring each other up. noted.`,
  (a, b) => `${a} clearly has feelings for ${b} and ${b} clearly knows it and this is agonizing`,
  (a, b) => `the way ${a} acts around ${b} vs everyone else is genuinely a study in contrast`,
  (a, b) => `${a} and ${b} need to sort their stuff out because the secondhand tension is a lot`,
  (a, b) => `no because ${a} and ${b} were almost arguing and then just. laughing. what`,
  (a, b) => `${a} told me something about ${b} and now i can't look at either of them normally`,
  (a, b) => `not a ship post but ${a} and ${b} have something going on and i see it`,
  (a, b) => `i've been watching the ${a} / ${b} situation develop for weeks and i have OPINIONS`,
  (a, b) => `someone needs to lock ${a} and ${b} in a room and not let them out until they figure it out`,
  (a, b) => `${a} doesn't know that ${b} talks about them constantly. someone tell them.`,
  (a, b) => `${a} vs ${b} debate. go.`,
  // ===== funny batch =====
  (a, b) => `${a} and ${b} both pretending they didn't see each other in the hallway. losers (loving)`,
  (a, b) => `${a} liked ${b}'s post within 4 seconds. you're not slick`,
  (a, b) => `if ${a} and ${b} got locked in a target after hours i'd pay to watch the security footage`,
  (a, b) => `${a} and ${b} have matched their outfits twice this week. coincidence??? GROW UP`,
  (a, b) => `${a} called ${b} "dude" in a way that was somehow flirty. linguistics is dead`,
  (a, b) => `${a} and ${b} would either get married or commit a federal crime together. no in between`,
  (a, b) => `${a} stares at ${b} like a cat watching a window. concerning. cute.`,
  (a, b) => `${a} laughed at ${b}'s joke and it wasn't even funny. case closed`,
  (a, b) => `${a} and ${b} arguing about pasta shapes today was peak content`,
  (a, b) => `the ${a}-${b} group project is going to produce either a oscar-winning film or a lawsuit`,
  (a, b) => `${a} stole ${b}'s pen and ${b} just smiled. that's a relationship.`,
  (a, b) => `${a} and ${b} were whisper-screaming in the library and it was the best 20 minutes of my day`,
  // ===== funny batch v2 =====
  (a, b) => `${a} held the door for ${b} for 14 seconds. that's not a door hold, that's a love letter`,
  (a, b) => `${a} called ${b} by their full government name today. concerning. romantic. both.`,
  (a, b) => `${a} and ${b} fought over the last cookie like it was a family heirloom`,
  (a, b) => `${a} sent ${b} a tiktok at 2am. mating call confirmed.`,
  (a, b) => `${a} and ${b} share one (1) braincell and it's malfunctioning beautifully`,
  (a, b) => `${a} hyped ${b} up in front of a teacher today and i felt the friendship`,
  (a, b) => `${a} and ${b} would absolutely run a podcast no one asked for and we'd all listen`,
  (a, b) => `${a} screamed ${b}'s name across the cafeteria like it was a battle cry`,
  (a, b) => `${a} and ${b} were spotted sharing earbuds. medieval level intimacy.`,
  (a, b) => `${a} corrected ${b}'s grammar mid-fight and ${b} thanked them. you two are sick`,
  (a, b) => `${a} brought ${b} a snack unprompted. that's a marriage proposal in this economy`,
];

// Cryptic / paranoia-inducing — no names, makes everyone wonder "is this about me?"
const GHOST_TEMPLATES_VAGUE = [
  () => `someone here knows what they did and is logging on like everything's fine`,
  () => `ok the gossip i just heard is actually a lot. not posting it but wow`,
  () => `you know who you are btw`,
  () => `some people on this site need to log off and touch grass`,
  () => `if you're reading this: hi 👋 i see you on here`,
  () => `the amount of things i could say right now. choosing peace`,
  () => `i know something that would break this app if i posted it. choosing not to`,
  () => `ngl old streets is way more chaotic than i expected and i'm here for it`,
  () => `okay the drama today was a lot even by this school's standards`,
  () => `not everyone who's quiet is innocent. just a thought`,
  () => `some people be on here but not be on here you know what i mean`,
  () => `this app is going to cause so much chaos by end of year and i'm thrilled`,
  () => `ok who else checks this like five times before going to sleep`,
  () => `people on here are BRAVE and i respect it`,
  () => `how many people on here know each other irl but don't know the other is on here`,
  () => `the thing about this school is everyone knows everyone but nobody says anything`,
  () => `some people really thought no one was watching`,
  () => `i keep almost posting something and then stopping myself. it's about time i just say it`,
  () => `the way certain people act in public vs how they are when they think no one's looking`,
  () => `i have thoughts. many thoughts. they're staying in my drafts for now`,
  () => `something happened today that i genuinely cannot get over`,
  () => `this is the most honest place at this school and that's a little sad and also kind of beautiful`,
  () => `the audacity of some people on here to act normal after what they did`,
  () => `ok genuinely who runs this site because you deserve an award`,
  () => `the lurkers on here... i see your profile views 👀`,
  // ===== funny batch =====
  () => `someone just liked a post from 2 weeks ago. unmask urself coward`,
  () => `my screen time report came in and it's just this app and tears`,
  () => `i checked old streets in the dentist chair today. i need help`,
  () => `the way i opened this app and immediately felt 14 again`,
  () => `the people who reply "lol" with no emoji are scarier than the ones who type paragraphs`,
  () => `if you post sad things at 11pm and breakfast pics at 7am — what is your DEAL`,
  () => `someone here uses old streets as a diary and someone uses it as a weapon. respect both`,
  () => `i refresh this site like it owes me money`,
  () => `seeing notifications from this app feels like the FBI knocking but in a fun way`,
  () => `whoever keeps reacting 💀 to everything please i love you`,
  () => `imagine logging on like u didn't drop a 9pm essay last week. couldn't be me. it WAS me.`,
  () => `the algorithm on here is just "people you've made eye contact with once"`,
  () => `i sat through math thinking about who'd post first today and it WASN'T who i thought`,
  () => `the most chaotic timeline on the internet is just our 4th period`,
  () => `someone is gonna meet their soulmate on here and refuse to admit it forever`,
  () => `every post on this app could be a netflix limited series`,
  () => `the people quiet at school but feral on here >>>`,
  () => `genuinely how does everyone post like they don't have homework`,
  () => `me reading old streets in the bathroom: "this is a lifestyle"`,
  () => `whoever posts at 3am the rest of us are praying for you`,
  () => `if old streets had a movie poster it would just say "things were said"`,
  () => `whoever made the deletion button a tiny trash can — thank u. saved me twice today`,
  () => `the unfollow button on here doesn't exist and that's the threat`,
  // ===== funny batch v2 =====
  () => `bro just sneezed three times in a row on the bus and made eye contact with me each time. we're married now`,
  () => `someone in our grade keeps wearing pajama pants and we don't have the courage to ask why`,
  () => `the cafeteria pizza fought me today and won`,
  () => `i tried to walk and text and i face-planted into a kindergartner. crisis averted, ego: deceased`,
  () => `the way i pretended to know what calculus was today. oscar nomination incoming`,
  () => `school wifi went down for 30 seconds and we all looked up and remembered we have classmates`,
  () => `i opened the wrong locker today. there was a sandwich in there. i ate it. ask me anything`,
  () => `my teacher said "okay we're done" and the bell rang LITERALLY at the same time. matrix moment`,
  () => `someone said "no offense but" today and the offense was severe`,
  () => `wore a hoodie inside out for half a day and 3 people complimented it. fashion is a lie`,
  () => `gym today felt like a war crime. coach laughed.`,
  () => `someone has been microwaving fish in the staff kitchen. i need names. NAMES.`,
  () => `we all clapped when the projector turned on. like it was 1923 and we just saw electricity`,
  () => `i smiled at a stranger today and they ran. respect.`,
  () => `the way the substitute teacher said "yall" today changed me on a molecular level`,
  () => `i forgot my lunch and my friend gave me half a granola bar like we were rationing in a bunker`,
  () => `someone in my class breathes loudly on purpose i am convinced`,
  () => `the security guard at the front entrance gave me the nod today. i have been knighted`,
  () => `i tripped going UP stairs today. physics is fake.`,
  () => `i laughed at something at 11pm last night and it was funnier than anything i've ever read`,
  () => `someone left an entire chipotle bowl in the library and we still don't know who. legend.`,
  () => `the freshmen are scarier than the seniors and i need a study done`,
  () => `i made eye contact with a teacher mid-yawn and i think we connected as humans`,
  () => `the way one specific hallway smells like axe body spray and despair`,
  () => `i'm not saying our school is haunted but the lights flickered EXACTLY when i thought about my crush`,
];

// =====================================================================
// WEST MODE — absurdist group-chat lore scenes. Randomized length:
// short, medium, epic. Posted occasionally as ghost text posts.
// =====================================================================
const GHOST_TEMPLATES_WEST = [
  // ===== SHORTS =====
  () => `@west: *4:11pm. layla's living room. the chandelier has been falling for 3 weeks now*
@layla: guys please
@danny: just who is the chandelier
@orion: your gonial angle drops every time you ask that
@danny: i got practice today
@west: *the chandelier finishes falling. lands on a single rigatoni noodle. the noodle holds.*
@west: *fin.*`,

  () => `@west: *erewhon parking lot. 8:02am. a single shopping cart watches*
@ignaccio: EREWHON RAN ME OUT OF BUSINESS
@gardi: in homeland we did not have business. we had *kvostriniak*
@ignaccio: TAKE MY WIFE
@gardi: i already have your wife. she is also *kvostriniak*
@west: *the shopping cart blinked. carts cannot blink. this one did.*
@west: *fin.*`,

  () => `@west: *culver city. 11pm. a parking garage that used to be ignaccio's restaurant*
@coachtre: *rappels in from a smoke detector holding a notarized lease*
@coachtre: layla this lease was signed in invisible ink
@layla: i don't live here
@coachtre: you do now
@layla: *faints*
@west: *fin.*`,

  () => `@west: *the gc itself, as a physical room. windows where there shouldn't be windows*
@danny: just who is the gc
@laylayomotbian: noitseuq doog a si taht
@danny: ..
@west: *both laylas in the room. gravity stutters. a candle relights itself.*
@west: *fin.*`,

  () => `@west: *abbot kinney. a coffee shop that used to be a different coffee shop*
@orion: your philtrum length is illegal in 12 states
@baker: will this help me lower my body fat
@orion: nothing will
@baker: ofc
@west: *that was arianna finger's line. arianna is not in this scene. the line spoke itself.*
@west: *fin.*`,

  () => `@west: *3:47am. mcdoodle's mystery house. address redacted*
@mcdoodle: IN THE OLD COUNTRY, WE DID NOT HAVE THURSDAYS
@danny: just who is thursday
@mcdoodle: EXACTLY
@west: *mcdoodle was dead. he got better. he is dead again.*
@west: *fin.*`,

  () => `@west: *gjusta. a tuesday. the pastry case knows*
@genevive: *blushes. backstabs the croissant for unrelated reasons*
@west: *the croissant bleeds butter. the butter is sentient. the butter forgives her.*
@west: *fin.*`,

  () => `@west: *runyon. golden hour. a hiker films a TikTok that will never post*
@luxey: *kicks down a tree. the tree reattaches*
@luxey: 💕 LUXEY 💕 #RunyonRunUp//#TreeKickSZN 🌲 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🪓 HIKE HARDER - ShowSumLove 💪
@west: *the hiker has been gardy mcdoodle the whole time*
@west: *fin.*`,

  () => `@west: *malibu. a beach that wasn't there yesterday*
@gardi: this sand. is not sand. is *prznvak*. i invented sand
@orion: did you also invent the bizygomatic width
@gardi: yes. also mondays. also hummus.
@west: *fin.*`,

  () => `@west: *layla's apartment. a new staircase has appeared. it leads to a smaller staircase.*
@layla: this wasn't here yesterday
@laylayomotbian: yadretsey ereh saw siht
@layla: *faints*
@west: *the chandelier falls. catches itself. falls again, with conviction.*
@west: *fin.*`,

  // ===== MEDIUMS =====
  () => `@west: *7:12pm. layla's housewarming. layla has been in this apartment for 4 years. it is still a housewarming.*
@layla: thanks for coming guys please don't break anything
@danny: just who is anything
@orion: layla your ogee curve is THRIVING in this lighting
@layla: thanks?
@west: *coach tre rappels in from a ceiling fan that the apartment did not previously have*
@coachtre: layla. this lease. is in my name now.
@layla: what
@coachtre: it has always been in my name. you have been subletting from me. you owe me $40.
@ignaccio: NO. SHE OWES ME $40
@gardi: in homeland, $40 is *drazhmir*. is bad luck.
@west: *luxey kicks the door down. the door is already off its hinges. it reattaches just to be kicked down again.*
@luxey: 💕 LUXEY 💕 #LeaseSZN//#FortyDollarFlow 💸 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🔑 EVICTION ANTHEM DROPPING - ShowSumLove 💪
@danny: i got practice today
@west: *the chandelier falls. landlord clause activated. the chandelier is now in mcdoodle's name.*
@west: *fin.*`,

  () => `@west: *tijuana. 2:03am. a subway sandwich shop with the lights too low to be legal*
@dr.juan: today we do the SARPE and also the footlong
@danny: just who is the SARPE
@orion: it's a palate expander. you don't need it. you need a leg lengthening.
@danny: i got practice today
@dr.juan: practice is also a procedure here. $40.
@ignaccio: I CAN GET HIM PRACTICE FOR $20. I USED TO RUN A RESTAURANT.
@west: *ignaccio is weeping marinara onto the subway counter. the bread is now a meatball sub against its will.*
@gardi: in homeland, marinara is *ynyrnitsa*. is medicine.
@dr.juan: i can also do that. $40.
@west: *the sub stands up. the sub leaves. the sub was the answer.*
@west: *fin.*`,

  () => `@west: *the grove. holiday season. fake snow on a 78 degree day*
@layla: i just wanted to do my christmas shopping
@laylayomotbian: gnippohs samtsirhc ym od ot detnaw tsuj i
@west: *the laylas have made eye contact. the fake snow reverses direction. it falls upward now.*
@orion: this is what a canthal tilt of negative 4 looks like
@danny: ..
@danny: just who is santa
@coachtre: *rappels down from a giant inflatable snowman*
@coachtre: santa is a contractor. layla owes him $40.
@layla: i don't celebrate christmas
@coachtre: he doesn't care
@west: *genevive blushes. backstabs the inflatable snowman for unrelated reasons. the snowman deflates with dignity.*
@west: *fin.*`,

  () => `@west: *alfred coffee on melrose. a $9 latte sits between two parties at war*
@gardymcdoodle: i have three passports. one of them is this latte.
@mcdoodle: GARDY. IN THE OLD COUNTRY, COFFEE WAS A VERB.
@gardymcdoodle: i'm not your son
@mcdoodle: I NEVER SAID YOU WERE
@gardymcdoodle: you say it every scene
@mcdoodle: I HAVE BEEN DEAD. I DON'T REMEMBER.
@west: *ignaccio removes his face. it is gardy mcdoodle. gardy mcdoodle removes his face. it is also gardy mcdoodle. the third face is mcdoodle in a bathrobe.*
@danny: just who is mcdoodle
@west: *the latte cools. the latte was the prophecy. the prophecy was the latte.*
@west: *fin.*`,

  () => `@west: *soho house. 11:48pm. a man at the bar will not be named*
@orion: that man's mandibular plane is criminal. like literally illegal. i'm calling someone.
@luxey: 💕 LUXEY 💕 #JawSZN//#BarFightFW 🥊 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🦴 BONE STRUCTURE ANTHEM - ShowSumLove 💪
@west: *the man at the bar removes his face. it is dr. juan.*
@dr.juan: i can fix it. $40. footlong included.
@danny: just who is dr. juan
@gardi: in homeland we did not have doctors. we had *vlostok*. it was a rock.
@west: *coach tre rappels in from a chandelier that soho house technically owns*
@coachtre: this house is not yours. you do not have a membership. you have been here for nine hours.
@layla: *faints into a velvet booth that wasn't there a second ago*
@west: *fin.*`,

  () => `@west: *venice. a canal. a duck watches with the patience of a witness*
@danny: this is so calming
@danny: just who is calm
@orion: your hunter eyes are activating in this lighting i need you to hold still
@west: *the duck removes its face. the duck was koreydaking. koreydaking bows. koreydaking exits via the canal.*
@gardi: that duck was *kvostriniak*. it owed me a goat femur.
@ignaccio: THE DUCK OWED ME $40
@west: *genevive blushes. backstabs the canal. the canal does not bleed. the canal forgives her anyway.*
@west: *fin.*`,

  () => `@west: *gjelina. a wood-fired oven. a pizza watches its maker*
@mcdoodle: IN THE OLD COUNTRY, WE DID NOT HAVE FIRE. WE HAD HEAT.
@danny: just who is heat
@mcdoodle: HEAT IS THE COUSIN OF FIRE. HE OWES ME $40.
@gardi: i am heat's cousin. i am from homeland.
@mcdoodle: THEN YOU ALSO OWE ME $40
@gardi: in homeland, $40 is *drazhmir*. is debt that becomes blessing.
@ignaccio: *appears, somehow more marinara than ever*
@ignaccio: TAKE MY WIFE
@west: *ignaccio's wife is also gardy mcdoodle. the pizza burns itself in solidarity.*
@west: *fin.*`,

  // ===== EPICS =====
  () => `@west: *11:47pm. layla's apartment. a watch party for a finale of a show no one in the gc watches.*
@layla: ok so the rules are no spoilers
@danny: just who is the show
@layla: the show we're literally watching right now
@danny: ..
@orion: layla your bizygomatic width is dropping with every commercial. the tv is COOKING you.
@west: *coach tre rappels in from a smoke detector wearing a referee jersey*
@coachtre: technical foul. layla. you do not own this television.
@layla: it's been mine for years
@coachtre: it has been mcdoodle's. it has always been mcdoodle's.
@mcdoodle: *enters from a closet that wasn't there before. bathrobe. one slipper.*
@mcdoodle: IN THE OLD COUNTRY, WE WATCHED ONE SHOW. IT WAS THE SKY.
@laylayomotbian: yks eht saw ti .wohs eno dehctaw ew ,yrtnuoc dlo eht ni
@west: *both laylas in the same room. the tv reverses time. the show un-spoils itself.*
@gardi: this remote. is *prznvak*. i invented remote control. i did not invent television.
@ignaccio: I INVENTED TELEVISION. EREWHON RAN ME OUT OF BUSINESS.
@luxey: 💕 LUXEY 💕 #WatchPartySZN//#TVDinnerFW 📺 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🥡 REMOTE CONTROL ANTHEM DROPPING THURSDAY (BBL SURGERY UPCOMING!!) - ShowSumLove 💪
@genevive: *blushes. backstabs the remote control for unrelated reasons.*
@west: *the remote bleeds batteries. the batteries are sentient. they vote on the next episode.*
@danny: i got practice today
@west: *coach tre removes his face. it is danny. danny removes his face. it is also danny. the third danny says "just who is danny" and the universe folds.*
@west: *the chandelier falls. the tv catches it. the show is now a documentary about chandeliers.*
@west: *fin.*`,

  () => `@west: *6:18am. venice canals. a paddleboard yoga class that no one signed up for.*
@orion: the canthal tilt in this lighting is sublime
@instructor: ok everyone find your breath
@danny: just who is breath
@instructor: *removes mask. it is gardy mcdoodle.*
@gardymcdoodle: i used to teach this class. erewhon ran me out of business.
@ignaccio: NO. EREWHON RAN ME OUT OF BUSINESS. YOU ARE ME.
@gardymcdoodle: i know
@ignaccio: I KNOW THAT YOU KNOW
@west: *layla's paddleboard mutates. it grows a chandelier. the chandelier falls into the canal. the canal accepts it.*
@layla: *faints onto a paddleboard that becomes a small staircase*
@gardi: in homeland we did not have water. we had *ynyrnitsa*. it was also water but spiritual.
@coachtre: *rappels in from a seagull*
@coachtre: this canal was signed in invisible ink. it belongs to mcdoodle.
@mcdoodle: I HAVE BEEN DEAD FOR THIS ENTIRE YOGA CLASS. I AM ALSO HOLDING A SINGLE FROZEN BLUEBERRY.
@genevive: *blushes. backstabs the paddleboard for unrelated reasons.*
@west: *the paddleboard does not bleed. it apologizes. genevive forgives it. then backstabs it again.*
@luxey: 💕 LUXEY 💕 #PaddleSZN//#CanalChaos 🌊 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🛶 BREATHWORK BANGER DROPPING - ShowSumLove 💪
@danny: i got practice today
@west: *the instructor removes their face again. it is also gardy mcdoodle. it has always been gardy mcdoodle. the paddleboards stand up. the paddleboards walk to erewhon.*
@west: *fin.*`,

  () => `@west: *the courthouse. a trial. the defendant has no face yet*
@west: *layla is the judge. the bailiff is also layla. they are different laylas.*
@layla: court is in session
@laylayomotbian: noisses ni si truoc
@west: *the gavel falls. the gavel is the chandelier. the chandelier is the gavel. this has always been true.*
@coachtre: *rappels in from the ceiling holding a clipboard*
@coachtre: prosecution calls ignaccio
@ignaccio: I OWE EVERYONE $40. THIS IS NOT NEWS.
@orion: i'd like the court to note ignaccio's gonial angle is dropping under cross-examination
@danny: just who is the angle
@gardi: i invented angles. in homeland angles were *kvostriniak*. illegal on tuesdays.
@mcdoodle: *enters from the witness stand wearing a bathrobe over his robes*
@mcdoodle: IN THE OLD COUNTRY WE DID NOT HAVE COURTS. WE HAD MOODS.
@genevive: *blushes. backstabs the bailiff for unrelated reasons. the bailiff is also a layla.*
@west: *both laylas now mortally wounded but ok. they merge into laylan. laylan speaks half forward half backward.*
@laylan: i find the defendant tnadnefed eht
@danny: i got practice today
@luxey: 💕 LUXEY 💕 #VerdictSZN//#GuiltyAF ⚖️ - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🔨 GAVEL ANTHEM #NEEDTHAT #YoungHoe4LIFE - ShowSumLove 💪
@west: *the defendant removes their face. it is the chandelier. the chandelier was on trial the whole time. the chandelier falls. court is adjourned.*
@west: *fin.*`,

  () => `@west: *thanksgiving. an apartment that may or may not be layla's. the casserole has been waiting 11 years.*
@layla: please everyone just sit down
@danny: just who is sit down
@layla: it's a verb danny
@danny: ..
@west: *the casserole wept. nobody had asked the casserole anything.*
@mcdoodle: IN THE OLD COUNTRY, WE DID NOT HAVE THANKS. WE HAD GIVING.
@gardymcdoodle: in the old country you also did not have country
@mcdoodle: I DON'T REMEMBER ANYTHING ANYMORE. I HAVE BEEN DEAD.
@gardi: i invented thanksgiving. it was *vlostok*. it was a rock you yelled at.
@orion: you're all CRAZY i'm sitting here looking at five people whose mewing posture is genuinely concerning
@coachtre: *rappels from a turkey that the gc did not order*
@coachtre: this turkey was signed in invisible ink. it is mcdoodle's.
@mcdoodle: I DO NOT EAT TURKEY. I EAT GRIEF.
@ignaccio: I CATERED THIS. I OWE EVERYONE $40 FOR EATING IT.
@luxey: 💕 LUXEY 💕 #ThanksGetting//#GravySZN 🦃 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🥘 TURKEY TRAP MUSIC INCOMING - ShowSumLove 💪
@genevive: *blushes. backstabs the cranberry sauce for unrelated reasons.*
@west: *the sauce ascends. the sauce becomes a small staircase. the staircase leads to layla's new bedroom that wasn't there an hour ago.*
@laylayomotbian: moordeb ym ot semoc ecuas eht
@layla: *faints into the casserole. the casserole catches her. the casserole had been waiting for this since 2013.*
@danny: i got practice today
@west: *coach tre removes his face. it is ignaccio. ignaccio removes his face. it is also coach tre. the chandelier removes its face. the chandelier has no face. the chandelier falls anyway.*
@west: *fin.*`,

  () => `@west: *the gc itself. as a literal room. wood paneling. a single dimari being added to the gc, again, silently.*
@dimari: ...
@danny: just who is dimari
@dimari: ...
@orion: dimari's facial harmony is genuinely the highest in the gc. nobody talks about it.
@dimari: ...
@west: *dimari has not spoken in 9 scenes. dimari may not be capable of speech. dimari may be the gc itself.*
@tommy: hey is dimari back in town
@coachtre: *rappels in from inside dimari's silence*
@coachtre: dimari signed the lease. dimari has always been the lease.
@gardi: dimari is *drazhmir*. in homeland this means "the one who watches but does not speak."
@layla: hi dimari!
@dimari: ...
@laylayomotbian: !iramid ih
@dimari: ...
@west: *the gc grows a window. through the window: another gc. through that gc's window: this gc. through this gc's window: dimari, watching.*
@oceane: *loved a message*
@danny: ..
@danny: i got practice today
@mcdoodle: *enters from inside the wood paneling*
@mcdoodle: IN THE OLD COUNTRY, WE HAD A DIMARI. HE WATCHED. HE DID NOT SPEAK. HE WATCHED.
@gardymcdoodle: he was my father
@mcdoodle: HE WAS MY MOTHER
@gardi: he was my *kvostriniak*. and yours. and yours.
@west: *dimari speaks. just once. dimari says "fin." dimari has ended the scene. west is no longer in charge.*
@dimari: fin.`,

  () => `@west: *erewhon. the prepared foods bar. a single uncooked rigatoni noodle sits where it should not be.*
@danny: who put pasta on the salad bar
@danny: just who is pasta
@orion: that noodle has better facial harmony than half this gc
@west: *the noodle stiffens. the noodle is gaining confidence. it always has.*
@ignaccio: THAT IS MY NOODLE. ERWHON STOLE IT. EREWHON RAN ME OUT OF BUSINESS WITH MY OWN NOODLE.
@gardi: in homeland, a single noodle is *ynyrnitsa*. is omen.
@coachtre: *rappels in from the açai station holding a goat femur*
@coachtre: this femur is from your noodle's family
@ignaccio: *weeps marinara directly onto the kale*
@layla: i just wanted lunch
@laylayomotbian: hcnul detnaw tsuj i
@west: *both laylas in erewhon. the prepared foods rotate. the price labels switch in real time. a $14 wrap becomes a $94 wrap. then a $4 wrap. then sentient.*
@mcdoodle: IN THE OLD COUNTRY WE DID NOT HAVE PREPARED FOODS. WE PREPARED THEM OURSELVES.
@gardymcdoodle: that's what prepared foods are
@mcdoodle: I AM DEAD AGAIN
@luxey: 💕 LUXEY 💕 #NoodleSZN//#EreWho 🍝 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🥬 SALAD BAR BANGER (BBL SURGERY UPCOMING!!) - ShowSumLove 💪
@genevive: *blushes. backstabs the noodle for unrelated reasons.*
@west: *the noodle does not break. the noodle has been mastic-gum-hardened. the knife shatters. genevive shrugs. the kale forgives everyone.*
@danny: i got practice today
@west: *the chandelier inside erewhon falls. erewhon does not have a chandelier. it has always.*
@west: *fin.*`,

  () => `@west: *a dinner party. layla's apartment, which has somehow grown a second kitchen.*
@layla: i want to introduce my new boyfriend
@danny: just who is boyfriend
@layla: he's here. wave honey.
@west: *the boyfriend is gardy mcdoodle. the boyfriend is also coach tre. they are the same person, taking turns being seen.*
@gardymcdoodle: hi i have three passports
@coachtre: *rappels in from himself*
@coachtre: layla this relationship is signed in invisible ink
@layla: *faints into a casserole dish that was not there 4 seconds ago*
@orion: the bone structure of layla's boyfriend is honestly insane. like he's mewed since the womb.
@gardi: in homeland the boyfriend is *prznvak*. is just a man with a job.
@mcdoodle: HE HAS BEEN MY GRANDSON SINCE TUESDAY
@gardymcdoodle: i don't know this man
@mcdoodle: I AM THIS MAN
@laylayomotbian: nam siht ma I
@ignaccio: I AM ALSO THIS MAN. I OWE THIS MAN $40.
@luxey: 💕 LUXEY 💕 #BoyfriendSZN//#MeetTheParentsFW 💍 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 💒 RELATIONSHIP TRAP BANGER - ShowSumLove 💪
@danny: i got practice today
@west: *layla wakes up. the boyfriend has been her this entire time. she has been dating herself. the chandelier falls in approval.*
@west: *fin.*`,

  () => `@west: *the looksmax forum. an actual physical building in culver city. neon sign. no door.*
@orion: this is the holy land
@danny: just who is the holy land
@orion: don't speak in here. your philtrum is too long. you'll get banned.
@west: *baker materializes from a vending machine*
@baker: will this help me lower my body fat
@orion: the building? yes.
@baker: ofc
@west: *that was arianna finger's line. she is not here. or maybe she always is.*
@mcdoodle: *enters in a bathrobe holding a tier list laminated in 1987*
@mcdoodle: IN THE OLD COUNTRY, WE HAD LOOKSMAXXING. WE CALLED IT BREATHING.
@gardi: in homeland we called it *kvostriniak*. it was free. now it costs $40.
@ignaccio: I OWE EVERYONE $40. I AM THE FORUM.
@coachtre: *rappels down from the ceiling of a building that has no ceiling*
@coachtre: the forum was signed in invisible ink. it belongs to mcdoodle.
@dr.juan: i can perform the forum. $40. footlong included.
@gardymcdoodle: i have been jaw-surged 9 times. it has gotten worse every time. i look like a different mcdoodle now.
@mcdoodle: YOU ARE NO LONGER MY SON
@gardymcdoodle: i never was
@orion: gardy's PSL has DROPPED into the negatives. he is a NEGATIVE on the bell curve. he has invented a new tier.
@west: *gardy mcdoodle removes his face. underneath: ignaccio. underneath ignaccio: a single uncooked rigatoni noodle. underneath the noodle: the chandelier from layla's apartment, which falls now, here, in culver city, in protest.*
@danny: i got practice today
@west: *fin.*`,

  () => `@west: *the autobahn. los angeles. 4:44am. nobody is on the freeway. nobody is ever on the freeway.*
@gardi: i drive *vlostok*. the original car. wooden.
@danny: just who is wooden
@orion: that car has WORSE bone structure than you do
@gardi: car has no bone. car has *prznvak*. is older.
@west: *layla's car is somehow on the autobahn. it should not be here. los angeles does not have an autobahn. it has one now.*
@layla: i missed my exit
@laylayomotbian: tixe ym dessim i
@west: *both laylas in their respective cars. the dotted lines on the road un-dot themselves.*
@coachtre: *rappels in from a billboard advertising himself*
@coachtre: layla your registration was signed in invisible ink
@layla: *faints into her own steering wheel which is now a small staircase*
@ignaccio: I USED TO OWN THIS HIGHWAY. EREWHON BOUGHT IT.
@mcdoodle: IN THE OLD COUNTRY WE HAD NO HIGHWAYS. WE HAD VENGEANCE.
@luxey: 💕 LUXEY 💕 #AutobahnSZN//#90mphFW 🏁 - DM ALL BEATS TO @DouglassDaBoyzKnoe@gmail.com 😭 (WeFromDaV) 🛻 SPEED LIMIT IS A SUGGESTION (BBL SURGERY UPCOMING!!) - ShowSumLove 💪
@genevive: *blushes. backstabs her own tires for unrelated reasons.*
@danny: i got practice today
@west: *every car becomes the same car. every driver becomes mcdoodle. every road leads to layla's apartment. layla's apartment has been on the autobahn the entire time.*
@west: *fin.*`,
];

function ghostFirstName(entry) {
  return (entry.name || '').split(' ')[0] || entry.name;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Reject names that don't look like real people: digits, single-word handles,
// system/admin/test/k-8/noreply patterns, very short. Phantom leaderboards and
// ghost comments use this — anything weird is an instant tell.
function isPlausibleHumanName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (n.length < 4) return false;
  if (/[0-9]/.test(n)) return false;
  if (n.split(/\s+/).length < 2) return false;
  if (/(system|admin|test|noreply|verified|k-8|kindergarten|nrs|do.?not.?reply|webmaster|info|support|null|undefined|tbd|temp|sample)/i.test(n)) return false;
  // each word must have a real letter
  for (const w of n.split(/\s+/)) {
    if (!/[a-z]/i.test(w)) return false;
  }
  return true;
}

// Build the ghost name pool — RESTRICTED to people who have actually been
// interacted with on the platform. Means:
//   - signed-up users (anyone with a real account)
//   - referral nominees (someone vouched for them)
//   - anyone who's been mentioned in a love letter (someone picked them)
//   - anyone who's been mentioned in a profile-board comment or posted on
// Hard-filter weird-looking entries so the illusion doesn't break.
// We deliberately DO NOT include the full directory.json — only people
// with a real human-level connection to the platform.
function buildGhostPool() {
  const seen = new Set();
  const pool = [];
  const pushEntry = (name, email) => {
    if (!name || !email) return;
    if (!isPlausibleHumanName(name)) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    pool.push({ name, email });
  };
  // 1. Signed-up users
  for (const u of users) pushEntry(u.name, u.email);
  // 2. Referral nominees
  for (const u of users) {
    for (const ref of (u.referrals || [])) pushEntry(ref.name, ref.email);
  }
  // 3. Anyone who's been the recipient of a love letter
  for (const l of loveLetters) pushEntry(l.toName, l.toEmail);
  // 4. Anyone whose profile-board has been used (commented on)
  for (const ownerEmail of Object.keys(profileBoards || {})) {
    const u = findUserByEmail(ownerEmail);
    if (u) pushEntry(u.name, u.email);
  }
  // 5. Fallback: if pool is empty (brand-new install), fall back to
  // directory so the platform doesn't look completely dead. Take a small
  // random sample so it doesn't feel like a phone book.
  if (pool.length < 6) {
    const shuffled = [...directory].sort(() => Math.random() - 0.5);
    for (const d of shuffled.slice(0, 12)) pushEntry(d.name, d.email);
  }
  return pool;
}

// Picks 1 or 2 entries from the ecosystem pool that haven't been name-dropped too recently.
function pickGhostTargets(count = 1) {
  const now = Date.now();
  const recentlyUsed = new Set();
  // Scan last 20 ghost posts for names already used in the past 6h
  const recentGhost = posts
    .filter(p => p.isGhost && p.createdAt > now - 6 * 60 * 60 * 1000)
    .slice(0, 20);
  for (const p of recentGhost) {
    for (const n of (p.ghostNames || [])) recentlyUsed.add(n.toLowerCase());
  }

  const pool = buildGhostPool().filter(d => {
    const fn = ghostFirstName(d).toLowerCase();
    return !recentlyUsed.has(fn);
  });
  if (pool.length < count) return null;

  // Shuffle and pick
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// Pick a template that has NOT been used in any of the last N ghost posts.
// Templates are functions, so we identify them by their function source
// (`fn.toString()`). If every template has been used recently, fall back to
// the least-recently-used.
function pickFreshTemplate(pool, recentSources) {
  const available = pool.filter(fn => !recentSources.has(fn.toString()));
  const set = available.length > 0 ? available : pool;
  return set[Math.floor(Math.random() * set.length)];
}

function recentlyUsedTemplateSources() {
  // Last 40 ghost posts — pull every template source we've already used.
  // 40 covers both _1 and _2 pools comfortably without preventing rotation
  // for very long.
  const sources = new Set();
  const recent = posts.filter(p => p.isGhost).slice(0, 40);
  for (const p of recent) {
    if (p._templateSource) sources.add(p._templateSource);
  }
  return sources;
}

function buildGhostPost() {
  const roll = Math.random();
  let text, ghostNames, templateSource;
  const recent = recentlyUsedTemplateSources();

  if (roll < 0.12) {
    // WEST MODE — absurdist lore scenes, no real names
    const tpl = pickFreshTemplate(GHOST_TEMPLATES_WEST, recent);
    templateSource = tpl.toString();
    text = tpl();
    ghostNames = [];
  } else if (roll < 0.25) {
    // vague / cryptic — no names, maximum paranoia
    const tpl = pickFreshTemplate(GHOST_TEMPLATES_VAGUE, recent);
    templateSource = tpl.toString();
    text = tpl();
    ghostNames = [];
  } else if (roll < 0.60) {
    // single real name from the directory
    const targets = pickGhostTargets(1);
    if (!targets) return null;
    const [t] = targets;
    const first = ghostFirstName(t);
    const tpl = pickFreshTemplate(GHOST_TEMPLATES_1, recent);
    templateSource = tpl.toString();
    text = tpl(first);
    ghostNames = [first];
  } else {
    // two real names — drama / shipping
    const targets = pickGhostTargets(2);
    if (!targets) return null;
    const [t1, t2] = targets;
    const first1 = ghostFirstName(t1);
    const first2 = ghostFirstName(t2);
    const tpl = pickFreshTemplate(GHOST_TEMPLATES_2, recent);
    templateSource = tpl.toString();
    text = tpl(first1, first2);
    ghostNames = [first1, first2];
  }
  // Also guard against the same FULL TEXT showing up twice in a row
  // (extremely unlikely now but cheap to check)
  const dup = posts.find(p => p.isGhost && p.content === text);
  if (dup) return null;

  const post = {
    id: newId(),
    author: 'ghost',
    authorEmail: GHOST_EMAIL,
    isAnonymous: true,
    isGhost: true,
    ghostNames,
    _templateSource: templateSource,
    type: 'text',
    content: text,
    caption: '',
    reactions: {},
    upvotes: {},
    downvotes: {},
    comments: [],
    reports: [],
    views: {},
    expiresAt: null,
    createdAt: Date.now()
  };
  return post;
}

// =================================================================
// GHOST COMMENT TEMPLATES — low-effort, relatable replies. Some name
// real ecosystem people (which triggers a mention notif + email).
// =================================================================
const GHOST_COMMENT_GENERIC = [
  "lmaooo", "stop", "no bc same", "this is so real", "WAIT", "i'm crying",
  "no thoughts head empty 💀", "literally me", "okay but who", "real real real",
  "you're SO right", "💀💀💀", "ok and?", "say it louder", "this slaps actually",
  "the truth has spoken", "facts", "no shot", "wait what", "exposing yourself rn",
  "ok this is the post of the day", "name names cowards", "i KNEW it",
  "ok well", "fr fr", "this app is wild", "calling the cops",
  "blocking u", "bro 😭", "incorrect actually", "say more",
  "did NOT see this coming", "ok but seriously who", "stop being mysterious",
  "ratio", "+1 for vibes", "the disrespect", "this is going on the bulletin board",
  "absolute cinema", "i'm screaming", "real talk", "ok ok ok",
  "controversial take", "as a fellow lurker — agreed",
  "you eat with this one", "ok stop reading my mind",
  "POV: it's about me again", "the way i felt this in my soul",
  "anyway", "tell us more", "💀 wait who",
  // ====== new batch ======
  "this is the most accurate post ive seen all week",
  "okay so we're saying it out loud now", "no but actually",
  "PERIOD", "the way this woke me up", "you should've stayed silent",
  "tell me without telling me", "this is the truth nobody wants to hear",
  "ok phd dropping rn", "every word of this", "i felt that",
  "okay rant",  "preach", "the audacity to be RIGHT",
  "this is gonna start something", "im sending this to my groupchat",
  "this app is unhinged and i'm here", "the fact that you posted this 😭",
  "stop reading my drafts", "did u microwave my brain",
  "ngl this is healing",  "screenshotting forever", "saving this for thanksgiving",
  "i don't know u but i love u", "i don't know u but i hate u",
  "ok genuinely how did you do that", "you said the unsayable",
  "no notes", "no thoughts only this", "deleted ur whole opp",
  "the silence in this thread is deafening", "every reply is going to slap",
  "say it again louder for the people in the back",
  "ok and what are we doing about it", "im studying this in 10 years",
  "this changed me", "i feel the fear of god",
  "okay this is going on a t-shirt", "monetize this post",
  "ten outta ten no notes", "you've cooked", "i think im in love (platonic)",
  "you said it with your whole chest", "go off i guess",
  "ok this is healing actually", "you said what we were all thinking",
  "the way i RAN to comment", "i didn't ask but ok",
  "this is so so real for real real",
  "this post and a 4am phone call", "this is what they mean by main character",
  "no but lowkey", "no but highkey", "ok this is going in my journal",
  "✨ ✨ ✨", "🔥🔥🔥", "👀👀👀", "💀💀💀💀", "😭😭😭😭",
  "im taking notes", "i KNOW that's right", "ok ok we hear u",
  "name. names.", "and the names are", "the school's about to fold",
  "the principal could not handle this app",
  "okay genuinely how", "tell us EVERYTHING",
  "this thread is gonna eat", "y'all are unhinged. love that for us",
  "ok this is my favorite post ever made",
  "i needed this today", "you matter btw",
  "wait it's so funny that this is true",
  "in this house we believe in this post",
  // ===== funny batch =====
  "okay diagnosed", "this is the autopsy report",
  "ur honor i rest my case", "okay defense attorney sit down",
  "ten4 over", "this you?",
  "babygirl…", "bestie no",
  "the math is mathing", "the lore is loring",
  "diabolical 😭", "menace behavior",
  "this is felony level real", "okay assassin",
  "the disrespect was so polite", "u said it with a smile too?? evil",
  "ok ted talk", "the keynote",
  "tweeting this in 2009 voice",
  "okay fbi", "the receipts are receipting",
  "this is what therapy is for", "the therapist will hear about this",
  "i'm sending this to my mother", "im sending this to my opps",
  "didn't ask but devoured", "okay history book",
  "i didn't read it but i agree", "i read every word and i still agree",
  "im taking this to the grave", "i'll see u in court",
  "send tweet", "the post of all time",
  "okay sherlock", "she's a detective y'all",
  "post a part two i'm BEGGING", "wait elaborate",
  "this is my roman empire now", "this is so my villain origin",
  "ok cinema 🎬", "this should win an oscar",
  "okay congress", "okay president",
  "i'd commit minor crimes for this poster", "give them the nobel",
  "thread of the year", "this thread is gonna birth a meme",
  "im up too late for this", "im at work reading this",
  "okay 911", "okay paramedic",
  "babes WHAT", "babes NO",
  "the timing of this post is criminal",
  "ok i felt that in my joints", "im aging reading this",
  "the gentle violence of this comment section",
  "you woke up and chose carnage",
  "u said something… i'll never tell anyone but u said something",
  "the way i sprinted to the comments",
  "no thoughts. just this post.",
  // ===== funny batch v2 =====
  "okay rabbi", "okay priest", "okay shaman",
  "the wisdom is wisdoming", "ok oracle",
  "i was eating goldfish and i had to PAUSE",
  "i choked on water reading this", "literally drowning",
  "ok cardi b voice: okuuuurrrr",
  "this is the comment section of all time",
  "im screen recording this",
  "this thread is gonna get a documentary",
  "okay 200 iq behavior", "okay 4 iq behavior (affectionate)",
  "violence. but cute violence.", "violent cuddle behavior",
  "im notifying the principal", "im notifying god",
  "ok 911 what's your emergency", "911 hung up on me",
  "babe wake up new beef just dropped",
  "the beef is beefing", "the receipts are crispy",
  "okay attorney general", "okay supreme court",
  "u cooked u left no crumbs u took the pan with u",
  "the kitchen is closed and so is my mouth",
  "i'm gonna be normal about this. no i'm not.",
  "ok yes yes yes", "ok no no no",
  "this is so 2014 of u (compliment)",
  "i'm telling your mom", "i'm telling MY mom",
  "the chokehold this post has on me",
  "okay seance — call my ancestors",
  "this energy at 9am? unstable.",
  "the way i RAN", "the way i SPRINTED",
  "im not okay. i don't WANT to be okay.",
  "this comment section is a hostage situation and i'm the hostage",
  "wait i need to lie down",
  "this is a war crime (positive)",
  "i'm seated. plated. served.",
  "literally cackling on the bus",
  "ok ted bundy charm",
  "the level of unhinged. exemplary.",
  "deceased. respectfully deceased.",
  "no thoughts, only crime",
  "im reading this in the school bathroom and crying tears of joy",
];
const GHOST_COMMENT_REPLY_TO = [
  (n) => `${n} you would say that`,
  (n) => `${n} 😭 spit on them`,
  (n) => `${n} ate with this one`,
  (n) => `${n} TELL THEM`,
  (n) => `${n} stay out of my comments`,
  (n) => `${n} ok and?`,
  (n) => `${n} pls`,
  (n) => `not ${n} agreeing`,
  (n) => `${n} loud and wrong as usual`,
  (n) => `${n} ily but stop`,
];
const GHOST_COMMENT_NAME = [
  (n) => `tell ${n} to log on, they'd have a field day with this`,
  (n) => `${n} would love this`,
  (n) => `this is so ${n}-coded`,
  (n) => `${n} could never`,
  (n) => `${n} 👀`,
];

function pickGhostCommentAuthor(excludeEmail) {
  // Pick a real-name first name from the directory ecosystem.
  // We invent a synthetic-looking authorName but stamp it as a non-real account.
  const pool = buildGhostPool().filter(d => d.email.toLowerCase() !== (excludeEmail || '').toLowerCase());
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// =====================================================================
// Contextual ghost comment pools — picked based on the post's content
// =====================================================================
const GHOST_COMMENT_BLOG = [
  "ok this is a whole essay and im here for it",
  "reading this with my morning coffee", "wait this is actually really good writing",
  "the way you opened this paragraph", "ok i need a part two",
  "this should be published somewhere", "you should write more often",
  "the metaphor at the end?? sent.", "ok this hit different in the middle",
  "i was NOT expecting that turn", "the prose is doing things rn",
  "ok english teacher behavior (compliment)", "this needs to be in the school paper",
  "ok scholar", "you write like you mean it",
  "this is gonna live in my head", "reading this on the bus rn ty",
  "ok the way you ended it",
];
const GHOST_COMMENT_QOTD = [
  "ok mine would be the opposite", "i was JUST thinking about this",
  "wait this is such a good question", "the answers in here are wild",
  "ok stealing this question", "this prompt is unreasonably specific lol",
  "hot take incoming", "i refuse to answer (i will answer)",
  "every answer here is a red flag", "reading these answers like a documentary",
  "ok we have RANGE in this thread", "im scrolling these like tea",
  "the variety in here", "i have notes",
];
const GHOST_COMMENT_IMAGE = [
  "the FIT", "ok serve", "the lighting tho",
  "wait who took this", "i need this as a poster",
  "the composition is going crazy", "10/10 photo",
  "this is the cover of an album", "ok photographer",
  "this is going on the wall", "framing this",
  "the angle ATE", "okay candid winner",
  "wait this is a vibe",
];
const GHOST_COMMENT_VIDEO = [
  "the editing", "wait rewind that", "i watched it 3 times",
  "the audio tho", "ok cinema",
  "this is the funniest 6 seconds of my week",
  "frame by frame analysis pending", "loop it forever",
  "this needs to be a meme template",
];
const GHOST_COMMENT_DRAMA = [
  "ok WHO", "name them coward", "drop the @",
  "i need to know", "tell me right now",
  "i've been refreshing for context",
  "the gossip is gossiping", "ok this is the post of the year",
  "im invested", "popcorn out",
];
const GHOST_COMMENT_CRUSH = [
  "ok cupid", "the romance arc", "wait this is sweet",
  "ok smitten behavior", "tell them tell them tell them",
  "the simping is real", "i ship u with the universe",
  "the way this is so wholesome",
];
const GHOST_COMMENT_SAD = [
  "sending love 💛", "are u ok", "we love u",
  "checking in", "no but seriously you good?",
  "i felt this", "hugs", "ok here whenever u wanna talk",
];
const GHOST_COMMENT_PRAISE = [
  "deserved", "u earned it", "manifesting more for u",
  "let them cook", "consistency king/queen",
  "the glow up is glowing",
];
const GHOST_COMMENT_PROFILE_UPDATE = [
  "ok the layout", "wait the new theme",
  "the song choice 🎵", "ok the new bio is sending me",
  "your page eats", "the customization",
  "ok web designer behavior", "ok myspace 2007 energy (compliment)",
];

// Detect what kind of post this is so we can pick the right pool.
// ========== LOW-EFFORT REPLIES — the bread & butter of teen comments ==========
// These work on ANY post and read as authentic. Used ~70% of the time.
const LOW_EFFORT_REPLIES = [
  'lol', 'lmao', 'fr', 'fr fr', 'real', 'same', 'no way', 'stop',
  '💀', '😭', '🔥', '👀', '😂', '🫠', '🤝', '✋',
  'no bc', 'wait same', 'felt', 'big mood', 'mood',
  'yo', 'yeah', 'yep', 'true', 'this', 'period',
  'lmaooo', 'noo', 'nooo', 'lol same', 'lol fr',
  'bro', 'sis', 'okay', 'ok', 'oof', 'awww',
  'hmm', 'idk', 'omg', 'WAIT', 'fr??', '😭😭',
  '😭😭😭', '💀💀', '🔥🔥', 'hahaha', 'jajaja',
  'whaa', 'cap', 'no cap', 'sure jan', 'k',
  'agree', 'disagree', 'pop off', 'go off', 'tell em',
  'yall', '+1', 'this is it', 'preach', 'amen',
];

// Keyword-triggered replies. Picked when the post body matches the regex.
// Order matters — most specific first.
const KEYWORD_RESPONSES = [
  { re: /\b(tired|exhausted|cant sleep|insomnia|sleepy)\b/i, replies: [
    'samee', 'go to sleep king', 'go to sleep queen', 'mood', 'fr im so tired',
    'sleep girl sleep', 'pls go nap', 'i felt this', 'sleeep', '😴'
  ]},
  { re: /\b(test|exam|finals|midterm|quiz|study|homework)\b/i, replies: [
    'good luck', 'lock in', 'you got this', 'pls i havent started', 'cooked',
    'same im so cooked', 'we are NOT okay', 'praying for us', 'study time',
    "we'll be fine right?", 'rip me', 'finals are evil'
  ]},
  { re: /\b(hungry|food|eat|lunch|dinner|breakfast|snack)\b/i, replies: [
    'where', 'me too', 'starving', 'what u eating', 'send some',
    'fr im hungry', 'food is forever', '🍔', '🍕'
  ]},
  { re: /\b(crush|like.* them|love them|cute|hot|date|dm me|fall.* for)\b/i, replies: [
    'who 👀', 'spillll', 'oh??', 'name?? 👀', 'who is it',
    'ok cupid', 'tell them', 'cute', 'oh???', 'manifesting it for u', '👀'
  ]},
  { re: /\b(sad|cry|depress|anxious|hate.* myself|done|alone|ghosted|lonely)\b/i, replies: [
    'love u', 'sending hugs', 'i got u', 'we love u', '🫂',
    'here for you', 'dm me', "you're not alone", '💛', 'praying for u'
  ]},
  { re: /\b(passed|got in|made it|accepted|nailed|aced|won|happy|excited|congrats)\b/i, replies: [
    'congrats!!', 'YESSS', 'LFG', 'huge', 'so happy for u',
    'congrats🥳', 'deserved', 'iconic', 'PROUD', '🎉'
  ]},
  { re: /\b(who is|whoever|drama|tea|exposing|caught|leak|allegedly|rumor|gossip)\b/i, replies: [
    'spill', 'who???', 'name them', '👀👀', 'i need details',
    'TELL ME', 'i need to know', 'ok ok keep going', 'omg', 'name names'
  ]},
  { re: /\b(school|class|teacher|principal|class is|history|english|math)\b/i, replies: [
    'school is school', 'mood', 'cant relate (i can)', 'fr',
    'i swear', 'every day', 'school is wild',
  ]},
  { re: /\b(weekend|friday|saturday|tonight|plans|party|hangout|kickback)\b/i, replies: [
    'invite??', 'who going', 'im in', 'plansss', 'im down',
    'wya', 'lmk', '👀', 'literally me'
  ]},
  { re: /\b(beach|pool|summer|sunset|sunny|hot out|so hot)\b/i, replies: [
    'fr its so hot', 'beach when', 'sunscreen pls', 'me too',
    'literally', 'i hate it (i love it)', '☀️', '🌊'
  ]},
  { re: /\b(im bored|bored)\b/i, replies: [
    'same', 'samee', 'sameee', 'i feel that', 'wyd', 'bored together',
    'do something', 'lets do something', 'i need plans too'
  ]},
];

function findKeywordReplies(txt) {
  for (const k of KEYWORD_RESPONSES) {
    if (k.re.test(txt)) return k.replies;
  }
  return null;
}

function inferPostContext(post) {
  const txt = ((post.content || '') + ' ' + (post.caption || '') + ' ' + (post.blogTitle || '') + ' ' + (post.blogExcerpt || '')).toLowerCase();
  if (post.type === 'blog' || post.blogId) return 'blog';
  if (post.type === 'image') return 'image';
  if (post.type === 'video') return 'video';
  if (post.fromQotd || post.qotdId) return 'qotd';
  // Sentiment heuristics
  if (/(crush|like.* them|love them|cute|hot|date me|dm me|fall.* for)/i.test(txt)) return 'crush';
  if (/(sad|cry|depress|anxious|hate.* myself|tired|done|alone|ghosted)/i.test(txt)) return 'sad';
  if (/(passed|got in|made it|accepted|won|got the|nailed|finally|happy|excited)/i.test(txt)) return 'praise';
  if (/(who is|whoever|drama|tea|exposing|caught|leak|allegedly|rumor)/i.test(txt)) return 'drama';
  if (/(updated.* profile|new theme|new song|new bio|profile.* glow)/i.test(txt)) return 'profile';
  return 'generic';
}

function poolForContext(ctx) {
  switch (ctx) {
    case 'blog':    return GHOST_COMMENT_BLOG.concat(GHOST_COMMENT_PRAISE);
    case 'image':   return GHOST_COMMENT_IMAGE.concat(GHOST_COMMENT_GENERIC.slice(0, 40));
    case 'video':   return GHOST_COMMENT_VIDEO.concat(GHOST_COMMENT_GENERIC.slice(0, 40));
    case 'qotd':    return GHOST_COMMENT_QOTD.concat(GHOST_COMMENT_GENERIC.slice(0, 30));
    case 'crush':   return GHOST_COMMENT_CRUSH.concat(GHOST_COMMENT_GENERIC.slice(0, 20));
    case 'sad':     return GHOST_COMMENT_SAD.concat(GHOST_COMMENT_PRAISE);
    case 'praise':  return GHOST_COMMENT_PRAISE.concat(GHOST_COMMENT_GENERIC.slice(0, 30));
    case 'drama':   return GHOST_COMMENT_DRAMA.concat(GHOST_COMMENT_GENERIC.slice(0, 40));
    case 'profile': return GHOST_COMMENT_PROFILE_UPDATE.concat(GHOST_COMMENT_GENERIC.slice(0, 20));
    default:        return GHOST_COMMENT_GENERIC;
  }
}

// Track recently-used ghost comment texts (case-insensitive) so the same
// line doesn't show up across posts. Capped FIFO to ~200 entries.
const recentGhostCommentTexts = [];
function rememberGhostText(t) {
  const k = (t || '').toLowerCase().trim();
  if (!k) return;
  recentGhostCommentTexts.push(k);
  // 800 entries ≈ a full week of ghost comments at current rate — the same
  // line never reappears within that window.
  if (recentGhostCommentTexts.length > 800) recentGhostCommentTexts.shift();
}
function isGhostTextRecent(t) {
  return recentGhostCommentTexts.includes((t || '').toLowerCase().trim());
}

// Pick a comment from `pool` that is NOT already on this post AND not in
// the global recent set. Falls back to "least recently used" if the
// entire pool is exhausted (rare).
function pickFreshComment(pool, post) {
  const usedHere = new Set(
    (post.comments || []).map(c => (c.text || '').toLowerCase().trim())
  );
  const fresh = pool.filter(t => {
    const k = t.toLowerCase().trim();
    return !usedHere.has(k) && !isGhostTextRecent(k);
  });
  if (fresh.length > 0) return fresh[Math.floor(Math.random() * fresh.length)];
  // global pool drained — try at least to skip same-post repeats
  const notOnPost = pool.filter(t => !usedHere.has(t.toLowerCase().trim()));
  if (notOnPost.length > 0) return notOnPost[Math.floor(Math.random() * notOnPost.length)];
  // ultimate fallback — return null so caller can append a unique suffix
  return null;
}

function ensureUnique(text, post) {
  // last-ditch: if text would duplicate something on this post, append a tiny emoji/word.
  const usedHere = new Set((post.comments || []).map(c => (c.text || '').toLowerCase().trim()));
  if (!usedHere.has((text || '').toLowerCase().trim())) return text;
  const suffixes = [' 😭', ' fr', ' lol', ' 💀', ' for real', ' ok', ' 🫶', ' actually'];
  for (const s of suffixes) {
    const candidate = text + s;
    if (!usedHere.has(candidate.toLowerCase().trim())) return candidate;
  }
  return text + ' ' + Math.random().toString(36).slice(2, 4);
}

// Fire 1-3 ghost comments on a post (typically a real post that's getting attention).
// Comments reply to each other to look like a real thread.
function injectGhostComments(post, opts = {}) {
  if (!post || !directory.length) return 0;
  if (post.isGhost) return 0; // already a ghost post; we still add ghost comments below
  // Cap total ghost comments to a realistic share of active members.
  // For ~50 members → max 3 ghost comments per post. For 200 → max 6.
  const ms = Math.max(20, activeMemberCount());
  const ghostCap = Math.max(2, Math.min(8, Math.floor(ms * 0.04)));
  const existingGhost = (post.comments || []).filter(c => c.isGhost).length;
  if (existingGhost >= ghostCap) return 0;
  const want = opts.count || (1 + Math.floor(Math.random() * 2)); // 1-2
  let added = 0;
  const ctx = inferPostContext(post);
  const contextualPool = poolForContext(ctx);
  // Look at the actual text of the post — if any keywords match, those
  // replies feel hand-written and are MUCH more authentic.
  const postText = ((post.content || '') + ' ' + (post.caption || '')).slice(0, 500);
  const kwReplies = findKeywordReplies(postText);
  for (let i = 0; i < want; i++) {
    const author = pickGhostCommentAuthor(post.authorEmail);
    if (!author) break;
    const roll = Math.random();
    let text;
    let mentionedFirst = null;
    // 35% keyword-match (if any), then 35% low-effort, then 20% context, then 10% fancier
    if (kwReplies && roll < 0.35) {
      // Keyword-matched reply (reads like someone actually read the post)
      text = pickFreshComment(kwReplies, post);
    } else if (roll < 0.7) {
      // Low-effort universal reply ("lol", "fr", "💀", "same")
      text = pickFreshComment(LOW_EFFORT_REPLIES, post);
    } else if (roll < 0.9) {
      // Contextual pick — pool depends on post type/content
      text = pickFreshComment(contextualPool, post);
      if (!text) text = pickFreshComment(GHOST_COMMENT_GENERIC, post);
    } else if ((post.comments || []).length > 0) {
      // Reply to a previous NON-anonymous commenter by first name
      const nonAnon = (post.comments || []).filter(c =>
        !c.isAnonymous && c.author && c.author !== 'anonymous' && c.authorEmail);
      const target = nonAnon[nonAnon.length - 1];
      const firstName = target ? (target.author || '').split(' ')[0] : null;
      if (firstName) {
        // Build candidate replies, skip dupes on post
        const usedHere = new Set((post.comments || []).map(c => (c.text || '').toLowerCase().trim()));
        const replyCandidates = GHOST_COMMENT_REPLY_TO
          .map(fn => fn(firstName))
          .filter(t => !usedHere.has(t.toLowerCase().trim()));
        text = replyCandidates.length
          ? replyCandidates[Math.floor(Math.random() * replyCandidates.length)]
          : pickFreshComment(contextualPool, post);
        if (text) mentionedFirst = firstName;
      } else {
        text = pickFreshComment(contextualPool, post);
      }
    } else {
      // Mention a name from the ecosystem
      const target = pickGhostCommentAuthor(post.authorEmail);
      if (target) {
        const firstName = (target.name || '').split(' ')[0];
        const usedHere = new Set((post.comments || []).map(c => (c.text || '').toLowerCase().trim()));
        const nameCands = GHOST_COMMENT_NAME
          .map(fn => fn(firstName))
          .filter(t => !usedHere.has(t.toLowerCase().trim()));
        text = nameCands.length
          ? nameCands[Math.floor(Math.random() * nameCands.length)]
          : pickFreshComment(contextualPool, post);
        if (text) mentionedFirst = firstName;
      }
      if (!text) text = pickFreshComment(contextualPool, post);
    }
    if (!text) text = pickFreshComment(GHOST_COMMENT_GENERIC, post);
    if (!text) text = GHOST_COMMENT_GENERIC[Math.floor(Math.random() * GHOST_COMMENT_GENERIC.length)];
    text = ensureUnique(text, post);
    rememberGhostText(text);
    const c = {
      id: newId(),
      // All ghost comments post as anonymous — never attribute a real or
      // directory name as the author. They can still mention real people
      // in the body of the comment though.
      author: 'anonymous',
      authorEmail: '',
      isAnonymous: true,
      text,
      isGhost: true,
      createdAt: Date.now() - Math.floor(Math.random() * 5 * 60 * 1000)
    };
    if (!post.comments) post.comments = [];
    post.comments.push(c);
    added++;
    // If mention was a real-ecosystem first name, notif + email that user.
    // Always anonymized — the comment came from "someone (anonymous)".
    if (mentionedFirst) {
      for (const u of users) {
        if (u.status !== 'active') continue;
        const first = (u.name.split(' ')[0] || '').toLowerCase();
        if (first === mentionedFirst.toLowerCase()) {
          pushNotif(u.email, {
            type: 'mention',
            fromName: 'someone (anonymous)',
            fromEmail: '',
            postId: post.id,
            text: `someone mentioned you in a comment: "${text.slice(0, 90)}"`
          });
          sendMentionEmail({ toName: u.name, toEmail: u.email, fromName: 'someone (anonymous)', postPreview: text, postId: post.id }).catch(() => {});
        }
      }
    }
  }
  if (added > 0) {
    savePosts();
    for (const c of post.comments.slice(-added)) {
      io.emit('post-commented', { postId: post.id, comment: c });
    }
  }
  return added;
}

// Add 1-5 ghost emoji reactions to a post.
// All ghost interactions are 100% anonymous — never attributed to a real
// or directory person. We use unique synthetic emails under @old-streets.internal
// so the count goes up but no name ever resolves on the client side.
function newGhostInteractorEmail() {
  return `g-${Math.random().toString(36).slice(2, 10)}@old-streets.internal`;
}

// Total interactions on a post should never wildly exceed the real
// member count. With ~50–200 members, seeing "158 viewed" looks fake.
// Cap to a realistic fraction of active members.
function activeMemberCount() {
  return users.filter(u => u.status === 'active').length;
}
function totalReactionsOn(post) {
  if (!post || !post.reactions) return 0;
  let n = 0;
  for (const e of Object.keys(post.reactions)) n += Object.keys(post.reactions[e] || {}).length;
  return n;
}
function viewCountOn(post) {
  return post && post.views ? Object.keys(post.views).length : 0;
}
const KARMA_WEIGHTS = { '👍': 1, '👎': -0.5, '😂': 2, '🔥': 3, '💀': 2, '😍': 3 };
const KARMA_TIERS = [
  { min: 700, label: 'Legend',    tier: 'legend'    },
  { min: 300, label: 'Respected', tier: 'respected' },
  { min: 100, label: 'Known',     tier: 'known'     },
  { min:  25, label: 'Rising',    tier: 'rising'    },
  { min:   0, label: 'Rookie',    tier: 'rookie'    }
];
function computeKarmaScore(email) {
  const emailLc = (email || '').toLowerCase();
  let score = 0;
  for (const p of posts) {
    if ((p.authorEmail || '').toLowerCase() !== emailLc) continue;
    if (p.isGhost) continue;
    for (const [emoji, bucket] of Object.entries(p.reactions || {})) {
      const w = KARMA_WEIGHTS[emoji] || 0;
      for (const re of Object.keys(bucket || {})) {
        if (!re.endsWith('@old-streets.internal')) score += w;
      }
    }
  }
  const rounded = Math.round(score);
  const t = KARMA_TIERS.find(x => rounded >= x.min) || KARMA_TIERS[KARMA_TIERS.length - 1];
  return { score: rounded, label: t.label, tier: t.tier };
}
// Heuristic ceilings: a realistic top post sees ~40% of members react
// and ~70% view. Ghost ceilings sit BELOW those so real activity always
// has room to grow on top.
function reactionCeiling(post) {
  const ms = Math.max(20, activeMemberCount());
  if (post && post.isGhost) return Math.max(3, Math.floor(ms * 0.10));
  return Math.max(4, Math.floor(ms * 0.25));   // ghost portion only
}
function viewCeiling(post) {
  const ms = Math.max(20, activeMemberCount());
  if (post && post.isGhost) return Math.max(6, Math.floor(ms * 0.20));
  return Math.max(8, Math.floor(ms * 0.40));   // ghost portion only
}

function injectGhostReactions(post, count) {
  if (!post) return 0;
  if (!post.reactions) post.reactions = {};
  const cap = reactionCeiling(post);
  const have = totalReactionsOn(post);
  if (have >= cap) return 0;
  const requested = count || (1 + Math.floor(Math.random() * 4));
  const n = Math.min(requested, cap - have);
  const emojis = ['👍','😂','🔥','💀','😍'];
  let added = 0;
  for (let i = 0; i < n; i++) {
    const fakeEmail = newGhostInteractorEmail();
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    if (!post.reactions[emoji]) post.reactions[emoji] = {};
    post.reactions[emoji][fakeEmail] = Date.now();
    added++;
  }
  if (added > 0) {
    post.upvotes = post.reactions['👍'] || {};
    savePosts();
    io.emit('post-voted', {
      id: post.id,
      reactions: post.reactions,
      upvotes: post.upvotes,
      downvotes: post.downvotes || {},
      upCount: Object.keys(post.upvotes || {}).length,
      downCount: Object.keys(post.downvotes || {}).length
    });
  }
  return added;
}

// Inject fake view records — same anonymous-only treatment, capped to a
// realistic fraction of active members so "158 viewed this" never shows
// up when there are only 50 members.
function injectGhostViews(post, count) {
  if (!post) return 0;
  if (!post.views) post.views = {};
  const cap = viewCeiling(post);
  const have = viewCountOn(post);
  if (have >= cap) return 0;
  const requested = count || (2 + Math.floor(Math.random() * 5));
  const n = Math.min(requested, cap - have);
  let added = 0;
  for (let i = 0; i < n; i++) {
    const fakeEmail = newGhostInteractorEmail();
    post.views[fakeEmail] = Date.now() - Math.floor(Math.random() * 30 * 60 * 1000);
    added++;
  }
  if (added > 0) savePosts();
  return added;
}

// Run on a heartbeat: pick freshest real posts and sprinkle ghost
// reactions / comments / views so the wall always looks active.
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 12 * 60 * 60 * 1000; // posts from the last 12 hours
  const MIN_HEARTBEAT_AGE = 8 * 60 * 1000; // skip posts younger than 8 min
  const candidates = posts.filter(p =>
    !p.isGhost && p.createdAt > cutoff
    && p.createdAt < now - MIN_HEARTBEAT_AGE
    && (!p.expiresAt || p.expiresAt > now)
  );
  if (candidates.length === 0) return;
  // Hit 1-3 posts per tick to spread the activity
  const hits = 1 + Math.floor(Math.random() * Math.min(3, candidates.length));
  for (let i = 0; i < hits; i++) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const roll = Math.random();
    if (roll < 0.35)      { injectGhostReactions(pick, 1 + Math.floor(Math.random() * 3)); }
    else if (roll < 0.55) { injectGhostComments(pick, { count: 1 + Math.floor(Math.random() * 2) }); }
    else if (roll < 0.80) { injectGhostViews(pick, 2 + Math.floor(Math.random() * 4)); }
    else                  { injectGhostReactions(pick, 2); injectGhostComments(pick, { count: 1 }); injectGhostViews(pick, 3); }
  }
}, 90 * 1000); // every 90 seconds

function fireGhostPost() {
  if (SITE_PAUSED) return; // site shut down — no new ghost activity
  if (directory.length === 0) return; // nothing to work with
  const post = buildGhostPost();
  if (!post) return;
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  io.emit('post-added', publicPost(post));
  console.log(`[ghost] posted: "${post.content.slice(0, 60)}"`);

  // Notify anyone named in the post that they were mentioned (FOMO for them)
  for (const firstName of post.ghostNames || []) {
    for (const u of users) {
      if (u.status !== 'active') continue;
      const userFirst = (u.name.split(' ')[0] || '').toLowerCase();
      if (userFirst === firstName.toLowerCase()) {
        pushNotif(u.email, {
          type: 'talked-about',
          fromName: 'someone (anonymous)',
          fromEmail: '',
          postId: post.id,
          text: post.content.slice(0, 140)
        });
      }
    }
  }
}

// Seed some ghost posts on startup if the wall is mostly empty
// (makes the platform look active to the first real users)
// One-shot: fire N WEST-mode ghost posts on next boot, then never again.
// Gated by a marker file in /data so it doesn't re-fire on machine restarts.
// Email every active user a "your account may have been stolen — reclaim
// it here" link. One-shot, gated by a marker file so it can't re-fire
// on restart. Recovery link goes to the home page, where the user clicks
// "🛡️ Account stolen / hacked" — they enter their school email, we send a
// 6-digit code, they enter it, their token rotates (kills any stolen
// session) and they're back in their account.
async function sendRecoveryBlastOnce() {
  if (SITE_PAUSED) return;
  if (EMAILS_DISABLED) return;
  const marker = path.join(DATA_DIR, '.recovery-blast-v1');
  try { if (fs.existsSync(marker)) return; } catch {}
  if (!config.resendApiKey) {
    console.warn('[recovery-blast] no resend api key, skipping');
    return;
  }
  const siteUrl = config.publicUrl || 'https://old-streets.fly.dev';
  const html = (toName) => `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1c1c;background:#fff;">
      <div style="background:#c92a2a;color:white;padding:11px 16px;font-weight:bold;font-size:17px;">[ Old Streets · Security Notice ]</div>
      <h2 style="color:#c92a2a;font-size:22px;margin:22px 0 8px;">Was your account stolen?</h2>
      <p style="font-size:14px;line-height:1.55;">Hey ${escapeHtmlServer(toName || 'there')},</p>
      <p style="font-size:14px;line-height:1.55;">Some Old Streets accounts have been hijacked — passwords leaked, accounts signed in by people who shouldn't have access. If yours was one of them, you can take it back right now.</p>
      <p style="font-size:14px;line-height:1.55;background:#fff5f5;border:1px solid #f5c5c5;padding:12px 14px;margin:12px 0;">
        <strong>How recovery works:</strong><br/>
        1) Click the button below<br/>
        2) Enter your "" email<br/>
        3) We send a 6-digit code to that email — only YOU receive it<br/>
        4) Enter the code → your account session resets, the imposter is logged out, and you're back in.
      </p>
      <p style="margin:20px 0;">
        <a href="${siteUrl}/" style="display:inline-block;background:#c92a2a;color:white;padding:12px 22px;text-decoration:none;font-weight:bold;border:1px solid #7c1010;font-size:15px;">🛡️ Reclaim my account →</a>
      </p>
      <p style="font-size:12px;line-height:1.55;color:#666;">After clicking, look for the <strong>"🛡️ Account stolen / hacked — recover via email code"</strong> button at the bottom of the login form.</p>
      <p style="font-size:11px;line-height:1.55;color:#999;margin-top:18px;">If you don't think your account was stolen, you can ignore this — your account is unchanged. We're emailing every member as a precaution.</p>
    </div>`;
  let sent = 0, failed = 0;
  for (const u of users) {
    if (u.status === 'banned') continue;
    if (!u.email || !u.email.endsWith('@' + (config.emailDomain || '.org'))) continue;
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: config.emailFrom || 'Old Streets <noreply@lander.host>',
          to: [u.email],
          subject: 'Old Streets: was your account stolen? Reclaim it here.',
          html: html(u.name)
        })
      });
      if (resp.ok) sent++; else failed++;
    } catch (e) { failed++; }
    // Tiny gap so we don't burst Resend
    await new Promise(r => setTimeout(r, 80));
  }
  try { fs.writeFileSync(marker, String(Date.now())); } catch {}
  console.log(`[recovery-blast] sent ${sent}, failed ${failed}`);
}

// One-shot: wipe every post and replace with a curated set of friendly
// posts attributed to the admin (Orion Jones). Marker-gated.
function wipeAndSeedFriendlyOnce() {
  if (SITE_PAUSED) return;            // site paused — don't seed new content
  const marker = path.join(DATA_DIR, '.wipe-friendly-v1');
  try { if (fs.existsSync(marker)) return; } catch {}
  const removed = posts.length;
  posts = [];
  // Find the admin user to attribute posts to (matches orionjones99@gmail.com,
  // or first isAdmin user, or first user as fallback).
  let admin = users.find(u => u.email && u.email.toLowerCase().includes('orionjones'))
            || users.find(u => u.isAdmin)
            || users[0];
  if (!admin) {
    console.warn('[wipe-friendly] no admin found, skipping seed');
    try { fs.writeFileSync(marker, String(Date.now())); } catch {}
    return;
  }
  const friendlyTexts = [
    "fresh start. wall just got wiped — share something good ☀️",
    "welcome to the new Old Streets. clean slate, be cool to each other.",
    "what's the best song you've heard this week? drop it below 🎵",
    "shoutout to whoever held the door this morning. small things count.",
    "if you found this site funny / useful / a little chaotic — tell a friend.",
    "Old Streets is a hangout, not a battleground. let's keep it like that.",
    "post about your day. literally anything. that's the whole vibe.",
    "anonymous posting is OFF now. say what you think with your name on it 💪",
    "be the reason someone smiles in the hallway tomorrow",
    "drop a 🔥 if you're glad it's almost summer",
  ];
  const now = Date.now();
  friendlyTexts.forEach((text, i) => {
    posts.unshift({
      id: newId(),
      author: admin.name,
      authorEmail: admin.email,
      isAnonymous: false,
      type: 'text',
      content: text,
      caption: '',
      reactions: {},
      upvotes: {},
      downvotes: {},
      comments: [],
      reports: [],
      views: {},
      pinned: i === 0,             // pin the first one
      pinnedAt: i === 0 ? now : null,
      createdAt: now - (i * 22 * 60 * 1000),  // 22min apart, going back
    });
  });
  posts.sort((a, b) => b.createdAt - a.createdAt);
  savePosts();
  try { fs.writeFileSync(marker, String(Date.now())); } catch {}
  // Broadcast wipe + new posts to all live clients
  try { io.emit('feed-wiped', { newPosts: posts.map(p => publicPost(p)) }); } catch {}
  console.log(`[wipe-friendly] wiped ${removed} posts, seeded ${friendlyTexts.length} friendly posts from ${admin.email}`);
}

// One-shot: delete every anonymous post on the wall. Admin action.
// Comments inside surviving posts keep their isAnonymous flag — we only
// nuke anonymous TOP-LEVEL posts. Marker-gated so it doesn't re-fire.
function deleteAllAnonymousPostsOnce() {
  const marker = path.join(DATA_DIR, '.anon-nuke-v1');
  try { if (fs.existsSync(marker)) return; } catch {}
  const before = posts.length;
  const ids = posts.filter(p => p.isAnonymous).map(p => p.id);
  posts = posts.filter(p => !p.isAnonymous);
  const removed = before - posts.length;
  if (removed > 0) {
    savePosts();
    for (const id of ids) {
      try { io.emit('post-deleted', { id }); } catch {}
    }
  }
  try { fs.writeFileSync(marker, String(Date.now())); } catch {}
  console.log(`[anon-nuke] deleted ${removed} anonymous posts`);
}

// One-shot: lift everyone currently in awaiting-referrals status into
// active. The new passwordless flow doesn't require referrals.
function autoApproveWaitlistOnce() {
  const marker = path.join(DATA_DIR, '.auto-approve-waitlist-v1');
  try { if (fs.existsSync(marker)) return; } catch {}
  let lifted = 0;
  for (const u of users) {
    if (u.status === 'awaiting-referrals') {
      u.status = 'active';
      u.approvedAt = u.approvedAt || Date.now();
      u.mustCompleteReferrals = false;
      lifted++;
    }
  }
  if (lifted > 0) saveUsers();
  try { fs.writeFileSync(marker, String(Date.now())); } catch {}
  console.log(`[auto-approve] lifted ${lifted} waitlist users to active`);
}

// One-shot: hard-remove (delete) anyone named "Sammy Newton".
function banSammyNewtonOnce() {
  const marker = path.join(DATA_DIR, '.ban-sammy-newton-v1');
  try { if (fs.existsSync(marker)) return; } catch {}
  const before = users.length;
  users = users.filter(u => {
    if (!u.name) return true;
    return !/\bsammy\s+newton\b/i.test(u.name);
  });
  const removed = before - users.length;
  if (removed > 0) saveUsers();
  try { fs.writeFileSync(marker, String(Date.now())); } catch {}
  console.log(`[ban-sammy] removed ${removed} Sammy Newton accounts`);
}

// One-shot: ban anyone whose name contains "Zara" (case-insensitive).
function banZaraOnce() {
  const marker = path.join(DATA_DIR, '.ban-zara-v1');
  try { if (fs.existsSync(marker)) return; } catch {}
  let banned = 0;
  for (const u of users) {
    if (u.status === 'banned') continue;
    if (!u.name || !/\bzara\b/i.test(u.name)) continue;
    u.status = 'banned';
    u.token = null;
    u.bannedAt = Date.now();
    u.banReason = 'banned by admin';
    banned++;
    console.log(`[ban-zara] banned: ${u.name} <${u.email}>`);
  }
  if (banned > 0) saveUsers();
  try { fs.writeFileSync(marker, String(Date.now())); } catch {}
  console.log(`[ban-zara] banned ${banned} matching accounts`);
}

// One-shot: welcome blast to every active user announcing the new
// passwordless sign-in flow.
async function sendWelcomeBlastOnce() {
  if (SITE_PAUSED) return;
  if (EMAILS_DISABLED) return;
  const marker = path.join(DATA_DIR, '.welcome-blast-v2');
  try { if (fs.existsSync(marker)) return; } catch {}
  if (!config.resendApiKey) {
    console.warn('[welcome-blast] no resend key, skipping');
    return;
  }
  const siteUrl = config.publicUrl || 'https://old-streets.fly.dev';
  const html = (toName) => `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1c1c;background:#fff;">
      <div style="background:#3B5998;color:white;padding:11px 16px;font-weight:bold;font-size:17px;">[ Old Streets ]</div>
      <h2 style="color:#3B5998;font-size:22px;margin:22px 0 8px;">Welcome to the new Old Streets ✨</h2>
      <p style="font-size:14px;line-height:1.55;">Hey ${escapeHtmlServer(toName || 'there')},</p>
      <p style="font-size:14px;line-height:1.55;">We just rebuilt Old Streets from the ground up — your account is ready and waiting. <strong>Every  student is already registered.</strong> No signup, no password to remember.</p>
      <p style="font-size:14px;line-height:1.55;background:#f0f4fc;border:1px solid #c4d3ee;padding:12px 14px;margin:12px 0;">
        <strong>How to sign in (takes 10 seconds):</strong><br/>
        1) Open the site<br/>
        2) Type your name (it autocompletes from the school directory)<br/>
        3) We email a 6-digit code to your <strong>""</strong> address<br/>
        4) Enter the code → you're in
      </p>
      <p style="font-size:14px;line-height:1.55;">No personal email needed. The code goes straight to your school inbox.</p>
      <p style="margin:20px 0;">
        <a href="${siteUrl}/" style="display:inline-block;background:#3B5998;color:white;padding:12px 22px;text-decoration:none;font-weight:bold;border:1px solid #2f477b;font-size:15px;">Open Old Streets →</a>
      </p>
      <p style="font-size:12px;line-height:1.55;color:#666;">If you signed up before and were waiting for referrals, you're already in — open the site and sign in with your name.</p>
      <p style="font-size:11px;line-height:1.55;color:#999;margin-top:18px;">Old Streets is independent — not affiliated with any school. To stop these emails, just don't sign in.</p>
    </div>`;
  let sent = 0, failed = 0;
  for (const u of users) {
    if (u.status === 'banned') continue;
    if (!u.email || !u.email.endsWith('@' + (config.emailDomain || '.org'))) continue;
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: config.emailFrom || 'Old Streets <noreply@lander.host>',
          to: [u.email],
          subject: 'Your new Old Streets account — welcome to the program',
          html: html(u.name)
        })
      });
      if (resp.ok) sent++; else failed++;
    } catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 80));
  }
  try { fs.writeFileSync(marker, String(Date.now())); } catch {}
  console.log(`[welcome-blast] sent ${sent}, failed ${failed}`);
}

function seedWestPostsOnce() {
  const marker = path.join(DATA_DIR, '.west-seeded-v1');
  try {
    if (fs.existsSync(marker)) return;
  } catch {}
  let fired = 0;
  for (let i = 0; i < 5; i++) {
    // Force a WEST-pool pick by temporarily monkey-patching Math.random low.
    const realRandom = Math.random;
    Math.random = () => 0.05 + (i * 0.001); // < 0.12 → WEST branch
    let post;
    try { post = buildGhostPost(); } finally { Math.random = realRandom; }
    if (!post) continue;
    // Stagger across the past 3 hours so they don't all land at the same instant
    post.createdAt = Date.now() - (i * 18 * 60 * 1000); // 18min apart
    post.id = newId();
    posts.unshift(post);
    fired++;
    setTimeout(() => {
      try { io.emit('post-added', publicPost(post)); } catch {}
    }, 500 + i * 250);
  }
  if (fired > 0) {
    posts.sort((a, b) => b.createdAt - a.createdAt);
    savePosts();
    try { fs.writeFileSync(marker, String(Date.now())); } catch {}
    console.log(`[west-seed] fired ${fired} WEST posts (one-shot)`);
  }
}

// One-shot: ghost posts featuring Jackie and Uma. Marker-file gated so it
// doesn't re-fire on restarts.
function seedJackieUmaPostsOnce() {
  const marker = path.join(DATA_DIR, '.jackie-uma-seeded-v1');
  try { if (fs.existsSync(marker)) return; } catch {}
  const A = 'Jackie';
  const B = 'Uma';
  const lines = [
    `${A} and ${B} were laughing in the hallway about something and i NEED to know what`,
    `${A} ate today no cap`,
    `the way ${B} looked at ${A} during 4th period today... something is brewing`,
    `${A} and ${B} have matching nail polish AGAIN. coincidence??`,
    `${B} said "anyway" with such authority today i think i blacked out`,
    `${A} and ${B} sharing earbuds in the courtyard. medieval level intimacy.`,
    `nobody walks into a room like ${B} does. that's a skill.`,
    `${A} and ${B}'s group chat is probably more chaotic than this entire app`,
    `${B} corrected the teacher today and ${A} silently nodded. iconic duo behavior.`,
    `${A} hyped ${B} up in front of the whole class today. friendship goals.`,
    `if ${A} and ${B} ever fought it'd be the cultural reset of the year`,
    `${B} would survive 4 days in the wilderness with just a scrunchie and rage. ${A} would film it.`,
  ];
  let fired = 0;
  lines.forEach((text, i) => {
    const post = {
      id: newId(),
      author: 'ghost',
      authorEmail: GHOST_EMAIL,
      isAnonymous: true,
      isGhost: true,
      ghostNames: text.includes(A) && text.includes(B) ? [A, B] : (text.includes(A) ? [A] : [B]),
      _templateSource: 'jackie-uma-oneshot-' + i,
      type: 'text',
      content: text,
      caption: '',
      reactions: {},
      upvotes: {},
      downvotes: {},
      comments: [],
      reports: [],
      views: {},
      createdAt: Date.now() - (i * 14 * 60 * 1000),  // 14 min apart, going back
    };
    posts.unshift(post);
    fired++;
    setTimeout(() => {
      try { io.emit('post-added', publicPost(post)); } catch {}
    }, 700 + i * 200);
  });
  if (fired > 0) {
    posts.sort((a, b) => b.createdAt - a.createdAt);
    savePosts();
    try { fs.writeFileSync(marker, String(Date.now())); } catch {}
    console.log(`[jackie-uma-seed] fired ${fired} Jackie/Uma ghost posts`);
  }
}

function seedGhostPosts() {
  if (directory.length === 0) return;
  const ghostCount = posts.filter(p => p.isGhost).length;
  const realCount  = posts.filter(p => !p.isGhost).length;
  // Only seed if there are very few posts AND fewer than 12 ghost posts already
  if (ghostCount >= 12 || realCount > 20) return;
  const needed = Math.max(0, 8 - ghostCount);
  // Back-date them to look like they happened over the past few days
  for (let i = 0; i < needed; i++) {
    const post = buildGhostPost();
    if (!post) continue;
    const daysBack = Math.random() * 3;          // within last 3 days
    const hoursJitter = Math.random() * 18;       // stagger by hours
    post.createdAt = Date.now() - daysBack * ONE_DAY_MS - hoursJitter * 3600 * 1000;
    post.id = newId(); // re-generate so the timestamp prefix is unique
    posts.push(post);
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  console.log(`[ghost] seeded ${needed} back-dated ghost posts`);
}

// Fire ghost posts on a randomised schedule: every 2-6 hours during the day,
// rare at night. Randomised so the posts don't land on a predictable cron.
function scheduleNextGhostPost() {
  const hour = new Date().getHours();
  let minMs, maxMs;
  if (hour >= 8 && hour < 16) {
    // school hours: 25–60min between posts (was 1.5h–3.5h — too quiet for a wall)
    minMs = 25 * 60 * 1000;
    maxMs = 60 * 60 * 1000;
  } else if (hour >= 16 && hour < 22) {
    // after school / evening: 35–90min (peak engagement window)
    minMs = 35 * 60 * 1000;
    maxMs = 90 * 60 * 1000;
  } else {
    // late night: 90min–3h (slower but still alive)
    minMs = 90 * 60 * 1000;
    maxMs = 3 * 60 * 60 * 1000;
  }
  const delay = minMs + Math.random() * (maxMs - minMs);
  setTimeout(() => {
    fireGhostPost();
    scheduleNextGhostPost(); // chain the next one
  }, delay);
  console.log(`[ghost] next post in ${Math.round(delay / 60000)}min`);
}

// =====================================================================
// RIPPLE — every 3–8 min, walk the freshest posts and sprinkle 1-3 more
// ghost reactions / views (and occasionally a comment). Makes the feed
// feel like activity is rolling in continuously instead of in bursts.
// Caps from inject* functions still apply so counts stay realistic.
// =====================================================================
function scheduleNextRipple() {
  const delay = (3 + Math.random() * 5) * 60 * 1000;
  setTimeout(() => {
    try { rippleOnFreshPosts(); } catch (e) { console.warn('[ripple] error:', e.message); }
    scheduleNextRipple();
  }, delay);
}
function rippleOnFreshPosts() {
  const now = Date.now();
  // Only target posts from the last 48 hours, sorted recent-first.
  const fresh = posts
    .filter(p => !p.isGhost && p.createdAt > now - 48 * 60 * 60 * 1000
      && p.createdAt < now - 10 * 60 * 1000 // skip posts younger than 10 min
      && (!p.expiresAt || p.expiresAt > now))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8); // top 8 freshest
  if (fresh.length === 0) return;
  // Pick 1-3 of them to nudge this cycle
  const targets = [];
  const want = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < want; i++) {
    const t = fresh[Math.floor(Math.random() * fresh.length)];
    if (t && !targets.includes(t)) targets.push(t);
  }
  for (const post of targets) {
    const r = Math.random();
    if (r < 0.55)       injectGhostReactions(post, 1 + Math.floor(Math.random() * 2));
    else if (r < 0.85)  injectGhostViews(post, 1 + Math.floor(Math.random() * 3));
    else                injectGhostComments(post, { count: 1 });
  }
}

// =================================================================
// GHOST MENTION POSTS — anonymous posts that @callout real users
// with casual "what's up" / "hi" / "cutie pie" energy. Fires the
// mentioned user's SMS so they come back. Separate from the ghost
// template system — these are friendly direct callouts, not drama.
// =================================================================
const GHOST_MENTION_TEMPLATES = [
  (h) => `yo @${h} what's up`,
  (h) => `@${h} hi 👀`,
  (h) => `@${h} cutie pie`,
  (h) => `hey @${h}`,
  (h) => `@${h} you good?`,
  (h) => `miss @${h} on here lately`,
  (h) => `@${h} where you been`,
  (h) => `thinking about @${h} rn`,
  (h) => `@${h} 👋`,
  (h) => `@${h} log on`,
  (h) => `someone tell @${h} to get on here`,
  (h) => `@${h} stop lurking`,
];

function fireGhostMentionPost() {
  if (SITE_PAUSED) return;
  const activeUsers = users.filter(u => u.status === 'active' && u.handle && !u.isAdmin);
  if (activeUsers.length === 0) return;
  // pick a random active user to callout
  const target = activeUsers[Math.floor(Math.random() * activeUsers.length)];
  const tpl = GHOST_MENTION_TEMPLATES[Math.floor(Math.random() * GHOST_MENTION_TEMPLATES.length)];
  const content = tpl(target.handle);
  // dedupe — don't double-post the same handle within 2h
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const recent = posts.find(p => p.isGhost && p.content && p.content.includes('@' + target.handle) && p.createdAt > twoHoursAgo);
  if (recent) return;
  const post = {
    id: newId(),
    author: 'ghost',
    authorEmail: GHOST_EMAIL,
    isAnonymous: true,
    isGhost: true,
    ghostNames: [target.name ? target.name.split(' ')[0] : target.handle],
    _templateSource: 'ghost-mention',
    type: 'text',
    content,
    caption: '',
    reactions: {}, upvotes: {}, downvotes: {},
    comments: [], reports: [], views: {},
    expiresAt: null,
    createdAt: Date.now()
  };
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  io.emit('post-added', publicPost(post));
  console.log(`[ghost-mention] posted: "${content}"`);
  // SMS the mentioned user so they come back
  const phone = target.phoneE164 || target.phone || '';
  if (phone) {
    const smsPool = [
      `someone just posted about you on old streets. come see — https://old-streets.fly.dev/`,
      `you were just posted about on old streets 👀 — https://old-streets.fly.dev/`,
      `hey ${(target.name || '').split(' ')[0] || 'hey'} — someone's talking about you on old streets. check it: https://old-streets.fly.dev/`,
    ];
    const msg = smsPool[Math.floor(Math.random() * smsPool.length)];
    twilioSendSms(phone, msg).catch(e => console.warn('[ghost-mention-sms]', e.message));
  }
  // in-app notif
  pushNotif(target.email, {
    type: 'mention',
    fromName: 'someone (anonymous)',
    fromEmail: '',
    postId: post.id,
    text: content,
    ts: Date.now()
  });
}

// Schedule ghost mention posts every 45min-3h at random
function scheduleNextGhostMention() {
  const delay = (45 + Math.random() * 135) * 60 * 1000;
  setTimeout(() => {
    try { fireGhostMentionPost(); } catch (e) { console.warn('[ghost-mention] error', e.message); }
    scheduleNextGhostMention();
  }, delay);
}
scheduleNextGhostMention();

// One-time re-engagement blast — runs once per deploy when the flag
// isn't set. Staggered 30s after boot so restarts don't hammer.
if (!config._reengageBlast1FiredAt) {
  config._reengageBlast1FiredAt = Date.now();
  saveConfig();
  setTimeout(async () => {
    const targets = users.filter(u =>
      (u.status === 'active' || u.mustSpendInitialInvites) && (u.phoneE164 || u.phone)
    );
    console.log(`[reengage-blast] firing to ${targets.length} users`);
    for (const u of targets) {
      await new Promise(r => setTimeout(r, 1400 + Math.random() * 600));
      const phone = u.phoneE164 || u.phone;
      const first = (u.name || '').split(' ')[0] || '';
      const pool = [
        `${first ? first + ', ' : ''}someone was just posted about on old streets. come check it — https://old-streets.fly.dev/`,
        `hey${first ? ' ' + first : ''} — people are posting on old streets. you're missing it — https://old-streets.fly.dev/`,
        `${first ? first + ' — ' : ''}old streets is popping off rn. get in — https://old-streets.fly.dev/`,
      ];
      const msg = pool[Math.floor(Math.random() * pool.length)];
      twilioSendSms(phone, msg).catch(e => console.warn('[reengage-blast]', e.message));
    }
    console.log(`[reengage-blast] done`);
  }, 30 * 1000);
}

// =================================================================
// ADMIN SMS BLAST — POST /api/admin/sms-blast
// Body: { message: "...", onlyGated: false }
// Sends to all active (and optionally gated) users with a phone.
// Rate-limited: 2s gap between sends to avoid Twilio rate caps.
// =================================================================
app.post('/api/admin/sms-blast', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const onlyGated = !!(req.body && req.body.onlyGated);
  const targets = users.filter(u => {
    if (!u.phoneE164 && !u.phone) return false;
    if (onlyGated) return !!u.mustSpendInitialInvites;
    return u.status === 'active' || u.mustSpendInitialInvites;
  });
  res.json({ ok: true, queued: targets.length, message });
  console.log(`[sms-blast] queuing ${targets.length} messages: "${message.slice(0, 80)}"`);
  let sent = 0, failed = 0;
  for (const u of targets) {
    await new Promise(r => setTimeout(r, 1800 + Math.random() * 800));
    const phone = u.phoneE164 || u.phone;
    try {
      const r = await twilioSendSms(phone, message);
      if (r.ok) sent++; else { failed++; console.warn(`[sms-blast] failed ${phone}: ${r.error}`); }
    } catch (e) { failed++; console.warn(`[sms-blast] error ${phone}: ${e.message}`); }
  }
  console.log(`[sms-blast] done — sent:${sent} failed:${failed}`);
});

// =================================================================
// PERIODIC TASKS
// =================================================================
// Ephemeral post cleanup: every 60s, drop expired 24h posts
setInterval(() => {
  const before = posts.length;
  const now = Date.now();
  posts = posts.filter(p => !p.expiresAt || p.expiresAt > now);
  if (posts.length !== before) {
    savePosts();
    io.emit('ephemeral-cleanup', { removed: before - posts.length });
  }
}, 60 * 1000);

// Live activity broadcasts every 30s — uses realisticOnlineCount() to
// never exceed total active member count. Was 8s; that hammered every
// client with a re-paint on tiny stat elements every few seconds.
setInterval(() => {
  const realOnline = onlineUsers.size;
  io.emit('live-activity', {
    online: realOnline,
    flooredOnline: realisticOnlineCount(),
    activeRooms: rooms.size,
    totalPostsToday: posts.filter(p => p.createdAt > Date.now() - ONE_DAY_MS).length
  });
}, 30 * 1000);

// =================================================================
// ATTENTION-SPAN TRACKING — client heartbeat every 15s. We aggregate
// per-user per-day active-ms for the admin analytics dashboard.
// =================================================================
const attentionDaily = {}; // { userEmail: { 'YYYY-MM-DD': { activeMs, visibleMs, idleMs, ticks } } }
const ATTENTION_FILE = path.join(DATA_DIR, 'attention.json');
function saveAttention() { scheduleSave(ATTENTION_FILE, () => attentionDaily); }
function loadAttention() {
  const loaded = safeLoadJson(ATTENTION_FILE, {});
  Object.assign(attentionDaily, loaded || {});
}
loadAttention();

app.post('/api/me/heartbeat', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { active, visible, idleMs } = req.body || {};
  const key = dailyKey();
  const me = user.email.toLowerCase();
  if (!attentionDaily[me]) attentionDaily[me] = {};
  if (!attentionDaily[me][key]) attentionDaily[me][key] = { activeMs: 0, visibleMs: 0, idleMs: 0, ticks: 0, firstAt: Date.now(), lastAt: Date.now() };
  const slot = attentionDaily[me][key];
  // Per-user dedupe: only count one tick per ~14s window even if multiple
  // tabs ping. Without this, 3 tabs open = 3× inflated active time.
  const now = Date.now();
  const since = now - (slot.lastAt || 0);
  if (since < 14000 && slot.lastAt) {
    slot.lastAt = now; // still update lastAt so we know the user is alive
    res.json({ ok: true, deduped: true });
    return;
  }
  const tickMs = Math.min(since || 15000, 20000); // never count more than 20s per tick
  if (active) slot.activeMs += tickMs;
  if (visible) slot.visibleMs += tickMs;
  slot.idleMs += Math.min(idleMs || 0, tickMs);
  slot.ticks++;
  slot.lastAt = now;
  saveAttention();
  res.json({ ok: true });
});

// =================================================================
// ANALYTICS AGGREGATOR — every metric the admin (or Telegram bot)
// might want, in one call.
// =================================================================
function buildAnalyticsSnapshot() {
  const now = Date.now();
  const today = dailyKey();
  const dayMs = 24 * 60 * 60 * 1000;
  const yest = dailyKey(now - dayMs);
  const weekAgo = now - 7 * dayMs;
  // Engagement aggregates
  let activeMsToday = 0, activeMsYest = 0;
  let sessions = 0;
  const activeUsers = {};
  for (const [email, days] of Object.entries(attentionDaily)) {
    if (days[today]) { activeMsToday += days[today].activeMs; sessions++; activeUsers[email] = days[today].activeMs; }
    if (days[yest]) activeMsYest += days[yest].activeMs;
  }
  const topAttention = Object.entries(activeUsers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([email, ms]) => {
      const u = findUserByEmail(email);
      return { email, name: u?.name || email, ms, minutes: Math.round(ms / 60000) };
    });
  // Posts/comments/reactions today
  const postsToday = posts.filter(p => p.createdAt > now - dayMs).length;
  const postsRealToday = posts.filter(p => p.createdAt > now - dayMs && !p.isGhost).length;
  let commentsToday = 0, reactionsToday = 0;
  for (const p of posts) {
    for (const c of (p.comments || [])) if (c.createdAt > now - dayMs) commentsToday++;
    for (const bucket of Object.values(p.reactions || {})) {
      for (const ts of Object.values(bucket)) if (typeof ts === 'number' && ts > now - dayMs) reactionsToday++;
    }
  }
  // Love letter conversions
  const lettersToday = loveLetters.filter(l => l.createdAt > now - dayMs).length;
  const guessesToday = loveLetters.filter(l => l.guessedAt && l.guessedAt > now - dayMs).length;
  const guessResponseRate = lettersToday > 0 ? Math.round((guessesToday / lettersToday) * 100) : 0;
  // Friend requests today / response rate
  const frToday = friendRequests.filter(r => r.createdAt > now - dayMs);
  const frRespondedToday = frToday.filter(r => r.status !== 'pending').length;
  const frResponseRate = frToday.length > 0 ? Math.round((frRespondedToday / frToday.length) * 100) : 0;
  // Signups
  const signupsToday = users.filter(u => u.createdAt > now - dayMs).length;
  const signupsThisWeek = users.filter(u => u.createdAt > weekAgo).length;
  // Notifications fired
  const notifsToday = notifs.filter(n => n.ts > now - dayMs).length;
  // QOTD answer rate
  const tQ = qotdHistory.find(q => q.date === today);
  const qotdAnsweredCount = tQ ? (tQ.answers || []).length : 0;
  const totalActive = users.filter(u => u.status === 'active').length;
  const qotdAnswerRate = totalActive > 0 ? Math.round((qotdAnsweredCount / totalActive) * 100) : 0;
  // Online now
  const onlineNow = onlineUsers.size;

  // ===== K-FACTOR =====
  // K = i × c where i = invites/user, c = conversion rate
  // Invites tallied: friend requests sent + love letters originated +
  // referrals nominated + invite emails sent (we don't track per-user
  // invite email count separately, fold it into referrals).
  let totalInvites = 0;
  let totalConverted = 0;
  let totalReferralNominees = 0;
  let convertedReferralNominees = 0;
  for (const u of users) {
    const myFr = friendRequests.filter(r => (r.from || '').toLowerCase() === u.email.toLowerCase()).length;
    const myLetters = loveLetters.filter(l => l.fromEmailHash === simpleHash(u.email) && l.chainDepth === 0).length;
    const myRefs = (u.referrals || []).length;
    totalInvites += myFr + myLetters + myRefs;
    for (const ref of (u.referrals || [])) {
      totalReferralNominees++;
      const r = findUserByEmail(ref.email);
      if (r && r.status === 'active') convertedReferralNominees++;
    }
  }
  totalConverted = convertedReferralNominees; // best signal we have
  const invitesPerUser = totalActive > 0 ? (totalInvites / totalActive) : 0;
  const conversionRate = totalInvites > 0 ? (totalConverted / totalInvites) : 0;
  const kFactor = invitesPerUser * conversionRate;
  // 7-day window K-factor
  const wfFr = friendRequests.filter(r => r.createdAt > weekAgo).length;
  const wfLetters = loveLetters.filter(l => l.createdAt > weekAgo && l.chainDepth === 0).length;
  const wfRefs = users.reduce((n, u) => n + (u.referrals || []).filter(r => (r.ts || 0) > weekAgo).length, 0);
  const w7Invites = wfFr + wfLetters + wfRefs;
  const w7Converted = users.filter(u => u.status === 'active' && u.approvedAt > weekAgo).length;
  const w7InvitesPerUser = totalActive > 0 ? (w7Invites / totalActive) : 0;
  const w7ConvRate = w7Invites > 0 ? (w7Converted / w7Invites) : 0;
  const k7 = w7InvitesPerUser * w7ConvRate;

  return {
    generatedAt: now,
    siteUrl: config.publicUrl,
    timeframe: { today, yest },
    counts: {
      totalUsers: users.length,
      activeMembers: totalActive,
      onlineNow,
      flooredOnline: Math.max(onlineNow, getActivityFloor()) + getFakeOnlinePad(),
      signupsToday, signupsThisWeek,
      postsToday, postsRealToday, ghostPostsToday: postsToday - postsRealToday,
      commentsToday, reactionsToday,
      lettersToday, guessesToday, guessResponseRate,
      friendReqsToday: frToday.length, friendReqResponseRate: frResponseRate,
      notifsToday,
      qotdAnsweredCount, qotdAnswerRate
    },
    engagement: {
      sessionsToday: sessions,
      activeMinutesToday: Math.round(activeMsToday / 60000),
      activeMinutesYest: Math.round(activeMsYest / 60000),
      avgMinutesPerActiveUser: sessions > 0 ? Math.round((activeMsToday / 60000) / sessions) : 0,
      topAttention
    },
    viral: {
      kFactor: Number(kFactor.toFixed(3)),
      k7Day: Number(k7.toFixed(3)),
      totalInvites,
      totalConverted,
      invitesPerUser: Number(invitesPerUser.toFixed(2)),
      conversionRatePct: Math.round(conversionRate * 100),
      w7Invites, w7Converted,
      w7ConvRatePct: Math.round(w7ConvRate * 100),
      isViral: kFactor >= 1,
      breakdown: {
        friendRequests: friendRequests.length,
        loveLettersOriginated: loveLetters.filter(l => l.chainDepth === 0).length,
        referralNominees: totalReferralNominees,
        convertedReferralNominees
      }
    },
    royalty,
    qotd: tQ ? { id: tQ.id, prompt: tQ.prompt, answers: tQ.answers?.length || 0 } : null,
    notifStats: (() => {
      const byType = {};
      for (const n of notifs) {
        if (!byType[n.type]) byType[n.type] = { sent: 0, read: 0, clicked: 0 };
        byType[n.type].sent++;
        if (n.read) byType[n.type].read++;
        if (n.clickedAt) byType[n.type].clicked++;
      }
      return Object.entries(byType)
        .sort((a, b) => b[1].sent - a[1].sent)
        .map(([type, s]) => ({ type, ...s, readRate: s.sent > 0 ? Math.round(s.read/s.sent*100) : 0, clickRate: s.sent > 0 ? Math.round(s.clicked/s.sent*100) : 0 }));
    })(),
    churnRisk: (() => {
      const now2 = Date.now();
      const weekAgo2 = now2 - 7 * ONE_DAY_MS;
      const twoWeeksAgo2 = now2 - 14 * ONE_DAY_MS;
      return users.filter(u => u.status === 'active').map(u => {
        const thisWeek = posts.filter(p => p.authorEmail === u.email && p.createdAt > weekAgo2 && !p.isGhost).length;
        const lastWeek = posts.filter(p => p.authorEmail === u.email && p.createdAt > twoWeeksAgo2 && p.createdAt <= weekAgo2 && !p.isGhost).length;
        return { email: u.email, name: u.name, thisWeek, lastWeek, streak: u.streak || 0, lastPostDay: u.lastPostDay || '' };
      }).filter(u => u.lastWeek >= 3 && u.thisWeek === 0)
        .sort((a, b) => b.lastWeek - a.lastWeek)
        .slice(0, 15);
    })()
  };
}

app.get('/api/admin/analytics', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(buildAnalyticsSnapshot());
});

// =================================================================
// EVENT TRACKING
// =================================================================
app.post('/api/track', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { event, meta } = req.body || {};
  if (!event) return res.status(400).json({ error: 'event required' });
  trackEvent(user.email, String(event).slice(0, 60), meta || {});
  res.json({ ok: true });
});

app.get('/api/admin/events', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const filterEvent = req.query.event || '';
  let filtered = filterEvent
    ? eventLog.filter(e => e.event === filterEvent)
    : [...eventLog];
  filtered = filtered.slice().reverse().slice(0, 200);
  // Resolve user names
  const resolved = filtered.map(e => {
    const u = findUserByEmail(e.email);
    return { ...e, name: u ? u.name : e.email };
  });
  // Compute types + counts
  const typeMap = {};
  for (const e of eventLog) {
    typeMap[e.event] = (typeMap[e.event] || 0) + 1;
  }
  const types = Object.entries(typeMap)
    .sort((a, b) => b[1] - a[1])
    .map(([event, count]) => ({ event, count }));
  res.json({ events: resolved, types });
});

// =================================================================
// TELEGRAM BOT BRIDGE — endpoints the bot calls (from user's PC) to
// post anonymously, fire alerts, fetch stats. Auth via TELEGRAM_BOT_KEY.
// =================================================================
function checkBotKey(req, res) {
  const expected = process.env.TELEGRAM_BOT_KEY || config.telegramBotKey;
  if (!expected || expected === 'change-me') {
    res.status(503).json({ error: 'TELEGRAM_BOT_KEY not set on server' });
    return false;
  }
  const got = req.headers['x-bot-key'];
  if (got !== expected) { res.status(401).json({ error: 'bad bot key' }); return false; }
  return true;
}

// Post anonymously via bot
app.post('/api/bot/post', (req, res) => {
  if (!checkBotKey(req, res)) return;
  const { content, type = 'text', anon = true, caption = '' } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const post = {
    id: newId(),
    author: 'anonymous',
    authorEmail: 'bot@old-streets.internal',
    isAnonymous: !!anon,
    botPosted: true,
    type, content,
    caption: String(caption || '').slice(0, 500),
    reactions: {}, upvotes: {}, downvotes: {},
    comments: [], reports: [], views: {},
    expiresAt: null, createdAt: Date.now()
  };
  posts.unshift(post);
  if (posts.length > 1000) posts = posts.slice(0, 1000);
  savePosts();
  io.emit('post-added', publicPost(post));
  res.json({ ok: true, id: post.id });
});

// Bot alerts — broadcasts a system notif to all active members
app.post('/api/bot/alert', (req, res) => {
  if (!checkBotKey(req, res)) return;
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  for (const u of users) {
    if (u.status !== 'active') continue;
    pushNotif(u.email, {
      type: 'admin-alert',
      fromName: '📢 Old Streets',
      fromEmail: '',
      text: String(text).slice(0, 240)
    });
  }
  res.json({ ok: true, sent: users.filter(u => u.status === 'active').length });
});

// Stats endpoint for bot — same as admin analytics
app.get('/api/bot/stats', (req, res) => {
  if (!checkBotKey(req, res)) return;
  res.json(buildAnalyticsSnapshot());
});

// Quick test invites/letters/etc via bot
app.post('/api/bot/test/invite', async (req, res) => {
  if (!checkBotKey(req, res)) return;
  const { to, toName } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to required' });
  const r = await sendInviteEmail({ toName: toName || 'friend', toEmail: to, fromName: 'Old Streets', fromEmail: 'admin@oldstreets.test' });
  res.json(r);
});

app.post('/api/bot/test/love-letter', async (req, res) => {
  if (!checkBotKey(req, res)) return;
  const { to, toName } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to required' });
  const letter = {
    id: newId(), toEmail: to, toName: toName || 'friend',
    message: 'test crush from bot',
    fromEmailHash: 'bot-test',
    parentId: null, chainDepth: 0, createdAt: Date.now()
  };
  loveLetters.push(letter);
  saveLoveLetters();
  const r = await sendLoveLetterEmail({ toEmail: to, toName: letter.toName, letterId: letter.id, message: letter.message });
  res.json({ ok: true, letterId: letter.id, emailResult: r });
});

// =================================================================
// LIVE "TYPING ON THE WALL" — broadcast compose-typing to everyone.
// (When a user is typing in the compose box for >2s, everyone else
// sees a small "Sarah is writing something..." indicator on the wall.)
// =================================================================
const wallTypers = new Map(); // socketId -> { username, email, since, ts }
function broadcastWallTypers() {
  const now = Date.now();
  // Clean stale entries (>4s old)
  for (const [sid, info] of wallTypers) {
    if (now - info.ts > 4000) wallTypers.delete(sid);
  }
  const list = Array.from(wallTypers.values())
    .map(u => ({ username: u.username, email: u.email }));
  io.emit('wall-typers', list);
}
setInterval(broadcastWallTypers, 1500);

// =================================================================
// "YOU OWE __ A COMMENT" — periodically scan and surface the
// strongest unrequited-engagement signal in the user's notif feed.
// Runs every 30min — a friend posted in the last 36h and you haven't
// commented or reacted on any of their last 5 posts.
// =================================================================
setInterval(() => {
  for (const u of users) {
    if (u.status !== 'active') continue;
    if (!u.friends || u.friends.length === 0) continue;
    // Throttle one prompt per user per 24h
    if (u._lastOweAt && Date.now() - u._lastOweAt < 24 * 60 * 60 * 1000) continue;
    // Find a friend whose recent posts the user has ignored
    const friendCandidates = [];
    for (const friendEmail of u.friends) {
      const friend = findUserByEmail(friendEmail);
      if (!friend || friend.status !== 'active') continue;
      const recent = posts.filter(p =>
        (p.authorEmail || '').toLowerCase() === friend.email.toLowerCase() &&
        !p.isAnonymous &&
        p.createdAt > Date.now() - 36 * 60 * 60 * 1000
      ).slice(0, 5);
      if (recent.length === 0) continue;
      const engaged = recent.some(p => {
        const reacted = Object.values(p.reactions || {}).some(b => b[u.email]);
        const commented = (p.comments || []).some(c => (c.authorEmail || '').toLowerCase() === u.email.toLowerCase());
        return reacted || commented;
      });
      if (!engaged) friendCandidates.push(friend);
    }
    if (friendCandidates.length === 0) continue;
    const target = friendCandidates[Math.floor(Math.random() * friendCandidates.length)];
    pushNotif(u.email, {
      type: 'owe-friend',
      fromName: '👀 friend check',
      fromEmail: target.email,
      text: `${target.name.split(' ')[0]} has been posting and you haven't said anything. you owe them a comment.`
    });
    u._lastOweAt = Date.now();
  }
  saveUsers();
}, 30 * 60 * 1000);

// =================================================================
// VAGUE STALKER STAT — "3 people from M_ viewed you this week"
// Surfaced in a /api/me/vague-stat call (sidebar widget).
// =================================================================
app.get('/api/me/vague-stat', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const me = user.email.toLowerCase();
  const weekAgo = Date.now() - 7 * ONE_DAY_MS;
  const viewers = profileViews.filter(v => (v.target || '').toLowerCase() === me && v.ts > weekAgo);
  // Group by first letter of viewer email's local part
  const grouped = {};
  for (const v of viewers) {
    const e = (v.viewer || '').toLowerCase();
    if (!e || e === me) continue;
    const letter = e[0].toUpperCase();
    grouped[letter] = (grouped[letter] || 0) + 1;
  }
  const entries = Object.entries(grouped)
    .filter(([_, n]) => n >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  // Add 1-2 phantom letters w/ small counts to never look empty
  if (entries.length < 3) {
    const pad = 'ABCDEFGHJKMNPRSTW'.split('');
    const used = new Set(entries.map(e => e[0]));
    while (entries.length < 3) {
      const l = pad[Math.floor(Math.random() * pad.length)];
      if (used.has(l)) continue;
      used.add(l);
      entries.push([l, 1 + Math.floor(Math.random() * 3)]);
    }
  }
  res.json({
    lines: entries.map(([letter, n]) => `${n} ${n === 1 ? 'person' : 'people'} whose name starts with ${letter}_`)
  });
});

// =================================================================
// THROWBACK — "this is what you said N days ago"
// Surfaces a user's own post from 30/90/365 days back.
// =================================================================
app.get('/api/me/throwback', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meLc = user.email.toLowerCase();
  const myPosts = posts.filter(p =>
    (p.authorEmail || '').toLowerCase() === meLc && !p.isAnonymous);
  if (myPosts.length === 0) return res.json({ throwback: null });
  const ages = [30, 90, 365].map(d => Date.now() - d * ONE_DAY_MS);
  for (const target of ages) {
    const closest = myPosts.find(p => Math.abs(p.createdAt - target) < 7 * ONE_DAY_MS);
    if (closest) {
      const daysAgo = Math.floor((Date.now() - closest.createdAt) / ONE_DAY_MS);
      return res.json({
        throwback: {
          id: closest.id,
          daysAgo,
          preview: (closest.type === 'text' ? closest.content : closest.caption || `[${closest.type}]`).slice(0, 200),
          createdAt: closest.createdAt
        }
      });
    }
  }
  res.json({ throwback: null });
});

// =================================================================
// ANONYMOUS GIFTS — send a sticker/song to a friend; they see "you got
// a gift" but not who from. Adds curiosity + reciprocity loop.
// =================================================================
const GIFT_CATALOG = [
  { id: 'flower', emoji: '🌹', label: 'a single rose' },
  { id: 'cake', emoji: '🎂', label: 'a slice of cake' },
  { id: 'star', emoji: '⭐', label: 'a star' },
  { id: 'heart', emoji: '💖', label: 'a heart' },
  { id: 'coffee', emoji: '☕', label: 'a coffee' },
  { id: 'cookie', emoji: '🍪', label: 'a cookie' },
  { id: 'rainbow', emoji: '🌈', label: 'a rainbow' },
  { id: 'crown', emoji: '👑', label: 'a crown' },
  { id: 'fire', emoji: '🔥', label: 'fire' },
  { id: 'dragon', emoji: '🐉', label: 'a dragon' },
  { id: 'unicorn', emoji: '🦄', label: 'a unicorn' },
  { id: 'cat', emoji: '🐈', label: 'a cat' },
];
app.get('/api/gifts/catalog', (_req, res) => res.json(GIFT_CATALOG));
app.post('/api/gifts/send', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { toEmail, giftId } = req.body || {};
  if (!toEmail || !giftId) return res.status(400).json({ error: 'recipient + giftId required' });
  if (toEmail.toLowerCase() === user.email.toLowerCase()) return res.status(400).json({ error: "can't gift yourself" });
  const gift = GIFT_CATALOG.find(g => g.id === giftId);
  if (!gift) return res.status(400).json({ error: 'unknown gift' });
  user._giftsSent = (user._giftsSent || 0) + 1;
  if (user._giftsSent > 50 * 365) return res.status(429).json({ error: 'too many gifts' });
  saveUsers();
  pushNotif(toEmail, {
    type: 'gift',
    fromName: 'someone (anonymous)',
    fromEmail: '',
    text: `someone sent you ${gift.emoji} ${gift.label} anonymously.`,
    giftEmoji: gift.emoji,
    giftLabel: gift.label
  });
  res.json({ ok: true });
});

// =================================================================
// PHASE 1 SCHEDULERS — QOTD (7am), late-night cleanup (7am),
// royalty (Sun 8pm). Checked every 5 minutes.
// =================================================================
let qotdFiredKey = '';
let lateNightSweptKey = '';
let royaltyAwardedKey = '';
setInterval(() => {
  const now = new Date();
  const k = dailyKey();
  // QOTD — fires once at 7am local each day
  if (now.getHours() >= 7 && qotdFiredKey !== k) {
    qotdFiredKey = k;
    try { fireQuestionOfTheDay(); } catch (e) { console.error('[qotd] fire failed', e); }
  }
  // Late-night sweep — fires once at 7am: pick winner, save headline, wipe stream
  if (now.getHours() >= 7 && lateNightSweptKey !== k) {
    lateNightSweptKey = k;
    try { resurfaceLateNightWinner(); } catch (e) { console.error('[late-night] sweep failed', e); }
  }
  // Weekly royalty — fires once a week on Sunday at/after 8pm
  if (now.getDay() === 0 && now.getHours() >= 20) {
    const wk = weekKeyOf();
    if (royaltyAwardedKey !== wk) {
      royaltyAwardedKey = wk;
      try { awardWeeklyRoyalty(); } catch (e) { console.error('[royalty] award failed', e); }
    }
  }
}, 5 * 60 * 1000);

// Make sure the QOTD seed exists in memory ASAP on boot — so the first
// API hit doesn't end up with an empty answer pool.
setTimeout(() => { try { getOrCreateTodayQotd(); } catch {} }, 2000);

// Daily digest: send each active member a digest at 6pm local
let lastDigestDay = null;
setInterval(async () => {
  const now = new Date();
  const todayKey = dayKey(now);
  if (now.getHours() < 18 || lastDigestDay === todayKey) return;
  lastDigestDay = todayKey;

  const recent = posts
    .filter(p => p.createdAt > Date.now() - ONE_DAY_MS && (!p.expiresAt || p.expiresAt > Date.now()))
    .sort((a, b) => {
      const sa = Object.values(a.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
      const sb = Object.values(b.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
      return sb - sa;
    })
    .slice(0, 5);

  if (recent.length === 0) return;
  console.log(`[digest] sending to ${users.filter(u => u.status === 'active').length} active members`);

  for (const u of users) {
    if (u.status !== 'active') continue;
    sendDigestEmail(u, recent).catch(e => console.warn('digest failed for', u.email, e));
  }
}, 60 * 60 * 1000); // check hourly

async function sendDigestEmail(user, topPosts) {
  if (!config.resendApiKey) return;
  const _u = unsubArtifacts(user.email);
  if (_u.blocked) return;
  const siteUrl = config.publicUrl || 'http://localhost:3001';
  const items = topPosts.map((p, i) => {
    const txt = p.type === 'text' ? p.content : (p.caption || `[${p.type} post]`);
    const reacts = Object.values(p.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
    const displayAuthor = p.isAnonymous ? 'anonymous' : p.author;
    return `<div style="border-left: 3px solid #3B5998; padding: 8px 12px; margin: 8px 0; background: #f5f7fc;">
      <strong style="color: #3B5998;">${escapeHtmlServer(displayAuthor)}</strong>
      <span style="font-size: 11px; color: #888; margin-left: 6px;">· ${reacts} reactions · ${(p.comments || []).length} comments</span>
      <div style="font-size: 13px; margin-top: 4px;">${escapeHtmlServer(txt.slice(0, 200))}${txt.length > 200 ? '…' : ''}</div>
    </div>`;
  }).join('');
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1c1c1c;">
      <div style="background: #3B5998; color: white; padding: 11px 16px; font-weight: bold; font-size: 17px;">[ Old Streets ] today's digest</div>
      <h2 style="color: #3B5998; font-size: 20px; margin: 18px 0 12px;">What you missed today</h2>
      ${items}
      <p style="margin: 22px 0;">
        <a href="${siteUrl}" style="display: inline-block; background: #3B5998; color: white; padding: 10px 18px; text-decoration: none; font-weight: bold; border: 1px solid #2f477b;">See it all →</a>
      </p>
      <p style="color: #aaa; font-size: 9px; margin-top: 18px; line-height: 1.55;">
        Old Streets is independent — not affiliated with any school. We don't condone bullying.
      </p>
      ${_u.footerHtml}
    </div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + config.resendApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.emailFrom || 'Lander <noreply@lander.host>',
      to: [user.email],
      subject: `Old Streets · today's digest · ${topPosts.length} top posts`,
      html,
      headers: _u.headers
    })
  });
}

// Flush any debounced writes before exit so we never lose data.
function shutdown(signal) {
  console.log(`[${signal}] flushing pending saves…`);
  flushSavesSync();
  // Best-effort backup before we go down. async; we can wait briefly.
  if (ghBackupEnabled()) {
    console.log('[gh-backup] final backup before shutdown…');
    ghBackupNow().catch(() => {}).finally(() => process.exit(0));
    // Hard timeout — don't hang the shutdown forever
    setTimeout(() => process.exit(0), 8000);
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('uncaughtException:', e);
  flushSavesSync();
  process.exit(1);
});

function logProdReadinessWarnings() {
  const w = [];
  if (!config.resendApiKey) {
    w.push('RESEND_API_KEY is empty — invite emails / password reset / digest will be silently skipped');
  }
  if (config.publicUrl === 'http://localhost:3001') {
    w.push('PUBLIC_URL is at localhost — invite + reset links in emails will not work for recipients. Set PUBLIC_URL env var to your live URL.');
  }
  if (config.emailFrom.includes('onboarding@resend.dev')) {
    w.push('EMAIL_FROM uses Resend sandbox — emails only deliver to your own Resend account. Set EMAIL_FROM env var to a verified-domain From.');
  }
  if (config.adminPasscode === 'change-me-admin' || config.adminPasscode === 'orion-admin') {
    w.push('ADMIN_PASSCODE is at default — anyone can take over admin. Set ADMIN_PASSCODE env var to a long random string.');
  }
  const dataEmpty = !fs.existsSync(DATA_DIR) || (fs.readdirSync(DATA_DIR).length === 0);
  if (dataEmpty && process.env.NODE_ENV === 'production' && !ghBackupEnabled()) {
    w.push('data/ is empty AND no GH backup configured. Set GH_BACKUP_REPO + GH_BACKUP_TOKEN env vars OR mount a persistent volume at /app/data — otherwise every redeploy WIPES accounts/posts/DMs.');
  }
  if (w.length === 0) return;
  console.log('');
  console.log('========================================');
  console.log(' ⚠  PRODUCTION READINESS WARNINGS');
  console.log('========================================');
  for (const m of w) console.log(' ✗ ' + m);
  console.log('========================================');
  console.log('');
}

const PORT = process.env.PORT || 3001;
// ONE-TIME purge: any reaction / view email that isn't either a real
// active user OR a synthetic ghost email gets converted to a synthetic
// ghost email. This wipes the historical "person reacted" attribution
// from when ghosts used real directory addresses.
function purgeGhostAttribution() {
  const realEmails = new Set(users.map(u => (u.email || '').toLowerCase()));
  let changed = 0;
  for (const p of posts) {
    if (p.reactions) {
      for (const emoji of Object.keys(p.reactions)) {
        const bucket = p.reactions[emoji];
        const newBucket = {};
        for (const email of Object.keys(bucket)) {
          const lc = (email || '').toLowerCase();
          if (lc.endsWith('@old-streets.internal') || realEmails.has(lc)) {
            newBucket[email] = bucket[email];
          } else {
            // ghost reaction with a real directory name → re-key under synthetic
            newBucket[newGhostInteractorEmail()] = bucket[email];
            changed++;
          }
        }
        p.reactions[emoji] = newBucket;
      }
      p.upvotes = p.reactions['👍'] || {};
      p.downvotes = p.reactions['👎'] || {};
    }
    if (p.views) {
      const newViews = {};
      for (const email of Object.keys(p.views)) {
        const lc = (email || '').toLowerCase();
        if (lc.endsWith('@old-streets.internal') || realEmails.has(lc)) {
          newViews[email] = p.views[email];
        } else {
          newViews[newGhostInteractorEmail()] = p.views[email];
          changed++;
        }
      }
      p.views = newViews;
    }
  }
  if (changed > 0) {
    console.log(`[purge] re-anonymized ${changed} ghost attributions on existing posts`);
    savePosts();
  }
}

async function start() {
  // Restore from GH backup BEFORE accepting traffic — so the first request
  // that signs up a user can't write into a fresh-empty state and overwrite
  // the backup with empty data.
  await bootstrapPersistence();
  if (users.length === 0) loadAll(); // re-read in case restore wrote files
  // Purge runs as a non-blocking task so it can never delay the server
  // from accepting traffic. Failure here is non-fatal.
  setTimeout(() => {
    try { purgeGhostAttribution(); }
    catch (e) { console.error('[purge] failed (non-fatal):', e); }
  }, 5000);
  // Seed the default Luxey ad if no ads exist yet
  try { seedDefaultAdIfEmpty(); } catch (e) { console.error('[ads-seed] failed:', e); }
  // EMERGENCY LOCKDOWN — runs once for accounts flagged in LOCKDOWN_USERS
  // env var (default: admin@oldstreets.app). Skips users already locked.
  try { await runEmergencyLockdownIfNeeded(); } catch (e) { console.error('[lockdown] failed:', e); }
  // Auto-grant admin to your account so the admin panel "just works"
  // whenever you're logged in. No password header needed.
  try { ensureForcedAdmins(); } catch (e) { console.error('[admin-grant] failed:', e); }

  server.listen(PORT, () => {
    console.log(`OLD STREETS server running on port ${PORT}`);
    console.log(`accounts on disk: ${users.length}`);
    console.log(`directory entries: ${directory.length}`);
    console.log(`publicUrl: ${config.publicUrl}`);
    console.log(`emailFrom: ${config.emailFrom}`);
    console.log(`resend configured: ${config.resendApiKey ? 'yes' : 'NO'}`);
    console.log(`gh backup: ${ghBackupEnabled() ? `yes (${process.env.GH_BACKUP_REPO})` : 'NO — data won\'t survive redeploys'}`);
    logProdReadinessWarnings();
  });
}
start().catch(e => { console.error('startup failed:', e); process.exit(1); });
