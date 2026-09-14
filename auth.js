(function () {
  "use strict";

  var AUTH_KEY = "impose.auth.v1";
  try {
    var saved = JSON.parse(localStorage.getItem("impose.clone.v1") || "{}");
    var theme = (saved.settings && saved.settings.theme) || "dark";
    if (["dark", "light", "warm"].indexOf(theme) === -1) theme = "dark";
    document.documentElement.setAttribute("data-theme", theme);
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = theme === "light" ? "#ffffff" : (theme === "warm" ? "#faf9f5" : "#212121");
  } catch (err) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
  var pendingEmail = sessionStorage.getItem("impose.auth.pendingEmail") || "";
  var otpPurpose = sessionStorage.getItem("impose.auth.otpPurpose") || "signup";
  var toastTimer = null;
  var resendTimer = null;
  var resendRemaining = 0;

  function $(id) { return document.getElementById(id); }
  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
  function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }

  function routeName() {
    var known = ["sign-in", "sign-up", "forgot-password", "otp", "reset-password", "success"];
    var hashRoute = location.hash.replace(/^#\/?/, "").split("?")[0];
    if (known.indexOf(hashRoute) >= 0) return hashRoute;
    var pathRoute = location.pathname.replace(/\/+$/, "").split("/").pop();
    return known.indexOf(pathRoute) >= 0 ? pathRoute : "sign-in";
  }

  function route(name, replace) {
    var next = "#" + name;
    if (replace) history.replaceState(null, "", next);
    else if (location.hash !== next) location.hash = next;
    renderRoute();
  }

  function renderRoute() {
    var name = routeName();
    all(".auth-view").forEach(function (view) { view.hidden = view.dataset.view !== name; });
    document.body.dataset.route = name;
    var titles = {
      "sign-in": "Sign in · Impose",
      "sign-up": "Create account · Impose",
      "forgot-password": "Reset password · Impose",
      "otp": "Verify your email · Impose",
      "reset-password": "Choose a new password · Impose",
      "success": "Account ready · Impose"
    };
    document.title = titles[name];
    if (name === "otp") {
      $("otpEmail").textContent = pendingEmail || "your email";
      startResendCountdown();
      window.setTimeout(function () { var first = document.querySelector(".otp-input"); if (first) first.focus(); }, 40);
    }
    clearErrors();
    refreshIcons();
  }

  function setError(id, message) {
    var input = $(id);
    var error = document.querySelector('[data-error-for="' + id + '"]');
    if (error) {
      error.id = id + "Error";
      error.textContent = message || "";
    }
    if (input) {
      input.classList.toggle("invalid", Boolean(message));
      input.setAttribute("aria-invalid", message ? "true" : "false");
      if (message && error) input.setAttribute("aria-describedby", error.id);
      else input.removeAttribute("aria-describedby");
    }
  }

  function focusFirstError(form) {
    var invalid = form.querySelector('[aria-invalid="true"]');
    if (invalid && invalid.focus) invalid.focus();
  }

  function clearErrors() {
    all(".field-error").forEach(function (node) { node.textContent = ""; });
    all(".invalid").forEach(function (node) {
      node.classList.remove("invalid");
      node.removeAttribute("aria-invalid");
      node.removeAttribute("aria-describedby");
    });
  }

  function busy(form, on) {
    var button = form.querySelector('[type="submit"]');
    if (!button) return;
    button.classList.toggle("busy", on);
    button.disabled = on;
    button.setAttribute("aria-busy", on ? "true" : "false");
  }

  function briefWork(form, callback) {
    busy(form, true);
    Promise.resolve().then(function () {
      busy(form, false);
      callback();
    });
  }

  function savePending(email, purpose) {
    pendingEmail = String(email || "").trim();
    otpPurpose = purpose;
    sessionStorage.setItem("impose.auth.pendingEmail", pendingEmail);
    sessionStorage.setItem("impose.auth.otpPurpose", purpose);
  }

  function saveSession(name, email) {
    var session = { name: name || email.split("@")[0], email: email, signedInAt: Date.now() };
    localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  }

  function showToast(message) {
    var node = $("authToast");
    node.textContent = message;
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 3200);
  }

  all("[data-route]").forEach(function (button) {
    button.addEventListener("click", function () { route(button.dataset.route); });
  });

  all("[data-reveal]").forEach(function (button) {
    button.addEventListener("click", function () {
      var input = $(button.dataset.reveal);
      var reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
      button.innerHTML = '<i data-lucide="' + (reveal ? "eye-off" : "eye") + '"></i>';
      refreshIcons();
    });
  });

  all("[data-provider]").forEach(function (button) {
    button.addEventListener("click", function () {
      showToast(button.dataset.provider + " sign in is ready for backend integration.");
    });
  });

  document.querySelector(".language-btn").addEventListener("click", function () {
    showToast("English is the only language available right now.");
  });

  all(".check-row a").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      showToast("Legal document link is ready for integration.");
    });
  });

  $("signInForm").addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrors();
    var email = $("signInEmail").value.trim();
    var password = $("signInPassword").value;
    var okay = true;
    if (!validEmail(email)) { setError("signInEmail", "Enter a valid email address."); okay = false; }
    if (password.length < 8) { setError("signInPassword", "Password must be at least 8 characters."); okay = false; }
    if (!okay) { focusFirstError(event.currentTarget); return; }
    briefWork(event.currentTarget, function () {
      saveSession(email.split("@")[0], email);
      location.href = "./index.html";
    });
  });

  $("signUpPassword").addEventListener("input", function () {
    var value = this.value;
    var rules = { length: value.length >= 8, number: /\d/.test(value), special: /[^A-Za-z0-9]/.test(value) };
    Object.keys(rules).forEach(function (key) {
      var item = document.querySelector('[data-rule="' + key + '"]');
      var met = rules[key];
      var label = item.querySelector("span").textContent;
      var icon = document.createElement("i");
      icon.setAttribute("data-lucide", met ? "circle-check" : "circle");
      item.classList.toggle("met", met);
      item.setAttribute("aria-label", label + (met ? ", met" : ", not met"));
      item.replaceChild(icon, item.firstElementChild);
    });
    refreshIcons();
  });

  $("signUpForm").addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrors();
    var email = $("signUpEmail").value.trim();
    var password = $("signUpPassword").value;
    var okay = true;
    if (!validEmail(email)) { setError("signUpEmail", "Enter a valid email address."); okay = false; }
    if (password.length < 8 || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) { setError("signUpPassword", "Use 8 characters, a number, and a special character."); okay = false; }
    if (!$("terms").checked) { setError("terms", "Accept the terms to continue."); okay = false; }
    if (!okay) { focusFirstError(event.currentTarget); return; }
    savePending(email, "signup");
    sessionStorage.setItem("impose.auth.pendingName", email.split("@")[0]);
    briefWork(event.currentTarget, function () { route("otp"); });
  });

  $("forgotForm").addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrors();
    var email = $("forgotEmail").value.trim();
    if (!validEmail(email)) {
      setError("forgotEmail", "Enter the email linked to your account.");
      focusFirstError(event.currentTarget);
      return;
    }
    savePending(email, "reset");
    briefWork(event.currentTarget, function () {
      $("successTitle").textContent = "Check your inbox";
      $("successCopy").textContent = "We sent a password reset link to " + email + ".";
      var successLink = $("successAction");
      successLink.href = "#sign-in";
      successLink.textContent = "Return to sign in";
      route("success");
    });
  });

  var otpInputs = all(".otp-input");
  otpInputs.forEach(function (input, index) {
    input.addEventListener("input", function () {
      input.value = input.value.replace(/\D/g, "").slice(-1);
      $("otpError").textContent = "";
      if (input.value && otpInputs[index + 1]) otpInputs[index + 1].focus();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Backspace" && !input.value && otpInputs[index - 1]) otpInputs[index - 1].focus();
      if (event.key === "ArrowLeft" && otpInputs[index - 1]) otpInputs[index - 1].focus();
      if (event.key === "ArrowRight" && otpInputs[index + 1]) otpInputs[index + 1].focus();
    });
    input.addEventListener("paste", function (event) {
      var digits = (event.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "").slice(0, 8);
      if (!digits) return;
      event.preventDefault();
      digits.split("").forEach(function (digit, digitIndex) { if (otpInputs[digitIndex]) otpInputs[digitIndex].value = digit; });
      otpInputs[Math.min(digits.length, 8) - 1].focus();
    });
  });

  $("otpForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var code = otpInputs.map(function (input) { return input.value; }).join("");
    if (code.length !== 8) {
      $("otpError").textContent = "Enter the complete eight-digit code.";
      var emptyDigit = otpInputs.filter(function (input) { return !input.value; })[0];
      if (emptyDigit) emptyDigit.focus();
      return;
    }
    briefWork(event.currentTarget, function () {
      if (otpPurpose === "reset") route("reset-password");
      else {
        saveSession(sessionStorage.getItem("impose.auth.pendingName") || pendingEmail.split("@")[0], pendingEmail);
        $("successTitle").textContent = "Email verified";
        $("successCopy").textContent = "Your Impose account is ready to use.";
        route("success");
      }
    });
  });

  function startResendCountdown() {
    var button = $("resendBtn");
    if (resendTimer) clearInterval(resendTimer);
    resendRemaining = 60;
    button.disabled = true;
    button.textContent = "Resend code in 60s";
    resendTimer = setInterval(function () {
      resendRemaining -= 1;
      button.textContent = resendRemaining > 0 ? "Resend code in " + resendRemaining + "s" : "Resend code";
      if (resendRemaining <= 0) {
        clearInterval(resendTimer);
        resendTimer = null;
        button.disabled = false;
      }
    }, 1000);
  }

  function resendCode() {
    if (resendRemaining > 0) return;
    showToast("A new code was sent to " + (pendingEmail || "your email") + ".");
    startResendCountdown();
  }

  $("resendBtn").addEventListener("click", resendCode);
  $("inlineResend").addEventListener("click", function () {
    if (resendRemaining > 0) showToast("You can request another code in " + resendRemaining + " seconds.");
    else resendCode();
  });

  $("resetForm").addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrors();
    var password = $("resetPassword").value;
    var confirmation = $("confirmPassword").value;
    var okay = true;
    if (password.length < 8) { setError("resetPassword", "Use at least 8 characters."); okay = false; }
    if (confirmation !== password) { setError("confirmPassword", "Passwords do not match."); okay = false; }
    if (!okay) { focusFirstError(event.currentTarget); return; }
    briefWork(event.currentTarget, function () {
      $("successTitle").textContent = "Password updated";
      $("successCopy").textContent = "You can now sign in with your new password.";
      var successLink = $("successAction");
      successLink.href = "#sign-in";
      successLink.textContent = "Return to sign in";
      route("success");
    });
  });

  window.addEventListener("hashchange", renderRoute);
  renderRoute();
  refreshIcons();
})();
