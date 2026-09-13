/* Companion-extension lifecycle/security checks. Run with Node. */
"use strict";
var fs = require("fs");
var path = require("path");
var bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
var page = fs.readFileSync(path.join(__dirname, "..", "..", "app.js"), "utf8");
var actions = fs.readFileSync(path.join(__dirname, "..", "content", "x-actions.js"), "utf8");

function extract(source, name, next) {
  var start = source.indexOf("function " + name + "(");
  var end = source.indexOf(next, start);
  if (start < 0 || end < 0) throw new Error("missing " + name);
  return (0, eval)("(" + source.slice(start, end).trim() + ")");
}
function ok(v, name) { if (!v) throw new Error(name); console.log("PASS: " + name); }

var validThreadUrl = extract(bg, "validThreadUrl", "\n\nfunction gotoThread");
ok(/^https:\/\/x\.com\/messages\//.test(validThreadUrl("https://x.com/messages/123")), "X DM thread accepted");
ok(/^https:\/\/twitter\.com\/messages\//.test(validThreadUrl("https://twitter.com/messages/123")), "Twitter DM thread accepted");
ok(validThreadUrl("https://evil.example/messages/123") === "", "foreign navigation rejected");
ok(validThreadUrl("https://x.com/home") === "", "non-message X navigation rejected");
ok(validThreadUrl("javascript:alert(1)") === "", "script navigation rejected");

var sendTimeout = /var EXT_SEND_TIMEOUT = (\d+);/.exec(page);
ok(sendTimeout && +sendTimeout[1] >= 55000, "frontend timeout covers bounded navigation and confirmation path");
ok(actions.indexOf("confirmed: true") !== -1, "send success requires explicit confirmation");
ok(actions.indexOf("Check the thread before retrying") !== -1, "unconfirmed click has an uncertain terminal state");
ok(page.indexOf('extLog("send", "Waiting for confirmation from X", null)') !== -1, "action ledger starts pending, not successful");
ok(page.indexOf("finishExtLog(sendLog") !== -1, "action ledger finalizes its original entry");
console.log("10 passed, 0 failed");
