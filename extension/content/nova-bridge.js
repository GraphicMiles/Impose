/* Injected only on the Nova origin. Relays postMessage calls from the page
   to the background worker and posts the answers back. Same-origin only. */
(function () {
  "use strict";
  if (window.__novaBridge) return;
  var VERSION = "0.1.0";
  window.__novaBridge = { version: VERSION, protocol: 1 };
  var ORIGIN = location.origin;

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var m = e.data;
    if (!m || m.src !== "nova-page" || !m.id) return;
    if (m.method === "ping") {
      window.postMessage({ src: "nova-ext", id: m.id, ok: true, result: { version: VERSION, protocol: 1 } }, ORIGIN);
      return;
    }
    chrome.runtime.sendMessage({ id: m.id, method: m.method, params: m.params || {} }, function (resp) {
      if (chrome.runtime.lastError) {
        window.postMessage({ src: "nova-ext", id: m.id, ok: false, error: chrome.runtime.lastError.message }, ORIGIN);
        return;
      }
      window.postMessage({
        src: "nova-ext",
        id: (resp && resp.id) || m.id,
        ok: !!(resp && resp.ok),
        result: resp && ("result" in resp ? resp.result : resp),
        error: resp && resp.error
      }, ORIGIN);
    });
  });
})();
