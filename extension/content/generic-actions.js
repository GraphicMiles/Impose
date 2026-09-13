/* Generic, semantic browser driver. It exposes bounded page observations and
   native actions to the extension worker; page text is data, never commands. */
(function () {
  "use strict";

  var MAX_ELEMENTS = 120;
  var MAX_PAGE_TEXT = 12000;
  var registry = Object.create(null);

  function textOf(element) {
    if (!element) return "";
    var text = element.innerText != null ? element.innerText : element.textContent;
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function labelText(element) {
    var aria = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby");
    if (aria && element.hasAttribute("aria-labelledby")) {
      aria = aria.split(/\s+/).map(function (id) {
        var label = document.getElementById(id);
        return label ? textOf(label) : "";
      }).join(" ").trim();
    }
    if (aria) return String(aria).trim();
    if (element.labels && element.labels.length) return textOf(element.labels[0]);
    return String(element.getAttribute("placeholder") || element.getAttribute("alt") ||
      element.getAttribute("title") || textOf(element) || "").trim();
  }

  function elementRole(element) {
    var explicit = element.getAttribute("role");
    if (explicit) return explicit;
    var tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea" || element.isContentEditable) return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      var type = String(element.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    return tag;
  }

  function riskOf(name) {
    var value = String(name || "").toLowerCase();
    if (/delete|remove|erase|purchase|checkout|\bbuy\b|\bpay\b|transfer|place order|close account|log ?out|sign ?out|cancel (?:subscription|booking|order|reservation)/.test(value)) {
      return "destructive";
    }
    if (/post|publish|comment|reply|send|submit|save|follow|unfollow|like|share|subscribe|\bbook\b|\breserve\b|register|sign up|create account/.test(value)) {
      return "side-effect";
    }
    return "none";
  }

  function elementRisk(element, name) {
    var identity = [name, element.value, element.getAttribute("data-testid"), element.getAttribute("name")].join(" ");
    var risk = riskOf(identity);
    var type = String(element.type || "").toLowerCase();
    var tag = String(element.tagName || "").toLowerCase();
    var submits = type === "submit" || (tag === "button" && (!type || type === "submit"));
    if (risk === "none" && submits && element.form && String(element.form.method || "get").toLowerCase() !== "get") {
      return "side-effect";
    }
    return risk;
  }

  function pageSnapshot() {
    registry = Object.create(null);
    var selector = "a,button,input,textarea,select,[role='button'],[role='link']," +
      "[role='textbox'],[role='checkbox'],[role='radio'],[contenteditable='true'],[tabindex]";
    var nodes = document.querySelectorAll(selector);
    var elements = [];
    for (var i = 0; i < nodes.length && elements.length < MAX_ELEMENTS; i++) {
      var element = nodes[i];
      if (!isVisible(element)) continue;
      if (element.closest && element.closest("[aria-hidden='true'],[inert]")) continue;
      var ref = "e" + (elements.length + 1);
      var name = labelText(element).slice(0, 180);
      registry[ref] = element;
      elements.push({
        ref: ref,
        role: elementRole(element),
        name: name,
        type: String(element.getAttribute("type") || "").slice(0, 40),
        href: element.tagName === "A" ? String(element.href || "").slice(0, 1000) : "",
        disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true",
        risk: elementRisk(element, name)
      });
    }
    var main = document.querySelector("main,[role='main']") || document.body;
    var pageText = textOf(main);
    if (pageText.length > MAX_PAGE_TEXT) pageText = pageText.slice(0, MAX_PAGE_TEXT) + "…";
    return {
      url: location.href,
      title: document.title,
      text: pageText,
      elements: elements
    };
  }

  function elementFor(ref) {
    var element = registry[String(ref || "")];
    return element && element.isConnected ? element : null;
  }

  function sensitiveField(element) {
    var type = String(element.type || "").toLowerCase();
    var autocomplete = String(element.autocomplete || "").toLowerCase();
    var identity = [element.name, element.id, element.getAttribute("aria-label")].join(" ").toLowerCase();
    return type === "password" || /cc-|one-time-code/.test(autocomplete) ||
      /password|passcode|credit.?card|card.?number|\bcvv\b|\bcvc\b|one.?time|\botp\b/.test(identity);
  }

  function setNativeValue(element, value) {
    var prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function typeInto(params) {
    var element = elementFor(params.ref);
    if (!element) return { ok: false, error: "That field is no longer available. Read the page again." };
    if (sensitiveField(element)) return { ok: false, error: "Impose will not type passwords, payment details, or one-time codes." };
    if (element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "That field is disabled or read-only." };
    }
    var value = String(params.text == null ? "" : params.text).slice(0, 20000);
    try {
      element.focus();
      if (element.isContentEditable) {
        if (params.clear !== false) {
          document.execCommand("selectAll", false, null);
        }
        if (!document.execCommand("insertText", false, value)) element.textContent = value;
      } else if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        setNativeValue(element, params.clear === false ? String(element.value || "") + value : value);
      } else {
        return { ok: false, error: "That element does not accept text." };
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, result: { typed: true, ref: params.ref, name: labelText(element).slice(0, 180) } };
    } catch (error) {
      return { ok: false, error: "Could not type into that field." };
    }
  }

  function originAllowed(params, rawUrl) {
    try {
      var origin = new URL(String(rawUrl || location.href), location.href).origin;
      return Array.isArray(params.allowedOrigins) && params.allowedOrigins.indexOf(origin) !== -1;
    } catch (error) {
      return false;
    }
  }

  function hasEnteredText(value) {
    var wanted = String(value || "").trim();
    if (!wanted) return true;
    var fields = document.querySelectorAll("input,textarea,[contenteditable='true'],[role='textbox']");
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var current = field.value != null ? String(field.value) : textOf(field);
      if (current.trim() === wanted) return true;
    }
    return false;
  }

  function clickElement(params) {
    var element = elementFor(params.ref);
    if (!element) return { ok: false, error: "That control is no longer available. Read the page again." };
    var name = labelText(element).slice(0, 180);
    var risk = elementRisk(element, name);
    if (risk === "destructive") {
      return { ok: false, error: "Destructive account, payment, and purchase actions require manual completion." };
    }
    if (risk === "side-effect" && params.public !== true) {
      return { ok: false, error: "This external action was not marked as part of the approved plan." };
    }
    if (risk === "side-effect" && !hasEnteredText(params.effectText)) {
      return { ok: false, error: "The exact approved content is not present in an editable field on this page." };
    }
    if (element.href && !originAllowed(params, element.href)) {
      return { ok: false, error: "That link now leaves the approved site origins." };
    }
    if (risk === "side-effect" && element.form && !originAllowed(params, element.form.action || location.href)) {
      return { ok: false, error: "That form now submits outside the approved site origins." };
    }
    if (!isVisible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "That control is hidden or disabled." };
    }
    try {
      var beforeUrl = location.href;
      var beforePressed = element.getAttribute("aria-pressed");
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      if (risk !== "side-effect") {
        return { ok: true, result: { clicked: true, ref: params.ref, name: name, risk: risk } };
      }
      return new Promise(function (resolve) {
        setTimeout(function () {
          var changed = location.href !== beforeUrl || !element.isConnected ||
            element.disabled || element.getAttribute("aria-disabled") === "true" ||
            element.getAttribute("aria-pressed") !== beforePressed || labelText(element).slice(0, 180) !== name;
          if (changed) {
            resolve({ ok: true, result: { clicked: true, confirmed: true, ref: params.ref, name: name, risk: risk } });
          } else {
            resolve({
              ok: false,
              uncertain: true,
              error: "The external action was clicked, but the page did not show a confirming state change. Inspect the page before retrying."
            });
          }
        }, 1200);
      });
    } catch (error) {
      return { ok: false, error: "Could not click that control." };
    }
  }

  function selectOption(params) {
    var element = elementFor(params.ref);
    if (!element || element.tagName !== "SELECT") return { ok: false, error: "That select field is no longer available." };
    var value = String(params.value == null ? "" : params.value);
    var option = Array.prototype.find.call(element.options, function (item) {
      return item.value === value || textOf(item) === value;
    });
    if (!option) return { ok: false, error: "That option was not found." };
    var risk = riskOf(labelText(element) + " " + textOf(option));
    if (risk === "destructive" || risk === "side-effect") {
      return { ok: false, error: "That selection could cause an external or destructive change and requires manual completion." };
    }
    element.value = option.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, result: { selected: option.value, ref: params.ref } };
  }

  function scrollPage(params) {
    var amount = Math.max(100, Math.min(3000, Number(params.amount) || Math.round(window.innerHeight * 0.8)));
    if (params.direction === "up") amount = -amount;
    window.scrollBy({ top: amount, left: 0, behavior: "auto" });
    return { ok: true, result: { scrolled: amount } };
  }

  function handle(message) {
    var params = message.params || {};
    if (message.method === "page.snapshot") return Promise.resolve({ ok: true, result: pageSnapshot() });
    if (["page.click", "page.type", "page.select", "page.scroll", "page.wait"].indexOf(message.method) !== -1 &&
        !originAllowed(params, location.href)) {
      return Promise.resolve({ ok: false, error: "The page moved outside the approved site origins." });
    }
    if (message.method === "page.click") return Promise.resolve(clickElement(params));
    if (message.method === "page.type") return Promise.resolve(typeInto(params));
    if (message.method === "page.select") return Promise.resolve(selectOption(params));
    if (message.method === "page.scroll") return Promise.resolve(scrollPage(params));
    if (message.method === "page.wait") {
      var delay = Math.max(0, Math.min(5000, Number(params.ms) || 500));
      return new Promise(function (resolve) {
        setTimeout(function () { resolve({ ok: true, result: { waited: delay } }); }, delay);
      });
    }
    return null;
  }

  function registerDriver() {
    chrome.runtime.onMessage.addListener(function (message, sender, reply) {
      if (!message || typeof message.method !== "string") return false;
      var work = handle(message);
      if (!work) return false;
      work.then(reply, function () { reply({ ok: false, error: "The page action failed unexpectedly." }); });
      return true;
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { riskOf: riskOf, elementRisk: elementRisk, sensitiveField: sensitiveField };
  } else {
    registerDriver();
  }
})();
