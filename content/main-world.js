(() => {
  'use strict';
  // Must match manifest.json. Lets the popup tell when a tab is still running an older copy of this script.
  const BUILD = '1.1.1';

  // Spotify's web player doesn't give extensions usable media-session controls or a reliable
  // duration, so on open.spotify.com the player bar on the page is used instead.
  const SP = location.hostname === 'open.spotify.com' ? {
    play: '[data-testid="control-button-playpause"]',
    prev: '[data-testid="control-button-skip-back"], [aria-label="Previous"]',
    next: '[data-testid="control-button-skip-forward"], [aria-label="Next"]',
    // Title/artist normally come from the page's media session. These are DOM fallbacks:
    // the first of each pair is from older player layouts (absent in the latest diagnostics),
    // the second matches the current "now-playing-widget-v2" layout.
    title: '[data-testid="context-item-info-title"], [data-testid="now-playing-widget-v2"] a[href*="/track/"]',
    artist: '[data-testid="context-item-info-subtitles"], [data-testid="now-playing-widget-v2-byline"]',
    cover: '[data-testid="cover-art-image"], [data-testid="now-playing-widget"] img',
    pos: '[data-testid="playback-position"]',
    dur: '[data-testid="playback-duration"]',
    bar: '[data-testid="playback-progressbar"] input[type="range"]'
  } : null;
  let spotifyPlayed = false;
  let spotifyActive = 0;
  let lastShown = { text: '', at: 0 }; // when the page's position text last changed

  const refs = [];
  const meta = new WeakMap();
  const handlers = Object.create(null);
  let position = null;
  let counter = 0;
  let lastScan = 0;
  let pruneAt = 50;

  // An element is "removed" once it has been part of the page and then taken out of it.
  // Elements that were never attached (new Audio(), Spotify's detached <video>) stay tracked.
  function isRemoved(el) {
    const m = meta.get(el);
    if (el.isConnected) { m.attached = true; return false; }
    return m.attached;
  }

  // Drops dead references and elements removed from the page, so nothing is kept forever.
  function prune() {
    for (let i = refs.length - 1; i >= 0; i--) {
      const el = refs[i].deref();
      if (el && !isRemoved(el)) continue;
      if (el) meta.delete(el);
      refs.splice(i, 1);
    }
    pruneAt = Math.max(50, refs.length * 2);
  }

  // Each element is tracked once (meta is keyed by the element itself).
  function track(el) {
    if (!meta.has(el)) {
      if (refs.length >= pruneAt) prune();
      meta.set(el, { id: ++counter, active: 0, attached: false });
      refs.push(new WeakRef(el));
    }
    return meta.get(el);
  }

  function touch(el) {
    const m = track(el);
    m.active = Date.now();
    if (el.isConnected) m.attached = true;
  }

  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const p = origPlay.apply(this, arguments);
      try { Promise.resolve(p).then(() => touch(this), () => {}); } catch (e) {}
      return p;
    };
  } catch (e) {}

  try {
    const ms = window.MediaSession && window.MediaSession.prototype;
    const setHandler = ms && ms.setActionHandler;
    if (setHandler) {
      ms.setActionHandler = function (action, handler) {
        const result = setHandler.apply(this, arguments);
        if (typeof handler === 'function') handlers[action] = handler;
        else delete handlers[action];
        return result;
      };
    }
    const setPosition = ms && ms.setPositionState;
    if (setPosition) {
      ms.setPositionState = function (state) {
        const result = setPosition.apply(this, arguments);
        position = state && state.duration > 0 && isFinite(state.duration) ? state.duration : null;
        return result;
      };
    }
  } catch (e) {}

  document.addEventListener('playing', (e) => {
    if (e.target instanceof HTMLMediaElement) touch(e.target);
  }, true);

  for (const type of ['pause', 'ended']) {
    document.addEventListener(type, (e) => {
      if (e.target instanceof HTMLMediaElement && meta.has(e.target)) touch(e.target);
    }, true);
  }

  // Catches playing media we never saw start (e.g. inside shadow DOM).
  function scan(root) {
    for (const el of root.querySelectorAll('video, audio')) {
      if (!meta.has(el) && !el.paused && !el.ended) touch(el);
    }
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) scan(node.shadowRoot);
    }
  }

  function liveElements() {
    if (Date.now() - lastScan > 1500) { lastScan = Date.now(); scan(document); }
    const out = [];
    for (let i = refs.length - 1; i >= 0; i--) {
      const el = refs[i].deref();
      if (!el) { refs.splice(i, 1); continue; }
      if (isRemoved(el)) { meta.delete(el); refs.splice(i, 1); continue; }
      if (el.srcObject || (!el.currentSrc && !el.src)) continue;
      out.push(el);
    }
    return out;
  }

  const isAudible = (el) => !el.muted && el.volume > 0;
  const isBackground = (el) => el.loop || (el.muted && el.duration < 15);

  function pick(mid, skipBackground) {
    const all = liveElements().filter((el) => !(skipBackground && isBackground(el)));
    if (!all.length) return null;
    const found = mid != null && all.find((el) => meta.get(el).id === mid);
    if (found) return found;
    const playing = all.filter((el) => !el.paused && !el.ended);
    return (playing.length ? playing : all)
      .sort((a, b) => isAudible(b) - isAudible(a) || meta.get(b).active - meta.get(a).active)[0];
  }

  function parseClock(text) {
    const parts = String(text || '').trim().split(':').map(Number);
    return parts.length > 1 && parts.every((n) => n >= 0) ? parts.reduce((a, n) => a * 60 + n, 0) : 0;
  }

  // Streaming sites feed media in small pieces, so the element's own duration can be just
  // the buffered part (a few seconds). Prefer the duration the site reports, then check the element's.
  function realDuration(el) {
    if (position && el.currentTime <= position + 2) return position;
    const d = el.duration;
    if (d === Infinity) return Infinity;
    if (!isFinite(d) || d <= 0) return null;
    if (el.currentSrc.startsWith('blob:') && el.buffered.length) {
      const end = el.buffered.end(el.buffered.length - 1);
      if (Math.abs(d - end) < 0.75 && end - el.currentTime < 20) return null;
    }
    return d;
  }

  function readMetadata() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!md) return {};
      const art = Array.from(md.artwork || []).map((a) => {
        const m = /(\d+)\s*x\s*(\d+)/i.exec(a.sizes || '');
        return { src: a.src, area: m ? m[1] * m[2] : 0 };
      }).filter((a) => a.src);
      art.sort((a, b) => b.area - a.area);
      return { title: md.title || '', artist: md.artist || '', album: md.album || '', art: art.map((a) => a.src) };
    } catch (e) {
      return {};
    }
  }

  function youtubeThumb() {
    try {
      if (!/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return '';
      let id = new URLSearchParams(location.search).get('v');
      if (!id) {
        const m = /^\/(?:embed|shorts|live)\/([\w-]{6,})/.exec(location.pathname);
        id = m && m[1];
      }
      return id ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : '';
    } catch (e) {
      return '';
    }
  }

  function ogImage() {
    try {
      if (window.top !== window) return '';
      const m = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
      return m && m.content ? new URL(m.content, location.href).href : '';
    } catch (e) {
      return '';
    }
  }

  function info(el) {
    const md = readMetadata();
    const d = realDuration(el);
    return {
      build: BUILD,
      mid: meta.get(el).id,
      title: md.title || '',
      artist: md.artist || '',
      album: md.album || '',
      art: md.art || [],
      poster: el.tagName === 'VIDEO' && el.poster ? el.poster : '',
      yt: youtubeThumb(),
      og: ogImage(),
      paused: el.paused || el.ended,
      t: isFinite(el.currentTime) ? el.currentTime : 0,
      d: isFinite(d) && d > 0 ? d : null,
      live: d === Infinity,
      rate: el.playbackRate || 1,
      canPrev: typeof handlers.previoustrack === 'function',
      canNext: typeof handlers.nexttrack === 'function',
      active: meta.get(el).active,
      pageTitle: document.title || ''
    };
  }

  // Ask the site to do it through its own media-session handler when it has one, so the site's
  // own player stays in sync. Returns false when there is no handler.
  function viaSite(name, details) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return false;
    try { fn(Object.assign({ action: name }, details)); return true; } catch (e) { return false; }
  }

  function seekTo(el, time) {
    const d = realDuration(el);
    let t = Math.max(0, time);
    if (isFinite(d) && d > 0) t = Math.min(t, d);
    else if (d === Infinity && el.seekable.length) t = Math.min(t, el.seekable.end(el.seekable.length - 1));
    if (viaSite('seekto', { seekTime: t })) {
      // If the site's handler didn't actually move playback, do it directly.
      setTimeout(() => { if (!el.seeking && Math.abs(el.currentTime - t) > 2) el.currentTime = t; }, 300);
    } else {
      el.currentTime = t;
    }
  }

  const $ = (selector) => document.querySelector(selector);

  // The element carrying the song: not a background loop, and best matches the duration the page
  // shows. Muted or zero-volume elements qualify; being audible is only a tie-breaker.
  function songElement() {
    const shown = $(SP.dur) ? parseClock($(SP.dur).textContent) : 0;
    const score = (el) => (shown && Math.abs(el.duration - shown) < 2 ? 4 : 0) + (isAudible(el) ? 2 : 0) + (!el.paused && !el.ended ? 1 : 0);
    return liveElements().filter((el) => !isBackground(el))
      .sort((a, b) => score(b) - score(a) || meta.get(b).active - meta.get(a).active)[0] || null;
  }

  // Playback evidence, in order: the song element itself; the page's position text moving;
  // an English "Pause" label. Never the label alone, because the UI can be in any language.
  function spotifyPlaying() {
    const button = $(SP.play);
    if (!button) return false;
    const pos = $(SP.pos);
    const text = pos ? pos.textContent.trim() : '';
    if (text !== lastShown.text) lastShown = { text, at: lastShown.text ? Date.now() : 0 }; // first sighting isn't a change
    const song = songElement();
    if (song) return !song.paused && !song.ended;
    return Date.now() - lastShown.at < 3500 || /^pause$/i.test((button.getAttribute('aria-label') || '').trim());
  }

  // Title fallbacks when the media session has none: page DOM, then the tab title ("Song • Artist").
  function spotifyTitle(md) {
    if (md.title) return md.title;
    const node = $(SP.title);
    if (node && node.textContent.trim()) return node.textContent.trim();
    return document.title.includes(' • ') ? document.title.split(' • ')[0].trim() : '';
  }

  function spotifyInfo() {
    const md = readMetadata();
    if (!$(SP.play)) return null;
    const playing = spotifyPlaying();
    if (playing) { spotifyPlayed = true; spotifyActive = Date.now(); }
    if (!spotifyPlayed) return null;
    const title = spotifyTitle(md);
    const cover = $(SP.cover);
    const artist = $(SP.artist);
    const pos = $(SP.pos);
    const dur = $(SP.dur);
    // The page only shows whole seconds; the playing element is more precise when they agree.
    const song = songElement();
    const shown = pos ? parseClock(pos.textContent) : song ? song.currentTime : 0;
    return {
      build: BUILD,
      mid: 0,
      title,
      artist: md.artist || (artist ? artist.textContent.trim() : ''),
      album: md.album || '',
      art: (md.art || []).concat(cover && cover.src).filter(Boolean),
      paused: !playing,
      t: song && !song.paused && Math.abs(song.currentTime - shown) < 3 ? song.currentTime : shown,
      d: (dur && parseClock(dur.textContent)) || (song && isFinite(song.duration) ? song.duration : null),
      canPrev: !!$(SP.prev) || typeof handlers.previoustrack === 'function',
      canNext: !!$(SP.next) || typeof handlers.nexttrack === 'function',
      active: spotifyActive,
      pageTitle: document.title || ''
    };
  }

  function spotifySeek(time, duration) {
    const t = Math.max(0, duration ? Math.min(time, duration) : time);
    const input = $(SP.bar);
    const max = input ? Number(input.max) : 0;
    if (input && max && duration) {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(input, String(Math.round((t / duration) * max)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // If the page's own position didn't follow, move the underlying media directly.
    setTimeout(() => {
      const pos = $(SP.pos);
      if (pos && Math.abs(parseClock(pos.textContent) - t) <= 3) return;
      const el = songElement();
      if (el) el.currentTime = t;
    }, 600);
  }

  function spotifyHandle(req) {
    const state = spotifyInfo();
    if (!state) return $(SP.play) ? null : undefined;
    const press = (selector, handlerName) => { const button = $(selector); if (button) button.click(); else viaSite(handlerName); };
    switch (req.cmd) {
      case 'toggle': press(SP.play, state.paused ? 'play' : 'pause'); state.paused = !state.paused; break;
      case 'prev': press(SP.prev, 'previoustrack'); break;
      case 'next': press(SP.next, 'nexttrack'); break;
      case 'seekBy': spotifySeek(state.t + Number(req.delta || 0), state.d); break;
      case 'seekTo': spotifySeek(Number(req.time || 0), state.d); break;
      default: break;
    }
    return state;
  }

  if (SP) {
    setInterval(() => {
      if (spotifyPlaying()) { spotifyPlayed = true; spotifyActive = Date.now(); }
    }, 1000);
  }

  // Describes what this page exposes, for troubleshooting (the popup's bug button).
  function debug() {
    scan(document);
    const listed = liveElements().length;
    const elements = [];
    for (const ref of refs) {
      const el = ref.deref();
      if (!el) continue;
      const end = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : null;
      elements.push({
        tag: el.tagName, src: (el.currentSrc || el.src || '').slice(0, 12), srcObject: !!el.srcObject,
        duration: el.duration, time: el.currentTime, bufferedEnd: end, paused: el.paused, muted: el.muted,
        volume: el.volume, attached: meta.get(el).attached, connected: el.isConnected,
        readyState: el.readyState, layoutRects: el.getClientRects().length, loop: el.loop, background: isBackground(el)
      });
    }
    const out = {
      build: BUILD, url: location.href, top: window.top === window, elements, listed, tracked: refs.length,
      handlers: Object.keys(handlers), positionState: position, metadata: readMetadata()
    };
    if (SP) {
      out.spotifySelectorsFound = {};
      for (const key of Object.keys(SP)) out.spotifySelectorsFound[key] = !!$(SP[key]);
      out.spotifyState = !!spotifyInfo();
      out.spotifyPlayed = spotifyPlayed;
      out.spotifyPlayingNow = spotifyPlaying();
      out.songElementFound = !!songElement();
      out.testIds = Array.from(document.querySelectorAll('[data-testid]')).slice(0, 150).map((n) => {
        const label = n.getAttribute('aria-label');
        const text = n.children.length === 0 ? n.textContent.trim().slice(0, 24) : '';
        return n.getAttribute('data-testid') + (label ? ' | aria=' + label : '') + (text ? ' | text=' + text : '');
      });
    }
    return out;
  }

  function handle(req) {
    if (req.cmd === 'debug') return debug();
    let skipBackground = false;
    if (SP) {
      const state = spotifyHandle(req);
      if (state) return state;
      skipBackground = state === null; // player bar present but no song found: fall back, minus page decoration
    }
    const el = pick(req.mid, skipBackground);
    if (!el) return null;
    switch (req.cmd) {
      case 'toggle': {
        const resume = el.paused || el.ended;
        if (!viaSite(resume ? 'play' : 'pause')) {
          if (resume) Promise.resolve(el.play()).catch(() => {});
          else el.pause();
        }
        break;
      }
      case 'seekBy':
        seekTo(el, el.currentTime + Number(req.delta || 0));
        break;
      case 'seekTo':
        seekTo(el, Number(req.time || 0));
        break;
      case 'prev':
        viaSite('previoustrack');
        break;
      case 'next':
        viaSite('nexttrack');
        break;
      default:
        break;
    }
    return info(el);
  }

  document.addEventListener('mc:req', (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    let res = null;
    try { res = handle(req); } catch (err) {}
    document.dispatchEvent(new CustomEvent('mc:res', { detail: JSON.stringify(res) }));
  }, true);
})();
