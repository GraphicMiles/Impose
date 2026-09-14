(function () {
  "use strict";

  function applyTheme() {
    try {
      var saved = JSON.parse(localStorage.getItem("impose.clone.v1") || "{}");
      var theme = (saved.settings && saved.settings.theme) || "dark";
      if (["dark", "light", "warm"].indexOf(theme) === -1) theme = "dark";
      document.documentElement.setAttribute("data-theme", theme);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = theme === "light" ? "#ffffff" : (theme === "warm" ? "#faf9f5" : "#212121");
    } catch (err) {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  }

  applyTheme();
  if (window.lucide) window.lucide.createIcons();

  var button = document.getElementById("menuBtn");
  var menu = document.getElementById("mobileNav");
  if (button && menu) {
    function setOpen(open) {
      menu.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      button.innerHTML = '<i data-lucide="' + (open ? "x" : "menu") + '"></i>';
      if (window.lucide) window.lucide.createIcons();
    }
    button.addEventListener("click", function () { setOpen(menu.hidden); });
    window.addEventListener("resize", function () { if (window.innerWidth > 850 && !menu.hidden) setOpen(false); });
  }
})();
