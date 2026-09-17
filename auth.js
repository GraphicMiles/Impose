(function () {
  "use strict";

  var AUTH_KEY = "impose.auth.v1";
  document.documentElement.setAttribute("data-theme", "dark");
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

  /* With Supabase configured these forms talk to a real backend. Without
     it the page keeps its previous local behaviour so the demo still
     deploys; `live()` is the switch, and every caller has both paths. */
  function live() {
    return !!(window.BotoAuth && window.BotoAuth.configured());
  }

  /* Shows a server error against the field the user can actually fix. */
  function failOn(form, id, error) {
    busy(form, false);
    var message = (error && error.message) || "Something went wrong. Try again.";
    if (id) { setError(id, message); focusFirstError(form); }
    else showToast(message);
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

  $("signInForm").addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrors();
    var email = $("signInEmail").value.trim();
    var password = $("signInPassword").value;
    var okay = true;
    if (!validEmail(email)) { setError("signInEmail", "Enter a valid email address."); okay = false; }
    if (password.length < 8) { setError("signInPassword", "Password must be at least 8 characters."); okay = false; }
    if (!okay) { focusFirstError(event.currentTarget); return; }
    var form = event.currentTarget;
    if (!live()) {
      briefWork(form, function () {
        saveSession(email.split("@")[0], email);
        location.href = "./index.html";
      });
      return;
    }
    busy(form, true);
    window.BotoAuth.signIn(email, password).then(function () {
      location.href = "./index.html";
    }, function (err) {
      /* Against the password field, not the email: saying "no such
         account" would confirm which addresses are registered. */
      failOn(form, "signInPassword", err);
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
    var form = event.currentTarget;
    if (!live()) {
      briefWork(form, function () { route("otp"); });
      return;
    }
    busy(form, true);
    /* The account is created first so a taken address fails here, before
       an email goes out. */
    window.BotoAuth.signUp(email, password).then(function () {
      busy(form, false);
      route("otp");
      startResendCountdown();
    }, function (err) {
      failOn(form, "signUpEmail", err);
    });
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
    var form = event.currentTarget;
    if (!live()) {
      briefWork(form, function () { route("otp"); startResendCountdown(); });
      return;
    }
    busy(form, true);
    /* Always reports success. Whether the address has an account is not
       the browser's business, and telling it here would turn this form
       into an account checker. */
    window.BotoAuth.requestReset(email).then(function () {
      busy(form, false);
      route("otp");
      startResendCountdown();
    }, function (err) {
      /* A transport or rate-limit failure is worth saying: the user needs
         to know no code is coming. */
      failOn(form, "forgotEmail", err);
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
    var form = event.currentTarget;

    function onVerified() {
      if (otpPurpose === "reset") {
        /* Carry the code forward: setting the new password needs it to
           prove, to the server, that this browser held the code. */
        sessionStorage.setItem("impose.auth.otpCode", code);
        route("reset-password");
        return;
      }
      saveSession(sessionStorage.getItem("impose.auth.pendingName") || pendingEmail.split("@")[0], pendingEmail);
      $("successTitle").textContent = "Email verified";
      $("successCopy").textContent = "Your Impose account is ready to use.";
      route("success");
    }

    if (!live()) { briefWork(form, onVerified); return; }

    busy(form, true);
    if (otpPurpose === "reset") {
      /* Do not spend the code here. The reset screen exchanges it for a
         session and sets the password in one step; verifying now would
         consume it and the exchange would then fail. */
      busy(form, false);
      onVerified();
      return;
    }
    window.BotoAuth.verifyCode(pendingEmail, "signup", code).then(function () {
      busy(form, false);
      onVerified();
    }, function (err) {
      busy(form, false);
      $("otpError").textContent = err.message || "That code is not right.";
      otpInputs.forEach(function (input) { input.value = ""; });
      otpInputs[0].focus();
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
    if (!live()) {
      showToast("A new code was sent to " + (pendingEmail || "your email") + ".");
      startResendCountdown();
      return;
    }
    /* Start the countdown immediately, before the request resolves. The
       button is the thing being double-tapped, so it has to go inert on
       the first press rather than on the reply. The server enforces its
       own cooldown regardless; this is only about the button. */
    startResendCountdown();
    window.BotoAuth.requestCode(pendingEmail, otpPurpose).then(function () {
      showToast("A new code was sent to " + (pendingEmail || "your email") + ".");
    }, function (err) {
      showToast(err.message || "Could not send a new code. Try again shortly.");
    });
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
    var form = event.currentTarget;

    function done() {
      sessionStorage.removeItem("impose.auth.otpCode");
      $("successTitle").textContent = "Password updated";
      $("successCopy").textContent = "You can now sign in with your new password.";
      var successLink = $("successAction");
      successLink.href = "#sign-in";
      successLink.textContent = "Return to sign in";
      route("success");
    }

    if (!live()) { briefWork(form, done); return; }

    var code = sessionStorage.getItem("impose.auth.otpCode") || "";
    if (!code) {
      /* The code is gone: a refresh, a new tab, or an expired session.
         Send them back rather than failing at the server with something
         cryptic. */
      showToast("That reset link expired. Request a new code.");
      route("forgot-password");
      return;
    }
    busy(form, true);
    window.BotoAuth.completeReset(pendingEmail, code, password).then(function () {
      busy(form, false);
      done();
    }, function (err) {
      failOn(form, "resetPassword", err);
    });
  });

  window.addEventListener("hashchange", renderRoute);
  renderRoute();
  refreshIcons();
})();
