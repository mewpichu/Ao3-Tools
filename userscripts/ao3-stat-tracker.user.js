// ==UserScript==
// @name         AO3: Stat Tracker
// @namespace    mewpichu-ao3-stat-tracker
// @version      2.0
// @description  Records your work stats each time you visit your AO3 stats page, and charts them over time.
// @author       mewpichu
// @match        https://archiveofourown.org/users/*/stats*
// @match        https://archiveofourown.com/users/*/stats*
// @match        https://archiveofourown.net/users/*/stats*
// @match        https://archiveofourown.gay/users/*/stats*
// @match        https://ao3.org/users/*/stats*
// @match        https://archive.transformativeworks.org/users/*/stats*
// @match        https://insecure.archiveofourown.org/users/*/stats*
// @match        https://archiveofourown.org/*/stats?*
// @match        https://archiveofourown.com/*/stats?*
// @match        https://archiveofourown.net/*/stats?*
// @match        https://archiveofourown.gay/*/stats?*
// @match        https://ao3.org/*/stats?*
// @match        https://archive.transformativeworks.org/*/stats?*
// @match        https://insecure.archiveofourown.org/*/stats?*
// @require      https://update.greasyfork.org/scripts/552743/1859007/AO3%3A%20Menu%20Helpers%20Library.js?v=2.3.0
// @grant        none
// @license      MIT
// @run-at       document-end
// ==/UserScript==
 
