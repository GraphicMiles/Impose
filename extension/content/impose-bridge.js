/* Injected only on the Impose origin. Relays postMessage calls from the page
   to the background worker and posts the answers back. Same-origin only. */
(function () {
  "use strict";
  if (window.__imposeBridge) return;
  var VERSION = "0.2.0";
  window.__imposeBridge = { version: VERSION, protocol: 2 };
  var ORIGIN = location.origin;

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var m = e.data;
    if (!m || m.src !== "impose-page" || !m.id) return;
    if (m.method === "ping") {
      window.postMessage({ src: "impose-ext", id: m.id, ok: true, result: { version: VERSION, protocol: 2 } }, ORIGIN);
      return;
    }
    chrome.runtime.sendMessage({ id: m.id, method: m.method, params: m.params || {} }, function (resp) {
      if (chrome.runtime.lastError) {
        window.postMessage({ src: "impose-ext", id: m.id, ok: false, error: chrome.runtime.lastError.message }, ORIGIN);
        return;
      }
      window.postMessage({
        src: "impose-ext",
        id: (resp && resp.id) || m.id,
        ok: !!(resp && resp.ok),
        result: resp && ("result" in resp ? resp.result : resp),
        error: resp && resp.error,
        uncertain: !!(resp && resp.uncertain)
      }, ORIGIN);
    });
  });
})();
