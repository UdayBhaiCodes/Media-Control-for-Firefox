(() => {
  'use strict';

  function call(req) {
    let out = null;
    const onRes = (e) => { out = e.detail; };
    document.addEventListener('mc:res', onRes, true);
    try {
      document.dispatchEvent(new CustomEvent('mc:req', { detail: JSON.stringify(req) }));
    } finally {
      document.removeEventListener('mc:res', onRes, true);
    }
    try { return typeof out === 'string' ? JSON.parse(out) : null; } catch (e) { return null; }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.mc !== 1) return undefined;
    return Promise.resolve(call(msg));
  });
})();
