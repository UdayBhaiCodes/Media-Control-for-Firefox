'use strict';

const VERSION = browser.runtime.getManifest().version;
const SKIP_SECONDS = 10;
const DISCOVER_MS = 2500;
const REFRESH_MS = 500;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const cards = new Map(); // tabId -> card
let firstScan = true;

const NOTE = '<svg class="ph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
const TEMPLATE = `
  <div class="top">
    <button class="thumb" title="Go to tab">${NOTE}<img class="icon" alt="" hidden><img class="art" alt="" referrerpolicy="no-referrer" hidden></button>
    <div class="meta">
      <button class="title" title="Go to tab"></button>
      <div class="artist" hidden></div>
      <div class="site"><img class="fav" alt="" hidden><span class="host"></span></div>
    </div>
  </div>
  <div class="seek">
    <span class="cur">0:00</span>
    <input type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
    <span class="dur">0:00</span>
  </div>
  <div class="ctrls">
    <button data-a="prev" aria-label="Previous track" title="Previous track"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>
    <button data-a="back" aria-label="Back 10 seconds" title="Back 10 seconds"><svg class="stroke" viewBox="0 0 24 24"><path d="M12 6a7 7 0 1 1-7 7M14.5 3.5L12 6l2.5 2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16" text-anchor="middle" font-size="7.5" font-weight="700" font-family="system-ui,sans-serif" fill="currentColor">10</text></svg></button>
    <button data-a="toggle" class="play" aria-label="Play or pause"><svg class="ic-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg class="ic-pause" viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg></button>
    <button data-a="fwd" aria-label="Forward 10 seconds" title="Forward 10 seconds"><svg class="stroke" viewBox="0 0 24 24"><path d="M12 6a7 7 0 1 0 7 7M9.5 3.5L12 6l-2.5 2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16" text-anchor="middle" font-size="7.5" font-weight="700" font-family="system-ui,sans-serif" fill="currentColor">10</text></svg></button>
    <button data-a="next" aria-label="Next track" title="Next track"><svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></button>
  </div>`;

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function ask(tabId, frameId, payload) {
  try {
    return await browser.tabs.sendMessage(tabId, Object.assign({ mc: 1 }, payload), { frameId });
  } catch (e) {
    return null;
  }
}

function rank(s) {
  return (s.paused ? 0 : 1e14) + (s.active || 0);
}

async function discover() {
  const tabs = await browser.tabs.query({});
  const found = await Promise.all(tabs.map(async (tab) => {
    if (tab.discarded) return null;
    let frames = [];
    try { frames = (await browser.webNavigation.getAllFrames({ tabId: tab.id })) || []; } catch (e) {}
    if (!frames.length) frames = [{ frameId: 0 }];
    const results = await Promise.all(frames.map(async (f) => ({
      frameId: f.frameId,
      state: await ask(tab.id, f.frameId, { cmd: 'state' })
    })));
    const hits = results.filter((r) => r.state);
    if (!hits.length) return null;
    hits.sort((a, b) => rank(b.state) - rank(a.state));
    return { tab, frameId: hits[0].frameId, state: hits[0].state };
  }));
  return found.filter(Boolean);
}

let discovering = false;
async function runDiscover() {
  if (discovering) return;
  discovering = true;
  try {
    const found = await discover();
    if (firstScan) found.sort((a, b) => rank(b.state) - rank(a.state));
    const seen = new Set();
    for (const f of found) {
      seen.add(f.tab.id);
      let card = cards.get(f.tab.id);
      if (!card) {
        card = createCard();
        cards.set(f.tab.id, card);
        listEl.append(card.el);
      }
      card.tab = f.tab;
      card.frameId = f.frameId;
      setState(card, f.state);
    }
    for (const [id, card] of cards) {
      if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
    }
    emptyEl.hidden = cards.size > 0;
    firstScan = false;
  } catch (e) {
    if (firstScan) { emptyEl.hidden = false; firstScan = false; }
  } finally {
    discovering = false;
  }
}

let refreshing = false;
async function refresh() {
  if (refreshing || !cards.size) return;
  refreshing = true;
  try {
    await Promise.all([...cards.values()].map(async (card) => {
      const s = await ask(card.tab.id, card.frameId, { cmd: 'state' });
      if (s) { setState(card, s); return; }
      card.misses = (card.misses || 0) + 1;
      if (card.misses >= 2) {
        card.el.remove();
        cards.delete(card.tab.id);
        emptyEl.hidden = cards.size > 0;
      }
    }));
  } finally {
    refreshing = false;
  }
}

