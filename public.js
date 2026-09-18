(function () {
  "use strict";

  document.documentElement.setAttribute("data-theme", "dark");
  if (window.lucide) window.lucide.createIcons();

  /* ---- mobile navigation ---- */
  var button = document.getElementById("menuBtn");
  var menu = document.getElementById("mobileNav");
  if (button && menu) {
    var setOpen = function (open) {
      menu.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      button.innerHTML = '<i data-lucide="' + (open ? "x" : "menu") + '"></i>';
      if (window.lucide) window.lucide.createIcons();
    };
    button.addEventListener("click", function () { setOpen(menu.hidden); });
    window.addEventListener("resize", function () { if (window.innerWidth > 850 && !menu.hidden) setOpen(false); });
    /* Escape closes it, like every other dismissible surface in the product.
       Tapping a link closes it too, so the menu is never left hanging open
       over the destination after an in-page jump. */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) { setOpen(false); button.focus(); }
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
  }

  /* ---- 404: "Go back" must actually go somewhere ----
     If there is history to return to, use it. If the page was opened from a
     bad link in a fresh tab there is no history, so the control would be a
     dead button. In that case it is relabelled and sends the reader to the
     app instead. No control that looks functional is allowed to do nothing. */
  var backBtn = document.getElementById("backBtn");
  if (backBtn) {
    var canGoBack = window.history.length > 1 && document.referrer !== "";
    if (!canGoBack) {
      backBtn.innerHTML = '<i data-lucide="info"></i><span>Read about Impose</span>';
      if (window.lucide) window.lucide.createIcons();
      backBtn.addEventListener("click", function () { window.location.href = "./about"; });
    } else {
      backBtn.addEventListener("click", function () { window.history.back(); });
    }
  }

  /* ---- table of contents: mark the section being read ----
     The legal pages are long and the sidebar gave no sense of position.
     IntersectionObserver only, never a scroll listener. */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a[href^='#']"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    var targets = [];
    tocLinks.forEach(function (a) {
      var el = document.getElementById(a.getAttribute("href").slice(1));
      if (el) { byId[el.id] = a; targets.push(el); }
    });
    var visible = {};
    var mark = function () {
      var current = null;
      targets.forEach(function (el) { if (visible[el.id] && !current) current = el.id; });
      tocLinks.forEach(function (a) { a.removeAttribute("aria-current"); });
      if (current && byId[current]) byId[current].setAttribute("aria-current", "true");
    };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { visible[entry.target.id] = entry.isIntersecting; });
      mark();
    }, { rootMargin: "-92px 0px -65% 0px", threshold: 0 });
    targets.forEach(function (el) { io.observe(el); });
  }
})();
