/* =================================================================
   OLD STREETS — client app
   ================================================================= */

const TIPS = [
  "Who is the best teacher? Obviously Jay. ms madson so pretty.",
  "Old Streets is members-only. Don't share your passcode w/ randos.",
  "Need an invite? Ask a current member to send you an invite.",
  "Sign up with an invite — admin approves within a day.",
  "Press / on the Wall to focus the search bar.",
  "Vote up = good. Vote down = bad.",
  "Make a Room and name it the class you're in right now.",
  "Random Video Chat = 1:1 video with another NR kid.",
  "Comments are public. Don't be a coward, don't be a creep.",
  "Camera + mic only turns on when you actually start a video chat.",
  "If a teacher walks by, just close the tab.",
  "Loading…",
  "Connecting to The Wall…"
];

// =================================================================
// STATE
// =================================================================
const state = {
  socket: null,
  user: null,
  token: null,
  socketId: null,
  localStream: null,
  currentRoom: null,
  postitType: 'text',
  postitFile: null,
  posts: [],
  sortMode: 'recent',
  searchQuery: '',
  openComments: new Set(),
  authMode: 'signup',
  waitlistInterval: null,
  directory: [],
  referralPicks: [null, null, null],
  pendingAvatar: null,
  dmOpenWith: null,
  notifs: [],
  unreadDmCount: 0,
  unreadNotifCount: 0,
  featureStatus: { dm: { unlocked: false }, random: { unlocked: false } },
  onlineEmails: new Set(),
  userAvatars: {},
  directory: []     // [{name, email}] for @mention typeahead
};
const REACTIONS = ['👍','👎','😂','🔥','💀','😍'];
const LAST_VISIT_KEY = 'oldstreets-last-visit';

// Wrapper that picks localStorage (persistent across browser restarts) or
// sessionStorage (cleared on browser close) based on "remember me".
const tokenStore = {
  get(key) {
    return localStorage.getItem(key) || sessionStorage.getItem(key) || null;
  },
  // Always persist to localStorage by default — "stay logged in" should
  // mean stay logged in. We only fall back to sessionStorage if the user
  // explicitly opted out of remember-me.
  set(key, val, persistent) {
    if (persistent !== false) {
      localStorage.setItem(key, val);
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, val);
      localStorage.removeItem(key);
    }
  },
  clear(key) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
};

const el = (id) => document.getElementById(id);
const STORAGE_KEY = 'oldstreets-token';

// =================================================================
// TIMEOUT LOCKOUT OVERLAY — when admin times a user out, this covers
// the whole UI with a countdown + the homelander gif. They can still
// see it because it's part of /api/me, but they can't do anything.
// =================================================================
function _fmtTimeoutLeft(ms) {
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function ensureTimeoutOverlay() {
  let ov = document.getElementById('timeout-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'timeout-overlay';
    ov.innerHTML = `
      <div class="timeout-card">
        <img class="timeout-gif" src="https://media.tenor.com/mBYyJweEnUoAAAAM/the-boys-homelander.gif" alt="homelander disapproves"/>
        <div class="timeout-title">YOU'VE BEEN LIMITED</div>
        <div class="timeout-sub">for posting dumb stuff</div>
        <div class="timeout-reason" id="timeout-reason"></div>
        <div class="timeout-countdown">
          <span class="timeout-countdown-label">time left:</span>
          <span class="timeout-countdown-value" id="timeout-countdown">—</span>
        </div>
        <div class="timeout-footnote">posting, commenting and reacting are blocked until the timer runs out.</div>
      </div>
    `;
    document.body.appendChild(ov);
  }
  return ov;
}
function refreshTimeoutOverlay() {
  const until = state?.user?.timeoutUntil || 0;
  const now = Date.now();
  // Fast path: no active timeout → don't even touch the DOM. The overlay
  // tick was firing every second and doing a getElementById + classList
  // touch on every page even for users who'd never been timed out.
  if (!until || until <= now) {
    const existing = document.getElementById('timeout-overlay');
    if (existing) existing.classList.remove('on');
    return;
  }
  const ov = ensureTimeoutOverlay();
  ov.classList.add('on');
  const reasonEl = document.getElementById('timeout-reason');
  if (reasonEl) reasonEl.textContent = state.user.timeoutReason ? `“${state.user.timeoutReason}”` : '';
  const cdEl = document.getElementById('timeout-countdown');
  if (cdEl) cdEl.textContent = _fmtTimeoutLeft(until - now);
}
setInterval(refreshTimeoutOverlay, 1000);

// =================================================================
// SITE-PAUSE OVERLAY — full-screen blocker covering everything, no
// dismiss. Activated when /api/site-info returns paused: true.
// =================================================================
function showPauseOverlay({ message, gif, teasers, apology }) {
  let ov = document.getElementById('site-pause-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'site-pause-overlay';
    document.body.appendChild(ov);
  }
  const clean = (s) => String(s || '').replace(/[<>]/g, '');
  const safeMsg = clean(message || 'we\'ll be back soon.');
  const apologyHtml = Array.isArray(apology) && apology.length
    ? `<div class="pause-apology">${apology.map(p => `<p>${clean(p)}</p>`).join('')}</div>`
    : '';
  const teaserList = Array.isArray(teasers) && teasers.length
    ? `<div class="pause-teasers-label">coming next:</div><ul class="pause-teasers">${teasers.map(t => `<li>${clean(t)}</li>`).join('')}</ul>`
    : '';
  ov.innerHTML = `
    <div class="pause-card">
      ${gif ? `<img class="pause-gif" src="${gif.replace(/"/g, '&quot;')}" alt="paused"/>` : ''}
      <div class="pause-title">⏸ Old Streets is temporarily paused</div>
      <div class="pause-body">${safeMsg}</div>
      ${apologyHtml}
      ${teaserList}
    </div>
  `;
  ov.classList.add('on');
}

// Daily-rotating brand word. The visible name swaps from "Old Streets" to
// "Old Roads" / "Old Pathways" / etc. depending on the day, so the site
// never reads the same twice in a row. Permanent canonical name in URLs
// and code is still "Old Streets" — only the rendered text rotates.
window.OS_BRAND = 'Old Streets';
function applyDailyBrand(brandToday) {
  if (!brandToday || brandToday === 'Old Streets') return;
  window.OS_BRAND = brandToday;
  try { document.title = 'Old Streets'; } catch {}
  // Case-aware substitution: replace each visible casing of the canonical
  // name with the matching casing of today's brand. Covers "Old Streets",
  // "old streets" (the lowercase wordmark pill), and ALL CAPS variants.
  const lowerBrand = brandToday.toLowerCase();
  const upperBrand = brandToday.toUpperCase();
  const SKIP = new Set(['SCRIPT','STYLE','CODE','PRE','TEXTAREA','INPUT','NOSCRIPT']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const v = n.nodeValue;
      if (!v) return NodeFilter.FILTER_REJECT;
      const has = v.indexOf('Old Streets') !== -1
               || v.indexOf('old streets') !== -1
               || v.indexOf('OLD STREETS') !== -1;
      if (!has) return NodeFilter.FILTER_REJECT;
      let p = n.parentNode;
      while (p && p.nodeType === 1) {
        if (SKIP.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const out = [];
  let cur; while ((cur = walker.nextNode())) out.push(cur);
  out.forEach(n => {
    let v = n.nodeValue;
    v = v.split('Old Streets').join(brandToday);
    v = v.split('old streets').join(lowerBrand);
    v = v.split('OLD STREETS').join(upperBrand);
    n.nodeValue = v;
  });
  // Re-run shortly to catch nodes injected after our first pass.
  if (!window._brandReapplied) {
    window._brandReapplied = true;
    setTimeout(() => { window._brandReapplied = false; try { applyDailyBrand(brandToday); } catch {} }, 1500);
  }
}

// ----------------------------------------------------------------
// AUTH GATE — if there's no token in localStorage, kick to /onboard.
// /onboard handles the unauthenticated states (landing, sign-in,
// invite-claim, signup, waitlist confirmation). This file (app.js) is
// the logged-in app — it should only ever run for signed-in users.
// ----------------------------------------------------------------
(function authGate(){
  try {
    const token = localStorage.getItem('oldstreets-token') || sessionStorage.getItem('oldstreets-token');
    if (!token && location.pathname !== '/onboard.html') {
      // Preserve ?invite= if present so the onboard flow picks it up.
      const params = location.search || '';
      location.replace('/onboard.html' + params);
    }
  } catch {}
})();

// ----------------------------------------------------------------
// WAITLIST OVERLAY — for signed-in users whose status is 'waitlist'.
// They can sign in but can't use the app. Shown as a full-screen
// blocker after whoami resolves.
// ----------------------------------------------------------------
function showWaitlistOverlay(user) {
  let ov = document.getElementById('waitlist-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'waitlist-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:#0a0a0a;color:#ece8e1;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;';
    ov.innerHTML = `
      <div style="max-width:420px;width:100%;text-align:left;">
        <div style="font-family:ui-serif,Georgia,serif;font-size:28px;text-align:center;margin-bottom:8px;">[ <span id="wl-brand">Old Streets</span> ]</div>
        <div style="width:64px;height:1px;background:#2a2722;margin:0 auto 28px;"></div>
        <h2 style="font-family:ui-serif,Georgia,serif;font-weight:400;font-size:24px;margin:0 0 12px;">You're on the waitlist.</h2>
        <p id="wl-overlay-body" style="color:#8a857a;font-size:14px;line-height:1.55;margin:0 0 20px;"></p>
        <div id="wl-overlay-pos" style="border:1px solid #2a2722;padding:14px 16px;font-size:13px;color:#8a857a;margin-bottom:20px;display:none;"></div>
        <p style="color:#4a4640;font-size:12px;letter-spacing:0.3px;margin:0 0 24px;">We'll text you when you're in. You can close this tab.</p>
        <button id="wl-overlay-out" style="width:100%;min-height:48px;background:transparent;color:#ece8e1;border:1px solid #2a2722;cursor:pointer;font-size:14px;letter-spacing:0.4px;">Sign out</button>
      </div>`;
    document.body.appendChild(ov);
    document.getElementById('wl-overlay-out').addEventListener('click', () => {
      try { localStorage.removeItem('oldstreets-token'); sessionStorage.removeItem('oldstreets-token'); localStorage.removeItem('oldstreets-user'); } catch {}
      location.replace('/onboard.html');
    });
  }
  const vouched = !!(user && user.invitedBy);
  document.getElementById('wl-overlay-body').textContent = vouched
    ? 'A current member vouched for you — you\'ll get in faster than the open pool, usually within a day.'
    : 'We let people in slowly. When a current member vouches you in, or the founder gets to your number, you\'ll get a text.';
  const pos = user && user.waitlistPosition;
  const posEl = document.getElementById('wl-overlay-pos');
  if (pos) { posEl.textContent = `You're #${pos} in line.`; posEl.style.display = ''; }
  if (window.OS_BRAND) {
    const b = document.getElementById('wl-brand'); if (b) b.textContent = window.OS_BRAND;
  }
}

// Run on boot before anything else.
(async () => {
  try {
    const r = await fetch('/api/site-info').then(r => r.json());
    if (r && r.brandToday) applyDailyBrand(r.brandToday);
    if (r && r.paused) showPauseOverlay({ message: r.pauseMessage, gif: r.pauseGif, teasers: r.pauseTeasers, apology: r.pauseApology });
  } catch {}
})();
// Also re-poll every 30s so a server-side flip propagates without forcing
// users to refresh.
setInterval(async () => {
  try {
    const r = await fetch('/api/site-info').then(r => r.json());
    if (r && r.paused) {
      showPauseOverlay({ message: r.pauseMessage, gif: r.pauseGif, teasers: r.pauseTeasers, apology: r.pauseApology });
    } else {
      const ov = document.getElementById('site-pause-overlay');
      if (ov) ov.classList.remove('on');
    }
  } catch {}
}, 30000);

// =================================================================
// ADMIN WARNING OVERLAY — full-screen blocker with 30s countdown
// before the user can dismiss it.
// =================================================================
function showAdminWarning(warning) {
  if (!warning || !warning.message) return;
  let ov = document.getElementById('admin-warning-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'admin-warning-overlay';
    ov.innerHTML = `
      <div class="admin-warning-card">
        <div class="admin-warning-title">⚠️ ADMIN MESSAGE</div>
        <div class="admin-warning-body" id="admin-warning-body"></div>
        <div class="admin-warning-countdown" id="admin-warning-countdown"></div>
        <button class="admin-warning-dismiss" id="admin-warning-dismiss" disabled>read & dismiss (30s)</button>
      </div>
    `;
    document.body.appendChild(ov);
  }
  document.getElementById('admin-warning-body').textContent = warning.message;
  ov.classList.add('on');
  const btn = document.getElementById('admin-warning-dismiss');
  const cd  = document.getElementById('admin-warning-countdown');
  let left = 30;
  btn.disabled = true;
  btn.textContent = `read & dismiss (${left}s)`;
  cd.textContent = `you can dismiss in ${left}s`;
  const tick = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(tick);
      btn.disabled = false;
      btn.textContent = 'dismiss';
      cd.textContent = '';
      return;
    }
    btn.textContent = `read & dismiss (${left}s)`;
    cd.textContent = `you can dismiss in ${left}s`;
  }, 1000);
  btn.onclick = async () => {
    if (btn.disabled) return;
    ov.classList.remove('on');
    clearInterval(tick);
    try { await api('POST', '/api/me/clear-warning'); } catch {}
    if (state.user) state.user.adminWarning = null;
  };
}

// Check on app boot — if the user already has a warning pending, show it.
setTimeout(() => {
  if (state.user && state.user.adminWarning) showAdminWarning(state.user.adminWarning);
}, 1500);

// =================================================================
// LOADING / TIPS
// =================================================================
let loadingTipInterval = null;
function startTipRotation(target) {
  pickTip(target);
  if (loadingTipInterval) clearInterval(loadingTipInterval);
  loadingTipInterval = setInterval(() => pickTip(target), 2400);
}
function stopTipRotation() {
  if (loadingTipInterval) clearInterval(loadingTipInterval);
  loadingTipInterval = null;
}
function pickTip(targetEl) {
  if (!targetEl) return;
  const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
  targetEl.style.opacity = 0;
  setTimeout(() => {
    targetEl.textContent = tip;
    targetEl.style.opacity = 1;
  }, 200);
}

function showMiniLoad(durationMs = 800) {
  return new Promise(resolve => {
    const overlay = el('mini-loading');
    overlay.classList.remove('hidden');
    startTipRotation(el('mini-loading-tip'));
    setTimeout(() => {
      overlay.classList.add('hidden');
      stopTipRotation();
      resolve();
    }, durationMs);
  });
}

async function showScreen(screenId, withMiniLoad = true) {
  const screens = ['loading-screen', 'passcode-screen', 'username-screen',
                   'forgot-screen', 'reset-screen',
                   'referrals-screen', 'waitlist-screen', 'board-screen'];
  if (withMiniLoad) await showMiniLoad();
  for (const id of screens) {
    el(id).classList.toggle('hidden', id !== screenId);
    el(id).classList.toggle('active', id === screenId);
  }
}

let toastTimeout = null;
function toast(msg, ms = 2400) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.add('hidden'), ms);
}

// =================================================================
// FETCH WRAPPER (auto-includes token)
// =================================================================
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  // If in-memory state lost the token (e.g., script-evaluation order race
  // on cold load), fall back to localStorage so the user doesn't get
  // booted with "sign in first" when they actually do have a valid session.
  if (!state.token) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
      if (saved) state.token = saved;
    } catch {}
  }
  if (state.token) headers['X-User-Token'] = state.token;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    // Server says the TOS hasn't been agreed to for this user — pop the modal.
    if (res.status === 403 && data && data.error === 'tos-required' && state.user) {
      state.user.needsTosAgreement = true;
      try { maybeShowTosModal(); } catch {}
    }
    // Server says we're timed out — sync local state so the overlay appears
    // even if the websocket missed the broadcast.
    if (res.status === 403 && data && data.error === 'timed-out' && state.user) {
      state.user.timeoutUntil = data.timeoutUntil || (Date.now() + 60 * 1000);
      state.user.timeoutReason = data.timeoutReason || '';
      try { refreshTimeoutOverlay(); } catch {}
    }
    // If we sent a token and the server doesn't recognize it, count it.
    // We're VERY lenient about clearing the local session — a redeploy
    // wipe, a flaky network, a Fortinet hiccup, anything can return a
    // transient 401. Only clear after 10 consecutive rejections (was 3).
    // Remember-me should mean remember me forever unless the user logs out.
    if (state.token && res.status === 401 && data.error === 'sign in first') {
      state._authRejectCount = (state._authRejectCount || 0) + 1;
      if (state._authRejectCount >= 10) {
        console.warn('[auth] token rejected 10 times — clearing local session');
        tokenStore.clear(STORAGE_KEY);
        state.token = null;
        state.user = null;
        state._authRejectCount = 0;
      } else {
        console.warn(`[auth] token 401 (count ${state._authRejectCount}/10) — keeping local session`);
      }
    } else if (res.ok || res.status !== 401) {
      state._authRejectCount = 0;
    }
    const err = new Error(data.error || ('http ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  // any success resets the auth-reject counter
  state._authRejectCount = 0;
  return data;
}

// =================================================================
// INITIAL FLOW
// =================================================================
window.addEventListener('DOMContentLoaded', async () => {
  startTipRotation(el('loading-tip'));

  setupAuth();
  setupReferrals();
  setupWaitlist();
  setupFeedScreen();
  setupModals();
  setupChatOverlay();
  setupHashRouting();
  setupReportModal();
  setupEditProfile();
  setupFooter();
  setupDmModal();
  setupInbox();
  setupNotifBell();
  setupMobileBottomNav();
  setupForgotPassword();
  setupResetPassword();

  // Check for password reset URL param
  const resetTok = new URLSearchParams(window.location.search).get('reset');
  if (resetTok) {
    state.resetTokenFromUrl = resetTok;
    setTimeout(async () => {
      stopTipRotation();
      await showScreen('reset-screen', false);
      el('reset-pw1').focus();
    }, 800);
    return;
  }

  // Try resume session if token exists (checks both localStorage + sessionStorage)
  const savedToken = tokenStore.get(STORAGE_KEY);
  if (savedToken) {
    // Retry whoami a few times before giving up — transient network blips or
    // a cold-started server shouldn't bounce people to the signup screen.
    let r = null, lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await api('POST', '/api/whoami', { token: savedToken });
        break;
      } catch (e) {
        lastErr = e;
        // If the server EXPLICITLY says the token is unknown/banned, no retry.
        if (e.status === 401 || e.status === 403) break;
        // Otherwise wait a bit and retry (network, 502, 504, etc.)
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (r) {
      state.token = savedToken;
      state.user = r.user;
      // Waitlisted users see the full-screen waitlist overlay instead of the app.
      if (r.user && r.user.status === 'waitlist') {
        try { showWaitlistOverlay(r.user); } catch (e) { console.warn('[waitlist] overlay failed', e.message); }
        return;
      }
      setTimeout(async () => {
        stopTipRotation();
        await routeByStatus();
      }, 900);
      return;
    }
    // Only NUKE the saved token if the server EXPLICITLY says the token
    // doesn't match a user or the account is banned. Other 403s (TOS,
    // unverified email, timed out, recoverable) keep the token so we
    // don't kick the user out for a soft restriction.
    const hardReject =
      lastErr && (
        (lastErr.status === 401 && lastErr.data?.error === 'unknown token') ||
        (lastErr.status === 403 && lastErr.data?.error === 'account banned')
      );
    if (hardReject) {
      tokenStore.clear(STORAGE_KEY);
      setTimeout(() => {
        toast('your session expired — sign in again', 5000);
      }, 1200);
    } else {
      // Network / 5xx — DON'T clear, just show signup screen with token preserved.
      setTimeout(() => {
        toast("couldn't reach the server — your session is saved, try again in a minute", 6000);
      }, 1200);
    }
  }

  // No saved session — go straight to signup/login (no passcode)
  setTimeout(async () => {
    stopTipRotation();
    await showScreen('username-screen', false);
    el('signup-name').focus();
  }, 2200);
});

// =================================================================
// AUTH SCREEN (Sign Up / Log In tabs) — initial passcode killed
// =================================================================
function setupAuth() {
  setupQuickNameSignIn();
  // Legacy modes (signup/login forms) are hidden via CSS; no openAuthMode needed.
  function openAuthMode(mode) {
    // Kept as a no-op so existing data-go buttons don't error out.
    state.authMode = mode;
  }
  // Landing big buttons
  document.querySelectorAll('[data-go]').forEach(btn => {
    btn.addEventListener('click', () => openAuthMode(btn.dataset.go));
  });
  // Legacy tabs (still present as a sub-toggle in case anyone wants to switch mode)
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => openAuthMode(tab.dataset.mode));
  });
  // "Use code instead" inside the login form
  const useCodeBtn = el('login-use-code-btn');
  if (useCodeBtn) useCodeBtn.addEventListener('click', () => openAuthMode('quick'));
  // 2FA Quick Sign In wiring
  setupQuickSignIn();
  // Google Sign-In wiring (no-op if GOOGLE_CLIENT_ID env is unset)
  setupGoogleSignIn();

  const signupSubmit = async () => {
    const name = el('signup-name').value.trim();
    const email = el('signup-email').value.trim().toLowerCase();
    const password = el('signup-password').value;
    const errEl = el('signup-error');
    errEl.classList.add('hidden');
    if (!name) { errEl.textContent = 'enter your name'; errEl.classList.remove('hidden'); return; }
    if (!/^[a-z0-9._%+-]+.*$/i.test(email)) {
      errEl.textContent = 'email must end in ';
      errEl.classList.remove('hidden');
      return;
    }
    if (!password || password.length < 6) {
      errEl.textContent = 'password must be at least 6 characters';
      errEl.classList.remove('hidden');
      return;
    }
    const grade = el('signup-grade')?.value || '';
    if (!grade) {
      errEl.textContent = 'pick your grade';
      errEl.classList.remove('hidden');
      return;
    }
    el('signup-submit').disabled = true;
    el('signup-submit').textContent = 'submitting…';
    try {
      const r = await api('POST', '/api/signup', { name, email, password, grade });
      state.token = r.token;
      state.user = r.user;
      tokenStore.set(STORAGE_KEY, r.token, true); // signup: always persistent
      // Mark them for onboarding — Crush flow or general
      const fromCrush = (window.location.hash || '').startsWith('#crush=');
      localStorage.setItem('needs-onboarding', fromCrush ? 'crush' : '1');
      await routeByStatus();
    } catch (e) {
      const msg = e.data?.error || e.message || 'signup failed';
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      if (msg.toLowerCase().includes('already registered')) {
        setTimeout(() => {
          document.querySelector('.auth-tab[data-mode="login"]').click();
          el('login-email').value = email;
          el('login-password').focus();
        }, 1200);
      }
    } finally {
      el('signup-submit').disabled = false;
      el('signup-submit').textContent = 'Sign Up →';
    }
  };
  el('signup-submit').addEventListener('click', signupSubmit);
  el('signup-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('signup-email').focus(); });
  el('signup-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('signup-password').focus(); });
  el('signup-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signupSubmit(); });

  // Auto-fill / lock the name field when the email matches the school directory
  el('signup-email').addEventListener('blur', async () => {
    const email = el('signup-email').value.trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+.*$/i.test(email)) return;
    if (state.directory.length === 0) {
      try {
        const r = await fetch('/api/directory').then(x => x.json());
        state.directory = Array.isArray(r) ? r : [];
      } catch {}
    }
    const match = state.directory.find(d => d.email.toLowerCase() === email);
    const nameInput = el('signup-name');
    if (match) {
      nameInput.value = match.name;
      nameInput.readOnly = true;
      nameInput.style.background = '#e8efff';
      nameInput.style.color = '#1c2e5b';
      // hint
      let hint = el('signup-name-hint');
      if (!hint) {
        hint = document.createElement('p');
        hint.id = 'signup-name-hint';
        hint.style.cssText = 'font-size: 10px; color: var(--fb-blue); margin: 4px 0 0; font-weight: bold;';
        nameInput.parentNode.appendChild(hint);
      }
      hint.textContent = '✓ matched school directory — name is locked to prevent impersonation';
    } else {
      nameInput.readOnly = false;
      nameInput.style.background = '';
      nameInput.style.color = '';
      const hint = el('signup-name-hint');
      if (hint) hint.remove();
    }
  });

  const loginSubmit = async () => {
    const email = el('login-email').value.trim().toLowerCase();
    const password = el('login-password').value;
    const errEl = el('login-error');
    errEl.classList.add('hidden');
    if (!/^[a-z0-9._%+-]+.*$/i.test(email)) {
      errEl.textContent = 'use your  email';
      errEl.classList.remove('hidden');
      return;
    }
    if (!password) {
      errEl.textContent = 'enter your password';
      errEl.classList.remove('hidden');
      return;
    }
    el('login-submit').disabled = true;
    el('login-submit').textContent = 'logging in…';
    try {
      const r = await api('POST', '/api/login', { email, password });
      state.token = r.token;
      state.user = r.user;
      // Always persist login token to localStorage — "stay logged in" is the
      // expectation. The Remember-me checkbox now only affects ephemeral
      // session preference; we still survive browser close.
      tokenStore.set(STORAGE_KEY, r.token, true);
      await routeByStatus();
    } catch (e) {
      errEl.textContent = e.data?.error || 'login failed';
      errEl.classList.remove('hidden');
    } finally {
      el('login-submit').disabled = false;
      el('login-submit').textContent = 'Log In →';
    }
  };
  // Legacy login wiring left in place but the form is hidden — these are no-ops
  // unless someone manually un-hides the auth-forms div.
  if (el('login-submit')) el('login-submit').addEventListener('click', loginSubmit);
  if (el('login-email')) el('login-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('login-password').focus(); });
  if (el('login-password')) el('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginSubmit(); });
  setupAccountRecovery();
}

// Passwordless sign-in: name → email code → in. Auto-creates the account
// on first sign-in if the name matches the school directory.
function setupQuickNameSignIn() {
  const startBtn = el('qn-start');
  if (!startBtn || startBtn._wired) return;
  startBtn._wired = true;

  const stepName = el('quick-step-name-landing');
  const stepCode = el('quick-step-code-landing');
  const errEl = el('qn-error');
  const nameInput = el('qn-name');
  const suggestions = el('qn-suggestions');

  // Load the school directory once for autocomplete. We just need the
  // NAMES — emails stay on the server. Cached for the page lifetime.
  let directoryNames = [];
  api('GET', '/api/directory').then(list => {
    directoryNames = (list || []).map(d => d.name).filter(Boolean).sort();
  }).catch(() => {});

  let highlightIdx = -1;
  const renderSuggestions = (matches) => {
    if (matches.length === 0) {
      suggestions.classList.add('hidden');
      suggestions.innerHTML = '';
      highlightIdx = -1;
      return;
    }
    highlightIdx = -1;
    suggestions.innerHTML = matches.slice(0, 8).map((n, i) =>
      `<div class="qn-suggestion" data-name="${escapeAttr(n)}" data-i="${i}">${escapeHtml(n)}</div>`
    ).join('');
    suggestions.classList.remove('hidden');
    suggestions.querySelectorAll('.qn-suggestion').forEach(div => {
      div.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur the input first
        nameInput.value = div.dataset.name;
        suggestions.classList.add('hidden');
        nameInput.focus();
      });
    });
  };

  const updateSuggestions = () => {
    const q = nameInput.value.trim().toLowerCase();
    if (q.length < 1) { renderSuggestions([]); return; }
    const matches = directoryNames.filter(n => n.toLowerCase().includes(q));
    // Prioritize startsWith matches first
    matches.sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.toLowerCase().startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.localeCompare(b);
    });
    renderSuggestions(matches);
  };
  nameInput.addEventListener('input', updateSuggestions);
  nameInput.addEventListener('focus', updateSuggestions);
  nameInput.addEventListener('blur', () => {
    setTimeout(() => suggestions.classList.add('hidden'), 120);
  });
  nameInput.addEventListener('keydown', (e) => {
    const rows = suggestions.querySelectorAll('.qn-suggestion');
    if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault();
      highlightIdx = Math.min(rows.length - 1, highlightIdx + 1);
      rows.forEach((r, i) => r.classList.toggle('hl', i === highlightIdx));
    } else if (e.key === 'ArrowUp' && rows.length) {
      e.preventDefault();
      highlightIdx = Math.max(0, highlightIdx - 1);
      rows.forEach((r, i) => r.classList.toggle('hl', i === highlightIdx));
    } else if (e.key === 'Enter' && highlightIdx >= 0 && rows[highlightIdx]) {
      e.preventDefault();
      nameInput.value = rows[highlightIdx].dataset.name;
      suggestions.classList.add('hidden');
    } else if (e.key === 'Escape') {
      suggestions.classList.add('hidden');
    }
  });

  const sendCode = async () => {
    errEl.classList.add('hidden');
    const name = el('qn-name').value.trim();
    if (!name) { errEl.textContent = 'enter your name'; errEl.classList.remove('hidden'); return; }
    startBtn.disabled = true;
    startBtn.textContent = 'sending…';
    try {
      const r = await api('POST', '/api/login/start-2fa', { name });
      stepName.classList.add('hidden');
      stepCode.classList.remove('hidden');
      if (r.maskedEmail) el('qn-masked-email').textContent = r.maskedEmail;
      if (r.devCode) toast('dev code (no email configured): ' + r.devCode, 12000);
      el('qn-code').focus();
    } catch (e) {
      errEl.textContent = e.data?.error || 'failed — try again';
      errEl.classList.remove('hidden');
    } finally {
      startBtn.disabled = false;
      startBtn.textContent = '📩 Email me a sign-in code';
    }
  };

  const verifyCode = async () => {
    errEl.classList.add('hidden');
    const name = el('qn-name').value.trim();
    const code = el('qn-code').value.trim();
    if (!code) { errEl.textContent = 'enter the code'; errEl.classList.remove('hidden'); return; }
    const vbtn = el('qn-verify');
    vbtn.disabled = true; vbtn.textContent = 'signing in…';
    try {
      const r = await api('POST', '/api/login/verify-2fa', { name, code });
      state.token = r.token;
      state.user = r.user;
      tokenStore.set(STORAGE_KEY, r.token, true);
      await routeByStatus();
    } catch (e) {
      errEl.textContent = e.data?.error || 'failed';
      errEl.classList.remove('hidden');
      vbtn.disabled = false; vbtn.textContent = 'Sign in →';
    }
  };

  startBtn.addEventListener('click', sendCode);
  el('qn-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(); });
  el('qn-verify').addEventListener('click', verifyCode);
  el('qn-code')?.addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
  el('qn-resend')?.addEventListener('click', sendCode);
  el('qn-back')?.addEventListener('click', () => {
    stepCode.classList.add('hidden');
    stepName.classList.remove('hidden');
    errEl.classList.add('hidden');
    el('qn-code').value = '';
    el('qn-name').focus();
  });
}

function setupAccountRecovery() {
  const openBtn = el('recover-btn');
  if (!openBtn || openBtn._wired) return;
  openBtn._wired = true;
  const flow = el('recover-flow');
  const sendBtn = el('recover-send');
  const verifyBtn = el('recover-verify');
  const stepEmail = el('recover-step-email');
  const stepCode = el('recover-step-code');
  const err = el('recover-error');
  openBtn.addEventListener('click', () => {
    flow.classList.toggle('hidden');
    if (!flow.classList.contains('hidden')) el('recover-email').focus();
  });
  sendBtn.addEventListener('click', async () => {
    err.classList.add('hidden');
    const email = el('recover-email').value.trim();
    if (!email) { err.textContent = 'enter your school email'; err.classList.remove('hidden'); return; }
    sendBtn.disabled = true; sendBtn.textContent = 'sending…';
    try {
      await api('POST', '/api/recover/request', { email });
      stepEmail.classList.add('hidden');
      stepCode.classList.remove('hidden');
      el('recover-code').focus();
    } catch (e) {
      err.textContent = e.data?.error || 'failed — try again';
      err.classList.remove('hidden');
    } finally {
      sendBtn.disabled = false; sendBtn.textContent = 'Send me a code →';
    }
  });
  verifyBtn.addEventListener('click', async () => {
    err.classList.add('hidden');
    const email = el('recover-email').value.trim();
    const code = el('recover-code').value.trim();
    if (!code) { err.textContent = 'enter the code'; err.classList.remove('hidden'); return; }
    verifyBtn.disabled = true; verifyBtn.textContent = 'verifying…';
    try {
      const r = await api('POST', '/api/recover/verify', { email, code });
      state.token = r.token;
      state.user = r.user;
      tokenStore.set(STORAGE_KEY, r.token, true);
      toast('account recovered ✓ all other sessions logged out');
      await routeByStatus();
    } catch (e) {
      err.textContent = e.data?.error || 'failed';
      err.classList.remove('hidden');
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Recover account →';
    }
  });
}

// =================================================================
// FORGOT PASSWORD / RESET PASSWORD
// =================================================================
function setupForgotPassword() {
  // Open forgot screen from login
  const link = el('forgot-pw-link');
  if (link) link.addEventListener('click', async () => {
    el('forgot-status').classList.add('hidden');
    el('forgot-error').classList.add('hidden');
    el('forgot-email').value = el('login-email').value || '';
    await showScreen('forgot-screen');
    el('forgot-email').focus();
  });
  el('forgot-back').addEventListener('click', async () => {
    await showScreen('username-screen');
    document.querySelector('.auth-tab[data-mode="login"]').click();
    el('login-email').focus();
  });

  const submit = async () => {
    const email = el('forgot-email').value.trim().toLowerCase();
    el('forgot-status').classList.add('hidden');
    el('forgot-error').classList.add('hidden');
    if (!/^[a-z0-9._%+-]+.*$/i.test(email)) {
      el('forgot-error').textContent = 'use your  email';
      el('forgot-error').classList.remove('hidden');
      return;
    }
    el('forgot-submit').disabled = true;
    el('forgot-submit').textContent = 'sending…';
    try {
      await api('POST', '/api/forgot-password', { email });
      el('forgot-status').textContent = '✓ if an account exists with that email, a reset link is on the way. check your inbox (and spam).';
      el('forgot-status').classList.remove('hidden');
    } catch (e) {
      el('forgot-error').textContent = e.data?.error || 'something broke';
      el('forgot-error').classList.remove('hidden');
    } finally {
      el('forgot-submit').disabled = false;
      el('forgot-submit').textContent = 'Send reset link →';
    }
  };
  el('forgot-submit').addEventListener('click', submit);
  el('forgot-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function setupResetPassword() {
  const submit = async () => {
    const pw1 = el('reset-pw1').value;
    const pw2 = el('reset-pw2').value;
    const errEl = el('reset-error');
    errEl.classList.add('hidden');
    if (pw1.length < 6) { errEl.textContent = 'password must be at least 6 characters'; errEl.classList.remove('hidden'); return; }
    if (pw1 !== pw2) { errEl.textContent = "passwords don't match"; errEl.classList.remove('hidden'); return; }

    el('reset-submit').disabled = true;
    el('reset-submit').textContent = 'saving…';
    try {
      const r = await api('POST', '/api/reset-password', {
        resetToken: state.resetTokenFromUrl,
        newPassword: pw1
      });
      state.token = r.token;
      state.user = r.user;
      tokenStore.set(STORAGE_KEY, r.token, true); // reset: persistent
      // strip ?reset= from URL so a refresh doesn't loop
      const url = new URL(window.location.href);
      url.searchParams.delete('reset');
      window.history.replaceState({}, '', url.toString());
      toast('password updated — logged in');
      await routeByStatus();
    } catch (e) {
      errEl.textContent = e.data?.error || 'reset failed';
      errEl.classList.remove('hidden');
    } finally {
      el('reset-submit').disabled = false;
      el('reset-submit').textContent = 'Save new password →';
    }
  };
  el('reset-submit').addEventListener('click', submit);
  el('reset-pw1').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('reset-pw2').focus(); });
  el('reset-pw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// =================================================================
// STATUS-BASED ROUTING
// =================================================================
async function routeByStatus() {
  if (!state.user) {
    state.token = null;
    localStorage.removeItem(STORAGE_KEY);
    await showScreen('username-screen', false);
    el('signup-name').focus();
    return;
  }
  if (state.user.status === 'active') {
    // Referrals are turned off — everyone goes straight to the feed.
    await connectAndShowFeed();
  } else if (state.user.status === 'awaiting-referrals') {
    // Legacy status — auto-skip to feed; the boot-time cleanup already
    // promotes these to 'active' but in case one slips through.
    await connectAndShowFeed();
  } else if (state.user.status === 'waitlist') {
    showWaitlist();
  } else {
    state.token = null;
    state.user = null;
    localStorage.removeItem(STORAGE_KEY);
    await showScreen('username-screen', false);
    el('signup-name').focus();
  }
}

// =================================================================
// REFERRALS SCREEN (last step before waitlist)
// =================================================================
async function showReferrals() {
  await showScreen('referrals-screen');
  // Load directory if not loaded
  if (state.directory.length === 0) {
    try {
      const r = await fetch('/api/directory').then(x => x.json());
      state.directory = Array.isArray(r) ? r : [];
    } catch (e) { console.warn('directory fetch failed', e); }
  }
  state.referralPicks = [null, null, null];
  renderReferralSlots();
}

function setupReferrals() {
  el('referrals-submit').addEventListener('click', submitReferrals);
  el('referrals-logout').addEventListener('click', logout);
}

function renderReferralSlots() {
  const wrap = el('referral-slots');
  wrap.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const pick = state.referralPicks[i];
    const slot = document.createElement('div');
    slot.className = 'referral-slot' + (pick ? ' filled' : '');
    slot.dataset.idx = i;
    slot.innerHTML = `
      <span class="referral-slot-num">#${i + 1}</span>
      <input type="text" class="referral-input ${pick ? 'filled' : ''}" placeholder="type a name..." value="${pick ? escapeHtml(pick.name + ' · ' + pick.email) : ''}" ${pick ? 'readonly' : ''}/>
      <button type="button" class="referral-clear" title="remove">✕</button>
      <div class="referral-dropdown"></div>
    `;
    wrap.appendChild(slot);

    const input = slot.querySelector('.referral-input');
    const dropdown = slot.querySelector('.referral-dropdown');
    const clearBtn = slot.querySelector('.referral-clear');

    input.addEventListener('input', () => updateReferralDropdown(i, input, dropdown, slot));
    input.addEventListener('focus', () => {
      if (!state.referralPicks[i]) updateReferralDropdown(i, input, dropdown, slot);
    });
    input.addEventListener('blur', () => {
      // delay so click on dropdown registers
      setTimeout(() => slot.classList.remove('open'), 150);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = dropdown.querySelectorAll('.referral-item');
        if (!items.length) return;
        let cur = dropdown.querySelector('.referral-item.highlight');
        if (cur) cur.classList.remove('highlight');
        const next = cur ? (cur.nextElementSibling || items[0]) : items[0];
        next.classList.add('highlight');
        next.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = dropdown.querySelectorAll('.referral-item');
        if (!items.length) return;
        let cur = dropdown.querySelector('.referral-item.highlight');
        if (cur) cur.classList.remove('highlight');
        const prev = cur ? (cur.previousElementSibling || items[items.length - 1]) : items[items.length - 1];
        prev.classList.add('highlight');
        prev.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const hl = dropdown.querySelector('.referral-item.highlight');
        if (hl && !hl.classList.contains('disabled')) {
          e.preventDefault();
          pickReferral(i, hl.dataset.email, hl.dataset.name);
        }
      } else if (e.key === 'Escape') {
        slot.classList.remove('open');
      }
    });

    clearBtn.addEventListener('click', () => {
      state.referralPicks[i] = null;
      renderReferralSlots();
    });
  }
  updateReferralsSubmitState();
}

function updateReferralDropdown(idx, input, dropdown, slot) {
  if (state.referralPicks[idx]) return;
  const q = input.value.toLowerCase().trim();
  const taken = new Set(state.referralPicks.filter(Boolean).map(p => p.email.toLowerCase()));
  let matches = state.directory;
  if (q) {
    matches = matches.filter(d =>
      d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q));
  }
  matches = matches.slice(0, 30);
  dropdown.innerHTML = '';
  if (matches.length === 0) {
    dropdown.innerHTML = '<div class="referral-empty">no matches</div>';
  } else {
    for (const d of matches) {
      const isTaken = taken.has(d.email.toLowerCase());
      const isClaimed = !!d.claimed;
      const isDisabled = isTaken || isClaimed;
      const item = document.createElement('div');
      let cls = 'referral-item';
      if (isClaimed) cls += ' on-platform';
      else if (isTaken) cls += ' disabled';
      item.className = cls;
      item.dataset.email = d.email;
      item.dataset.name = d.name;
      const claimedTag = isClaimed
        ? '<span class="claimed-tag">already on the platform</span>'
        : (isTaken ? '<span class="taken">already picked</span>' : '');
      item.innerHTML = `
        <span class="name">${escapeHtml(d.name)}</span>
        <span class="email">${escapeHtml(d.email)}${claimedTag ? ' · ' + claimedTag : ''}</span>
      `;
      if (!isDisabled) {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickReferral(idx, d.email, d.name);
        });
      } else {
        item.style.cursor = 'not-allowed';
      }
      dropdown.appendChild(item);
    }
  }
  slot.classList.add('open');
}

function pickReferral(idx, email, name) {
  state.referralPicks[idx] = { email, name };
  renderReferralSlots();
}

function updateReferralsSubmitState() {
  const ok = state.referralPicks.every(p => p && p.email);
  el('referrals-submit').disabled = !ok;
}

async function submitReferrals() {
  const errEl = el('referrals-error');
  errEl.classList.add('hidden');
  if (!state.referralPicks.every(p => p && p.email)) {
    errEl.textContent = 'pick all 3 friends';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = el('referrals-submit');
  btn.disabled = true;
  btn.textContent = 'sending invites…';
  try {
    const r = await api('POST', '/api/referrals', {
      referrals: state.referralPicks.map(p => ({ email: p.email }))
    });
    state.user = r.user;
    toast('invites sent — you are on the waitlist');
    showWaitlist();
  } catch (e) {
    if (e.status === 401) {
      // server forgot us (almost always: container redeployed and wiped data).
      // Kick back to signup w/ a clear message instead of leaving them on
      // a referrals screen with a useless red error.
      toast('your account was reset — please sign up again', 5000);
      tokenStore.clear(STORAGE_KEY);
      state.token = null;
      state.user = null;
      setTimeout(async () => { await showScreen('username-screen'); }, 600);
    } else {
      errEl.textContent = e.data?.error || 'something broke';
      errEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send invites + go to waitlist →';
    updateReferralsSubmitState();
  }
}

// =================================================================
// WAITLIST SCREEN
// =================================================================
function setupWaitlist() {
  el('waitlist-refresh').addEventListener('click', checkWaitlistNow);
  el('waitlist-logout').addEventListener('click', logout);
}

async function showWaitlist() {
  await showScreen('waitlist-screen');
  el('waitlist-name').textContent = state.user?.name || '';
  el('waitlist-email').textContent = state.user?.email || '';
  if (state.waitlistInterval) clearInterval(state.waitlistInterval);
  state.waitlistInterval = setInterval(checkWaitlistNow, 8000);
}

async function checkWaitlistNow() {
  try {
    const r = await api('POST', '/api/whoami', { token: state.token });
    state.user = r.user;
    if (r.user.status === 'active') {
      if (state.waitlistInterval) clearInterval(state.waitlistInterval);
      state.waitlistInterval = null;
      toast('approved! welcome in.');
      await connectAndShowFeed();
    } else if (r.user.status === 'banned') {
      toast('account banned');
      logout();
    } else if (r.user.status === 'awaiting-referrals') {
      // shouldn't happen from waitlist screen but be safe
      await showReferrals();
    }
  } catch (e) {
    // Only force logout on a definite "unknown token" reply — transient
    // 5xx / network errors keep the user signed in.
    if (e.status === 401 || e.status === 403) logout();
  }
}

function logout() {
  if (state.waitlistInterval) clearInterval(state.waitlistInterval);
  state.waitlistInterval = null;
  if (state.socket) try { state.socket.disconnect(); } catch {}
  state.token = null;
  state.user = null;
  tokenStore.clear(STORAGE_KEY);
  window.location.hash = '';
  endCurrentChatSilent();
  showScreen('username-screen', false);
  el('signup-name').focus();
}

// =================================================================
// CAMERA / MIC (deferred until video chat)
// =================================================================
async function ensureCamera() {
  if (state.localStream) {
    const tracks = state.localStream.getTracks();
    if (tracks.length && tracks.every(t => t.readyState === 'live')) return true;
    state.localStream = null;
  }
  toast('requesting camera + mic…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    state.localStream = stream;
    return true;
  } catch (err) {
    toast('camera/mic denied — allow it in browser settings');
    return false;
  }
}
function stopCamera() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
}

// =================================================================
// SOCKET CONNECTION + FEED LOAD
// =================================================================
async function connectAndShowFeed() {
  await connectSocket();
  await goToFeed();
}

async function connectSocket() {
  return new Promise((resolve, reject) => {
    state.socket = io({ transports: ['websocket', 'polling'] });
    let settled = false;
    const settle = (fn, val) => { if (settled) return; settled = true; fn(val); };
    state.socket.on('connect', () => {
      state.socket.emit('register', { token: state.token, username: state.user?.name });
    });
    state.socket.on('registered', ({ socketId }) => {
      state.socketId = socketId;
      clearTimeout(connectTimer);
      settle(resolve);
    });
    state.socket.on('register-failed', ({ reason }) => {
      clearTimeout(connectTimer);
      settle(reject, new Error('register failed: ' + reason));
      if (reason === 'banned' || reason === 'unknown') logout();
    });
    state.socket.on('online-count', (count) => {
      const c = el('online-counter'); if (c) c.textContent = count;
      const big = el('online-count-large'); if (big) big.textContent = count + ' online';
      const sn = el('subnav-online'); if (sn) sn.textContent = count;
      // Live meter at top of left rail (index.html widget)
      const oc = el('oc-num'); if (oc) {
        oc.textContent = count;
        const lbl = el('oc-label'); if (lbl) lbl.textContent = (count === 1 ? 'member online' : 'members online');
      }
      if (state.siteInfo) state.siteInfo.onlineCount = count;
    });
    state.socket.on('online-users', renderOnlineUsers);
    state.socket.on('post-added', onPostAdded);
    state.socket.on('post-voted', onPostVoted);
    state.socket.on('post-commented', onPostCommented);
    state.socket.on('post-deleted', onPostDeleted);
    state.socket.on('comment-deleted', onCommentDeleted);
    state.socket.on('rooms-list', renderLobbiesList);
    state.socket.on('notif', onIncomingNotif);
    state.socket.on('live-activity', onLiveActivity);
    state.socket.on('post-view-count', onPostViewCount);
    state.socket.on('post-readers-count', onPostReadersCount);
    state.socket.on('dm-typing', onDmTyping);
    state.socket.on('dm-stop-typing', onDmStopTyping);
    state.socket.on('random-chat-locked', ({ reason }) => toast(reason || 'omegle locked'));
    state.socket.on('ephemeral-cleanup', ({ removed }) => {
      if (removed) loadPosts();
    });
    state.socket.on('user-timed-out', (info) => {
      if (!state.user || !info) return;
      if ((state.user.email || '').toLowerCase() === (info.email || '').toLowerCase()) {
        state.user.timeoutUntil = info.timeoutUntil;
        state.user.timeoutReason = info.reason || '';
        refreshTimeoutOverlay();
      }
    });
    state.socket.on('admin-warning', (warning) => {
      if (state.user) state.user.adminWarning = warning;
      showAdminWarning(warning);
    });
    state.socket.on('user-untimed-out', (info) => {
      if (!state.user || !info) return;
      if ((state.user.email || '').toLowerCase() === (info.email || '').toLowerCase()) {
        state.user.timeoutUntil = 0;
        state.user.timeoutReason = '';
        refreshTimeoutOverlay();
      }
    });

    setupRandomChatHandlers();
    setupRoomHandlers();
    setupWebRTCHandlers();
    setupLooksMax();
    initPostViewObserver();
    state.socket.on('chat-message', onChatMessage);
    state.socket.on('dm-message', onIncomingDm);
    state.socket.on('dm-read', ({ ids }) => applyDmRead(ids));
    state.socket.on('group-message', onIncomingGroupMessage);
    state.socket.on('group-created', () => { refreshInboxBadge(); });
    state.socket.on('friend-request-incoming', () => loadFriendRequests());
    state.socket.on('friend-added', async () => {
      // refresh the user record so friends list updates
      try { const me = await api('POST', '/api/whoami'); if (me && me.user) state.user = { ...state.user, ...me.user }; } catch {}
      loadFriendRequests();
    });

    const connectTimer = setTimeout(() => settle(reject, new Error('socket connect timeout')), 8000);
  }).catch((e) => {
    console.error('socket failed:', e);
    const lt = el('loading-tip');
    if (lt) lt.textContent = 'connection failed — refresh the page';
    toast('connection failed — refresh');
    throw e;
  });
}

async function goToFeed() {
  await showScreen('board-screen');
  syncProfileSidebar();
  syncStreakPill();

  try {
    const info = await fetch('/api/site-info').then(r => r.json());
    // Member count intentionally NOT displayed publicly (per product spec —
    // exposing the live count gives away that the platform is small).
    const sm = el('subnav-members'); if (sm) sm.textContent = '';
  } catch {}

  // Grab lastVisit BEFORE we update it — this is what we pass to the digest.
  // Use a SEPARATE key for "last time we showed the FOMO splash" so refreshing
  // the page doesn't reset the gone-while-away timer.
  const lastVisit = parseInt(localStorage.getItem(LAST_VISIT_KEY) || '0');
  state.lastVisit = lastVisit;
  // Update lastVisit only after we've actually been here for a while —
  // a 2-second refresh doesn't count as a new visit.
  const FOMO_REFRESH_GAP = 5 * 60 * 1000; // 5 minutes
  if (Date.now() - lastVisit > FOMO_REFRESH_GAP) {
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  }

  // Show "X new posts since last visit" banner (legacy, still shown for quick glance)
  if (lastVisit > 0) {
    try {
      const r = await api('GET', `/api/posts-since/${lastVisit}`);
      if (r.count > 0) {
        el('return-banner-count').textContent = r.count;
        el('return-banner').classList.remove('hidden');
      }
    } catch {}
  }

  // load notifications + feature status
  await refreshNotifications();
  await refreshFeatureStatus();

  // FOMO digest — only show if they've been here before (lastVisit > 0)
  // and something interesting happened while they were away
  if (lastVisit > 0) {
    try {
      const digest = await api('GET', `/api/me/digest?since=${lastVisit}`);
      // Streak break guilt toast (fires before digest splash)
      if (digest.streakBrokeAt && digest.prevStreak > 1) {
        setTimeout(() => {
          toast(`💔 Your ${digest.prevStreak}-day streak broke. Start a new one today.`, 6000);
        }, 600);
      }
      // Show FOMO splash if there's anything to report
      const hasActivity = digest.newPostCount > 0 || digest.unreadDmCount > 0 ||
                          digest.unreadNotifCount > 0 || digest.profileViewCount > 0;
      if (hasActivity) {
        showFomoSplash(digest);
      }
    } catch (e) { console.warn('digest fetch failed', e); }
  }

  await loadPosts();

  // Load sidebar widgets (non-blocking, in parallel)
  loadLeaderboard();
  loadProfileViewsBadge();
  loadVanityWidget();
  loadUninvitedFriends();
  loadDirectoryForMentions();
  loadWhoViewedMeMost();
  loadBulletins();
  loadBlogs();
  loadFriendRequests();
  loadQotd();
  loadLateNight();
  loadRoyalty();
  loadStreakStatus();
  loadPeopleYouMayKnow();
  loadCompletenessBar();
  loadFeaturePromo();
  loadActiveAd();
  setInterval(loadActiveAd, 60 * 1000);
  initSiteTheme();
  loadAnnouncements();
  setInterval(loadAnnouncements, 60 * 1000);
  // Force-show TOS agreement if the user hasn't accepted the current version.
  setTimeout(maybeShowTosModal, 400);
  setTimeout(maybeShowGradePrompt, 900);
  setTimeout(checkWhileAwayDigest, 1400);
  // (Personal email onboarding is disabled — see maybeShowPersonalEmailOnboarding.)
  setTimeout(maybeShowPersonalEmailOnboarding, 800);
  wireHelloBlockLinks();
  loadThrowback();
  loadVagueStat();
  wireWallTyping();
  refreshHelloViewsCount();
  startAttentionHeartbeat();
  maybeAskForNotificationPermission();
  // Live updates on the Hello block stats every 30s
  setInterval(loadPeopleYouMayKnow, 5 * 60 * 1000);
  setInterval(loadFeaturePromo, 90 * 1000);
  setInterval(loadThrowback, 60 * 60 * 1000); // hourly
  setInterval(loadVagueStat, 10 * 60 * 1000);
  setInterval(refreshHelloViewsCount, 60 * 1000);
  // Onboarding priority: server-flagged forced tour (post-approval) >
  // localStorage signup flag > what's-new banner.
  setTimeout(() => {
    if (state.user && state.user.needsOnboarding) {
      runForcedTour();
      return;
    }
    const flag = localStorage.getItem('needs-onboarding');
    if (flag) {
      localStorage.removeItem('needs-onboarding');
      runOnboarding({ fromCrush: flag === 'crush' });
    } else {
      maybeShowWhatsNew();
    }
  }, 1200);
  // Refresh cadences
  setInterval(loadFriendRequests, 60 * 1000);
  setInterval(loadBlogs, 5 * 60 * 1000);
  setInterval(loadQotd, 2 * 60 * 1000);
  setInterval(loadLateNight, 60 * 1000);
  setInterval(loadStreakStatus, 5 * 60 * 1000);

  // Handle URL hash route
  const hash = window.location.hash;
  if (hash && hash.startsWith('#room=')) {
    const roomId = hash.slice(6);
    setTimeout(() => { toast('joining room from link…'); joinRoom(roomId); }, 500);
  } else if (hash && hash.startsWith('#lobby=')) {
    const roomId = hash.slice(7);
    setTimeout(() => { toast('joining room from link…'); joinRoom(roomId); }, 500);
  } else {
    handleHashRoute();
  }
}

// =================================================================
// FOMO SPLASH
// =================================================================
function showFomoSplash(digest) {
  const items = el('fomo-items');
  if (!items) return;
  items.innerHTML = '';

  const add = (num, label) => {
    const div = document.createElement('div');
    div.className = 'fomo-item';
    div.innerHTML = `<span class="fi-num">${num}</span><span class="fi-label">${label}</span>`;
    items.appendChild(div);
  };

  if (digest.newPostCount > 0) {
    add(digest.newPostCount, `new <strong>${digest.newPostCount === 1 ? 'post' : 'posts'}</strong> on the wall`);
  }
  if (digest.unreadDmCount > 0) {
    add(digest.unreadDmCount, `unread <strong>direct ${digest.unreadDmCount === 1 ? 'message' : 'messages'}</strong>`);
  }
  if (digest.unreadNotifCount > 0) {
    add(digest.unreadNotifCount, `<strong>${digest.unreadNotifCount === 1 ? 'notification' : 'notifications'}</strong> — someone mentioned you`);
  }
  if (digest.profileViewCount > 0) {
    add(digest.profileViewCount, `<strong>${digest.profileViewCount === 1 ? 'person' : 'people'}</strong> checked your profile this week`);
  }
  if (Array.isArray(digest.friendActivity) && digest.friendActivity.length > 0) {
    const names = digest.friendActivity.slice(0, 2).map(f => `<strong>${escapeHtml(f.name)}</strong>`).join(', ');
    const extra = digest.friendActivity.length > 2 ? ` and ${digest.friendActivity.length - 2} others` : '';
    add('', `${names}${extra} posted while you were gone`);
  }

  // Below-average framing: benchmark anchored at 65th percentile so
  // average users always feel slightly behind "most active members."
  const stats = digest.activityStats;
  if (stats && stats.myPostsThisWeek !== undefined && stats.benchmark > 0) {
    if (stats.myPostsThisWeek < stats.benchmark) {
      add(stats.myPostsThisWeek, `posts this week — most active members post <strong>${stats.benchmark}+</strong>`);
    }
  }

  if (items.children.length === 0) return; // nothing to show
  el('fomo-splash').classList.remove('hidden');
  el('fomo-dismiss').onclick = () => el('fomo-splash').classList.add('hidden');
}

// =================================================================
// LEADERBOARD SIDEBAR
// =================================================================
async function loadLeaderboard() {
  try {
    const data = await api('GET', '/api/leaderboard');
    if (!Array.isArray(data) || data.length === 0) return;
    const box = el('leaderboard-box');
    const list = el('leaderboard-list');
    if (!box || !list) return;
    list.innerHTML = '';
    const medals = ['🥇','🥈','🥉','',''];
    data.forEach((entry, i) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-medal">${medals[i] || ''}</span>
        <span class="lb-name ${entry.isMe ? 'is-me' : ''}" data-email="${escapeHtml(entry.email)}">${escapeHtml(entry.name)}${entry.isMe ? ' (you)' : ''}</span>
        <span class="lb-pts">${entry.pts}pt${entry.decayed ? ' <span class="lb-decay" title="score decaying — post something">↘</span>' : ''}</span>
      `;
      const nameEl = li.querySelector('.lb-name');
      // Always navigate to a profile (stub if not joined). Phantoms get the
      // "hasn't joined yet" stub page with crush + invite buttons.
      if (!entry.isMe && entry.email) {
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', () => navigateToProfile(entry.email));
      }
      list.appendChild(li);
    });
    box.style.display = '';
  } catch (e) { console.warn('leaderboard fetch failed', e); }
}

// =================================================================
// PROFILE VIEWS SIDEBAR BADGE
// =================================================================
async function loadProfileViewsBadge() {
  try {
    const digest = await api('GET', `/api/me/digest?since=${Date.now() - 7 * 24 * 60 * 60 * 1000}`);
    const count = digest.profileViewCount || 0;
    const box = el('profile-views-box');
    const countEl = el('profile-views-count');
    if (!box || !countEl || count === 0) return;
    countEl.textContent = count;
    if (count > 0) {
      const names = el('profile-views-names');
      if (names) names.textContent = count === 1 ? 'tap your profile to see who' : 'tap your profile name to see who';
    }
    box.style.display = '';
  } catch (e) { /* quiet fail */ }
}

// =================================================================
// VANITY WIDGET — inflated social proof in sidebar
// =================================================================
async function loadVanityWidget() {
  try {
    const v = await api('GET', '/api/me/vanity');
    const box = el('vanity-box');
    const body = el('vanity-body');
    if (!box || !body) return;

    const lines = [];

    if (v.profileViewCount > 0) {
      lines.push(`
        <div class="vanity-line">
          <span class="vanity-num">${v.profileViewCount}</span>
          <span class="vanity-label">people viewed your profile this week</span>
        </div>
        <div style="font-size:10px; color:var(--good); padding-bottom:4px;">
          your profile is in the <strong>top ${v.profileViewPercentile}%</strong> most visited
        </div>
      `);
    }

    if (v.postCount > 0 && v.engagementMultiplier > 1) {
      lines.push(`
        <div class="vanity-line" style="margin-top:4px;">
          <span class="vanity-num">${v.engagementMultiplier}×</span>
          <span class="vanity-label">more reactions than average on your posts</span>
        </div>
      `);
    }

    if (lines.length === 0) return;
    body.innerHTML = lines.join('');
    box.style.display = '';
  } catch (e) { /* quiet fail */ }
}

// =================================================================
// UNINVITED FRIENDS — guilt-trip people whose referrals haven't joined
// =================================================================
async function loadUninvitedFriends() {
  try {
    const v = await api('GET', '/api/me/vanity');
    const uninvited = v.uninvitedReferrals || [];
    if (uninvited.length === 0) return;
    const box = el('uninvited-box');
    const body = el('uninvited-body');
    if (!box || !body) return;

    body.innerHTML = `
      <p style="font-size:10px; color:var(--text-3); margin-bottom:6px;">
        ${uninvited.length === 1 ? 'This person' : 'These people'} you invited haven't joined yet.
        They're missing out on everything being said about them.
      </p>
    `;
    for (const r of uninvited) {
      const item = document.createElement('div');
      item.className = 'uninvited-item';
      item.innerHTML = `
        <span class="uninvited-name">${escapeHtml(r.name.split(' ')[0])}</span>
        <span class="uninvited-cta" title="remind ${escapeHtml(r.name.split(' ')[0])}">remind them →</span>
      `;
      // "Remind them" — copies a pre-drafted invite message to clipboard
      item.querySelector('.uninvited-cta').addEventListener('click', async () => {
        const msg = `hey ${r.name.split(' ')[0]}, you should get on Old Streets (it's a students-only thing at school). people are already talking — sign up at ${window.location.origin}`;
        try { await navigator.clipboard.writeText(msg); toast(`copied invite for ${r.name.split(' ')[0]} — paste it!`, 4000); }
        catch { toast(msg, 8000); }
      });
      body.appendChild(item);
    }
    box.style.display = '';
  } catch (e) { /* quiet fail */ }
}

function syncProfileSidebar() {
  const u = state.user;
  if (!u) return;
  el('topbar-username').textContent = u.name;
  const subnavU = el('subnav-username'); if (subnavU) subnavU.textContent = u.name;
  const welcomeName = el('welcome-name'); if (welcomeName) welcomeName.textContent = u.name;
  const composeName = el('compose-name'); if (composeName) composeName.textContent = u.name;
  // MySpace "Hello, name!" banner
  const helloName = el('ms-hello-name'); if (helloName) helloName.textContent = u.name.split(' ')[0];
  const vanityHandle = el('ms-vanity-handle');
  if (vanityHandle) vanityHandle.textContent = u.vanityUrl || u.email.split('@')[0];
  const helloDate = el('ms-hello-date');
  if (helloDate) {
    const d = new Date();
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const hr = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = hr < 12 ? 'AM' : 'PM';
    const hr12 = ((hr + 11) % 12) + 1;
    helloDate.textContent = `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hr12}:${m} ${ampm}`;
  }
  // Side profile column stats
  const sideViews = el('ms-side-views'); if (sideViews) sideViews.textContent = u.profileViewCount || 0;
  const sideLastLogin = el('ms-side-last-login');
  if (sideLastLogin) sideLastLogin.textContent = u.lastSeen ? formatDate(u.lastSeen) : 'just now';
  // photo: avatar img if present, else initial letter
  const photo = el('profile-photo');
  if (photo) {
    if (u.avatar) {
      photo.innerHTML = `<img src="${u.avatar}" alt=""/>`;
    } else {
      photo.textContent = (u.name[0] || '?').toUpperCase();
    }
  }
  el('profile-name').textContent = u.name;
  const emailInfo = el('profile-email-info'); if (emailInfo) emailInfo.textContent = u.email;
  el('profile-member-since').textContent = formatDate(u.approvedAt || u.createdAt);
  const bioDisp = el('profile-bio-display');
  if (bioDisp) {
    if (u.bio && u.bio.trim()) bioDisp.textContent = u.bio;
    else bioDisp.innerHTML = '<em style="color:var(--text-3)">none yet — click edit profile</em>';
  }
}

// =================================================================
// PROFILE COMPLETENESS BAR — the bar that never quite hits 100%.
// The last few % require milestones most users won't reach. It nags.
// =================================================================
async function loadCompletenessBar() {
  const wrap = el('completeness-wrap');
  if (!wrap) return;
  try {
    const data = await api('GET', '/api/me/completeness');
    const pct = data.pct || 0;
    const incomplete = (data.tasks || []).filter(t => !t.done);
    const nextTask = incomplete[0];
    wrap.innerHTML = `
      <div class="completeness-label">profile ${pct}% complete${pct < 100 ? ' — <em>' + (nextTask ? nextTask.label : 'almost there') + '</em>' : ' ✓'}</div>
      <div class="completeness-track"><div class="completeness-fill" style="width:${pct}%"></div></div>
    `;
    wrap.style.display = pct >= 100 ? 'none' : '';
  } catch {}
}

// =================================================================
// SESSION EXTENSION HOOK — fires when the user switches away from
// the tab. If they return within 12s, show "you missed X new posts"
// with a slightly inflated count. Loss aversion keeps them scrolling.
// =================================================================
(function setupSessionExtensionHook() {
  let hiddenAt = 0;
  let extensionFired = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      extensionFired = false;
    } else {
      if (!hiddenAt || extensionFired) return;
      const awayMs = Date.now() - hiddenAt;
      hiddenAt = 0;
      if (awayMs < 3000 || awayMs > 12000) return; // only very short tab-switches
      extensionFired = true;
      // Count new posts since page load and inflate by 1-3
      const since = state.lastVisit || (Date.now() - 30 * 60 * 1000);
      fetch(`/api/posts-since/${since}`, {
        headers: { 'x-user-token': getToken() || '' }
      }).then(r => r.json()).then(d => {
        const raw = d.count || 0;
        const inflated = raw + 1 + Math.floor(Math.random() * 3);
        if (inflated >= 2) {
          toast(`${inflated} new posts since you arrived — keep scrolling`, 5000);
        }
      }).catch(() => {});
    }
  });
})();

// =================================================================
// VIEW SWITCHING (wall / post / profile)
// =================================================================
function setupHashRouting() {
  window.addEventListener('hashchange', () => handleHashRoute());
}

function handleHashRoute() {
  if (!state.user || state.user.status !== 'active') return;
  const hash = window.location.hash || '';
  if (hash.startsWith('#post=')) {
    const id = decodeURIComponent(hash.slice(6));
    showPostView(id);
  } else if (hash.startsWith('#user=')) {
    const email = decodeURIComponent(hash.slice(6));
    showProfileView(email);
  } else if (hash.startsWith('#room=') || hash.startsWith('#lobby=')) {
    // handled elsewhere; show wall in background
    setView('wall');
  } else if (hash.startsWith('#crush=')) {
    const letterId = decodeURIComponent(hash.slice(7));
    setView('wall');
    openCrushPick3Modal(letterId);
  } else if (hash === '#loveletter' || hash === '#love-letter') {
    setView('wall');
    openLoveLetterModal();
  } else if (hash === '#friends') {
    openFriendsView();
  } else if (hash === '#daily' || hash === '#qotd') {
    openDailyView();
  } else if (hash === '#night' || hash === '#late-night') {
    openNightView();
  } else {
    setView('wall');
  }
  // scroll main to top on view change
  const main = document.querySelector('.fb-main');
  if (main) main.scrollTop = 0;
}

function setView(name) {
  state.view = name;
  document.querySelectorAll('.fb-main > .view').forEach(v => v.classList.add('hidden'));
  const target = document.querySelector(`.fb-main > .view-${name}`);
  if (target) target.classList.remove('hidden');
  // Broadcast presence-activity
  const map = {
    wall: { kind: 'browsing', label: 'browsing the wall' },
    profile: { kind: 'profile', label: 'on a profile', ref: state.viewingProfile || '' },
    'love-letter': { kind: 'love-letter', label: 'writing a love letter' },
    friends: { kind: 'friends', label: 'in friends' },
    daily: { kind: 'qotd', label: 'on Question of the Day' },
    night: { kind: 'night', label: 'in late-night thoughts' },
  };
  broadcastActivity(map[name] || { kind: 'browsing', label: 'just browsing' });
}

// Throttle so a fast typist doesn't fire 20 events/sec. We were causing
// the whole feed to flash on every keystroke because the server rebroadcasts
// online-users and renderOnlineUsers used to re-render the feed.
let _lastActivityAt = 0;
let _lastActivityKey = '';
function broadcastActivity(act) {
  try {
    if (!state.socket || !state.socket.connected) return;
    const key = (act && act.kind || '') + '|' + (act && act.ref || '');
    const now = Date.now();
    // Same activity-kind firing again? Send at most once every 3s.
    if (key === _lastActivityKey && now - _lastActivityAt < 3000) return;
    _lastActivityAt = now;
    _lastActivityKey = key;
    state.socket.emit('activity', act);
  } catch {}
}

function navigateToPost(postId) {
  // Full-page post detail view at /post.html?id=…
  window.location.href = '/post.html?id=' + encodeURIComponent(postId);
}
function navigateToProfile(email) {
  window.location.hash = '#user=' + encodeURIComponent(email);
}
function navigateToWall() {
  if (window.location.hash) window.location.hash = '';
  else setView('wall');
}

async function showPostView(postId) {
  setView('post');
  const wrap = el('post-view-content');
  wrap.innerHTML = '<div style="padding:30px; text-align:center; color:var(--text-3); font-size:11px;">Loading post…</div>';
  let post = state.posts.find(p => p.id === postId);
  if (!post) {
    try {
      post = await api('GET', `/api/posts/${encodeURIComponent(postId)}`);
    } catch (e) {
      wrap.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-3); font-size:12px;"><strong>Post not found.</strong><br/>It may have been deleted.</div>';
      return;
    }
  }
  renderPostDetail(wrap, post);
}

function renderPostDetail(wrap, post) {
  wrap.innerHTML = '';
  const node = document.createElement('div');
  node.className = 'post-detail';
  node.dataset.id = post.id;

  const myEmail = state.user?.email || '';
  const reactions = post.reactions || {};
  const myReaction = REACTIONS.find(e => reactions[e] && reactions[e][myEmail]) || null;
  const anyReactions = REACTIONS.some(e => reactions[e] && Object.keys(reactions[e]).length > 0);
  const reactionsHtml = REACTIONS.map(e => {
    const count = reactions[e] ? Object.keys(reactions[e]).length : 0;
    if (!anyReactions || count > 0 || myReaction === e) {
      return `<button class="react-btn ${myReaction === e ? 'active' : ''}" data-emoji="${e}" title="${e}">${e} <span class="react-count">${count}</span></button>`;
    }
    return '';
  }).filter(Boolean).join('');
  const myReported = (post.reports || []).some(r => r.reporterEmail === myEmail);

  let mediaHtml = '';
  if (post.type === 'image') mediaHtml = `<div class="post-detail-media"><img src="${post.content}" alt=""/></div>`;
  else if (post.type === 'video') mediaHtml = `<div class="post-detail-media"><video src="${post.content}" controls playsinline></video></div>`;
  let repostHtml = '';
  if (post.repostOf) {
    try { repostHtml = buildRepostCardHTML(post.repostOf); } catch {}
  }
  else if (post.type === 'survey') {
    ensureSurveyTemplates().catch(() => {});
    mediaHtml = `<div class="post-detail-survey">${renderSurveyContent(post)}</div>`;
  }

  const captionText = post.type === 'text' ? (post.content || '') : (post.type === 'survey' ? '' : (post.caption || ''));

  const detailIsAnon = !!post.isAnonymous;
  node.innerHTML = `
    <div class="post-detail-header">
      <span class="post-detail-author ${detailIsAnon ? 'anon' : ''}" data-email="${detailIsAnon ? '' : escapeHtml(post.authorEmail)}">${detailIsAnon ? 'anonymous' : escapeHtml(post.author)}</span>
      ${detailIsAnon ? '<span class="anon-tag">🥷 anonymous</span>' : ''}
      <span class="post-detail-time">${escapeHtml(formatDate(post.createdAt))} · ${timeAgo(post.createdAt)}</span>
      <span class="post-detail-num">post ${post.id.split('-')[0]}</span>
    </div>
    ${post.repostOf
      ? `${captionText ? `<div class="post-detail-caption post-caption-quote">${linkify(escapeHtml(captionText))}</div>` : ''}${renderSpotifyEmbed(captionText)}${repostHtml}`
      : `${mediaHtml}${captionText ? `<div class="post-detail-caption">${linkify(escapeHtml(captionText))}</div>` : ''}${renderSpotifyEmbed(captionText)}`}
    <div class="post-detail-actions">
      <span class="reaction-row">${reactionsHtml}</span>
      <button class="report-btn ${myReported ? 'reported' : ''}">⚐ ${myReported ? 'reported' : 'report'}</button>
      <button class="permalink-btn" id="copy-permalink-btn">copy link</button>
      <button class="repost-btn detail-repost-btn">🔁 repost</button>
      ${(() => {
        const isPinned = (state.user?.pinnedPosts || []).includes(post.id);
        return `<button class="pin-profile-btn ${isPinned ? 'pinned' : ''}" title="${isPinned ? 'unpin from your profile' : 'pin to your profile'}">📌${isPinned ? ' pinned' : ''}</button>`;
      })()}
      ${post.isMine ? `<button class="delete-post-btn">🗑 delete</button>` : ''}
      <span class="post-spacer"></span>
    </div>
    <div class="post-detail-comments-header">comments (${(post.comments || []).length})</div>
    <div class="comments-list" id="post-detail-comments"></div>
    <div class="comment-input-row" style="margin-top:10px;">
      <input type="text" class="scribble-input comment-input" placeholder="say something..." maxlength="400"/>
      <label class="comment-anon-label" title="post this comment anonymously"><input type="checkbox" class="comment-anon"/>🥷</label>
      <button class="scribble-button comment-send">send</button>
    </div>
  `;
  wrap.appendChild(node);

  // Wire delete button (detail view only)
  const delBtn = node.querySelector('.delete-post-btn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('delete this post permanently?')) return;
    try {
      await api('DELETE', `/api/posts/${encodeURIComponent(post.id)}`);
      state.posts = state.posts.filter(p => p.id !== post.id);
      toast('post deleted');
      // Return to wall
      location.hash = '';
    } catch (e) { toast('delete failed: ' + (e.data?.error || 'unknown')); }
  });

  // wire reactions (full emoji set, same as feed card)
  node.querySelectorAll('.react-btn').forEach(btn => {
    btn.addEventListener('click', () => reactToPost(post.id, btn.dataset.emoji));
  });
  // report
  node.querySelector('.report-btn').addEventListener('click', () => openReportModal(post.id));
  // copy permalink
  node.querySelector('#copy-permalink-btn').addEventListener('click', async () => {
    const link = `${window.location.origin}/#post=${encodeURIComponent(post.id)}`;
    try { await navigator.clipboard.writeText(link); toast('link copied'); }
    catch { toast(link, 4000); }
  });
  // repost (detail view)
  const detailRepostBtn = node.querySelector('.detail-repost-btn');
  if (detailRepostBtn) detailRepostBtn.addEventListener('click', () => openRepostModal(post));

  // pin to profile (detail view)
  const detailPinBtn = node.querySelector('.pin-profile-btn');
  if (detailPinBtn) detailPinBtn.addEventListener('click', async () => {
    const wasPinned = detailPinBtn.classList.contains('pinned');
    detailPinBtn.disabled = true;
    try {
      if (wasPinned) {
        await api('DELETE', `/api/me/pinned-posts/${encodeURIComponent(post.id)}`);
        if (state.user) state.user.pinnedPosts = (state.user.pinnedPosts || []).filter(id => id !== post.id);
        detailPinBtn.classList.remove('pinned');
        detailPinBtn.innerHTML = '📌';
        toast('unpinned from your profile');
      } else {
        await api('POST', `/api/me/pinned-posts/${encodeURIComponent(post.id)}`);
        if (state.user) {
          state.user.pinnedPosts = state.user.pinnedPosts || [];
          if (!state.user.pinnedPosts.includes(post.id)) state.user.pinnedPosts.unshift(post.id);
        }
        detailPinBtn.classList.add('pinned');
        detailPinBtn.innerHTML = '📌 pinned';
        toast('pinned to your profile 📌');
      }
    } catch (err) {
      toast('pin failed: ' + (err.data?.error || 'unknown'));
    } finally {
      detailPinBtn.disabled = false;
    }
  });
  // author click → profile (skipped for anonymous)
  const authorEl = node.querySelector('.post-detail-author');
  if (!detailIsAnon && post.authorEmail) {
    authorEl.addEventListener('click', () => navigateToProfile(post.authorEmail));
    authorEl.style.cursor = 'pointer';
  } else {
    authorEl.style.cursor = 'default';
    authorEl.style.textDecoration = 'none';
  }
  // comment send — uses the shared submitComment() so the detail view also
  // re-renders the list (was a race between socket + http response that
  // showed comments only on the second action).
  const cmtInput = node.querySelector('.comment-input');
  const cmtSend = node.querySelector('.comment-send');
  const cmtAnon = node.querySelector('.comment-anon');
  // The detail comment block in some templates doesn't include the anon
  // checkbox — make sure openComments is set so re-render fires.
  state.openComments.add(post.id);
  const sendCmt = () => {
    const text = cmtInput.value.trim();
    if (!text) return;
    const anon = !!cmtAnon?.checked;
    cmtInput.value = '';
    if (cmtAnon) cmtAnon.checked = false;
    submitComment(post.id, text, anon);
  };
  cmtSend.addEventListener('click', sendCmt);
  cmtInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendCmt(); } });

  // render comments
  const list = node.querySelector('#post-detail-comments');
  if ((post.comments || []).length === 0) {
    list.innerHTML = '<div class="comment-empty">no comments yet — say something!</div>';
  } else {
    for (const c of post.comments) list.appendChild(renderComment(c, post.id));
  }
}

async function showProfileView(email) {
  setView('profile');
  const wrap = el('profile-view-content');
  wrap.innerHTML = '<div style="padding:30px; text-align:center; color:var(--text-3); font-size:11px;">Loading profile…</div>';
  try {
    const profile = await api('GET', `/api/users/profile/${encodeURIComponent(email)}`);
    renderProfileDetail(wrap, profile);
  } catch (e) {
    // If we tried to view OUR OWN profile and it's gone, our account was
    // deleted server-side. Log us out cleanly instead of showing a stale state.
    if (state.user && email.toLowerCase() === state.user.email.toLowerCase()
        && (e.status === 404 || e.status === 401)) {
      toast('your account no longer exists — signing out');
      setTimeout(logout, 1200);
      return;
    }
    wrap.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-3); font-size:12px;"><strong>Profile not found.</strong><br/>This person may have deleted their account.</div>';
  }
}

function renderProfileDetail(wrap, profile) {
  // STUB profile — directory entry that hasn't signed up yet
  if (profile.isStub) {
    return renderStubProfile(wrap, profile);
  }
  const isMe = profile.email === state.user.email;
  const userPosts = state.posts.filter(p => p.authorEmail === profile.email)
    .sort((a, b) => b.createdAt - a.createdAt);
  const cmtCount = state.posts.reduce((acc, p) =>
    acc + (p.comments || []).filter(c => c.authorEmail === profile.email).length, 0);
  if (!state.userAvatars) state.userAvatars = {};
  if (profile.avatar) state.userAvatars[profile.email] = profile.avatar;
  const photoHtml = profile.avatar
    ? `<img src="${profile.avatar}" alt=""/>`
    : escapeHtml((profile.name[0] || '?').toUpperCase());

  // Friendship status — server provides viewerSentFriendReq / viewerReceivedFriendReq
  const amFriend = (state.user.friends || []).map(e => e.toLowerCase()).includes(profile.email.toLowerCase());
  let friendBtn = '';
  if (!isMe) {
    if (amFriend) {
      friendBtn = `<button class="auth-btn secondary" disabled title="already friends">✓ Friends</button>`;
    } else if (profile.viewerSentFriendReq) {
      friendBtn = `<button class="auth-btn secondary" disabled title="they haven't accepted yet">✓ Friend request sent</button>`;
    } else if (profile.viewerReceivedFriendReq) {
      friendBtn = `<button class="auth-btn" id="profile-accept-friend" data-email="${escapeHtml(profile.email)}" title="they sent you a request — accept?">✓ Accept friend request</button>`;
    } else {
      friendBtn = `<button class="auth-btn" id="profile-add-friend" data-email="${escapeHtml(profile.email)}">＋ Add Friend</button>`;
    }
  }

  const isOnline = !!profile.online;
  const lastActiveTs = profile.lastVisitAt || profile.lastSeen || 0;
  const lastActiveAge = lastActiveTs ? Date.now() - lastActiveTs : Infinity;
  const lastSeenStr = isOnline ? '' :
    lastActiveAge < 60 * 60 * 1000   ? 'active today' :
    lastActiveAge < 24 * 60 * 60 * 1000 ? 'active today' :
    lastActiveTs ? `last seen ${timeAgo(lastActiveTs)}` : '';
  const visiblePosts = profile.visiblePostCount != null ? profile.visiblePostCount : userPosts.length;
  const streakHtml = profile.streak > 0 ? ` · 🔥 <strong>${profile.streak}</strong> day streak` : '';

  // Profile views are now PUBLIC — anyone can see who viewed this profile.
  let viewsHtml = '';
  if (profile.viewCount != null) {
    const viewersHtml = (profile.recentViewers || []).slice(0, 8).map(v =>
      `<a data-email="${escapeHtml(v.email)}">${escapeHtml(v.name || v.email)}</a>`
    ).join(', ') || '<em>no one yet</em>';
    viewsHtml = `
      <div class="profile-views-box">
        <span class="label">profile views (public)</span>
        <span class="count">${profile.viewCount}</span>
        <div class="viewer-list">recent: ${viewersHtml}</div>
      </div>
    `;
  }

  // Mood / headline
  const moodLine = profile.mood ? `<div class="profile-mood">🎭 mood: <strong>${escapeHtml(profile.mood)}</strong></div>` : '';
  const headlineLine = profile.headline ? `<div class="profile-headline">"${escapeHtml(profile.headline)}"</div>` : '';

  // Top 8 (MySpace classic)
  const top8Html = (profile.top8 && profile.top8.length > 0) ? `
    <div class="profile-detail-section profile-top8">
      <h3>${isMe ? 'My Top ' + profile.top8.length : profile.name.split(' ')[0] + "'s Top " + profile.top8.length}</h3>
      <div class="top8-grid">
        ${profile.top8.map((t, i) => `
          <div class="top8-cell" data-email="${escapeHtml(t.email)}" title="#${i+1} — ${escapeHtml(t.name)}">
            ${t.avatar ? `<img src="${t.avatar}" alt=""/>` : `<span class="top8-letter">${escapeHtml((t.name || '?')[0].toUpperCase())}</span>`}
            <div class="top8-name">${escapeHtml(t.name.split(' ')[0])}</div>
          </div>
        `).join('')}
      </div>
    </div>` : (isMe ? '<div class="profile-detail-section"><h3>My Top 8</h3><p style="font-size:11px; color:var(--text-3); padding:6px 4px;">pick your top 8 friends — <button class="header-link" id="profile-edit-top8" style="background:none; border:none; color:var(--fb-blue); text-decoration:underline; cursor:pointer;">edit</button></p></div>' : '');

  // About me / interests / heroes
  const aboutMeBlock = (profile.aboutMe || profile.interests || profile.heroes) ? `
    <div class="profile-detail-section profile-about">
      ${profile.aboutMe ? `<div class="about-block"><strong>About me:</strong><p>${linkify(escapeHtml(profile.aboutMe))}</p></div>` : ''}
      ${profile.interests ? `<div class="about-block"><strong>Interests:</strong><p>${linkify(escapeHtml(profile.interests))}</p></div>` : ''}
      ${profile.heroes ? `<div class="about-block"><strong>Heroes:</strong><p>${linkify(escapeHtml(profile.heroes))}</p></div>` : ''}
    </div>` : '';

  // Crush button on other people's profiles
  const crushBtn = !isMe ? `<button class="auth-btn" id="profile-crush-here" data-email="${escapeHtml(profile.email)}" title="send anonymous love letter">💌 Crush</button>` : '';

  wrap.innerHTML = `
    <div class="profile-detail">
      <div class="profile-detail-header">
        <div class="profile-detail-photo" style="position: relative;">
          ${photoHtml}
          ${isOnline ? '<span class="online-dot-tiny" style="width:14px; height:14px; bottom:6px; right:6px;"></span>' : ''}
        </div>
        <div class="profile-detail-info">
          <div class="profile-detail-name">${escapeHtml(profile.name)}</div>
          <div class="profile-detail-email">${escapeHtml(profile.email)} · Old Streets school ${isOnline ? '<span style="color: var(--good); font-weight: bold;">· online now</span>' : (lastSeenStr ? `· ${lastSeenStr}` : '')}</div>
          ${profile.bio ? `<div class="profile-detail-bio">"${escapeHtml(profile.bio)}"</div>` : '<div class="profile-detail-bio" style="color:var(--text-4);">no bio yet</div>'}
          <div class="profile-badges">
            ${profile.grade ? `<span class="profile-badge grade-badge">${profile.grade === 'alumni' ? '🎓 alumni' : `${profile.grade}th${profile.classOf ? ' · class of ' + profile.classOf : ''}`}</span>` : ''}
            ${profile.ogTier === 'founding-50' ? `<span class="profile-badge og-founding" title="signed up in the first week">✨ founding 50</span>` : ''}
            ${profile.ogTier === 'og' ? `<span class="profile-badge og-og" title="signed up in the first 2 months">⭐ OG</span>` : ''}
            ${profile.ogTier === 'vet' ? `<span class="profile-badge og-vet" title="1+ year on the platform">🪶 vet</span>` : ''}
            ${profile.ogTier === 'year-1' ? `<span class="profile-badge og-year1" title="year 1 member">🌱 year 1</span>` : ''}
            ${(profile.daysOnPlatform || 0) >= 1 ? `<span class="profile-badge days-badge" title="days on platform">${profile.daysOnPlatform}d here</span>` : ''}
          </div>
          ${moodLine}
          ${headlineLine}
          <div class="profile-detail-stats">
            <div><span class="num">${visiblePosts}</span>posts</div>
            <div><span class="num">${cmtCount}</span>comments</div>
            <div><span class="num">${profile.friendCount || 0}</span>friends</div>
            <div><span class="num">${formatDate(profile.joinedAt)}</span>joined</div>
          </div>
          <div style="font-size: 11px; color: var(--text-3); margin-top: 4px;">${streakHtml}</div>
          ${(profile.karmaScore != null) ? `<div class="karma-block karma-tier-${profile.karmaTier || 'rookie'}"><span class="karma-score-num">${profile.karmaScore}</span><span class="karma-tier-label">${profile.karmaLabel || 'Rookie'}</span><span class="karma-tag-text">lifetime karma</span></div>` : ''}
          <div style="margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap;">
            ${isMe
              ? '<button class="auth-btn" id="profile-edit-here">Edit profile</button>'
              : `<button class="auth-btn" id="profile-message-here" data-email="${escapeHtml(profile.email)}">💬 Message</button>`}
            ${friendBtn}
            ${crushBtn}
          </div>
          ${viewsHtml}
        </div>
      </div>
      ${isMe ? '<div id="profile-secret-admirers-host" class="hidden"></div>' : ''}
      ${aboutMeBlock}
      ${top8Html}
      <div class="profile-detail-section">
        <h3>Comments</h3>
        <div id="profile-board"></div>
      </div>
      ${(profile.pinnedPosts && profile.pinnedPosts.length > 0) ? `
      <div class="profile-detail-section profile-pinned">
        <h3>📌 ${isMe ? 'Your pinned posts' : 'Pinned by ' + profile.name.split(' ')[0]}</h3>
        <div class="pinned-posts-grid">
          ${profile.pinnedPosts.map(p => {
            const isImg = p.type === 'image';
            const isVid = p.type === 'video';
            const isGif = p.type === 'gif';
            const media = isImg ? `<img src="${escapeAttr(p.content)}" alt=""/>`
                       : isVid ? `<video src="${escapeAttr(p.content)}" muted playsinline></video>`
                       : isGif ? `<img src="${escapeAttr(p.content)}" alt=""/>`
                       : `<div class="pinned-text">${escapeHtml((p.content || p.caption || '').slice(0, 180))}</div>`;
            const authorLabel = p.isAnonymous ? 'anonymous' : escapeHtml(p.author || '');
            return `
              <div class="pinned-post-card" data-post-id="${escapeAttr(p.id)}">
                ${media}
                ${p.caption && (isImg || isVid || isGif) ? `<div class="pinned-caption">${escapeHtml(p.caption.slice(0, 80))}</div>` : ''}
                <div class="pinned-meta">— ${authorLabel}</div>
                ${isMe ? `<button class="pinned-unpin-btn" data-post-id="${escapeAttr(p.id)}" title="unpin">×</button>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>` : (isMe ? `
      <div class="profile-detail-section">
        <h3>📌 Pinned posts</h3>
        <p style="font-size:11px; color:var(--text-3); padding:6px 4px;">tap the 📌 on any post to pin it here (up to 6).</p>
      </div>` : '')}
      <div class="profile-detail-section">
        <h3>${isMe ? 'Your posts' : 'Their posts'}</h3>
        <div class="profile-posts-list" id="profile-posts-list"></div>
      </div>
    </div>
  `;

  // Apply theme to the profile section if user picked one
  if (profile.theme) applyProfileTheme(profile.theme, wrap.querySelector('.profile-detail'));
  // Apply custom text color override
  if (profile.profileTextColor) {
    const pd = wrap.querySelector('.profile-detail');
    if (pd) pd.style.setProperty('--profile-text-color', profile.profileTextColor);
  }

  // Secret admirers — only on the user's own profile
  if (isMe) {
    const host = wrap.querySelector('#profile-secret-admirers-host');
    if (host) renderSecretAdmirers(host);
  }

  // Load + render the profile board (MySpace-style comments)
  api('GET', `/api/users/profile/${encodeURIComponent(profile.email)}/board`)
    .then(items => renderProfileBoard(wrap.querySelector('#profile-board'), profile, items || []))
    .catch(() => {});

  // Wire top-8 clicks
  wrap.querySelectorAll('.top8-cell').forEach(c => {
    c.addEventListener('click', () => navigateToProfile(c.dataset.email));
  });
  // Wire pinned-post clicks (open the post) + unpin
  wrap.querySelectorAll('.pinned-post-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.pinned-unpin-btn')) return;
      const pid = card.dataset.postId;
      if (pid) navigateToPost(pid);
    });
  });
  wrap.querySelectorAll('.pinned-unpin-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pid = btn.dataset.postId;
      if (!pid) return;
      try {
        await api('DELETE', `/api/me/pinned-posts/${encodeURIComponent(pid)}`);
        if (state.user) state.user.pinnedPosts = (state.user.pinnedPosts || []).filter(id => id !== pid);
        toast('unpinned');
        // re-fetch profile to refresh the section
        const fresh = await api('GET', `/api/users/profile/${encodeURIComponent(profile.email)}`);
        renderProfileDetail(wrap, fresh);
      } catch (err) { toast('unpin failed: ' + (err.data?.error || 'unknown')); }
    });
  });
  // Wire crush button
  const cb = wrap.querySelector('#profile-crush-here');
  if (cb) cb.addEventListener('click', () => openLoveLetterModal(cb.dataset.email));
  // Add-friend button
  const addFr = wrap.querySelector('#profile-add-friend');
  if (addFr) addFr.addEventListener('click', async () => {
    addFr.disabled = true;
    addFr.textContent = 'sending…';
    try {
      await api('POST', '/api/friend-requests/send', { toEmail: addFr.dataset.email });
      addFr.textContent = '✓ Friend request sent';
      toast('friend request sent ✨');
    } catch (e) {
      addFr.textContent = '＋ Add Friend';
      addFr.disabled = false;
      toast(e.data?.error || 'failed');
    }
  });
  // Accept-friend button (when they sent us a request first)
  const acceptFr = wrap.querySelector('#profile-accept-friend');
  if (acceptFr) acceptFr.addEventListener('click', async () => {
    acceptFr.disabled = true;
    acceptFr.textContent = 'accepting…';
    try {
      // Need the request id — fetch pending, find by from-email
      const pending = await api('GET', '/api/friend-requests/pending');
      const match = (pending || []).find(r => (r.from || '').toLowerCase() === acceptFr.dataset.email.toLowerCase());
      if (!match) {
        toast('request not found — refresh');
        acceptFr.disabled = false;
        acceptFr.textContent = '✓ Accept friend request';
        return;
      }
      await api('POST', `/api/friend-requests/${match.id}/respond`, { accept: true });
      acceptFr.textContent = '✓ Friends';
      toast('friend added 🎉');
      // refresh state.user so friends list updates
      try { const me = await api('POST', '/api/whoami'); if (me?.user) state.user = { ...state.user, ...me.user }; } catch {}
    } catch (e) {
      acceptFr.disabled = false;
      acceptFr.textContent = '✓ Accept friend request';
      toast(e.data?.error || 'failed');
    }
  });
  // Top-8 quick edit shortcut
  const t8 = wrap.querySelector('#profile-edit-top8');
  if (t8) t8.addEventListener('click', openEditProfileModal);

  if (isMe) {
    wrap.querySelector('#profile-edit-here').addEventListener('click', openEditProfileModal);
    // wire viewer links
    wrap.querySelectorAll('.viewer-list a').forEach(a => {
      a.style.cursor = 'pointer';
      a.addEventListener('click', () => navigateToProfile(a.dataset.email));
    });
  } else {
    const msgBtn = wrap.querySelector('#profile-message-here');
    if (msgBtn) msgBtn.addEventListener('click', () => openDmModal(profile.email, profile.name, profile.avatar));
    // wire viewer links for non-self too (they're public now)
    wrap.querySelectorAll('.viewer-list a').forEach(a => {
      a.style.cursor = 'pointer';
      a.addEventListener('click', () => navigateToProfile(a.dataset.email));
    });
  }

  // Profile song embed (if any)
  if (profile.songEmbed) {
    const info = wrap.querySelector('.profile-detail-info');
    if (info) {
      const musicDiv = document.createElement('div');
      musicDiv.innerHTML = renderProfileMusic(profile.songEmbed);
      info.appendChild(musicDiv);
    }
  }
  // Profile blinkies — confined to the edit-profile customize picker only.
  // No longer rendered on the public profile view.
  // Background image + custom CSS scoped to this profile
  const detail = wrap.querySelector('.profile-detail');
  if (detail) {
    applyProfileBackground(detail, profile);
    applyProfileCustomCss(detail, profile.customCss, profile.email);
  }
  // Sanitized custom HTML — drop into the about section
  if (profile.customHtmlSafe) {
    const aboutSection = wrap.querySelector('.profile-about');
    const customDiv = document.createElement('div');
    customDiv.className = 'profile-custom-html';
    customDiv.innerHTML = profile.customHtmlSafe;
    if (aboutSection) aboutSection.appendChild(customDiv);
    else if (detail) {
      const block = wrap.querySelector('.profile-detail-section');
      if (block) block.parentNode.insertBefore(customDiv, block);
    }
  }

  const list = wrap.querySelector('#profile-posts-list');
  if (userPosts.length === 0) {
    list.innerHTML = '<div class="comment-empty" style="padding:24px;">no posts yet.</div>';
  } else {
    userPosts.forEach((post, i) => list.appendChild(renderPostCard(post, i + 1)));
  }
}

// =================================================================
// STUB PROFILE — for directory entries that haven't signed up
// =================================================================
function renderStubProfile(wrap, profile) {
  wrap.innerHTML = `
    <div class="profile-detail">
      <div class="profile-detail-header">
        <div class="profile-detail-photo" style="opacity: 0.4;">
          ${escapeHtml((profile.name[0] || '?').toUpperCase())}
        </div>
        <div class="profile-detail-info">
          <div class="profile-detail-name">${escapeHtml(profile.name)}</div>
          <div class="profile-detail-email">${escapeHtml(profile.email)} · <strong style="color: var(--text-3);">not on Old Streets yet</strong></div>
          <div class="profile-detail-bio">${escapeHtml(profile.name.split(' ')[0])} hasn't joined Old Streets yet — pull them in.</div>
          <div style="margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap;">
            <button class="auth-btn" id="stub-crush" data-email="${escapeHtml(profile.email)}">💌 Send anonymous crush</button>
            <button class="auth-btn secondary" id="stub-invite" data-email="${escapeHtml(profile.email)}">✉️ Invite them</button>
          </div>
        </div>
      </div>
      <div class="profile-detail-section">
        <p style="padding: 16px; font-size: 12px; color: var(--text-3); text-align: center;">
          When ${escapeHtml(profile.name.split(' ')[0])} signs up, you'll see their wall, top 8, and profile here.
        </p>
      </div>
    </div>`;
  const crush = wrap.querySelector('#stub-crush');
  if (crush) crush.addEventListener('click', () => openLoveLetterModal(profile.email));
  const inv = wrap.querySelector('#stub-invite');
  if (inv) inv.addEventListener('click', async () => {
    inv.disabled = true; inv.textContent = 'sending…';
    try {
      await api('POST', '/api/invite-single', { toEmail: profile.email, toName: profile.name });
      toast('invite sent ✉️');
      inv.textContent = '✓ invited';
    } catch (e) {
      inv.textContent = '✉️ Invite them';
      inv.disabled = false;
      toast(e.data?.error || 'invite failed');
    }
  });
}

// =================================================================
// REPORT MODAL
// =================================================================
let reportingPostId = null;
function openReportModal(postId) {
  reportingPostId = postId;
  el('report-reason').value = '';
  el('report-status').textContent = '';
  el('report-modal').classList.remove('hidden');
  setTimeout(() => el('report-reason').focus(), 80);
}
function setupReportModal() {
  el('report-submit').addEventListener('click', async () => {
    if (!reportingPostId) return;
    const reason = el('report-reason').value.trim();
    el('report-submit').disabled = true;
    try {
      await api('POST', `/api/posts/${reportingPostId}/report`, { reason });
      el('report-status').textContent = 'sent. admin will review.';
      // mark current view if applicable
      document.querySelectorAll(`.post-card[data-id="${reportingPostId}"] .report-btn, .post-detail[data-id="${reportingPostId}"] .report-btn`).forEach(b => {
        b.classList.add('reported');
        b.textContent = '⚐ reported';
      });
      setTimeout(() => el('report-modal').classList.add('hidden'), 1100);
    } catch (e) {
      el('report-status').textContent = 'failed: ' + (e.data?.error || e.message);
      el('report-status').style.color = 'var(--bad)';
    } finally {
      el('report-submit').disabled = false;
    }
  });
}

// =================================================================
// EDIT PROFILE
// =================================================================
function openEditProfileModal() {
  const nameInput = el('edit-name');
  nameInput.value = state.user.name;
  nameInput.readOnly = !!state.user.nameLockedFromDirectory;
  nameInput.style.background = state.user.nameLockedFromDirectory ? '#e8efff' : '';
  nameInput.style.color = state.user.nameLockedFromDirectory ? '#1c2e5b' : '';
  // hint about why name is locked
  let hint = el('edit-name-hint');
  if (state.user.nameLockedFromDirectory) {
    if (!hint) {
      hint = document.createElement('p');
      hint.id = 'edit-name-hint';
      hint.style.cssText = 'font-size: 10px; color: var(--fb-blue); margin: 4px 0 0; font-weight: bold;';
      nameInput.parentNode.appendChild(hint);
    }
    hint.textContent = '🔒 name is locked from the school directory — only you can use this identity';
  } else if (hint) {
    hint.remove();
  }

  el('edit-bio').value = state.user.bio || '';
  el('edit-email-readonly').textContent = state.user.email;
  // MySpace fields
  if (el('edit-mood'))      el('edit-mood').value      = state.user.mood || '';
  if (el('edit-headline'))  el('edit-headline').value  = state.user.headline || '';
  if (el('edit-aboutme'))   el('edit-aboutme').value   = state.user.aboutMe || '';
  if (el('edit-interests')) el('edit-interests').value = state.user.interests || '';
  if (el('edit-heroes'))    el('edit-heroes').value    = state.user.heroes || '';
  if (el('edit-theme'))     el('edit-theme').value     = state.user.theme || 'classic';
  if (el('edit-vanity'))    el('edit-vanity').value    = state.user.vanityUrl || '';
  if (el('edit-top8'))      el('edit-top8').value      = (state.user.top8 || []).join(', ');
  if (el('edit-pronouns'))  el('edit-pronouns').value  = state.user.pronouns || '';
  if (el('edit-website'))   el('edit-website').value   = state.user.websiteUrl || '';
  if (el('edit-song'))      el('edit-song').value      = state.user.songUrl || '';
  if (el('edit-bg'))        el('edit-bg').value        = state.user.backgroundUrl || '';
  if (el('edit-bg-mode'))   el('edit-bg-mode').value   = state.user.backgroundMode || 'cover';
  const opacEl = el('edit-bg-opacity');
  const opacDisp = el('edit-bg-opacity-display');
  const curOpac = typeof state.user.backgroundOpacity === 'number' ? state.user.backgroundOpacity : 85;
  if (opacEl) opacEl.value = curOpac;
  if (opacDisp) opacDisp.textContent = curOpac;
  if (opacEl && !opacEl._wired) {
    opacEl._wired = true;
    opacEl.addEventListener('input', () => {
      if (opacDisp) opacDisp.textContent = opacEl.value;
    });
  }
  // Profile text color picker (linked color input + hex input + clear)
  const tcEl = el('edit-text-color');
  const tcHex = el('edit-text-color-hex');
  const tcClear = el('edit-text-color-clear');
  const curColor = state.user.profileTextColor || '';
  if (tcEl) tcEl.value = curColor || '#000000';
  if (tcHex) tcHex.value = curColor;
  if (tcEl && !tcEl._wired) {
    tcEl._wired = true;
    tcEl.addEventListener('input', () => { if (tcHex) tcHex.value = tcEl.value; });
  }
  if (tcHex && !tcHex._wired) {
    tcHex._wired = true;
    tcHex.addEventListener('input', () => {
      const v = tcHex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v) && tcEl) tcEl.value = v;
    });
  }
  if (tcClear && !tcClear._wired) {
    tcClear._wired = true;
    tcClear.addEventListener('click', () => {
      if (tcHex) tcHex.value = '';
      if (tcEl) tcEl.value = '#000000';
    });
  }
  if (el('edit-html'))      el('edit-html').value      = state.user.customHtml || '';
  if (el('edit-css'))       el('edit-css').value       = state.user.customCss || '';
  // Mood emoji grid
  renderMoodPicker(state.user.moodId);
  // Blinkies grid
  state._selectedBlinkies = new Set(state.user.blinkies || []);
  renderBlinkiesPicker(state._selectedBlinkies);
  el('edit-profile-error').classList.add('hidden');
  state.pendingAvatar = null;
  refreshAvatarPreview();
  el('edit-profile-modal').classList.remove('hidden');
  wireSecuritySection();
  setTimeout(() => state.user.nameLockedFromDirectory ? el('edit-bio').focus() : nameInput.focus(), 80);
}

function refreshAvatarPreview() {
  const preview = el('edit-avatar-preview');
  if (!preview) return;
  const avatar = state.pendingAvatar !== null ? state.pendingAvatar : (state.user?.avatar || '');
  if (avatar) preview.innerHTML = `<img src="${avatar}" alt="" style="width:100%; height:100%; object-fit:cover;"/>`;
  else preview.textContent = (state.user?.name?.[0] || '?').toUpperCase();
}

function setupEditProfile() {
  el('edit-profile-btn').addEventListener('click', openEditProfileModal);

  el('edit-avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      toast('compressing image…');
      // Avatars only show ~80px tops anywhere — shrink hard so the JSON body
      // is small and Lander's proxy never rejects.
      const dataUrl = await compressImageToDataURL(file, 384, 0.8, 220 * 1024);
      if (!dataUrl || !dataUrl.startsWith('data:image/')) throw new Error('bad output');
      state.pendingAvatar = dataUrl;
      refreshAvatarPreview();
      toast('image ready — click save profile');
    } catch (err) {
      console.error('avatar compress failed', err);
      toast("couldn't process that image — try a different one");
    }
    e.target.value = '';
  });

  el('edit-avatar-remove').addEventListener('click', () => {
    state.pendingAvatar = '';
    el('edit-avatar-file').value = '';
    refreshAvatarPreview();
  });

  el('edit-profile-submit').addEventListener('click', async () => {
    const name = el('edit-name').value.trim();
    const bio = el('edit-bio').value.trim();
    const errEl = el('edit-profile-error');
    errEl.classList.add('hidden');
    if (!name) { errEl.textContent = 'name required'; errEl.classList.remove('hidden'); return; }
    el('edit-profile-submit').disabled = true;
    try {
      const body = { name, bio };
      if (state.pendingAvatar !== null) {
        body.avatar = state.pendingAvatar;
        console.log('[edit-profile] sending avatar:',
          state.pendingAvatar === '' ? 'REMOVE' : `${state.pendingAvatar.length} bytes`);
      }
      const r = await api('PUT', '/api/users/me', body);
      state.user = { ...state.user, ...r.user };
      // Verify what came back from the server matches what we sent
      if (state.pendingAvatar !== null) {
        const sent = state.pendingAvatar;
        const got = r.user?.avatar || '';
        if (sent === '' && got === '') {
          toast('✓ avatar removed', 3000);
        } else if (sent && got && sent.length === got.length) {
          toast('✓ avatar saved', 3000);
        } else if (sent && !got) {
          console.error('[edit-profile] server dropped avatar — sent', sent.length, 'got empty');
          toast('avatar didn\'t save — try a different image', 6000);
        }
      }
      // Clear pending so next open starts fresh
      state.pendingAvatar = null;
      // Now save the MySpace fields via POST /api/users/me (additive)
      const top8Raw = (el('edit-top8')?.value || '').trim();
      const top8 = top8Raw
        ? top8Raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8).map(s => {
            // resolve name → email via directory
            if (s.includes('@')) return s.toLowerCase();
            const d = (state.directory || []).find(x => x.name.toLowerCase() === s.toLowerCase());
            return d ? d.email.toLowerCase() : null;
          }).filter(Boolean)
        : [];
      const myPatch = {
        mood: el('edit-mood')?.value || '',
        moodId: state._selectedMoodId || '',
        headline: el('edit-headline')?.value || '',
        aboutMe: el('edit-aboutme')?.value || '',
        interests: el('edit-interests')?.value || '',
        heroes: el('edit-heroes')?.value || '',
        theme: el('edit-theme')?.value || 'classic',
        vanityUrl: el('edit-vanity')?.value || '',
        top8,
        displayPronouns: el('edit-pronouns')?.value || '',
        websiteUrl: el('edit-website')?.value || '',
        songUrl: el('edit-song')?.value || '',
        backgroundUrl: el('edit-bg')?.value || '',
        backgroundMode: el('edit-bg-mode')?.value || 'cover',
        backgroundOpacity: parseInt(el('edit-bg-opacity')?.value || '85', 10),
        profileTextColor: el('edit-text-color-hex')?.value.trim() || '',
        customHtml: el('edit-html')?.value || '',
        customCss: el('edit-css')?.value || '',
        blinkies: Array.from(state._selectedBlinkies || [])
      };
      try {
        const r2 = await api('POST', '/api/users/me', myPatch);
        state.user = { ...state.user, ...r2 };
      } catch (myErr) {
        // surface specific errors (e.g. vanity URL taken) without blocking core save
        toast(myErr.data?.error || 'some fields didn\'t save');
      }
      if (!state.userAvatars) state.userAvatars = {};
      if (state.user.avatar) state.userAvatars[state.user.email] = state.user.avatar;
      else delete state.userAvatars[state.user.email];
      syncProfileSidebar();
      el('edit-profile-modal').classList.add('hidden');
      toast('profile saved');
      handleHashRoute();
      renderFeed();
    } catch (e) {
      console.error('profile save error', e, e.data);
      let msg = e.data?.error || e.message || 'save failed';
      if (e.status === 413) msg = 'image too big — try a smaller photo';
      else if (e.status === 0 || /Failed to fetch|NetworkError/i.test(msg)) msg = 'network issue — your image might be too large. try a smaller one.';
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      toast(msg, 6000);
    } finally {
      el('edit-profile-submit').disabled = false;
    }
  });
}

// =================================================================
// DIRECT MESSAGES
// =================================================================
let dmTypingTimeout = null;
function setupDmModal() {
  const send = async () => {
    const text = el('dm-input').value.trim();
    if (!text || !state.dmOpenWith) return;
    el('dm-input').value = '';
    // stop typing indicator when we send
    if (state.socket && state.dmOpenWith) {
      state.socket.emit('dm-stop-typing', { to: state.dmOpenWith });
    }
    try {
      await api('POST', '/api/dm/with/' + encodeURIComponent(state.dmOpenWith), { text });
      // socket will deliver it back and append
    } catch (e) {
      toast(e.data?.error || 'send failed');
    }
  };
  el('dm-send').addEventListener('click', send);
  el('dm-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  attachMentionTypeahead(el('dm-input'));

  // Typing indicator — emit while user is actively typing, stop after 2s idle
  el('dm-input').addEventListener('input', () => {
    if (!state.socket || !state.dmOpenWith) return;
    state.socket.emit('dm-typing', { to: state.dmOpenWith });
    clearTimeout(dmTypingTimeout);
    dmTypingTimeout = setTimeout(() => {
      if (state.socket && state.dmOpenWith) {
        state.socket.emit('dm-stop-typing', { to: state.dmOpenWith });
      }
    }, 2000);
  });

  el('dm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dm-modal') {
      if (state.socket && state.dmOpenWith) {
        state.socket.emit('dm-stop-typing', { to: state.dmOpenWith });
      }
      state.dmOpenWith = null;
    }
  });
}

function onDmTyping({ from, fromName }) {
  // Only show if the DM modal is open for this person
  if (state.dmOpenWith !== from) return;
  const indicator = el('dm-typing-indicator');
  if (!indicator) return;
  indicator.textContent = `${fromName || from} is typing…`;
  indicator.classList.remove('hidden');
  // Auto-clear after 3s in case stop-typing never fires
  clearTimeout(indicator._clearTimer);
  indicator._clearTimer = setTimeout(() => indicator.classList.add('hidden'), 3000);
}

function onDmStopTyping({ from }) {
  if (state.dmOpenWith !== from) return;
  const indicator = el('dm-typing-indicator');
  if (indicator) {
    clearTimeout(indicator._clearTimer);
    indicator.classList.add('hidden');
  }
}

async function openDmModal(email, name, avatar) {
  // Check DM lock
  // DMs are now open to all active members. No gating.
  state.dmOpenWith = email.toLowerCase();
  el('dm-header-name').textContent = name || email;
  el('dm-header-email').textContent = email;
  const avEl = el('dm-avatar');
  if (avatar) avEl.innerHTML = `<img src="${avatar}" alt=""/>`;
  else avEl.textContent = (name?.[0] || email[0] || '?').toUpperCase();
  el('dm-messages').innerHTML = '<div class="dm-empty">loading…</div>';
  el('dm-modal').classList.remove('hidden');
  setTimeout(() => el('dm-input').focus(), 80);

  try {
    const r = await api('GET', '/api/dm/with/' + encodeURIComponent(email));
    renderDmMessages(r.messages);
    appendDmReadReceipt();
  } catch (e) {
    el('dm-messages').innerHTML = '<div class="dm-empty">' + (e.data?.error || 'failed to load') + '</div>';
  }
}

function renderDmMessages(messages) {
  const wrap = el('dm-messages');
  if (!messages || messages.length === 0) {
    wrap.innerHTML = '<div class="dm-empty">no messages yet — say hi.</div>';
    return;
  }
  wrap.innerHTML = '';
  for (const m of messages) appendDmToDOM(m);
  wrap.scrollTop = wrap.scrollHeight;
}

function appendDmToDOM(m) {
  if (!state.user) return;
  const wrap = el('dm-messages');
  if (!wrap) return;
  const empty = wrap.querySelector('.dm-empty');
  if (empty) empty.remove();
  const myEmail = (state.user.email || '').toLowerCase();
  const fromMe = m.from === myEmail;
  const node = document.createElement('div');
  node.className = 'dm-msg' + (fromMe ? ' from-me' : '');
  node.dataset.id = m.id;
  const ticks = fromMe ? `<span class="dm-ticks ${m.read ? 'read' : 'sent'}">${m.read ? '✓✓' : '✓'}</span>` : '';
  node.innerHTML = `
    <div class="body">${linkify(escapeHtml(m.text))}</div>
    <div class="meta">${timeAgo(m.createdAt)} ${ticks}</div>
  `;
  wrap.appendChild(node);
  wrap.scrollTop = wrap.scrollHeight;
}

function applyDmRead(ids) {
  if (!Array.isArray(ids)) return;
  const wrap = el('dm-messages');
  if (!wrap) return;
  for (const id of ids) {
    const node = wrap.querySelector(`.dm-msg[data-id="${CSS.escape(id)}"] .dm-ticks`);
    if (node) {
      node.classList.remove('sent');
      node.classList.add('read');
      node.textContent = '✓✓';
    }
  }
}

function onIncomingDm(m) {
  if (!state.user) return;
  const myEmail = (state.user.email || '').toLowerCase();
  const partner = m.from === myEmail ? m.to : m.from;
  // Fire a real browser notification if this is FROM someone else AND
  // the tab is in the background.
  if (m.from !== myEmail) {
    firePushNotification(
      `💬 ${m.fromName || m.from}`,
      m.text || '(message)',
      {
        tag: 'dm:' + m.from,
        onClick: () => openDmModal(m.from, m.fromName || m.from)
      }
    );
  }
  if (state.dmOpenWith === partner) {
    appendDmToDOM(m);
    // The modal is open and we're looking at this thread — mark read instantly.
    if (m.from !== myEmail && state.socket?.connected) {
      state.socket.emit('dm-mark-read', { from: m.from });
    }
  } else {
    // not open — toast + bell
    if (m.from !== myEmail) {
      toast(`💬 new dm from ${m.fromName || partner}`, 4000);
    }
  }
}

// =================================================================
// FOOTER LINKS
// =================================================================
function setupFooter() {
  document.querySelectorAll('[data-footer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.footer;
      if (which === 'about') el('about-modal').classList.remove('hidden');
      else if (which === 'terms') el('terms-modal').classList.remove('hidden');
    });
  });
}

function renderOnlineUsers(users) {
  const list = el('online-list');
  const count = el('online-list-count');
  const prevOnline = state.onlineEmails || new Set();
  // remember online emails for online-dot rendering
  state.onlineEmails = new Set((users || []).map(u => (u.email || '').toLowerCase()));

  // Friend came online — toast once per session per friend
  if (state.user && state.user.friends && prevOnline.size > 0) {
    const myFriends = new Set((state.user.friends || []).map(e => e.toLowerCase()));
    for (const u of (users || [])) {
      const email = (u.email || '').toLowerCase();
      if (email === state.user.email.toLowerCase()) continue;
      if (!myFriends.has(email)) continue;
      if (!prevOnline.has(email) && !state._toastedOnline?.has(email)) {
        if (!state._toastedOnline) state._toastedOnline = new Set();
        state._toastedOnline.add(email);
        toast(`${u.username || email.split('@')[0]} just came online 👋`, 4000);
      }
    }
  }

  // Only re-render the wall when the SET of online emails actually changed
  // (someone joined or left). Skip when only activity/labels updated — that
  // was firing on every keystroke and causing the feed to flash.
  const setChanged =
    prevOnline.size !== state.onlineEmails.size ||
    Array.from(state.onlineEmails).some(e => !prevOnline.has(e));
  if (setChanged && state.view === 'wall') renderFeed();
  // Update in-place online-dots on already-rendered posts so we don't
  // need a full re-render to reflect new online status.
  document.querySelectorAll('.post-avatar[data-email]').forEach(node => {
    const em = node.dataset.email;
    if (!em) return;
    const isOnline = state.onlineEmails.has(em.toLowerCase());
    node.classList.toggle('is-online', isOnline);
  });
  if (!list) return;
  list.innerHTML = '';
  if (count) count.textContent = users.length;
  if (!users || users.length === 0) {
    list.innerHTML = '<li><span class="name" style="color:var(--text-4)">no one</span></li>';
    return;
  }
  const sorted = [...users].sort((a, b) => {
    if (a.socketId === state.socketId) return -1;
    if (b.socketId === state.socketId) return 1;
    return a.username.localeCompare(b.username);
  });
  for (const u of sorted) {
    const li = document.createElement('li');
    const isYou = u.socketId === state.socketId;
    const a = u.activity || null;
    // Cache avatar globally so post cards + DM list can use it without refetching
    if (u.avatar && u.email) {
      if (!state.userAvatars) state.userAvatars = {};
      state.userAvatars[u.email] = u.avatar;
    }
    let actionHtml = '';
    let statusLabel = '';
    if (!isYou && a) {
      statusLabel = a.label || '';
      if (a.kind === 'room' && a.ref) {
        actionHtml = `<button class="activity-action" data-action="join-room" data-ref="${escapeAttr(a.ref)}">join their room ▶</button>`;
      } else if (a.kind === 'profile' && a.ref) {
        actionHtml = `<button class="activity-action" data-action="view-profile" data-ref="${escapeAttr(a.ref)}">view profile →</button>`;
      } else if (u.email) {
        actionHtml = `<button class="activity-action subtle" data-action="view-profile" data-ref="${escapeAttr(u.email)}">profile →</button>`;
      }
    }
    const avatarHtml = u.avatar
      ? `<span class="online-avatar"><img src="${escapeAttr(u.avatar)}" alt=""/></span>`
      : `<span class="online-avatar online-avatar-letter">${escapeHtml((u.username || '?')[0].toUpperCase())}</span>`;
    li.innerHTML = `
      <div class="online-row-head">
        ${avatarHtml}
        <span class="dot"></span>
        <span class="name">${escapeHtml(u.username)}</span>
        ${isYou ? '<span class="you">/ you</span>' : ''}
      </div>
      ${statusLabel ? `<div class="online-row-status">↳ ${escapeHtml(statusLabel)}</div>` : ''}
      ${actionHtml ? `<div class="online-row-action">${actionHtml}</div>` : ''}
    `;
    list.appendChild(li);
  }
  list.querySelectorAll('.activity-action').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const ref = btn.dataset.ref;
      if (action === 'join-room' && ref) {
        location.hash = `#room=${encodeURIComponent(ref)}`;
        joinRoom(ref);
      } else if (action === 'view-profile' && ref) {
        navigateToProfile(ref);
      }
    });
  });
}

// =================================================================
// FEED
// =================================================================
async function loadPosts() {
  try {
    const endpoint = state.sortMode === 'foryou' ? '/api/posts/foryou' : '/api/posts';
    let data;
    try {
      data = await api('GET', endpoint);
    } catch (e1) {
      // For-You may fail (slow algo / cold cache) — fall back to plain /api/posts
      if (endpoint !== '/api/posts') {
        try { data = await api('GET', '/api/posts'); }
        catch { data = []; }
      } else {
        data = [];
      }
      // If we ended up empty, show a soft retry banner
      if (!Array.isArray(data) || data.length === 0) {
        toast('feed slow — retrying…', 3000);
        setTimeout(() => loadPosts(), 2000);
      }
    }
    state.posts = Array.isArray(data) ? data : [];
    renderFeed();
    updateProfileStats();
  } catch (e) { console.error(e); }
}

function onPostAdded(post) {
  if (!post || !post.id) return;
  // De-dupe: ignore if we already have this post (POST response + socket
  // broadcast race-condition would otherwise insert it twice).
  if (state.posts.find(p => p.id === post.id)) return;
  state.posts.unshift(post);
  // Incrementally PREPEND the new card instead of wiping + re-rendering the
  // whole feed (which causes a visible flash on every ghost post). Sort modes
  // that depend on score still re-render via their explicit hooks.
  if (state.view === 'wall' && state.sortMode !== 'popular') {
    const feed = el('feed');
    if (feed) {
      try {
        const node = renderPostCard(post, 1);
        // No flash — silently prepend. Users complained the highlight felt
        // like the whole wall was flashing on every ghost post / reaction.
        feed.insertBefore(node, feed.firstChild);
      } catch (e) { console.warn('incremental insert failed, falling back', e); renderFeed(); }
    }
  } else {
    renderFeed();
  }
  updateProfileStats();
}
function onPostDeleted({ id }) {
  state.posts = state.posts.filter(p => p.id !== id);
  state.openComments.delete(id);
  // Remove just that card in place — no flash
  const card = document.querySelector(`.post-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.remove();
  else renderFeed();
  updateProfileStats();
  // if currently viewing this post, return to wall
  if (state.view === 'post') {
    const detail = document.querySelector(`.post-detail[data-id="${id}"]`);
    if (detail) {
      toast('this post was deleted');
      navigateToWall();
    }
  }
}
function onCommentDeleted({ postId, commentId }) {
  const post = state.posts.find(p => p.id === postId);
  if (!post) return;
  post.comments = (post.comments || []).filter(c => c.id !== commentId);
  if (state.openComments.has(postId)) {
    const card = document.querySelector(`.post-card[data-id="${postId}"]`);
    if (card) renderCommentsList(card, post);
  }
  updateCommentCountUI(post);
  if (state.sortMode === 'comments') renderFeed();
}

function onPostVoted({ id, upvotes, downvotes }) {
  const post = state.posts.find(p => p.id === id);
  if (post) {
    post.upvotes = upvotes;
    post.downvotes = downvotes;
    updateVoteUI(post);
  }
}

function onPostCommented({ postId, comment }) {
  const post = state.posts.find(p => p.id === postId);
  if (!post || !comment) return;
  post.comments = post.comments || [];
  // Dedup: if this comment id is already on the post, ignore the socket event.
  // Server now emits to everyone including the original sender; without this
  // check the sender saw their own comment twice.
  if (post.comments.some(c => c.id === comment.id)) return;
  post.comments.push(comment);
  if (state.openComments.has(postId)) appendCommentToDOM(postId, comment);
  updateCommentCountUI(post);
  if (state.sortMode === 'comments') renderFeed();
  updateProfileStats();
}

function updateProfileStats() {
  const me = state.user?.email;
  if (!me) return;
  const myPosts = state.posts.filter(p => p.authorEmail === me).length;
  const myCmts = state.posts.reduce((acc, p) =>
    acc + (p.comments || []).filter(c => c.authorEmail === me).length, 0);
  const pc = el('profile-post-count'); if (pc) pc.textContent = myPosts;
  const cc = el('profile-comment-count'); if (cc) cc.textContent = myCmts;
}

function getSortedFilteredPosts() {
  const q = state.searchQuery.toLowerCase().trim();
  let posts = state.posts;
  if (q) {
    posts = posts.filter(p =>
      (p.author || '').toLowerCase().includes(q) ||
      (p.caption || '').toLowerCase().includes(q) ||
      (p.type === 'text' && (p.content || '').toLowerCase().includes(q)) ||
      (p.comments || []).some(c =>
        (c.author || '').toLowerCase().includes(q) ||
        (c.text || '').toLowerCase().includes(q))
    );
  }
  posts = [...posts];
  // Pinned posts always rise to the top, regardless of sort mode.
  const pinned = posts.filter(p => p.pinned);
  posts = posts.filter(p => !p.pinned);
  if (state.sortMode === 'foryou') {
    // Already ranked server-side — preserve order, pinned first
  } else if (state.sortMode === 'recent') {
    posts.sort((a, b) => b.createdAt - a.createdAt);
  } else if (state.sortMode === 'popular') {
    posts.sort((a, b) => {
      const aScore = Object.keys(a.upvotes || {}).length - Object.keys(a.downvotes || {}).length;
      const bScore = Object.keys(b.upvotes || {}).length - Object.keys(b.downvotes || {}).length;
      if (bScore !== aScore) return bScore - aScore;
      return b.createdAt - a.createdAt;
    });
  } else if (state.sortMode === 'comments') {
    posts.sort((a, b) => {
      const aLen = (a.comments || []).length;
      const bLen = (b.comments || []).length;
      if (bLen !== aLen) return bLen - aLen;
      return b.createdAt - a.createdAt;
    });
  }
  // Pinned posts always go first, sorted by pin timestamp (newest pin first)
  pinned.sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  return [...pinned, ...posts];
}

function renderFeed() {
  const feed = el('feed');
  const empty = el('feed-empty');
  if (!feed) return;
  feed.querySelectorAll('.post-card').forEach(c => c.remove());

  const posts = getSortedFilteredPosts();
  const postCountEl = el('post-count');
  if (postCountEl) postCountEl.textContent = state.posts.length;

  if (posts.length === 0) {
    empty.classList.remove('hidden');
    if (state.searchQuery) {
      empty.querySelector('h2').textContent = 'no matches';
      empty.querySelector('p').textContent = `nothing for "${state.searchQuery}"`;
    } else {
      empty.querySelector('h2').textContent = 'nothing on the wall yet.';
      empty.querySelector('p').innerHTML = 'be the first — hit <strong>+ post</strong> in the top right.';
    }
  } else {
    empty.classList.add('hidden');
    // Defensive: don't let one bad post break the whole feed render.
    posts.forEach((post, i) => {
      try { feed.appendChild(renderPostCard(post, i + 1)); }
      catch (e) {
        console.error('[renderPostCard FAILED]', post?.id, e);
        // FALLBACK: render the actual post content in a stripped-down card
        // so the user still sees it. They can't react/comment from this
        // simple view, but at least the content shows.
        const fallback = document.createElement('div');
        fallback.className = 'post-card post-card-fallback';
        const isAnon = !!post?.isAnonymous;
        const who = isAnon ? '🥷 anonymous' : escapeHtml(post?.author || 'someone');
        const when = post?.createdAt ? timeAgo(post.createdAt) : '';
        let body = '';
        if (post?.type === 'text') body = linkify(escapeHtml(post.content || ''));
        else if (post?.type === 'image' && post.content) body = `<img src="${post.content}" alt="" style="max-width:100%;"/>`;
        else if (post?.type === 'video' && post.content) body = `<video src="${post.content}" controls playsinline style="max-width:100%;"></video>`;
        else if (post?.caption) body = escapeHtml(post.caption);
        fallback.innerHTML = `
          <div class="post-main-col" style="padding:12px;">
            <div style="font-weight:bold; color: var(--fb-blue); margin-bottom: 4px;">${who} <span style="font-size:10px; color:#aaa; font-weight:normal;">${when}</span></div>
            <div style="font-size:14px; line-height:1.5;">${body}</div>
          </div>`;
        feed.appendChild(fallback);
      }
    });
  }

  const searchTag = el('search-tag');
  if (state.searchQuery) {
    searchTag.classList.remove('hidden');
    searchTag.textContent = `"${state.searchQuery}" · ${posts.length}`;
  } else {
    searchTag.classList.add('hidden');
  }
}

function renderPostCard(post, num) {
  if (!post || !post.id) throw new Error('renderPostCard: invalid post');
  const card = document.createElement('div');
  card.className = 'post-card';
  card.dataset.id = post.id;

  const cmtCount = (post.comments || []).length;
  const myEmail = (state.user && state.user.email) ? String(state.user.email) : '';
  const myEmailLc = myEmail.toLowerCase();
  const myReported = (post.reports || []).some(r => r && r.reporterEmail === myEmail);
  const reactions = post.reactions || {};
  const myReaction = REACTIONS.find(e => reactions[e] && reactions[e][myEmail]) || null;

  let mediaHtml = '';
  try {
    if (post.type === 'image' && post.content) {
      mediaHtml = `<div class="post-media-wrap"><img src="${post.content}" alt=""/></div>`;
    } else if (post.type === 'video' && post.content) {
      mediaHtml = `<div class="post-media-wrap"><video src="${post.content}" controls playsinline></video></div>`;
    } else if (post.type === 'survey') {
      ensureSurveyTemplates().catch(() => {});
      mediaHtml = `<div class="post-survey-wrap">${renderSurveyContent(post)}</div>`;
    } else if (post.type === 'blog') {
      const title = escapeHtml(post.blogTitle || '(untitled blog)');
      const excerpt = escapeHtml(post.blogExcerpt || '');
      mediaHtml = `
        <a class="post-blog-card" href="#blogs/${escapeHtml(post.blogId || '')}">
          <div class="post-blog-badge">📖 BLOG</div>
          <div class="post-blog-title">${title}</div>
          ${excerpt ? `<div class="post-blog-excerpt">${excerpt}…</div>` : ''}
          <div class="post-blog-cta">read full post →</div>
        </a>
      `;
    }
  } catch (e) { console.warn('media render failed', post.id, e); mediaHtml = ''; }
  // For reposts, the embedded quote card sits BELOW the user's comment
  // (Twitter quote-tweet layout), not above. Render it separately so the
  // caption can come first and be styled bigger than the embedded card.
  let repostHtml = '';
  if (post.repostOf) {
    try { repostHtml = buildRepostCardHTML(post.repostOf); } catch {}
  }
  // Room attachment is rendered as a SEPARATE box BELOW the post, not
  // inside the media area. Cleaner visual hierarchy.
  let roomBoxHtml = '';
  if (post.roomId) {
    const roomName = post.roomName || 'video room';
    roomBoxHtml = `
      <a class="post-room-card" data-room-id="${escapeAttr(post.roomId)}" href="#room=${escapeAttr(post.roomId)}">
        <span class="post-room-icon">🎥</span>
        <span class="post-room-body">
          <strong>${escapeHtml(roomName)}</strong>
          <span class="post-room-sub">tap to join the video room</span>
        </span>
        <span class="post-room-cta">join ▶</span>
      </a>`;
  }

  const captionText = post.type === 'text' ? (post.content || '')
    : (post.type === 'survey' ? '' : (post.caption || ''));

  const isAnon = !!post.isAnonymous;
  const authorEmailLc = post.authorEmail ? String(post.authorEmail).toLowerCase() : '';
  // Prefer the server-supplied avatar on the post (current at fetch time).
  // Fall back to the local cache (populated by online list / profile visits).
  let avatarSrc = !isAnon && (post.authorAvatar || (state.userAvatars && state.userAvatars[post.authorEmail || '']));
  // And cache it so it's available everywhere
  if (post.authorAvatar && post.authorEmail) {
    if (!state.userAvatars) state.userAvatars = {};
    state.userAvatars[post.authorEmail] = post.authorAvatar;
  }
  const authorStr = String(post.author || (isAnon ? 'anonymous' : 'unknown'));
  const avatarHtml = isAnon
    ? '🥷'
    : (avatarSrc ? `<img src="${avatarSrc}" alt=""/>` : escapeHtml((authorStr[0] || '?').toUpperCase()));
  const isOnline = !isAnon && authorEmailLc && state.onlineEmails && state.onlineEmails.has(authorEmailLc);

  // Build reaction buttons (only show emojis with count > 0 OR all 6 if no reactions yet)
  const anyReactions = REACTIONS.some(e => reactions[e] && Object.keys(reactions[e]).length > 0);
  const reactionsHtml = REACTIONS.map(e => {
    const count = reactions[e] ? Object.keys(reactions[e]).length : 0;
    if (!anyReactions || count > 0 || myReaction === e) {
      return `<button class="react-btn ${myReaction === e ? 'active' : ''}" data-emoji="${e}" title="${e}">${e} <span class="react-count">${count}</span></button>`;
    }
    return '';
  }).filter(Boolean).join('');

  // Reactor names — visible to the post author for their OWN posts (anonymous
  // or not). The server sets isMine for the original author even on anon posts.
  let reactorList = '';
  const isMyPost = !!post.isMine || (myEmailLc && authorEmailLc && authorEmailLc === myEmailLc);
  if (isMyPost && anyReactions) {
    const realReactors = [];
    let anonReactorCount = 0;
    for (const e of REACTIONS) {
      const bucket = reactions[e] || {};
      for (const email of Object.keys(bucket)) {
        // Filter ghost emails — they exist for the count only, never name-shown
        if (String(email).toLowerCase().endsWith('@old-streets.internal')) {
          anonReactorCount++;
          continue;
        }
        realReactors.push({ email, emoji: e });
      }
    }
    const parts = [];
    if (realReactors.length > 0) {
      parts.push(realReactors.slice(0, 8).map(r => {
        const rEmail = String(r.email || '');
        const rEmailLc = rEmail.toLowerCase();
        const dir = (state.directory || []).find(d => d && d.email && d.email.toLowerCase() === rEmailLc);
        const first = dir ? (dir.name || '').split(' ')[0] : rEmail.split('@')[0];
        return `<span class="reactor-pill" data-email="${escapeHtml(rEmail)}">${r.emoji} ${escapeHtml(first)}</span>`;
      }).join(' '));
      if (realReactors.length > 8) parts.push(`<span class="reactor-more">+ ${realReactors.length - 8} more</span>`);
    }
    if (anonReactorCount > 0) parts.push(`<span class="reactor-more">+ ${anonReactorCount} anonymous</span>`);
    if (parts.length > 0) {
      reactorList = `<div class="reactor-list" title="people who reacted to your post"><span class="reactor-label">reacted by:</span> ${parts.join(' ')}</div>`;
    }
  }

  // ephemeral indicator
  const ephemeralTag = post.expiresAt
    ? `<span class="ephemeral-tag">⏱ ${timeUntil(post.expiresAt)}</span>`
    : '';

  const anonTag = isAnon ? '<span class="anon-tag">🥷 anonymous</span>' : '';
  const pinnedTag = post.pinned ? '<span class="pinned-tag">📌 pinned</span>' : '';
  const trendingTag = post.trending ? '<span class="trending-tag">🔥 trending</span>' : '';
  const freshMs = Date.now() - (post.createdAt || 0);
  const earlyReaderTag = freshMs < 5 * 60 * 1000 ? '<span class="early-reader-tag">🆕 first look</span>' : '';

  // Absence badge — user hasn't posted in 5+ days, show tag on posts they missed
  const userIsAbsent = state.user && (state.user.lastPostAt || 0) < Date.now() - 5 * 24 * 60 * 60 * 1000;
  const absenceTag = userIsAbsent && (state.lastVisit || 0) > 0 && post.createdAt > (state.lastVisit || 0)
    ? '<span class="absence-tag">posted while you were away</span>' : '';

  // Fake expiry — posts 20–23.5h old get a melting countdown label (disappears naturally after 24h)
  const fakeExpiryHoursLeft = !post.expiresAt && freshMs >= 20 * 3600 * 1000 && freshMs < 24 * 3600 * 1000
    ? Math.max(1, Math.ceil((24 * 3600 * 1000 - freshMs) / (3600 * 1000))) : 0;
  const fakeExpiryTag = fakeExpiryHoursLeft > 0
    ? `<span class="fake-expiry-tag">🕐 fades in ${fakeExpiryHoursLeft}h</span>` : '';

  // Soft lock — hot posts (≥10 reactors) need 3+ posts to unlock comment input
  const myPostCount = state.user ? (state.user.postCount || 0) : 0;
  const hotLocked = !!(post.hotLocked && myPostCount < 3);

  if (post.pinned) card.classList.add('pinned-card');
  card.innerHTML = `
    <div class="post-meta-col">
      <div class="post-num">#${num}</div>
      <div>${escapeHtml(formatDate(post.createdAt))}</div>
      <div class="post-time">${timeAgo(post.createdAt)}</div>
    </div>
    <div class="post-main-col">
      <div class="post-header">
        <div class="post-avatar ${isAnon ? 'anon' : ''}" data-email="${isAnon ? '' : escapeHtml(post.authorEmail || '')}">
          ${avatarHtml}
          ${isOnline ? '<span class="online-dot-tiny"></span>' : ''}
        </div>
        <span class="post-author ${isAnon ? 'anon' : ''}" data-email="${isAnon ? '' : escapeHtml(post.authorEmail || '')}">${isAnon ? 'anonymous' : escapeHtml(authorStr)}</span>${(!isAnon && post.authorRating > 0) ? `<span class="author-rating" style="color:#cc7700;font-size:10px;margin-left:4px;font-weight:700;" title="${post.authorRating.toFixed(1)} / 5 from members">★${post.authorRating.toFixed(1)}</span>` : ''}
        ${anonTag}
        ${pinnedTag}
        ${trendingTag}
        ${earlyReaderTag}
        ${absenceTag}
        ${fakeExpiryTag}
        <span class="post-time">posted ${timeAgo(post.createdAt)}${ephemeralTag}</span>
      </div>
      ${post.repostOf
        ? `${captionText ? `<div class="post-caption post-caption-quote">${linkify(escapeHtml(captionText))}</div>` : ''}${renderSpotifyEmbed(captionText)}${repostHtml}`
        : `${mediaHtml}${captionText ? `<div class="post-caption">${linkify(escapeHtml(captionText))}</div>` : ''}${renderSpotifyEmbed(captionText)}`}
      ${roomBoxHtml}
      <div class="post-actions">
        <span class="reaction-row">${reactionsHtml}</span>
        <button class="comment-toggle">
          💬 <span class="comment-count">${cmtCount}</span>
        </button>
        <button class="report-btn ${myReported ? 'reported' : ''}">⚐ ${myReported ? 'reported' : 'report'}</button>
        <button class="permalink-btn feed-permalink-btn">copy link</button>
        <button class="repost-btn" title="repost with a comment">🔁 repost</button>
        ${(() => {
          const isPinned = (state.user?.pinnedPosts || []).includes(post.id);
          return `<button class="pin-profile-btn ${isPinned ? 'pinned' : ''}" title="${isPinned ? 'unpin from your profile' : 'pin to your profile'}">📌${isPinned ? ' pinned' : ''}</button>`;
        })()}
        ${isMyPost ? `<button class="delete-post-btn" title="delete this post">🗑</button>` : ''}
        <span class="post-spacer"></span>
        <span class="readers-now hidden" data-post-id="${post.id}"></span>
        ${(post.viewCount || 0) > 0 && post.viewCount <= 5
          ? `<span class="post-view-badge exclusive-view" title="only ${post.viewCount} people have seen this">👁 <span class="view-num">${post.viewCount}</span> · exclusive</span>`
          : (post.viewCount || 0) > 0
            ? `<span class="post-view-badge" title="${post.viewCount} members saw this">👁 <span class="view-num">${post.viewCount}</span></span>`
            : `<span class="post-view-badge" style="opacity:0;"><span class="view-num">0</span></span>`}
      </div>
      ${reactorList}
      ${(post.seenBy || []).length > 0
        ? `<div class="seen-by-row">seen by ${post.seenBy.slice(0, 4).map(n => escapeHtml(n)).join(', ')}${post.viewCount > post.seenBy.length ? ` + ${post.viewCount - post.seenBy.length} more` : ''}</div>`
        : ''}
      <div class="comments-section ${state.openComments.has(post.id) ? 'open' : ''}">
        <div class="comments-list"></div>
        ${hotLocked
          ? `<div class="hot-lock-gate">🔒 post 3 times to unlock replies on popular posts <button class="scribble-button" style="margin-left:8px; font-size:10px;" onclick="el('add-postit-btn').click()">post now</button></div>`
          : `<div class="comment-input-row">
              <input type="text" class="scribble-input comment-input" placeholder="say something..." maxlength="400"/>
              <label class="comment-anon-label" title="post this comment anonymously"><input type="checkbox" class="comment-anon"/>🥷</label>
              <button class="scribble-button comment-send">send</button>
            </div>`}
      </div>
    </div>
  `;

  card.querySelectorAll('.react-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); reactToPost(post.id, btn.dataset.emoji); });
  });
  const reportBtn = card.querySelector('.report-btn');
  if (reportBtn) reportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openReportModal(post.id);
  });
  const feedDelBtn = card.querySelector('.delete-post-btn');
  if (feedDelBtn) feedDelBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('delete this post permanently?')) return;
    try {
      await api('DELETE', `/api/posts/${encodeURIComponent(post.id)}`);
      state.posts = state.posts.filter(p => p.id !== post.id);
      toast('post deleted');
      card.remove();
    } catch (err) { toast('delete failed: ' + (err.data?.error || 'unknown')); }
  });

  const repostBtn = card.querySelector('.repost-btn');
  if (repostBtn) repostBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRepostModal(post);
  });

  const feedPermalinkBtn = card.querySelector('.feed-permalink-btn');
  if (feedPermalinkBtn) feedPermalinkBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const link = `${window.location.origin}/#post=${encodeURIComponent(post.id)}`;
    try { await navigator.clipboard.writeText(link); toast('link copied'); }
    catch { toast(link, 4000); }
  });

  const pinBtn = card.querySelector('.pin-profile-btn');
  if (pinBtn) pinBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasPinned = pinBtn.classList.contains('pinned');
    pinBtn.disabled = true;
    try {
      if (wasPinned) {
        await api('DELETE', `/api/me/pinned-posts/${encodeURIComponent(post.id)}`);
        if (state.user) state.user.pinnedPosts = (state.user.pinnedPosts || []).filter(id => id !== post.id);
        pinBtn.classList.remove('pinned');
        pinBtn.innerHTML = '📌';
        pinBtn.title = 'pin to your profile';
        toast('unpinned from your profile');
      } else {
        await api('POST', `/api/me/pinned-posts/${encodeURIComponent(post.id)}`);
        if (state.user) {
          state.user.pinnedPosts = state.user.pinnedPosts || [];
          if (!state.user.pinnedPosts.includes(post.id)) state.user.pinnedPosts.unshift(post.id);
        }
        pinBtn.classList.add('pinned');
        pinBtn.innerHTML = '📌 pinned';
        pinBtn.title = 'unpin from your profile';
        toast('pinned to your profile 📌');
      }
    } catch (err) {
      toast('pin failed: ' + (err.data?.error || 'unknown'));
    } finally {
      pinBtn.disabled = false;
    }
  });
  // author + avatar click → profile (skipped for anonymous posts — there's nothing to view)
  const authorEl = card.querySelector('.post-author');
  const avatarEl = card.querySelector('.post-avatar');
  if (!isAnon && post.authorEmail) {
    if (authorEl) authorEl.addEventListener('click', (e) => { e.stopPropagation(); navigateToProfile(post.authorEmail); });
    if (avatarEl) avatarEl.addEventListener('click', (e) => { e.stopPropagation(); navigateToProfile(post.authorEmail); });
  }

  const commentToggle = card.querySelector('.comment-toggle');
  const commentsSection = card.querySelector('.comments-section');
  if (commentToggle && commentsSection) {
    commentToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (commentsSection.classList.contains('open')) {
        commentsSection.classList.remove('open');
        state.openComments.delete(post.id);
      } else {
        commentsSection.classList.add('open');
        state.openComments.add(post.id);
        renderCommentsList(card, post);
        const inp = card.querySelector('.comment-input');
        if (inp) setTimeout(() => inp.focus(), 50);
      }
    });
  }

  const cmtInput = card.querySelector('.comment-input');
  const cmtSend = card.querySelector('.comment-send');
  const cmtAnon = card.querySelector('.comment-anon');
  if (cmtInput && cmtSend) {
    const sendCmt = () => {
      const text = cmtInput.value.trim();
      if (!text) return;
      const anon = !!cmtAnon?.checked;
      cmtInput.value = '';
      if (cmtAnon) cmtAnon.checked = false;
      submitComment(post.id, text, anon);
    };
    cmtSend.addEventListener('click', (e) => { e.stopPropagation(); sendCmt(); });
    cmtInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendCmt(); } });
    cmtInput.addEventListener('click', (e) => e.stopPropagation());
    if (cmtAnon) cmtAnon.addEventListener('click', (e) => e.stopPropagation());
  }

  // card body click → permalink view (excluding interactive elements)
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, input, textarea, a, .post-author, .comments-section')) return;
    // Clicking the embedded repost card goes to the ORIGINAL, not the repost.
    const repostCard = e.target.closest('.repost-card');
    if (repostCard && repostCard.dataset.origId) {
      e.stopPropagation();
      navigateToPost(repostCard.dataset.origId);
      return;
    }
    navigateToPost(post.id);
  });

  if (state.openComments.has(post.id)) renderCommentsList(card, post);

  // Wire "Join room" cards to actually join the video room
  const roomCard = card.querySelector('.post-room-card');
  if (roomCard) {
    roomCard.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const rid = roomCard.dataset.roomId;
      if (rid) joinRoom(rid);
    });
  }

  // wire post-view tracking after the card enters the DOM
  // (must be deferred so IntersectionObserver sees it mounted)
  observePostCard(card);

  return card;
}

function renderCommentsList(cardEl, post) {
  const list = cardEl.querySelector('.comments-list');
  list.innerHTML = '';
  const comments = post.comments || [];
  if (comments.length === 0) {
    list.innerHTML = `<div class="comment-empty">no comments yet</div>`;
    return;
  }
  for (const c of comments) list.appendChild(renderComment(c, post.id));
}

function renderComment(c, postId) {
  const node = document.createElement('div');
  node.className = 'comment-card';
  node.dataset.id = c.id;
  node.innerHTML = `
    <span class="comment-author" data-email="${escapeHtml(c.authorEmail || '')}" style="${c.authorEmail ? 'cursor:pointer; color:var(--fb-blue); text-decoration:underline;' : ''}">${escapeHtml(c.author)}</span>
    <span class="post-time">· ${timeAgo(c.createdAt)}</span>
    <span class="comment-body">${linkify(escapeHtml(c.text))}</span>
    <button class="comment-repost-btn" title="repost this comment with your take">🔁</button>
  `;
  const authorEl = node.querySelector('.comment-author');
  if (c.authorEmail && authorEl) {
    authorEl.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateToProfile(c.authorEmail);
    });
  }
  const repostBtn = node.querySelector('.comment-repost-btn');
  if (repostBtn) repostBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Repost the comment as a quoted post — wrap it in a synthetic post-like
    // object the repost modal can render. Server stores it as a regular
    // repost of the parent post but with the comment text appended to caption.
    openRepostModal({
      id: postId || c._postId || '',
      author: c.author,
      authorEmail: c.authorEmail || '',
      isAnonymous: !!c.isAnonymous,
      type: 'text',
      content: '"' + c.text + '" — comment by ' + (c.isAnonymous ? 'anonymous' : c.author),
      caption: '',
      createdAt: c.createdAt
    });
  });
  return node;
}

function appendCommentToDOM(postId, comment) {
  // wall card
  const card = document.querySelector(`.post-card[data-id="${postId}"]`);
  if (card) {
    const list = card.querySelector('.comments-list');
    if (list) {
      const empty = list.querySelector('.comment-empty');
      if (empty) empty.remove();
      list.appendChild(renderComment(comment));
      list.scrollTop = list.scrollHeight;
    }
  }
  // post-detail view
  const detail = document.querySelector(`.post-detail[data-id="${postId}"]`);
  if (detail) {
    const list = detail.querySelector('.comments-list');
    if (list) {
      const empty = list.querySelector('.comment-empty');
      if (empty) empty.remove();
      list.appendChild(renderComment(comment));
      list.scrollTop = list.scrollHeight;
    }
    // update header count
    const header = detail.querySelector('.post-detail-comments-header');
    if (header) {
      const post = state.posts.find(p => p.id === postId);
      if (post) header.textContent = `comments (${(post.comments || []).length})`;
    }
  }
}

function updateVoteUI(post) {
  // PATCH IN PLACE — re-rendering the whole card on every reaction was
  // causing the wall to flash (multiple cards being destroyed/rebuilt per
  // second as ghost reactions fire). Just update the reaction row + count.
  if (state.view === 'wall') {
    const card = document.querySelector(`.post-card[data-id="${post.id}"]`);
    if (card) patchReactionsInCard(card, post);
  }
  const detail = document.querySelector(`.post-detail[data-id="${post.id}"]`);
  if (detail) {
    patchReactionsInCard(detail, post);
  }
  if (state.sortMode === 'popular' && state.view === 'wall') renderFeed();
}

// Surgical reaction-row patch — replaces just the reaction buttons within
// a card, leaving the rest of the DOM (and all event listeners) intact.
function patchReactionsInCard(card, post) {
  const row = card.querySelector('.reaction-row');
  if (!row) return;
  const me = (state.user?.email || '').toLowerCase();
  const reactions = post.reactions || {};
  const anyReactions = Object.keys(reactions).length > 0;
  const myReaction = REACTIONS.find(e => reactions[e]?.[state.user?.email]);
  const html = REACTIONS.map(e => {
    const count = reactions[e] ? Object.keys(reactions[e]).length : 0;
    if (!anyReactions || count > 0 || myReaction === e) {
      return `<button class="react-btn ${myReaction === e ? 'active' : ''}" data-emoji="${e}" title="${e}">${e} <span class="react-count">${count}</span></button>`;
    }
    return '';
  }).filter(Boolean).join('');
  if (row.innerHTML === html) return; // no change, skip the write entirely
  row.innerHTML = html;
  row.querySelectorAll('.react-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); reactToPost(post.id, btn.dataset.emoji); });
  });
}

function updateCommentCountUI(post) {
  const card = document.querySelector(`.post-card[data-id="${post.id}"]`);
  if (card) {
    const c = card.querySelector('.comment-count'); if (c) c.textContent = (post.comments || []).length;
  }
}

async function reactToPost(postId, emoji) {
  const post = state.posts.find(p => p.id === postId);
  if (!post) return;
  const me = state.user.email;
  if (!post.reactions) post.reactions = {};
  // What's my current reaction?
  const cur = REACTIONS.find(e => post.reactions[e]?.[me]);
  const newE = cur === emoji ? null : emoji;
  // Optimistic update
  for (const e of REACTIONS) {
    if (post.reactions[e]) {
      delete post.reactions[e][me];
      if (Object.keys(post.reactions[e]).length === 0) delete post.reactions[e];
    }
  }
  if (newE) {
    if (!post.reactions[newE]) post.reactions[newE] = {};
    post.reactions[newE][me] = state.user.name;
  }
  // mirror to legacy
  post.upvotes = post.reactions['👍'] || {};
  post.downvotes = post.reactions['👎'] || {};
  updateVoteUI(post);
  try {
    await api('POST', `/api/posts/${postId}/react`, { emoji: newE });
  } catch (e) {
    const msg = e.data?.error || e.message || 'unknown';
    if (msg === 'tos-required') toast('agree to the TOS to react', 5000);
    else if (msg === 'school-email-unverified') toast('verify your school email first — check your inbox', 6000);
    else if (msg === 'timed-out') toast('you\'re timed out — can\'t react right now', 5000);
    else toast('reaction failed: ' + msg, 5000);
  }
}

// Backwards-compat name
const votePost = (id, v) => reactToPost(id, v === 'up' ? '👍' : v === 'down' ? '👎' : null);

async function submitComment(postId, text, anon = false) {
  console.log('[comment] submitting', postId, text.slice(0, 30), anon ? '🥷' : '');
  try {
    const r = await api('POST', `/api/posts/${postId}/comment`, { text, anon });
    console.log('[comment] server response', r);
    // Server returns the comment object directly (with id/author/text).
    const newComment = r && r.id ? r : (r && r.comment) || null;
    if (newComment) {
      const post = state.posts.find(p => p.id === postId);
      if (post) {
        post.comments = post.comments || [];
        if (!post.comments.some(c => c.id === newComment.id)) {
          post.comments.push(newComment);
        }
        // Always re-render the visible list rather than relying on an incremental
        // append — that path had a race where the socket event sometimes lost
        // the round-trip with the HTTP response and the sender saw nothing on
        // their first Enter. Re-rendering is cheap and idempotent.
        if (state.openComments.has(postId)) {
          const card = document.querySelector(`.post-card[data-id="${postId}"]`);
          if (card) renderCommentsList(card, post);
          const detail = document.querySelector(`.post-detail[data-id="${postId}"]`);
          if (detail) {
            renderCommentsList(detail, post);
            const header = detail.querySelector('.post-detail-comments-header');
            if (header) header.textContent = `comments (${post.comments.length})`;
          }
        }
        updateCommentCountUI(post);
      }
    }
  } catch (e) {
    console.error('[comment] failed', e);
    toast('comment failed: ' + (e.data?.error || e.message || 'unknown'), 5000);
  }
}

// =================================================================
// FEED SCREEN SETUP
// =================================================================
function setupFeedScreen() {
  // header + sub-nav buttons (sub-nav handled by data-action below)
  const addBtn = el('add-postit-btn'); if (addBtn) addBtn.addEventListener('click', openAddPostitModal);
  el('logout-btn').addEventListener('click', logout);

  // sidebar actions
  const sidePost = el('sidebar-post-btn');
  const sideRandom = el('sidebar-random-btn');
  const sideRooms = el('sidebar-lobbies-btn');
  if (sidePost) sidePost.addEventListener('click', openAddPostitModal);
  if (sideRandom) sideRandom.addEventListener('click', startRandomChat);
  if (sideRooms) sideRooms.addEventListener('click', openLobbiesModal);

  // inline compose box
  const composeText = el('compose-text');
  const composeSubmit = el('compose-submit');
  const composePhoto = el('compose-photo-btn');
  if (composePhoto) composePhoto.addEventListener('click', () => {
    openAddPostitModal();
    // pre-select the photo tab
    document.querySelectorAll('#add-postit-modal .tab-btn').forEach((b, i) => {
      if (b.dataset.type === 'image') { b.click(); }
    });
  });
  // Compose "Posting as" label flips when anonymous is toggled
  const composeAnon = el('compose-anon');
  if (composeAnon) {
    composeAnon.addEventListener('change', () => {
      const nameSpan = el('compose-name');
      if (!nameSpan || !state.user) return;
      nameSpan.textContent = composeAnon.checked ? 'anonymous 🥷' : state.user.name;
      nameSpan.style.color = composeAnon.checked ? '#999' : '';
      nameSpan.style.fontStyle = composeAnon.checked ? 'italic' : '';
    });
  }
  if (composeSubmit) {
    composeSubmit.addEventListener('click', async () => {
      const text = composeText.value.trim();
      const gif = state._composeGifUrl || '';
      // Need at least a body (text, gif, or both)
      if (!text && !gif) { toast('write something or pick a gif'); composeText.focus(); return; }
      const ephemeral = !!el('compose-ephemeral')?.checked;
      const anon = !!el('compose-anon')?.checked;
      const roomRowOn = !el('compose-room-row')?.classList.contains('hidden');
      const body = { ephemeral, anon };
      // If a GIF is attached, post as IMAGE with caption=text
      if (gif) {
        body.type = 'image';
        body.content = gif;
        body.caption = text;
      } else {
        body.type = 'text';
        body.content = text;
      }
      if (roomRowOn) {
        const mode = el('compose-room-mode')?.value;
        if (mode === 'existing') {
          const rid = el('compose-room-existing')?.value;
          if (rid) body.roomId = rid;
        } else {
          const nm = el('compose-room-name')?.value.trim();
          if (nm) body.newRoomName = nm;
        }
      }
      composeSubmit.disabled = true;
      composeSubmit.textContent = 'posting…';
      try {
        await api('POST', '/api/posts', body);
        composeText.value = '';
        state._composeGifUrl = '';
        const gifPreview = el('compose-gif-preview');
        if (gifPreview) { gifPreview.innerHTML = ''; gifPreview.classList.add('hidden'); }
        el('compose-room-row')?.classList.add('hidden');
        if (el('compose-room-name')) el('compose-room-name').value = '';
        if (el('compose-ephemeral')) el('compose-ephemeral').checked = false;
        if (el('compose-anon')) el('compose-anon').checked = false;
        const tags = [];
        if (anon) tags.push('anonymous 🥷');
        if (ephemeral) tags.push('24h only ⏱');
        if (body.roomId || body.newRoomName) tags.push('🎥 room');
        if (gif) tags.push('🎞 gif');
        toast(tags.length ? `posted (${tags.join(' · ')})` : 'posted');
      } catch (e) {
        toast(e.data?.error || 'post failed');
      } finally {
        composeSubmit.disabled = false;
        composeSubmit.textContent = 'Post';
      }
    });
  }
  // Compose room attach toggle
  const composeRoomBtn = el('compose-room-btn');
  if (composeRoomBtn) {
    composeRoomBtn.addEventListener('click', async () => {
      const row = el('compose-room-row');
      const open = row.classList.toggle('hidden') === false;
      if (open) {
        // Load existing rooms
        try {
          const rooms = await api('GET', '/api/rooms');
          const sel = el('compose-room-existing');
          sel.innerHTML = '<option value="">— pick —</option>' +
            (rooms || []).map(r => `<option value="${escapeAttr(r.id)}">${escapeHtml(r.name)} (${r.memberCount})</option>`).join('');
        } catch {}
      }
    });
  }
  const composeRoomMode = el('compose-room-mode');
  if (composeRoomMode) {
    composeRoomMode.addEventListener('change', () => {
      const m = composeRoomMode.value;
      el('compose-room-name')?.classList.toggle('hidden', m !== 'new');
      el('compose-room-existing')?.classList.toggle('hidden', m !== 'existing');
    });
  }
  const composeRoomCancel = el('compose-room-cancel');
  if (composeRoomCancel) {
    composeRoomCancel.addEventListener('click', () => el('compose-room-row')?.classList.add('hidden'));
  }
  // GIF picker
  const composeGifBtn = el('compose-gif-btn');
  if (composeGifBtn) composeGifBtn.addEventListener('click', openGifPicker);
  // Setup the GIF picker modal once
  setupGifPicker();

  // Invite friends — native share (falls back to clipboard copy on desktop)
  const inviteBtn = el('invite-share-btn');
  if (inviteBtn) {
    inviteBtn.addEventListener('click', async () => {
      const url = 'https://old-streets.fly.dev';
      const myFirst = (state.user?.name || '').split(' ')[0] || '';
      const text = `${myFirst ? myFirst + ' wants you on ' : 'come check out '}Old Streets — it's a private wall + video chat for Old Streets members only. join here:`;
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Old Streets', text, url });
          toast('thanks for sharing 🫶');
        } catch (e) {
          if (e.name !== 'AbortError') console.warn('share failed', e);
        }
      } else {
        // Desktop fallback — copy link
        try {
          await navigator.clipboard.writeText(`${text} ${url}`);
          toast('invite copied to clipboard — paste it anywhere');
        } catch {
          toast('share not supported on this browser');
        }
      }
    });
  }
  // return banner dismiss
  const banner = el('return-banner');
  const bDismiss = el('return-banner-dismiss');
  if (bDismiss) bDismiss.addEventListener('click', () => banner?.classList.add('hidden'));
  if (composeText) composeText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) composeSubmit.click();
  });

  // top + sub nav: navigate to wall
  document.querySelectorAll('[data-scroll="wall"]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateToWall();
      const main = document.querySelector('.fb-main');
      if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  // back buttons inside post/profile views
  document.querySelectorAll('.back-btn[data-back="wall"]').forEach(btn => {
    btn.addEventListener('click', () => navigateToWall());
  });
  document.querySelectorAll('.sub-nav-link[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'post') openAddPostitModal();
      else if (action === 'random') startRandomChat();
      else if (action === 'rooms') openLobbiesModal();
      else if (action === 'love-letter') openLoveLetterModal();
      else if (action === 'bulletin') openBulletinModal();
      else if (action === 'blog') openBlogComposer();
      else if (action === 'survey') openSurveyComposer();
      else if (action === 'my-profile') {
        if (state.user?.email) navigateToProfile(state.user.email);
        else toast('still loading…');
      }
      else if (action === 'friends') openFriendsView();
      else if (action === 'wall') navigateToWall();
      else if (action === 'daily') openDailyView();
      else if (action === 'night') openNightView();
      else if (action === 'messages') openInbox();
    });
  });

  // Also make the sidebar profile card click → your profile
  const profileCard = document.querySelector('.profile-card');
  if (profileCard) {
    profileCard.style.cursor = 'pointer';
    profileCard.addEventListener('click', (e) => {
      // don't hijack inner button clicks
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A') return;
      if (state.user?.email) navigateToProfile(state.user.email);
    });
  }

  // sort
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const prev = state.sortMode;
      state.sortMode = btn.dataset.sort;
      // For You requires a fresh server fetch (personalised ranking); so does
      // switching away from it (to get the plain chronological list back).
      if (state.sortMode === 'foryou' || prev === 'foryou') {
        loadPosts();
      } else {
        renderFeed();
      }
    });
  });

  // search (MySpace-style: scope dropdown routes the query)
  const searchInput = el('feed-search');
  const searchClear = el('feed-search-clear');
  const searchScope = el('feed-search-scope');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    searchClear.classList.toggle('hidden', !state.searchQuery);
    runScopedSearch();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchClear.classList.add('hidden');
    renderFeed();
    searchInput.focus();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') searchClear.click();
    if (e.key === 'Enter') runScopedSearch(true);
  });
  if (searchScope) searchScope.addEventListener('change', () => runScopedSearch(true));

  function runScopedSearch(focusResults) {
    const scope = (searchScope && searchScope.value) || 'people';
    const q = state.searchQuery.trim();
    if (!q) { renderFeed(); return; }
    if (scope === 'posts') {
      renderFeed();
    } else if (scope === 'people') {
      openFriendsView();
      const fSearch = el('friends-search');
      if (fSearch) {
        fSearch.value = q;
        fSearch.dispatchEvent(new Event('input', { bubbles: true }));
        if (focusResults) fSearch.focus();
      }
    } else if (scope === 'blogs') {
      el('blogs-box')?.scrollIntoView({ behavior: 'smooth' });
    } else if (scope === 'bulletins') {
      el('bulletins-box')?.scrollIntoView({ behavior: 'smooth' });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
    if (e.key === '/' &&
        document.activeElement.tagName !== 'INPUT' &&
        document.activeElement.tagName !== 'TEXTAREA') {
      const screen = document.querySelector('.screen.active');
      if (screen && screen.id === 'board-screen') {
        e.preventDefault();
        searchInput.focus();
      }
    }
  });
}

// =================================================================
// MODALS
// =================================================================
function setupModals() {
  // close via X button
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => el(btn.dataset.close).classList.add('hidden'));
  });
  // also handle any [data-close] (e.g. "Got it" buttons inside about/terms)
  document.querySelectorAll('[data-close]').forEach(btn => {
    if (btn.classList.contains('modal-close')) return; // already wired
    btn.addEventListener('click', () => el(btn.dataset.close).classList.add('hidden'));
  });
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });
  setupAddPostit();
  setupRoomsModal();
}
function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

// =================================================================
// ADD POST
// =================================================================
function setupAddPostit() {
  document.querySelectorAll('#add-postit-modal .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#add-postit-modal .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.postitType = btn.dataset.type;
      el('postit-text').classList.toggle('hidden', state.postitType !== 'text');
      el('postit-file-area').classList.toggle('hidden', state.postitType === 'text');
      el('postit-file-preview').innerHTML = '';
      state.postitFile = null;
    });
  });

  el('postit-file').addEventListener('change', (e) => {
    loadPostitFile(e.target.files[0], e.target);
  });

  // Drag-and-drop: the whole composer modal is a drop target. Drop an image
  // or video anywhere on the modal and it gets attached. Auto-switches to
  // the right tab (image vs video) based on the file type.
  const modal = el('add-postit-modal');
  if (modal && !modal._dndWired) {
    modal._dndWired = true;
    const dropZone = el('postit-file-area') || modal;
    let dragCount = 0;
    const setDragging = (on) => modal.classList.toggle('drag-over', on);
    modal.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dragCount++;
      setDragging(true);
    });
    modal.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    modal.addEventListener('dragleave', (e) => {
      dragCount = Math.max(0, dragCount - 1);
      if (dragCount === 0) setDragging(false);
    });
    modal.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      dragCount = 0;
      setDragging(false);
      const file = e.dataTransfer.files[0];
      // Auto-flip to the right tab based on file type
      const isImage = (file.type || '').startsWith('image/');
      const isVideo = (file.type || '').startsWith('video/');
      if (isImage || isVideo) {
        const targetTab = document.querySelector(`#add-postit-modal .tab-btn[data-type="${isImage ? 'image' : 'video'}"]`);
        if (targetTab && !targetTab.classList.contains('active')) targetTab.click();
      }
      loadPostitFile(file, el('postit-file'));
    });
  }

  // Paste support: cmd/ctrl-V an image/video into the composer.
  if (modal && !modal._pasteWired) {
    modal._pasteWired = true;
    modal.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.kind !== 'file') continue;
        const file = it.getAsFile();
        if (!file) continue;
        const isImage = (file.type || '').startsWith('image/');
        const isVideo = (file.type || '').startsWith('video/');
        if (!isImage && !isVideo) continue;
        const targetTab = document.querySelector(`#add-postit-modal .tab-btn[data-type="${isImage ? 'image' : 'video'}"]`);
        if (targetTab && !targetTab.classList.contains('active')) targetTab.click();
        loadPostitFile(file, el('postit-file'));
        e.preventDefault();
        break;
      }
    });
  }

  el('postit-submit').addEventListener('click', submitPostit);

  // Global drag target: dropping a file anywhere on the page opens the
  // composer with the file pre-attached. Skipped if the user is already
  // dragging into the composer (handled above) or another upload zone.
  if (!document.body._globalDropWired) {
    document.body._globalDropWired = true;
    let globalDragCount = 0;
    const overlay = document.createElement('div');
    overlay.id = 'global-drop-overlay';
    overlay.innerHTML = '<div class="global-drop-card">📂 drop to post — photo or video</div>';
    document.body.appendChild(overlay);
    const showOverlay = (on) => overlay.classList.toggle('on', on);
    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      // If the composer is open, its own handler covers it
      if (!el('add-postit-modal').classList.contains('hidden')) return;
      // Skip if dragging over an input/textarea — likely a text drag
      if (e.target.closest('input,textarea')) return;
      e.preventDefault();
      globalDragCount++;
      showOverlay(true);
    });
    document.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      if (!el('add-postit-modal').classList.contains('hidden')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (e) => {
      globalDragCount = Math.max(0, globalDragCount - 1);
      if (globalDragCount === 0) showOverlay(false);
    });
    document.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      if (!el('add-postit-modal').classList.contains('hidden')) return;
      e.preventDefault();
      globalDragCount = 0;
      showOverlay(false);
      const file = e.dataTransfer.files[0];
      const isImage = (file.type || '').startsWith('image/');
      const isVideo = (file.type || '').startsWith('video/');
      if (!isImage && !isVideo) return;
      openAddPostitModal();
      setTimeout(() => loadPostitFile(file, el('postit-file')), 50);
    });
  }
}

// =================================================================
// REPOST WITH COMMENT
// =================================================================
function buildRepostCardHTML(orig) {
  if (!orig) return '';
  if (orig.deleted) return `<div class="repost-card deleted">[original post was deleted]</div>`;
  const isImg = orig.type === 'image';
  const isVid = orig.type === 'video';
  const media = isImg
    ? `<img class="repost-media" src="${escapeAttr(orig.content)}" alt=""/>`
    : isVid
      ? `<video class="repost-media" src="${escapeAttr(orig.content)}" muted playsinline controls></video>`
      : '';
  const caption = (isImg || isVid) ? (orig.caption || '') : (orig.content || '');
  const isAnon = !!orig.isAnonymous;
  // Twitter-style: small avatar + name + @handle + dot + time, then body
  const handle = isAnon ? 'anonymous' : ((orig.authorEmail || '').split('@')[0] || '');
  const avatarHtml = isAnon
    ? `<div class="repost-card-avatar anon">🥷</div>`
    : (orig.authorAvatar
        ? `<img class="repost-card-avatar" src="${escapeAttr(orig.authorAvatar)}" alt=""/>`
        : `<div class="repost-card-avatar letter">${escapeHtml((orig.author || '?').charAt(0).toUpperCase())}</div>`);
  return `
    <div class="repost-card" data-orig-id="${escapeAttr(orig.id)}">
      <div class="repost-card-header">
        ${avatarHtml}
        <span class="repost-card-author ${isAnon ? 'anon' : ''}" data-email="${escapeAttr(orig.authorEmail || '')}">${escapeHtml(orig.author || '?')}</span>
        ${!isAnon && handle ? `<span class="repost-card-handle">@${escapeHtml(handle)}</span>` : ''}
        <span class="repost-card-sep">·</span>
        <span class="repost-card-time">${escapeHtml(timeAgo(orig.createdAt))}</span>
      </div>
      ${caption ? `<div class="repost-card-body">${linkify(escapeHtml(caption.slice(0, 280)))}${caption.length > 280 ? '…' : ''}</div>` : ''}
      ${media}
    </div>
  `;
}

function openRepostModal(post) {
  if (!post) return;
  // Always repost the ROOT original — never nest reposts.
  const original = post.repostOf && !post.repostOf.deleted ? post.repostOf : {
    id: post.id,
    author: post.isAnonymous ? 'anonymous' : post.author,
    authorEmail: post.isAnonymous ? '' : post.authorEmail,
    isAnonymous: !!post.isAnonymous,
    type: post.type,
    content: post.content,
    caption: post.caption,
    createdAt: post.createdAt
  };
  const modal = el('repost-modal');
  if (!modal) return;
  el('repost-preview').innerHTML = buildRepostCardHTML(original);
  el('repost-comment').value = '';
  if (el('repost-anon')) el('repost-anon').checked = false;
  // Show my avatar in the composer
  const meAv = el('repost-me-avatar');
  if (meAv) {
    if (state.user?.avatar) {
      meAv.innerHTML = `<img src="${escapeAttr(state.user.avatar)}" alt=""/>`;
    } else {
      meAv.innerHTML = `<span>${escapeHtml((state.user?.name || '?').charAt(0).toUpperCase())}</span>`;
    }
  }
  modal.classList.remove('hidden');
  // Focus the textarea after open
  setTimeout(() => el('repost-comment')?.focus(), 50);
  modal.querySelectorAll('[data-close]').forEach(b => {
    if (b._repostWired) return;
    b._repostWired = true;
    b.addEventListener('click', () => modal.classList.add('hidden'));
  });
  const submit = el('repost-submit');
  // Bind fresh — easier to track current post
  submit.onclick = async () => {
    const comment = el('repost-comment').value.trim();
    const anon = !!el('repost-anon')?.checked;
    submit.disabled = true;
    submit.textContent = 'reposting…';
    try {
      await api('POST', '/api/posts', {
        type: 'text',
        content: comment, // can be empty for a pure repost
        anon,
        repostOf: original.id
      });
      modal.classList.add('hidden');
      toast(comment ? 'reposted with your take 🔁' : 'reposted 🔁');
    } catch (e) {
      toast('repost failed: ' + (e.data?.error || 'unknown'), 5000);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Repost →';
    }
  };
}

// Shared loader — picks up files from the file input, a drop, or a paste.
async function loadPostitFile(file, inputEl) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    toast(`file too big — ${(file.size / 1024 / 1024).toFixed(1)}mb. max is 25mb.`, 5000);
    if (inputEl) inputEl.value = '';
    return;
  }
  if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '')) {
    toast('iPhone HEIC images don\'t work in browsers — convert to JPG/PNG first (Photos → Edit → File Type).', 7000);
    if (inputEl) inputEl.value = '';
    return;
  }
  try {
    const dataUrl = await fileToDataURL(file);
    state.postitFile = { dataUrl, file, mime: file.type };
    const preview = el('postit-file-preview');
    if (preview) preview.innerHTML = '';
    if (file.type.startsWith('image/')) {
      // Make sure the image tab is active so the preview is visible
      const imgTab = document.querySelector('#add-postit-modal .tab-btn[data-type="image"]');
      if (imgTab && !imgTab.classList.contains('active')) imgTab.click();
      const img = document.createElement('img');
      img.src = dataUrl;
      preview && preview.appendChild(img);
    } else if (file.type.startsWith('video/')) {
      const vidTab = document.querySelector('#add-postit-modal .tab-btn[data-type="video"]');
      if (vidTab && !vidTab.classList.contains('active')) vidTab.click();
      const vid = document.createElement('video');
      vid.src = dataUrl;
      vid.controls = true;
      vid.muted = true;
      vid.playsInline = true;
      preview && preview.appendChild(vid);
    } else {
      toast('unsupported file type — pick an image or video');
      if (inputEl) inputEl.value = '';
      state.postitFile = null;
      return;
    }
    toast('attached — drop another to replace, or hit Post', 3000);
  } catch (err) {
    toast('couldn\'t read that file — try a different one', 5000);
    console.warn('file read failed:', err);
  }
}

// =================================================================
// GIF PICKER — Tenor v2 public API (no key needed for low volume)
// =================================================================
let _gifSearchTimer = null;
function setupGifPicker() {
  const modal = el('gif-picker-modal');
  if (!modal || modal._wired) return;
  modal._wired = true;
  // Close on backdrop click + ✕
  modal.addEventListener('click', e => { if (e.target.id === 'gif-picker-modal') modal.classList.add('hidden'); });
  modal.querySelector('[data-close]')?.addEventListener('click', () => modal.classList.add('hidden'));
  const search = el('gif-search');
  search?.addEventListener('input', () => {
    clearTimeout(_gifSearchTimer);
    _gifSearchTimer = setTimeout(() => runGifSearch(search.value.trim()), 350);
  });
}

function openGifPicker() {
  const modal = el('gif-picker-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  el('gif-search').value = '';
  setTimeout(() => el('gif-search')?.focus(), 80);
  // Load trending GIFs by default
  runGifSearch('');
}

async function runGifSearch(query) {
  const results = el('gif-results');
  if (!results) return;
  results.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-3);">loading…</div>';
  // Tenor v2 public endpoint — anonymous works for low volume.
  // Use 'old-streets' as client_key for analytics.
  const base = query
    ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&media_filter=tinygif&limit=24&client_key=oldstreets&key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ`
    : `https://tenor.googleapis.com/v2/featured?media_filter=tinygif&limit=24&client_key=oldstreets&key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ`;
  try {
    const r = await fetch(base);
    const data = await r.json();
    if (!data || !Array.isArray(data.results)) throw new Error('bad response');
    if (data.results.length === 0) {
      results.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-3);">no matches</div>';
      return;
    }
    results.innerHTML = data.results.map(g => {
      const tiny = g.media_formats?.tinygif?.url || g.media_formats?.nanogif?.url;
      const full = g.media_formats?.gif?.url || tiny;
      if (!tiny || !full) return '';
      return `<button class="gif-result" data-full="${escapeAttr(full)}"><img src="${escapeAttr(tiny)}" alt="" loading="lazy"/></button>`;
    }).join('');
    results.querySelectorAll('.gif-result').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.full;
        state._composeGifUrl = url;
        const preview = el('compose-gif-preview');
        if (preview) {
          preview.innerHTML = `<img src="${escapeAttr(url)}" alt=""/><button class="compose-gif-remove" title="remove gif">✕</button>`;
          preview.classList.remove('hidden');
          preview.querySelector('.compose-gif-remove').addEventListener('click', () => {
            state._composeGifUrl = '';
            preview.innerHTML = '';
            preview.classList.add('hidden');
          });
        }
        el('gif-picker-modal').classList.add('hidden');
        toast('🎞 gif attached — click Post to send');
      });
    });
  } catch (e) {
    console.warn('gif search failed', e);
    results.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-3);">gif search unavailable right now</div>';
  }
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Compress an image File down to <= targetBytes. Scales to maxDim and
// re-encodes as JPEG, walking quality down if needed. HEIC/non-image
// files just fall through as raw data-URLs (browser may still read them).
async function compressImageToDataURL(file, maxDim = 512, quality = 0.85, targetBytes = 480 * 1024) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    return fileToDataURL(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let q = quality;
    let out = canvas.toDataURL('image/jpeg', q);
    // Walk quality down if still too big
    while (out.length > targetBytes && q > 0.4) {
      q -= 0.1;
      out = canvas.toDataURL('image/jpeg', q);
    }
    // Still too big? Shrink dims further
    let curDim = maxDim;
    while (out.length > targetBytes && curDim > 128) {
      curDim = Math.round(curDim * 0.8);
      const s = Math.min(1, curDim / Math.max(img.naturalWidth, img.naturalHeight));
      const nw = Math.max(1, Math.round(img.naturalWidth * s));
      const nh = Math.max(1, Math.round(img.naturalHeight * s));
      canvas.width = nw; canvas.height = nh;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, nw, nh);
      ctx.drawImage(img, 0, 0, nw, nh);
      out = canvas.toDataURL('image/jpeg', 0.75);
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openAddPostitModal() {
  el('postit-text').value = '';
  el('postit-caption').value = '';
  el('postit-file').value = '';
  el('postit-file-preview').innerHTML = '';
  state.postitFile = null;
  state.postitType = 'text';
  document.querySelectorAll('#add-postit-modal .tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  el('postit-text').classList.remove('hidden');
  el('postit-file-area').classList.add('hidden');
  if (el('modal-anon')) el('modal-anon').checked = false;
  // Reset room attachment controls
  const ar = el('postit-attach-room'); if (ar) ar.checked = false;
  el('postit-room-options')?.classList.add('hidden');
  if (el('postit-room-name')) el('postit-room-name').value = '';
  if (el('postit-room-mode')) el('postit-room-mode').value = 'new';
  el('postit-room-name')?.classList.remove('hidden');
  el('postit-room-existing')?.classList.add('hidden');
  // Wire toggle + mode change once
  setupRoomAttachmentControls();
  el('add-postit-modal').classList.remove('hidden');
  setTimeout(() => el('postit-text').focus(), 100);
}

function setupRoomAttachmentControls() {
  const toggle = el('postit-attach-room');
  const opts = el('postit-room-options');
  const modeSel = el('postit-room-mode');
  const nameInp = el('postit-room-name');
  const existSel = el('postit-room-existing');
  if (toggle && !toggle._wired) {
    toggle._wired = true;
    toggle.addEventListener('change', async () => {
      opts.classList.toggle('hidden', !toggle.checked);
      if (toggle.checked) {
        // Load existing rooms so the dropdown is ready if user switches mode
        try {
          const rooms = await api('GET', '/api/rooms');
          existSel.innerHTML = '<option value="">— pick a room —</option>' +
            (rooms || []).map(r => `<option value="${escapeAttr(r.id)}">${escapeHtml(r.name)} (${r.memberCount} in)</option>`).join('');
        } catch {}
      }
    });
  }
  if (modeSel && !modeSel._wired) {
    modeSel._wired = true;
    modeSel.addEventListener('change', () => {
      const m = modeSel.value;
      nameInp.classList.toggle('hidden', m !== 'new');
      existSel.classList.toggle('hidden', m !== 'existing');
    });
  }
}

// NSFW moderation — uses nsfwjs (loaded via CDN) to scan images and video
// frames before upload. Blocks anything where Porn or Hentai exceeds 0.6.
// Sexy alone is allowed (bikinis, etc.) — only explicit content is blocked.
let _nsfwModel = null;
let _nsfwLoading = null;
async function getNsfwModel() {
  if (_nsfwModel) return _nsfwModel;
  if (!window.nsfwjs) return null;
  if (!_nsfwLoading) {
    _nsfwLoading = window.nsfwjs.load().then(m => { _nsfwModel = m; return m; }).catch(e => {
      console.warn('nsfw model load failed', e);
      _nsfwLoading = null;
      return null;
    });
  }
  return _nsfwLoading;
}

function _nsfwVerdict(preds) {
  const p = {}; (preds || []).forEach(x => { p[x.className] = x.probability; });
  const porn = (p.Porn || 0) + (p.Hentai || 0);
  const sexyHigh = (p.Sexy || 0) >= 0.85;
  return { blocked: porn >= 0.45 || sexyHigh, porn };
}

async function checkImageBlobNSFW(blob) {
  const model = await getNsfwModel();
  if (!model) return { blocked: false }; // fail-open if model couldn't load
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const preds = await model.classify(img);
    return _nsfwVerdict(preds);
  } catch (e) {
    console.warn('nsfw check failed', e);
    return { blocked: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function checkVideoBlobNSFW(blob) {
  const model = await getNsfwModel();
  if (!model) return { blocked: false };
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement('video');
    v.src = url; v.muted = true; v.playsInline = true; v.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = reject;
    });
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const samples = dur > 0 ? [0.1, 0.35, 0.6, 0.85].map(f => dur * f) : [0];
    const canvas = document.createElement('canvas');
    canvas.width = 224; canvas.height = 224;
    const ctx = canvas.getContext('2d');
    for (const t of samples) {
      await new Promise((resolve) => {
        const onSeeked = () => { v.removeEventListener('seeked', onSeeked); resolve(); };
        v.addEventListener('seeked', onSeeked);
        try { v.currentTime = t; } catch { resolve(); }
      });
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const preds = await model.classify(canvas);
      const verdict = _nsfwVerdict(preds);
      if (verdict.blocked) return verdict;
    }
    return { blocked: false };
  } catch (e) {
    console.warn('video nsfw check failed', e);
    return { blocked: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function submitPostit() {
  let content;
  let caption = '';
  if (state.postitType === 'text') {
    content = el('postit-text').value.trim();
    if (!content) { toast('write something'); return; }
  } else {
    if (!state.postitFile) { toast('pick a file first'); return; }
    caption = el('postit-caption').value.trim();
  }
  const anon = !!el('modal-anon')?.checked;
  const submitBtn = el('postit-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'posting…';
  try {
    // For image/video: upload the raw file first to /api/uploads (streaming)
    // and use the returned URL as the post's content. This bypasses the
    // proxy 403 that strips huge base64 JSON bodies.
    if (state.postitType !== 'text') {
      submitBtn.textContent = 'scanning…';
      let fileObj = state.postitFile.file;
      let mime = state.postitFile.mime || fileObj.type;
      try {
        const verdict = mime.startsWith('video/')
          ? await checkVideoBlobNSFW(fileObj)
          : (mime.startsWith('image/') ? await checkImageBlobNSFW(fileObj) : { blocked: false });
        if (verdict.blocked) {
          throw new Error('explicit content detected — this post was blocked. nudity/porn is not allowed here.');
        }
      } catch (e) {
        if (e.message && e.message.startsWith('explicit content')) throw e;
        console.warn('nsfw scan errored, allowing post', e);
      }
      submitBtn.textContent = 'uploading…';
      // For images: pre-compress in the browser so we never send a 10MB+
      // body that Lander's edge proxy might reject. (Skip for video — too
      // expensive to re-encode client-side without ffmpeg.)
      if (mime.startsWith('image/') && fileObj.size > 1.5 * 1024 * 1024) {
        try {
          const dataUrl = await compressImageToDataURL(fileObj, 1280, 0.85, 1.5 * 1024 * 1024);
          // Convert data URL back to a Blob for upload.
          const r2 = await fetch(dataUrl);
          fileObj = await r2.blob();
          mime = 'image/jpeg';
        } catch (e) {
          console.warn('image compress failed, sending original', e);
        }
      }
      // Use application/octet-stream + X-File-Mime header. Many edge proxies
      // (Lander/Cloudflare) reject POSTs with image/* content-type as a
      // "suspicious upload pattern" — octet-stream bypasses that path.
      const r = await fetch('/api/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Mime': mime,
          'X-User-Token': state.token || ''
        },
        body: fileObj
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data.error || ('upload HTTP ' + r.status);
        throw new Error(msg);
      }
      content = data.url;
      submitBtn.textContent = 'posting…';
    }
    // Room attachment
    const body = { type: state.postitType, content, caption, anon };
    if (el('postit-attach-room')?.checked) {
      const mode = el('postit-room-mode')?.value;
      if (mode === 'existing') {
        const rid = el('postit-room-existing')?.value;
        if (rid) body.roomId = rid;
      } else {
        const nm = el('postit-room-name')?.value.trim();
        if (nm) body.newRoomName = nm;
      }
    }
    await api('POST', '/api/posts', body);
    el('add-postit-modal').classList.add('hidden');
    toast(anon ? 'posted anonymously 🥷' : (body.roomId || body.newRoomName ? 'posted + room attached 🎥' : 'posted'));
    if (!anon) setTimeout(() => toast('nice post — now tell a friend to get on here 👀', 4500), 2800);
  } catch (e) {
    const msg = e.data?.error || e.message || 'post failed';
    toast('post failed: ' + msg, 6000);
    console.error('post failed:', e);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Post →';
  }
}

// =================================================================
// ROOMS (was lobbies)
// =================================================================
function setupRoomsModal() {
  el('create-lobby-btn').addEventListener('click', () => {
    el('lobbies-modal').classList.add('hidden');
    el('lobby-name-input').value = '';
    el('create-lobby-modal').classList.remove('hidden');
    setTimeout(() => el('lobby-name-input').focus(), 100);
  });
  el('lobby-create-submit').addEventListener('click', () => {
    const name = el('lobby-name-input').value.trim();
    if (!name) { toast('give it a name'); return; }
    state.socket.emit('create-room', { name });
  });
  el('lobby-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('lobby-create-submit').click();
  });
  el('copy-link-btn').addEventListener('click', async () => {
    const link = el('lobby-link').value;
    try { await navigator.clipboard.writeText(link); toast('copied'); }
    catch { el('lobby-link').select(); document.execCommand('copy'); toast('copied'); }
  });
  el('join-lobby-btn').addEventListener('click', () => {
    const roomId = el('join-lobby-btn').dataset.lobbyId;
    el('lobby-created-modal').classList.add('hidden');
    if (roomId) joinRoom(roomId);
  });
}

function openLobbiesModal() {
  el('lobbies-modal').classList.remove('hidden');
  state.socket.emit('get-rooms');
}

function renderLobbiesList(rooms) {
  const list = el('lobbies-list');
  list.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    list.innerHTML = '<p class="empty-state">No rooms right now — be the first.</p>';
  } else {
    for (const room of rooms) {
      const card = document.createElement('div');
      card.className = 'lobby-card';
      card.innerHTML = `
        <div class="lobby-card-info">
          <div class="lobby-card-name">${escapeHtml(room.name)}</div>
          <div class="lobby-card-meta">by ${escapeHtml(room.createdBy)} · ${room.memberCount} ppl</div>
        </div>
      `;
      const joinBtn = document.createElement('button');
      joinBtn.className = 'scribble-button';
      joinBtn.textContent = 'Join →';
      joinBtn.addEventListener('click', () => {
        el('lobbies-modal').classList.add('hidden');
        joinRoom(room.id);
      });
      card.appendChild(joinBtn);
      list.appendChild(card);
    }
  }

  // top live rail
  const rail = el('live-rail');
  if (rail) {
    rail.querySelectorAll('.live-rail-pill').forEach(p => p.remove());
    const empty = el('live-rail-empty');
    if (!rooms || rooms.length === 0) {
      if (empty) empty.style.display = '';
    } else {
      if (empty) empty.style.display = 'none';
      for (const room of rooms.slice(0, 4)) {
        const pill = document.createElement('span');
        pill.className = 'live-rail-pill';
        pill.innerHTML = `${escapeHtml(room.name)} <span class="count">${room.memberCount}</span>`;
        pill.addEventListener('click', () => joinRoom(room.id));
        rail.appendChild(pill);
      }
    }
  }

  // sidebar
  const sideList = el('sidebar-lobbies-list');
  if (sideList) {
    sideList.innerHTML = '';
    if (!rooms || rooms.length === 0) {
      sideList.innerHTML = '<p class="empty-state" style="padding: 8px 10px; text-align: left; font-size: 11px;">no rooms right now</p>';
    } else {
      const ul = document.createElement('ul');
      ul.style.cssText = 'list-style:none; padding:0; margin:0;';
      for (const room of rooms.slice(0, 6)) {
        const li = document.createElement('li');
        li.style.cssText = 'padding: 5px 10px; border-bottom: 1px dotted var(--border-light); display:flex; align-items:center; gap:6px; cursor:pointer; font-size: 11px;';
        li.innerHTML = `
          <span class="dot" style="background: var(--bad);"></span>
          <span style="flex:1; color:var(--link); font-weight: bold; word-break: break-word;">${escapeHtml(room.name)}</span>
          <span style="font-size: 10px; color: var(--text-3);">${room.memberCount}</span>
        `;
        li.addEventListener('click', () => joinRoom(room.id));
        ul.appendChild(li);
      }
      sideList.appendChild(ul);
    }
  }
}

function setupRoomHandlers() {
  state.socket.on('room-created', ({ roomId, name }) => {
    el('create-lobby-modal').classList.add('hidden');
    el('lobby-created-name').textContent = name;
    const link = `${window.location.origin}/#room=${roomId}`;
    el('lobby-link').value = link;
    el('join-lobby-btn').dataset.lobbyId = roomId;
    el('lobby-created-modal').classList.remove('hidden');
  });
  state.socket.on('room-error', (msg) => toast(msg));

  state.socket.on('room-joined', ({ roomId, name, members }) => {
    openChatOverlay({ type: 'room', id: roomId, name });
    for (const member of members) addPeer(member.socketId, member.username, true);
    addChatMessage({ system: true, message: `you joined "${name}"` });
  });

  state.socket.on('room-member-joined', ({ socketId, username }) => {
    if (state.currentRoom?.type !== 'room') return;
    addPeer(socketId, username, false);
    addChatMessage({ system: true, message: `${username} joined` });
  });

  state.socket.on('room-member-left', ({ socketId }) => {
    if (state.currentRoom?.type !== 'room') return;
    const peer = state.currentRoom.peers.get(socketId);
    if (peer) {
      addChatMessage({ system: true, message: `${peer.name} left` });
      removePeer(socketId);
    }
  });
}

async function joinRoom(roomId) {
  const ok = await ensureCamera();
  if (!ok) return;
  if (state.currentRoom) endCurrentChat({ keepCamera: true });
  state.socket.emit('join-room', { roomId });
  broadcastActivity({ kind: 'room', label: 'in a video room', ref: roomId });
}

// =================================================================
// RANDOM CHAT
// =================================================================
function setupRandomChatHandlers() {
  state.socket.on('random-chat-waiting', () => toast('waiting for someone…', 5000));
  state.socket.on('random-chat-matched', ({ roomId, peer, initiator }) => {
    hideOmegleWaiting();
    openChatOverlay({ type: 'random', id: roomId, name: 'random video chat · ' + peer.username });
    addPeer(peer.socketId, peer.username, initiator);
    addChatMessage({ system: true, message: `matched with ${peer.username}` });
  });
  state.socket.on('peer-left', ({ socketId }) => {
    if (!state.currentRoom) return;
    const peer = state.currentRoom.peers.get(socketId);
    if (peer) {
      addChatMessage({ system: true, message: `${peer.name} disconnected` });
      removePeer(socketId);
      if (state.currentRoom.type === 'random' && state.currentRoom.peers.size === 0) {
        addChatMessage({ system: true, message: 'they left. ending.' });
        setTimeout(endCurrentChat, 1500);
      }
    }
  });
}

async function startRandomChat() {
  if (state.currentRoom) { toast('already in a chat'); return; }
  if (state.featureStatus?.random && !state.featureStatus.random.unlocked) {
    toast('🔒 omegle unlocks after you make 1 post');
    return;
  }
  const ok = await ensureCamera();
  if (!ok) return;
  state.socket.emit('random-chat-request');
  showOmegleWaiting();
}

// Modal-ish overlay: "looking for someone…" with a Stop Waiting button so
// users aren't stuck in queue forever.
function showOmegleWaiting() {
  let wait = document.getElementById('omegle-waiting');
  if (!wait) {
    wait = document.createElement('div');
    wait.id = 'omegle-waiting';
    wait.innerHTML = `
      <div class="omegle-waiting-card">
        <div class="omegle-waiting-spinner">🎥</div>
        <div class="omegle-waiting-title">Looking for someone…</div>
        <div class="omegle-waiting-sub">we'll pair you up as soon as another person hits the queue.</div>
        <button id="omegle-stop-waiting" class="auth-btn">Stop waiting</button>
      </div>
    `;
    document.body.appendChild(wait);
    document.getElementById('omegle-stop-waiting').addEventListener('click', () => {
      try { state.socket.emit('random-chat-cancel'); } catch {}
      hideOmegleWaiting();
      toast('left the queue');
    });
  }
  wait.classList.add('on');
}
function hideOmegleWaiting() {
  const wait = document.getElementById('omegle-waiting');
  if (wait) wait.classList.remove('on');
}

// =================================================================
// WEBRTC
// =================================================================
const RTC_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};

function setupWebRTCHandlers() {
  state.socket.on('webrtc-offer', async ({ from, fromName, offer }) => {
    let peer = state.currentRoom?.peers.get(from);
    if (!peer) {
      addPeer(from, fromName || 'someone', false);
      peer = state.currentRoom.peers.get(from);
    }
    await peer.pc.setRemoteDescription(offer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    state.socket.emit('webrtc-answer', { to: from, answer });
  });
  state.socket.on('webrtc-answer', async ({ from, answer }) => {
    const peer = state.currentRoom?.peers.get(from);
    if (peer) await peer.pc.setRemoteDescription(answer);
  });
  state.socket.on('webrtc-ice', async ({ from, candidate }) => {
    const peer = state.currentRoom?.peers.get(from);
    if (peer && candidate) {
      try { await peer.pc.addIceCandidate(candidate); }
      catch (e) { console.error('ice error', e); }
    }
  });
}

function addPeer(socketId, username, initiator) {
  if (!state.currentRoom) return;
  if (state.currentRoom.peers.has(socketId)) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const tile = createVideoTile(socketId, username);
  state.currentRoom.peers.set(socketId, { pc, tile, name: username });

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  }
  pc.ontrack = (e) => {
    const video = tile.querySelector('video');
    if (video.srcObject !== e.streams[0]) {
      video.srcObject = e.streams[0];
      tile.querySelector('.tile-pending')?.remove();
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) state.socket.emit('webrtc-ice', { to: socketId, candidate: e.candidate });
  };
  if (initiator) {
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('webrtc-offer', { to: socketId, offer });
    })();
  }
}

function removePeer(socketId) {
  if (!state.currentRoom) return;
  const peer = state.currentRoom.peers.get(socketId);
  if (peer) {
    peer.pc.close();
    peer.tile.remove();
    state.currentRoom.peers.delete(socketId);
    updateVideoGridCount();
  }
}

function createVideoTile(socketId, username, isLocal = false) {
  const tile = document.createElement('div');
  tile.className = 'video-tile' + (isLocal ? ' local-tile' : '');
  tile.dataset.socketId = socketId;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;
  tile.appendChild(video);

  if (!isLocal) {
    const pending = document.createElement('div');
    pending.className = 'tile-pending';
    pending.textContent = 'connecting…';
    tile.appendChild(pending);
  }

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = isLocal ? username + ' / you' : username;
  tile.appendChild(label);

  el('video-grid').appendChild(tile);
  updateVideoGridCount();
  return tile;
}

// Apply a .count-N class to the video grid so CSS can pick the right
// layout — 1 tile fills the screen, 2 are split, etc.
function updateVideoGridCount() {
  const grid = el('video-grid');
  if (!grid) return;
  const n = grid.querySelectorAll('.video-tile').length;
  for (let i = 1; i <= 9; i++) grid.classList.remove('count-' + i);
  if (n >= 1) grid.classList.add('count-' + Math.min(n, 9));
}

// =================================================================
// LOOKS MAXING
// =================================================================
const looksMax = {
  active: false,
  pendingTo: null,
  pendingFrom: null,
  rafId: null,
  detector: null,
  cleanup: [],
  scoreSent: false,
  finished: false,
};

function setupLooksMax() {
  const btn = el('looksmax-btn');
  if (btn) btn.addEventListener('click', requestLooksMax);

  const accept = el('lp-accept');
  const decline = el('lp-decline');
  if (accept) accept.addEventListener('click', () => {
    if (!looksMax.pendingFrom) return;
    state.socket.emit('looksmax-accept', { to: looksMax.pendingFrom });
    el('looksmax-prompt').classList.add('hidden');
  });
  if (decline) decline.addEventListener('click', () => {
    if (!looksMax.pendingFrom) return;
    state.socket.emit('looksmax-decline', { to: looksMax.pendingFrom });
    looksMax.pendingFrom = null;
    el('looksmax-prompt').classList.add('hidden');
  });

  state.socket.on('looksmax-request', ({ from, fromName }) => {
    if (looksMax.active) {
      state.socket.emit('looksmax-decline', { to: from });
      return;
    }
    looksMax.pendingFrom = from;
    el('lp-from').textContent = fromName || 'someone';
    el('looksmax-prompt').classList.remove('hidden');
    setTimeout(() => {
      if (looksMax.pendingFrom === from) {
        looksMax.pendingFrom = null;
        el('looksmax-prompt').classList.add('hidden');
      }
    }, 15000);
  });
  state.socket.on('looksmax-decline', () => {
    if (looksMax.pendingTo) {
      toast('they declined.');
      looksMax.pendingTo = null;
    }
  });
  state.socket.on('looksmax-cancel', () => {
    looksMax.pendingFrom = null;
    el('looksmax-prompt').classList.add('hidden');
  });
  state.socket.on('looksmax-go', startLooksMaxMatch);
}

function requestLooksMax() {
  if (!state.currentRoom) { toast('start a video chat first'); return; }
  if (looksMax.active) return;
  const peers = Array.from(state.currentRoom.peers.keys());
  if (peers.length === 0) { toast('no one to challenge'); return; }
  if (peers.length > 1) { toast('looks max is 1-on-1 only'); return; }
  const target = peers[0];
  looksMax.pendingTo = target;
  state.socket.emit('looksmax-request', { to: target });
  toast('challenge sent…');
  setTimeout(() => {
    if (looksMax.pendingTo === target) looksMax.pendingTo = null;
  }, 15000);
}

function startLooksMaxMatch(payload) {
  if (!state.currentRoom) return;
  if (looksMax.active) return;
  looksMax.active = true;
  looksMax.scoreSent = false;
  looksMax.finished = false;
  looksMax.pendingTo = null;
  looksMax.pendingFrom = null;
  el('looksmax-prompt').classList.add('hidden');

  const overlay = el('looksmax-overlay');
  const timerEl = el('looksmax-timer');
  overlay.classList.remove('hidden');

  const tilesById = new Map();
  for (const sid of payload.players) {
    let tile;
    if (sid === state.socketId) {
      tile = document.querySelector('.video-tile.local-tile');
    } else {
      tile = document.querySelector(`.video-tile[data-socket-id="${sid}"]`);
    }
    if (!tile) continue;
    tile.classList.add('looksmax-active');
    const scan = document.createElement('div');
    scan.className = 'looksmax-scan';
    scan.innerHTML = `
      <div class="lm-grid"></div>
      <div class="lm-corner tl"></div><div class="lm-corner tr"></div>
      <div class="lm-corner bl"></div><div class="lm-corner br"></div>
      <div class="lm-scanline"></div>
      <div class="lm-track" style="display:none"></div>
      <div class="lm-name">${escapeHtml(payload.names[sid] || '?')}</div>
      <div class="lm-score">--.-</div>
      <div class="lm-result-overlay"></div>
    `;
    tile.appendChild(scan);
    tilesById.set(sid, { tile, scan });
  }

  const startFaceTracking = (sid, scan) => {
    const tile = tilesById.get(sid)?.tile;
    if (!tile) return;
    const video = tile.querySelector('video');
    const track = scan.querySelector('.lm-track');
    if (!video || !('FaceDetector' in window)) return;
    let detector;
    try { detector = new FaceDetector({ fastMode: true }); } catch { return; }
    let stopped = false;
    const tick = async () => {
      if (stopped || !looksMax.active) return;
      try {
        if (video.readyState >= 2) {
          const faces = await detector.detect(video);
          if (faces && faces[0]) {
            const f = faces[0].boundingBox;
            const vw = video.videoWidth || 640;
            const vh = video.videoHeight || 480;
            const rect = tile.getBoundingClientRect();
            const scaleX = rect.width / vw;
            const scaleY = rect.height / vh;
            let x = f.x * scaleX;
            const y = f.y * scaleY;
            const w = f.width * scaleX;
            const h = f.height * scaleY;
            // local tile is mirrored — flip the bounding box too
            if (tile.classList.contains('local-tile')) {
              x = rect.width - x - w;
            }
            track.style.display = 'block';
            track.style.left = x + 'px';
            track.style.top = y + 'px';
            track.style.width = w + 'px';
            track.style.height = h + 'px';
          }
        }
      } catch {}
      setTimeout(tick, 200);
    };
    tick();
    looksMax.cleanup.push(() => { stopped = true; });
  };

  for (const [sid, { scan }] of tilesById) startFaceTracking(sid, scan);

  // Real symmetry measurement — captures both players' videos every ~300ms,
  // crops the face bounding box, mirrors one half over the other, and
  // measures the pixel diff. Lower diff = more symmetric = higher score.
  const symAccum = new Map(); // sid -> [scores]
  for (const sid of payload.players) symAccum.set(sid, []);
  const symCanvas = document.createElement('canvas');
  const sctx = symCanvas.getContext('2d', { willReadFrequently: true });
  let symDetector = null;
  try { if ('FaceDetector' in window) symDetector = new FaceDetector({ fastMode: true }); } catch {}

  async function measureSymmetryFor(sid, video) {
    if (!video || video.readyState < 2) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    let box;
    if (symDetector) {
      try {
        const faces = await symDetector.detect(video);
        if (faces && faces[0] && faces[0].boundingBox) {
          const f = faces[0].boundingBox;
          box = { x: f.x, y: f.y, w: f.width, h: f.height };
        }
      } catch {}
    }
    // Fallback: use centered 60% of frame as the face crop.
    if (!box) {
      const w = vw * 0.55;
      const h = vh * 0.65;
      box = { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
    }
    // Downscale to a small fixed size for speed
    const TW = 64, TH = 80;
    symCanvas.width = TW;
    symCanvas.height = TH;
    try {
      sctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, TW, TH);
    } catch (e) { return null; }
    let data;
    try { data = sctx.getImageData(0, 0, TW, TH).data; }
    catch (e) { return null; }
    let total = 0, count = 0;
    const half = TW / 2;
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < half; x++) {
        const li = (y * TW + x) * 4;
        const ri = (y * TW + (TW - 1 - x)) * 4;
        const dr = Math.abs(data[li] - data[ri]);
        const dg = Math.abs(data[li + 1] - data[ri + 1]);
        const db = Math.abs(data[li + 2] - data[ri + 2]);
        total += (dr + dg + db) / 3;
        count++;
      }
    }
    const avgDiff = total / count;          // 0..255
    // Map: 0 diff → 99, 90+ diff → ~25
    const score = Math.max(20, Math.min(99, 99 - (avgDiff / 90) * 70));
    return score;
  }

  // Only measure OUR OWN local video. The opponent measures theirs.
  // We send our final score to the server, the server compares and broadcasts
  // the authoritative winner. This avoids the "both players see themselves
  // as winner" bug where each client made the decision locally with
  // different views of each video.
  const meSid = state.socketId;
  let symInterval = setInterval(async () => {
    if (!looksMax.active) return;
    const entry = tilesById.get(meSid);
    if (!entry) return;
    const video = entry.tile.querySelector('video');
    const s = await measureSymmetryFor(meSid, video);
    if (s != null) symAccum.get(meSid).push(s);
    // Also collect a visual sample for opponent so the on-screen jitter looks
    // alive — but DO NOT use it for winner determination.
    for (const sid of payload.players) {
      if (sid === meSid) continue;
      const oppEntry = tilesById.get(sid);
      if (!oppEntry) continue;
      const oppVideo = oppEntry.tile.querySelector('video');
      const os = await measureSymmetryFor(sid, oppVideo);
      if (os != null) symAccum.get(sid).push(os);
    }
  }, 300);
  looksMax.cleanup.push(() => { clearInterval(symInterval); });

  // Server-authoritative result handler (one-time per match)
  const onResult = (r) => {
    if (!r || r.matchId !== payload.matchId) return;
    if (looksMax.finished) return;
    looksMax.finished = true;
    payload.winner = r.winner;
    payload.finals = { ...payload.finals, ...r.finals };
    finishLooksMaxMatch(payload, tilesById);
    state.socket.off('looksmax-result', onResult);
  };
  state.socket.on('looksmax-result', onResult);
  looksMax.cleanup.push(() => { state.socket.off('looksmax-result', onResult); });

  const animate = () => {
    if (!looksMax.active) return;
    const elapsed = Date.now() - payload.startAt;
    const remaining = Math.max(0, payload.duration - elapsed);
    timerEl.textContent = Math.ceil(remaining / 1000);

    if (elapsed < 0) {
      timerEl.textContent = 'GO';
    } else if (remaining > 0) {
      for (const sid of payload.players) {
        const entry = tilesById.get(sid);
        if (!entry) continue;
        const samples = symAccum.get(sid) || [];
        const live = samples.length > 0
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : null;
        const scoreEl = entry.scan.querySelector('.lm-score');
        if (scoreEl) scoreEl.textContent = live != null ? live.toFixed(1) : '--.-';
      }
    } else {
      // Match-time over locally. Send OUR score to the server exactly once.
      if (!looksMax.scoreSent) {
        looksMax.scoreSent = true;
        const samples = symAccum.get(meSid) || [];
        const myScore = samples.length > 0
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : (payload.finals[meSid] || 50);
        try {
          state.socket.emit('looksmax-score', { matchId: payload.matchId, score: myScore });
        } catch {}
        el('looksmax-timer').textContent = '⚖️';
        // Hard fallback if server doesn't reply within 3.5s (peer dropped, etc).
        setTimeout(() => {
          if (looksMax.active && !looksMax.finished) {
            looksMax.finished = true;
            console.warn('[looksmax] no server result in time — using placeholder');
            finishLooksMaxMatch(payload, tilesById);
          }
        }, 3500);
      }
      return;
    }
    looksMax.rafId = requestAnimationFrame(animate);
  };
  looksMax.rafId = requestAnimationFrame(animate);
}

function finishLooksMaxMatch(payload, tilesById) {
  for (const sid of payload.players) {
    const entry = tilesById.get(sid);
    if (!entry) continue;
    const won = sid === payload.winner;
    entry.tile.classList.add(won ? 'lm-winner' : 'lm-loser');
    const scoreEl = entry.scan.querySelector('.lm-score');
    if (scoreEl) {
      scoreEl.textContent = payload.finals[sid].toFixed(1);
      scoreEl.classList.add(won ? 'lm-final-win' : 'lm-final-lose');
    }
    const result = entry.scan.querySelector('.lm-result-overlay');
    if (result) {
      result.innerHTML = won
        ? `<div class="lm-trophy">🏆</div><div class="lm-verdict win">VICTOR</div>`
        : `<div class="lm-skull">💀</div><div class="lm-verdict lose">DEFEAT</div>`;
    }
  }
  el('looksmax-timer').textContent = '✓';
  setTimeout(() => endLooksMaxMatch(tilesById), 4500);
}

function endLooksMaxMatch(tilesById) {
  if (looksMax.rafId) cancelAnimationFrame(looksMax.rafId);
  looksMax.rafId = null;
  for (const fn of looksMax.cleanup) try { fn(); } catch {}
  looksMax.cleanup = [];
  if (tilesById) {
    for (const { tile, scan } of tilesById.values()) {
      tile.classList.remove('looksmax-active', 'lm-winner', 'lm-loser');
      scan.remove();
    }
  }
  el('looksmax-overlay').classList.add('hidden');
  looksMax.active = false;
  looksMax.scoreSent = false;
  looksMax.finished = false;
}

// =================================================================
// CHAT OVERLAY
// =================================================================
function setupChatOverlay() {
  el('end-chat-btn').addEventListener('click', () => endCurrentChat());
  const back = el('back-to-wall-btn');
  if (back) back.addEventListener('click', () => { endCurrentChat(); navigateToWall(); });

  const sendMsg = () => {
    const input = el('chat-input');
    const msg = input.value.trim();
    if (!msg || !state.currentRoom) return;
    state.socket.emit('chat-message', {
      roomId: state.currentRoom.id,
      message: msg
    });
    input.value = '';
  };
  el('chat-send').addEventListener('click', sendMsg);
  el('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
}

function openChatOverlay(room) {
  if (state.currentRoom) endCurrentChat({ keepCamera: true });
  state.currentRoom = { ...room, peers: new Map() };

  el('chat-title').textContent = room.name;
  el('chat-messages').innerHTML = '';
  el('chat-overlay').classList.remove('hidden');

  const sharePill = el('chat-share');
  if (room.type === 'room') {
    const link = `${window.location.origin}/#room=${room.id}`;
    sharePill.textContent = 'copy room link';
    sharePill.classList.remove('hidden');
    sharePill.style.cursor = 'pointer';
    sharePill.onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('link copied'); }
      catch { toast(link, 4000); }
    };
  } else {
    sharePill.classList.add('hidden');
  }

  const grid = el('video-grid');
  grid.innerHTML = '';
  const localTile = createVideoTile(state.socketId, state.user.name, true);
  if (state.localStream) localTile.querySelector('video').srcObject = state.localStream;
}

function endCurrentChat(opts = {}) {
  if (!state.currentRoom) return;
  if (looksMax.active) endLooksMaxMatch();
  const peerIds = Array.from(state.currentRoom.peers.keys());
  for (const id of peerIds) removePeer(id);

  if (state.currentRoom.type === 'random') {
    state.socket.emit('end-random-chat', {
      roomId: state.currentRoom.id,
      peerSocketId: peerIds[0]
    });
    state.socket.emit('cancel-random-chat');
  } else if (state.currentRoom.type === 'room') {
    state.socket.emit('leave-room', { roomId: state.currentRoom.id });
  }

  state.currentRoom = null;
  el('chat-overlay').classList.add('hidden');
  el('video-grid').innerHTML = '';

  if (!opts.keepCamera) stopCamera();
  broadcastActivity({ kind: 'browsing', label: 'just left a room' });
}

function endCurrentChatSilent() {
  if (!state.currentRoom) return;
  for (const id of Array.from(state.currentRoom.peers.keys())) removePeer(id);
  state.currentRoom = null;
  el('chat-overlay').classList.add('hidden');
  el('video-grid').innerHTML = '';
  stopCamera();
}

function onChatMessage({ username, socketId, message }) {
  addChatMessage({ author: username, message, isSelf: socketId === state.socketId });
}

function addChatMessage({ author, message, isSelf, system }) {
  const messages = el('chat-messages');
  const msg = document.createElement('div');
  msg.className = 'chat-msg' + (isSelf ? ' self' : '') + (system ? ' system' : '');
  if (system) {
    msg.textContent = message;
  } else {
    msg.innerHTML = `<span class="author">${escapeHtml(author)}</span><span class="body">${escapeHtml(message)}</span>`;
  }
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}

// =================================================================
// UTILS
// =================================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Spotify embed — detect open.spotify.com / spotify.link links in post text
// and produce an iframe player. Returns '' if no spotify URL found.
function renderSpotifyEmbed(text) {
  if (!text) return '';
  const m = String(text).match(/https?:\/\/open\.spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/i);
  if (!m) return '';
  const kind = m[1].toLowerCase();
  const id = m[2];
  const height = kind === 'track' ? 152 : 352;
  return `
    <div class="spotify-embed-wrap">
      <iframe class="spotify-embed"
              src="https://open.spotify.com/embed/${kind}/${encodeURIComponent(id)}?utm_source=oldstreets"
              width="100%" height="${height}" frameborder="0"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"></iframe>
    </div>
  `;
}

function linkify(text) {
  let out = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // @mention chips — only if handle resolves to a signed-up directory user.
  // Otherwise leave the @text untouched so non-platform names look like plain text.
  out = out.replace(/(^|[\s(>])@([a-z0-9._-]{1,40})/gi, (full, lead, handle) => {
    const hLc = handle.toLowerCase();
    const dir = (state.directory || []);
    // try first-name match OR email-local match — must be CLAIMED (signed up).
    const u = dir.find(d => {
      if (!d || !d.claimed) return false;
      const first = (d.name || '').split(' ')[0].toLowerCase();
      const slug = (d.email || '').split('@')[0].toLowerCase();
      return first === hLc || slug === hLc;
    });
    if (!u) return full; // not on platform — render as plain text
    return `${lead}<a href="#profile/${escapeAttr(u.email)}" class="caption-mention" data-email="${escapeAttr(u.email)}">@${escapeHtml(handle)}</a>`;
  });
  return out;
}

function timeAgo(ts) {
  if (!ts) return 'just now';
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const d = Math.floor(hr / 24);
  if (d < 7) return d + 'd ago';
  const w = Math.floor(d / 7);
  if (w < 52) return w + 'w ago';
  return Math.floor(d / 365) + 'y ago';
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

setInterval(() => {
  // Only touch the DOM if the relative-time string actually changed.
  // Used to rewrite textContent on every post card every 30s even when
  // nothing changed (e.g. "5h ago" → "5h ago"), causing perceived flicker.
  document.querySelectorAll('.post-card .post-time').forEach(elT => {
    const card = elT.closest('.post-card');
    if (!card) return;
    const post = state.posts.find(p => p.id === card.dataset.id);
    if (!post) return;
    const next = (elT.textContent.startsWith('posted ') ? 'posted ' : '') + timeAgo(post.createdAt);
    if (elT.textContent !== next) elT.textContent = next;
  });
}, 120000);

function timeUntil(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000);
  if (h > 0) return h + 'h left';
  const m = Math.floor(ms / 60000);
  if (m > 0) return m + 'm left';
  return 'less than 1m';
}

// =================================================================
// NOTIFICATIONS
// =================================================================
function setupNotifBell() {
  const bell = el('notif-bell');
  if (!bell) return;
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = el('notif-dropdown');
    dd.classList.toggle('hidden');
    if (!dd.classList.contains('hidden')) {
      // Anchor the dropdown directly under the bell so it doesn't float
      // far from the icon on responsive layouts / themed bars.
      const rect = bell.getBoundingClientRect();
      const ddWidth = 320;
      const padding = 8;
      let left = rect.right - ddWidth;
      // Keep it on-screen
      if (left + ddWidth > window.innerWidth - padding) left = window.innerWidth - ddWidth - padding;
      if (left < padding) left = padding;
      dd.style.top = (rect.bottom + 4) + 'px';
      dd.style.left = left + 'px';
      dd.style.right = 'auto';
      refreshNotifications();
      refreshNotifPushCta();
    }
  });
  document.addEventListener('click', (e) => {
    const dd = el('notif-dropdown');
    if (dd && !dd.classList.contains('hidden') && !dd.contains(e.target) && !bell.contains(e.target)) {
      dd.classList.add('hidden');
    }
  });
  el('notif-mark-all').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/read-all');
      await refreshNotifications();
    } catch {}
  });
  // "Turn on push notifications" CTA inside the bell dropdown
  const pushBtn = el('notif-push-enable');
  if (pushBtn) {
    pushBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await requestNotificationsExplicit();
      refreshNotifPushCta();
    });
  }
  refreshNotifPushCta();
}

function refreshNotifPushCta() {
  const cta = el('notif-push-cta');
  if (!cta) return;
  if (!('Notification' in window)) { cta.classList.add('hidden'); return; }
  if (Notification.permission === 'granted') { cta.classList.add('hidden'); return; }
  cta.classList.remove('hidden');
  // Tweak label if previously denied
  const label = cta.querySelector('span');
  if (Notification.permission === 'denied' && label) {
    label.textContent = '🔕 notifications blocked — tap the 🔒 in the address bar to re-enable';
    const btn = el('notif-push-enable');
    if (btn) btn.textContent = 'how';
  }
}

async function refreshNotifications() {
  try {
    const r = await api('GET', '/api/notifications');
    state.notifs = r.notifications || [];
    state.unreadDmCount = r.unreadDmCount || 0;
    state.unreadNotifCount = r.unreadNotifCount || 0;
    renderNotifBadge();
    renderNotifList();
  } catch (e) { console.warn('notifs fetch failed', e); }
}

function renderNotifBadge() {
  const total = state.unreadDmCount + state.unreadNotifCount;
  const setBadge = (id) => {
    const b = el(id);
    if (!b) return;
    if (total > 0) { b.textContent = total > 99 ? '99+' : String(total); b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  };
  setBadge('notif-badge');
  setBadge('mb-notif-badge');
  document.title = total > 0 ? `(${total}) Old Streets` : 'Old Streets';
}

function renderNotifList() {
  const list = el('notif-list');
  if (!list) return;
  if (!state.notifs || state.notifs.length === 0) {
    list.innerHTML = '<div class="notif-empty">no notifications yet</div>';
    return;
  }
  // Belt-and-suspenders dedup at render time. Some notif types should only
  // ever show ONE entry (the most recent): qotd, performance, retro,
  // friends-online, phantom. If older copies linger in state.notifs they
  // get hidden here regardless of what the server sent.
  const collapseTypes = new Set(['qotd', 'performance', 'retro', 'friends-online', 'phantom']);
  const seenCollapse = new Set();
  const visibleNotifs = [];
  for (const n of state.notifs) {
    if (collapseTypes.has(n.type)) {
      if (seenCollapse.has(n.type)) continue;
      seenCollapse.add(n.type);
    }
    visibleNotifs.push(n);
  }
  list.innerHTML = '';
  for (const n of visibleNotifs) {
    const div = document.createElement('div');
    div.className = 'notif-item' + (n.read ? '' : ' unread');
    let label = '';
    if (n.type === 'mention') label = `<span class="who">${escapeHtml(n.fromName)}</span> mentioned you`;
    else if (n.type === 'comment') label = `<span class="who">${escapeHtml(n.fromName)}</span> commented on your post`;
    else if (n.type === 'talked-about') label = `<span class="who">${escapeHtml(n.fromName)}</span> might be talking about you`;
    else if (n.type === 'phantom') label = `<span class="who notif-phantom">👁 activity</span>`;
    else if (n.type === 'blowup') label = `<span class="who">${escapeHtml(n.fromName)}</span>'s post is blowing up 🔥`;
    else if (n.type === 'retro') label = `<span class="who notif-retro">🔁 old post</span>`;
    else if (n.type === 'performance') label = `<span class="who notif-phantom">📊 post update</span>`;
    else if (n.type === 'friends-online') label = `<span class="who notif-online">🟢 friends online</span>`;
    else if (n.type === 'love-letter') label = `<span class="who notif-love">💌 someone has a crush on you</span>`;
    else if (n.type === 'profile-board') label = `<span class="who">${escapeHtml(n.fromName)}</span> wrote on your profile`;
    else if (n.type === 'bulletin') label = `<span class="who">${escapeHtml(n.fromName)}</span> posted a bulletin 📢`;
    else if (n.type === 'mutual-stalker') label = `<span class="who notif-mutual">👀 mutual curiosity</span>`;
    else if (n.type === 'crush-match') label = `<span class="who notif-crush-match">💞 IT'S A MATCH</span>`;
    else if (n.type === 'qotd') label = `<span class="who notif-qotd">☀️ question of the day</span>`;
    else if (n.type === 'royalty') label = `<span class="who notif-royalty">${n.crown || '👑'} royalty crown</span>`;
    else if (n.type === 'streak-revived') label = `<span class="who notif-streak">🔥 streak revived</span>`;
    else if (n.type === 'streak-milestone') label = `<span class="who notif-streak">🔥 streak milestone</span>`;
    else if (n.type === 'streak-reminder') label = `<span class="who notif-streak">⚠️ streak at risk</span>`;
    else if (n.type === 'streak-competition') label = `<span class="who notif-streak">🔥 streak update</span>`;
    else if (n.type === 'blowup-author') label = `<span class="who notif-phantom">🔥 your post</span>`;
    else if (n.type === 'reciprocal-nudge') label = `<span class="who">${escapeHtml(n.fromName)}</span> reacted to your post`;
    else if (n.type === 'thread-heat') label = `<span class="who notif-phantom">🔥 thread blowing up</span>`;
    else if (n.type === 'missed-you') label = `<span class="who notif-broadcast">👋 we noticed</span>`;
    else if (n.type === 'leaderboard-drop') label = `<span class="who notif-phantom">📉 leaderboard update</span>`;
    else if (n.type === 'crush-tease') label = `<span class="who notif-love">💌 secret admirer</span>`;
    else if (n.type === 'qotd-nudge') label = `<span class="who notif-qotd">❓ question of the day</span>`;
    else if (n.type === 'profile-obsession') label = `<span class="who notif-mutual">👀 someone keeps coming back</span>`;
    else if (n.type === 'phantom-typing') label = `<span class="who notif-phantom">✏️ someone is typing</span>`;
    else if (n.type === 'friend-drift') label = `<span class="who notif-broadcast">📭 ${escapeHtml(n.fromName || 'connection fading')}</span>`;
    else if (n.type === 'reciprocity-debt') label = `<span class="who">${escapeHtml(n.fromName)}</span> reacted to your posts`;
    else if (n.type === 'view-velocity-drop') label = `<span class="who notif-mutual">👻 visibility dropping</span>`;
    else if (n.type === 'weekly-report-card') label = `<span class="who notif-phantom">📊 weekly report</span>`;
    else if (n.type === 'friend-request') label = `<span class="who">${escapeHtml(n.fromName)}</span> wants to be your friend 👯`;
    else if (n.type === 'friend-accept') label = `<span class="who">${escapeHtml(n.fromName)}</span> accepted your friend request ✨`;
    else if (n.type === 'blog') label = `<span class="who">${escapeHtml(n.fromName)}</span> posted a new blog 📝`;
    else if (n.type === 'blog-comment') label = `<span class="who">${escapeHtml(n.fromName)}</span> commented on your blog`;
    else if (n.type === 'broadcast') label = `<span class="who notif-broadcast">📣 ${escapeHtml(n.fromName || 'announcement')}</span>`;
    else if (n.type === 'memory') label = `<span class="who notif-memory">🌀 memory drop</span>`;
    else if (n.type === 'anniversary') label = `<span class="who notif-anniversary">🎂 1 year on Old Streets</span>`;
    else label = `<span class="who">${escapeHtml(n.fromName || 'someone')}</span> · ${escapeHtml(n.type)}`;
    div.innerHTML = `
      <button class="notif-dismiss" title="mark as read" data-id="${escapeAttr(n.id)}">✓</button>
      ${label}
      ${n.text ? `<div class="preview">"${escapeHtml(n.text)}"</div>` : ''}
      <span class="when">${timeAgo(n.ts)}</span>
    `;
    // Wire mark-as-read button BEFORE the row click handlers so it doesn't bubble.
    const dismissBtn = div.querySelector('.notif-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (n.read) return; // already read, no-op
        // Optimistic flip
        n.read = true;
        state.unreadNotifCount = Math.max(0, state.unreadNotifCount - 1);
        div.classList.remove('unread');
        renderNotifBadge();
        try { await api('POST', `/api/notifications/${encodeURIComponent(n.id)}/read`, {}); } catch {}
      });
    }
    // Mark single notification as read when clicked. Send POST and AWAIT it
    // so a subsequent refresh doesn't race and overwrite our optimistic flip.
    div.addEventListener('click', async () => {
      if (!n.read) {
        n.read = true;
        state.unreadNotifCount = Math.max(0, state.unreadNotifCount - 1);
        renderNotifBadge();
        div.classList.remove('unread');
        try {
          await api('POST', `/api/notifications/${encodeURIComponent(n.id)}/read`, {});
        } catch (e) {
          // If the server rejected, revert the local read flag
          console.warn('mark-read failed', e);
          n.read = false;
          state.unreadNotifCount++;
          renderNotifBadge();
          div.classList.add('unread');
        }
      }
    });
    if (n.type === 'love-letter' && n.letterId) {
      div.addEventListener('click', () => {
        openCrushPick3Modal(n.letterId);
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.type === 'mutual-stalker' && n.revealEmail) {
      div.addEventListener('click', () => {
        openMutualRevealModal(n);
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.type === 'crush-match' && n.matchedEmail) {
      div.addEventListener('click', () => {
        openCrushMatchModal(n);
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.type === 'qotd') {
      div.addEventListener('click', () => {
        document.getElementById('qotd-box')?.scrollIntoView({ behavior: 'smooth' });
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.type === 'friend-request' || n.type === 'friend-accept') {
      div.addEventListener('click', () => {
        openFriendsView();
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.type === 'royalty') {
      div.addEventListener('click', () => {
        if (state.user?.email) navigateToProfile(state.user.email);
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.type === 'blog' && n.blogId) {
      div.addEventListener('click', () => {
        openBlogDetail(n.blogId);
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.postId) {
      div.addEventListener('click', () => {
        navigateToPost(n.postId);
        el('notif-dropdown').classList.add('hidden');
      });
    } else if (n.type === 'profile-board' && n.fromEmail) {
      div.addEventListener('click', () => {
        navigateToProfile(state.user.email);
        el('notif-dropdown').classList.add('hidden');
      });
    }
    list.appendChild(div);
  }
}

function onIncomingNotif(n) {
  // Aggressive dedup: never show more than one QOTD notif (per day) on the
  // client. If we already have one in state, drop the incoming silently
  // instead of pushing/toasting it. Same idea for other collapsible types.
  const collapseTypes = new Set(['qotd', 'performance', 'retro', 'friends-online', 'phantom']);
  if (collapseTypes.has(n.type)) {
    const existingIdx = state.notifs.findIndex(x => x.type === n.type);
    if (existingIdx >= 0) {
      // Replace with the newer one (so timestamp updates) but DON'T toast or push.
      state.notifs[existingIdx] = n;
      renderNotifBadge();
      renderNotifList();
      return;
    }
  }
  // Drop exact-duplicate notifs (same id arrives twice over multiple sockets).
  if (n.id && state.notifs.some(x => x.id === n.id)) return;
  state.notifs.unshift(n);
  if (state.notifs.length > 50) state.notifs = state.notifs.slice(0, 50);
  state.unreadNotifCount++;
  renderNotifBadge();
  renderNotifList();
  let label = 'new notification';
  if (n.type === 'mention') label = `${n.fromName} mentioned you 👀`;
  else if (n.type === 'comment') label = `${n.fromName} commented on your post`;
  else if (n.type === 'talked-about') label = `${n.fromName} might be talking about you 👀`;
  else if (n.type === 'phantom') label = n.text || 'people are watching 👁';
  else if (n.type === 'blowup') label = n.text || `${n.fromName}'s post is blowing up 🔥`;
  else if (n.type === 'retro') label = n.text || 'your old post is getting attention again 🔁';
  else if (n.type === 'performance') label = n.text || 'your post is quiet so far 👀';
  else if (n.type === 'friends-online') label = n.text || 'your friends are online right now 🟢';
  else if (n.type === 'love-letter') label = '💌 someone has a crush on you — tap to pick 3';
  else if (n.type === 'profile-board') label = `${n.fromName} wrote on your profile 📝`;
  else if (n.type === 'bulletin') label = `${n.fromName} posted a bulletin 📢`;
  else if (n.type === 'mutual-stalker') label = `👀 ${n.revealName || 'someone'} viewed you too — recently. tap to see.`;
  else if (n.type === 'crush-match') label = `💞 IT'S A MATCH — ${n.matchedName || 'someone'} has a crush on you too. tap to reveal.`;
  else if (n.type === 'qotd') label = '☀️ question of the day is up — tap to answer';
  else if (n.type === 'royalty') label = `${n.crown || '👑'} you got a royalty crown!`;
  else if (n.type === 'streak-revived') label = `🔥 streak revived`;
  else if (n.type === 'streak-milestone') label = n.text || `🔥 streak milestone`;
  else if (n.type === 'streak-reminder') label = n.text || `⚠️ your streak is at risk — post before midnight`;
  else if (n.type === 'streak-competition') label = n.text || `🔥 someone has a longer streak than you`;
  else if (n.type === 'blowup-author') label = n.text || `🔥 your post is blowing up`;
  else if (n.type === 'reciprocal-nudge') label = n.text || `${n.fromName} reacted to your post — check theirs out`;
  else if (n.type === 'thread-heat') label = n.text || `🔥 the thread you commented on is blowing up`;
  else if (n.type === 'missed-you') label = n.text || `👋 it's been a few days — come back`;
  else if (n.type === 'leaderboard-drop') label = n.text || `📉 you dropped on the leaderboard`;
  else if (n.type === 'crush-tease') label = n.text || `💌 someone added you as a crush this week`;
  else if (n.type === 'qotd-nudge') label = n.text || `❓ today's question is waiting for you`;
  else if (n.type === 'profile-obsession') label = n.text || `👀 someone keeps coming back to your profile`;
  else if (n.type === 'phantom-typing') label = n.text || `✏️ someone started typing on your post...`;
  else if (n.type === 'friend-drift') label = n.text || `📭 a friendship is fading — ${n.fromName || 'check in'}`;
  else if (n.type === 'reciprocity-debt') label = n.text || `${n.fromName} reacted to your posts — show them some back`;
  else if (n.type === 'view-velocity-drop') label = n.text || `👻 your profile views are dropping`;
  else if (n.type === 'weekly-report-card') label = n.text || `📊 weekly report`;
  else if (n.type === 'friend-request') label = `${n.fromName} wants to be your friend 👯`;
  else if (n.type === 'friend-accept') label = `${n.fromName} accepted your friend request ✨`;
  else if (n.type === 'blog') label = `${n.fromName} posted a new blog 📝`;
  else if (n.type === 'blog-comment') label = `${n.fromName} commented on your blog`;
  else if (n.type === 'broadcast') label = `📣 ${n.text || 'announcement from Old Streets'}`;
  else if (n.type === 'memory') label = `🌀 your old post is back — ${n.text || 'remember this?'}`;
  else if (n.type === 'anniversary') label = `🎂 1 year on Old Streets — happy anniversary`;
  toast(label, n.type === 'broadcast' ? 8000 : 5000);
  // Native push notification (only fires if user granted permission and tab is in background)
  firePushNotification(
    n.type === 'broadcast' ? (n.fromName || '📣 Old Streets') : 'Old Streets',
    label.replace(/<[^>]+>/g, ''),
    {
      tag: n.type + ':' + (n.postId || n.letterId || n.fromEmail || n.id || ''),
      onClick: () => {
        if (n.type === 'love-letter' && n.letterId) openCrushPick3Modal(n.letterId);
        else if (n.type === 'broadcast' && n.link) {
          if (n.link.startsWith('http')) window.open(n.link, '_blank');
          else location.hash = n.link;
        }
        else if (n.postId) navigateToPost(n.postId);
        else if (n.fromEmail) navigateToProfile(n.fromEmail);
      }
    }
  );
  // Mutual-stalker used to auto-open a full-screen modal — now it lives in
  // the bell only (user clicks it to open). Keeps the wall uninterrupted.
}

function onLiveActivity(d) {
  // Set textContent ONLY when the value differs — otherwise the browser
  // still treats the assignment as a mutation and the inspector flashes
  // the node. With multiple of these every few seconds the user saw it
  // as a constant page-refresh shimmer.
  const setIfChanged = (id, val) => {
    const node = el(id);
    if (!node) return;
    const v = String(val);
    if (node.textContent !== v) node.textContent = v;
  };
  setIfChanged('online-count-large', (d.flooredOnline || d.online || 1) + ' online');
  setIfChanged('post-count', d.totalPostsToday || 0);
  setIfChanged('la-online', d.flooredOnline || d.online || 1);
  setIfChanged('la-today', d.totalPostsToday || 0);
  setIfChanged('la-rooms', d.activeRooms || 0);
}

// =================================================================
// POST VIEW TRACKING
// =================================================================
// IntersectionObserver watches post cards; once a card is 50% visible
// for 1s, we emit 'post-view' so the server can count it.
let postViewObserver = null;
const viewedPostIds = new Set();

function initPostViewObserver() {
  if (postViewObserver) postViewObserver.disconnect();
  viewedPostIds.clear();
  postViewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const card = entry.target;
      const postId = card.dataset.id;
      if (!postId) continue;

      if (entry.isIntersecting) {
        // Emit reading presence immediately (for the "N reading now" badge)
        if (state.socket) state.socket.emit('post-start-reading', { postId });

        // Delay the view-count increment to avoid fly-by scrolls
        if (!viewedPostIds.has(postId)) {
          setTimeout(() => {
            if (!card.isConnected) return;
            const rect = card.getBoundingClientRect();
            if (rect.top < window.innerHeight && rect.bottom > 0) {
              viewedPostIds.add(postId);
              if (state.socket) state.socket.emit('post-view', { postId });
            }
          }, 1000);
        }
      } else {
        // Card left viewport — stop counting as reading
        if (state.socket) state.socket.emit('post-stop-reading', { postId });
      }
    }
  }, { threshold: 0.5 });
}

function observePostCard(card) {
  if (postViewObserver && card) postViewObserver.observe(card);
}

function onPostViewCount({ postId, viewCount }) {
  // Update the view badge on any visible card
  const card = document.querySelector(`.post-card[data-id="${postId}"]`);
  if (card) {
    let badge = card.querySelector('.post-view-badge');
    if (badge) badge.querySelector('.view-num').textContent = viewCount;
  }
  // Also update state so re-renders pick it up
  const post = state.posts.find(p => p.id === postId);
  if (post) post.viewCount = viewCount;
}

function onPostReadersCount({ postId, count }) {
  const cards = document.querySelectorAll(`.post-card[data-id="${postId}"]`);
  cards.forEach(card => {
    const badge = card.querySelector('.readers-now');
    if (!badge) return;
    if (count > 1) {
      badge.textContent = `👁 ${count} reading`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

function syncStreakPill() {
  const pill = el('streak-pill');
  const num = el('streak-count');
  if (!pill || !num) return;
  const s = state.user?.streak || 0;
  if (s > 0) {
    pill.classList.remove('hidden');
    updateStreakCountdown(); // start live countdown
  } else {
    pill.classList.add('hidden');
  }
}

// Live streak countdown — updates every minute. Color shifts at danger zone.
let streakCountdownTimer = null;
function updateStreakCountdown() {
  const pill = el('streak-pill');
  const num = el('streak-count');
  if (!pill || !num) return;
  const s = state.user?.streak || 0;
  if (s === 0) {
    // Show "🔥 start your streak" so they have a visible goal
    pill.classList.remove('hidden');
    pill.classList.remove('urgent', 'warning');
    num.textContent = 'start';
    pill.title = 'post once today to start a streak';
    return;
  }

  const expiresAt = state.user.streakExpiresAt || (new Date().setHours(23, 59, 59, 999));
  const msLeft = expiresAt - Date.now();
  const hoursLeft = msLeft / (1000 * 60 * 60);

  let countdownText = '';
  pill.classList.remove('urgent', 'warning');
  if (hoursLeft < 0) {
    // already expired — shouldn't normally happen, refresh will catch it
    countdownText = '';
  } else if (hoursLeft < 2) {
    // red zone: show minutes
    const minsLeft = Math.ceil(msLeft / 60000);
    countdownText = `· ${minsLeft}m left`;
    pill.classList.add('urgent');
  } else if (hoursLeft < 6) {
    // yellow zone: show hours
    countdownText = `· ${Math.floor(hoursLeft)}h left`;
    pill.classList.add('warning');
  }

  // Rebuild pill content
  let existing = pill.querySelector('.streak-countdown');
  if (existing) existing.remove();
  num.textContent = s;
  if (countdownText) {
    const span = document.createElement('span');
    span.className = 'streak-countdown';
    span.textContent = countdownText;
    pill.appendChild(span);
  }

  // Schedule next update
  if (streakCountdownTimer) clearInterval(streakCountdownTimer);
  streakCountdownTimer = setInterval(updateStreakCountdown, 60 * 1000);
}

async function refreshFeatureStatus() {
  try {
    const r = await api('GET', '/api/me/feature-status');
    state.featureStatus = r;
    applyFeatureLocks();
  } catch (e) { console.warn('feature status fetch failed', e); }
}

function applyFeatureLocks() {
  const fs = state.featureStatus || {};
  // DM lock
  const dmLocked = fs.dm && !fs.dm.unlocked;
  // Random chat lock
  const randomLocked = fs.random && !fs.random.unlocked;
  const sideRandom = el('sidebar-random-btn');
  if (sideRandom) {
    sideRandom.classList.toggle('locked', randomLocked);
    if (randomLocked) sideRandom.title = 'unlock by making 1 post first';
  }
  const navRandom = el('random-chat-btn');
  if (navRandom) {
    navRandom.classList.toggle('locked', randomLocked);
    if (randomLocked) navRandom.title = 'unlock by making 1 post first';
  }
}

function appendDmReadReceipt() {
  // After we render DM messages, mark the last self-message with "seen" if read.
  const wrap = el('dm-messages');
  if (!wrap) return;
  // remove any old receipts
  wrap.querySelectorAll('.read-receipt').forEach(r => r.remove());
  const msgs = wrap.querySelectorAll('.dm-msg.from-me');
  if (msgs.length === 0) return;
  const lastSelf = msgs[msgs.length - 1];
  const r = document.createElement('div');
  r.className = 'read-receipt';
  r.textContent = '✓ seen';
  lastSelf.appendChild(r);
}

// =================================================================
// INBOX — unified DM threads + group chats list, with new-group flow
// =================================================================
function setupInbox() {
  const btn = el('inbox-btn');
  if (btn) btn.addEventListener('click', openInbox);
  // wire close on backdrop
  ['inbox-modal', 'group-modal', 'new-group-modal'].forEach(id => {
    const m = el(id);
    if (m) m.addEventListener('click', e => { if (e.target.id === id) m.classList.add('hidden'); });
    const close = m?.querySelector('[data-close]');
    if (close) close.addEventListener('click', () => m.classList.add('hidden'));
  });
  const newGrpBtn = el('inbox-new-group-btn');
  if (newGrpBtn) newGrpBtn.addEventListener('click', openNewGroupModal);
  const createBtn = el('new-group-create');
  if (createBtn) createBtn.addEventListener('click', submitNewGroup);
  const sendBtn = el('group-send');
  if (sendBtn) sendBtn.addEventListener('click', sendGroupMessage);
  const groupInput = el('group-input');
  if (groupInput) groupInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendGroupMessage(); });
  const leaveBtn = el('group-leave-btn');
  if (leaveBtn) leaveBtn.addEventListener('click', leaveCurrentGroup);
  const addMemberBtn = el('group-add-member-btn');
  if (addMemberBtn) addMemberBtn.addEventListener('click', addMemberToCurrentGroup);
  // Refresh inbox badge periodically + when groups change
  setInterval(refreshInboxBadge, 60 * 1000);
  refreshInboxBadge();
}

async function openInbox() {
  el('inbox-modal').classList.remove('hidden');
  const list = el('inbox-list');
  list.innerHTML = '<div class="inbox-empty">loading…</div>';
  try {
    const threads = await api('GET', '/api/inbox');
    state._inboxThreads = threads;
    renderInbox(threads);
  } catch (e) {
    list.innerHTML = '<div class="inbox-empty">' + (e.data?.error || 'failed to load') + '</div>';
  }
}

function renderInbox(threads) {
  const list = el('inbox-list');
  if (!list) return;
  if (!threads || threads.length === 0) {
    list.innerHTML = '<div class="inbox-empty">no messages yet — start one</div>';
    return;
  }
  list.innerHTML = '';
  for (const t of threads) {
    const row = document.createElement('div');
    row.className = 'inbox-row' + (t.unread > 0 ? ' unread' : '');
    const icon = t.kind === 'group'
      ? `<div class="inbox-avatar group">👥</div>`
      : (t.avatar
          ? `<div class="inbox-avatar"><img src="${escapeAttr(t.avatar)}" alt=""/></div>`
          : `<div class="inbox-avatar">${escapeHtml((t.name?.[0] || '?').toUpperCase())}</div>`);
    const subtitle = t.kind === 'group' ? `${t.memberCount} members` : t.email;
    const preview = (t.lastFromMe ? 'you: ' : '') + (t.lastText || '');
    row.innerHTML = `
      ${icon}
      <div class="inbox-row-body">
        <div class="inbox-row-top">
          <strong class="inbox-row-name">${escapeHtml(t.name)}</strong>
          <span class="inbox-row-time">${t.lastTs ? timeAgo(t.lastTs) : ''}</span>
        </div>
        <div class="inbox-row-sub">${escapeHtml(subtitle)}</div>
        <div class="inbox-row-preview">${escapeHtml(preview.slice(0, 80))}</div>
      </div>
      ${t.unread > 0 ? `<span class="inbox-unread-pill">${t.unread}</span>` : ''}
    `;
    row.addEventListener('click', () => {
      el('inbox-modal').classList.add('hidden');
      if (t.kind === 'group') openGroupModal(t.id);
      else openDmModal(t.email, t.name, t.avatar);
    });
    list.appendChild(row);
  }
}

async function refreshInboxBadge() {
  if (!state.token) return;
  try {
    const threads = await api('GET', '/api/inbox');
    const total = (threads || []).reduce((n, t) => n + (t.unread || 0), 0);
    const setBadge = (id) => {
      const b = el(id);
      if (!b) return;
      if (total > 0) { b.textContent = total > 99 ? '99+' : String(total); b.classList.remove('hidden'); }
      else b.classList.add('hidden');
    };
    setBadge('inbox-badge');
    setBadge('mb-inbox-badge');
    setBadge('subnav-inbox-badge');
  } catch {}
}

function setupMobileBottomNav() {
  const nav = el('mobile-bottom-nav');
  if (!nav) return;
  nav.querySelectorAll('.mb-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.nav;
      if (action === 'home') {
        location.hash = '';
        if (typeof handleHashRoute === 'function') handleHashRoute();
        else if (typeof renderFeed === 'function') renderFeed();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (action === 'inbox') {
        openInbox();
      } else if (action === 'post') {
        openAddPostitModal();
      } else if (action === 'notifs') {
        el('notif-bell')?.click();
      } else if (action === 'me') {
        if (state.user?.email) navigateToProfile(state.user.email);
      }
      // Visual active state
      nav.querySelectorAll('.mb-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // Default active = home
  const homeBtn = nav.querySelector('[data-nav="home"]');
  if (homeBtn) homeBtn.classList.add('active');
}

// ----- new group flow -----
function openNewGroupModal() {
  el('inbox-modal').classList.add('hidden');
  el('new-group-name').value = '';
  el('new-group-error').classList.add('hidden');
  state._newGroupPicks = new Set();
  // Render friend list (and fallback to directory) as toggleable chips.
  const picker = el('new-group-picker');
  const myEmail = (state.user?.email || '').toLowerCase();
  const friends = (state.user?.friends || []).map(f => String(f).toLowerCase());
  const friendObjs = friends
    .map(f => (state.directory || []).find(d => d.email.toLowerCase() === f && d.claimed))
    .filter(Boolean);
  // Fall back to all claimed directory users if no friends
  const others = (state.directory || [])
    .filter(d => d.claimed && d.email.toLowerCase() !== myEmail && !friends.includes(d.email.toLowerCase()))
    .slice(0, 30);
  const all = friendObjs.concat(others);
  if (all.length === 0) {
    picker.innerHTML = '<div class="inbox-empty">no one to add yet — make friends first</div>';
  } else {
    picker.innerHTML = all.map(d => `
      <button type="button" class="ng-pick" data-email="${escapeAttr(d.email)}">
        ${escapeHtml(d.name)}
      </button>
    `).join('');
    picker.querySelectorAll('.ng-pick').forEach(b => {
      b.addEventListener('click', () => {
        const em = b.dataset.email.toLowerCase();
        if (state._newGroupPicks.has(em)) {
          state._newGroupPicks.delete(em);
          b.classList.remove('picked');
        } else {
          state._newGroupPicks.add(em);
          b.classList.add('picked');
        }
      });
    });
  }
  el('new-group-modal').classList.remove('hidden');
  setTimeout(() => el('new-group-name').focus(), 60);
}

async function submitNewGroup() {
  const name = el('new-group-name').value.trim();
  const errEl = el('new-group-error');
  const members = Array.from(state._newGroupPicks || []);
  errEl.classList.add('hidden');
  if (!name) { errEl.textContent = 'group needs a name'; errEl.classList.remove('hidden'); return; }
  if (members.length < 1) { errEl.textContent = 'pick at least 1 person'; errEl.classList.remove('hidden'); return; }
  const btn = el('new-group-create');
  btn.disabled = true; btn.textContent = 'creating…';
  try {
    const g = await api('POST', '/api/groups', { name, members });
    el('new-group-modal').classList.add('hidden');
    toast(`group "${g.name}" created — ${g.members.length} members`);
    openGroupModal(g.id);
  } catch (e) {
    errEl.textContent = e.data?.error || 'failed';
    errEl.classList.remove('hidden');
  } finally { btn.disabled = false; btn.textContent = 'create group →'; }
}

// ----- group chat view -----
state._currentGroup = null;
async function openGroupModal(groupId) {
  state._currentGroup = groupId;
  el('group-modal').classList.remove('hidden');
  el('group-messages').innerHTML = '<div class="dm-empty">loading…</div>';
  el('group-header-name').textContent = '…';
  el('group-header-members').textContent = '';
  try {
    const g = await api('GET', '/api/groups/' + encodeURIComponent(groupId));
    state._currentGroupData = g;
    el('group-header-name').textContent = g.name;
    el('group-header-members').textContent = g.members.map(m => m.name.split(' ')[0]).join(', ');
    renderGroupMessages(g);
    setTimeout(() => el('group-input').focus(), 60);
    refreshInboxBadge();
  } catch (e) {
    el('group-messages').innerHTML = '<div class="dm-empty">' + (e.data?.error || 'failed') + '</div>';
  }
}

function renderGroupMessages(g) {
  const wrap = el('group-messages');
  wrap.innerHTML = '';
  const myEmail = (state.user?.email || '').toLowerCase();
  const memberByEmail = {};
  for (const m of g.members) memberByEmail[m.email.toLowerCase()] = m;
  if (!g.messages || g.messages.length === 0) {
    wrap.innerHTML = '<div class="dm-empty">no messages yet — say hi 👋</div>';
    return;
  }
  for (const m of g.messages) {
    if (m.system) {
      const sys = document.createElement('div');
      sys.className = 'dm-system';
      sys.textContent = m.text;
      wrap.appendChild(sys);
      continue;
    }
    appendGroupMessageToDOM(m, memberByEmail);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function appendGroupMessageToDOM(m, memberByEmail) {
  const wrap = el('group-messages');
  if (!wrap) return;
  const empty = wrap.querySelector('.dm-empty');
  if (empty) empty.remove();
  const myEmail = (state.user?.email || '').toLowerCase();
  const fromMe = m.from === myEmail;
  const memberByEmailMap = memberByEmail || {};
  const sender = memberByEmailMap[m.from] || { name: m.fromName || m.from, avatar: '' };
  const node = document.createElement('div');
  node.className = 'dm-msg' + (fromMe ? ' from-me' : '');
  node.dataset.id = m.id;
  const senderHtml = fromMe ? '' : `<div class="dm-sender">${escapeHtml((sender.name || '').split(' ')[0])}</div>`;
  node.innerHTML = `
    ${senderHtml}
    <div class="body">${linkify(escapeHtml(m.text))}</div>
    <div class="meta">${timeAgo(m.createdAt)}</div>
  `;
  wrap.appendChild(node);
  wrap.scrollTop = wrap.scrollHeight;
}

async function sendGroupMessage() {
  const input = el('group-input');
  const text = input.value.trim();
  if (!text || !state._currentGroup) return;
  input.value = '';
  try {
    await api('POST', `/api/groups/${encodeURIComponent(state._currentGroup)}/message`, { text });
  } catch (e) {
    toast(e.data?.error || 'send failed');
    input.value = text;
  }
}

function onIncomingGroupMessage({ groupId, message, groupName }) {
  if (!state.user) return;
  const myEmail = (state.user.email || '').toLowerCase();
  // If group modal is open for this group, append. Otherwise toast + push.
  if (state._currentGroup === groupId) {
    const g = state._currentGroupData || { members: [] };
    const memberByEmail = {};
    for (const m of g.members) memberByEmail[m.email.toLowerCase()] = m;
    appendGroupMessageToDOM(message, memberByEmail);
  } else if (message.from !== myEmail) {
    toast(`💬 [${groupName}] new message`, 4000);
    firePushNotification(`👥 ${groupName}`, `${message.fromName}: ${message.text}`, {
      tag: 'group:' + groupId,
      onClick: () => openGroupModal(groupId)
    });
    refreshInboxBadge();
  }
}

async function leaveCurrentGroup() {
  if (!state._currentGroup) return;
  if (!confirm('Leave this group?')) return;
  try {
    await api('DELETE', `/api/groups/${encodeURIComponent(state._currentGroup)}/me`);
    el('group-modal').classList.add('hidden');
    toast('left the group');
    refreshInboxBadge();
  } catch (e) { toast(e.data?.error || 'failed'); }
}

async function addMemberToCurrentGroup() {
  if (!state._currentGroup) return;
  const email = prompt('Add who? (enter their email)');
  if (!email) return;
  try {
    await api('POST', `/api/groups/${encodeURIComponent(state._currentGroup)}/members`, { email });
    toast('added');
    openGroupModal(state._currentGroup); // refresh
  } catch (e) { toast(e.data?.error || 'failed'); }
}

// =================================================================
// @MENTION TYPEAHEAD — attach to any <textarea>/<input> and show a
// floating dropdown of directory names when user types "@xxx"
// =================================================================
async function loadDirectoryForMentions() {
  try {
    const d = await api('GET', '/api/directory');
    state.directory = (d || []).map(x => ({ name: x.name, email: x.email, claimed: !!x.claimed }));
  } catch (e) { console.warn('directory load failed', e); }
}

function attachMentionTypeahead(inputEl) {
  if (!inputEl || inputEl._mentionAttached) return;
  inputEl._mentionAttached = true;
  let dropdown = null;
  let activeIdx = 0;
  let matches = [];

  function close() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    matches = []; activeIdx = 0;
  }
  function currentMentionFragment() {
    const v = inputEl.value || '';
    const pos = inputEl.selectionStart || v.length;
    const before = v.slice(0, pos);
    // Match @ even without any following letters yet — user wants the picker
    // to show immediately when they type @ so they can browse signed-up people.
    const m = before.match(/(?:^|[^a-zA-Z0-9._%+\-])@([a-zA-Z][a-zA-Z'\-\.]{0,30})?$/);
    if (!m) return null;
    return { handle: m[1] || '', start: pos - (m[1] || '').length - 1, end: pos };
  }
  function refresh() {
    const frag = currentMentionFragment();
    if (!frag) { close(); return; }
    const q = frag.handle.toLowerCase();
    // @mention typeahead only matches people who have ACTUALLY signed up.
    // Directory-only people (unclaimed) can't be @-mentioned since the
    // mention is supposed to notify the target — which requires an account.
    const claimed = (state.directory || []).filter(d => d.claimed);
    if (q === '') {
      // Empty @ → show recent / alphabetical list of signed-up users
      matches = claimed.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);
    } else {
      matches = claimed
        .filter(d => {
          const first = (d.name || '').split(' ')[0].toLowerCase();
          const slug = (d.email || '').split('@')[0].toLowerCase();
          return first.startsWith(q) || slug.startsWith(q) || d.name.toLowerCase().includes(q);
        })
        .slice(0, 8);
    }
    if (matches.length === 0) { close(); return; }
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'mention-dropdown';
      document.body.appendChild(dropdown);
    }
    const rect = inputEl.getBoundingClientRect();
    dropdown.style.top = (window.scrollY + rect.bottom + 2) + 'px';
    dropdown.style.left = (window.scrollX + rect.left) + 'px';
    dropdown.style.width = Math.min(280, rect.width) + 'px';
    activeIdx = Math.min(activeIdx, matches.length - 1);
    dropdown.innerHTML = matches.map((m, i) => {
      const first = (m.name || '').split(' ')[0];
      return `<div class="mention-item ${i === activeIdx ? 'active' : ''}" data-i="${i}">
        <strong>${escapeHtml(m.name)}</strong>
        <span class="mention-handle">@${escapeHtml(first.toLowerCase())}</span>
      </div>`;
    }).join('');
    dropdown.querySelectorAll('.mention-item').forEach(it => {
      it.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(parseInt(it.dataset.i)); });
    });
  }
  function pick(i) {
    if (i < 0 || i >= matches.length) return;
    const m = matches[i];
    const frag = currentMentionFragment();
    if (!frag) { close(); return; }
    const v = inputEl.value;
    const before = v.slice(0, frag.start);
    const after = v.slice(frag.end);
    // Insert FULL name (replacing spaces with non-breaking spaces would
    // mess with the mention regex on the server side; instead we just use
    // the regular name and the server-side resolver matches the full string).
    const insert = '@' + (m.name || '') + ' ';
    inputEl.value = before + insert + after;
    const newPos = (before + insert).length;
    try { inputEl.setSelectionRange(newPos, newPos); } catch {}
    inputEl.focus();
    close();
  }
  inputEl.addEventListener('input', refresh);
  inputEl.addEventListener('keydown', (e) => {
    if (!dropdown || matches.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % matches.length; refresh(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + matches.length) % matches.length; refresh(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(activeIdx); }
    else if (e.key === 'Escape') { close(); }
  });
  inputEl.addEventListener('blur', () => setTimeout(close, 150));
}

// Auto-attach to compose + comment inputs as they appear
const _mentionAutoObserver = new MutationObserver(() => {
  document.querySelectorAll('#compose-text, #postit-text, #postit-caption, .comment-input, .profile-board-input, .bulletin-input, .love-letter-msg, .profile-mood-input')
    .forEach(attachMentionTypeahead);
});
window.addEventListener('DOMContentLoaded', () => {
  _mentionAutoObserver.observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('#compose-text, #postit-text, #postit-caption').forEach(attachMentionTypeahead);
});

// =================================================================
// LOVE LETTER — viral anonymous-crush chain
// =================================================================
function openLoveLetterModal(prefillEmail) {
  let modal = el('love-letter-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'love-letter-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="window">
        <div class="kicker">love letter 💌</div>
        <button class="modal-close" data-close="love-letter-modal">✕</button>
        <h2 class="big-title">send an anonymous crush</h2>
        <p class="subtitle">we'll email them: <em>"someone has a crush on you. pick the 3 people you think it might be."</em><br/>they'll have to pick 3 names. each of those gets the same email. it spreads.</p>
        <input type="text" id="love-letter-to" class="scribble-input" placeholder="who's your crush? (start typing a name)" autocomplete="off"/>
        <div id="love-letter-suggest" class="ll-suggest"></div>
        <textarea id="love-letter-msg-text" class="scribble-input scribble-textarea love-letter-msg" placeholder="(optional) write them an anonymous note. e.g. 'i sit two rows behind you in english'" maxlength="280"></textarea>
        <p class="subtitle" style="font-size:11px; margin:8px 16px;">they will never know it's you. promise. 🤐</p>
        <button id="love-letter-send" class="scribble-button big-btn">send love letter →</button>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-close]').addEventListener('click', () => modal.classList.add('hidden'));

    const inp = modal.querySelector('#love-letter-to');
    const sug = modal.querySelector('#love-letter-suggest');
    let picked = null;
    inp.addEventListener('input', () => {
      picked = null;
      const q = inp.value.trim().toLowerCase();
      if (!q) { sug.innerHTML = ''; return; }
      const results = (state.directory || [])
        .filter(d => d.email.toLowerCase() !== (state.user?.email || '').toLowerCase())
        .filter(d => d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q))
        .slice(0, 6);
      sug.innerHTML = results.map(r => `
        <div class="ll-sug-item" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}">
          <strong>${escapeHtml(r.name)}</strong>
          <span style="color:var(--text-3); font-size:10px;">${r.claimed ? 'already on Old Streets' : 'not on yet — will get an invite'}</span>
        </div>`).join('');
      sug.querySelectorAll('.ll-sug-item').forEach(it => {
        it.addEventListener('click', () => {
          picked = { email: it.dataset.email, name: it.dataset.name };
          inp.value = it.dataset.name;
          sug.innerHTML = '';
        });
      });
    });

    modal.querySelector('#love-letter-send').addEventListener('click', async () => {
      if (!picked) {
        // try exact match
        const q = inp.value.trim().toLowerCase();
        const found = (state.directory || []).find(d => d.name.toLowerCase() === q);
        if (found) picked = { email: found.email, name: found.name };
      }
      if (!picked) { toast('pick someone from the list 👀'); return; }
      const msg = modal.querySelector('#love-letter-msg-text').value.trim();
      const btn = modal.querySelector('#love-letter-send');
      btn.disabled = true; btn.textContent = 'sending…';
      try {
        const r = await api('POST', '/api/love-letter', { toEmail: picked.email, toName: picked.name, message: msg });
        modal.classList.add('hidden');
        if (r && r.matched && r.match) {
          // INSTANT MATCH — they had crushed us first, reveal both ways
          setTimeout(() => openCrushMatchModal({
            matchedName: r.match.otherName,
            matchedEmail: r.match.otherEmail
          }), 400);
        } else {
          toast('💌 love letter sent — they\'ll never know it was you', 5500);
        }
      } catch (e) {
        toast(e.data?.error || 'send failed');
      } finally {
        btn.disabled = false; btn.textContent = 'send love letter →';
      }
    });
  }
  modal.classList.remove('hidden');
  if (prefillEmail) {
    const d = (state.directory || []).find(x => x.email === prefillEmail);
    if (d) modal.querySelector('#love-letter-to').value = d.name;
  } else {
    modal.querySelector('#love-letter-to').value = '';
  }
  modal.querySelector('#love-letter-msg-text').value = '';
  modal.querySelector('#love-letter-suggest').innerHTML = '';
}

// =================================================================
// CRUSH-PICK-3 — the receive end of a love letter
// =================================================================
function openCrushPick3Modal(senderId) {
  let modal = el('crush-pick3-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'crush-pick3-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="window">
        <div class="kicker">💌 someone has a crush on you</div>
        <button class="modal-close" data-close="crush-pick3-modal">✕</button>
        <h2 class="big-title">Who do you think it is?</h2>
        <p class="subtitle">Pick the 3 people you think have a crush on you. We'll never tell you if you got it right — the sender is anonymous forever. But it'll bug you 'til you find out 😈</p>
        <div id="crush-picks" style="padding: 8px 16px; display:flex; flex-direction:column; gap:6px;">
          <input type="text" class="scribble-input cp-input" data-i="0" placeholder="guess 1 — start typing a name"/>
          <input type="text" class="scribble-input cp-input" data-i="1" placeholder="guess 2"/>
          <input type="text" class="scribble-input cp-input" data-i="2" placeholder="guess 3"/>
        </div>
        <div id="cp-suggest" class="ll-suggest"></div>
        <div id="cp-result" class="hidden"></div>
        <button id="cp-send" class="scribble-button big-btn">submit my 3 guesses →</button>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-close]').addEventListener('click', () => modal.classList.add('hidden'));

    const sug = modal.querySelector('#cp-suggest');
    const picks = [null, null, null];
    let activeInput = null;
    modal.querySelectorAll('.cp-input').forEach(inp => {
      inp.addEventListener('focus', () => { activeInput = inp; });
      inp.addEventListener('input', () => {
        const idx = parseInt(inp.dataset.i);
        picks[idx] = null;
        const q = inp.value.trim().toLowerCase();
        if (!q) { sug.innerHTML = ''; return; }
        const results = (state.directory || [])
          .filter(d => d.email.toLowerCase() !== (state.user?.email || '').toLowerCase())
          .filter(d => d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q))
          .slice(0, 6);
        sug.innerHTML = results.map(r => `
          <div class="ll-sug-item" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}">
            <strong>${escapeHtml(r.name)}</strong>
          </div>`).join('');
        sug.querySelectorAll('.ll-sug-item').forEach(it => {
          it.addEventListener('click', () => {
            picks[idx] = { email: it.dataset.email, name: it.dataset.name };
            inp.value = it.dataset.name;
            sug.innerHTML = '';
          });
        });
      });
    });

    modal.querySelector('#cp-send').addEventListener('click', async () => {
      // try to auto-resolve any unresolved picks by exact name match
      modal.querySelectorAll('.cp-input').forEach(inp => {
        const idx = parseInt(inp.dataset.i);
        if (picks[idx]) return;
        const q = inp.value.trim().toLowerCase();
        const found = (state.directory || []).find(d => d.name.toLowerCase() === q);
        if (found) picks[idx] = { email: found.email, name: found.name };
      });
      const filled = picks.filter(Boolean);
      if (filled.length < 3) { toast('pick 3 people 👀'); return; }
      // dedupe
      const seen = new Set();
      const unique = filled.filter(p => { const k = p.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
      if (unique.length < 3) { toast('pick 3 *different* people'); return; }
      const btn = modal.querySelector('#cp-send');
      btn.disabled = true; btn.textContent = 'submitting…';
      try {
        const r = await api('POST', '/api/love-letter/respond', {
          senderId: modal.dataset.senderId,
          picks: unique.map(p => ({ email: p.email, name: p.name }))
        });
        const resultBox = modal.querySelector('#cp-result');
        resultBox.classList.remove('hidden');
        if (r.matched && r.matchedName) {
          // GOT THEM
          resultBox.innerHTML = `
            <div class="crush-result matched" style="border-color: #ff1493; background: #fff0f7;">
              <div class="crush-result-title">🎯 YOU GOT IT.</div>
              <div class="crush-result-name">${escapeHtml(r.matchedName)}</div>
              <div class="crush-result-sub">they're the one who sent you the love letter.</div>
              <p style="font-size: 12px; color: var(--text-3); margin: 8px 16px 4px;">your other 2 guesses got an anonymous love letter too — they'll start their own chains.</p>
              ${r.matchedEmail ? `<button class="scribble-button" id="cp-view-match">view ${escapeHtml(r.matchedName)} →</button>` : ''}
            </div>`;
          const vBtn = resultBox.querySelector('#cp-view-match');
          if (vBtn) vBtn.addEventListener('click', () => {
            modal.classList.add('hidden');
            navigateToProfile(r.matchedEmail);
          });
        } else {
          // MISSED ALL 3
          resultBox.innerHTML = `
            <div class="crush-result missed">
              <div class="crush-result-title">😶 none of those.</div>
              <div class="crush-result-sub">that was your 3 guesses. the crush stays a secret forever now.</div>
              <p style="font-size: 12px; color: var(--text); margin: 10px 16px;">your 3 guesses just got an anonymous "someone has a crush on you" message. the chain spreads.</p>
              <button class="scribble-button" id="cp-close-result">got it</button>
            </div>`;
        }
        const closeBtn = resultBox.querySelector('#cp-close-result');
        if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
        modal.querySelectorAll('.cp-input').forEach(i => i.disabled = true);
        btn.style.display = 'none';
      } catch (e) {
        toast(e.data?.error || 'send failed');
      } finally {
        btn.disabled = false; btn.textContent = 'submit my 3 guesses →';
      }
    });
  }
  modal.dataset.senderId = senderId || '';
  modal.classList.remove('hidden');
  modal.querySelectorAll('.cp-input').forEach(inp => { inp.value = ''; });
  modal.querySelector('#cp-suggest').innerHTML = '';
}

// =================================================================
// PROFILE BOARD — MySpace-style public comments wall on each profile
// =================================================================
function renderProfileBoard(boardEl, profile, items) {
  boardEl.innerHTML = `
    <div class="fb-box-header"><span>Comments</span><span class="count">${items.length}</span></div>
    <div class="profile-board-list" id="pb-list-${profile.email}"></div>
    <div class="profile-board-compose">
      <textarea class="scribble-input profile-board-input" maxlength="400" placeholder="leave them a comment..."></textarea>
      <div style="display:flex; align-items:center; gap:6px; margin-top:6px;">
        <label style="font-size:10px; color:var(--text-3); cursor:pointer;">
          <input type="checkbox" class="pb-anon" style="vertical-align:middle;"/> post as anonymous 🥷
        </label>
        <span style="flex:1;"></span>
        <button class="scribble-button pb-submit" style="font-size:11px;">post →</button>
      </div>
    </div>`;
  const list = boardEl.querySelector('.profile-board-list');
  list.innerHTML = items.length ? items.map(it => `
    <div class="profile-board-item" data-id="${it.id}">
      <div class="pb-head">
        <strong class="${it.isAnonymous ? 'anon' : ''}" ${!it.isAnonymous && it.authorEmail ? `data-email="${escapeHtml(it.authorEmail)}"` : ''}>
          ${it.isAnonymous ? 'anonymous' : escapeHtml(it.authorName)}
        </strong>
        <span class="pb-time">${timeAgo(it.createdAt)}</span>
      </div>
      <div class="pb-body">${linkify(escapeHtml(it.text))}</div>
    </div>`).join('') : '<div class="comment-empty" style="padding:10px;">no comments yet — be the first to leave one.</div>';
  list.querySelectorAll('strong[data-email]').forEach(s => {
    s.style.cursor = 'pointer';
    s.style.textDecoration = 'underline';
    s.addEventListener('click', () => navigateToProfile(s.dataset.email));
  });
  const sub = boardEl.querySelector('.pb-submit');
  const inp = boardEl.querySelector('.profile-board-input');
  const anonCb = boardEl.querySelector('.pb-anon');
  sub.addEventListener('click', async () => {
    const t = inp.value.trim();
    if (!t) return;
    sub.disabled = true;
    try {
      await api('POST', `/api/users/profile/${encodeURIComponent(profile.email)}/board`, { text: t, anon: !!anonCb.checked });
      inp.value = '';
      const fresh = await api('GET', `/api/users/profile/${encodeURIComponent(profile.email)}/board`);
      renderProfileBoard(boardEl, profile, fresh);
    } catch (e) { toast(e.data?.error || 'failed'); }
    finally { sub.disabled = false; }
  });
}

// =================================================================
// "WHO VIEWED ME MOST THIS WEEK" widget (public — anyone can see for any profile)
// =================================================================
async function loadWhoViewedMeMost() {
  try {
    const data = await api('GET', '/api/profile-views/top-this-week');
    const box = el('vmm-box');
    if (!box || !Array.isArray(data) || data.length === 0) {
      if (box) box.style.display = 'none';
      return;
    }
    box.style.display = '';
    const list = el('vmm-list');
    list.innerHTML = data.map((v, i) => `
      <li>
        <span class="lb-rank">#${i + 1}</span>
        <span class="lb-name" data-email="${escapeHtml(v.email)}">${escapeHtml(v.name)}</span>
        <span class="lb-pts">${v.views}×</span>
      </li>`).join('');
    list.querySelectorAll('.lb-name').forEach(n => {
      n.style.cursor = 'pointer';
      n.addEventListener('click', () => navigateToProfile(n.dataset.email));
    });
  } catch (e) { /* widget is optional */ }
}

// =================================================================
// BULLETINS — broadcast a quick post to friends only (classic MySpace)
// =================================================================
async function loadBulletins() {
  try {
    const items = await api('GET', '/api/bulletins');
    const box = el('bulletins-box');
    if (!box) return;
    if (!items || items.length === 0) { box.style.display = 'none'; return; }
    box.style.display = '';
    const list = el('bulletins-list');
    list.innerHTML = items.slice(0, 5).map(b => `
      <li class="bulletin-item">
        <strong data-email="${escapeHtml(b.authorEmail)}">${escapeHtml(b.authorName)}</strong>
        <span class="bul-time">${timeAgo(b.createdAt)}</span>
        <div class="bul-body">${linkify(escapeHtml(b.text))}</div>
      </li>`).join('');
    list.querySelectorAll('strong[data-email]').forEach(s => {
      s.style.cursor = 'pointer';
      s.addEventListener('click', () => navigateToProfile(s.dataset.email));
    });
  } catch (e) {}
}

function openBulletinModal() {
  let m = el('bulletin-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'bulletin-modal';
    m.className = 'modal hidden';
    m.innerHTML = `
      <div class="window">
        <div class="kicker">bulletin · friends-only broadcast</div>
        <button class="modal-close" data-close="bulletin-modal">✕</button>
        <h2 class="big-title">post a bulletin</h2>
        <p class="subtitle">classic myspace move. goes out to your friends only.</p>
        <textarea id="bulletin-text" class="scribble-input scribble-textarea bulletin-input" placeholder="what's the bulletin..." maxlength="500"></textarea>
        <button id="bulletin-send" class="scribble-button big-btn">post bulletin →</button>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('[data-close]').addEventListener('click', () => m.classList.add('hidden'));
    m.querySelector('#bulletin-send').addEventListener('click', async () => {
      const t = m.querySelector('#bulletin-text').value.trim();
      if (!t) { toast('write something'); return; }
      const b = m.querySelector('#bulletin-send');
      b.disabled = true; b.textContent = 'posting…';
      try {
        await api('POST', '/api/bulletins', { text: t });
        m.classList.add('hidden');
        toast('bulletin posted 📢');
        loadBulletins();
      } catch (e) { toast(e.data?.error || 'failed'); }
      finally { b.disabled = false; b.textContent = 'post bulletin →'; }
    });
  }
  m.querySelector('#bulletin-text').value = '';
  m.classList.remove('hidden');
}

// =================================================================
// MOOD / HEADLINE / THEME save helpers
// =================================================================
async function updateProfileFields(patch) {
  try {
    await api('POST', '/api/users/me', patch);
    Object.assign(state.user, patch);
  } catch (e) { toast(e.data?.error || 'save failed'); }
}

// Apply a theme — a curated color palette (no arbitrary CSS for safety)
const PROFILE_THEMES = {
  classic:   { primary: '#3B5998', bg: '#f0f2f5', accent: '#6979c4' },
  midnight:  { primary: '#1a1a2e', bg: '#0f0f1f', accent: '#e94560' },
  candy:     { primary: '#ff6ec7', bg: '#fff0f7', accent: '#ffb86b' },
  matrix:    { primary: '#0d6e0d', bg: '#0a0a0a', accent: '#33ff33' },
  sunset:    { primary: '#ff7e5f', bg: '#feb47b', accent: '#fff' },
  cyber:     { primary: '#00ffff', bg: '#1a0033', accent: '#ff00ff' },
  paper:     { primary: '#2b2b2b', bg: '#fafaf5', accent: '#c0392b' },
  iceblue:   { primary: '#0b486b', bg: '#cce6f4', accent: '#f56991' },
};

function applyProfileTheme(themeName, scope) {
  const t = PROFILE_THEMES[themeName];
  if (!t) return;
  const el = scope || document.body;
  el.style.setProperty('--theme-primary', t.primary);
  el.style.setProperty('--theme-bg', t.bg);
  el.style.setProperty('--theme-accent', t.accent);
  el.dataset.theme = themeName;
}

// =================================================================
// MOOD CATALOG + BLINKIES — fetched once, cached for the session
// =================================================================
let MOOD_CATALOG_CACHE = [];
let BLINKY_CATALOG_CACHE = [];
let SURVEY_TEMPLATES_CACHE = [];

async function ensureMoodCatalog() {
  if (MOOD_CATALOG_CACHE.length) return MOOD_CATALOG_CACHE;
  try { MOOD_CATALOG_CACHE = await api('GET', '/api/moods') || []; }
  catch { MOOD_CATALOG_CACHE = []; }
  return MOOD_CATALOG_CACHE;
}
async function ensureBlinkyCatalog() {
  if (BLINKY_CATALOG_CACHE.length) return BLINKY_CATALOG_CACHE;
  try { BLINKY_CATALOG_CACHE = await api('GET', '/api/blinkies') || []; }
  catch { BLINKY_CATALOG_CACHE = []; }
  return BLINKY_CATALOG_CACHE;
}
async function ensureSurveyTemplates() {
  if (SURVEY_TEMPLATES_CACHE.length) return SURVEY_TEMPLATES_CACHE;
  try { SURVEY_TEMPLATES_CACHE = await api('GET', '/api/surveys/templates') || []; }
  catch { SURVEY_TEMPLATES_CACHE = []; }
  return SURVEY_TEMPLATES_CACHE;
}

async function renderMoodPicker(selectedId) {
  const grid = el('edit-mood-grid');
  if (!grid) return;
  const moods = await ensureMoodCatalog();
  state._selectedMoodId = selectedId || '';
  grid.innerHTML = moods.map(m => `
    <button type="button" class="mood-chip ${m.id === selectedId ? 'selected' : ''}" data-id="${m.id}" data-label="${escapeHtml(m.emoji + ' ' + m.label)}">
      <span class="mood-emoji">${m.emoji}</span>
      <span class="mood-label">${escapeHtml(m.label)}</span>
    </button>
  `).join('');
  grid.querySelectorAll('.mood-chip').forEach(b => {
    b.addEventListener('click', () => {
      grid.querySelectorAll('.mood-chip').forEach(c => c.classList.remove('selected'));
      b.classList.add('selected');
      state._selectedMoodId = b.dataset.id;
      if (el('edit-mood')) el('edit-mood').value = b.dataset.label;
    });
  });
}

async function renderBlinkiesPicker(selectedSet) {
  const grid = el('edit-blinkies-grid');
  if (!grid) return;
  const blinkies = await ensureBlinkyCatalog();
  grid.innerHTML = blinkies.map(b => `
    <button type="button" class="blinky-pick ${selectedSet.has(b.id) ? 'selected' : ''}" data-id="${b.id}" title="${escapeHtml(b.text)}">
      ${renderBlinkyMarkup(b)}
    </button>
  `).join('');
  grid.querySelectorAll('.blinky-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (selectedSet.has(id)) selectedSet.delete(id);
      else if (selectedSet.size < 8) selectedSet.add(id);
      else { toast('max 8 blinkies'); return; }
      btn.classList.toggle('selected');
    });
  });
}

function renderBlinkyMarkup(b) {
  // CSS-only blinky — gradient bar with a 1-step animation
  return `<span class="blinky" style="background:${b.bg}; color:${b.fg};">${escapeHtml(b.text)}</span>`;
}

// =================================================================
// PROFILE MUSIC EMBED — renders an iframe player for the song
// =================================================================
function renderProfileMusic(embed) {
  if (!embed) return '';
  if (embed.kind === 'youtube') {
    return `<div class="profile-music">
      <div class="profile-music-label">🎵 profile song</div>
      <iframe src="${escapeAttr(embed.embedUrl)}" frameborder="0"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowfullscreen
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-presentation"
        style="width:100%; aspect-ratio: 16/9; max-height: 220px; border: 0;"></iframe>
    </div>`;
  }
  if (embed.kind === 'spotify') {
    // Spotify needs forms+popups for its login/save buttons. Sandbox was
    // crippling playback — remove it; use generator-suffix URL which is the
    // current canonical embed pattern.
    const url = embed.embedUrl.includes('?')
      ? embed.embedUrl
      : embed.embedUrl + '?utm_source=generator';
    return `<div class="profile-music">
      <div class="profile-music-label">🎵 profile song</div>
      <iframe src="${escapeAttr(url)}" frameborder="0"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        allowtransparency="true"
        loading="lazy"
        style="width:100%; height: 152px; border: 0; border-radius: 12px;"></iframe>
    </div>`;
  }
  if (embed.kind === 'soundcloud') {
    return `<div class="profile-music">
      <div class="profile-music-label">🎵 profile song</div>
      <iframe src="${escapeAttr(embed.embedUrl)}" frameborder="no" scrolling="no"
        allow="autoplay"
        loading="lazy"
        style="width:100%; height: 120px; border: 0;"></iframe>
    </div>`;
  }
  if (embed.kind === 'bandcamp') {
    return `<div class="profile-music">
      <div class="profile-music-label">🎵 profile song</div>
      <a href="${escapeAttr(embed.linkOnly)}" target="_blank" rel="noopener" class="auth-btn secondary">▶ Listen on Bandcamp</a>
    </div>`;
  }
  return '';
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =================================================================
// PROFILE BACKGROUND + CUSTOM CSS — applied scoped to the profile detail
// =================================================================
// Normalize common social-image share URLs into direct media URLs. People
// paste tenor.com/view/... and giphy.com/gifs/... share pages all the time
// — those are HTML, not images, so the browser silently fails to render.
function normalizeBackgroundUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  // Giphy page → direct media URL. Extract the trailing -<id> segment.
  // Example: https://giphy.com/gifs/cute-cat-3oEjI5VtIhHvK37WYo → media.giphy.com/media/3oEjI5VtIhHvK37WYo/giphy.gif
  const giphyMatch = url.match(/giphy\.com\/gifs\/(?:[a-z0-9-]+-)?([a-zA-Z0-9]{8,})(?:[/?#]|$)/i);
  if (giphyMatch) return `https://media.giphy.com/media/${giphyMatch[1]}/giphy.gif`;
  // Tenor page → swap to media.tenor.com if we can recognize the id. Many
  // tenor share URLs end in /view/<slug>-<numeric-id>. Tenor's CDN serves
  // mBYyJweEnUoAAAAM/<slug>.gif but the format ID isn't in the page URL,
  // so the best we can do is route through tenor's "media1" subdomain
  // pattern which tends to redirect for short IDs. If it's already a direct
  // media.tenor.com URL, leave it alone.
  if (/^https?:\/\/(media\.|c\.)tenor\.com\//i.test(url)) return url;
  // Imgur "page" URLs → swap to i.imgur.com
  const imgurMatch = url.match(/^https?:\/\/(?:www\.)?imgur\.com\/([a-zA-Z0-9]{5,8})(?:\.[a-z]+)?$/i);
  if (imgurMatch) return `https://i.imgur.com/${imgurMatch[1]}.gif`;
  return url;
}

function applyProfileBackground(scope, profile) {
  if (!scope) return;
  const rawUrl = profile.backgroundUrl;
  const resolved = rawUrl ? normalizeBackgroundUrl(rawUrl) : '';
  if (resolved) {
    scope.style.backgroundImage = `url("${resolved.replace(/"/g, '%22')}")`;
    const mode = profile.backgroundMode || 'cover';
    scope.style.backgroundRepeat = mode === 'tile' ? 'repeat' : 'no-repeat';
    scope.style.backgroundSize = mode === 'tile' ? 'auto' : (mode === 'center' ? 'auto' : mode);
    scope.style.backgroundPosition = 'center top';
    // backgroundAttachment: 'fixed' freezes GIF animation on iOS Safari and
    // most mobile browsers — animated backgrounds need 'scroll' (default)
    // so the browser keeps decoding frames.
    scope.style.backgroundAttachment = 'scroll';
    scope.classList.add('has-bg');
    // Preload-probe: if the URL fails to load (tenor.com/view/..., 404, etc),
    // strip it so we don't leave a broken background and we surface the issue.
    const probe = new Image();
    probe.onerror = () => {
      console.warn('[profile-bg] image failed to load — clearing:', resolved);
      scope.style.backgroundImage = '';
      scope.classList.remove('has-bg');
      scope.style.removeProperty('--bg-overlay-alpha');
    };
    probe.src = resolved;
    const opac = typeof profile.backgroundOpacity === 'number' ? profile.backgroundOpacity : 85;
    scope.style.setProperty('--bg-overlay-alpha', (opac / 100).toFixed(2));
  } else {
    scope.style.backgroundImage = '';
    scope.classList.remove('has-bg');
    scope.style.removeProperty('--bg-overlay-alpha');
  }
}

function applyProfileCustomCss(scope, css, ownerKey) {
  // Inject scoped CSS via a <style> child of `scope`, prefixed with a
  // unique data-attribute so rules don't bleed into other profiles.
  if (!scope) return;
  scope.querySelectorAll('style.profile-custom-css').forEach(s => s.remove());
  if (!css) return;
  const safe = String(css)
    .replace(/<\/style/gi, '')  // can't break out of <style>
    .replace(/<!--|-->/g, '');
  // Prefix every rule with [data-profile-owner="..."] so it's scoped
  const scopedSel = `[data-profile-owner="${(ownerKey || '').replace(/"/g, '')}"]`;
  let scoped = '';
  let depth = 0, buf = '', sel = '';
  let inComment = false;
  for (let i = 0; i < safe.length; i++) {
    const ch = safe[i], next = safe[i+1] || '';
    if (inComment) {
      if (ch === '*' && next === '/') { inComment = false; i++; }
      continue;
    }
    if (ch === '/' && next === '*') { inComment = true; i++; continue; }
    if (depth === 0) {
      if (ch === '{') {
        depth = 1;
        const selectors = sel.split(',').map(s => s.trim()).filter(Boolean)
          .map(s => s.startsWith('@') ? s : `${scopedSel} ${s}`)
          .join(', ');
        scoped += selectors + '{';
        sel = '';
        buf = '';
      } else sel += ch;
    } else {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) scoped += buf + '}';
      else buf += ch;
      if (depth === 0) buf = '';
    }
  }
  const style = document.createElement('style');
  style.className = 'profile-custom-css';
  style.textContent = scoped;
  scope.appendChild(style);
  scope.setAttribute('data-profile-owner', ownerKey || '');
}

// =================================================================
// BLOG UI — list + detail + composer
// =================================================================
async function loadBlogs() {
  try {
    const items = await api('GET', '/api/blogs');
    const box = el('blogs-box');
    const list = el('blogs-list');
    if (!box || !list) return;
    if (!items || items.length === 0) { box.style.display = 'none'; return; }
    box.style.display = '';
    list.innerHTML = items.slice(0, 8).map(b => `
      <li class="blog-row" data-id="${escapeHtml(b.id)}">
        <a class="blog-row-title" href="#blogs/${escapeHtml(b.id)}">${escapeHtml(b.title)}</a>
        <span class="blog-row-by">${escapeHtml((b.authorName || '').split(' ')[0])} · ${timeAgo(b.createdAt)}</span>
      </li>
    `).join('');
    list.querySelectorAll('.blog-row').forEach(r => {
      r.style.cursor = 'pointer';
      r.addEventListener('click', () => openBlogDetail(r.dataset.id));
    });
  } catch (e) { /* optional */ }
}

function openBlogComposer() {
  let m = el('blog-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'blog-modal';
    m.className = 'modal hidden';
    m.innerHTML = `
      <div class="window">
        <div class="kicker">new blog · long-form</div>
        <button class="modal-close" data-close="blog-modal">✕</button>
        <h2 class="big-title">📝 write a blog</h2>
        <input type="text" id="blog-title" class="scribble-input" placeholder="title (max 120)" maxlength="120"/>
        <textarea id="blog-body" class="scribble-input scribble-textarea" placeholder="write the post. basic HTML allowed — &lt;b&gt; &lt;i&gt; &lt;u&gt; &lt;font color&gt; &lt;marquee&gt; etc." maxlength="16000" style="min-height: 240px;"></textarea>
        <p class="auth-note" style="margin: 4px 16px; font-size:10px; padding:0; border:0;">scripts are stripped. images: paste an &lt;img src="https://..."&gt; tag.</p>
        <button id="blog-publish" class="scribble-button big-btn">publish blog →</button>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('[data-close]').addEventListener('click', () => m.classList.add('hidden'));
    m.querySelector('#blog-publish').addEventListener('click', async () => {
      const title = m.querySelector('#blog-title').value.trim();
      const body = m.querySelector('#blog-body').value.trim();
      if (!title || !body) { toast('title + body required'); return; }
      const btn = m.querySelector('#blog-publish');
      btn.disabled = true; btn.textContent = 'publishing…';
      try {
        const r = await api('POST', '/api/blogs', { title, body });
        m.classList.add('hidden');
        toast('blog published 📝');
        loadBlogs();
        openBlogDetail(r.id);
      } catch (e) { toast(e.data?.error || 'failed'); }
      finally { btn.disabled = false; btn.textContent = 'publish blog →'; }
    });
  }
  m.querySelector('#blog-title').value = '';
  m.querySelector('#blog-body').value = '';
  m.classList.remove('hidden');
}

async function openBlogDetail(blogId) {
  let m = el('blog-detail-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'blog-detail-modal';
    m.className = 'modal hidden';
    m.innerHTML = `<div class="window blog-window">
      <button class="modal-close" data-close="blog-detail-modal">✕</button>
      <div id="blog-detail-content"></div>
    </div>`;
    document.body.appendChild(m);
    m.querySelector('[data-close]').addEventListener('click', () => m.classList.add('hidden'));
  }
  const wrap = m.querySelector('#blog-detail-content');
  wrap.innerHTML = '<div style="padding:30px; text-align:center; color:var(--text-3);">loading…</div>';
  m.classList.remove('hidden');
  try {
    const b = await api('GET', `/api/blogs/${encodeURIComponent(blogId)}`);
    const totalReacts = Object.values(b.reactions || {}).reduce((n, r) => n + Object.keys(r).length, 0);
    const myReaction = REACTIONS.find(e => b.reactions && b.reactions[e] && b.reactions[e][state.user.email]) || null;
    const reactionsHtml = REACTIONS.map(e => {
      const count = b.reactions[e] ? Object.keys(b.reactions[e]).length : 0;
      return `<button class="react-btn ${myReaction === e ? 'active' : ''}" data-emoji="${e}">${e} <span class="react-count">${count}</span></button>`;
    }).join('');
    wrap.innerHTML = `
      <div class="kicker">📝 blog</div>
      <h2 class="big-title" style="margin-bottom: 4px;">${escapeHtml(b.title)}</h2>
      <div style="font-size: 11px; color: var(--text-3); margin: 0 16px 12px;">
        by <a class="blog-author-link" data-email="${escapeHtml(b.authorEmail)}">${escapeHtml(b.authorName)}</a>
        · ${escapeHtml(formatDate(b.createdAt))} · ${timeAgo(b.createdAt)}
      </div>
      <div class="blog-body">${b.bodyHtml}</div>
      <div class="post-actions" style="margin: 8px 16px;">
        <span class="reaction-row">${reactionsHtml}</span>
        <span style="flex:1;"></span>
        <span style="font-size:11px; color:var(--text-3);">${totalReacts} reactions · ${(b.comments || []).length} comments</span>
      </div>
      <div class="post-detail-comments-header" style="margin: 0 16px;">comments (${(b.comments || []).length})</div>
      <div class="comments-list" id="blog-comments" style="margin: 0 16px;"></div>
      <div class="comment-input-row" style="margin: 8px 16px;">
        <input type="text" class="scribble-input comment-input" placeholder="say something..." maxlength="400"/>
        <button class="scribble-button comment-send">send</button>
      </div>`;
    // reactions
    wrap.querySelectorAll('.react-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const e = btn.dataset.emoji;
        const newE = myReaction === e ? null : e;
        try { await api('POST', `/api/blogs/${b.id}/react`, { emoji: newE }); openBlogDetail(b.id); }
        catch { toast('reaction failed'); }
      });
    });
    // author link
    wrap.querySelector('.blog-author-link').addEventListener('click', () => {
      m.classList.add('hidden');
      navigateToProfile(b.authorEmail);
    });
    // comments
    const cmtList = wrap.querySelector('#blog-comments');
    if ((b.comments || []).length === 0) {
      cmtList.innerHTML = '<div class="comment-empty">no comments yet</div>';
    } else {
      cmtList.innerHTML = b.comments.map(c => `
        <div class="comment-row">
          <strong data-email="${escapeHtml(c.authorEmail)}">${escapeHtml(c.author)}</strong>
          <span class="comment-time">${timeAgo(c.createdAt)}</span>
          <div class="comment-body">${linkify(escapeHtml(c.text))}</div>
        </div>`).join('');
      cmtList.querySelectorAll('strong[data-email]').forEach(s => {
        s.style.cursor = 'pointer';
        s.addEventListener('click', () => { m.classList.add('hidden'); navigateToProfile(s.dataset.email); });
      });
    }
    // send comment
    const cmtInp = wrap.querySelector('.comment-input');
    const cmtBtn = wrap.querySelector('.comment-send');
    const send = async () => {
      const text = cmtInp.value.trim();
      if (!text) return;
      cmtInp.value = '';
      try {
        await api('POST', `/api/blogs/${b.id}/comment`, { text });
        openBlogDetail(b.id);
      } catch { toast('comment failed'); }
    };
    cmtBtn.addEventListener('click', send);
    cmtInp.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  } catch (e) {
    wrap.innerHTML = '<div style="padding:30px; text-align:center; color:var(--text-3);">blog not found.</div>';
  }
}

// =================================================================
// SURVEY UI — pick template → fill answers → posts as type='survey'
// =================================================================
async function openSurveyComposer() {
  const templates = await ensureSurveyTemplates();
  let m = el('survey-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'survey-modal';
    m.className = 'modal hidden';
    m.innerHTML = `<div class="window">
      <div class="kicker">📋 survey</div>
      <button class="modal-close" data-close="survey-modal">✕</button>
      <h2 class="big-title">post a survey</h2>
      <p class="subtitle">classic. pick a template, fill it out, post it. people will fill out theirs too.</p>
      <div id="survey-picker"></div>
      <div id="survey-fill" class="hidden"></div>
    </div>`;
    document.body.appendChild(m);
    m.querySelector('[data-close]').addEventListener('click', () => m.classList.add('hidden'));
  }
  const picker = m.querySelector('#survey-picker');
  const fill = m.querySelector('#survey-fill');
  picker.classList.remove('hidden');
  fill.classList.add('hidden');
  picker.innerHTML = templates.map(t => `
    <button class="survey-template-btn" data-id="${t.id}">
      <strong>${escapeHtml(t.title)}</strong>
      <span class="survey-q-count">${t.questions.length} questions</span>
    </button>
  `).join('');
  picker.querySelectorAll('.survey-template-btn').forEach(btn => {
    btn.addEventListener('click', () => showSurveyFillStep(m, templates.find(t => t.id === btn.dataset.id)));
  });
  m.classList.remove('hidden');
}

function showSurveyFillStep(m, tpl) {
  const picker = m.querySelector('#survey-picker');
  const fill = m.querySelector('#survey-fill');
  picker.classList.add('hidden');
  fill.classList.remove('hidden');
  fill.innerHTML = `
    <button id="survey-back" class="auth-btn secondary" style="margin: 0 16px;">← pick a different one</button>
    <h3 style="margin: 10px 16px 4px; color: var(--fb-blue);">${escapeHtml(tpl.title)}</h3>
    <div class="survey-fill-list">
      ${tpl.questions.map((q, i) => `
        <div class="survey-q-row">
          <label class="survey-q">${escapeHtml(q)}</label>
          <input type="text" class="scribble-input survey-a" data-i="${i}" maxlength="240" placeholder="your answer..."/>
        </div>
      `).join('')}
    </div>
    <label style="font-size: 11px; color: var(--text-3); margin: 6px 16px; display:block; cursor: pointer;">
      <input type="checkbox" id="survey-anon" style="vertical-align:middle;"/> post anonymously 🥷
    </label>
    <button id="survey-post" class="scribble-button big-btn">post survey →</button>
  `;
  fill.querySelector('#survey-back').addEventListener('click', () => openSurveyComposer());
  fill.querySelector('#survey-post').addEventListener('click', async () => {
    const answers = Array.from(fill.querySelectorAll('.survey-a')).map(i => i.value.trim());
    if (answers.every(a => !a)) { toast('fill at least one answer'); return; }
    const anon = !!fill.querySelector('#survey-anon').checked;
    const btn = fill.querySelector('#survey-post');
    btn.disabled = true; btn.textContent = 'posting…';
    try {
      await api('POST', '/api/posts', {
        type: 'survey',
        content: JSON.stringify({ templateId: tpl.id, title: tpl.title, answers }),
        anon
      });
      m.classList.add('hidden');
      toast('survey posted 📋');
    } catch (e) { toast(e.data?.error || 'failed'); }
    finally { btn.disabled = false; btn.textContent = 'post survey →'; }
  });
}

// Render a survey post inside a feed card or detail
function renderSurveyContent(post) {
  try {
    const parsed = typeof post.content === 'string' ? JSON.parse(post.content) : post.content;
    if (!parsed || !parsed.answers) return escapeHtml(post.content || '');
    const tpl = SURVEY_TEMPLATES_CACHE.find(t => t.id === parsed.templateId);
    const questions = tpl ? tpl.questions : parsed.answers.map((_, i) => `Q${i+1}`);
    return `
      <div class="survey-card">
        <div class="survey-title">📋 ${escapeHtml(parsed.title || 'survey')}</div>
        <div class="survey-qa-list">
          ${questions.map((q, i) => {
            const a = (parsed.answers[i] || '').toString();
            if (!a) return '';
            return `<div class="survey-qa">
              <div class="survey-q-text">${escapeHtml(q)}</div>
              <div class="survey-a-text">${linkify(escapeHtml(a))}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  } catch { return escapeHtml(post.content || ''); }
}

// =================================================================
// FRIEND REQUEST UI — pending list + accept/reject
// =================================================================
async function loadFriendRequests() {
  try {
    const list = await api('GET', '/api/friend-requests/pending');
    const box = el('friend-req-box');
    const listEl = el('friend-req-list');
    const countEl = el('friend-req-count');
    if (!box || !listEl) return;
    if (!list || list.length === 0) { box.style.display = 'none'; if (countEl) countEl.textContent = '0'; return; }
    box.style.display = '';
    if (countEl) countEl.textContent = list.length;
    listEl.innerHTML = list.map(r => `
      <li class="friend-req-item" data-id="${escapeHtml(r.id)}">
        <strong class="friend-req-from" data-email="${escapeHtml(r.from)}">${escapeHtml(r.fromName)}</strong>
        <div class="friend-req-actions">
          <button class="auth-btn fr-accept" data-id="${escapeHtml(r.id)}">accept</button>
          <button class="auth-btn secondary fr-reject" data-id="${escapeHtml(r.id)}">reject</button>
        </div>
      </li>
    `).join('');
    listEl.querySelectorAll('.fr-accept').forEach(b => b.addEventListener('click', () => respondFriendRequest(b.dataset.id, true)));
    listEl.querySelectorAll('.fr-reject').forEach(b => b.addEventListener('click', () => respondFriendRequest(b.dataset.id, false)));
    listEl.querySelectorAll('.friend-req-from').forEach(s => {
      s.style.cursor = 'pointer';
      s.addEventListener('click', () => navigateToProfile(s.dataset.email));
    });
  } catch (e) {}
}

async function respondFriendRequest(id, accept) {
  try {
    await api('POST', `/api/friend-requests/${id}/respond`, { accept });
    toast(accept ? 'friend added 🎉' : 'rejected');
    // Re-fetch our own user record so state.user.friends reflects the new
    // friendship — otherwise the UI shows stale friendship state until
    // the next page load.
    if (accept) {
      try {
        const me = await api('POST', '/api/whoami');
        if (me && me.user) state.user = { ...state.user, ...me.user };
      } catch {}
    }
    loadFriendRequests();
  } catch (e) { toast(e.data?.error || 'failed'); }
}

async function sendFriendRequest(toEmail) {
  try {
    await api('POST', '/api/friend-requests/send', { toEmail });
    toast('friend request sent ✨');
  } catch (e) { toast(e.data?.error || 'failed'); }
}

// =================================================================
// BLINKY STRIP — render blinkies the user picked, on their profile
// =================================================================
async function renderBlinkyStrip(blinkies) {
  if (!blinkies || blinkies.length === 0) return '';
  const catalog = await ensureBlinkyCatalog();
  const items = blinkies.map(id => catalog.find(b => b.id === id)).filter(Boolean);
  if (!items.length) return '';
  return `<div class="profile-blinkies">
    ${items.map(b => renderBlinkyMarkup(b)).join('')}
  </div>`;
}

// =================================================================
// DAILY VIEW — Question of the Day on its own page
// =================================================================
function openDailyView() {
  setView('daily');
  loadQotd();
  const main = document.querySelector('.fb-main');
  if (main) main.scrollTop = 0;
}

// =================================================================
// NIGHT VIEW — Late-Night Thoughts on its own page
// =================================================================
function openNightView() {
  setView('night');
  loadLateNight();
  const main = document.querySelector('.fb-main');
  if (main) main.scrollTop = 0;
}

// =================================================================
// FRIENDS VIEW — dedicated page with my friends, pending, sent, suggested
// =================================================================
async function openFriendsView() {
  setView('friends');
  // Make sure the directory is loaded before search expects it
  if (!state.directory || state.directory.length === 0) {
    try { await loadDirectoryForMentions(); } catch {}
  }
  // tabs wiring (once)
  const tabs = document.querySelectorAll('.friends-tab');
  if (!tabs[0]._wired) {
    tabs.forEach(t => {
      t._wired = true;
      t.addEventListener('click', () => {
        tabs.forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        document.querySelectorAll('.friends-pane').forEach(p => p.classList.add('hidden'));
        const target = el('fp-' + t.dataset.tab);
        if (target) target.classList.remove('hidden');
      });
    });
  }
  // search wiring (once)
  const search = el('friends-search');
  if (search && !search._wired) {
    search._wired = true;
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      const out = el('friends-search-results');
      if (!q) { out.innerHTML = ''; return; }
      const results = (state.directory || [])
        .filter(d => d.email.toLowerCase() !== state.user.email.toLowerCase())
        .filter(d => d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q))
        .slice(0, 12);
      const sentSet = state._sentFriendReqEmails || new Set();
      out.innerHTML = results.length ? results.map(r => {
        const sent = sentSet.has(r.email.toLowerCase());
        return `
        <div class="friend-search-row" data-email="${escapeHtml(r.email)}">
          <div class="friend-card-name">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="friend-card-sub">${r.claimed ? 'on Old Streets' : 'not on yet'}</span>
          </div>
          <div class="friend-card-actions">
            ${r.claimed
              ? (sent
                  ? `<button class="auth-btn secondary" disabled>✓ request sent</button>
                     <button class="auth-btn secondary" data-act="view" data-email="${escapeHtml(r.email)}">view profile</button>`
                  : `<button class="auth-btn fr-add" data-email="${escapeHtml(r.email)}">＋ Add Friend</button>
                     <button class="auth-btn secondary" data-act="view" data-email="${escapeHtml(r.email)}">view profile</button>`)
              : `<button class="auth-btn" data-act="crush" data-email="${escapeHtml(r.email)}">💌 Send crush</button>
                 <button class="auth-btn secondary" data-act="invite" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}">✉️ Invite</button>`}
          </div>
        </div>`;}).join('') : '<div class="comment-empty" style="padding:12px;">no matches.</div>';
      out.querySelectorAll('.fr-add').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'sending…';
        try { await api('POST', '/api/friend-requests/send', { toEmail: b.dataset.email }); b.textContent = '✓ requested'; toast('request sent ✨'); }
        catch (e) { b.disabled = false; b.textContent = '＋ Add Friend'; toast(e.data?.error || 'failed'); }
      }));
      out.querySelectorAll('[data-act="view"]').forEach(b => b.addEventListener('click', () => navigateToProfile(b.dataset.email)));
      out.querySelectorAll('[data-act="crush"]').forEach(b => b.addEventListener('click', () => openLoveLetterModal(b.dataset.email)));
      out.querySelectorAll('[data-act="invite"]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'sending…';
        try { await api('POST', '/api/invite-single', { toEmail: b.dataset.email, toName: b.dataset.name }); b.textContent = '✓ invited'; toast('invite sent ✉️'); }
        catch (e) { b.disabled = false; b.textContent = '✉️ Invite'; toast(e.data?.error || 'failed'); }
      }));
    });
  }
  refreshFriendsPanes();
}

async function refreshFriendsPanes() {
  const myEmails = state.user.friends || [];
  el('ft-count').textContent = myEmails.length;
  // My friends pane
  const myWrap = el('fp-my-friends');
  if (myWrap) {
    if (myEmails.length === 0) {
      myWrap.innerHTML = '<div class="comment-empty" style="padding:14px;">no friends yet — search above or check the suggested tab.</div>';
    } else {
      myWrap.innerHTML = '<div style="padding:8px; color: var(--text-3); font-size: 11px;">loading…</div>';
      const friendCards = [];
      for (const fe of myEmails) {
        try {
          const p = await api('GET', `/api/users/profile/${encodeURIComponent(fe)}`);
          friendCards.push(p);
        } catch {}
      }
      myWrap.innerHTML = friendCards.length ? `<div class="friend-grid">${friendCards.map(p => friendCardHtml(p)).join('')}</div>` : '<div class="comment-empty" style="padding:14px;">no friends loaded.</div>';
      myWrap.querySelectorAll('[data-email]').forEach(n => {
        n.style.cursor = 'pointer';
        n.addEventListener('click', () => navigateToProfile(n.dataset.email));
      });
    }
  }

  // Pending pane
  const pending = await api('GET', '/api/friend-requests/pending').catch(() => []);
  el('ft-pending-count').textContent = pending.length;
  const pendingWrap = el('fp-pending');
  if (pendingWrap) {
    pendingWrap.innerHTML = pending.length === 0
      ? '<div class="comment-empty" style="padding:14px;">no pending requests.</div>'
      : pending.map(r => `
        <div class="friend-search-row" data-id="${escapeHtml(r.id)}">
          <div class="friend-card-name">
            <strong data-email="${escapeHtml(r.from)}" style="cursor:pointer;">${escapeHtml(r.fromName)}</strong>
            <span class="friend-card-sub">wants to be your friend</span>
          </div>
          <div class="friend-card-actions">
            <button class="auth-btn" data-act="accept" data-id="${escapeHtml(r.id)}">Accept</button>
            <button class="auth-btn secondary" data-act="reject" data-id="${escapeHtml(r.id)}">Reject</button>
          </div>
        </div>`).join('');
    pendingWrap.querySelectorAll('strong[data-email]').forEach(s => s.addEventListener('click', () => navigateToProfile(s.dataset.email)));
    pendingWrap.querySelectorAll('[data-act="accept"]').forEach(b => b.addEventListener('click', async () => {
      await respondFriendRequest(b.dataset.id, true); refreshFriendsPanes();
    }));
    pendingWrap.querySelectorAll('[data-act="reject"]').forEach(b => b.addEventListener('click', async () => {
      await respondFriendRequest(b.dataset.id, false); refreshFriendsPanes();
    }));
  }

  // Sent pane — show every outgoing friend request with status
  const sentWrap = el('fp-sent');
  if (sentWrap) {
    try {
      const sent = await api('GET', '/api/friend-requests/sent');
      if (!sent || sent.length === 0) {
        sentWrap.innerHTML = '<div class="comment-empty" style="padding:14px;">no requests sent yet. find people above or in <strong>Suggested</strong>.</div>';
      } else {
        sentWrap.innerHTML = sent.map(r => {
          const statusBadge = r.status === 'pending'
            ? '<span class="fr-status pending">⏳ pending</span>'
            : r.status === 'accepted'
              ? '<span class="fr-status accepted">✓ accepted</span>'
              : '<span class="fr-status rejected">✕ rejected</span>';
          return `<div class="friend-search-row" data-id="${escapeHtml(r.id)}">
            <div class="friend-card-name">
              <strong data-email="${escapeHtml(r.to)}" style="cursor:pointer;">${escapeHtml(r.toName)}</strong>
              <span class="friend-card-sub">sent ${timeAgo(r.createdAt)}</span>
            </div>
            <div class="friend-card-actions">${statusBadge}</div>
          </div>`;
        }).join('');
        sentWrap.querySelectorAll('strong[data-email]').forEach(s =>
          s.addEventListener('click', () => navigateToProfile(s.dataset.email)));
      }
    } catch (e) {
      sentWrap.innerHTML = '<div class="comment-empty" style="padding:14px;">couldn\'t load sent list.</div>';
    }
  }

  // Suggested pane — only people who have ACTUALLY signed up. Directory
  // entries who haven't joined yet don't belong in "Suggested" because
  // you can't friend them anyway.
  const suggestWrap = el('fp-suggest');
  if (suggestWrap) {
    const haveFriends = new Set(myEmails.map(e => e.toLowerCase()));
    haveFriends.add(state.user.email.toLowerCase());
    const sentEmails = state._sentFriendReqEmails || new Set();
    const pool = (state.directory || [])
      .filter(d => d.claimed)
      .filter(d => !haveFriends.has(d.email.toLowerCase()));
    const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, 12);
    suggestWrap.innerHTML = shuffled.length ? `<div class="friend-grid">${shuffled.map(d => {
      const requested = sentEmails.has(d.email.toLowerCase());
      return `
      <div class="friend-card" data-email="${escapeHtml(d.email)}">
        <div class="friend-card-photo">${escapeHtml((d.name[0] || '?').toUpperCase())}</div>
        <div class="friend-card-name">
          <strong style="cursor:pointer;">${escapeHtml(d.name)}</strong>
          <span class="friend-card-sub">on Old Streets</span>
        </div>
        <div class="friend-card-actions">
          ${requested
            ? `<button class="auth-btn secondary" disabled>✓ request sent</button>`
            : `<button class="auth-btn fr-add" data-email="${escapeHtml(d.email)}">＋ Add Friend</button>`}
          <button class="auth-btn secondary" data-act="view" data-email="${escapeHtml(d.email)}">view</button>
        </div>
      </div>`;}).join('')}</div>` : '<div class="comment-empty" style="padding:14px;">no one to suggest right now — invite people to grow the network.</div>';
    suggestWrap.querySelectorAll('.fr-add').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'sending…';
      try {
        await api('POST', '/api/friend-requests/send', { toEmail: b.dataset.email });
        b.textContent = '✓ request sent';
        b.classList.add('secondary');
        // Sync local cache so other widgets reflect "sent" state
        if (state._sentFriendReqEmails) state._sentFriendReqEmails.add(b.dataset.email.toLowerCase());
        toast('friend request sent ✨');
      }
      catch (e) { b.disabled = false; b.textContent = '＋ Add Friend'; toast(e.data?.error || 'failed'); }
    }));
    suggestWrap.querySelectorAll('[data-act="view"]').forEach(b => b.addEventListener('click', () => navigateToProfile(b.dataset.email)));
    suggestWrap.querySelectorAll('[data-act="crush"]').forEach(b => b.addEventListener('click', () => openLoveLetterModal(b.dataset.email)));
    suggestWrap.querySelectorAll('.friend-card strong').forEach(s => s.addEventListener('click', () => {
      const card = s.closest('.friend-card');
      if (card) navigateToProfile(card.dataset.email);
    }));
  }
}

// =================================================================
// QUESTION OF THE DAY widget
// =================================================================
async function loadQotd() {
  try {
    const q = await api('GET', '/api/qotd/today');
    state._qotd = q;
    renderQotd(q);
    // Update the top-bar pill
    const pill = el('qotd-pill');
    const pillText = el('qotd-pill-text');
    if (pill && pillText && q && q.prompt) {
      pillText.textContent = q.myAnswered ? '☀️ see today\'s answers' : '☀️ today: ' + (q.prompt.length > 32 ? q.prompt.slice(0, 32) + '…' : q.prompt);
      pill.classList.remove('hidden');
      if (!pill._wired) {
        pill._wired = true;
        pill.addEventListener('click', () => openDailyView());
      }
    }
  } catch (e) { /* widget optional */ }
}

function renderQotd(q) {
  const box = el('qotd-box');
  if (!box) return;
  box.style.display = '';
  el('qotd-prompt').textContent = q.prompt;
  el('qotd-date').textContent = q.date || '';

  const inputRow = el('qotd-answer-row');
  const lockedRow = el('qotd-locked');
  if (q.myAnswered) {
    inputRow.classList.add('hidden');
    lockedRow.classList.remove('hidden');
  } else {
    inputRow.classList.remove('hidden');
    lockedRow.classList.add('hidden');
  }

  // wire submit (idempotent)
  const inp = el('qotd-answer-input');
  const sub = el('qotd-answer-submit');
  if (sub && !sub._wired) {
    sub._wired = true;
    sub.addEventListener('click', async () => {
      const t = inp.value.trim();
      if (!t) return;
      sub.disabled = true;
      try {
        await api('POST', `/api/qotd/${q.id}/answer`, { text: t });
        toast('answer locked in ✓');
        loadQotd();
      } catch (e) { toast(e.data?.error || 'failed'); }
      finally { sub.disabled = false; inp.value = ''; }
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') sub.click(); });
  }

  // answers list
  const list = el('qotd-answers');
  if (!q.answers || q.answers.length === 0) {
    list.innerHTML = '<div class="qotd-empty">no answers yet — be first.</div>';
  } else {
    list.innerHTML = q.answers.map(a => `
      <div class="qotd-answer-row" data-target="${escapeHtml(a.authorEmail)}">
        <strong class="qotd-answer-name" data-email="${escapeHtml(a.authorEmail)}">${escapeHtml(a.authorName)}</strong>
        <span class="qotd-answer-text">${linkify(escapeHtml(a.text))}</span>
        <span class="qotd-react">
          ${REACTIONS.map(e => `<button class="qotd-react-btn ${a.myReaction === e ? 'active' : ''}" data-emoji="${e}" data-target="${escapeHtml(a.authorEmail)}">${e}</button>`).join('')}
          <span class="qotd-react-count">${a.reactionCount || ''}</span>
        </span>
      </div>
    `).join('');
    list.querySelectorAll('.qotd-answer-name').forEach(n => n.addEventListener('click', () => navigateToProfile(n.dataset.email)));
    list.querySelectorAll('.qotd-react-btn').forEach(b => b.addEventListener('click', async () => {
      const target = b.dataset.target;
      const emoji = b.classList.contains('active') ? null : b.dataset.emoji;
      try { await api('POST', `/api/qotd/${q.id}/react`, { targetEmail: target, emoji }); loadQotd(); }
      catch { toast('reaction failed'); }
    }));
  }
}

// =================================================================
// LATE-NIGHT widget
// =================================================================
async function loadLateNight() {
  // Late-night feature retired. Function kept as a no-op so existing
  // interval/scroll-into-view callers don't throw.
  return;
  // eslint-disable-next-line no-unreachable
  try {
    const s = await api('GET', '/api/late-night/status');
    state._lateNight = s;
    renderLateNight(s);
  } catch (e) {}
}

function renderLateNight(s) {
  const box = el('late-night-box');
  if (!box) return;
  // Always show the box so people see the headline + know when it opens.
  box.style.display = '';
  const pill = el('ln-status-pill');
  const headline = el('ln-headline');
  const inputRow = el('ln-input-row');
  const closedMsg = el('ln-closed-msg');
  const list = el('ln-list');
  if (pill) {
    pill.textContent = s.open ? 'OPEN now' : 'opens 10pm';
    pill.style.color = s.open ? '#ff6ec7' : '';
  }
  // Headline display
  if (s.headline && s.headline.text) {
    headline.classList.remove('hidden');
    headline.innerHTML = `
      <div class="ln-headline-card">
        <div class="ln-headline-label">last night's headline · ${escapeHtml(s.headline.date || '')}</div>
        <div class="ln-headline-text">"${linkify(escapeHtml(s.headline.text))}"</div>
        <div class="ln-headline-meta">— ${escapeHtml(s.headline.authorName)} · ${s.headline.reactCount} reactions</div>
      </div>`;
  } else {
    headline.classList.add('hidden');
  }
  // Input area open/closed
  if (s.open) {
    inputRow.classList.remove('hidden');
    closedMsg.classList.add('hidden');
    const inp = el('ln-input');
    const sub = el('ln-submit');
    const anon = el('ln-anon');
    if (sub && !sub._wired) {
      sub._wired = true;
      sub.addEventListener('click', async () => {
        const t = inp.value.trim();
        if (!t) return;
        sub.disabled = true;
        try {
          await api('POST', '/api/late-night', { text: t, anon: !!anon.checked });
          inp.value = '';
          toast('late-night thought posted 🌙 vanishes at 7am.');
          loadLateNight();
        } catch (e) { toast(e.data?.error || 'failed'); }
        finally { sub.disabled = false; }
      });
    }
  } else {
    inputRow.classList.add('hidden');
    closedMsg.classList.remove('hidden');
    const next = s.nextOpen ? new Date(s.nextOpen) : null;
    el('ln-closed-msg').querySelector('.ln-closed-text').textContent =
      next ? `the late-night window is closed. opens at 10pm.` : 'closed for now.';
  }
  // List
  if (!s.posts || s.posts.length === 0) {
    list.innerHTML = s.open ? '<div class="comment-empty" style="padding:10px;">no late-night thoughts yet. be first.</div>' : '';
  } else {
    list.innerHTML = s.posts.map(p => `
      <div class="ln-item" data-id="${escapeHtml(p.id)}">
        <strong class="ln-author ${p.isAnonymous ? 'anon' : ''}" data-email="${escapeHtml(p.authorEmail || '')}">${escapeHtml(p.authorName)}</strong>
        <span class="ln-text">${linkify(escapeHtml(p.text))}</span>
        <span class="ln-react">
          ${REACTIONS.map(e => `<button class="ln-react-btn ${p.myReaction === e ? 'active' : ''}" data-emoji="${e}" data-id="${escapeHtml(p.id)}">${e}</button>`).join('')}
          <span class="ln-react-count">${p.reactionCount || ''}</span>
        </span>
      </div>
    `).join('');
    list.querySelectorAll('.ln-author[data-email]').forEach(n => {
      if (!n.dataset.email) return;
      n.style.cursor = 'pointer';
      n.addEventListener('click', () => navigateToProfile(n.dataset.email));
    });
    list.querySelectorAll('.ln-react-btn').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const emoji = b.classList.contains('active') ? null : b.dataset.emoji;
      try { await api('POST', `/api/late-night/${id}/react`, { emoji }); loadLateNight(); }
      catch { toast('reaction failed'); }
    }));
  }
}

// =================================================================
// MUTUAL STALKER reveal — when a notif arrives, offer reveal
// =================================================================
// =================================================================
// CRUSH MATCH REVEAL — the eCRUSH payoff. Fires when both parties have
// sent crushes to each other.
// =================================================================
function openCrushMatchModal(notif) {
  let m = el('crush-match-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'crush-match-modal';
    m.className = 'modal hidden';
    document.body.appendChild(m);
  }
  const name = escapeHtml(notif.matchedName || 'someone');
  m.innerHTML = `<div class="window crush-match-window">
    <button class="modal-close" id="crush-match-close">✕</button>
    <div class="crush-match-burst">💞</div>
    <h2 class="big-title crush-match-title">IT'S A MATCH</h2>
    <p class="crush-match-sub">You and <strong>${name}</strong> both have a crush on each other.</p>
    <p class="crush-match-tag">we kept it secret until you both swiped — that's the whole game.</p>
    <div class="crush-match-actions">
      <button class="scribble-button crush-match-view" data-email="${escapeHtml(notif.matchedEmail || '')}">View ${name}'s profile →</button>
      <button class="scribble-button crush-match-dm" data-email="${escapeHtml(notif.matchedEmail || '')}" data-name="${name}">💬 Send them a DM</button>
      <button class="auth-btn secondary" id="crush-match-skip">close</button>
    </div>
  </div>`;
  m.classList.remove('hidden');
  m.querySelector('#crush-match-close').addEventListener('click', () => m.classList.add('hidden'));
  m.querySelector('#crush-match-skip').addEventListener('click', () => m.classList.add('hidden'));
  m.querySelector('.crush-match-view').addEventListener('click', (e) => {
    m.classList.add('hidden');
    navigateToProfile(e.currentTarget.dataset.email);
  });
  m.querySelector('.crush-match-dm').addEventListener('click', (e) => {
    m.classList.add('hidden');
    openDmModal(e.currentTarget.dataset.email, e.currentTarget.dataset.name);
  });
}

function openMutualRevealModal(notif) {
  let m = el('mutual-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'mutual-modal';
    m.className = 'modal hidden';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="window">
    <div class="kicker">👀 mutual curiosity</div>
    <button class="modal-close" data-close="mutual-modal">✕</button>
    <h2 class="big-title">${escapeHtml(notif.revealName || 'someone')} viewed you too.</h2>
    <p class="subtitle">you both clicked on each other recently. that's not nothing. wanna let them know it was you?</p>
    <div style="display:flex; gap:6px; padding:12px 16px;">
      <button class="scribble-button" id="mutual-view">view their profile</button>
      <button class="scribble-button secondary" id="mutual-crush">💌 send a crush instead</button>
      <button class="auth-btn secondary" id="mutual-skip">stay anonymous</button>
    </div>
  </div>`;
  m.classList.remove('hidden');
  m.querySelector('[data-close]').addEventListener('click', () => m.classList.add('hidden'));
  m.querySelector('#mutual-view').addEventListener('click', () => {
    m.classList.add('hidden');
    navigateToProfile(notif.revealEmail);
  });
  m.querySelector('#mutual-crush').addEventListener('click', () => {
    m.classList.add('hidden');
    openLoveLetterModal(notif.revealEmail);
  });
  m.querySelector('#mutual-skip').addEventListener('click', () => m.classList.add('hidden'));
}

// =================================================================
// ROYALTY BANNER
// =================================================================
async function loadRoyalty() {
  try {
    const r = await api('GET', '/api/royalty');
    const banner = el('royalty-banner');
    if (!banner || !r || !r.winners || r.winners.length === 0) return;
    const myEmail = (state.user?.email || '').toLowerCase();
    const winners = r.winners.map(w => {
      const isMe = w.email?.toLowerCase() === myEmail;
      return `<span class="royalty-pill ${isMe ? 'is-me' : ''}" data-email="${escapeHtml(w.email)}" title="${escapeHtml(w.title)} — ${escapeHtml(w.summary || '')}">
        ${w.crown} ${escapeHtml(w.name)} ${isMe ? '(you)' : ''}
      </span>`;
    }).join('');
    el('royalty-winners').innerHTML = winners;
    // Only show if not dismissed for this week
    const dismissedKey = 'royalty-dismissed-' + r.weekKey;
    if (localStorage.getItem(dismissedKey)) return;
    banner.classList.remove('hidden');
    const close = el('royalty-close');
    if (close && !close._wired) {
      close._wired = true;
      close.addEventListener('click', () => {
        banner.classList.add('hidden');
        localStorage.setItem(dismissedKey, '1');
      });
    }
    banner.querySelectorAll('.royalty-pill').forEach(p => {
      p.style.cursor = 'pointer';
      p.addEventListener('click', () => p.dataset.email && navigateToProfile(p.dataset.email));
    });
  } catch (e) {}
}

// =================================================================
// STREAK INSURANCE — show button when broken & recent
// =================================================================
async function loadStreakStatus() {
  try {
    const s = await api('GET', '/api/streak/status');
    state._streak = s;
    const btn = el('streak-insure-btn');
    if (!btn) return;
    if (s.canInsure && s.available >= s.cost) {
      btn.classList.remove('hidden');
      btn.textContent = `⚡ revive ${s.prevStreak}-day streak (5 reacts)`;
      if (!btn._wired) {
        btn._wired = true;
        btn.addEventListener('click', async () => {
          if (!confirm(`Revive your ${s.prevStreak}-day streak? This costs 5 of your reactions.`)) return;
          btn.disabled = true;
          try {
            const r = await api('POST', '/api/streak/insure');
            toast(`🔥 streak revived — ${r.streak} days`);
            btn.classList.add('hidden');
            loadStreakStatus();
            // update the pill
            const pill = el('streak-pill');
            const count = el('streak-count');
            if (pill && count) {
              pill.classList.remove('hidden');
              count.textContent = r.streak;
            }
          } catch (e) { toast(e.data?.error || 'failed'); }
          finally { btn.disabled = false; }
        });
      }
    } else {
      btn.classList.add('hidden');
    }
  } catch (e) {}
}

// =================================================================
// ONBOARDING WALKTHROUGH — short tutorial for fresh signups.
// Two flavors: "fromCrush" (came via a love-letter email) and "general".
// =================================================================
function runOnboarding(opts = {}) {
  const fromCrush = !!opts.fromCrush;
  const steps = fromCrush ? [
    {
      title: '💌 Welcome to Old Streets.',
      body: 'Someone here has a crush on you. To find out who you THINK it might be, we need you on the inside.',
      icon: '💌'
    },
    {
      title: 'It\'s just Old Streets members.',
      body: 'Members-only. No outsiders. No teachers. We approve every account by hand. Tell a friend who\'s on already to vouch for you and you\'re in faster.',
      icon: '🔒'
    },
    {
      title: 'How the crush thing works.',
      body: 'You\'ll pick 3 people you think have a crush on you. We\'ll never tell you if you\'re right. Each of those 3 will get the same anonymous email — "someone has a crush on you" — and they\'ll pick 3 too. The chain keeps going.',
      icon: '👀'
    },
    {
      title: 'There\'s more here than the crush.',
      body: 'A wall (post anything), profile pages, top 8 friends, blogs, surveys, bulletins, themes, profile songs, late-night thoughts (10pm–midnight), Question of the Day, mutual stalker reveals, weekly Royalty crowns. Yeah it\'s a lot. Take a look around.',
      icon: '🏛️'
    },
    {
      title: 'One last thing.',
      body: 'Click 💌 Crush in the top bar any time you want to start your own anonymous crush chain. The wall is the home page. Profile lives in the top-left. We\'ll let you go now — have at it.',
      icon: '✨'
    }
  ] : [
    {
      title: '👋 Welcome to Old Streets.',
      body: 'It\'s a private wall and video chat for Old Streets members only. Members only. Don\'t tell the principal.',
      icon: '🏛️'
    },
    {
      title: 'The basics.',
      body: 'Post on the wall. React. Comment. DM your friends. Video chat in rooms or hit "Random Video Chat" to talk to whoever else is online.',
      icon: '🧱'
    },
    {
      title: 'The fun stuff.',
      body: '☀️ Question of the Day (drops at 7am). 🌙 Late-night thoughts (open 10pm–midnight, vanish at 7am). 👑 Weekly Royalty crowns (Sunday 8pm). 💌 Anonymous love-letter chain. All on the home page.',
      icon: '🎉'
    },
    {
      title: 'Make it yours.',
      body: 'Click "edit profile" to set your mood, headline, song, theme, blinkies, top 8 friends, and more. There\'s a whole MySpace-era toolkit.',
      icon: '🎨'
    }
  ];
  showOnboardingStep(steps, 0);
}

function showOnboardingStep(steps, i) {
  let modal = el('onboarding-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'onboarding-modal';
    modal.className = 'modal hidden';
    document.body.appendChild(modal);
  }
  const step = steps[i];
  const isLast = i === steps.length - 1;
  modal.innerHTML = `
    <div class="window onboarding-window">
      <button class="modal-close" id="ob-skip" title="skip">✕</button>
      <div class="onboarding-icon">${step.icon}</div>
      <h2 class="big-title onboarding-title">${escapeHtml(step.title)}</h2>
      <p class="onboarding-body">${escapeHtml(step.body)}</p>
      <div class="onboarding-dots">
        ${steps.map((_, j) => `<span class="ob-dot ${j === i ? 'active' : ''}"></span>`).join('')}
      </div>
      <div class="onboarding-actions">
        ${i > 0 ? '<button class="auth-btn secondary" id="ob-back">← back</button>' : '<span></span>'}
        <button class="scribble-button" id="ob-next">${isLast ? 'let\'s go →' : 'next →'}</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');
  el('ob-skip').addEventListener('click', () => modal.classList.add('hidden'));
  const backBtn = el('ob-back');
  if (backBtn) backBtn.addEventListener('click', () => showOnboardingStep(steps, i - 1));
  el('ob-next').addEventListener('click', () => {
    if (isLast) {
      modal.classList.add('hidden');
      // If they came from a crush link, surface the crush picker now
      const hash = window.location.hash || '';
      if (hash.startsWith('#crush=')) {
        const letterId = decodeURIComponent(hash.slice(7));
        setTimeout(() => openCrushPick3Modal(letterId), 400);
      }
    } else {
      showOnboardingStep(steps, i + 1);
    }
  });
}

// =================================================================
// FORCED ELEMENT-ANCHORED TOUR — fires post-approval, points at real UI
// =================================================================
function runForcedTour() {
  const tourSteps = [
    {
      selector: '#compose-text',
      title: '✍️ post stuff here',
      body: "this is the wall. type whatever's on your mind — drama, takes, jokes, pics. drag in photos or videos too.",
      where: 'below'
    },
    {
      selector: '#modal-anon',
      title: '🥷 post anonymously',
      body: "want to spill without your name on it? click 'add post' on the wall and check this box. people see 'anonymous' — but admins still know who posted (no slurs, no bullying).",
      where: 'below',
      preAction: () => {
        const btn = el('add-postit-btn');
        if (btn) btn.click();
      }
    },
    {
      selector: '#pymk-box',
      title: '👯 add friends here',
      body: 'people you may know live here on the right. click their name → friend request. mutual = top 8 candidates.',
      where: 'left',
      preAction: () => {
        // close the post-it modal if open
        const m = el('add-postit-modal'); if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
      }
    },
    {
      selector: '#edit-profile-btn',
      title: '🎨 personalize your profile',
      body: "set your mood, song, theme, blinkies, top 8, bio. this is your home — myspace-era customization is encouraged.",
      where: 'below'
    },
    {
      selector: null,
      title: "🏛️ you're all set",
      body: "browse the wall, drop a comment, send a DM, jump in a video room, answer the question of the day. have fun on Old Streets.",
      where: 'center'
    }
  ];
  showTourStep(tourSteps, 0);
}

function showTourStep(steps, i) {
  cleanupTour();
  const step = steps[i];
  if (step.preAction) { try { step.preAction(); } catch (e) { console.warn('tour preAction failed', e); } }
  const isLast = i === steps.length - 1;
  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'tour-backdrop';
  backdrop.id = 'tour-backdrop';
  document.body.appendChild(backdrop);
  // Tooltip
  const tip = document.createElement('div');
  tip.className = 'tour-tooltip';
  tip.id = 'tour-tooltip';
  tip.innerHTML = `
    <div class="tour-tip-icon">${(step.title.match(/^\S+/) || ['✦'])[0]}</div>
    <h3 class="tour-tip-title">${escapeHtml(step.title.replace(/^\S+\s*/, ''))}</h3>
    <p class="tour-tip-body">${escapeHtml(step.body)}</p>
    <div class="tour-dots">
      ${steps.map((_, j) => `<span class="tour-dot ${j === i ? 'active' : ''}"></span>`).join('')}
    </div>
    <div class="tour-actions">
      ${i > 0 ? '<button class="tour-btn-secondary" id="tour-back">← back</button>' : '<span></span>'}
      <div style="display:flex; gap:8px;">
        ${isLast ? '' : '<button class="tour-btn-secondary" id="tour-skip">skip</button>'}
        <button class="tour-btn-primary" id="tour-next">${isLast ? "let's go →" : 'next →'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(tip);
  // Highlight target + position tooltip
  let target = step.selector ? document.querySelector(step.selector) : null;
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => positionTooltipNear(tip, target, step.where || 'below'), 250);
    target.classList.add('tour-highlight');
  } else {
    // center the tooltip
    tip.style.position = 'fixed';
    tip.style.top = '50%';
    tip.style.left = '50%';
    tip.style.transform = 'translate(-50%, -50%)';
  }
  // Wire buttons
  document.getElementById('tour-next').addEventListener('click', () => {
    if (isLast) {
      cleanupTour();
      api('POST', '/api/me/onboarding-complete', {}).catch(() => {});
      if (state.user) state.user.needsOnboarding = false;
      toast('welcome to Old Streets 🎉', 4000);
    } else {
      showTourStep(steps, i + 1);
    }
  });
  const back = document.getElementById('tour-back');
  if (back) back.addEventListener('click', () => showTourStep(steps, i - 1));
  const skip = document.getElementById('tour-skip');
  if (skip) skip.addEventListener('click', () => {
    cleanupTour();
    api('POST', '/api/me/onboarding-complete', {}).catch(() => {});
    if (state.user) state.user.needsOnboarding = false;
  });
}

function positionTooltipNear(tip, target, where) {
  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth || 320;
  const th = tip.offsetHeight || 200;
  const margin = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top, left;
  if (where === 'left') {
    top = Math.max(margin, r.top + r.height / 2 - th / 2);
    left = Math.max(margin, r.left - tw - margin);
  } else if (where === 'right') {
    top = Math.max(margin, r.top + r.height / 2 - th / 2);
    left = Math.min(vw - tw - margin, r.right + margin);
  } else if (where === 'above') {
    top = Math.max(margin, r.top - th - margin);
    left = Math.max(margin, Math.min(vw - tw - margin, r.left + r.width / 2 - tw / 2));
  } else {
    // below (default)
    top = Math.min(vh - th - margin, r.bottom + margin);
    left = Math.max(margin, Math.min(vw - tw - margin, r.left + r.width / 2 - tw / 2));
  }
  tip.style.position = 'fixed';
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
  tip.style.transform = 'none';
}

function cleanupTour() {
  document.querySelectorAll('.tour-highlight').forEach(el => el.classList.remove('tour-highlight'));
  const b = document.getElementById('tour-backdrop'); if (b) b.remove();
  const t = document.getElementById('tour-tooltip'); if (t) t.remove();
}

function maybeRunForcedTour() {
  if (state.user && state.user.needsOnboarding) {
    setTimeout(runForcedTour, 1200);
    return true;
  }
  return false;
}

// =================================================================
// "WHAT'S NEW" BANNER — show once per user, persisted in localStorage
// =================================================================
function maybeShowWhatsNew() {
  const banner = el('whats-new-banner');
  if (!banner) return;
  const key = 'whats-new-shown-v2';
  if (localStorage.getItem(key)) return;
  banner.classList.remove('hidden');
  const close = () => {
    banner.classList.add('hidden');
    localStorage.setItem(key, '1');
  };
  const c = el('whats-new-close');
  const ok = el('whats-new-got-it');
  if (c) c.addEventListener('click', close);
  if (ok) ok.addEventListener('click', close);
}

function friendCardHtml(p) {
  const photo = p.avatar
    ? `<img src="${escapeAttr(p.avatar)}" alt="" style="width:48px; height:48px; object-fit:cover; border:1px solid var(--border);"/>`
    : `<div class="friend-card-photo">${escapeHtml((p.name[0] || '?').toUpperCase())}</div>`;
  return `<div class="friend-card" data-email="${escapeHtml(p.email)}">
    ${photo}
    <div class="friend-card-name">
      <strong>${escapeHtml(p.name)}</strong>
      <span class="friend-card-sub">${p.online ? '🟢 online' : (p.streak > 0 ? `🔥 ${p.streak} day streak` : 'member')}</span>
    </div>
  </div>`;
}

// =================================================================
// HELLO BLOCK LINK WIRING — every "ms-..." link goes somewhere meaningful
// =================================================================
function wireHelloBlockLinks() {
  const goProfile = () => state.user?.email && navigateToProfile(state.user.email);
  const wireOnce = (id, fn) => {
    const e = el(id);
    if (!e || e._wired) return;
    e._wired = true;
    e.style.cursor = 'pointer';
    e.addEventListener('click', (ev) => { ev.preventDefault(); fn(); });
  };
  wireOnce('ms-vanity-url', goProfile);
  wireOnce('ms-edit-profile', openEditProfileModal);
  // Side profile column (left sidebar)
  wireOnce('ms-side-photos-edit', goProfile);
  wireOnce('ms-side-photos-upload', openAddPostitModal);
  wireOnce('ms-side-videos-edit', goProfile);
  wireOnce('ms-side-videos-upload', openAddPostitModal);
  wireOnce('ms-side-manage-blog', openBlogComposer);
  wireOnce('ms-side-manage-bulletins', openBulletinModal);
  wireOnce('ms-side-manage-surveys', openSurveyComposer);
  wireOnce('ms-side-manage-friends', openFriendsView);
  // Legacy hello-block ids (kept harmless)
  wireOnce('ms-hello-photo', goProfile);
  wireOnce('ms-photos', openAddPostitModal);
  wireOnce('ms-videos', openAddPostitModal);
  wireOnce('ms-manage-blog', openBlogComposer);
  wireOnce('ms-manage-bulletins', openBulletinModal);
  wireOnce('ms-manage-surveys', openSurveyComposer);
  wireOnce('ms-manage-friends', openFriendsView);
  const wireViewMy = (sel) => {
    if (!sel || sel._wired) return;
    sel._wired = true;
    sel.addEventListener('change', () => {
      const v = sel.value;
      sel.value = '';
      if (v === 'profile' || v === 'comments') goProfile();
      else if (v === 'friends') openFriendsView();
      else if (v === 'blogs' || v === 'bulletins') {
        const target = el(v === 'blogs' ? 'blogs-box' : 'bulletins-box');
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  };
  wireViewMy(el('ms-view-my'));
  wireViewMy(el('ms-side-view-my'));
}

// =================================================================
// PEOPLE YOU MAY KNOW — sidebar widget
// =================================================================
async function loadPeopleYouMayKnow() {
  const list = el('pymk-list');
  if (!list) return;
  if (!state.directory || state.directory.length === 0) {
    try { await loadDirectoryForMentions(); } catch {}
  }
  // Also fetch outgoing friend requests so we can label rows correctly
  let sentEmails = new Set();
  try {
    const sent = await api('GET', '/api/friend-requests/sent');
    sentEmails = new Set((sent || []).filter(r => r.status === 'pending').map(r => (r.to || '').toLowerCase()));
  } catch {}
  state._sentFriendReqEmails = sentEmails;
  const myEmail = (state.user?.email || '').toLowerCase();
  const friends = new Set((state.user?.friends || []).map(e => e.toLowerCase()));
  const dismissed = new Set(JSON.parse(localStorage.getItem('pymk-dismissed') || '[]'));
  const seen = new Set([myEmail, ...friends, ...dismissed]);
  const pool = (state.directory || []).filter(d => !seen.has(d.email.toLowerCase()));
  pool.sort((a, b) => (b.claimed ? 1 : 0) - (a.claimed ? 1 : 0));
  // Shuffle within priority bands
  const claimed = pool.filter(p => p.claimed).sort(() => Math.random() - 0.5);
  const unclaimed = pool.filter(p => !p.claimed).sort(() => Math.random() - 0.5);
  const top = [...claimed, ...unclaimed].slice(0, 5);
  if (top.length === 0) { list.innerHTML = '<li class="pymk-empty">no suggestions right now.</li>'; return; }
  // Build a "who's been referred" set so we offer Poke instead of Invite
  // for people already vouched for by someone else.
  const referredEmails = new Set();
  // Best-effort: server returns directory entries with claimed=true if joined
  // or includes a "referred" flag if available. If not, fallback to checking
  // directory state from a separate cache.
  list.innerHTML = top.map(d => {
    const first = (d.name || '').split(' ')[0];
    const lcEmail = d.email.toLowerCase();
    const alreadySent = sentEmails.has(lcEmail);
    const alreadyReferred = d.referred === true || referredEmails.has(lcEmail);
    let actionLink;
    if (alreadySent) actionLink = `<span class="ms-link" style="color:var(--text-3); cursor:default;">✓ request sent</span>`;
    else if (d.claimed) actionLink = `<a class="ms-link pymk-add" data-act="friend">＋ Add to Friends</a>`;
    else if (alreadyReferred) actionLink = `<a class="ms-link pymk-poke" data-act="poke">👉 Poke ${escapeHtml(first)}</a>`;
    else actionLink = `<a class="ms-link pymk-add" data-act="invite">✉️ Invite ${escapeHtml(first)}</a>`;
    return `<li class="pymk-row" data-email="${escapeHtml(d.email)}" data-name="${escapeHtml(d.name)}">
      <div class="pymk-photo">${escapeHtml((d.name[0] || '?').toUpperCase())}</div>
      <div class="pymk-info">
        <a class="pymk-name ms-link" data-act="view">${escapeHtml(d.name)}</a>
        <div class="pymk-sub">${d.claimed ? '✓ on Old Streets' : (alreadyReferred ? 'vouched for — just needs to sign up' : 'not joined yet')}</div>
        ${actionLink}
      </div>
      <button class="pymk-x" data-act="dismiss" title="hide">×</button>
    </li>`;
  }).join('');
  list.querySelectorAll('.pymk-row').forEach(row => {
    const email = row.dataset.email;
    const name = row.dataset.name;
    row.querySelector('[data-act="view"]').addEventListener('click', () => navigateToProfile(email));
    row.querySelector('.pymk-photo').addEventListener('click', () => navigateToProfile(email));
    const addBtn = row.querySelector('[data-act="friend"], [data-act="invite"]');
    if (addBtn) addBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const btn = e.target;
      const act = btn.dataset.act;
      btn.textContent = '…';
      try {
        if (act === 'friend') {
          await api('POST', '/api/friend-requests/send', { toEmail: email });
          btn.textContent = '✓ requested';
        } else {
          await api('POST', '/api/invite-single', { toEmail: email, toName: name });
          btn.textContent = '✓ invited';
        }
      } catch (err) {
        btn.textContent = act === 'friend' ? '＋ Add to Friends' : '✉️ Invite';
        toast(err.data?.error || 'failed');
      }
    });
    const pokeBtn = row.querySelector('[data-act="poke"]');
    if (pokeBtn) pokeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const btn = e.target;
      btn.textContent = '👉 …';
      try {
        await api('POST', '/api/poke', { toEmail: email, toName: name });
        btn.outerHTML = `<span class="ms-link" style="color:var(--text-3);">✓ poked</span>`;
      } catch (err) {
        btn.textContent = '👉 Poke';
        toast(err.data?.error || 'failed');
      }
    });
    row.querySelector('[data-act="dismiss"]').addEventListener('click', () => {
      const cur = JSON.parse(localStorage.getItem('pymk-dismissed') || '[]');
      cur.push(email);
      localStorage.setItem('pymk-dismissed', JSON.stringify(cur.slice(-100)));
      row.remove();
    });
  });
  const more = el('pymk-show-more');
  if (more && !more._wired) {
    more._wired = true;
    more.addEventListener('click', (e) => { e.preventDefault(); openFriendsView(); });
  }
}

// =================================================================
// FEATURE PROMO — rotates "What's Hot" through current features
// =================================================================
const PROMO_DECK = [
  () => ({
    icon: '💌',
    title: 'Got a crush?',
    body: 'Send an anonymous love letter. They guess 3 people they think have a crush on them, and the chain spreads.',
    cta: 'Send a crush',
    onClick: () => openLoveLetterModal()
  }),
  () => ({
    icon: '☀️',
    title: 'Question of the Day',
    body: 'Drops at 7am. One question, one answer, see everyone else\'s.',
    cta: 'Jump to today',
    onClick: () => el('qotd-box')?.scrollIntoView({ behavior: 'smooth' })
  }),
  () => ({
    icon: '🌙',
    title: 'Late-night thoughts',
    body: 'Opens at 10pm. Vanishes at 7am — except the top one, which becomes tomorrow\'s headline.',
    cta: 'Late-night',
    onClick: () => el('late-night-box')?.scrollIntoView({ behavior: 'smooth' })
  }),
  () => ({
    icon: '📝',
    title: 'Write a blog',
    body: 'Long-form. HTML allowed: marquee, fonts, colors. MySpace journal energy.',
    cta: 'New blog',
    onClick: openBlogComposer
  }),
  () => ({
    icon: '📋',
    title: 'Post a survey',
    body: 'Classic "fill this out" surveys. Pick a template — favorites, have-you-ever, this-or-that.',
    cta: 'Pick a template',
    onClick: openSurveyComposer
  }),
  () => ({
    icon: '👯',
    title: 'Find your people',
    body: 'Search the directory, send friend requests, build your top 8.',
    cta: 'Find friends',
    onClick: openFriendsView
  }),
  () => ({
    icon: '👑',
    title: 'Weekly Royalty',
    body: 'Sunday 8pm: top post, top inviter, top commenter get crowns for the week.',
    cta: 'See standings',
    onClick: () => el('leaderboard-box')?.scrollIntoView({ behavior: 'smooth' })
  })
];
let _promoIndex = 0;
function loadFeaturePromo() {
  const wrap = el('promo-content');
  if (!wrap) return;
  const item = PROMO_DECK[_promoIndex % PROMO_DECK.length]();
  _promoIndex++;
  wrap.innerHTML = `
    <div class="promo-icon">${item.icon}</div>
    <div class="promo-title">${escapeHtml(item.title)}</div>
    <div class="promo-body">${escapeHtml(item.body)}</div>
    <button class="scribble-button promo-cta">${escapeHtml(item.cta)} →</button>`;
    wrap.querySelector('.promo-cta').addEventListener('click', item.onClick);
}

// =================================================================
// PROFILE VIEWS COUNT into the hello block
// =================================================================
async function refreshHelloViewsCount() {
  try {
    const stats = await api('GET', '/api/me/vanity');
    if (!stats) return;
    const v = el('ms-profile-views');
    if (v && typeof stats.profileViewCount !== 'undefined') {
      v.textContent = stats.profileViewCount;
    }
    const sv = el('ms-side-views');
    if (sv && typeof stats.profileViewCount !== 'undefined') {
      sv.textContent = stats.profileViewCount;
    }
  } catch {}
}

// =================================================================
// LIVE WALL TYPING — compose box typing broadcasts
// =================================================================
function wireWallTyping() {
  const compose = el('compose-text');
  if (!compose || compose._typingWired || !state.socket) return;
  compose._typingWired = true;
  let typingTimer = null;
  let lastTickAt = 0;
  compose.addEventListener('input', () => {
    if (!state.socket) return;
    const now = Date.now();
    if (now - lastTickAt > 1500) {
      state.socket.emit('wall-typing-tick');
      lastTickAt = now;
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => state.socket?.emit('wall-typing-stop'), 3000);
    broadcastActivity({ kind: 'composing', label: 'writing a post' });
  });
  compose.addEventListener('blur', () => {
    state.socket?.emit('wall-typing-stop');
    broadcastActivity({ kind: 'browsing', label: 'browsing the wall' });
  });
  state.socket.on('wall-typers', list => {
    const wrap = el('wall-typers');
    const text = el('wall-typers-text');
    if (!wrap || !text) return;
    const me = (state.user?.email || '').toLowerCase();
    const others = (list || []).filter(u => (u.email || '').toLowerCase() !== me);
    if (others.length === 0) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const names = others.slice(0, 3).map(u => u.username.split(' ')[0]);
    if (others.length === 1) text.textContent = `${names[0]} is writing something…`;
    else if (others.length === 2) text.textContent = `${names[0]} and ${names[1]} are writing…`;
    else text.textContent = `${names.join(', ')}${others.length > 3 ? ` + ${others.length - 3} more` : ''} are writing…`;
  });
}

// =================================================================
// THROWBACK widget
// =================================================================
async function loadThrowback() {
  try {
    const r = await api('GET', '/api/me/throwback');
    const wrap = el('throwback-box');
    if (!wrap) return;
    if (localStorage.getItem('throwback-dismissed-today') === todayKey()) return;
    if (!r || !r.throwback) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    el('throwback-days').textContent = r.throwback.daysAgo;
    el('throwback-preview').innerHTML = `"${escapeHtml(r.throwback.preview)}"`;
    const close = el('throwback-close');
    if (close && !close._wired) {
      close._wired = true;
      close.addEventListener('click', () => {
        wrap.classList.add('hidden');
        localStorage.setItem('throwback-dismissed-today', todayKey());
      });
    }
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      navigateToPost(r.throwback.id);
    });
  } catch {}
}
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

// =================================================================
// VAGUE STALKER STAT widget
// =================================================================
async function loadVagueStat() {
  // The widget now lives inside the user's own profile page. We render
  // there via renderProfileDetail. This stub stays for backward-compat
  // and is called on init but is a no-op without the DOM target.
  try {
    const wrap = el('vague-stat-box');
    if (!wrap) return;
    const r = await api('GET', '/api/me/vague-stat');
    if (!r || !r.lines) return;
    wrap.classList.remove('hidden');
    el('vague-stat-list').innerHTML = r.lines.map(l => `<li>${escapeHtml(l)}</li>`).join('');
  } catch {}
}

// Inline render of secret admirers into a target element (used by profile)
async function renderSecretAdmirers(targetEl) {
  if (!targetEl) return;
  try {
    const r = await api('GET', '/api/me/vague-stat');
    if (!r || !r.lines || r.lines.length === 0) { targetEl.classList.add('hidden'); return; }
    targetEl.classList.remove('hidden');
    targetEl.innerHTML = `
      <div class="profile-secret-admirers">
        <div class="fb-box-header"><span>👀 Secret Admirers · this week</span></div>
        <ul class="vague-stat-list">${r.lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      </div>`;
  } catch {}
}

// =================================================================
// ATTENTION-SPAN HEARTBEAT — pings server every 15s with activity state.
// Server aggregates session duration per user for the admin dashboard.
// =================================================================
function startAttentionHeartbeat() {
  if (!state.user || !state.token) return;
  let lastActivityAt = Date.now();
  const tick = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
  tick.forEach(ev => window.addEventListener(ev, () => { lastActivityAt = Date.now(); }, { passive: true }));
  setInterval(async () => {
    const idleMs = Date.now() - lastActivityAt;
    const visible = !document.hidden;
    const active = visible && idleMs < 30000;
    try {
      await fetch('/api/me/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Token': state.token },
        body: JSON.stringify({ active, visible, idleMs: Math.min(idleMs, 300000) })
      });
    } catch {}
  }, 15000);
}

// =================================================================
// SITE-WIDE THEME — applied to <body>, persisted in localStorage
// =================================================================
const SITE_THEMES = ['classic','dark','midnight','candy','matrix','sunset','cyber','paper','iceblue'];
function applySiteTheme(name) {
  const t = SITE_THEMES.includes(name) ? name : 'classic';
  document.body.setAttribute('data-site-theme', t);
  localStorage.setItem('site-theme', t);
  const sel = el('site-theme-pick');
  if (sel) sel.value = t;
}
function initSiteTheme() {
  const saved = localStorage.getItem('site-theme') || 'classic';
  applySiteTheme(saved);
  const sel = el('site-theme-pick');
  if (sel && !sel._wired) {
    sel._wired = true;
    sel.addEventListener('change', () => applySiteTheme(sel.value));
  }
}

// =================================================================
// AD SLOT — fetches active ads, rotates if multiple, supports
// caption with @mention linking to the user's profile
// =================================================================
let _adRotation = 0;
async function loadActiveAd() {
  const wrap = el('ad-slot-content');
  if (!wrap) return;
  try {
    const ads = await api('GET', '/api/ads/current');
    if (!Array.isArray(ads) || ads.length === 0) {
      wrap.parentElement.style.display = 'none';
      return;
    }
    wrap.parentElement.style.display = '';
    const ad = ads[_adRotation % ads.length];
    _adRotation++;
    // Skip the full innerHTML rebuild if we're already showing this exact ad
    // — was causing a visible flicker every 60s even when nothing changed.
    const existing = wrap.querySelector('.ad-card');
    if (existing && existing.dataset.id === ad.id) return;
    // Fire-and-forget impression
    fetch(`/api/ads/${encodeURIComponent(ad.id)}/impression`, { method: 'POST' }).catch(() => {});
    // Render caption with @mention linking to that user's profile if claimed
    const captionHtml = ad.mentionedHandle ? renderAdCaption(ad.caption, ad.mentionedHandle) : escapeHtml(ad.caption);
    const imgHtml = ad.imageUrl
      ? `<img src="${escapeAttr(ad.imageUrl)}" alt="" class="ad-image"/>`
      : `<div class="ad-image-placeholder">${ad.mentionedHandle ? '🎵 ' + escapeHtml(ad.mentionedHandle) : '✦'}</div>`;
    wrap.innerHTML = `
      <div class="ad-card" data-id="${escapeAttr(ad.id)}">
        ${ad.link ? `<a href="${escapeAttr(ad.link)}" target="_blank" rel="noopener" class="ad-link">${imgHtml}</a>` : imgHtml}
        <div class="ad-caption">${captionHtml}</div>
        <div class="ad-note">advertisement</div>
      </div>`;
    // Click tracking on the whole card
    wrap.querySelector('.ad-card').addEventListener('click', () => {
      fetch(`/api/ads/${encodeURIComponent(ad.id)}/click`, { method: 'POST' }).catch(() => {});
    });
    // Wire @mention chips to navigate to profile
    wrap.querySelectorAll('.ad-mention').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const email = a.dataset.email;
        if (email) navigateToProfile(email);
      });
    });
  } catch (e) { /* ad widget is optional */ }
}

function renderAdCaption(caption, mentionedHandle) {
  // Find @lucasnoe etc in caption text and turn into clickable link IF
  // that handle resolves to a real signed-up user in the directory.
  const text = String(caption || '');
  const handleLc = String(mentionedHandle || '').toLowerCase();
  if (!handleLc) return escapeHtml(text);
  // Resolve the handle to a real user — first name OR email slug match,
  // and they must be signed up (claimed)
  const dir = (state.directory || []).find(d => {
    if (!d.claimed) return false;
    const first = (d.name || '').split(' ')[0].toLowerCase();
    const slug = (d.email || '').split('@')[0].toLowerCase();
    return first === handleLc || slug === handleLc;
  });
  if (!dir) return escapeHtml(text);
  // Replace @handle in caption with chip
  const safeText = escapeHtml(text);
  const re = new RegExp('@' + handleLc + '\\b', 'gi');
  return safeText.replace(re, `<a class="ad-mention" data-email="${escapeAttr(dir.email)}" title="${escapeAttr(dir.name)}">@${escapeHtml(handleLc)}</a>`);
}

// =================================================================
// QUICK SIGN-IN (2FA via personal email) — name → code → logged in
// =================================================================
function setupQuickSignIn() {
  const startBtn = el('quick-start-submit');
  const verifyBtn = el('quick-verify-submit');
  const resendBtn = el('quick-resend');
  if (!startBtn || startBtn._wired) return;
  startBtn._wired = true;
  startBtn.addEventListener('click', startQuickSignIn);
  if (verifyBtn) verifyBtn.addEventListener('click', verifyQuickSignIn);
  if (resendBtn) resendBtn.addEventListener('click', () => {
    el('quick-step-code').classList.add('hidden');
    el('quick-step-name').classList.remove('hidden');
    el('quick-name').focus();
  });
  el('quick-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') startQuickSignIn(); });
  el('quick-code')?.addEventListener('keydown', e => { if (e.key === 'Enter') verifyQuickSignIn(); });
}

async function startQuickSignIn() {
  const name = el('quick-name').value.trim();
  const errEl = el('quick-error');
  errEl.classList.add('hidden');
  if (!name) { errEl.textContent = 'enter your name'; errEl.classList.remove('hidden'); return; }
  const btn = el('quick-start-submit');
  btn.disabled = true; btn.textContent = 'sending…';
  try {
    const r = await api('POST', '/api/login/start-2fa', { name });
    state._quickName = name;
    el('quick-step-name').classList.add('hidden');
    el('quick-step-code').classList.remove('hidden');
    el('quick-masked-email').textContent = r.maskedEmail || 'your personal email';
    el('quick-code').focus();
    if (r.devCode) {
      // Resend not configured — surface code so dev can test
      toast('code (no email configured): ' + r.devCode, 8000);
    }
  } catch (e) {
    const msg = e.data?.error || 'failed';
    if (e.data?.noPersonalEmail) {
      errEl.innerHTML = 'this account doesn\'t have a personal email set yet. <strong>Sign in with password first</strong>, then we\'ll set 2FA up.';
    } else {
      errEl.textContent = msg;
    }
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Send me a code →';
  }
}

async function verifyQuickSignIn() {
  const code = el('quick-code').value.trim();
  const errEl = el('quick-error');
  errEl.classList.add('hidden');
  if (!code) { errEl.textContent = 'enter the code'; errEl.classList.remove('hidden'); return; }
  const btn = el('quick-verify-submit');
  btn.disabled = true; btn.textContent = 'verifying…';
  try {
    const r = await api('POST', '/api/login/verify-2fa', { name: state._quickName, code });
    state.token = r.token;
    state.user = r.user;
    tokenStore.set(STORAGE_KEY, r.token, true);
    await routeByStatus();
  } catch (e) {
    errEl.textContent = e.data?.error || 'failed';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in →';
  }
}

// =================================================================
// GOOGLE SIGN-IN — auth landing button + school-email link flow
// =================================================================
async function setupGoogleSignIn() {
  let cfg;
  try { cfg = await fetch('/api/auth/google/config').then(r => r.json()); }
  catch { return; }
  if (!cfg || !cfg.enabled || !cfg.clientId) return; // not configured — hide button
  state._googleClientId = cfg.clientId;
  // Wait for Google's script to load (it's deferred), then render the button.
  const ready = () => (window.google && window.google.accounts && window.google.accounts.id);
  const trySetup = (attempt) => {
    if (!ready()) {
      if (attempt > 30) return; // ~3s timeout
      return setTimeout(() => trySetup(attempt + 1), 100);
    }
    try {
      window.google.accounts.id.initialize({
        client_id: cfg.clientId,
        callback: onGoogleCredential,
        ux_mode: 'popup',
        auto_select: false
      });
      const wrap = el('google-signin-btn');
      if (wrap) {
        window.google.accounts.id.renderButton(wrap, {
          type: 'standard', theme: 'outline', size: 'large',
          text: 'continue_with', shape: 'pill', logo_alignment: 'left', width: 280
        });
      }
      const wrap2 = el('google-signin-wrap');
      if (wrap2) wrap2.classList.remove('hidden');
    } catch (e) { console.warn('google sign-in setup failed', e); }
  };
  trySetup(0);
  // Wire link-step buttons (idempotent)
  const sendBtn = el('gl-send-code');
  if (sendBtn && !sendBtn._wired) {
    sendBtn._wired = true;
    sendBtn.addEventListener('click', sendGoogleLinkCode);
    el('gl-school-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendGoogleLinkCode(); });
  }
  const verifyBtn = el('gl-verify');
  if (verifyBtn && !verifyBtn._wired) {
    verifyBtn._wired = true;
    verifyBtn.addEventListener('click', verifyGoogleLinkCode);
    el('gl-code')?.addEventListener('keydown', e => { if (e.key === 'Enter') verifyGoogleLinkCode(); });
  }
  const backBtn = el('gl-back');
  if (backBtn && !backBtn._wired) {
    backBtn._wired = true;
    backBtn.addEventListener('click', () => {
      el('gl-step-code').classList.add('hidden');
      el('gl-step-email').classList.remove('hidden');
      el('gl-error').classList.add('hidden');
      el('gl-error2').classList.add('hidden');
    });
  }
}

async function onGoogleCredential(response) {
  if (!response || !response.credential) return;
  state._googleCredential = response.credential;
  try {
    const r = await api('POST', '/api/auth/google', { credential: response.credential });
    if (r.needsLink) {
      // New user — show link step
      el('auth-landing')?.classList.add('hidden');
      el('auth-forms')?.classList.add('hidden');
      el('auth-legacy-tabs')?.classList.add('hidden');
      el('google-link-screen')?.classList.remove('hidden');
      el('gl-google-email').textContent = r.google.email || r.google.name;
      el('gl-step-code')?.classList.add('hidden');
      el('gl-step-email')?.classList.remove('hidden');
      el('gl-school-email')?.focus();
      return;
    }
    // Existing user — log in directly
    state.token = r.token;
    state.user = r.user;
    tokenStore.set(STORAGE_KEY, r.token, true);
    await routeByStatus();
  } catch (e) {
    toast(e.data?.error || 'google sign-in failed');
  }
}

async function sendGoogleLinkCode() {
  const email = el('gl-school-email').value.trim().toLowerCase();
  const errEl = el('gl-error');
  errEl.classList.add('hidden');
  if (!/^[a-z0-9._%+-]+.*$/i.test(email)) {
    errEl.textContent = 'must end ';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = el('gl-send-code');
  btn.disabled = true; btn.textContent = 'sending…';
  try {
    await api('POST', '/api/auth/google/start-link', {
      credential: state._googleCredential,
      schoolEmail: email
    });
    state._glSchoolEmail = email;
    el('gl-step-email').classList.add('hidden');
    el('gl-step-code').classList.remove('hidden');
    el('gl-school-display').textContent = email;
    el('gl-code')?.focus();
  } catch (e) {
    errEl.textContent = e.data?.error || 'failed';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Send verification code →';
  }
}

async function verifyGoogleLinkCode() {
  const code = el('gl-code').value.trim();
  const errEl = el('gl-error2');
  errEl.classList.add('hidden');
  if (!code) { errEl.textContent = 'enter the code'; errEl.classList.remove('hidden'); return; }
  const btn = el('gl-verify');
  btn.disabled = true; btn.textContent = 'verifying…';
  try {
    const r = await api('POST', '/api/auth/google/verify-link', {
      credential: state._googleCredential,
      code
    });
    state.token = r.token;
    state.user = r.user;
    tokenStore.set(STORAGE_KEY, r.token, true);
    el('google-link-screen').classList.add('hidden');
    await routeByStatus();
  } catch (e) {
    errEl.textContent = e.data?.error || 'failed';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Verify & sign in →';
  }
}

// =================================================================
// FORCED PERSONAL-EMAIL ONBOARDING
// Triggered after login if user.personalEmail is not set/verified.
// =================================================================
// Forces the user to accept the current TOS before they can use the site.
// Called after login and on app boot when state.user lands.
function maybeShowTosModal() {
  if (!state.user) return;
  if (!state.user.needsTosAgreement) return;
  const modal = el('tos-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const check = el('tos-checkbox');
  const accept = el('tos-accept-btn');
  const decline = el('tos-decline-btn');
  if (check && accept && !check._wired) {
    check._wired = true;
    check.checked = false;
    accept.disabled = true;
    check.addEventListener('change', () => { accept.disabled = !check.checked; });
  }
  if (accept && !accept._wired) {
    accept._wired = true;
    accept.addEventListener('click', async () => {
      accept.disabled = true;
      accept.textContent = 'saving…';
      try {
        const r = await api('POST', '/api/me/agree-tos');
        if (r && r.user) state.user = { ...state.user, ...r.user };
        modal.classList.add('hidden');
        toast('thanks — welcome to old streets 🤝');
      } catch (e) {
        toast('couldn\'t save — try again');
        accept.disabled = false;
        accept.textContent = 'I agree → continue';
      }
    });
  }
  if (decline && !decline._wired) {
    decline._wired = true;
    decline.addEventListener('click', () => {
      modal.classList.add('hidden');
      toast('signing you out — come back when you\'re ready to agree', 4000);
      setTimeout(logout, 500);
    });
  }
}

// One-shot prompt: if the logged-in user has no grade set, force them to pick.
function maybeShowGradePrompt() {
  if (!state.user || !state.user.needsGrade) return;
  const modal = el('grade-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const sel = el('grade-modal-select');
  const btn = el('grade-modal-save');
  if (sel && btn && !btn._wired) {
    btn._wired = true;
    sel.addEventListener('change', () => { btn.disabled = !sel.value; });
    btn.addEventListener('click', async () => {
      const grade = sel.value;
      if (!grade) return;
      btn.disabled = true;
      btn.textContent = 'saving…';
      try {
        const r = await api('POST', '/api/me/set-grade', { grade });
        if (r && r.user) state.user = { ...state.user, ...r.user };
        modal.classList.add('hidden');
        toast(`saved · class of ${state.user.classOf || '?'} 🎓`);
      } catch (e) {
        if (e.status === 403 && e.data && e.data.error === 'middle-schooler') {
          // Trap — account just got wiped server-side. Boot the user.
          modal.classList.add('hidden');
          toast('Old Streets is upper-school only. account removed.', 6000);
          tokenStore.clear(STORAGE_KEY);
          state.token = null;
          state.user = null;
          setTimeout(() => { window.location.href = '/'; }, 2000);
          return;
        }
        btn.disabled = false;
        btn.textContent = 'Save grade →';
        toast('couldn\'t save — try again');
      }
    });
  }
}

// When the user returns from a 5+ day absence, show a one-time "while you
// were away" digest modal — counts of new posts, mentions, profile views,
// missed DMs. Server enforces the 5d cooldown.
async function checkWhileAwayDigest() {
  if (!state.user) return;
  try {
    const r = await api('POST', '/api/me/while-away');
    if (r && !r.skipped) showWhileAwayModal(r);
  } catch (e) { /* silent */ }
}
function showWhileAwayModal(d) {
  const modal = el('away-modal');
  if (!modal) return;
  el('away-subtitle').textContent = `you were gone ${d.awayDays} day${d.awayDays === 1 ? '' : 's'}. here's what happened.`;
  const stats = el('away-stats');
  const items = [
    { n: d.newPosts,        label: 'new posts on the wall', icon: '📜' },
    { n: d.mentions,        label: 'people mentioned you', icon: '🗣️' },
    { n: d.profileViewers,  label: 'profile views',         icon: '👀' },
    { n: d.dmsMissed,       label: 'unread DMs',            icon: '💬' },
  ].filter(x => x.n > 0);
  stats.innerHTML = items.length === 0
    ? '<div class="away-empty">quiet stretch. nothing major.</div>'
    : items.map(i => `<div class="away-stat-row"><span class="away-icon">${i.icon}</span><span class="away-num">${i.n}</span><span class="away-label">${i.label}</span></div>`).join('');
  modal.classList.remove('hidden');
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => modal.classList.add('hidden'), { once: true }));
}

function maybeShowPersonalEmailOnboarding() {
  // Disabled — sign-in is now just school email, no personal email / 2FA required.
  return;
  // legacy guard kept for reference:
  if (!state.user) return;
  if (state.user.personalEmail && state.user.personalEmailVerified) return;
  const modal = el('personal-email-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  // Hide close — this is forced
  const sendBtn = el('pe-send-code');
  const verifyBtn = el('pe-verify-code');
  const resendBtn = el('pe-resend');
  if (sendBtn && !sendBtn._wired) {
    sendBtn._wired = true;
    sendBtn.addEventListener('click', async () => {
      const e = el('pe-email').value.trim();
      const errEl = el('pe-error');
      errEl.classList.add('hidden');
      if (!e) { errEl.textContent = 'enter your personal email'; errEl.classList.remove('hidden'); return; }
      sendBtn.disabled = true; sendBtn.textContent = 'sending…';
      try {
        const r = await api('POST', '/api/me/set-personal-email', { personalEmail: e });
        el('pe-sent-to').textContent = e;
        el('pe-step-enter').classList.add('hidden');
        el('pe-step-verify').classList.remove('hidden');
        el('pe-code').focus();
        if (r.devCode) toast('code (no email configured): ' + r.devCode, 8000);
      } catch (err) { errEl.textContent = err.data?.error || 'failed'; errEl.classList.remove('hidden'); }
      finally { sendBtn.disabled = false; sendBtn.textContent = 'Send me a code →'; }
    });
  }
  if (verifyBtn && !verifyBtn._wired) {
    verifyBtn._wired = true;
    verifyBtn.addEventListener('click', async () => {
      const code = el('pe-code').value.trim();
      const errEl = el('pe-error');
      errEl.classList.add('hidden');
      if (!code) { errEl.textContent = 'enter the code'; errEl.classList.remove('hidden'); return; }
      verifyBtn.disabled = true; verifyBtn.textContent = 'verifying…';
      try {
        await api('POST', '/api/me/verify-personal-email', { code });
        // Refresh user state
        const me = await api('POST', '/api/whoami');
        if (me?.user) state.user = { ...state.user, ...me.user };
        modal.classList.add('hidden');
        toast('✓ personal email verified — 2FA active', 5000);
      } catch (err) { errEl.textContent = err.data?.error || 'failed'; errEl.classList.remove('hidden'); }
      finally { verifyBtn.disabled = false; verifyBtn.textContent = 'Verify + finish →'; }
    });
  }
  if (resendBtn && !resendBtn._wired) {
    resendBtn._wired = true;
    resendBtn.addEventListener('click', () => {
      el('pe-step-verify').classList.add('hidden');
      el('pe-step-enter').classList.remove('hidden');
      el('pe-email').focus();
    });
  }
}

// =================================================================
// ANNOUNCEMENT BANNER — fetches active announcements, displays at top
// with a rainbow LED-frame animation. Dismiss = hidden for this session.
// =================================================================
let _announceCurrent = null;
async function loadAnnouncements() {
  try {
    const list = await api('GET', '/api/announcements/current');
    if (!Array.isArray(list) || list.length === 0) {
      el('announcement-banner-wrap')?.classList.add('hidden');
      return;
    }
    // Pick the most-recent active one we haven't dismissed
    const dismissed = JSON.parse(sessionStorage.getItem('dismissed-announcements') || '[]');
    const fresh = list.filter(a => !dismissed.includes(a.id));
    if (fresh.length === 0) { el('announcement-banner-wrap')?.classList.add('hidden'); return; }
    const a = fresh[0];
    _announceCurrent = a;
    const wrap = el('announcement-banner-wrap');
    const textEl = el('announcement-text');
    const linkEl = el('announcement-link');
    if (!wrap || !textEl) return;
    textEl.textContent = a.text;
    if (a.link) {
      linkEl.href = a.link;
      linkEl.textContent = 'open →';
      linkEl.classList.remove('hidden');
    } else {
      linkEl.classList.add('hidden');
    }
    wrap.classList.remove('hidden');
    const dismissBtn = el('announcement-dismiss');
    if (dismissBtn && !dismissBtn._wired) {
      dismissBtn._wired = true;
      dismissBtn.addEventListener('click', () => {
        if (!_announceCurrent) return;
        const d = JSON.parse(sessionStorage.getItem('dismissed-announcements') || '[]');
        d.push(_announceCurrent.id);
        sessionStorage.setItem('dismissed-announcements', JSON.stringify(d));
        wrap.classList.add('hidden');
      });
    }
  } catch {}
}

// =================================================================
// SECURITY — logout everywhere + edit personal email
// =================================================================
async function logoutEverywhere() {
  if (!confirm('Rotate your session token? Every device you\'re signed in on (including this one) will need to log in again.')) return;
  try {
    await api('POST', '/api/me/rotate-token');
    toast('signed out everywhere. please log in.');
    tokenStore.clear(STORAGE_KEY);
    state.token = null;
    state.user = null;
    setTimeout(() => location.reload(), 1200);
  } catch (e) { toast(e.data?.error || 'failed'); }
}

function wireSecuritySection() {
  const logoutBtn = el('edit-logout-everywhere');
  if (logoutBtn && !logoutBtn._wired) {
    logoutBtn._wired = true;
    logoutBtn.addEventListener('click', logoutEverywhere);
  }
  const changeBtn = el('edit-personal-email-change');
  if (changeBtn && !changeBtn._wired) {
    changeBtn._wired = true;
    changeBtn.addEventListener('click', () => {
      // Force re-show onboarding so they can change their personal email
      el('personal-email-modal').classList.remove('hidden');
      el('pe-step-verify').classList.add('hidden');
      el('pe-step-enter').classList.remove('hidden');
      el('pe-email').value = state.user.personalEmail || '';
      el('pe-email').focus();
    });
  }
  const display = el('edit-personal-email-display');
  if (display) {
    display.textContent = state.user?.personalEmail
      ? state.user.personalEmail + (state.user.personalEmailVerified ? ' ✓' : ' (unverified)')
      : 'not set';
  }
}

// =================================================================
// BROWSER PUSH NOTIFICATIONS — when a socket notif arrives, also
// fire a native browser Notification so the user sees it even with
// the page in a background tab.
// =================================================================
function maybeAskForNotificationPermission() {
  if (!('Notification' in window)) return;
  // Sticky banner shown on EVERY visit (not just first time) until either:
  //   - user grants permission
  //   - user dismisses (banner stays away for 7 days)
  // Browsers require a user gesture for requestPermission, so we trigger
  // on a click — never auto-call it.
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return; // can't ask again — user
                                                    // must re-enable in browser settings
  const dismissedAt = parseInt(localStorage.getItem('notif-prompt-dismissed-at') || '0', 10);
  if (dismissedAt && Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;
  setTimeout(() => {
    if (document.querySelector('.notif-permission-prompt')) return;
    const banner = document.createElement('div');
    banner.className = 'notif-permission-prompt';
    banner.innerHTML = `
      <span>🔔 turn on push notifications so you don't miss DMs, mentions, or who's posting</span>
      <button id="np-yes" class="scribble-button" style="padding: 6px 14px; font-size: 12px;">enable</button>
      <button id="np-no" class="auth-btn secondary" style="padding: 6px 12px; font-size: 11px;">later</button>`;
    document.body.appendChild(banner);
    document.getElementById('np-yes').addEventListener('click', async () => {
      try {
        const p = await Notification.requestPermission();
        if (p === 'granted') {
          banner.remove();
          // Fire a confirmation notification so user sees it work
          try {
            new Notification('Old Streets', {
              body: "you're set — we'll ping you when stuff happens",
              icon: '/logo.svg'
            });
          } catch {}
        } else if (p === 'denied') {
          banner.innerHTML = `<span>blocked. to re-enable: tap the 🔒 icon in your browser's address bar → Notifications → Allow.</span>
            <button class="auth-btn secondary" style="padding: 4px 10px;" onclick="this.parentElement.remove()">ok</button>`;
        }
      } catch {}
    });
    document.getElementById('np-no').addEventListener('click', () => {
      localStorage.setItem('notif-prompt-dismissed-at', String(Date.now()));
      banner.remove();
    });
  }, 1500);
}

// Public: invoked by the explicit "enable notifications" button anywhere
// in the UI. Forces the prompt even if previously dismissed.
async function requestNotificationsExplicit() {
  if (!('Notification' in window)) {
    toast('your browser does not support push notifications');
    return false;
  }
  if (Notification.permission === 'granted') {
    toast('✓ already enabled');
    return true;
  }
  if (Notification.permission === 'denied') {
    toast('blocked — tap the 🔒 in your browser address bar → Notifications → Allow', 7000);
    return false;
  }
  try {
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      toast('✓ notifications on');
      try { new Notification('Old Streets', { body: "you're set", icon: '/logo.svg' }); } catch {}
      return true;
    }
    if (p === 'denied') {
      toast('denied — you can re-enable in browser settings', 6000);
    }
  } catch (e) {
    console.warn('notif permission error', e);
  }
  return false;
}

function firePushNotification(title, body, opts) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return; // skip when tab is active
  try {
    const n = new Notification(title, {
      body,
      icon: '/logo.svg',
      badge: '/logo.svg',
      tag: opts?.tag,
      silent: false
    });
    if (opts?.onClick) {
      n.onclick = () => { window.focus(); opts.onClick(); n.close(); };
    } else {
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch {}
}


