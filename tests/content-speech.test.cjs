const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor() { this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.listeners = {}; }
  set innerHTML(_value) { this.children = []; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.className === selector.slice(1) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
}

async function contentHarness(permissions = ["tts"]) {
  const body = new Element();
  const timers = new Map();
  const messages = [];
  const warnings = [];
  let listener;
  let sequence = 0;
  const context = vm.createContext({
    console: { warn(...args) { warnings.push(args.join(" ")); } },
    crypto: { randomUUID() { return "request-" + ++sequence; } },
    setTimeout(callback, delay) { const id = {}; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: { body, createElement() { return new Element(); }, addEventListener() {} },
    window: {
      scrollX: 0, scrollY: 0, addEventListener() {},
      getSelection() { return { toString() { return "private selected text"; }, getRangeAt() { return { getBoundingClientRect() { return { left: 0, bottom: 20 }; } }; } }; }
    },
    chrome: {
      storage: { sync: { get(defaults, callback) { callback(defaults); } } },
      runtime: {
        id: "test-extension",
        getManifest() { return { permissions }; },
        onMessage: { addListener(value) { listener = value; } },
        sendMessage(message, callback) {
          messages.push(message);
          if (message.type === "TRANSLATE") callback({ ok: true, translated: "translated text", sourceLang: "en", targetLang: "zh-CN" });
          else if (message.type !== "SPEAK_SELECTION") callback({ ok: true });
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context);
  listener({ type: "TRANSLATE_SELECTION" }, {}, () => {});
  await Promise.resolve();
  return {
    body, timers, messages, warnings, listener,
    button: body.querySelectorAll(".ait-speech")[0],
    status: body.querySelectorAll(".ait-speech-status")[0]
  };
}

test("the foreground watchdog restores buttons if the background never responds", async () => {
  const h = await contentHarness();
  h.button.listeners.click();
  assert.equal(h.status.textContent, "正在准备发音…");
  const request = h.messages.find((message) => message.type === "SPEAK_SELECTION");
  const timer = [...h.timers.values()].find((entry) => entry.delay === 12000);
  assert.ok(timer);
  timer.callback();
  assert.match(h.status.textContent, /发音准备超时/);
  assert.equal(h.button.textContent, "原文发音");
  assert.equal(h.button.attributes["aria-pressed"], "false");
  assert.ok(h.messages.some((message) => message.type === "STOP_SELECTION_SPEECH" && message.requestId === request.requestId));
  assert.ok(h.messages.some((message) => message.type === "SPEECH_DIAGNOSTIC" && message.code === "TTS_FRONTEND_TIMEOUT"));
  h.listener({ type: "SPEECH_STATUS", requestId: request.requestId, state: "playing", voiceName: "Zira", lang: "en-US" }, {}, () => {});
  assert.match(h.status.textContent, /发音准备超时/);
  assert.ok(h.warnings.every((line) => !line.includes("private selected text")));
  assert.equal(h.timers.size, 0);
});

test("a real playing status clears the preparing watchdog; a repeated click stops", async () => {
  const h = await contentHarness();
  h.button.listeners.click();
  const request = h.messages.find((message) => message.type === "SPEAK_SELECTION");
  h.listener({ type: "SPEECH_STATUS", requestId: request.requestId, state: "playing", voiceName: "Microsoft Zira", lang: "en-US" }, {}, () => {});
  assert.equal(h.timers.size, 0);
  assert.match(h.status.textContent, /Zira.*en-US/);
  h.button.listeners.click();
  assert.equal(h.button.textContent, "原文发音");
  assert.equal(h.status.textContent, "已停止");
});

test("missing registered TTS permission asks for reload without starting or hanging", async () => {
  const h = await contentHarness([]);
  h.button.listeners.click();
  assert.match(h.status.textContent, /重新加载并确认权限/);
  assert.equal(h.button.textContent, "原文发音");
  assert.equal(h.timers.size, 0);
  assert.equal(h.messages.some((message) => message.type === "SPEAK_SELECTION"), false);
  assert.ok(h.messages.some((message) => message.code === "TTS_RELOAD_REQUIRED"));
});
