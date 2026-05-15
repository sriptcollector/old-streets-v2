// ====================================================================
// SHARED CHROME — emits exactly the same nav markup the home page uses
// (.top-strip / .nav-strip / .nav-item / .nav-bell), patches window.fetch
// to attach X-User-Token to same-origin requests, and removes any stale
// per-page nav so we never double-render.
// ====================================================================
(function(){
  const TOKEN_KEY = 'oldstreets-token';
  const THEME_KEY = 'oldstreets-theme';
  function token(){ return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''; }

  // School brand cache — synced on every whoami so first paint of any page
  // can render the right wordmark without an API round-trip flash.
  const SCHOOL_BRAND_KEY = 'os-school-cache';
  const SCHOOL_BRAND_MAP = {
    'new-roads':     'Paths',
    'beverly-hills': 'Paths',
    'crossroads':    'Paths'
  };
  function getCachedSchool() {
    try { return JSON.parse(localStorage.getItem(SCHOOL_BRAND_KEY) || 'null') || null; } catch { return null; }
  }
  function setCachedSchool(me) {
    if (!me || !me.schoolId) return;
    try { localStorage.setItem(SCHOOL_BRAND_KEY, JSON.stringify({ schoolId: me.schoolId, schoolName: me.schoolName || '' })); } catch {}
  }
  window.osBrand = { getCachedSchool, setCachedSchool, SCHOOL_BRAND_MAP };

  // ---- @-mention autofill (universal — adds @-autocomplete to every input/textarea) ----
  (function loadMention(){
    if (document.querySelector('script[src*="mention.js"]')) return;
    const s = document.createElement('script');
    s.src = '/mention.js?v=20260513q';
    s.defer = true;
    document.head.appendChild(s);
  })();

  // ---- Theme sync (runs IMMEDIATELY, before any paint) ----
  // The home page stores [data-theme] in localStorage; mirror it onto <html>
  // on every sub-page so colors carry across the site.
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch {}

  // ---- Global fetch patch (runs immediately, before page scripts) ----
  (function patchFetch(){
    if (window.__osFetchPatched) return;
    window.__osFetchPatched = true;
    const orig = window.fetch.bind(window);
    window.fetch = function(input, init) {
      try {
        const t = token();
        if (!t) return orig(input, init);
        const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
        const isSameOrigin = !urlStr || urlStr.startsWith('/') || urlStr.startsWith(location.origin);
        if (!isSameOrigin) return orig(input, init);
        init = init || {};
        const h = new Headers(init.headers || (input && input.headers) || {});
        if (!h.has('x-user-token') && !h.has('X-User-Token')) h.set('X-User-Token', t);
        init.headers = h;
      } catch {}
      return orig(input, init);
    };
  })();

  function activeKey(){
    const s = document.currentScript || document.querySelector('script[src*="chrome.js"]');
    if (s && s.dataset && s.dataset.active) return s.dataset.active;
    const p = (location.pathname || '').toLowerCase();
    if (p === '/' || p.endsWith('/index.html')) return 'home';
    if (p.endsWith('/mail.html') || p.endsWith('/inbox.html')) return 'chats';
    if (p.endsWith('/friends.html')) return 'friends';
    if (p.endsWith('/members.html')) return 'members';
    if (p.endsWith('/invite.html')) return 'invite';
    if (p.endsWith('/bulletins.html')) return 'bulletins';
    if (p.endsWith('/late-night.html')) return 'latenight';
    if (p.endsWith('/leaderboard.html')) return 'leaderboard';
    if (p.startsWith('/u/') || p.endsWith('/profile.html')) return 'profile';
    return '';
  }
  function esc(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function tab(key, href, label, badgeId, extraStyle) {
    const act = key === activeKey() ? ' is-active' : '';
    const badge = badgeId ? ` <span id="${badgeId}" class="nav-badge hidden">0</span>` : '';
    const style = extraStyle ? ` style="${extraStyle}"` : '';
    return `<a class="nav-item${act}" href="${href}"${style}>${label}${badge}</a>`;
  }

  function buildChrome(info, unread, me) {
    // Per-school wordmark — overrides the rotation when school is locked.
    const brand = 'Paths';
    const tomorrow = (info && info.brandTomorrow) || '';
    return `
      <div class="top-strip" id="top-strip">
        <div class="top-strip-inner">
          <a class="brand-wordmark" id="brand-wordmark" href="/" style="display:inline-flex; flex-direction:column; line-height:1.05;">
            <span>[ <span id="brand-text">${esc(brand)}</span><span class="brand-dot">.</span> ]</span>
            <span id="brand-edition" style="font-size:9.5px; font-style:italic; color:#5b6f9a; margin-top:1px; font-weight:normal;"></span>
          </a>
          <a class="tomorrow-link" id="tomorrow-link" href="#"
             onclick="event.preventDefault(); if(window.os && os.openTomorrowVote){os.openTomorrowVote();} else { location.href='/?vote=1'; }"
             title="tomorrow's wordmark — tap to vote"
             style="margin-left:10px; font-size:10.5px; color:#5b6f9a; text-decoration:none; font-style:italic;">
            <span id="tomorrow-badge" style="display:none; background:#cc5500; color:#fff; padding:1px 6px; font-weight:700; font-size:9px; margin-right:4px; border-radius:1px; font-style:normal; text-transform:uppercase;">👑 winning</span>
            tomorrow → <span id="tomorrow-name" style="color:#003399; text-decoration:underline; font-weight:700;">${esc(tomorrow || 'loading…')}</span><span id="tomorrow-votes" style="margin-left:4px; color:#cc5500; font-weight:700; font-style:normal;"></span>
          </a>
          <form class="top-search" id="top-search-form" onsubmit="return ___osNavSearch(event)" style="margin-left:8px;">
            <select id="search-scope"><option value="people">People</option><option value="posts">Posts</option></select>
            <input type="search" id="search-q" placeholder="Find friends, classmates, posts..."/>
            <button type="submit" class="top-search-btn">Search</button>
          </form>
          <div class="top-pwr">POWERED BY <b>ojstudios</b></div>
        </div>
      </div>
      <div class="nav-strip" id="nav-strip">
        <div class="nav-hamburger">
          <span id="nav-mob-name">${esc(activeKey() || 'Home')}</span>
          <button class="ham-toggle" type="button" onclick="document.getElementById('nav-strip').classList.toggle('open')">menu</button>
        </div>
        <div class="nav-inner">
          <div class="nav-left">
            ${tab('home', '/', 'Home')}
            ${tab('rooms', '/rooms.html', '🎥 Rooms', null, 'background:var(--msp-orange);')}
            ${tab('oldmegle', '/oldmegle.html', '🎲 Oldmegle', null, 'background:#cc0000;')}
            ${tab('chats', '/mail.html', 'Chats', 'mail-badge')}
            ${tab('friends', '/friends.html', 'Friends', 'fr-badge')}
            ${tab('members', '/members.html', 'Members')}
            ${tab('invite', '/invite.html', 'Invite')}
            ${tab('crush', '/crush.html', '💌 Letters')}
            ${tab('admin', '/admin', 'Admin', null, (me && me.isAdmin) ? '' : 'display:none;')}
          </div>
          <div class="nav-right">
            <a class="nav-item nav-bell" href="javascript:void(0)" id="nav-bell" title="alerts" onclick="event.preventDefault(); event.stopPropagation(); window.__osToggleNotifPop && window.__osToggleNotifPop(this); return false;">
              <svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:middle;display:inline-block;" aria-hidden="true">
                <path fill="currentColor" d="M12 2a2 2 0 0 0-2 2v.6A7 7 0 0 0 5 11v3.2L3 17h18l-2-2.8V11a7 7 0 0 0-5-6.4V4a2 2 0 0 0-2-2zm-2 17a2 2 0 0 0 4 0h-4z"/>
              </svg>
              <span id="nav-bell-badge" class="bell-badge" style="display:none;">0</span>
            </a>
            <a class="nav-item" href="/profile-edit.html">Account</a>
            <a class="nav-item" href="#" id="os-logout">Sign Out</a>
          </div>
        </div>
      </div>
    `;
  }
  // Global hook for the search form so it works without app.js being loaded.
  window.___osNavSearch = function(e){
    e.preventDefault();
    const q = (document.getElementById('search-q') || {}).value || '';
    const scope = (document.getElementById('search-scope') || {}).value || 'people';
    if (q.trim()) location.href = '/?search=' + encodeURIComponent(q) + '&scope=' + encodeURIComponent(scope);
    return false;
  };

  function stripExistingChrome(){
    // Aggressively remove any pre-existing top-strip / nav-strip so the
    // injected chrome is the only one on the page. Cover BOTH the hyphenated
    // home-page class names AND the legacy compact ones used by profile.html.
    const sels = [
      '.top-strip', '.top-strip-inner',
      '.nav-strip', '.nav-inner',
      '.topstrip', '.navstrip',
      '#top-strip', '#nav-strip',
      '#topstrip', '#navstrip',
      'header.top-strip', 'nav.nav-strip'
    ];
    document.querySelectorAll(sels.join(',')).forEach(el => { try { el.remove(); } catch {} });
  }

  async function fetchInfo() {
    try { const r = await fetch('/api/site-info'); if (r.ok) return await r.json(); } catch {}
    return null;
  }
  async function fetchMe() {
    try {
      const r = await fetch('/api/whoami', { headers: { 'X-User-Token': token() } });
      if (!r.ok) return null;
      const d = await r.json();
      return d.user || d;
    } catch { return null; }
  }
  async function fetchUnread() {
    try {
      const r = await fetch('/api/notifications', { headers: { 'X-User-Token': token() } });
      if (!r.ok) return 0;
      const d = await r.json();
      const list = d.notifications || [];
      const pending = d.pendingFriendRequests || 0;
      return list.filter(n => !n.read).length + (typeof pending === 'number' ? pending : 0);
    } catch { return 0; }
  }

  // Nav is rendered by THIS function on EVERY page (including home).
  // Single source of truth. No per-page inline copies.
  function isHomePage() {
    const p = (location.pathname || '').toLowerCase();
    return p === '/' || p === '' || p.endsWith('/index.html');
  }

  function mountContactFooter() {
    if (document.getElementById('os-contact-footer')) return;
    const f = document.createElement('div');
    f.id = 'os-contact-footer';
    f.innerHTML = '<a href="https://docs.google.com/forms/d/e/1FAIpQLSciUaA1PS5XhSyCzLdU1bMhroaeBJa-UtTigqaIJdwJKHHPBQ/viewform" target="_blank" rel="noopener">📮 Contact us</a> · <span class="muted">Paths</span>';
    document.body.appendChild(f);
  }

  async function mount() {
    if (!token()) return;       // signed-out pages skip chrome entirely
    stripExistingChrome();
    const [info, unread, me] = await Promise.all([fetchInfo(), fetchUnread(), fetchMe()]);
    const wrap = document.createElement('div');
    wrap.innerHTML = buildChrome(info || {}, unread || 0, me);
    // If the page provides an explicit mount point (recommended pattern),
    // use it. Otherwise prepend to body for legacy pages.
    const mountPt = document.getElementById('os-chrome-mount');
    if (mountPt) {
      while (wrap.firstChild) mountPt.appendChild(wrap.firstChild);
    } else {
      const frag = document.createDocumentFragment();
      while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      document.body.insertBefore(frag, document.body.firstChild);
    }

    // Sign out
    const so = document.getElementById('os-logout');
    if (so) so.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-User-Token': token() } }); } catch {}
      try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch {}
      location.replace('/onboard.html');
    });

    // Wire any sidebar "View My Notifications" link (replaces the removed
    // top-right bell). The home page passes its own anchor element so the
    // dropdown positions against it.
    const sbNotifs = document.getElementById('sb-notifs');
    if (sbNotifs) sbNotifs.addEventListener('click', (e) => { e.preventDefault(); toggleNotifPop(sbNotifs); });

    // Search — delegate to home for now (people / posts search).
    const form = document.querySelector('.top-search');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = (document.getElementById('search-q') || {}).value || '';
      const scope = (document.getElementById('search-scope') || {}).value || 'people';
      if (q.trim()) location.href = '/?search=' + encodeURIComponent(q) + '&scope=' + encodeURIComponent(scope);
    });

    // Bell badge + tab-title prefix on sub-pages. Re-polls every 30s.
    paintBell(unread || 0);
    setInterval(refreshBellFromNetwork, 30000);

    // Bell click is handled by inline onclick attribute in buildChrome()
    // which calls window.__osToggleNotifPop. Adding a second listener here
    // would double-fire the toggle (open then immediately close).

    // Emit per-page activity so Online Now shows what people are doing.
    emitPageActivity();

    mountContactFooter();
  }

  const BASE_TITLE = (document.title || 'Paths').replace(/^\(\d+\+?\)\s*/, '').replace(/Old Streets/g, 'Paths').replace(/Streets/g, 'Paths');
  function paintBell(n) {
    n = n | 0;
    document.querySelectorAll('.bell-badge').forEach(b => {
      if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = 'inline-block'; b.classList.add('has'); }
      else { b.style.display = 'none'; b.classList.remove('has'); }
    });
    const prefix = n > 0 ? '(' + (n > 99 ? '99+' : n) + ') ' : '';
    document.title = prefix + BASE_TITLE;
  }
  async function refreshBellFromNetwork() {
    try {
      const u = await fetchUnread();
      paintBell(u || 0);
    } catch {}
  }

  // Emit a granular "activity" socket event so Online Now can show what
  // each viewer is doing. Reuses an existing socket if the page opened one,
  // otherwise lazy-loads socket.io and creates ours. Re-emits every 30s so
  // server never falls back to the "just arrived" default.
  function pageActivity() {
    const p = (location.pathname || '').toLowerCase();
    const labels = {
      '/': { kind: 'feed', label: 'on the feed' },
      '/index.html': { kind: 'feed', label: 'on the feed' },
      '/rooms.html': { kind: 'rooms', label: 'in Live Rooms' },
      '/oldmegle.html': { kind: 'oldmegle', label: 'in Oldmegle' },
      '/mail.html': { kind: 'chats', label: 'reading chats' },
      '/inbox.html': { kind: 'chats', label: 'reading chats' },
      '/friends.html': { kind: 'friends', label: 'browsing friends' },
      '/members.html': { kind: 'members', label: 'browsing members' },
      '/invite.html': { kind: 'invite', label: 'sending invites' },
      '/leaderboard.html': { kind: 'leaderboard', label: 'checking leaderboard' },
      '/crush.html': { kind: 'crush', label: 'writing letters' },
      '/profile-edit.html': { kind: 'profile-edit', label: 'editing profile' },
      '/admin': { kind: 'admin', label: 'in admin' },
      '/admin.html': { kind: 'admin', label: 'in admin' },
      '/post.html': { kind: 'post', label: 'reading a post' }
    };
    let act = labels[p];
    if (!act && p.startsWith('/u/')) {
      const who = decodeURIComponent(p.slice(3));
      act = { kind: 'profile', label: 'viewing @' + who.slice(0, 24), ref: who };
    }
    return act;
  }
  function emitPageActivity() {
    const act = pageActivity();
    if (!act) return;
    function emit(sock) {
      try { sock.emit('activity', act); } catch {}
    }
    function withSocket(cb) {
      // Prefer an already-open socket on this page.
      const existing = (window.state && window.state.socket) || window.__osSocket;
      if (existing && existing.connected) return cb(existing);
      if (existing) {
        existing.on('connect', () => cb(existing));
        return;
      }
      if (!window.io) {
        const sc = document.createElement('script');
        sc.src = '/socket.io/socket.io.js';
        sc.onload = () => withSocket(cb);
        document.head.appendChild(sc);
        return;
      }
      const s = window.io({ transports: ['websocket', 'polling'] });
      window.__osSocket = s;
      s.on('connect', () => {
        s.emit('register', { token: token() });
        setTimeout(() => cb(s), 250);
      });
    }
    withSocket(emit);
    // Keep refreshing so the label doesn't drift back to default.
    if (!window.__osActivityInterval) {
      window.__osActivityInterval = setInterval(() => {
        const a = pageActivity();
        if (!a) return;
        withSocket(s => { try { s.emit('activity', a); } catch {} });
      }, 30000);
    }
  }

  // ============ NOTIF DROPDOWN (fade-in next to bell) ============
  let _notifPop = null, _notifLoaded = false, _notifData = null;
  function ensureNotifPop(){
    if (_notifPop) return _notifPop;
    _notifPop = document.createElement('div');
    _notifPop.className = 'notif-pop';
    _notifPop.innerHTML = `
      <div class="arrow"></div>
      <div class="head"><span>Activity Stream</span><a href="#" id="np-clear">mark all read</a></div>
      <div class="body" id="np-body"><div class="empty">loading…</div></div>
    `;
    document.body.appendChild(_notifPop);
    document.addEventListener('click', (ev) => {
      if (!_notifPop || !_notifPop.classList.contains('show')) return;
      if (ev.target.closest('.notif-pop') || ev.target.closest('#os-nav-bell, #nav-bell')) return;
      hideNotifPop();
    });
    const clearLink = _notifPop.querySelector('#np-clear');
    if (clearLink) clearLink.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await fetch('/api/notifications/read-all', { method:'POST', headers: { 'X-User-Token': token() } }); } catch {}
      loadNotifsAndRender();
    });
    return _notifPop;
  }
  function positionNotifPop(anchor){
    const pop = ensureNotifPop();
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth || 340;
    let left = r.right - w + 8;
    if (left < 8) left = 8;
    const right = window.innerWidth - r.right;
    pop.style.top = (r.bottom + 8) + 'px';
    pop.style.left = '';
    pop.style.right = right + 'px';
    const arrow = pop.querySelector('.arrow');
    if (arrow) arrow.style.right = '22px';
  }
  function toggleNotifPop(anchor){
    const pop = ensureNotifPop();
    if (pop.classList.contains('show')) { hideNotifPop(); return; }
    positionNotifPop(anchor || document.getElementById('nav-bell') || document.body);
    pop.classList.add('show');
    loadNotifsAndRender();
  }
  // Globally exposed so the inline bell onclick works regardless of any
  // page's `window.os = {...}` overwrites later in the script load order.
  window.__osToggleNotifPop = toggleNotifPop;
  function hideNotifPop(){
    if (_notifPop) _notifPop.classList.remove('show');
  }
  async function loadNotifsAndRender(){
    const pop = ensureNotifPop();
    const body = pop.querySelector('#np-body');
    if (!body) return;
    const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const timeAgo = (ts) => { if(!ts) return ''; const s=Math.floor((Date.now()-ts)/1000); if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'m'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; };
    body.innerHTML = '<div class="empty" style="padding:14px;">loading…</div>';
    try {
      const [notifsRes, dmsRes, frRes] = await Promise.all([
        fetch('/api/notifications', { headers: { 'X-User-Token': token() } }).then(r => r.ok ? r.json() : { notifications: [] }).catch(()=>({ notifications: [] })),
        fetch('/api/dm/unread-threads', { headers: { 'X-User-Token': token() } }).then(r => r.ok ? r.json() : { threads: [] }).catch(()=>({ threads: [] })),
        fetch('/api/friend-requests/pending', { headers: { 'X-User-Token': token() } }).then(r => r.ok ? r.json() : []).catch(()=>[])
      ]);
      _notifData = notifsRes;
      const notifs = (notifsRes.notifications || []).slice(0, 30);
      const dmThreads = (dmsRes.threads || dmsRes || []).slice(0, 20);
      const frList = (Array.isArray(frRes) ? frRes : (frRes.requests || [])).slice(0, 20);
      const items = [];
      // Friend requests first (most actionable)
      for (const r of frList) {
        const nm = esc(r.fromName||'someone');
        const h = r.fromHandle ? esc(r.fromHandle) : '';
        const who = h ? `<a class="who" href="/u/${h}" onclick="event.stopPropagation();">${nm}</a>` : `<span class="who">${nm}</span>`;
        items.push({ ts: r.createdAt || 0, html: `<div class="row unread"><span class="when">${esc(timeAgo(r.createdAt))}</span><div>👤 ${who} wants to be friends — <a href="/friends.html" onclick="event.stopPropagation();" style="font-weight:700;">view</a></div></div>` });
      }
      // Unread DMs
      for (const t of dmThreads) {
        const nm = esc(t.fromName || t.name || 'someone');
        const h = t.fromHandle || t.handle ? esc(t.fromHandle || t.handle) : '';
        const who = h ? `<a class="who" href="/u/${h}" onclick="event.stopPropagation();">${nm}</a>` : `<span class="who">${nm}</span>`;
        items.push({ ts: t.lastTs || 0, html: `<div class="row unread"><span class="when">${esc(timeAgo(t.lastTs))}</span><div>💬 ${who}: ${esc((t.lastText || '').slice(0, 60))} — <a href="/mail.html" onclick="event.stopPropagation();" style="font-weight:700;">open</a></div></div>` });
      }
      // Notifs
      for (const n of notifs) {
        const nm = esc(n.fromName||'someone');
        const h = n.fromHandle ? esc(n.fromHandle) : '';
        const who = h ? `<a class="who" href="/u/${h}" onclick="event.stopPropagation();">${nm}</a>` : `<span class="who">${nm}</span>`;
        items.push({ ts: n.ts || 0, html: `<div class="row${n.read ? '' : ' unread'}" data-id="${esc(n.id||'')}"><span class="when">${esc(timeAgo(n.ts))}</span><div>${who} ${esc((n.text||'').slice(0, 80))}</div></div>` });
      }
      items.sort((a,b) => (b.ts||0) - (a.ts||0));
      if (!items.length) {
        body.innerHTML = '<div class="empty">nothing yet. when people react, comment, follow, or message you, you\'ll see it here.</div>';
        return;
      }
      body.innerHTML = items.map(i => i.html).join('') +
        '<div style="text-align:right;padding:6px 10px;border-top:1px solid var(--msp-rule-l);background:var(--msp-tint-2);"><a href="#" id="notif-read-all" style="font-size:11px;font-weight:700;">mark all read ✓</a></div>';
      const ra = body.querySelector('#notif-read-all');
      if (ra) ra.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await fetch('/api/notifications/read-all', { method: 'POST', headers: { 'X-User-Token': token() } }); } catch {}
        body.querySelectorAll('.row.unread').forEach(r => r.classList.remove('unread'));
        document.querySelectorAll('.bell-badge').forEach(b => { b.style.display='none'; b.classList.remove('has'); });
      });
      body.querySelectorAll('.row[data-id]').forEach(row => row.addEventListener('click', async () => {
        const id = row.dataset.id;
        if (id) { try { await fetch('/api/notifications/'+encodeURIComponent(id)+'/read', { method:'POST', headers: { 'X-User-Token': token() } }); } catch {} }
        row.classList.remove('unread');
      }));
    } catch {
      body.innerHTML = '<div class="empty">could not load.</div>';
    }
  }

  // PHANTOM TYPING DELETED. Admin wants only real activity — "someone is
  // typing" must reflect a real user. Kept as no-op so callers don't break.
  function startPhantomTyping(){ /* disabled */ }

  // ============ ANNOUNCEMENT BANNER (rainbow, top of page) ============
  const ANN_KEY = 'os-announce-dismissed';
  async function loadAnnouncements(){
    if (!token()) return;
    try {
      const r = await fetch('/api/announcements/current', { headers: { 'X-User-Token': token() } });
      if (!r.ok) return;
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) return;
      const dismissed = (() => { try { return JSON.parse(localStorage.getItem(ANN_KEY) || '[]'); } catch { return []; } })();
      const live = list.filter(a => !dismissed.includes(a.id))[0];
      if (!live) return;
      renderAnnouncement(live);
    } catch {}
  }
  function renderAnnouncement(a){
    const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const bar = document.createElement('div');
    bar.className = 'os-announce';
    const link = (a.link || '').trim();
    const html = link
      ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(a.text)}</a>`
      : esc(a.text);
    bar.innerHTML = html + `<button class="x" type="button" title="dismiss">✕</button>`;
    bar.querySelector('.x').addEventListener('click', () => {
      try { const arr = JSON.parse(localStorage.getItem(ANN_KEY) || '[]'); arr.push(a.id); localStorage.setItem(ANN_KEY, JSON.stringify(arr.slice(-50))); } catch {}
      bar.remove();
      document.body.classList.remove('has-announce');
    });
    document.body.appendChild(bar); // append, since it's position:fixed it doesn't matter where in body
    document.body.classList.add('has-announce');
  }

  // Wire any sidebar notifs button on every page (including home).
  function wireSidebarNotifs(){
    const sbNotifs = document.getElementById('sb-notifs');
    if (!sbNotifs || sbNotifs._wired) return;
    sbNotifs._wired = true;
    sbNotifs.addEventListener('click', (e) => { e.preventDefault(); toggleNotifPop(sbNotifs); });
    // Update badge
    fetch('/api/notifications', { headers: { 'X-User-Token': token() } }).then(r => r.json()).then(d => {
      const unread = (d.notifications||[]).filter(n => !n.read).length;
      const b = document.getElementById('notif-badge-sb');
      if (b) { if (unread > 0) { b.textContent = unread; b.style.display = 'inline-block'; } else b.style.display = 'none'; }
    }).catch(()=>{});
  }
  // Expose to home page's os namespace if it exists, for direct calling.
  window.os = window.os || {};
  window.os.openSidebarNotifs = function(anchor){ toggleNotifPop(anchor || document.getElementById('sb-notifs')); };

  // ====== FORCED 3-SCHOOL LOCK + HANDLE PICKER (every page) ======
  // Self-contained — paints its own full-screen overlay so it works on
  // any sub-page that doesn't have the home page's modal scaffold.
  async function maybeForceSchoolLock() {
    const t = token();
    if (!t) return;
    // Skip on signed-out-only pages
    const p = (location.pathname || '').toLowerCase();
    if (p.endsWith('/onboard.html') || p.endsWith('/signin.html') || p.endsWith('/claim.html')) return;
    let me;
    try {
      const r = await fetch('/api/whoami', { headers: { 'X-User-Token': t } });
      const j = await r.json();
      me = j.user;
    } catch { return; }
    if (!me) return;
    if (me.isAdmin) return;
    // Order: school first (required), then handle pick (required), then
    // home page's own gate handlers take it from there.
    // School selection removed — auto-lock everyone to a single community.
    if (!me.schoolLocked) {
      try {
        await fetch('/api/me/auto-lock-school', { method: 'POST', headers: { 'X-User-Token': t } });
      } catch {}
    }
    if (!me.handleChosen) {
      paintHandlePickerOverlay(me);
      return;
    }
    // Force re-capture for any user whose selfie pre-dates the current
    // camera-gate TOS version. Admins exempt.
    const CURRENT_CAM_GATE = '2026-05-15-v3-cam-gate';
    const needsCamReupload = !me.isAdmin && (me.selfieTosVersion || '') !== CURRENT_CAM_GATE;
    if (!me.selfieTaken || needsCamReupload) {
      paintSelfieOverlay(me);
    }
  }

  // ====== HARD CAMERA / TOS GATE ======
  // On every page load, if the user hasn't passed the gate, blur the
  // entire site and show: (1) 6 pages of TOS they must click through,
  // (2) camera permission prompt, (3) instant auto-snap (no preview,
  // no retake), (4) lock the profile photo forever.
  function paintSelfieOverlay(me) {
    if (document.getElementById('os-cam-gate')) return;
    // Inject blur style once.
    if (!document.getElementById('os-cam-gate-css')) {
      const css = document.createElement('style');
      css.id = 'os-cam-gate-css';
      css.textContent = `
        body.os-cam-blur > *:not(#os-cam-gate) { filter: blur(14px) brightness(0.6); pointer-events: none; user-select: none; transition: filter 200ms; }
        body.os-cam-blur { overflow: hidden; }
        #os-cam-gate { position: fixed; inset: 0; z-index: 1000000; background: rgba(8,12,24,0.92); display:flex; align-items: center; justify-content: center; padding: 16px; font: 13px Verdana,Tahoma,Arial,sans-serif; }
        #os-cam-gate .card { background: #fff; max-width: 560px; width: 100%; border: 1px solid #29447e; box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: flex; flex-direction: column; max-height: 90vh; }
        #os-cam-gate .hdr { background: #3b5998; color: #fff; padding: 10px 14px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
        #os-cam-gate .sub { background: #cc0000; color: #fff; padding: 6px 14px; font-size: 11px; font-weight: 700; }
        #os-cam-gate .pg  { padding: 14px 18px; flex: 1; overflow-y: auto; font-size: 11px; line-height: 1.45; color: #1a1a1a; }
        #os-cam-gate .pg h3 { margin: 0 0 8px; color: #29447e; font-size: 13px; }
        #os-cam-gate .pg p  { margin: 0 0 8px; }
        #os-cam-gate .pg small { font-size: 9px; color: #555; }
        #os-cam-gate .ftr { padding: 10px 14px; background: var(--msp-tint-2,#eef2f8); border-top: 1px solid #c8d0e0; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
        #os-cam-gate .ftr .dots { font-size: 10px; color: #555; }
        #os-cam-gate .ftr button { padding: 8px 14px; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
        #os-cam-gate .btn-next { background: #1a4f1a; color: #fff; border: 1px solid #0d3a0d; }
        #os-cam-gate .btn-next:disabled { opacity: 0.5; cursor: not-allowed; }
        #os-cam-gate .stage { width: 320px; max-width: 100%; aspect-ratio: 1/1; background: #000; margin: 14px auto; position: relative; overflow: hidden; border: 2px solid #29447e; }
        #os-cam-gate .stage video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; background: #000; }
        #os-cam-gate .stage .flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; transition: opacity 80ms ease-out; }
        #os-cam-gate .errbox { background: #fef2f2; border: 1px solid #f0a5a5; color: #7a1f1f; padding: 10px; margin: 10px 14px; font-size: 11.5px; }
      `;
      document.head.appendChild(css);
    }
    document.body.classList.add('os-cam-blur');
    const overlay = document.createElement('div');
    overlay.id = 'os-cam-gate';
    document.body.appendChild(overlay);

    const tosPages = [
      {
        title: 'Terms · 1 of 7 — Acceptance & age (18+)',
        html: `
          <h3>Paths · Terms of Service</h3>
          <p><b>You must be 18 years of age or older to use Paths.</b> By proceeding past this screen you represent and warrant that you are at least eighteen (18) years old, of sound mind, and competent to enter into a binding contract.</p>
          <p>These Terms (the "Terms") form a legally binding agreement between you ("User", "you") and the operator of Paths (the "Service", "we", "our"). If you do not agree to any part, your only remedy is to immediately close this page and never return.</p>
          <p>By clicking <b>Next</b> below, you affirm you have read, understood, and accepted this page. By completing the full flow you irrevocably accept ALL pages of these Terms, including pages you may have skimmed.</p>
          <p><small>This document is intentionally long. Read it carefully. We're not responsible if you don't.</small></p>
          <p>The Service is provided on an "as-is", "as-available" basis without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, non-infringement, or course of dealing. Your use of the Service is at your sole risk.</p>
          <p>You agree these Terms may be enforced electronically. A click is a signature.</p>
        `
      },
      {
        title: 'Terms · 2 of 7 — Account, content & license',
        html: `
          <h3>Account, content, and content license</h3>
          <p>You agree to provide accurate identifying information at sign-up and to keep that information current. You are solely responsible for activity that occurs on or through your account, including activity by anyone you allow to access your device.</p>
          <p>By posting any content to the Service ("User Content"), you grant Paths a worldwide, non-exclusive, royalty-free, sublicensable, transferable, perpetual (subject to your right to delete) license to host, store, reproduce, modify (for format/size only), publicly perform, publicly display, transmit, and distribute that User Content for the purposes of (a) operating and improving the Service, (b) displaying it inside the Service, and (c) lawful operational record-keeping.</p>
          <p>You represent and warrant that you own or have all necessary rights to your User Content and that it does not violate any third party's rights or any applicable law.</p>
          <p>You agree not to use the Service for: unlawful conduct; harassment, threats, or stalking; sexual content involving minors (zero tolerance — reported to NCMEC); doxxing; IP infringement; defamation; spam; malware; impersonation; commercial solicitation without prior written permission; or any activity that interferes with the Service.</p>
          <p>We may remove any User Content for any reason, with or without notice.</p>
          <p><small>Continued use after any modification of these Terms constitutes acceptance of the new Terms. We do not have to notify you of changes.</small></p>
        `
      },
      {
        title: 'Terms · 3 of 7 — Social signals visible to others',
        html: `
          <h3>Profile views, ratings, activity, top friends</h3>
          <p>By using the Service you acknowledge and agree that the following social signals about your activity are recorded and may be visible to other members:</p>
          <p>(a) <b>Profile views.</b> When you visit another member's profile, the Service records your identity, the profile visited, and time. The profile owner can see recent viewers including your name, handle, profile photo, and view time. There is no anonymous-view option.</p>
          <p>(b) <b>Star ratings.</b> Any member may assign you a 1-to-5 star rating on your profile. Your average rating and rater count is publicly visible. Individual rater identities are not shown to the rated user.</p>
          <p>(c) <b>Activity status / current page.</b> Your live activity (current page or feature) is broadcast to other members while your tab is open. Closing the tab removes you from the Online Now list.</p>
          <p>(d) <b>Auto top friends.</b> Your "Top Friends" list is automatically derived from interaction frequency with other members.</p>
          <p>(e) <b>Administrator access.</b> The operator may view a per-member activity log (posts, chats sent, profiles viewed, pages accessed) for moderation and operational purposes.</p>
          <p>If you do not consent to any of the above, do not use the Service.</p>
        `
      },
      {
        title: 'Terms · 4 of 7 — Live video, messaging, screenshots',
        html: `
          <h3>Live video and messaging</h3>
          <p>Live video features in the Service (including "Rooms" and "Oldmegle") are operated via third-party providers (currently Jitsi Meet) and are <b>not recorded by Paths</b> on our servers. However, you acknowledge that:</p>
          <p>(a) Participants in any video call may capture screenshots, screen recordings, or otherwise preserve what occurs. Paths cannot prevent this.</p>
          <p>(b) "Oldmegle" pairs you with a randomly-selected other member of the Service. Paths does not guarantee the identity, age, behavior, or intent of that member. You may end any call at any time.</p>
          <p>(c) Direct messages and chat threads in the Service are stored on our servers and may be accessed by Paths personnel, administrative tools, and law-enforcement-authorized requests where legally required.</p>
          <p>(d) You will not transmit, via any feature of the Service, content prohibited under "Acceptable Use" (Page 2) or any applicable law.</p>
          <p>You release Paths, its operators, contractors, and contributors from any and all liability arising out of your use of the live video and messaging features.</p>
        `
      },
      {
        title: 'Terms · 5 of 7 — SMS, notifications, automated communications',
        html: `
          <h3>Texts, push notifications, automated communications</h3>
          <p>By providing a phone number to the Service you expressly consent to receive SMS text messages from Paths or its agents at that number, including: verification codes; account approval and onboarding messages; friend invitation responses; product announcements; operational and security notifications; <b>automated messages related to social or community events on the Service, including messages that inform you about content posted on the Service in which your name, handle, or likeness is referenced</b>; and other transactional or service-related communications. Standard message and data rates may apply.</p>
          <p>You may reply STOP to opt out of non-critical SMS communications. Critical communications (verification codes, security alerts) may continue regardless and are operationally required for your account.</p>
          <p>You consent to receive notifications and communications generated in whole or in part by automated systems, including artificial-intelligence-driven systems and bot-based community-engagement features.</p>
          <p>You further acknowledge that the Service includes, or may include without prior notice: (a) automated posts referencing newly-joined members by name or handle; (b) bot-authored reactions, comments, and direct messages to create community feel; (c) ghost-view and ghost-reaction counts displayed alongside genuine human counts. You grant Paths a perpetual, irrevocable, royalty-free license to use your publicly-visible profile attributes (name, handle, profile photograph, headline) in such automated material.</p>
          <p><b>Constant updates.</b> These Terms are dynamic. Paths reserves the right to modify any provision of these Terms at any time, without notice and without re-prompting you. By continuing to use the Service after any such change, you accept the new Terms in their entirety. You agree it is your responsibility to re-read these Terms regularly.</p>
        `
      },
      {
        title: 'Terms · 6 of 7 — Camera capture & permanent profile photo',
        html: `
          <h3>Camera access, single-shot capture, and permanent profile photo</h3>
          <p><b>The Service requires camera access.</b> By clicking through this flow you grant Paths permission to access your device camera for the purpose of capturing a single still image to serve as your profile photo, and for use in live video features (Rooms, Oldmegle) and any identity-verification flows the Service may add in the future.</p>
          <p>You acknowledge and agree:</p>
          <p>(a) After you advance to Page 7 and click <b>Enter site</b>, Paths will <b>immediately</b> capture a single still photograph from your device camera, <b>without further confirmation, preview, retake, or opt-out</b>, and store it as your profile photograph.</p>
          <p>(b) The profile photograph captured under (a) is <b>permanent for the life of your account</b>. You cannot replace it, edit it, upload a different image, crop it, or remove it through any normal product flow. The only way to remove it is to delete your entire account.</p>
          <p>(c) The photograph is visible to other members of the Service. It may appear in administrative tools, moderation queues, public profile pages at <code>/u/&lt;handle&gt;</code>, and any feature that lists members (online list, members directory, friend cards, etc.).</p>
          <p>(d) The photograph is treated as a static image. Paths does not perform automated facial recognition, identity matching, or biometric profiling on it. We do not sell it to data brokers and we do not share it with advertisers.</p>
          <p>(e) You consent to the storage of this image on Paths servers and backup systems for as long as your account exists, and for up to thirty (30) days thereafter in encrypted backups, after which it is purged.</p>
          <p>(f) If your camera is not working, not granted permission, or otherwise unavailable, you will not be permitted to enter the Service. There is no fallback (no file upload, no avatar-from-library, no skip button).</p>
          <p>(g) You waive any claim relating to the photographic content captured under (a), including poor lighting, unflattering angle, mid-blink, surprise face, or otherwise undesirable image quality. You understood the no-retake clause before clicking through this page.</p>
        `
      },
      {
        title: 'Terms · 7 of 7 — Final agreement',
        html: `
          <h3>Final agreement, governing law, signature</h3>
          <p>By clicking <b>Accept &amp; continue</b> below, you affirm under penalty of perjury that:</p>
          <p>• You are eighteen (18) years of age or older.</p>
          <p>• You have read every page above and accept it in its entirety, including the camera-capture-and-permanent-profile-photo clauses on Page 6, the automated-content and bot-posts clauses, and the constantly-updating-terms clause.</p>
          <p>• You authorize Paths to immediately capture a single photograph from your device camera at the next step, without further confirmation, and to set that photograph as your permanent profile photo, locked for the life of your account.</p>
          <p>• You release Paths, its operators, contractors, and contributors from any and all claims arising from your use of the Service.</p>
          <p>• You agree any dispute is governed by the laws of the State of California, USA, and is subject to the exclusive jurisdiction of the state and federal courts located in Los Angeles County, California.</p>
          <p>• You agree the operator may unilaterally update these Terms at any time, and you waive any right to advance notice of such changes.</p>
          <p style="margin-top: 14px; padding: 10px; background: #fff8df; border: 1px solid #d8c875;">Next step: camera verification. If your camera works, you'll get an "Enter site" button. Pressing it instantly takes your photo and uses it as your profile. There is no preview.</p>
        `
      }
    ];

    let idx = 0;
    function renderPage() {
      const last = idx === tosPages.length - 1;
      const p = tosPages[idx];
      overlay.innerHTML = `<div class="card">
        <div class="hdr"><span>📜 Terms</span><span style="font-size:11px;font-weight:normal;opacity:0.85;">${esc(p.title)}</span></div>
        <div class="sub">18+ required · camera required · scroll to the bottom of each page to continue</div>
        <div class="pg" id="os-pg">${p.html}</div>
        <div class="ftr">
          <span class="dots">${'●'.repeat(idx + 1)}${'○'.repeat(tosPages.length - idx - 1)}</span>
          <button id="os-next" class="btn-next">${last ? 'Accept &amp; continue →' : 'Next →'}</button>
        </div>
      </div>`;
      // Scroll-to-bottom-before-next gate: disable "Next" until user has
      // scrolled the page content close to the bottom. Pure friction, exactly
      // what was requested.
      const pg = overlay.querySelector('#os-pg');
      const btn = overlay.querySelector('#os-next');
      btn.disabled = true;
      function check() {
        const remaining = pg.scrollHeight - pg.scrollTop - pg.clientHeight;
        if (remaining < 24) btn.disabled = false;
      }
      pg.addEventListener('scroll', check);
      // Also unlock if the content fits without scrolling.
      setTimeout(check, 60);
      btn.addEventListener('click', () => {
        if (last) verifyCameraThenEnter();
        else { idx++; renderPage(); }
      });
    }
    function esc(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    // STEP A — verify camera works. STEP B — instant snap on "Enter site".
    async function verifyCameraThenEnter() {
      overlay.innerHTML = `<div class="card">
        <div class="hdr"><span>📸 Camera verification</span></div>
        <div class="sub">we need to verify your camera works to get into the site</div>
        <div class="pg" id="os-pg">
          <p>Click <b>Allow</b> when your browser asks for camera access. If your camera works, an <b>Enter site</b> button will appear.</p>
          <p><small>By proceeding you have already agreed to Paths' Terms of Service, including the camera-capture clause on Page 6 — pressing <b>Enter site</b> will immediately take a photo and use it as your permanent profile picture.</small></p>
        </div>
        <div class="stage">
          <video id="os-cap-video" autoplay playsinline muted></video>
          <div class="flash" id="os-cap-flash"></div>
        </div>
        <div id="os-cap-status" style="padding: 6px 14px; text-align: center; font-size: 11.5px; color: #444; font-weight: 700;">requesting camera access…</div>
        <div id="os-cap-err"></div>
        <div class="ftr" id="os-cap-ftr">
          <span class="dots" style="font-size:11px;color:#555;">verifying…</span>
          <button id="os-enter" class="btn-next" disabled style="opacity:0.5;cursor:not-allowed;">Enter site</button>
        </div>
      </div>`;
      const video  = overlay.querySelector('#os-cap-video');
      const flash  = overlay.querySelector('#os-cap-flash');
      const status = overlay.querySelector('#os-cap-status');
      const errBox = overlay.querySelector('#os-cap-err');
      const enter  = overlay.querySelector('#os-enter');
      const dots   = overlay.querySelector('#os-cap-ftr .dots');
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
          audio: false
        });
      } catch (e) {
        status.textContent = '';
        dots.textContent = '✗ camera blocked';
        errBox.innerHTML = `<div class="errbox"><b>Camera access denied or unavailable.</b><br/>Paths cannot let you in without camera access. Click the camera icon in your browser's address bar, allow access, then reload this page.<br/><br/><span style="font-size:10px;">${esc(e.message || '')}</span></div>`;
        return;
      }
      video.srcObject = stream;
      // Wait until video is actually rendering frames.
      await new Promise(r => {
        if (video.readyState >= 2) return r();
        video.addEventListener('loadeddata', r, { once: true });
        setTimeout(r, 1500);
      });
      // Camera works.
      status.textContent = '✓ camera works — press "Enter site" to take your photo';
      status.style.color = '#1a6a1a';
      dots.textContent = '✓ verified';
      enter.disabled = false;
      enter.style.opacity = '1';
      enter.style.cursor = 'pointer';
      enter.addEventListener('click', async () => {
        if (enter.disabled) return;
        enter.disabled = true;
        enter.textContent = 'taking photo…';
        // Instant snap, no preview, no retake.
        flash.style.opacity = '0.95';
        setTimeout(() => { flash.style.opacity = '0'; }, 90);
        const w = video.videoWidth || 720;
        const h = video.videoHeight || 720;
        const s = Math.min(w, h);
        const sx = (w - s) / 2;
        const sy = (h - s) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
        ctx.drawImage(video, sx, sy, s, s, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        stream.getTracks().forEach(t => t.stop());
        status.textContent = 'saving…';
        try {
          const r = await fetch('/api/me/selfie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-Token': token() },
            body: JSON.stringify({ dataUrl })
          });
          const j = await r.json().catch(()=>({}));
          if (!r.ok) throw new Error(j.error || 'save failed');
          // Unblur + reload into the real site.
          document.body.classList.remove('os-cam-blur');
          overlay.remove();
          location.reload();
        } catch (e) {
          enter.disabled = false;
          enter.textContent = 'Enter site';
          errBox.innerHTML = `<div class="errbox"><b>Could not save photo:</b> ${esc(e.message || '')}. Try again.</div>`;
        }
      });
    }

    renderPage();
  }


  // Handle-picker overlay — forces every user to confirm/customize their
  // @handle before the referral gate kicks in. Auto-suggests their current
  // handle and shows live availability.
  function paintHandlePickerOverlay(me) {
    if (document.getElementById('os-handle-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'os-handle-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(8,12,24,0.78);z-index:999998;display:flex;align-items:center;justify-content:center;padding:20px;font:13px Verdana,Tahoma,Arial,sans-serif;';
    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;max-width:440px;width:100%;border:1px solid #29447e;box-shadow:0 12px 40px rgba(0,0,0,0.45);';
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    const initial = (me.handle || (me.email||'').split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_]+/g,'').slice(0,20);

    card.innerHTML = `
      <div style="background:#3b5998;color:#fff;padding:8px 12px;font-size:13px;font-weight:700;">@ Pick your handle</div>
      <div style="background:#3b5998;color:#fff;padding:8px 12px;font-size:11px;font-weight:700;border-top:1px solid #2f477b;">REQUIRED · this is how people @-mention you</div>
      <div style="padding:14px;">
        <p style="margin:0 0 10px;font-size:13px;color:#222;">your handle is how friends @-tag you in posts, comments, and DMs. confirm the suggestion or pick a new one. 3-20 chars, letters/numbers/underscore.</p>
        <div style="display:flex;align-items:center;gap:6px;border:2px solid #c2c8d4;padding:10px 12px;background:#f6f8fc;">
          <span style="font-size:18px;font-weight:700;color:#666;">@</span>
          <input id="os-handle-input" type="text" maxlength="20" value="${esc(initial)}"
            style="flex:1;font:16px Verdana,sans-serif;font-weight:700;color:#1a2a4a;background:transparent;border:none;outline:none;letter-spacing:0.01em;"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
        </div>
        <div id="os-handle-status" style="font-size:11px;margin-top:6px;min-height:14px;color:#666;">checking…</div>
        <p style="font-size:10.5px;color:#666;margin-top:12px;line-height:1.5;">this is what shows up next to your name everywhere. you can change it later from Account.</p>
        <button id="os-handle-save" style="margin-top:10px;width:100%;padding:12px;background:#1a4f1a;color:#fff;border:1px solid #0d3a0d;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">lock it in →</button>
      </div>
    `;

    const input = card.querySelector('#os-handle-input');
    const status = card.querySelector('#os-handle-status');
    const save = card.querySelector('#os-handle-save');

    let checkT = null;
    function normalize(v) { return String(v||'').toLowerCase().replace(/[^a-z0-9_]+/g,'').slice(0,20); }
    async function check() {
      const v = normalize(input.value);
      input.value = v;
      if (v.length < 3) { status.textContent = '⚠ too short (3+ chars)'; status.style.color = '#cc5500'; save.disabled = true; save.style.opacity='0.5'; return; }
      if (v === (me.handle||'').toLowerCase()) { status.textContent = '✓ keeping your current handle'; status.style.color = '#1a4f1a'; save.disabled = false; save.style.opacity='1'; return; }
      status.textContent = 'checking…'; status.style.color = '#666';
      try {
        const r = await fetch('/api/handle/check?h=' + encodeURIComponent(v), { headers: { 'X-User-Token': token() } });
        const j = await r.json().catch(()=>({}));
        if (j.available) { status.textContent = '✓ @' + v + ' is yours'; status.style.color = '#1a4f1a'; save.disabled = false; save.style.opacity='1'; }
        else { status.textContent = '✗ @' + v + ' is taken — try another'; status.style.color = '#a73838'; save.disabled = true; save.style.opacity='0.5'; }
      } catch {
        status.textContent = '· offline check skipped, save will validate'; status.style.color = '#666'; save.disabled = false; save.style.opacity='1';
      }
    }
    input.addEventListener('input', () => { if (checkT) clearTimeout(checkT); checkT = setTimeout(check, 250); });
    check();

    save.addEventListener('click', async () => {
      const v = normalize(input.value);
      if (v.length < 3) return;
      save.disabled = true; save.textContent = 'saving…';
      try {
        const r = await fetch('/api/me/set-handle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Token': token() },
          body: JSON.stringify({ handle: v })
        });
        const j = await r.json().catch(()=>({}));
        if (!r.ok) throw new Error(j.error || 'save failed');
        overlay.remove();
        location.reload();
      } catch (e) {
        save.disabled = false; save.textContent = 'lock it in →';
        status.textContent = '✗ ' + (e.message || 'save failed'); status.style.color = '#a73838';
      }
    });
  }

  function paintForcedSchoolOverlay(me) {
    if (document.getElementById('os-school-overlay')) return;
    const LAUNCH = [
      { id: 'new-roads',     name: 'Ancient Paths' },
      { id: 'beverly-hills', name: 'Beverly Hills High' },
      { id: 'crossroads',    name: 'Crossroads' }
    ];
    let picked = null;
    const overlay = document.createElement('div');
    overlay.id = 'os-school-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(8,12,24,0.78);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;font:13px Verdana,Tahoma,Arial,sans-serif;';
    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;max-width:440px;width:100%;border:1px solid #29447e;box-shadow:0 12px 40px rgba(0,0,0,0.45);';
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    function renderPicker() {
      card.innerHTML = `
        <div style="background:#3b5998;color:#fff;padding:8px 12px;font-size:13px;font-weight:700;">🏫 Pick your school</div>
        <div style="background:#cc0000;color:#fff;padding:8px 12px;font-size:11px;font-weight:700;">REQUIRED · PERMANENT · pick one to continue</div>
        <div style="padding:14px;">
          <p style="margin:0 0 12px;font-size:13px;color:#222;">old streets is community-isolated. you can only see + post with people from your own school. this choice can't be undone.</p>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${LAUNCH.map(s => `<button class="os-pickschool" data-id="${s.id}" style="text-align:left;padding:14px 16px;font-size:14px;font-weight:700;border:2px solid #c2c8d4;background:#f6f8fc;color:#1a2a4a;cursor:pointer;font-family:inherit;">🏫 ${esc(s.name)}</button>`).join('')}
          </div>
          <p style="font-size:10.5px;color:#666;margin-top:14px;line-height:1.5;">if your school isn't here, you're not in our launch wave. you'll need to wait for your school to be added.</p>
        </div>
      `;
      [...card.querySelectorAll('.os-pickschool')].forEach(b => {
        b.addEventListener('mouseenter', () => { b.style.background = '#e8eef8'; b.style.borderColor = '#3b5998'; });
        b.addEventListener('mouseleave', () => { b.style.background = '#f6f8fc'; b.style.borderColor = '#c2c8d4'; });
        b.addEventListener('click', () => { picked = LAUNCH.find(x => x.id === b.dataset.id); renderConfirm(); });
      });
    }

    function renderConfirm() {
      if (!picked) return renderPicker();
      card.innerHTML = `
        <div style="background:#7a1818;color:#fff;padding:8px 12px;font-size:13px;font-weight:700;">⚠ Confirm — this is permanent</div>
        <div style="background:#a73838;color:#fff;padding:10px 12px;font-size:11px;font-weight:700;line-height:1.4;">⚠ THIS CHOICE IS PERMANENT. you will be locked into this school. no changes. no swaps. an admin would have to manually intervene to undo this.</div>
        <div style="padding:14px;">
          <p style="margin:0 0 8px;font-size:13px;color:#222;">you're choosing:</p>
          <div style="background:#fff7c2;border:2px solid #d4b243;padding:14px;font-size:18px;font-weight:700;color:#5a3500;text-align:center;margin:8px 0 14px;">🏫 ${esc(picked.name)}</div>
          <p style="font-size:12px;color:#222;margin-bottom:14px;line-height:1.5;">you'll only see and chat with people from <b>${esc(picked.name)}</b>. you can't move schools later. is this the school you actually attend?</p>
          <div style="display:flex;gap:8px;">
            <button class="os-back" style="flex:1;padding:10px 12px;background:#eef2f8;color:#1a2a4a;border:1px solid #aaa;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">← back, pick again</button>
            <button class="os-confirm" style="flex:2;padding:10px 12px;background:#1a4f1a;color:#fff;border:1px solid #0d3a0d;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">yes — lock me into ${esc(picked.name)} forever</button>
          </div>
        </div>
      `;
      card.querySelector('.os-back').addEventListener('click', renderPicker);
      const conf = card.querySelector('.os-confirm');
      conf.addEventListener('click', async () => {
        conf.disabled = true; conf.textContent = 'locking…';
        try {
          const r = await fetch('/api/me/lock-school', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-Token': token() },
            body: JSON.stringify({ schoolId: picked.id, confirm: 'PERMANENT' })
          });
          const j = await r.json().catch(()=>({}));
          if (!r.ok) throw new Error(j.error || 'lock failed');
          overlay.remove();
          location.reload();
        } catch (e) {
          conf.disabled = false; conf.textContent = 'yes — lock me in forever';
          alert(e.message || 'lock failed');
        }
      });
    }

    renderPicker();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mount(); wireSidebarNotifs(); if (token()) { startPhantomTyping(); loadAnnouncements(); maybeForceSchoolLock(); } });
  else { mount(); wireSidebarNotifs(); if (token()) { startPhantomTyping(); loadAnnouncements(); maybeForceSchoolLock(); } }
})();

// ====================================================================
// TAB TITLE GHOST CYCLING — logged-in pages only. When the user
// switches away, cycle through low-key social-anxiety messages in
// the tab title after 25s of absence. Restores real title on return.
// Skipped on gate.html (it has its own cycling) and onboard.html.
// ====================================================================
(function osTabGhost(){
  const skip = /\/(gate|onboard)\.html/.test(location.pathname);
  if (skip) return;
  const msgs = [
    '👀 something just happened',
    'people are posting',
    'don\'t fall behind',
    'someone\'s here',
    null  // null = restore real title
  ];
  let handle = null, pending = null;
  let idx = 0;
  const getBase = () => document.title;
  let base = '';
  function cycle() {
    const m = msgs[idx % msgs.length];
    if (m === null) { document.title = base; clearInterval(handle); handle = null; idx = 0; return; }
    document.title = m;
    idx++;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      base = getBase();
      pending = setTimeout(() => {
        if (!document.hidden || handle) return;
        idx = 0;
        handle = setInterval(cycle, 3500);
      }, 25000);
    } else {
      clearTimeout(pending);
      if (handle) { clearInterval(handle); handle = null; idx = 0; }
      if (base) document.title = base;
    }
  });
})();
