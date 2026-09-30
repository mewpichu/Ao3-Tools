// ==UserScript==
// @name         AO3: Proximity Flags
// @namespace    ao3ph
// @version      1.0
// @description  Flags and highlights when watchlist words/phrases appear near each other in an AO3 work. Settings live in the Userscripts dropdown menu.
// @match        https://archiveofourown.org/works/*
// @match        https://archiveofourown.org/chapters/*
// @match        https://archiveofourown.com/works/*
// @match        https://archiveofourown.com/chapters/*
// @match        https://archiveofourown.net/works/*
// @match        https://archiveofourown.net/chapters/*
// @match        https://archiveofourown.gay/works/*
// @match        https://archiveofourown.gay/chapters/*
// @match        https://ao3.org/works/*
// @match        https://ao3.org/chapters/*
// @match        https://archive.transformativeworks.org/works/*
// @match        https://archive.transformativeworks.org/chapters/*
// @match        http://insecure.archiveofourown.org/works/*
// @match        http://insecure.archiveofourown.org/chapters/*
// @require      https://update.greasyfork.org/scripts/552743/1859007/AO3%3A%20Menu%20Helpers%20Library.js?v=2.3.0
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @license      MIT
// @author       mewpichu
// ==/UserScript==
 
(function () {
  'use strict';
 
  /* ============================ Settings ============================ */
 
  const DEFAULTS = {
    terms: [],            // array of strings (words or phrases)
    proximity: 500,       // in words
    wholeWords: true,     // whole-word matching (uses Unicode-aware boundaries)
    caseSensitive: false,
    heatmap: true,        // show the scrollbar heatmap
    showHighlights: true, // highlight flagged passages in the text
    enabled: true,
  };
 
  const STORE_KEY = 'ao3ph_settings_v1';
 
  function loadSettings() {
    let raw = null;
    try { if (typeof GM_getValue === 'function') raw = GM_getValue(STORE_KEY, null); } catch (e) {}
    if (raw == null) { try { raw = localStorage.getItem(STORE_KEY); } catch (e) {} }
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
    return Object.assign({}, DEFAULTS, raw || {});
  }
 
  function saveSettings() {
    const s = JSON.stringify(settings);
    try { if (typeof GM_setValue === 'function') GM_setValue(STORE_KEY, s); } catch (e) {}
    try { localStorage.setItem(STORE_KEY, s); } catch (e) {}
  }
 
  const settings = loadSettings();
 
  const debounce = (fn, ms) => {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
 
  /* ============================ Text engine ============================
     Flattens the work's text nodes into one string + offset map, so
     phrases spanning inline markup (<em> etc.) still match, and word
     positions are simple integers. */
 
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'TR',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'HR', 'TABLE', 'UL', 'OL']);
 
  function getContentRoots() {
    const roots = [];
    document.querySelectorAll('#workskin .userstuff, #chapters .userstuff').forEach(el => {
      if (el.closest('.notes')) return;   // skip author's notes
      roots.push(el);
    });
    return [...new Set(roots)];
  }
 
  function blockAncestorOf(node, root) {
    let el = node.parentElement;
    while (el && el !== root) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return root;
  }
 
  function collectText(roots) {
    const nodes = [];      // {node, start}
    let text = '';
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p || p.closest('script, style, .ao3ph-ui')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let prevBlock = null, n;
      while ((n = walker.nextNode())) {
        const block = blockAncestorOf(n, root);
        if (nodes.length && block !== prevBlock) text += '\n'; // don't merge words across paragraphs
        prevBlock = block;
        nodes.push({ node: n, start: text.length });
        text += n.nodeValue;
      }
      text += '\n';
    }
    return { nodes, text };
  }
 
  function upperBound(arr, x) { // first index where arr[i] > x
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }
 
  function buildRegex(terms) {
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const W = '[\\p{L}\\p{N}_]';
    const parts = terms.map(raw => {
      const t = raw.trim();
      // '*' is a wildcard: matches any run of word characters (including none).
      // Split on it first so the escaping below doesn't neutralize it.
      let p = t.split('*')
               .map(seg => esc(seg).replace(/\s+/g, '\\s+'))
               .join(W + '*');
      if (settings.wholeWords) {
        // Boundary checks only apply where the term actually starts/ends
        // with a word character — a leading/trailing '*' replaces them.
        if (new RegExp('^' + W, 'u').test(t)) p = '(?<!' + W + ')' + p;
        if (new RegExp(W + '$', 'u').test(t)) p = p + '(?!' + W + ')';
      }
      return '(' + p + ')';
    });
    return new RegExp(parts.join('|'), settings.caseSensitive ? 'gu' : 'giu');
  }
 
  // Returns { hits, flags }. hits: {term, termKey, start, end, wordIndex}
  function scan(collected) {
    const { text } = collected;
    if (!settings.terms.length || !text) return { hits: [], flags: [] };
 
    const wordStarts = [];
    const wRe = /\S+/g;
    let m;
    while ((m = wRe.exec(text))) wordStarts.push(m.index);
    const wordIndexAt = pos => upperBound(wordStarts, pos) - 1;
 
    const re = buildRegex(settings.terms);
    const hits = [];
    while ((m = re.exec(text))) {
      let g = 1;
      while (g < m.length && m[g] === undefined) g++;      // which alternation matched
      if (m[0].length === 0) { re.lastIndex++; continue; } // safety vs empty matches
      hits.push({
        term: settings.terms[g - 1],
        termKey: g - 1,
        start: m.index,
        end: m.index + m[0].length,
        wordIndex: wordIndexAt(m.index),
      });
    }
 
    // Proximity: hits are already in document order. Adjacent different-term
    // pairs within the threshold are exactly the minimal flags.
    const flags = [];
    for (let i = 0; i + 1 < hits.length; i++) {
      const a = hits[i], b = hits[i + 1];
      if (a.termKey === b.termKey) continue;
      const dist = b.wordIndex - a.wordIndex;
      if (dist <= settings.proximity) flags.push({ a: i, b: i + 1, dist });
    }
    return { hits, flags };
  }
 
  /* ===================== Page positions (for heatmap) ===================== */
 
  // Absolute Y position of each hit, via a collapsed Range on its text node.
  // Must be called while `collected`'s nodes match the current DOM.
  function computeHitTops(collected, hits) {
    const { nodes } = collected;
    if (!nodes.length) return hits.map(() => 0);
    const nodeStarts = nodes.map(n => n.start);
    const tops = new Array(hits.length).fill(0);
    const range = document.createRange();
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      let ni = upperBound(nodeStarts, h.start) - 1;
      if (ni < 0) ni = 0;
      while (ni + 1 < nodes.length &&
             nodes[ni].start + nodes[ni].node.nodeValue.length <= h.start) ni++;
      const info = nodes[ni];
      const off = Math.min(Math.max(h.start - info.start, 0), info.node.nodeValue.length);
      try {
        range.setStart(info.node, off);
        range.collapse(true);
        const r = range.getBoundingClientRect();
        tops[i] = r.top + window.scrollY;
      } catch (e) { /* leave as 0 */ }
    }
    return tops;
  }
 
  /* ========================= Highlighting =========================
     Only hits involved in a flag get wrapped; plain hits never touch
     the DOM. */
 
  function clearHighlights() {
    document.querySelectorAll('span.ao3ph-hit').forEach(span => {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      if (parent.normalize) parent.normalize();
    });
  }
 
  function highlightHits(collected, hits, flaggedIdx) {
    const { nodes } = collected;
    if (!nodes.length) return;
    const nodeStarts = nodes.map(n => n.start);
    const byNode = new Map(); // node -> [{from,to,idx,flagged}] node-relative
 
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      let ni = upperBound(nodeStarts, h.start) - 1;
      if (ni < 0) ni = 0;
      while (ni < nodes.length && nodes[ni].start < h.end) {
        const info = nodes[ni];
        const nEnd = info.start + info.node.nodeValue.length;
        const from = Math.max(h.start, info.start) - info.start;
        const to = Math.min(h.end, nEnd) - info.start;
        if (to > from) {
          if (!byNode.has(info.node)) byNode.set(info.node, []);
          byNode.get(info.node).push({ from, to, idx: i, flagged: flaggedIdx.has(i) });
        }
        if (nEnd >= h.end) break;
        ni++;
      }
    }
 
    let rendered = 0;
    const RENDER_CAP = 4000; // safety valve for pathological cases
    for (const [node, segs] of byNode) {
      if (rendered >= RENDER_CAP) break;
      segs.sort((x, y) => y.from - x.from); // descending so offsets stay valid
      let current = node;
      for (const s of segs) {
        if (rendered >= RENDER_CAP) break;
        if (s.to < current.nodeValue.length) current.splitText(s.to);
        const mid = s.from > 0 ? current.splitText(s.from) : current;
        const span = document.createElement('span');
        span.className = 'ao3ph-hit' + (s.flagged ? ' ao3ph-flagged' : '');
        span.dataset.ao3phHit = String(s.idx);
        mid.parentNode.replaceChild(span, mid);
        span.appendChild(mid);
        rendered++;
      }
    }
  }
 
  /* ============================ Heatmap ============================ */
 
  function scrollToHit(idx) {
    const span = document.querySelector(`span.ao3ph-hit[data-ao3ph-hit="${idx}"]`);
    if (span) {
      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      span.classList.remove('ao3ph-flash');
      void span.offsetWidth; // restart animation
      span.classList.add('ao3ph-flash');
    } else if (hitTops[idx] != null) {
      window.scrollTo({ top: Math.max(0, hitTops[idx] - window.innerHeight / 2), behavior: 'smooth' });
    }
  }
 
  function renderHeatmap() {
    heatmap.textContent = '';
    if (!settings.enabled || !settings.heatmap || !lastResult.hits.length || !getContentRoots().length) {
      heatmap.style.display = 'none';
      return;
    }
    heatmap.style.display = '';
    const docH = document.documentElement.scrollHeight || 1;
 
    // Yellow ticks: every hit
    lastResult.hits.forEach((h, i) => {
      const tick = document.createElement('div');
      tick.className = 'ao3ph-tick';
      tick.style.top = (hitTops[i] / docH * 100) + '%';
      tick.title = `"${h.term}"`;
      tick.addEventListener('click', () => scrollToHit(i));
      heatmap.appendChild(tick);
    });
 
    // Red ticks: one at each end of every flagged pair (drawn after
    // yellow ticks so they sit on top)
    lastResult.flags.forEach(f => {
      const a = lastResult.hits[f.a], b = lastResult.hits[f.b];
      const title = `Flag: "${a.term}" ↔ "${b.term}" (${f.dist} words apart)`;
      [f.a, f.b].forEach(idx => {
        const tick = document.createElement('div');
        tick.className = 'ao3ph-flagtick';
        tick.style.top = (hitTops[idx] / docH * 100) + '%';
        tick.title = title;
        tick.addEventListener('click', () => scrollToHit(idx));
        heatmap.appendChild(tick);
      });
    });
  }
 
  /* ============================ Rescan ============================ */
 
  let lastResult = { hits: [], flags: [] };
  let hitTops = [];
 
  function rescan() {
    clearHighlights();
    lastResult = { hits: [], flags: [] };
    hitTops = [];
 
    const roots = getContentRoots();
    const hasWork = roots.length > 0;
    launcher.style.display = hasWork ? '' : 'none';
    badge.style.display = 'none';
    heatmap.style.display = 'none';
 
    if (!hasWork || !settings.enabled || !settings.terms.length) { renderPanel(); return; }
 
    const collected = collectText(roots);
    const { hits, flags } = scan(collected);
    lastResult = { hits, flags };
 
    const flaggedIdx = new Set();
    flags.forEach(f => { flaggedIdx.add(f.a); flaggedIdx.add(f.b); });
 
    hitTops = computeHitTops(collected, hits); // before highlighting mutates the DOM
    if (settings.showHighlights) highlightHits(collected, hits, flaggedIdx); // flags only
    if (flags.length > 0) {
      badge.textContent = `⚑ ${flags.length} proximity flag${flags.length === 1 ? '' : 's'} found`;
      badge.style.display = '';
    }
    launcherLabel.textContent = flags.length ? `⚑ ${flags.length}` : '⚑';
    renderHeatmap();
    renderPanel();
  }
 
  const scheduleRescan = debounce(rescan, 250);
 
  // Marker positions depend on layout — recompute on resize without a full rescan.
  window.addEventListener('resize', debounce(() => {
    if (!lastResult.hits.length) return;
    const roots = getContentRoots();
    if (!roots.length) return;
    hitTops = computeHitTops(collectText(roots), lastResult.hits);
    renderHeatmap();
  }, 200));
 
  /* ============================== UI ============================== */
 
  const style = document.createElement('style');
  style.textContent = `
    span.ao3ph-hit { background: rgba(255, 213, 79, .5); border-radius: 2px; }
    span.ao3ph-hit.ao3ph-flagged { background: rgba(255, 112, 67, .55); box-shadow: 0 0 0 1px rgba(230, 81, 0, .9); }
    span.ao3ph-hit.ao3ph-flash { animation: ao3phflash 1s ease-out 2; }
    @keyframes ao3phflash { 50% { background: rgba(255, 0, 0, .85); } }
 
    #ao3ph-heatmap { position: fixed; top: 0; right: 0; width: 12px; height: 100vh;
      z-index: 999997; background: rgba(127, 127, 127, .10); }
    #ao3ph-heatmap .ao3ph-tick { position: absolute; right: 0; width: 7px; height: 2px;
      background: rgba(255, 193, 7, .9); cursor: pointer; }
    #ao3ph-heatmap .ao3ph-tick:hover { background: rgba(255, 193, 7, 1); width: 12px; }
    #ao3ph-heatmap .ao3ph-flagtick { position: absolute; right: 0; width: 12px; height: 3px;
      background: rgba(229, 57, 53, .95); cursor: pointer; }
    #ao3ph-heatmap .ao3ph-flagtick:hover { background: rgba(255, 30, 20, 1); }
 
    #ao3ph-launcher { position: fixed; right: 16px; bottom: 16px; z-index: 999998;
      background: #2a2a2a; color: #fff; border: 1px solid #555; border-radius: 6px;
      padding: 6px 10px; font: 13px/1.4 sans-serif; cursor: pointer; opacity: .92; }
    #ao3ph-launcher:hover { opacity: 1; }
 
    #ao3ph-badge { cursor: pointer; font-size: .9em; margin: .4em 0; padding: .3em .6em;
      border: 1px solid #c25b4e; border-radius: 4px; display: inline-block; }
 
    #ao3ph-panel { position: fixed; right: 16px; bottom: 56px; z-index: 999999;
      width: 320px; max-height: 60vh; overflow: auto; background: #1f1f1f; color: #eee;
      border: 1px solid #555; border-radius: 8px; padding: 10px; font: 13px/1.5 sans-serif;
      box-shadow: 0 4px 18px rgba(0,0,0,.5); display: none; }
    #ao3ph-panel h3 { margin: 0 0 6px; font-size: 14px; }
    #ao3ph-panel .ao3ph-flagitem { padding: 5px 6px; border-bottom: 1px solid #333; cursor: pointer; }
    #ao3ph-panel .ao3ph-flagitem:hover { background: #333; }
    #ao3ph-panel .ao3ph-dim { opacity: .65; }
    #ao3ph-panel button { margin-top: 8px; }
 
    #ao3ph-overlay { position: fixed; inset: 0; z-index: 1000000; background: rgba(0,0,0,.45);
      display: none; align-items: center; justify-content: center; }
    #ao3ph-dialog { width: 420px; max-width: 92vw; max-height: 85vh; overflow: auto;
      background: #242424; color: #eee; border-radius: 10px; padding: 16px;
      font: 14px/1.5 sans-serif; box-shadow: 0 6px 30px rgba(0,0,0,.6); }
    #ao3ph-dialog h2 { margin: 0 0 10px; font-size: 16px; }
    #ao3ph-dialog .ao3ph-chip { display: inline-flex; align-items: center; gap: 6px;
      background: #3a3a3a; border-radius: 12px; padding: 3px 10px; margin: 3px; }
    #ao3ph-dialog .ao3ph-chip button { background: none; border: none; color: #ff8a65;
      cursor: pointer; font-size: 14px; padding: 0; }
    #ao3ph-dialog input[type=text], #ao3ph-dialog input[type=number] {
      background: #111; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 5px 8px; }
    #ao3ph-dialog input[type=text] { width: 100%; box-sizing: border-box; }
    #ao3ph-dialog input[type=number] { width: 90px; }
    #ao3ph-dialog button.ao3ph-btn { background: #444; color: #fff; border: 1px solid #666;
      border-radius: 4px; padding: 5px 12px; cursor: pointer; }
    #ao3ph-dialog .ao3ph-preset { margin-left: 6px; cursor: pointer; color: #8ab4f8; }
    #ao3ph-dialog label { display: block; margin: 6px 0; }
    #ao3ph-dialog .ao3ph-row { margin: 12px 0; }
  `;
  document.head.appendChild(style);
 
  // Floating launcher + flags panel
  const launcher = document.createElement('button');
  launcher.id = 'ao3ph-launcher';
  launcher.className = 'ao3ph-ui';
  const launcherLabel = document.createElement('span');
  launcherLabel.textContent = '⚑';
  launcher.appendChild(launcherLabel);
  launcher.title = 'Proximity flags';
 
  const panel = document.createElement('div');
  panel.id = 'ao3ph-panel';
  panel.className = 'ao3ph-ui';
 
  launcher.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  });
 
  // Small badge at the top of the work when flags exist
  const badge = document.createElement('div');
  badge.id = 'ao3ph-badge';
  badge.className = 'ao3ph-ui';
  badge.style.display = 'none';
  badge.addEventListener('click', () => { panel.style.display = 'block'; });
 
  // Scrollbar heatmap rail
  const heatmap = document.createElement('div');
  heatmap.id = 'ao3ph-heatmap';
  heatmap.className = 'ao3ph-ui';
  heatmap.style.display = 'none';
 
  function renderPanel() {
    panel.textContent = '';
    const h = document.createElement('h3');
    h.textContent = `Proximity flags (≤ ${settings.proximity} words)`;
    panel.appendChild(h);
 
    if (!settings.enabled) {
      const d = document.createElement('div');
      d.className = 'ao3ph-dim';
      d.textContent = 'Highlighting is disabled in settings.';
      panel.appendChild(d);
    } else if (!settings.terms.length) {
      const d = document.createElement('div');
      d.className = 'ao3ph-dim';
      d.textContent = 'No watchlist terms yet — add some in settings.';
      panel.appendChild(d);
    } else if (!lastResult.flags.length) {
      const d = document.createElement('div');
      d.className = 'ao3ph-dim';
      d.textContent = `${lastResult.hits.length} hit(s), no proximity flags.`;
      panel.appendChild(d);
    } else {
      lastResult.flags.forEach(f => {
        const a = lastResult.hits[f.a], b = lastResult.hits[f.b];
        const item = document.createElement('div');
        item.className = 'ao3ph-flagitem';
        const main = document.createElement('div');
        main.textContent = `"${a.term}" ↔ "${b.term}"`;
        const sub = document.createElement('div');
        sub.className = 'ao3ph-dim';
        sub.textContent = `${f.dist} words apart`;
        item.appendChild(main);
        item.appendChild(sub);
        item.addEventListener('click', () => scrollToHit(f.a));
        panel.appendChild(item);
      });
    }
 
    const btn = document.createElement('button');
    btn.className = 'ao3ph-btn';
    btn.textContent = 'Settings…';
    btn.addEventListener('click', openSettings);
    panel.appendChild(btn);
  }
 
  /* ------------------------- Settings dialog ------------------------- */
 
  const overlay = document.createElement('div');
  overlay.id = 'ao3ph-overlay';
  overlay.className = 'ao3ph-ui';
  const dialog = document.createElement('div');
  dialog.id = 'ao3ph-dialog';
  overlay.appendChild(dialog);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });
 
  function openSettings() {
    renderDialog();
    overlay.style.display = 'flex';
  }
  function closeSettings() { overlay.style.display = 'none'; }
 
  function renderDialog() {
    dialog.textContent = '';
 
    const title = document.createElement('h2');
    title.textContent = 'Proximity Flags — Settings';
    dialog.appendChild(title);
 
    // Terms
    const termRow = document.createElement('div');
    termRow.className = 'ao3ph-row';
    const termLabel = document.createElement('div');
    termLabel.textContent = 'Watchlist (words or phrases):';
    termRow.appendChild(termLabel);
 
    const chipBox = document.createElement('div');
    settings.terms.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'ao3ph-chip';
      chip.appendChild(document.createTextNode(t));
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove';
      x.addEventListener('click', () => {
        settings.terms.splice(i, 1);
        saveSettings(); renderDialog(); scheduleRescan();
      });
      chip.appendChild(x);
      chipBox.appendChild(chip);
    });
    termRow.appendChild(chipBox);
 
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a word or phrase (* = Wildcard)';
    const addTerm = () => {
      const v = input.value.trim();
      if (!v) return;
      if (!v.replace(/\*/g, '').trim()) return; // reject wildcard-only terms
      if (!settings.terms.some(t => t.toLowerCase() === v.toLowerCase())) {
        settings.terms.push(v);
        saveSettings(); scheduleRescan();
      }
      input.value = '';
      renderDialog();
      const again = dialog.querySelector('input[type=text]');
      if (again) again.focus();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') addTerm(); });
    termRow.appendChild(input);
    const addBtn = document.createElement('button');
    addBtn.className = 'ao3ph-btn';
    addBtn.textContent = 'Add';
    addBtn.style.marginTop = '6px';
    addBtn.addEventListener('click', addTerm);
    termRow.appendChild(addBtn);
    dialog.appendChild(termRow);
 
    // Proximity
    const proxRow = document.createElement('div');
    proxRow.className = 'ao3ph-row';
    const proxLabel = document.createElement('label');
    proxLabel.textContent = 'Flag when two different terms appear within ';
    const proxInput = document.createElement('input');
    proxInput.type = 'number';
    proxInput.min = '1';
    proxInput.value = String(settings.proximity);
    proxInput.addEventListener('change', () => {
      const v = parseInt(proxInput.value, 10);
      if (Number.isFinite(v) && v > 0) { settings.proximity = v; saveSettings(); scheduleRescan(); }
    });
    proxLabel.appendChild(proxInput);
    proxLabel.appendChild(document.createTextNode(' words of each other:'));
    proxRow.appendChild(proxLabel);
    [250, 500, 1000, 2500].forEach(v => {
      const chip = document.createElement('span');
      chip.className = 'ao3ph-preset';
      chip.textContent = String(v);
      chip.addEventListener('click', () => {
        settings.proximity = v; saveSettings(); renderDialog(); scheduleRescan();
      });
      proxRow.appendChild(chip);
    });
    dialog.appendChild(proxRow);
 
    // Toggles
    const mkToggle = (labelText, key) => {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!settings[key];
      cb.addEventListener('change', () => {
        settings[key] = cb.checked; saveSettings(); scheduleRescan();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + labelText));
      return lab;
    };
    dialog.appendChild(mkToggle('Enabled', 'enabled'));
    dialog.appendChild(mkToggle('Highlight hits (yellow) and flags (red) in the text', 'showHighlights'));
    dialog.appendChild(mkToggle('Show heatmap along the scrollbar', 'heatmap'));
    dialog.appendChild(mkToggle('Whole words only (recommended)', 'wholeWords'));
    dialog.appendChild(mkToggle('Case sensitive', 'caseSensitive'));
 
    // Close
    const close = document.createElement('button');
    close.className = 'ao3ph-btn';
    close.textContent = 'Close';
    close.style.marginTop = '10px';
    close.addEventListener('click', closeSettings);
    dialog.appendChild(close);
  }
 
  /* ============================ Init ============================ */
 
  document.body.appendChild(launcher);
  document.body.appendChild(panel);
  document.body.appendChild(overlay);
  document.body.appendChild(heatmap);
  const workskin = document.getElementById('workskin');
  if (workskin) workskin.prepend(badge);
 
  // Register in the shared Userscripts dropdown (with a short retry in case
  // the menu library initializes after us).
  function initSharedMenu(attempts) {
    if (window.AO3MenuHelpers) {
      window.AO3MenuHelpers.addToSharedMenu({
        id: 'ao3ph_settings',
        text: 'Proximity Flags',
        onClick: openSettings,
      });
    } else if (attempts > 0) {
      setTimeout(() => initSharedMenu(attempts - 1), 500);
    }
  }
  initSharedMenu(10);
 
  rescan();
})();
