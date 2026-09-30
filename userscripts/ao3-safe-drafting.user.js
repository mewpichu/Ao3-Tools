// ==UserScript==
// @name         AO3: Safe Drafting
// @namespace    mewpichu-ao3-safe-drafting
// @version      1.0.0
// @description  Adds a "Safe Draft Mode" to Ao3. Posting requires an extra confirmation step so you can't accidentally hit Post.
// @author       mewpichu
// @match        https://archiveofourown.org/*
// @match        https://archiveofourown.com/*
// @match        https://archiveofourown.net/*
// @match        https://archiveofourown.gay/*
// @match        https://ao3.org/*
// @match        https://archive.transformativeworks.org/*
// @match        https://insecure.archiveofourown.org/*
// @require      https://update.greasyfork.org/scripts/552743/1859007/AO3%3A%20Menu%20Helpers%20Library.js?v=2.3.0
// @run-at       document-end
// @grant        none
// @license      MIT
// ==/UserScript==
 
(function () {
  'use strict';
  const LS_LEVEL = 'ao3_sdm_level';
  const getLevel = () => localStorage.getItem(LS_LEVEL) || 'confirm'; // default: confirm
  const POST_VALUE_RE = /^post(\s|$)/i;
  const POST_LINK_RE = /^post draft$/i;
 
  function findPostControls() {
    const buttons = document.querySelectorAll(
      'form input[type="submit"], form button[type="submit"], form button:not([type])'
    );
    const guardedButtons = [...buttons].filter(el =>
      POST_VALUE_RE.test((el.value || el.textContent || '').trim())
    );
 
    const links = document.querySelectorAll('a[href]');
    const guardedLinks = [...links].filter(el =>
      POST_LINK_RE.test((el.textContent || '').trim())
    );
 
    return guardedButtons.concat(guardedLinks);
  }
 
  /* ============================ Style ============================ */
  const css = `
    .sdm-confirm {
      display: inline-flex; align-items: center; gap: 0.5em; flex-wrap: wrap;
      margin-left: 0.75em; padding: 0.4em 0.75em;
      border: 2px solid #990000; border-radius: 4px;
      background: #fdecea; color: #333; font-size: 0.95em;
    }
    .sdm-confirm strong { color: #990000; }
    .sdm-confirm input[type="text"] { width: 5.5em; padding: 0.15em 0.3em; }
    .sdm-confirm button { margin: 0; }
    .sdm-confirm .sdm-yes { background: #990000; color: #fff; border-color: #990000; }
    .sdm-guarded { outline: 2px dashed #d4b200 !important; outline-offset: 2px; }
 
    #sdm-overlay {
      position: fixed; inset: 0; z-index: 1000000;
      background: rgba(0,0,0,.45);
      display: flex; align-items: center; justify-content: center;
    }
    #sdm-dialog {
      width: 420px; max-width: 92vw; max-height: 85vh; overflow: auto;
      background: #242424; color: #eee; border-radius: 10px; padding: 16px;
      font: 14px/1.5 sans-serif; box-shadow: 0 6px 30px rgba(0,0,0,.6);
    }
    #sdm-dialog h2 { margin: 0 0 10px; font-size: 16px; }
    #sdm-dialog .sdm-row { margin: 12px 0; }
    #sdm-dialog label { display: block; margin: 6px 0; cursor: pointer; }
    #sdm-dialog input[type="radio"] { accent-color: #8ab4f8; margin-right: 6px; }
    #sdm-dialog .sdm-desc { display: block; margin-left: 22px; font-size: 12px; color: #aaa; }
    #sdm-dialog .sdm-actions { margin-top: 12px; text-align: right; }
    #sdm-dialog button.sdm-btn {
      background: #444; color: #fff; border: 1px solid #666;
      border-radius: 4px; padding: 5px 12px; cursor: pointer;
    }
    #sdm-dialog button.sdm-btn:hover { background: #555; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
 
  /* ============================ Confirm ============================ */
  
  function buildConfirmPanel(control) {
    const strict = getLevel() === 'strict';
    const panel = document.createElement('span');
    panel.className = 'sdm-confirm';
 
    const msg = document.createElement('strong');
    msg.textContent = 'This will publish publicly. ';
    panel.appendChild(msg);
 
    let typedOk = !strict;
 
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'sdm-yes';
    yes.textContent = 'Yes, publish';
    yes.disabled = !typedOk;
    yes.addEventListener('click', () => {
      control.dataset.sdmBypass = '1';
      panel.remove();
      control.click();
    });
 
    if (strict) {
      const lbl = document.createElement('span');
      lbl.textContent = 'Type POST to confirm:';
      const typeInput = document.createElement('input');
      typeInput.type = 'text';
      typeInput.setAttribute('autocomplete', 'off');
      typeInput.addEventListener('input', () => {
        typedOk = typeInput.value.trim() === 'POST';
        yes.disabled = !typedOk;
      });
      typeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && typedOk) { e.preventDefault(); yes.click(); }
      });
      panel.appendChild(lbl);
      panel.appendChild(typeInput);
    }
 
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Cancel';
    no.addEventListener('click', () => panel.remove());
 
    panel.appendChild(yes);
    panel.appendChild(no);
    return panel;
  }
 
  /* ============================ Guard ============================ */
  
  function guardControl(el) {
    if (el.dataset.sdmGuarded) return;
    el.dataset.sdmGuarded = '1';
    if (getLevel() !== 'off') el.classList.add('sdm-guarded');
 
    el.addEventListener('click', function (e) {
      if (getLevel() === 'off') return;
      if (el.dataset.sdmBypass === '1') {
        delete el.dataset.sdmBypass;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
 
      if (el.parentElement.querySelector('.sdm-confirm')) return;
      const panel = buildConfirmPanel(el);
      el.insertAdjacentElement('afterend', panel);
      const t = panel.querySelector('input[type="text"]');
      if (t) t.focus();
    }, true);
  }
 
  /* ============================ Settings ============================ */
  
  const LEVELS = [
    { value: 'off',     label: 'Off',     desc: 'Post buttons work normally. No protection.' },
    { value: 'confirm', label: 'Confirm', desc: 'Posting requires one extra click on "Yes, publish".' },
    { value: 'strict',  label: 'Strict',  desc: 'Posting requires typing POST before the publish button unlocks.' },
  ];
 
  function openPopup() {
    if (document.getElementById('sdm-overlay')) return;
 
    const overlay = document.createElement('div');
    overlay.id = 'sdm-overlay';
 
    const dialog = document.createElement('div');
    dialog.id = 'sdm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Safe Draft Mode settings');
 
    const heading = document.createElement('h2');
    heading.textContent = 'Safe Draft Mode';
    dialog.appendChild(heading);
 
    const row = document.createElement('div');
    row.className = 'sdm-row';
    const current = getLevel();
 
    LEVELS.forEach(({ value, label, desc }) => {
      const lbl = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'sdm-level';
      radio.value = value;
      radio.checked = value === current;
      radio.addEventListener('change', () => {
        localStorage.setItem(LS_LEVEL, value);
        document.querySelectorAll('[data-sdm-guarded]').forEach(b => {
          b.classList.toggle('sdm-guarded', value !== 'off');
        });
      });
      lbl.appendChild(radio);
      lbl.appendChild(document.createTextNode(label));
      const d = document.createElement('span');
      d.className = 'sdm-desc';
      d.textContent = desc;
      lbl.appendChild(d);
      row.appendChild(lbl);
    });
    dialog.appendChild(row);
 
    const actions = document.createElement('div');
    actions.className = 'sdm-actions';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sdm-btn';
    close.textContent = 'Close';
    close.addEventListener('click', () => overlay.remove());
    actions.appendChild(close);
    dialog.appendChild(actions);
 
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(overlay);
  }
 
  /* ============================ Button ============================ */
  
  function initSharedMenu(attempts) {
    if (window.AO3MenuHelpers) {
      window.AO3MenuHelpers.addToSharedMenu({
        id: 'ao3-safe-draft-mode',
        text: 'Safe Draft Mode',
        onClick: openPopup,
      });
    } else if (attempts > 0) {
      setTimeout(() => initSharedMenu(attempts - 1), 500);
    }
  }
  initSharedMenu(10);
 
  /* ======================================================== */
  
  const postControls = findPostControls();
  if (postControls.length === 0) return;
 
  postControls.forEach(guardControl);
})();
