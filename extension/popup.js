/* Tiny status popup. Reads the last background heartbeat, nothing else. */
(function () {
  "use strict";
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    return Math.round(s / 60) + "m ago";
  }
  try {
    chrome.storage.local.get("novaStatus", function (out) {
      var el = document.getElementById("st");
      var s = out && out.novaStatus;
      if (!s) { el.textContent = "Installed. Open Nova and connect it."; return; }
      el.textContent = "X tabs seen: " + (s.tabs == null ? "?" : s.tabs) +
        (s.last ? " · last action " + s.last + (s.ok ? " ok" : " failed") : "") +
        " · " + ago(s.at);
    });
  } catch (e) {
    document.getElementById("st").textContent = "Installed.";
  }
  document.getElementById("open").addEventListener("click", function () {
    chrome.tabs.create({ url: "https://impose-web.onrender.com/" });
  });
})();
