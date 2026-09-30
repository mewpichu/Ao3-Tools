// ==UserScript==
// @name         Ao3 Read Marker
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Mark Ao3 fics you've already read
// @match        https://archiveofourown.org/*
// @match        https://archiveofourown.com/*
// @match        https://archiveofourown.net/*
// @match        https://archiveofourown.gay/*
// @match        https://ao3.org/*
// @match        https://archive.transformativeworks.org/*
// @match        https://insecure.archiveofourown.org/*
// @exclude      https://archiveofourown.org/users/*
// @exclude      https://archiveofourown.com/users/*
// @exclude      https://archiveofourown.net/users/*
// @exclude      https://archiveofourown.gay/users/*
// @exclude      https://ao3.org/users/*
// @exclude      https://archive.transformativeworks.org/users/*
// @exclude      https://insecure.archiveofourown.org/users/*
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// @author       mewpichu
// ==/UserScript==
 
(function() {
    'use strict';
 
    const STORAGE_KEY = 'ao3-read-history';
 
    function getFicId(url) {
        const match = url.match(/\/works\/(\d+)/);
        return match ? match[1] : null;
    }
 
    function markAsRead() {
        const id = getFicId(window.location.href);
        if (!id) return;
 
        let history = JSON.parse(GM_getValue(STORAGE_KEY, '{}'));
        history[id] = Date.now();
        GM_setValue(STORAGE_KEY, JSON.stringify(history));
    }
 
    function removeReadMark(id) {
        let history = JSON.parse(GM_getValue(STORAGE_KEY, '{}'));
        delete history[id];
        GM_setValue(STORAGE_KEY, JSON.stringify(history));
    }
 
    function addReadMarkers() {
        const history = JSON.parse(GM_getValue(STORAGE_KEY, '{}'));
 
        // find all works
        document.querySelectorAll('li.work').forEach(blurb => {
            // skip if already processed
            if (blurb.querySelector('.ao3-read-badge')) return;
 
            // get fic id from the title link
            const titleLink = blurb.querySelector('h4 a[href*="/works/"]');
            if (!titleLink) return;
 
            const id = getFicId(titleLink.href);
            if (!id || !history[id]) return;
 
            // find author line
            const authorLine = blurb.querySelector('.byline, .heading');
            if (!authorLine) return;
 
            const container = document.createElement('span');
            container.style.display = 'inline-flex';
            container.style.alignItems = 'center';
            container.style.gap = '0.3em';
            container.style.marginLeft = '0.4em';
 
            const badge = document.createElement('span');
            badge.className = 'ao3-read-badge';
            badge.textContent = '[read]';
            badge.style.color = '#999';
            badge.style.fontSize = '0.85em';
            badge.style.fontStyle = 'italic';
 
            const removeBtn = document.createElement('button');
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove read mark';
            removeBtn.style.all = 'unset';
            removeBtn.style.color = '#bbb';
            removeBtn.style.fontSize = '0.75em';
            removeBtn.style.cursor = 'pointer';
            removeBtn.style.padding = '0 0.2em';
            removeBtn.style.lineHeight = '1';
            removeBtn.style.opacity = '0';
            removeBtn.style.transition = 'opacity 0.15s';
 
            removeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                removeReadMark(id);
                container.remove();
            });
 
            container.addEventListener('mouseenter', () => {
                removeBtn.style.opacity = '1';
            });
            container.addEventListener('mouseleave', () => {
                removeBtn.style.opacity = '0';
            });
 
            container.appendChild(badge);
            container.appendChild(removeBtn);
 
            // append after author
            authorLine.appendChild(container);
        });
    }
 
    markAsRead();
    addReadMarkers();
 
    const observer = new MutationObserver(addReadMarkers);
    observer.observe(document.body, { childList: true, subtree: true });
})();
