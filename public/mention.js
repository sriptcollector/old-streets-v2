// =========================================================================
// @-MENTION AUTOFILL — universal. Drop this on any page and every textarea
// and text input gets @-handle autocomplete automatically. Triggers when
// the caret is right after an "@" with no space between, and the partial
// is 0+ chars (we show 'recent' if empty, search results once they type).
//
// Floats a dropdown anchored to the input, navigable with ↑ ↓, accepted
// with Enter/Tab, closed with Esc or clicking outside.
// =========================================================================
(function () {
  if (window.__osMentionInit) return; window.__osMentionInit = true;

  const TOKEN = localStorage.getItem('oldstreets-token') || sessionStorage.getItem('oldstreets-token');
  if (!TOKEN) return; // signed-out page — no mentions

  const css = `
    .osm-pop {
      position: absolute; z-index: 99999;
      background: #fff; border: 1px solid #29447e;
      box-shadow: 0 4px 14px rgba(0,0,0,0.18);
      min-width: 220px; max-width: 320px;
      max-height: 240px; overflow-y: auto;
      font: 12px Verdana, Tahoma, Arial, sans-serif;
    }
    .osm-row {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 9px; cursor: pointer;
      border-bottom: 1px solid #e7eaf0;
    }
    .osm-row:last-child { border-bottom: none; }
    .osm-row.active, .osm-row:hover { background: #eef2f8; }
    .osm-av {
      width: 22px; height: 22px; border-radius: 50%;
      background: #c7cfdb url('') center/cover no-repeat;
      flex-shrink: 0; font-size: 10px; color: #fff;
      display: flex; align-items: center; justify-content: center; font-weight: 700;
    }
    .osm-nm { font-weight: 700; color: #1a2a4a; line-height: 1.1; }
    .osm-h  { font-size: 10px; color: #5c6b86; line-height: 1.1; }
    .osm-empty { padding: 10px 12px; color: #888; font-style: italic; font-size: 11px; }
    .osm-hint  { padding: 4px 9px; font-size: 10px; color: #888; background: #f7f8fb; border-bottom: 1px solid #e0e3eb; }
  `;
  const styleTag = document.createElement('style');
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  let pop = null;
  let activeIdx = 0;
  let lastResults = [];
  let activeField = null;
  let triggerStart = -1; // index of '@' in the field value
  let debounceT = null;
  let cache = new Map();

  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function isMentionTarget(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.dataset && el.dataset.osNoMention === '1') return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return t === 'text' || t === 'search' || t === '';
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function getCaret(field) {
    if (field.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return -1;
      return sel.anchorOffset;
    }
    return field.selectionStart ?? -1;
  }

  function getText(field) {
    if (field.isContentEditable) return field.textContent || '';
    return field.value || '';
  }

  function setText(field, val, caretAt) {
    if (field.isContentEditable) {
      field.textContent = val;
      const sel = window.getSelection();
      const range = document.createRange();
      const node = field.firstChild || field;
      try { range.setStart(node, Math.min(caretAt, (node.nodeValue || '').length)); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); } catch {}
    } else {
      field.value = val;
      try { field.setSelectionRange(caretAt, caretAt); } catch {}
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Detect "@partial" at caret position. Returns { start, partial } or null.
  function detectTrigger(field) {
    const text = getText(field);
    const caret = getCaret(field);
    if (caret < 0) return null;
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@') {
        if (i > 0 && /\S/.test(text[i - 1]) && !/[\s\n]/.test(text[i - 1])) return null;
        return { start: i, partial: text.slice(i + 1, caret) };
      }
      if (/[\s\n]/.test(ch)) return null;
      if (caret - i > 20) return null;
      i--;
    }
    return null;
  }

  function placePop(field) {
    if (!pop) return;
    const r = field.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    pop.style.top  = (r.bottom + scrollY + 2) + 'px';
    pop.style.left = (r.left + scrollX) + 'px';
  }

  function closePop() {
    if (pop) { pop.remove(); pop = null; }
    activeIdx = 0; lastResults = []; activeField = null; triggerStart = -1;
  }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'osm-pop';
    document.body.appendChild(pop);
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    return pop;
  }

  function renderPop(results, partial) {
    ensurePop();
    lastResults = results;
    activeIdx = 0;
    if (!results.length) {
      pop.innerHTML = '<div class="osm-empty">no matches for @' + esc(partial) + '</div>';
      return;
    }
    pop.innerHTML = '<div class="osm-hint">↑ ↓ to pick · enter to insert</div>' +
      results.map((u, i) => {
        const init = (u.name || u.handle || '?').trim()[0] || '?';
        const av = u.avatar ? `style="background-image:url('${esc(u.avatar)}')"` : '';
        return `<div class="osm-row ${i === 0 ? 'active' : ''}" data-i="${i}">
          <div class="osm-av" ${av}>${av ? '' : esc(init.toUpperCase())}</div>
          <div>
            <div class="osm-nm">${esc(u.name || u.handle || '?')}</div>
            <div class="osm-h">@${esc(u.handle || u.email || '')}</div>
          </div>
        </div>`;
      }).join('');
    [...pop.querySelectorAll('.osm-row')].forEach(row => {
      row.addEventListener('click', () => { activeIdx = +row.dataset.i; choose(); });
    });
  }

  async function search(partial) {
    if (cache.has(partial)) return cache.get(partial);
    const q = partial.length === 0 ? '' : partial;
    if (q.length < 1) {
      // empty trigger — show friends or recent. Hit /api/friends.
      try {
        const r = await fetch('/api/friends', { headers: { 'X-User-Token': TOKEN } });
        const j = await r.json().catch(() => ({}));
        const list = (j.friends || []).slice(0, 8);
        cache.set(partial, list);
        return list;
      } catch { return []; }
    }
    try {
      const r = await fetch('/api/search?scope=people&q=' + encodeURIComponent(q), { headers: { 'X-User-Token': TOKEN } });
      const j = await r.json().catch(() => ({}));
      const list = (j.results || []).slice(0, 8);
      cache.set(partial, list);
      return list;
    } catch { return []; }
  }

  function choose() {
    if (!pop || !activeField || !lastResults.length || triggerStart < 0) { closePop(); return; }
    const user = lastResults[activeIdx];
    if (!user) { closePop(); return; }
    const text = getText(activeField);
    const caret = getCaret(activeField);
    const handle = user.handle || (user.email || '').split('@')[0];
    const replace = '@' + handle + ' ';
    const before = text.slice(0, triggerStart);
    const after  = text.slice(caret);
    const next   = before + replace + after;
    const newCaret = (before + replace).length;
    setText(activeField, next, newCaret);
    closePop();
  }

  function moveActive(delta) {
    if (!pop || !lastResults.length) return;
    activeIdx = (activeIdx + delta + lastResults.length) % lastResults.length;
    [...pop.querySelectorAll('.osm-row')].forEach((row, i) => row.classList.toggle('active', i === activeIdx));
    const active = pop.querySelector('.osm-row.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function onInput(e) {
    const field = e.target;
    if (!isMentionTarget(field)) return;
    const trig = detectTrigger(field);
    if (!trig) { closePop(); return; }
    activeField = field;
    triggerStart = trig.start;
    if (debounceT) clearTimeout(debounceT);
    debounceT = setTimeout(async () => {
      const results = await search(trig.partial);
      if (activeField !== field) return; // user moved on
      renderPop(results, trig.partial);
      placePop(field);
    }, 60);
  }

  function onKeyDown(e) {
    if (!pop || !activeField) return;
    if (e.target !== activeField) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (lastResults.length) { e.preventDefault(); choose(); }
    } else if (e.key === 'Escape') { e.preventDefault(); closePop(); }
  }

  function onFocusOut(e) {
    setTimeout(() => { if (!pop || !pop.contains(document.activeElement)) closePop(); }, 120);
  }

  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('scroll', () => { if (activeField) placePop(activeField); }, true);
  window.addEventListener('resize', () => { if (activeField) placePop(activeField); });
})();