function createCard() {
  const el = document.createElement('section');
  el.className = 'card';
  el.innerHTML = TEMPLATE;
  const q = (sel) => el.querySelector(sel);
  const card = {
    el,
    thumb: q('.thumb'), art: q('.art'), icon: q('.icon'),
    title: q('.title'), artist: q('.artist'), fav: q('.fav'), host: q('.host'),
    cur: q('.cur'), dur: q('.dur'), range: q('input'),
    prev: q('[data-a=prev]'), next: q('[data-a=next]'),
    s: null, tab: null, frameId: 0, at: 0, misses: 0, dragging: false, thumbKey: '', curText: ''
  };
  card.fav.onerror = () => { card.fav.hidden = true; };

  card.thumb.addEventListener('click', () => goTo(card));
  card.title.addEventListener('click', () => goTo(card));

  const actions = {
    prev: { cmd: 'prev' },
    back: { cmd: 'seekBy', delta: -SKIP_SECONDS },
    toggle: { cmd: 'toggle' },
    fwd: { cmd: 'seekBy', delta: SKIP_SECONDS },
    next: { cmd: 'next' }
  };
  el.querySelectorAll('[data-a]').forEach((btn) => {
    btn.addEventListener('click', () => command(card, actions[btn.dataset.a]));
  });

  card.range.addEventListener('input', () => {
    card.dragging = true;
    const t = (card.range.value / 1000) * (card.s.d || 0);
    card.cur.textContent = fmt(t);
    card.range.style.setProperty('--pct', card.range.value / 10 + '%');
  });
  card.range.addEventListener('change', async () => {
    const t = (card.range.value / 1000) * (card.s.d || 0);
    await command(card, { cmd: 'seekTo', time: t });
    card.dragging = false;
  });
  return card;
}

async function command(card, payload) {
  if (!card.s) return;
  const s = await ask(card.tab.id, card.frameId, Object.assign({ mid: card.s.mid }, payload));
  if (s) setState(card, s);
  setTimeout(refresh, 200); // pick up what the site did in response
}

async function goTo(card) {
  try {
    await browser.tabs.update(card.tab.id, { active: true });
    await browser.windows.update(card.tab.windowId, { focused: true });
  } catch (e) {}
  window.close();
}

function setThumb(card, urls, favicon) {
  const key = urls.join('|') + '#' + favicon;
  if (card.thumbKey === key) return;
  card.thumbKey = key;

  card.icon.onerror = () => { card.icon.hidden = true; };
  card.icon.hidden = !favicon;
  if (favicon) card.icon.src = favicon;

  const art = card.art;
  let i = 0;
  art.hidden = true;
  art.onload = () => { art.hidden = false; };
  art.onerror = tryNext;
  function tryNext() {
    if (i >= urls.length) { art.hidden = true; return; }
    art.src = urls[i++];
  }
  tryNext();
}

function setState(card, s) {
  card.s = s;
  card.at = performance.now();
  card.misses = 0;

  const host = hostOf(card.tab.url);
  card.title.textContent = s.title || card.tab.title || s.pageTitle || host;
  const sub = s.build === VERSION ? [s.artist, s.album].filter(Boolean).join(' · ') : 'Reload this tab to finish updating';
  card.artist.textContent = sub;
  card.artist.hidden = !sub;
  card.host.textContent = host;

  const fav = /^(https?|data):/.test(card.tab.favIconUrl || '') ? card.tab.favIconUrl : '';
  card.fav.hidden = !fav;
  if (fav && card.fav.getAttribute('src') !== fav) card.fav.src = fav;

  const urls = [].concat(s.art || [], s.poster, s.yt, s.og).filter((u) => u && !u.startsWith('blob:'));
  setThumb(card, urls, fav);

  card.el.classList.toggle('paused', !!s.paused);
  card.prev.disabled = !s.canPrev;
  card.next.disabled = !s.canNext;

  const seekable = !!s.d && !s.live;
  card.range.disabled = !seekable;
  card.dur.textContent = s.live ? 'LIVE' : s.d ? fmt(s.d) : '--:--';
  paintTime(card);
}

function currentTime(card) {
  const s = card.s;
  let t = s.t || 0;
  if (!s.paused) t += ((performance.now() - card.at) / 1000) * (s.rate || 1);
  if (s.d) t = Math.min(t, s.d);
  return t;
}

function paintTime(card) {
  if (card.dragging || !card.s) return;
  const t = currentTime(card);
  const text = fmt(t);
  if (text !== card.curText) {
    card.curText = text;
    card.cur.textContent = text;
  }
  const pct = card.s.d && !card.s.live ? (t / card.s.d) * 100 : 0;
  card.range.value = Math.round(pct * 10);
  card.range.style.setProperty('--pct', pct + '%');
}

function tick() {
  for (const card of cards.values()) paintTime(card);
  requestAnimationFrame(tick);
}

document.getElementById('debug').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const out = { version: VERSION, frames: [] };
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    out.tab = { url: tab.url, status: tab.status };
    const frames = (await browser.webNavigation.getAllFrames({ tabId: tab.id })) || [];
    for (const f of frames) {
      out.frames.push({ frameId: f.frameId, url: f.url, debug: await ask(tab.id, f.frameId, { cmd: 'debug' }) });
    }
  } catch (err) {
    out.error = String(err);
  }
  const text = JSON.stringify(out, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add('done');
    button.title = 'Copied. Paste it into the chat.';
  } catch (err) {
    const box = document.getElementById('dump');
    box.value = text;
    box.hidden = false;
    box.select();
    button.title = 'Copy the text below';
  }
});

runDiscover();
setInterval(runDiscover, DISCOVER_MS);
setInterval(refresh, REFRESH_MS);
requestAnimationFrame(tick);
