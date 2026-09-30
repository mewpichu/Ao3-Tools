// ==UserScript==
// @name         AO3: Fic Safety Net
// @namespace    mewpichu-ao3-fic-safety
// @version      1.2.5
// @description  Saves a temporary local copy of the fic you're currently reading in case you lose connection or the work becomes otherwise unavailable.
// @author       mewpichu
// @match        https://archiveofourown.org/*
// @match        https://archiveofourown.com/*
// @match        https://archiveofourown.net/*
// @match        https://archiveofourown.gay/*
// @match        https://ao3.org/*
// @match        https://archive.transformativeworks.org/*
// @match        https://insecure.archiveofourown.org/*
// @require      https://update.greasyfork.org/scripts/552743/1859007/AO3%3A%20Menu%20Helpers%20Library.js?v=2.3.0
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==
 
(function () {
  'use strict';
 
  const DB_NAME = 'ao3-fic-safety-net';
  const STORE = 'cache';
  const SLOT = 'current';
  const THEME_KEY = 'fsn-theme';
 
  /* ============================ IndexedDB wrapper ============================ */
 
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
 
  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
 
  async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
 
  async function idbClear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
 
  /* ============================ Capture ============================ */
 
  let inMemoryEntry = null;
 
  const workMatch = location.pathname.match(/^\/works\/(\d+)(?:\/chapters\/(\d+))?/);
  if (workMatch) {
    const [, workId, chapterId] = workMatch;
    captureWork(workId, chapterId || null).catch(err =>
      console.warn('[Fic Safety Net] capture failed:', err)
    );
 
    // When this tab becomes active, claim the cache slot
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        commitToSlot().catch(err =>
          console.warn('[Fic Safety Net] commit failed:', err)
        );
      }
    });
  }
 
  async function captureWork(workId, chapterId) {
    // Slot already holds this work? Update the chapter marker, no fetch
    const existing = await idbGet(SLOT);
    if (existing && existing.workId === workId) {
      inMemoryEntry = { ...existing, chapterId };
      if (document.visibilityState === 'visible') await commitToSlot();
      return;
    }
    const resp = await fetch(
      `/works/${workId}?view_full_work=true&view_adult=true`,
      { credentials: 'same-origin' }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
 
    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
    const workskin = doc.querySelector('#workskin');
 
    // If there's no work content, you hit an adult-warning gate, a deleted
    // work, or a redirect, bail WITHOUT touching the existing cache
    if (!workskin || !workskin.querySelector('#chapters, .chapter')) {
      throw new Error('no work content in response');
    }
 
    // Author work-skin CSS lives in <style> tags in the head.
    const skinCss = [...doc.querySelectorAll('head style')]
      .map(s => s.textContent)
      .join('\n');
 
    inMemoryEntry = {
      workId,
      chapterId,
      title: doc.querySelector('.preface .title')?.textContent.trim() || 'Unknown title',
      author: doc.querySelector('.preface .byline a')?.textContent.trim() || 'Unknown author',
      html: workskin.outerHTML,
      skinCss,
      savedAt: Date.now(),
    };
 
    // Only write through immediately if this tab is the active one
    // Background tabs hold their copy in memory until activated
    if (document.visibilityState === 'visible') {
      await commitToSlot();
    }
  }
 
  async function commitToSlot() {
    if (!inMemoryEntry) return;
    const existing = await idbGet(SLOT);
    // Skip the write only if both the work AND chapter are already current
    if (
      existing &&
      existing.workId === inMemoryEntry.workId &&
      existing.chapterId === inMemoryEntry.chapterId
    ) {
      return;
    }
    await idbClear();
    await idbSet(SLOT, inMemoryEntry);
    console.log(`[Fic Safety Net] slot now holds "${inMemoryEntry.title}" (${(inMemoryEntry.html.length / 1024).toFixed(0)} KB)`);
  }
 
  /* ============================ Overlay ============================ */
 
  const OVERLAY_CSS = `
    #fsn-overlay {
      position: fixed; inset: 0; z-index: 999999;
      background: #fff; color: #222; overflow-y: auto;
      font-family: Georgia, 'Times New Roman', serif;
    }
    #fsn-overlay.fsn-dark { background: #161616; color: #e2e2e2; }
    #fsn-overlay.fsn-dark a { color: #8ab4f8; }
    #fsn-bar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; gap: 0.6em;
      padding: 0.6em 1em;
      background: #7d0f0f; color: #fff;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      font-family: sans-serif; font-size: 14px;
    }
    #fsn-bar .fsn-meta { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #fsn-bar button {
      background: #fff; color: #7d0f0f; border: 0; border-radius: 4px;
      padding: 0.3em 0.9em; cursor: pointer; font-weight: bold;
      white-space: nowrap;
    }
    #fsn-content {
      max-width: 45em; margin: 2em auto; padding: 0 1em 4em;
      line-height: 1.6; font-size: 1.05em;
    }
    #fsn-content img { max-width: 100%; }
    #fsn-content .chapter, #fsn-content .preface { scroll-margin-top: 3.5em; }
    #fsn-content .chapter.preface, #fsn-content .preface { margin-bottom: 2em; }
    @media (max-width: 600px) {
      #fsn-bar { font-size: 13px; padding: 0.4em 0.6em; }
      #fsn-bar .fsn-title { display: none; }
      #fsn-bar button { padding: 0.2em 0.6em; }
    }
  `;
 
  function formatDate(ts) {
    const d = new Date(ts);
    return (
      d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
      ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    );
  }
 
  async function openSavedCopy() {
    document.getElementById('fsn-overlay')?.remove();
 
    const entry = await idbGet(SLOT);
    const overlay = document.createElement('div');
    overlay.id = 'fsn-overlay';
    if (localStorage.getItem(THEME_KEY) === 'dark') {
      overlay.classList.add('fsn-dark');
    }
 
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS + (entry ? entry.skinCss : '');
    overlay.appendChild(style);
 
    const bar = document.createElement('div');
    bar.id = 'fsn-bar';
 
    const meta = document.createElement('span');
    meta.className = 'fsn-meta';
    if (entry) {
      const titleSpan = document.createElement('span');
      titleSpan.className = 'fsn-title';
      titleSpan.textContent = `${entry.title} by ${entry.author} | `;
      const dateSpan = document.createElement('span');
      dateSpan.textContent = `${entry.title} | ${formatDate(entry.savedAt)}`;
      meta.append(titleSpan, dateSpan);
    } else {
      meta.textContent = 'Nothing saved yet. Open a fic first.';
    }
 
    const themeBtn = document.createElement('button');
    const syncThemeLabel = () => {
      themeBtn.textContent = overlay.classList.contains('fsn-dark') ? 'Light' : 'Dark';
    };
    themeBtn.onclick = () => {
      overlay.classList.toggle('fsn-dark');
      localStorage.setItem(
        THEME_KEY,
        overlay.classList.contains('fsn-dark') ? 'dark' : 'light'
      );
      syncThemeLabel();
    };
    syncThemeLabel();
 
    const close = document.createElement('button');
    close.textContent = 'X';
    close.onclick = () => overlay.remove();
 
    bar.append(meta, themeBtn, close);
    overlay.appendChild(bar);
 
    if (entry) {
      const content = document.createElement('div');
      content.id = 'fsn-content';
      content.innerHTML = entry.html;
      overlay.appendChild(content);
 
      // Jump to chapter AFTER previous cache
      if (entry.chapterId) {
        // '.chapter' also matches the nested "chapter preface group" divs,
        // so keep only the outermost chapter wrappers
        const chapters = [...content.querySelectorAll('.chapter')]
          .filter(el => !el.parentElement.closest('.chapter'));
        const idx = chapters.findIndex(ch =>
          ch.querySelector(`a[href*="/chapters/${entry.chapterId}"]`)
        );
        if (idx !== -1) {
          // Next chapter, or the marked one if it was the last
          const target = chapters[idx + 1] || chapters[idx];
          requestAnimationFrame(() => target.scrollIntoView());
        } else {
          // Fallback: scroll to the marked chapter itself
          const link = content.querySelector(`a[href*="/chapters/${entry.chapterId}"]`);
          const target = link?.closest('.chapter') || link;
          if (target) {
            requestAnimationFrame(() => target.scrollIntoView());
          }
        }
      }
    }
 
    document.body.appendChild(overlay);
  }
 
  /* ============================ Button ============================ */
 
  function initSharedMenu(attempts) {
    if (window.AO3MenuHelpers) {
      window.AO3MenuHelpers.addToSharedMenu({
        id: 'fic-safety-net',
        text: 'Open Saved Fic Copy',
        onClick: openSavedCopy,
      });
    } else if (attempts > 0) {
      setTimeout(() => initSharedMenu(attempts - 1), 500);
    }
  }
  initSharedMenu(10);
})();