(function () {
  'use strict';
 
  /* ============================ Config ============================ */
 
  // Stack order in the chart, bottom -> top
  const STAT_KEYS = ['hits', 'kudos', 'comments', 'bookmarks', 'subscriptions'];
 
  const COLORS = {
    hits:          '#f08c00', // orange
    kudos:         '#e03131', // red
    comments:      '#1971c2', // blue
    bookmarks:     '#2f9e44', // green
    subscriptions: '#7048e8', // purple
    userSubscriptions: '#d6336c', // pink
  };
 
  const LABELS = {
    hits: 'Hits',
    kudos: 'Kudos',
    comments: 'Comments',
    bookmarks: 'Bookmarks',
    subscriptions: 'Subscriptions',
    userSubscriptions: 'User Subs',
  };
 
  // The User Stats view stacks user subscriptions as a 6th stat on top
  const USER_STATS = [...STAT_KEYS, 'userSubscriptions'];
 
  function activeStats() {
    return state.selectedWork === 'user' ? USER_STATS : STAT_KEYS;
  }
 
  const Y_AXIS_PAD = 0.1;
 
  const RANGES = {
    all:   'All time',
    '7d':  'Last 7 days',
    '30d': 'Last 30 days',
    '60d': 'Last 60 days',
    month: 'Current month',
    year:  'Current year',
  };
 
  // Persistent UI preferences (survives page refresh)
  const PREF_DEFAULTS = {
    selectedWork: 'user',
    mode: 'cumulative',
    smallerHits: false,
    range: 'all',
    dark: false,
    hiddenStats: [],
    ignoredFirstDays: [],
  };
 
  let state = Object.assign({}, PREF_DEFAULTS);
 
  function prefsKey(username) { return 'ao3StatTracker.prefs.' + username; }
 
  function loadPrefs(username) {
    try {
      const raw = localStorage.getItem(prefsKey(username));
      if (raw) {
        const prefs = JSON.parse(raw);
        if ('smallerKudos' in prefs && !('smallerHits' in prefs)) {
          prefs.smallerHits = prefs.smallerKudos;
          delete prefs.smallerKudos;
        }
        const merged = Object.assign({}, PREF_DEFAULTS, prefs);
        if (merged.selectedWork === 'all') merged.selectedWork = 'user'; // All Works view removed
        return merged;
      }
    } catch (e) { /* fall through to defaults */ }
    return Object.assign({}, PREF_DEFAULTS);
  }
 
  function savePrefs() {
    const username = getUsername();
    if (!username) return;
    try {
      localStorage.setItem(prefsKey(username), JSON.stringify(state));
    } catch (e) { /* non-fatal */ }
  }
 
  /* ============================ Date Helpers ============================ */
 
  // All UTC to avoid daylight savings shenanigans
 
  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
 
  function todayKey() { return dateKey(new Date()); }
 
  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
 
  function addDays(key, n) {
    const d = new Date(parseKey(key) + n * 86400000);
    return d.toISOString().slice(0, 10);
  }
 
  function daysBetween(a, b) {
    return Math.round((parseKey(b) - parseKey(a)) / 86400000);
  }
 
   /* ============================ Storage ============================ */
 
  function getUsername() {
    const m = location.pathname.match(/^\/users\/([^/]+)\/stats/);
    return m ? m[1] : null;
  }
 
  function storageKey(username) {
    return 'ao3StatTracker.v1.' + username;
  }
 
  const hasCompression = typeof CompressionStream !== 'undefined' &&
                         typeof DecompressionStream !== 'undefined';
 
  function compressText(text, cb) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    new Response(stream).arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      cb(btoa(bin));
    }).catch((e) => {
      console.error('[AO3 Stat Tracker] compression failed:', e);
      cb(null);
    });
  }
 
  function decompressText(b64, cb) {
    let bytes;
    try {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      console.error('[AO3 Stat Tracker] bad base64 in stored data:', e);
      return cb(null);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    new Response(stream).text()
      .then((text) => cb(text))
      .catch((e) => {
        console.error('[AO3 Stat Tracker] decompression failed:', e);
        cb(null);
      });
  }
 
  const STORAGE_PREFIX = 'def1:';
  // Fixed array order for compact day records. userSubscriptions/words only
  // appear in user totals. Works just store 0 in those slots.
  const COMPACT_KEYS = ['hits', 'kudos', 'comments', 'bookmarks', 'subscriptions', 'userSubscriptions', 'words'];
 
  let cache = { username: null, data: null };
 
  function toCompact(data) {
    const out = { works: {}, userTotals: {} };
    for (const id in data.works) {
      const w = data.works[id];
      const scopes = {};
      for (const scope in (w.scopes || {})) {
        scopes[scope] = {};
        for (const d in w.scopes[scope]) {
          const st = w.scopes[scope][d];
          scopes[scope][d] = COMPACT_KEYS.map((k) => st[k] || 0);
        }
      }
      out.works[id] = { t: w.title, s: scopes };
    }
    for (const scope in (data.userTotals || {})) {
      out.userTotals[scope] = {};
      for (const d in data.userTotals[scope]) {
        const st = data.userTotals[scope][d];
        out.userTotals[scope][d] = COMPACT_KEYS.map((k) => st[k] || 0);
      }
    }
    return out;
  }
 
  function fromCompact(c) {
    const out = { works: {}, userTotals: {} };
    for (const id in (c.works || {})) {
      const scopes = {};
      for (const scope in (c.works[id].s || {})) {
        scopes[scope] = {};
        for (const d in c.works[id].s[scope]) {
          const arr = c.works[id].s[scope][d];
          const st = {};
          COMPACT_KEYS.forEach((k, i) => { st[k] = arr[i] || 0; });
          scopes[scope][d] = st;
        }
      }
      out.works[id] = { title: c.works[id].t, scopes };
    }
    for (const scope in (c.userTotals || {})) {
      out.userTotals[scope] = {};
      for (const d in c.userTotals[scope]) {
        const st = {};
        c.userTotals[scope][d].forEach((v, i) => { st[COMPACT_KEYS[i]] = v || 0; });
        out.userTotals[scope][d] = st;
      }
    }
    return out;
  }
 
  /* ============================ Sync ============================ */
 
  const SYNC_CELL_LIMIT = 47000;
 
  function syncStorageKey(username) {
    return 'ao3StatTracker.sync.' + username;
  }
 
  // newest-first unique list of every date present in a compact data object
  function compactDatesDesc(compact) {
    const set = new Set();
    for (const id in compact.works) {
      for (const scope in compact.works[id].s) {
        for (const d in compact.works[id].s[scope]) set.add(d);
      }
    }
    for (const scope in compact.userTotals) {
      for (const d in compact.userTotals[scope]) set.add(d);
    }
    return [...set].sort().reverse();
  }
 
  function trimCompactToCutoff(compact, cutoff) {
    const out = { works: {}, userTotals: {} };
    for (const id in compact.works) {
      const scopes = {};
      for (const scope in compact.works[id].s) {
        const days = {};
        for (const d in compact.works[id].s[scope]) {
          if (d >= cutoff) days[d] = compact.works[id].s[scope][d];
        }
        if (Object.keys(days).length) scopes[scope] = days;
      }
      if (Object.keys(scopes).length) out.works[id] = { t: compact.works[id].t, s: scopes };
    }
    for (const scope in compact.userTotals) {
      const days = {};
      for (const d in compact.userTotals[scope]) {
        if (d >= cutoff) days[d] = compact.userTotals[scope][d];
      }
      if (Object.keys(days).length) out.userTotals[scope] = days;
    }
    return out;
  }
 
  // Write the sync key with as much recent data as fits. Estimates how much
  // of the timeline to keep, trims the oldest days, and retries if needed.
  function persistSyncData(compact) {
    const username = cache.username;
    if (!username || !hasCompression) return;
    const attempt = (obj, rounds) => {
      compressText(JSON.stringify(obj), (b64) => {
        if (!b64) return;
        if (b64.length <= SYNC_CELL_LIMIT || rounds >= 6) {
          try {
            localStorage.setItem(syncStorageKey(username), STORAGE_PREFIX + b64);
            console.log('[AO3 Stat Tracker] sync key saved:', (b64.length + STORAGE_PREFIX.length).toLocaleString(), 'chars');
          } catch (e) {
            console.warn('[AO3 Stat Tracker] Could not save sync key:', e);
          }
          return;
        }
        const dates = compactDatesDesc(obj);
        if (!dates.length) return;
        const keep = Math.max(1, Math.floor(dates.length * (SYNC_CELL_LIMIT / b64.length) * 0.9));
        const cutoff = dates[Math.min(dates.length - 1, keep - 1)]; // keep days >= cutoff
        attempt(trimCompactToCutoff(obj, cutoff), rounds + 1);
      });
    };
    attempt(compact, 0);
  }
 
  // Merge the sync key into the big key. Runs on page load, and again when
  // the popup opens if the sync key changed since the last merge.
  let lastSyncRaw = null;
  function mergeFromSync(username, cb) {
    if (!hasCompression) return cb();
    let raw = null;
    try { raw = localStorage.getItem(syncStorageKey(username)); } catch (e) { /* ignore */ }
    if (!raw || !raw.startsWith(STORAGE_PREFIX)) return cb();
    if (raw === lastSyncRaw) return cb(); // unchanged since last merge
    lastSyncRaw = raw;
    decompressText(raw.slice(STORAGE_PREFIX.length), (text) => {
      let res = { added: 0, updated: 0 };
      try {
        if (text) res = mergeSyncData(cache.data, fromCompact(JSON.parse(text)));
      } catch (e) { /* corrupt sync data: ignore it */ }
      if (res.added > 0 || res.updated > 0) {
        persistData();
        const parts = [];
        if (res.added) parts.push(`${res.added} new day${res.added === 1 ? '' : 's'}`);
        if (res.updated) parts.push(`${res.updated} updated`);
        showToast(`Stat Tracker: pulled ${parts.join(', ')} from sync.`);
      }
      cb();
    });
  }
 
  // Like mergeImport, but built for sync data. When the SAME day exists in
  // both keys, each stat keeps the HIGHER value instead of skipping the
  // day.
  function mergeSyncData(data, syncData) {
    let added = 0, updated = 0;
    if (!syncData || typeof syncData !== 'object') return { added, updated };
 
    const mergeDaysMax = (targetScopeObj, syncScopeObj) => {
      for (const day in syncScopeObj) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const stats = cleanStats(syncScopeObj[day]);
        if (!stats) continue;
        const existing = targetScopeObj[day];
        if (!existing) { targetScopeObj[day] = stats; added++; continue; }
        let bumped = false;
        for (const k in stats) {
          if (typeof existing[k] !== 'number' || stats[k] > existing[k]) {
            existing[k] = stats[k];
            bumped = true;
          }
        }
        if (bumped) updated++;
      }
    };
 
    const works = syncData.works || {};
    for (const id in works) {
      const w = works[id];
      if (!w || typeof w !== 'object' || !w.scopes) continue;
      if (!/^\d+$/.test(String(id))) continue; // sync data always uses numeric work ids
      if (!data.works[id]) data.works[id] = { title: w.title || 'Work ' + id, scopes: {} };
      if (w.title && !data.works[id].title) data.works[id].title = w.title;
      for (const scope in w.scopes) {
        if (!w.scopes[scope] || typeof w.scopes[scope] !== 'object') continue;
        if (!data.works[id].scopes[scope]) data.works[id].scopes[scope] = {};
        mergeDaysMax(data.works[id].scopes[scope], w.scopes[scope]);
      }
    }
 
    const totals = syncData.userTotals || {};
    for (const scope in totals) {
      if (!totals[scope] || typeof totals[scope] !== 'object') continue;
      if (!data.userTotals[scope]) data.userTotals[scope] = {};
      mergeDaysMax(data.userTotals[scope], totals[scope]);
    }
 
    return { added, updated };
  }
 
  // Purge dupes caused by some shenanigans in an older build
  function purgeYearScopes(data) {
    let removed = 0;
    for (const id in data.works) {
      const scopes = data.works[id].scopes || {};
      for (const scope in scopes) {
        if (scope === 'all') continue;
        removed += Object.keys(scopes[scope]).length;
        delete scopes[scope];
      }
    }
    for (const scope in data.userTotals) {
      if (scope === 'all') continue;
      removed += Object.keys(data.userTotals[scope]).length;
      delete data.userTotals[scope];
    }
    if (removed > 0) {
      console.log(`[AO3 Stat Tracker] purged ${removed} duplicate year-view record(s).`);
      persistData();
    }
  }
 
  // As of v2.0 the big history key lives in IndexedDB. Prefs and the
  // sync key stay in localStorage.
  const IDB_NAME = 'ao3StatTracker';
  const IDB_VERSION = 1;
  const IDB_STORE = 'history';
  const IDB_SCHEMA = 1;
 
  let idbPromise = null;
 
  function idbOpen() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB not available'));
      let req;
      try { req = indexedDB.open(IDB_NAME, IDB_VERSION); }
      catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); idbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    idbPromise.catch(() => { idbPromise = null; });
    return idbPromise;
  }
 
  // Resolves on commit
  function idbRequest(mode, fn) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      let result;
      req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || req.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    }));
  }
 
  const idbGet = (key) => idbRequest('readonly', (store) => store.get(key));
  const idbPut = (key, value) => idbRequest('readwrite', (store) => store.put(value, key));
  const idbDelete = (key) => idbRequest('readwrite', (store) => store.delete(key));
 
  /* ============================ Legacy localstorage ============================ */
  // Reads the pre-v2 big key. cb receives { status, data }:
  //   'empty'       nothing stored
  //   'ok'          parsed successfully
  //   'unreadable'  something is there but can't be read
  function readLegacyLocal(username, cb) {
    const unreadable = { status: 'unreadable', data: null };
    let raw = null;
    try { raw = localStorage.getItem(storageKey(username)); } catch (e) { /* ignore */ }
    if (!raw) return cb({ status: 'empty', data: null });
 
    if (raw.startsWith(STORAGE_PREFIX)) {
      if (!hasCompression) {
        console.error('[AO3 Stat Tracker] Stored data is compressed but this browser has no ' +
          'CompressionStream. Your data was NOT deleted.');
        return cb(unreadable);
      }
      decompressText(raw.slice(STORAGE_PREFIX.length), (text) => {
        let data = null;
        try { data = text ? fromCompact(JSON.parse(text)) : null; } catch (e) { data = null; }
        cb(data ? { status: 'ok', data } : unreadable);
      });
      return;
    }
 
    if (raw.startsWith('lzma1:')) {
      console.error('[AO3 Stat Tracker] Stored data is in the old LZMA format, which this build cannot read. ' +
        'Your data was NOT deleted. Import a JSON export.');
      return cb(unreadable);
    }
 
    // legacy plain JSON
    let data;
    try { data = JSON.parse(raw); } catch (e) { return cb(unreadable); }
    if (!data || typeof data !== 'object') return cb(unreadable);
    const sampleWork = data.works && data.works[Object.keys(data.works)[0]];
    if (sampleWork && sampleWork.s && !sampleWork.scopes) {
      try { data = fromCompact(data); } catch (e) { return cb(unreadable); }
    }
    cb({ status: 'ok', data });
  }
 
  // One-time migration from localStorage to IndexedDB. Only called when IndexedDB
  // has NO record. The old localStorage key remains as a backup.
  function migrateFromLocal(username, finish) {
    readLegacyLocal(username, ({ status, data }) => {
      if (status === 'empty') return finish(null, 'idb', false);
      if (status === 'unreadable') return finish(null, 'idb', true);
 
      const compact = toCompact(data);
      const expected = JSON.stringify(compact);
      idbPut(username, { schema: IDB_SCHEMA, data: compact, savedAt: new Date().toISOString() })
        .then(() => idbGet(username))
        .then((check) => !!check && JSON.stringify(check.data) === expected)
        .catch((e) => { console.warn('[AO3 Stat Tracker] migration error:', e); return false; })
        .then((ok) => {
          if (ok) {
            console.log('[AO3 Stat Tracker] Migrated data to IndexedDB. Old localStorage copy kept as a backup.');
            finish(data, 'idb', false);
            return;
          }
          console.warn('[AO3 Stat Tracker] Migration could not be verified. Staying on localStorage for now.');
          idbDelete(username).catch(() => {}).then(() => finish(data, 'local', false));
        });
    });
  }
 
  /* ============================ Load + Save ============================ */
 
  // Data is loaded once per page load (async) and then served from memory.
  let loadWaiters = null;
 
  function prepareData(username, cb) {
    if (cache.username === username && cache.data) return cb(cache.data);
    if (loadWaiters) { loadWaiters.push(cb); return; }
    loadWaiters = [cb];
 
    const done = () => {
      const waiters = loadWaiters;
      loadWaiters = null;
      waiters.forEach((fn) => fn(cache.data));
    };
 
    const finish = (data, backend, readOnly) => {
      data = data || {};
      data.works = data.works || {};
      data.userTotals = data.userTotals || {};
      cache = { username, data, backend, readOnly: !!readOnly };
      if (readOnly) return done();
      mergeFromSync(username, () => {
        purgeYearScopes(cache.data);
        let syncRaw = null;
        try { syncRaw = localStorage.getItem(syncStorageKey(username)); } catch (e) { /* ignore */ }
        if (!syncRaw) persistData();
        done();
      });
    };
 
    idbOpen().then(() => idbGet(username)).then((record) => {
      if (record !== undefined) {
        // Already in IndexedDB. Never migrate again, even if the record is
        // empty.
        let data;
        try { data = fromCompact(record.data || {}); }
        catch (e) {
          console.error('[AO3 Stat Tracker] IndexedDB record is unreadable. Not overwriting it.', e);
          return finish(null, 'idb', true);
        }
        return finish(data, 'idb', false);
      }
      migrateFromLocal(username, finish);
    }, (err) => {
      console.warn('[AO3 Stat Tracker] IndexedDB unavailable, using localStorage:', err);
      readLegacyLocal(username, ({ status, data }) => finish(data, 'local', status === 'unreadable'));
    });
  }
 
  let saving = false;
  let saveQueued = false;
 
  function persistData() {
    const username = cache.username;
    if (!username || !cache.data || cache.readOnly) return;
    if (saving) { saveQueued = true; return; }
    saving = true;
 
    const done = () => {
      saving = false;
      if (saveQueued) { saveQueued = false; persistData(); }
    };
    const compact = toCompact(cache.data);
 
    if (cache.backend === 'idb') {
      idbPut(username, { schema: IDB_SCHEMA, data: compact, savedAt: new Date().toISOString() })
        .then(
          () => console.log('[AO3 Stat Tracker] saved to IndexedDB.'),
          (e) => console.warn('[AO3 Stat Tracker] Could not save to IndexedDB:', e)
        )
        .then(() => {
          persistSyncData(compact);
          done();
        });
      return;
    }
 
    // localStorage fallback (only when IndexedDB is unavailable)
    if (!hasCompression) {
      try { localStorage.setItem(storageKey(username), JSON.stringify(cache.data)); }
      catch (e) { console.warn('[AO3 Stat Tracker] Could not save:', e); }
      return done();
    }
    compressText(JSON.stringify(compact), (b64) => {
      if (b64) {
        try {
          localStorage.setItem(storageKey(username), STORAGE_PREFIX + b64);
          console.log('[AO3 Stat Tracker] big key saved:', (b64.length + STORAGE_PREFIX.length).toLocaleString(), 'chars');
        } catch (e) {
          console.warn('[AO3 Stat Tracker] Could not save:', e);
        }
        persistSyncData(compact);
      }
      done();
    });
  }
 
  /* ============================ Scrape ============================ */
 
  function parseNum(text) {
    if (!text) return 0;
    const n = parseInt(String(text).replace(/[^\d-]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }
 
  function getScope() {
    const current = document.querySelector('ol.year .current');
    if (current) {
      const text = current.textContent.trim();
      return /^\d{4}$/.test(text) ? text : 'all';
    }
    const year = new URLSearchParams(location.search).get('year');
    return year && /^\d{4}$/.test(year) ? year : 'all';
  }
 
  // Each work is an <li> under <ul class="statistics index group"> holding
  // a /works/ link and a <dl class="stats"> whose <dd> values are classed
  // by stat name (dd.hits, dd.kudos, dd.comments, dd.bookmarks,
  // dd.subscriptions). In Fandoms View a work appears once per fandom, so
  // dedupe by work ID.
  function scrapeWorks() {
    const works = [];
    const seen = new Set();
    const items = document.querySelectorAll('ul.statistics.index li');
 
    for (const li of items) {
      const link = li.querySelector('a[href*="/works/"]');
      const dl = li.querySelector('dl.stats');
      if (!link || !dl) continue;
      const idMatch = link.getAttribute('href').match(/\/works\/(\d+)/);
      if (!idMatch || seen.has(idMatch[1])) continue;
      seen.add(idMatch[1]);
 
      const read = (cls) => {
        const dd = dl.querySelector('dd.' + cls);
        return dd ? parseNum(dd.textContent) : 0;
      };
 
      const wordsSpan = li.querySelector('.words');
      works.push({
        id: idMatch[1],
        title: link.textContent.trim(),
        stats: {
          kudos:         read('kudos'),
          comments:      read('comments'),
          bookmarks:     read('bookmarks'),
          hits:          read('hits'),
          subscriptions: read('subscriptions'),
          words:         wordsSpan ? parseNum(wordsSpan.textContent) : 0,
        },
      });
    }
    return works;
  }
 
  // The user-level totals are a <dl class="statistics meta group"> of
  // <dt>Label:</dt><dd>number</dd> pairs. Matched by exact label text so
  // "User Subscriptions" never collides with work "Subscriptions".
  function scrapeUserTotals() {
    const dl = document.querySelector('dl.statistics.meta');
    if (!dl) return null;
    const labels = {
      'kudos': 'kudos',
      'comments': 'comments',
      'comment threads': 'comments',
      'bookmarks': 'bookmarks',
      'hits': 'hits',
      'subscriptions': 'subscriptions',
      'word count': 'words',
      'user subscriptions': 'userSubscriptions',
    };
    const totals = {};
    let matched = 0;
 
    for (const dt of dl.querySelectorAll('dt')) {
      const label = dt.textContent.trim().toLowerCase().replace(/:$/, '');
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== 'DD') continue;
      if (labels[label]) {
        totals[labels[label]] = parseNum(dd.textContent);
        matched++;
      }
    }
    return matched >= 2 ? totals : null;
  }
 
  function statsEqual(a, b) {
    if (!a || !b) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
    return true;
  }
 
  // Most recent non-zero word count recorded for a work (0 if none yet).
  // Word count only changes when chapters are edited, so the last known
  // total is fine for a stand-in on year tabs, which don't show the real one.
  function lastKnownWords(workEntry) {
    const days = (workEntry.scopes && workEntry.scopes.all) || {};
    const dates = Object.keys(days).sort().reverse();
    for (const d of dates) {
      if (days[d] && days[d].words) return days[d].words;
    }
    return 0;
  }
 
  function recordSnapshot() {
    const username = getUsername();
    if (!username) return;
 
    const scope = getScope();
    const works = scrapeWorks();
    const totals = scrapeUserTotals();
    if (!works.length && !totals) return; // not a recognizable stats page
 
    prepareData(username, (data) => recordSnapshotInto(username, data, scope, works, totals));
  }
 
  function recordSnapshotInto(username, data, scope, works, totals) {
    const today = todayKey();
    let changed = false;
 
    for (const work of works) {
      if (!data.works[work.id]) data.works[work.id] = { title: work.title, scopes: {} };
      data.works[work.id].title = work.title; // keep the title fresh
      if (!data.works[work.id].scopes.all) data.works[work.id].scopes.all = {};
      const existing = data.works[work.id].scopes.all[today];
      if (scope !== 'all') {
        work.stats.words = (existing && existing.words) || lastKnownWords(data.works[work.id]);
      }
      // One snapshot per work per day. Overwrite, never append, and skip
      // the write entirely if nothing has changed.
      if (!statsEqual(existing, work.stats)) {
        data.works[work.id].scopes.all[today] = work.stats;
        changed = true;
      }
    }
 
    // The Totals box is only a true user-wide total on the All Years view.
    // On a year tab AO3 sums just the works listed there (and the word
    // count is year-scoped), so recording it would corrupt the series.
    if (totals && scope === 'all') {
      if (!data.userTotals.all) data.userTotals.all = {};
      if (!statsEqual(data.userTotals.all[today], totals)) {
        data.userTotals.all[today] = totals;
        changed = true;
      }
    }
 
    if (changed) {
      persistData();
      showToast(
        `Stat Tracker: recorded ${works.length} work${works.length === 1 ? '' : 's'}` +
        ` (${scope === 'all' ? 'All Years' : scope} view).`
      );
    } else {
      showToast('Stat Tracker: no changes since earlier today.');
    }
  }
 
  /* ============================ Series ============================ */
 
  // Earliest date recorded for any work
  function firstTrackedDate(data) {
    let min = null;
    for (const id in data.works) {
      const days = (data.works[id].scopes && data.works[id].scopes.all) || {};
      for (const d in days) {
        if (!min || d < min) min = d;
      }
    }
    return min;
  }
 
  // Daily-series math for one set of day snapshots (a work, or the user totals)
  function buildDaySeries(days, mode, keys, trackingStart, skipFirst) {
    let dates = Object.keys(days).sort();
    if (skipFirst) {
      // Pretend tracking started on day two
      dates = dates.slice(1);
      trackingStart = null;
    }
    const result = new Map();
    if (!dates.length) return result;
 
    if (mode === 'cumulative') {
      // Gaps between recorded days ramp up by linear interpolation instead
      // of holding flat and jumping on the next recorded day
      let prev = null;
      for (const d of dates) {
        if (prev === null) {
          result.set(d, Object.assign({}, days[d]));
        } else {
          const n = Math.max(1, daysBetween(prev, d));
          for (let i = 1; i <= n; i++) {
            const k = addDays(prev, i);
            const step = {};
            for (const s of keys) {
              const gain = (days[d][s] || 0) - (days[prev][s] || 0);
              step[s] = (days[prev][s] || 0) + (gain * i) / n;
            }
            result.set(k, step);
          }
        }
        prev = d;
      }
    } else {
      let prev = null;
      for (const d of dates) {
        if (prev === null) {
          if (trackingStart && d > trackingStart) {
            const portion = {};
            for (const s of keys) portion[s] = Math.max(0, days[d][s] || 0);
            result.set(d, portion);
          }
        } else {
          const n = Math.max(1, daysBetween(prev, d));
          for (let i = 1; i <= n; i++) {
            const k = addDays(prev, i);
            const portion = {};
            for (const s of keys) {
              const gain = (days[d][s] || 0) - (days[prev][s] || 0);
              portion[s] = Math.max(0, gain) / n;
            }
            result.set(k, portion);
          }
        }
        prev = d;
      }
    }
    return result;
  }
 
  // Per-work daily series
  function buildWorkSeries(work, mode, trackingStart, skipFirst) {
    return buildDaySeries((work.scopes && work.scopes.all) || {}, mode, STAT_KEYS, trackingStart, skipFirst);
  }
 
  // User totals daily series, with user subscriptions as the 6th stat
  function buildUserSeries(data, mode, skipFirst) {
    const totalsDays = (data.userTotals && data.userTotals.all) || {};
    const firstTotals = Object.keys(totalsDays).sort()[0];
    const days = {};
    for (const d in totalsDays) days[d] = totalsDays[d];
 
    const sums = new Map();
    for (const id in data.works) {
      const series = buildDaySeries((data.works[id].scopes && data.works[id].scopes.all) || {}, 'cumulative', STAT_KEYS, null);
      for (const [k, v] of series) {
        if (firstTotals && k >= firstTotals) continue; // real totals take over from here
        if (!sums.has(k)) sums.set(k, { hits: 0, kudos: 0, comments: 0, bookmarks: 0, subscriptions: 0 });
        const bucket = sums.get(k);
        for (const s of STAT_KEYS) bucket[s] += v[s] || 0;
      }
    }
    const firstSubs = firstTotals ? (totalsDays[firstTotals].userSubscriptions || 0) : 0;
    for (const [k, v] of sums) {
      if (!days[k]) days[k] = Object.assign({ userSubscriptions: firstSubs }, v);
    }
 
    return buildDaySeries(days, mode, USER_STATS, firstTrackedDate(data), skipFirst);
  }
 
  // Restrict a finished series to the selected date range. Applied AFTER
  // series building so gap-filling math is unaffected by the range.
  function filterByRange(series, range) {
    if (range === 'all') return series;
    const today = todayKey();
    let start;
    if (range === '7d') start = addDays(today, -6);
    else if (range === '30d') start = addDays(today, -29);
    else if (range === '60d') start = addDays(today, -59);
    else if (range === 'month') start = today.slice(0, 8) + '01';
    else if (range === 'year') start = today.slice(0, 4) + '-01-01';
    else return series;
 
    const out = new Map();
    for (const [k, v] of series) {
      if (k >= start && k <= today) out.set(k, v);
    }
    return out;
  }
 
  // Return a copy of the series with hits at 1/10 scale for bar heights.
  // Tooltips still show the unscaled series.
  function scaleHits(series) {
    const out = new Map();
    for (const [k, v] of series) {
      out.set(k, Object.assign({}, v, { hits: (v.hits || 0) / 10 }));
    }
    return out;
  }
 
  /* ============================ UI ============================ */
 
  const CSS = `
    #ao3st-overlay {
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: center; justify-content: center;
      font-family: "Lucida Grande", "Lucida Sans Unicode", sans-serif;
    }
    #ao3st-panel {
      background: #ffffff; color: #222222;
      width: 94vw; height: 92vh; border-radius: 6px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
      font: 14px/1.45 "Lucida Grande", "Lucida Sans Unicode", sans-serif;
    }
    #ao3st-header {
      display: flex; flex-direction: column; gap: 0.45em;
      padding: 0.7em 1.1em; border-bottom: 1px solid #dddddd; background: #ffffff;
    }
    #ao3st-header h2 { margin: 0.1em 0; font-size: 18px; color: #900000; }
    #ao3st-header .ao3st-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em; }
    #ao3st-header .ao3st-row-split { justify-content: space-between; }
    #ao3st-header .ao3st-group { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5em; }
    #ao3st-header label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
    #ao3st-header select {
      font-size: 13px; padding: 5px 8px; max-width: 300px;
      border: 1px solid #bbbbbb; border-radius: 3px; background: #ffffff; color: #222222;
      font-family: inherit;
    }
    /* buttons, ported from the library script's .lib-btn: flat, no shadow,
       one uniform stronger hover tint for every button */
    #ao3st-header button,
    .ao3st-seg button {
      padding: 5px 12px; margin: 2px;
      border: 1px solid #999999; border-radius: 3px;
      background: #f2f2f2; color: #222222; cursor: pointer;
      font-size: 13px; font-family: inherit;
      box-shadow: none;
    }
    #ao3st-header button:hover,
    .ao3st-seg button:hover { background: #d0d0d0; }
    .ao3st-seg { display: inline-flex; }
    /* ID-scoped so it beats the flat "#ao3st-header button" base/hover rules */
    #ao3st-header .ao3st-seg button.active,
    #ao3st-header .ao3st-seg button.active:hover {
      background: #900000; border-color: #900000; color: #ffffff;
    }
    #ao3st-legend {
      display: flex; flex-wrap: wrap; gap: 14px;
      padding: 8px 16px; border-bottom: 1px solid #eeeeee; font-size: 13px;
    }
    .ao3st-chip { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .ao3st-chip.ao3st-off { color: #999999; text-decoration: line-through; }
    .ao3st-chip.ao3st-off .ao3st-swatch { background: #bbbbbb !important; }
    #ao3st-panel.ao3st-dark .ao3st-chip.ao3st-off { color: #77777e; }
    #ao3st-panel.ao3st-dark .ao3st-chip.ao3st-off .ao3st-swatch { background: #55555e !important; }
    .ao3st-swatch { width: 12px; height: 12px; border-radius: 2px; display: inline-block; }
    #ao3st-chartwrap { flex: 1 1 auto; overflow: hidden; padding: 12px 16px; }
    #ao3st-footer {
      padding: 8px 16px; border-top: 1px solid #dddddd;
      font-size: 12px; color: #777777; background: #ffffff;
    }
    #ao3st-empty {
      padding: 40px; text-align: center; color: #777777; font-size: 13px;
      font-style: italic; line-height: 1.7;
    }
    #ao3st-tooltip {
      position: fixed; z-index: 100000; pointer-events: none; display: none;
      background: rgba(30, 30, 30, 0.95); color: #ffffff; font-size: 12px;
      padding: 8px 10px; border-radius: 4px; line-height: 1.5; max-width: 260px;
      font-family: "Lucida Grande", "Lucida Sans Unicode", sans-serif;
    }
    #ao3st-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #2a2a2a; color: #ffffff; font-size: 13px;
      padding: 8px 16px; border-radius: 4px; opacity: 0; transition: opacity 0.2s;
      pointer-events: none; z-index: 100000;
      font-family: "Lucida Grande", "Lucida Sans Unicode", sans-serif;
    }
 
    /* ---- dark mode (ported from the library script's .lib-dark) ---- */
    #ao3st-panel.ao3st-dark { background: #232329; color: #e4e4e8; }
    #ao3st-panel.ao3st-dark #ao3st-header { background: #232329; border-bottom-color: #3a3a41; }
    #ao3st-panel.ao3st-dark #ao3st-header h2 { color: #e08080; }
    #ao3st-panel.ao3st-dark #ao3st-header select {
      background: #2e2e35; border-color: #55555e; color: #e4e4e8;
    }
    #ao3st-panel.ao3st-dark #ao3st-header button,
    #ao3st-panel.ao3st-dark .ao3st-seg button {
      background: #3a3a41; border-color: #55555e; color: #e4e4e8;
    }
    #ao3st-panel.ao3st-dark #ao3st-header button:hover,
    #ao3st-panel.ao3st-dark .ao3st-seg button:hover { background: #50505a; }
    #ao3st-panel.ao3st-dark #ao3st-header .ao3st-seg button.active,
    #ao3st-panel.ao3st-dark #ao3st-header .ao3st-seg button.active:hover {
      background: #a31212; border-color: #a31212; color: #ffffff;
    }
    #ao3st-panel.ao3st-dark #ao3st-legend { border-bottom-color: #3a3a41; }
    #ao3st-panel.ao3st-dark #ao3st-footer {
      background: #232329; border-top-color: #3a3a41; color: #9a9aa2;
    }
    #ao3st-panel.ao3st-dark #ao3st-empty { color: #9a9aa2; }
 
    /* ---- manage data popup ---- */
    #ao3st-manage-overlay {
      position: fixed; inset: 0; z-index: 100001;
      background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: center; justify-content: center;
      font-family: "Lucida Grande", "Lucida Sans Unicode", sans-serif;
    }
    #ao3st-manage-panel {
      background: #ffffff; color: #222222;
      width: min(760px, 94vw); height: 88vh; border-radius: 6px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
      font: 14px/1.45 "Lucida Grande", "Lucida Sans Unicode", sans-serif;
    }
    #ao3st-manage-header {
      display: flex; align-items: center; gap: 10px;
      padding: 0.7em 1.1em; border-bottom: 1px solid #dddddd; background: #ffffff;
    }
    #ao3st-manage-header h2 { margin: 0; font-size: 18px; color: #900000; flex: 0 0 auto; }
    #ao3st-manage-filter {
      flex: 1 1 auto; min-width: 0; font-size: 13px; padding: 5px 8px;
      border: 1px solid #bbbbbb; border-radius: 3px; background: #ffffff; color: #222222;
      font-family: inherit;
    }
    #ao3st-manage-close {
      padding: 5px 12px; border: 1px solid #999999; border-radius: 3px;
      background: #f2f2f2; color: #222222; cursor: pointer;
      font-size: 13px; font-family: inherit;
    }
    #ao3st-manage-close:hover { background: #d0d0d0; }
    #ao3st-manage-body { flex: 1 1 auto; overflow-y: auto; padding: 10px 16px; }
    .ao3st-manage-work { border: 1px solid #dddddd; border-radius: 4px; margin-bottom: 8px; }
    .ao3st-manage-work > summary {
      display: flex; align-items: center; gap: 8px; cursor: pointer;
      padding: 8px 10px; list-style: none;
    }
    .ao3st-manage-work > summary::-webkit-details-marker { display: none; }
    .ao3st-manage-work > summary::before { content: '\\25B8'; flex: 0 0 auto; color: #999999; }
    .ao3st-manage-work[open] > summary::before { content: '\\25BE'; }
    .ao3st-manage-title { font-weight: bold; word-break: break-word; }
    .ao3st-manage-count { color: #777777; font-size: 12px; white-space: nowrap; }
    .ao3st-manage-ignore {
      margin-left: auto; padding: 2px 8px; font-size: 12px; font-family: inherit;
      border: 1px solid #999999; border-radius: 3px; background: #f2f2f2; color: #222222;
      cursor: pointer; white-space: nowrap;
    }
    .ao3st-manage-ignore:hover { background: #d0d0d0; }
    .ao3st-manage-ignore.ao3st-on { background: #900000; border-color: #900000; color: #ffffff; }
    .ao3st-manage-delwork {
      padding: 2px 8px; font-size: 12px; font-family: inherit;
      border: 1px solid #c08080; border-radius: 3px; background: #f9f0f0; color: #900000;
      cursor: pointer; white-space: nowrap;
    }
    .ao3st-manage-delwork:hover { background: #eccfcf; }
    .ao3st-manage-scope { padding: 6px 12px 0; font-size: 12px; color: #777777; font-style: italic; }
    .ao3st-manage-row {
      display: flex; align-items: center; gap: 10px;
      padding: 4px 10px 4px 26px; font-size: 12px;
      border-top: 1px solid #f0f0f0;
    }
    .ao3st-manage-date { font-weight: bold; white-space: nowrap; }
    .ao3st-manage-stats { flex: 1 1 auto; color: #555555; word-break: break-word; }
    .ao3st-manage-row button {
      padding: 1px 8px; font-size: 11px; font-family: inherit;
      border: 1px solid #c08080; border-radius: 3px; background: #f9f0f0; color: #900000;
      cursor: pointer; white-space: nowrap;
    }
    .ao3st-manage-row button:hover { background: #eccfcf; }
    #ao3st-manage-empty {
      padding: 40px; text-align: center; color: #777777; font-size: 13px;
      font-style: italic; line-height: 1.7;
    }
 
    /* manage popup dark mode */
    #ao3st-manage-panel.ao3st-dark { background: #232329; color: #e4e4e8; }
    #ao3st-manage-panel.ao3st-dark #ao3st-manage-header { background: #232329; border-bottom-color: #3a3a41; }
    #ao3st-manage-panel.ao3st-dark #ao3st-manage-header h2 { color: #e08080; }
    #ao3st-manage-panel.ao3st-dark #ao3st-manage-filter {
      background: #2e2e35; border-color: #55555e; color: #e4e4e8;
    }
    #ao3st-manage-panel.ao3st-dark #ao3st-manage-close {
      background: #3a3a41; border-color: #55555e; color: #e4e4e8;
    }
    #ao3st-manage-panel.ao3st-dark #ao3st-manage-close:hover { background: #50505a; }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-work { border-color: #3a3a41; }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-count,
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-scope { color: #9a9aa2; }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-row { border-top-color: #2e2e35; }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-stats { color: #b8b8c0; }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-ignore {
      background: #3a3a41; border-color: #55555e; color: #e4e4e8;
    }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-ignore:hover { background: #50505a; }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-ignore.ao3st-on {
      background: #a31212; border-color: #a31212; color: #ffffff;
    }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-delwork,
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-row button {
      background: #3a2a2c; border-color: #7a4a4a; color: #e08080;
    }
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-delwork:hover,
    #ao3st-manage-panel.ao3st-dark .ao3st-manage-row button:hover { background: #553636; }
    #ao3st-manage-panel.ao3st-dark #ao3st-manage-empty { color: #9a9aa2; }
 
    /* ---- mobile (max-width: 700px) ---- */
    .ao3st-legend-break { display: none; }
    @media (max-width: 700px) {
      /* Header becomes a two-column grid: controls down the left, buttons
         down the right, with the title and X sharing the top row. */
      #ao3st-header { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; align-items: start; }
      #ao3st-header .ao3st-row, #ao3st-header .ao3st-group { display: contents; }
      #ao3st-header h2 { grid-column: 1; grid-row: 1; margin: 0; align-self: center; font-size: 17px; }
      #ao3st-close { grid-column: 2; grid-row: 1; justify-self: end; }
      #ao3st-worklabel { grid-column: 1; grid-row: 2; }
      #ao3st-import { grid-column: 2; grid-row: 2; }
      #ao3st-rangelabel { grid-column: 1; grid-row: 3; }
      #ao3st-export { grid-column: 2; grid-row: 3; }
      #ao3st-hitslabel { grid-column: 1; grid-row: 4; }
      #ao3st-darkbtn { grid-column: 2; grid-row: 4; }
      #ao3st-modeseg { grid-column: 1; grid-row: 5; display: flex; flex-wrap: wrap; }
      #ao3st-import, #ao3st-export, #ao3st-darkbtn { justify-self: stretch; width: 100%; box-sizing: border-box; }
      #ao3st-header select { max-width: 150px; }
      /* legend: Hits/Kudos/Comments on line 1, Bookmarks/Subs on line 2, centered */
      #ao3st-legend { justify-content: center; gap: 8px 14px; }
      #ao3st-legend .ao3st-legend-break { display: block; flex-basis: 100%; height: 0; }
      /* tighter chart padding */
      #ao3st-chartwrap { padding: 8px; }
    }
  `;
 
  let overlayEl = null;
  let tooltipEl = null;
 
  function injectStyle() {
    if (document.getElementById('ao3st-style')) return;
    const style = document.createElement('style');
    style.id = 'ao3st-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
 
  function showToast(message) {
    injectStyle();
    let toast = document.getElementById('ao3st-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ao3st-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    raf(() => { toast.style.opacity = '1'; });
    setTimeout(() => { toast.style.opacity = '0'; }, 4000);
  }
 
  function fmt(v) {
    const rounded = Math.round(v * 10) / 10;
    return Number.isInteger(rounded) ? rounded.toLocaleString() : rounded.toFixed(1);
  }
 
  function openPopup() {
    const username = getUsername();
    if (!username) return;
    injectStyle();
 
    state = loadPrefs(username); // restore last-used toggle settings
    if (!overlayEl) buildPopup();
 
    // Show BEFORE rendering. The chart measures its container, which is 0
    // while the overlay is display:none
    overlayEl.style.display = 'flex';
    syncControls();
    if (cache.username === username && cache.data) {
      // Data already loaded this page view, but the sync key might have
      // changed since, so re-merge before drawing
      mergeFromSync(username, () => {
        populateWorkSelect(cache.data);
        renderCurrent();
      });
      return;
    }
    document.getElementById('ao3st-chartwrap').innerHTML =
      '<div id="ao3st-empty">Loading&hellip;</div>';
    prepareData(username, (data) => {
      populateWorkSelect(data);
      renderCurrent();
    });
  }
 
  function closePopup() {
    if (overlayEl) overlayEl.style.display = 'none';
    hideTooltip();
  }
 
  function buildPopup() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'ao3st-overlay';
    overlayEl.innerHTML = `
      <div id="ao3st-panel" role="dialog" aria-label="AO3 Stat Tracker">
        <div id="ao3st-header">
          <div class="ao3st-row"><h2>AO3 Stat Tracker</h2></div>
          <div class="ao3st-row ao3st-row-split">
            <span class="ao3st-group">
              <label id="ao3st-worklabel">Work: <select id="ao3st-workselect"></select></label>
              <label id="ao3st-hitslabel" title="Display hits at 1/10 scale so they don't dominate the bars">
                <input type="checkbox" id="ao3st-hitscale"> Smaller Hits (&divide;10)
              </label>
            </span>
            <span class="ao3st-group">
              <button type="button" class="ao3st-btn" id="ao3st-darkbtn">Dark mode</button>
              <button type="button" class="ao3st-btn" id="ao3st-import">Import</button>
              <button type="button" class="ao3st-btn" id="ao3st-export">Export</button>
              <button type="button" class="ao3st-btn" id="ao3st-close" aria-label="Close">&times;</button>
            </span>
          </div>
          <div class="ao3st-row">
            <label id="ao3st-rangelabel">Range: <select id="ao3st-range"></select></label>
            <span class="ao3st-seg" id="ao3st-modeseg">
              <button type="button" data-mode="cumulative">Cumulative</button>
              <button type="button" data-mode="new">New each day</button>
            </span>
            <input type="file" id="ao3st-importfile" accept=".json,application/json" style="display:none">
          </div>
        </div>
        <div id="ao3st-legend"></div>
        <div id="ao3st-chartwrap"></div>
        <div id="ao3st-footer"></div>
      </div>`;
    document.body.appendChild(overlayEl);
 
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'ao3st-tooltip';
    document.body.appendChild(tooltipEl);
 
    overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closePopup(); });
    window.addEventListener('resize', () => {
      if (overlayEl.style.display !== 'none') renderCurrent(); // refit chart width
    });
    document.getElementById('ao3st-close').addEventListener('click', closePopup);
    document.addEventListener('keydown', (e) => {
      // Ignore Escape while the manage popup is open on top of this one
      if (e.key === 'Escape' && overlayEl.style.display !== 'none' &&
          (!manageOverlayEl || manageOverlayEl.style.display === 'none')) closePopup();
    });
 
    document.getElementById('ao3st-workselect').addEventListener('change', (e) => {
      state.selectedWork = e.target.value;
      savePrefs();
      renderCurrent();
    });
 
    const rangeSelect = document.getElementById('ao3st-range');
    rangeSelect.innerHTML = Object.keys(RANGES).map((key) =>
      `<option value="${key}">${RANGES[key]}</option>`).join('');
    rangeSelect.addEventListener('change', (e) => {
      state.range = e.target.value;
      savePrefs();
      renderCurrent();
    });
 
    const seg = document.getElementById('ao3st-modeseg');
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      state.mode = btn.dataset.mode;
      savePrefs();
      syncControls();
      renderCurrent();
    });
 
    document.getElementById('ao3st-hitscale').addEventListener('change', (e) => {
      state.smallerHits = e.target.checked;
      savePrefs();
      updateLegend();
      renderCurrent();
    });
 
    document.getElementById('ao3st-darkbtn').addEventListener('click', () => {
      state.dark = !state.dark;
      savePrefs();
      applyDark();
      renderCurrent(); // re-render chart with theme colors
    });
 
    document.getElementById('ao3st-legend').addEventListener('click', (e) => {
      const chip = e.target.closest('.ao3st-chip[data-stat]');
      if (!chip) return;
      const k = chip.dataset.stat;
      const i = state.hiddenStats.indexOf(k);
      if (i === -1) state.hiddenStats.push(k);
      else state.hiddenStats.splice(i, 1);
      savePrefs();
      updateLegend();
      renderCurrent();
    });
 
    document.getElementById('ao3st-export').addEventListener('click', exportData);
 
    const importFile = document.getElementById('ao3st-importfile');
    document.getElementById('ao3st-import').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
      if (importFile.files && importFile.files[0]) importData(importFile.files[0]);
      importFile.value = ''; // allow re-importing the same file
    });
  }
 
  // Push the persisted state into the UI controls
  function syncControls() {
    const seg = document.getElementById('ao3st-modeseg');
    for (const b of seg.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    }
    document.getElementById('ao3st-hitscale').checked = state.smallerHits;
    document.getElementById('ao3st-range').value = state.range in RANGES ? state.range : 'all';
    applyDark();
    updateLegend();
  }
 
  function applyDark() {
    const panel = document.getElementById('ao3st-panel');
    if (panel) panel.classList.toggle('ao3st-dark', state.dark);
    const btn = document.getElementById('ao3st-darkbtn');
    if (btn) btn.textContent = state.dark ? 'Light mode' : 'Dark mode';
  }
 
  function updateLegend() {
    const legend = document.getElementById('ao3st-legend');
    const chips = activeStats().map((k) => {
      const label = k === 'hits' && state.smallerHits ? 'Hits (&divide;10)' : LABELS[k];
      const off = state.hiddenStats.includes(k) ? ' ao3st-off' : '';
      return `<span class="ao3st-chip${off}" data-stat="${k}" title="Click to show/hide">` +
        `<span class="ao3st-swatch" style="background:${COLORS[k]}"></span>${label}</span>`;
    });
    chips.splice(3, 0, '<span class="ao3st-legend-break"></span>'); // mobile line break
    legend.innerHTML = chips.join('');
  }
 
  function populateWorkSelect(data) {
    const select = document.getElementById('ao3st-workselect');
    const ids = Object.keys(data.works).sort((a, b) =>
      (data.works[a].title || '').localeCompare(data.works[b].title || '')
    );
    select.innerHTML =
      `<option value="user">User Stats</option>` +
      ids.map((id) => `<option value="${id}">${escapeHtml(data.works[id].title || 'Work ' + id)}</option>`).join('');
 
    // Keep the persisted selection if that work still exists
    const stillThere = state.selectedWork === 'user' || data.works[state.selectedWork];
    select.value = stillThere ? state.selectedWork : 'user';
    state.selectedWork = select.value;
  }
 
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
 
  function renderCurrent() {
    const username = getUsername();
    if (cache.username !== username || !cache.data) return; // prepareData will re-render when ready
    const data = cache.data;
    const wrap = document.getElementById('ao3st-chartwrap');
    const footer = document.getElementById('ao3st-footer');
 
    updateLegend(); // the User Stats view has an extra chip, so rebuild every render
 
    let series;
    if (state.selectedWork === 'user') {
      series = buildUserSeries(data, state.mode, state.ignoredFirstDays.includes('user'));
    } else if (data.works[state.selectedWork]) {
      series = buildWorkSeries(data.works[state.selectedWork], state.mode, firstTrackedDate(data),
        state.ignoredFirstDays.includes(state.selectedWork));
    } else {
      series = new Map();
    }
 
    series = filterByRange(series, state.range);
 
    if (activeStats().every((k) => state.hiddenStats.includes(k))) {
      wrap.innerHTML = `<div id="ao3st-empty">All stats are hidden.<br>Click a legend item to bring it back.</div>`;
      footer.textContent = footerText(data);
      return;
    }
 
    if (!series.size) {
      const hint = state.mode === 'new'
        ? 'New-each-day view needs at least two recorded days.'
        : "Visit your stats page's <strong>All Years</strong> view to record a snapshot.";
      wrap.innerHTML = `<div id="ao3st-empty">No data to display for this range.<br>${hint}</div>`;
    } else {
      renderChart(wrap, state.smallerHits ? scaleHits(series) : series, series);
    }
 
    footer.textContent = footerText(data);
  }
 
  function footerText(data) {
    const parts = [];
    const scopesSeen = new Set();
    const snapshotDays = new Set();
    for (const id in data.works) {
      for (const scope in data.works[id].scopes) {
        scopesSeen.add(scope);
        if (scope === 'all') {
          for (const d in data.works[id].scopes[scope]) snapshotDays.add(d);
        }
      }
    }
    parts.push(`${Object.keys(data.works).length} work(s) tracked`);
    parts.push(`${snapshotDays.size} All Years day(s) recorded`);
    const yearScopes = [...scopesSeen].filter((s) => s !== 'all').sort();
    if (yearScopes.length) parts.push(`year views stored: ${yearScopes.join(', ')}`);
 
    const allTotals = data.userTotals.all || {};
    const latest = Object.keys(allTotals).sort().pop();
    if (latest) {
      const t = allTotals[latest];
      const bits = [];
      for (const s of STAT_KEYS) if (s in t) bits.push(`${LABELS[s]} ${fmt(t[s])}`);
      if ('userSubscriptions' in t) bits.push(`User Subs ${fmt(t.userSubscriptions)}`);
      if (bits.length) parts.push(`latest user totals (${latest}): ${bits.join(' · ')}`);
    }
    return parts.join('  |  ');
  }
 
  /* ============================ Import/Export ============================ */
 
  function exportData() {
    const username = getUsername();
    prepareData(username, (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ao3-stat-tracker-${username}-${todayKey()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }
 
  function importData(file) {
    const username = getUsername();
    const reader = new FileReader();
    reader.onload = () => {
      prepareData(username, (data) => {
        try {
          const result = mergeImport(data, JSON.parse(reader.result));
          persistData();
          showToast(
            `Stat Tracker: imported ${result.added} new day${result.added === 1 ? '' : 's'}` +
            (result.skipped ? `, skipped ${result.skipped} conflicting` : '') + '.'
          );
          populateWorkSelect(data);
          renderCurrent();
        } catch (e) {
          console.warn('[AO3 Stat Tracker] Import failed:', e);
          showToast('Stat Tracker: import failed — not valid tracker JSON.');
        }
      });
    };
    reader.readAsText(file);
  }
 
  function cleanStats(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const KEYS = ['hits', 'kudos', 'comments', 'bookmarks', 'subscriptions', 'userSubscriptions', 'words'];
    const out = {};
    for (const k of KEYS) {
      if (typeof obj[k] === 'number' && isFinite(obj[k])) out[k] = obj[k];
      else if (typeof obj[k] === 'string' && obj[k].trim() !== '' && isFinite(Number(obj[k].replace(/[^\d.-]/g, '')))) {
        out[k] = Number(obj[k].replace(/[^\d.-]/g, ''));
      }
    }
    return Object.keys(out).length ? out : null;
  }
 
  // Merge imported data into storage. Rules:
  //  -days that don't exist yet are added
  //  -identical existing days are left alone
  //  -conflicting existing days are KEPT (import never overwrites) and counted as skipped
  //  -a work keyed by something non-numeric (eg- a title from a converted
  //    spreadsheet) is matched to an existing work by title when possible
  function mergeImport(data, imported) {
    if (!imported || typeof imported !== 'object' || !imported.works || typeof imported.works !== 'object') {
      throw new Error('missing works object');
    }
    let added = 0, skipped = 0;
 
    const byTitle = {};
    for (const id in data.works) byTitle[(data.works[id].title || '').toLowerCase()] = id;
 
    const mergeDays = (targetScopeObj, importedScopeObj) => {
      for (const day in importedScopeObj) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const stats = cleanStats(importedScopeObj[day]);
        if (!stats) continue;
        if (targetScopeObj[day]) {
          if (!statsEqual(targetScopeObj[day], stats)) skipped++;
        } else {
          targetScopeObj[day] = stats;
          added++;
        }
      }
    };
 
    for (const rawId in imported.works) {
      const w = imported.works[rawId];
      if (!w || typeof w !== 'object' || !w.scopes) continue;
      let id = String(rawId);
      if (!/^\d+$/.test(id)) {
        const t = (w.title || id).toLowerCase();
        id = byTitle[t] || ('imported-' + t.replace(/\W+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'work');
      }
      if (!data.works[id]) data.works[id] = { title: w.title || 'Work ' + id, scopes: {} };
      if (w.title) data.works[id].title = w.title;
      for (const scope in w.scopes) {
        if (!w.scopes[scope] || typeof w.scopes[scope] !== 'object') continue;
        if (!data.works[id].scopes[scope]) data.works[id].scopes[scope] = {};
        mergeDays(data.works[id].scopes[scope], w.scopes[scope]);
      }
    }
 
    if (imported.userTotals && typeof imported.userTotals === 'object') {
      for (const scope in imported.userTotals) {
        if (!imported.userTotals[scope] || typeof imported.userTotals[scope] !== 'object') continue;
        if (!data.userTotals[scope]) data.userTotals[scope] = {};
        mergeDays(data.userTotals[scope], imported.userTotals[scope]);
      }
    }
 
    return { added, skipped };
  }
 
  /* ============================ Manage Data ============================ */
 
  let manageOverlayEl = null;
  const manageOpenWorks = new Set(); // expanded <details> survive re-renders
 
  function openManagePopup() {
    const username = getUsername();
    if (!username) return;
    injectStyle();
 
    state = loadPrefs(username);
    if (!manageOverlayEl) buildManagePopup();
    document.getElementById('ao3st-manage-panel').classList.toggle('ao3st-dark', state.dark);
    manageOverlayEl.style.display = 'flex';
    document.getElementById('ao3st-manage-body').innerHTML =
      '<div id="ao3st-manage-empty">Loading&hellip;</div>';
    prepareData(username, () => renderManageList());
  }
 
  function closeManagePopup() {
    if (manageOverlayEl) manageOverlayEl.style.display = 'none';
    // If the chart popup is open underneath, refresh it in case works or
    // days were removed.
    if (overlayEl && overlayEl.style.display !== 'none' &&
        cache.username === getUsername() && cache.data) {
      populateWorkSelect(cache.data);
      renderCurrent();
    }
  }
 
  function buildManagePopup() {
    manageOverlayEl = document.createElement('div');
    manageOverlayEl.id = 'ao3st-manage-overlay';
    manageOverlayEl.innerHTML = `
      <div id="ao3st-manage-panel" role="dialog" aria-label="Recorded stat data">
        <div id="ao3st-manage-header">
          <h2>Recorded Data</h2>
          <input type="search" id="ao3st-manage-filter" placeholder="Filter by work title&hellip;">
          <button type="button" id="ao3st-manage-close" aria-label="Close">&times;</button>
        </div>
        <div id="ao3st-manage-body"></div>
      </div>`;
    document.body.appendChild(manageOverlayEl);
 
    manageOverlayEl.addEventListener('click', (e) => {
      if (e.target === manageOverlayEl) closeManagePopup();
    });
    document.getElementById('ao3st-manage-close').addEventListener('click', closeManagePopup);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && manageOverlayEl.style.display !== 'none') closeManagePopup();
    });
    document.getElementById('ao3st-manage-filter').addEventListener('input', renderManageList);
 
    const body = document.getElementById('ao3st-manage-body');
    // 'toggle' doesn't bubble, but capture-phase listeners still see it
    body.addEventListener('toggle', (e) => {
      const det = e.target.closest('details[data-work]');
      if (!det) return;
      if (det.open) manageOpenWorks.add(det.dataset.work);
      else manageOpenWorks.delete(det.dataset.work);
    }, true);
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const { action, kind, id, scope, day } = btn.dataset;
      if (action === 'ignore-first') {
        // The button lives inside <summary>; don't let it toggle the section
        e.preventDefault();
        e.stopPropagation();
        const key = kind === 'totals' ? 'user' : id;
        const i = state.ignoredFirstDays.indexOf(key);
        if (i === -1) state.ignoredFirstDays.push(key);
        else state.ignoredFirstDays.splice(i, 1);
        savePrefs();
        renderManageList();
        // Refresh the chart popup if it's open underneath
        if (overlayEl && overlayEl.style.display !== 'none' &&
            cache.username === getUsername() && cache.data) renderCurrent();
      } else if (action === 'del-day') {
        deleteDayRecord(kind, id, scope, day);
        showToast(`Stat Tracker: removed the ${day} record.`);
        renderManageList();
      } else if (action === 'del-work') {
        // The button lives inside <summary>; don't let it toggle the section
        e.preventDefault();
        e.stopPropagation();
        const title = (cache.data.works[id] && cache.data.works[id].title) || 'Work ' + id;
        if (!window.confirm(`Remove ALL recorded data for "${title}"?`)) return;
        delete cache.data.works[id];
        manageOpenWorks.delete(id);
        persistData();
        showToast(`Stat Tracker: removed "${title}".`);
        renderManageList();
      }
    });
  }
 
  function deleteDayRecord(kind, id, scope, day) {
    const data = cache.data;
    if (!data) return;
    if (kind === 'totals') {
      const scopeObj = data.userTotals[scope];
      if (scopeObj) {
        delete scopeObj[day];
        if (!Object.keys(scopeObj).length) delete data.userTotals[scope];
      }
    } else {
      const w = data.works[id];
      if (!w) return;
      const scopeObj = (w.scopes || {})[scope];
      if (scopeObj) {
        delete scopeObj[day];
        if (!Object.keys(scopeObj).length) delete w.scopes[scope];
      }
      // A work with no days left is dropped entirely
      if (w.scopes && !Object.keys(w.scopes).length) {
        delete data.works[id];
        manageOpenWorks.delete(id);
      }
    }
    persistData();
  }
 
  function statSummary(stats) {
    const bits = [];
    for (const s of STAT_KEYS) bits.push(`${LABELS[s]} ${fmt(stats[s] || 0)}`);
    if (stats.userSubscriptions) bits.push(`User Subs ${fmt(stats.userSubscriptions)}`);
    if (stats.words) bits.push(`Words ${fmt(stats.words)}`);
    return bits.join(' · ');
  }
 
  function ignoreFirstButtonHtml(kind, id) {
    const key = kind === 'totals' ? 'user' : id;
    const on = state.ignoredFirstDays.includes(key);
    return `<button type="button" class="ao3st-manage-ignore${on ? ' ao3st-on' : ''}" ` +
      `data-action="ignore-first" data-kind="${kind}" data-id="${escapeHtml(id)}" ` +
      `title="Don't chart the first recorded day (handy when it's a huge lifetime total)">` +
      `${on ? 'First day ignored' : 'Ignore first day'}</button>`;
  }
 
  function dayRowHtml(kind, id, scope, day, stats) {
    return `<div class="ao3st-manage-row">` +
      `<span class="ao3st-manage-date">${day}</span>` +
      `<span class="ao3st-manage-stats">${statSummary(stats)}</span>` +
      `<button type="button" data-action="del-day" data-kind="${kind}" data-id="${escapeHtml(id)}" ` +
      `data-scope="${escapeHtml(scope)}" data-day="${day}" title="Remove this day's record">Remove</button>` +
      `</div>`;
  }
 
  function renderManageList() {
    const body = document.getElementById('ao3st-manage-body');
    if (!body || !cache.data) return;
    const data = cache.data;
    const filter = (document.getElementById('ao3st-manage-filter').value || '').trim().toLowerCase();
    const scrollTop = body.scrollTop;
    const parts = [];
 
    // -- user-level totals --
    const totalScopes = Object.keys(data.userTotals || {})
      .filter((s) => Object.keys(data.userTotals[s]).length).sort();
    if (totalScopes.length) {
      let dayCount = 0;
      let rows = '';
      for (const scope of totalScopes) {
        const days = Object.keys(data.userTotals[scope]).sort().reverse();
        dayCount += days.length;
        if (scope !== 'all') rows += `<div class="ao3st-manage-scope">${escapeHtml(scope)} view</div>`;
        for (const d of days) rows += dayRowHtml('totals', '', scope, d, data.userTotals[scope][d]);
      }
         parts.push(
        `<details class="ao3st-manage-work" data-work="__totals__"${manageOpenWorks.has('__totals__') ? ' open' : ''}>` +
        `<summary><span class="ao3st-manage-title">User Totals</span> ` +
        `<span class="ao3st-manage-count">${dayCount} day(s)</span>` +
        ignoreFirstButtonHtml('totals', '') +
        `</summary>${rows}</details>`);
    }
 
    //per-work records, newest day first
    const ids = Object.keys(data.works).sort((a, b) =>
      (data.works[a].title || '').localeCompare(data.works[b].title || ''));
    let shown = 0;
    for (const id of ids) {
      const w = data.works[id];
      const title = w.title || 'Work ' + id;
      if (filter && title.toLowerCase().indexOf(filter) === -1) continue;
      shown++;
      let dayCount = 0;
      let rows = '';
      for (const scope of Object.keys(w.scopes || {}).sort()) {
        const days = Object.keys(w.scopes[scope]).sort().reverse();
        dayCount += days.length;
        if (scope !== 'all') rows += `<div class="ao3st-manage-scope">${escapeHtml(scope)} view</div>`;
        for (const d of days) rows += dayRowHtml('work', id, scope, d, w.scopes[scope][d]);
      }
      parts.push(
        `<details class="ao3st-manage-work" data-work="${escapeHtml(id)}"${manageOpenWorks.has(id) ? ' open' : ''}>` +
        `<summary><span class="ao3st-manage-title">${escapeHtml(title)}</span> ` +
        `<span class="ao3st-manage-count">${dayCount} day(s)</span>` +
        ignoreFirstButtonHtml('work', id) +
        `<button type="button" class="ao3st-manage-delwork" data-action="del-work" data-id="${escapeHtml(id)}" ` +
        `title="Remove every recorded day for this work">Remove all</button>` +
        `</summary>${rows || '<div class="ao3st-manage-row">No days recorded.</div>'}</details>`);
    }
 
    if (!ids.length && !totalScopes.length) {
      body.innerHTML = '<div id="ao3st-manage-empty">No data recorded yet.<br>' +
        "Visit your stats page's <strong>All Years</strong> view to record a snapshot.</div>";
      return;
    }
    if (filter && shown === 0) {
      parts.push('<div id="ao3st-manage-empty">No works match this filter.</div>');
    }
    body.innerHTML = parts.join('');
    body.scrollTop = scrollTop;
  }
 
  /* ============================ Chart ============================ */
 
  function niceStep(range, targetTicks) {
    const raw = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (raw <= m * mag) return m * mag;
    }
    return 10 * mag;
  }
 
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }
 
  // displaySeries drives bar heights. rawSeries drives tooltip values.
  function renderChart(wrap, displaySeries, rawSeries) {
    const theme = state.dark
      ? { grid: '#3a3a41', text: '#9a9aa2', subtext: '#77777e' }
      : { grid: '#dddddd', text: '#777777', subtext: '#999999' };
 
    // legend toggles- only visible stats are stacked, totalled, and shown
    const VISIBLE = activeStats().filter((k) => !state.hiddenStats.includes(k));
 
    const entries = [...displaySeries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const totals = entries.map(([, v]) => VISIBLE.reduce((sum, s) => sum + (v[s] || 0), 0));
    const maxTotal = Math.max(1, ...totals);
    const minTotal = Math.min(...totals);
    let yBottom = 0;
    if (state.mode === 'cumulative' && minTotal > 0) {
      const span = maxTotal - minTotal;
      const pad = (span > 0 ? span : minTotal) * Y_AXIS_PAD;
      yBottom = Math.max(0, minTotal - pad);
    }
 
    const mobile = window.innerWidth <= 700;
    const padL = mobile ? 42 : 64, padR = mobile ? 6 : 16;
    const padT = mobile ? 10 : 16, padB = mobile ? 40 : 48;
    const plotH = mobile ? 340 : 420;
    // Chart always fills the visible width of the popup. The per-day slot
    // and bar widths stretch or shrink to fit the number of days shown.
    const plotW = Math.max(200, wrap.clientWidth - padL - padR);
    const slot = plotW / entries.length;   // px per day
    const barW = Math.max(1, slot * 0.65);
    const width = padL + plotW + padR;
    const height = padT + plotH + padB;
 
    const yStep = niceStep(maxTotal - yBottom, 6);
    const yMin = yStep * Math.floor(yBottom / yStep);
    const yMax = yStep * Math.ceil(maxTotal / yStep);
    const y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
 
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('font-size', '11');
    svg.setAttribute('font-family', 'inherit');
 
    const mk = (tag, attrs, parent) => {
      const el = document.createElementNS(svgNS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(el);
      return el;
    };
 
    // Y axis gridlines and labels
    for (let v = yMin; v <= yMax + 1e-9; v += yStep) {
      const yy = y(v);
      mk('line', { x1: padL, y1: yy, x2: padL + plotW, y2: yy, stroke: theme.grid, 'stroke-width': 1 }, svg);
      const label = mk('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end', fill: theme.text }, svg);
      label.textContent = fmt(v);
    }
 
    // X axis labels, thinned out when there are many days
    const labelEvery = Math.max(1, Math.ceil(70 / slot));
    entries.forEach(([key], i) => {
      if (i % labelEvery !== 0 && i !== entries.length - 1) return;
      const cx = padL + i * slot + slot / 2;
      const label = mk('text', {
        x: cx, y: padT + plotH + 14, 'text-anchor': 'end', fill: theme.text,
        transform: `rotate(-35 ${cx} ${padT + plotH + 14})`,
      }, svg);
      label.textContent = key.slice(5); // MM-DD
      if (i === 0 || key.slice(5) === '01-01') {
        const yr = mk('text', {
          x: cx, y: padT + plotH + 40, 'text-anchor': 'middle', fill: theme.subtext, 'font-size': '10',
        }, svg);
        yr.textContent = key.slice(0, 4);
      }
    });
 
    // Bars (bottom -> top: hits, kudos, comments, bookmarks, subscriptions)
    entries.forEach(([key, stats], i) => {
      const raw = rawSeries.get(key) || stats;
      const rawTotal = VISIBLE.reduce((sum, s) => sum + (raw[s] || 0), 0);
        const x = padL + i * slot + (slot - barW) / 2;
      const barH = padT + plotH - y(totals[i]);
      let segY = padT + plotH;
      for (const s of VISIBLE) {
        const v = stats[s] || 0;
        if (v <= 0) continue;
        const h = (v / totals[i]) * barH;
        segY -= h;
        mk('rect', {
          x, y: segY, width: barW, height: Math.max(0.5, h), fill: COLORS[s],
        }, svg);
      }
      // Invisible full-height hover column for the tooltip
      const hover = mk('rect', {
        x: padL + i * slot, y: padT, width: slot, height: plotH, fill: 'transparent',
      }, svg);
      hover.addEventListener('mousemove', (e) => {
        const lines = VISIBLE.map((s) =>
          `<span style="color:${COLORS[s]}">&#9632;</span> ${LABELS[s]}: ${fmt(raw[s] || 0)}`
        );
        tooltipEl.innerHTML = `<strong>${key}</strong><br>` + lines.join('<br>') +
          `<br>Total: ${fmt(rawTotal)}`;
        tooltipEl.style.display = 'block';
        const tw = tooltipEl.offsetWidth || 200;
        // Default: right of the cursor. Too close to the right edge -> flip left.
        let left = e.clientX + 14;
        if (left + tw > window.innerWidth - 12) left = Math.max(8, e.clientX - tw - 14);
        tooltipEl.style.left = left + 'px';
        tooltipEl.style.top = Math.max(8, e.clientY - 20) + 'px';
      });
      hover.addEventListener('mouseleave', hideTooltip);
    });
 
    wrap.innerHTML = '';
    wrap.appendChild(svg);
  }
 
  /* ============================ Button ============================ */
 
  function initSharedMenu(attempts) {
    if (window.AO3MenuHelpers) {
      window.AO3MenuHelpers.addToSharedMenu({
        id: 'ao3-stat-tracker',
        text: 'Stat Tracker',
        onClick: openPopup,
      });
      window.AO3MenuHelpers.addToSharedMenu({
        id: 'ao3-stat-tracker-manage',
        text: 'Stat Tracker: Manage Data',
        onClick: openManagePopup,
      });
    } else if (attempts > 0) {
      setTimeout(() => initSharedMenu(attempts - 1), 500);
    }
  }
 
  /* ======================================================== */
 
  try {
    console.log('[AO3 Stat Tracker] v2.0 running — native compression:', hasCompression);
    recordSnapshot();
    initSharedMenu(10);
  } catch (e) {
    console.error('[AO3 Stat Tracker] startup error:', e);
  }
})();
