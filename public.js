(function () {
  "use strict";

  document.documentElement.setAttribute("data-theme", "dark");
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
