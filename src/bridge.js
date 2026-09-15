/**
 * ISOLATED-world bridge — two-way relay between the MAIN-world agent and the
 * service worker. The agent cannot reach chrome.runtime; the service worker
 * cannot reach the page realm.
 */
(() => {
  'use strict';

  const OUT = '__igfo_out__'; // MAIN -> here
  const IN = '__igfo_in__'; // here -> MAIN

  // MAIN -> service worker
  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data[OUT] !== 1) return;

      const payload = { ...data };
      delete payload[OUT];
      payload.href = payload.href || window.location.href;

      try {
        chrome.runtime.sendMessage({ type: 'IGFO_EVENT', payload }, () => {
          void chrome.runtime.lastError; // no listener / panel closed
        });
      } catch (_) {
        // Extension reloaded; the page will be re-injected on refresh.
      }
    },
    false
  );

  // service worker -> MAIN
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'IGFO_COMMAND') return undefined;
    try {
      window.postMessage({ [IN]: 1, command: message.command }, window.location.origin);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return true;
  });
})();
