const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const zira = { voiceName: "Microsoft Zira Desktop - English (United States)", lang: "en-US" };
const huihui = { voiceName: "Microsoft Huihui - Chinese (Simplified, PRC)", lang: "zh-CN" };
const sender = { tab: { id: 7 }, frameId: 0 };
const message = (requestId, lang = "en") => ({ requestId, lang, text: "Hello world" });

function harness() {
  const timers = new Map();
  const context = vm.createContext({
    setTimeout(callback, delay) {
      const id = {};
      timers.set(id, { callback, delay });
      if (delay === 250) queueMicrotask(() => { if (timers.delete(id)) callback(); });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "speech.js"), "utf8") + "\nglobalThis.subject = AitSpeech;", context);
  const events = [];
  const calls = [];
  const api = {
    runtime: {},
    tts: {
      getVoices(callback) { callback([zira, huihui]); },
      speak(text, options, callback) { calls.push({ text, options }); callback(); },
      stop() { api.stops++; }
    },
    stops: 0
  };
  return {
    subject: context.subject, api, events, calls, timers,
    controller: context.subject.createController(api, (request, event) => events.push({ request, ...event }))
  };
}

test("English is always US; language aliases retain Chinese script and other locales", () => {
  const { subject } = harness();
  for (const lang of ["en", "en-GB", "EN_us", "en-AU"]) assert.equal(subject.resolveLanguage(lang), "en-US");
  for (const [input, output] of [["zh", "zh-CN"], ["zh-Hans-CN", "zh-CN"], ["zh-Hant", "zh-TW"], ["fr", "fr-FR"], ["es-MX", "es-MX"]]) {
    assert.equal(subject.resolveLanguage(input), output);
  }
  assert.equal(subject.resolveLanguage("xx"), null);
  assert.equal(subject.resolveLanguage(null), null);
});

test("only known native Microsoft female voices with matching locale are selected", () => {
  const { subject } = harness();
  assert.equal(subject.selectVoice([zira, huihui], "en-GB").voice, zira);
  assert.equal(subject.selectVoice([zira, huihui], "zh-CN").voice, huihui);
  for (const invalid of [
    { ...zira, voiceName: "Microsoft David Desktop - English (United States)" },
    { ...zira, lang: "en-GB" },
    { ...zira, gender: "male" },
    { ...zira, remote: true },
    { ...zira, extensionId: "third-party" },
    { ...zira, voiceName: "Google US English" }
  ]) assert.throws(() => subject.selectVoice([invalid], "en"), /en-US/);
  assert.throws(() => subject.selectVoice([], "en"), /Zira/);
  assert.throws(() => subject.selectVoice([zira], null), /识别/);
  assert.throws(() => subject.selectVoice([zira], "ru"), /不支持/);
});

test("start/end events drive playback state and the exact voice is pinned", async () => {
  const h = harness();
  assert.equal((await h.controller.play(message("source"), sender)).ok, true);
  assert.equal(h.events.length, 0);
  const { options } = h.calls[0];
  assert.equal(options.voiceName, zira.voiceName);
  assert.equal(options.lang, "en-US");
  assert.equal(options.enqueue, false);
  assert.deepEqual(Array.from(options.requiredEventTypes), ["start", "end"]);
  options.onEvent({ type: "start" });
  assert.equal(h.events[0].state, "playing");
  assert.equal(h.events[0].lang, "en-US");
  options.onEvent({ type: "end" });
  assert.equal(h.events[1].state, "stopped");
  assert.equal(h.timers.size, 0);
});

test("switching source/translation cancels previous speech and ignores its late events", async () => {
  const h = harness();
  await h.controller.play(message("source"), sender);
  h.calls[0].options.onEvent({ type: "start" });
  await h.controller.play(message("target", "zh-CN"), sender);
  assert.equal(h.api.stops, 1);
  assert.equal(h.calls[1].options.voiceName, huihui.voiceName);
  h.calls[1].options.onEvent({ type: "start" });
  const count = h.events.length;
  h.calls[0].options.onEvent({ type: "end" });
  assert.equal(h.events.length, count);
  h.controller.stop("source", sender);
  assert.equal(h.api.stops, 1);
  h.controller.stop("target", sender);
  assert.equal(h.api.stops, 2);
  assert.equal(h.timers.size, 0);
});

test("stopping before voice enumeration completes cannot resurrect closed speech", async () => {
  const h = harness();
  const callbacks = [];
  h.api.tts.getVoices = (callback) => callbacks.push(callback);
  const first = h.controller.play(message("old"), sender);
  const second = h.controller.play(message("new", "zh-CN"), sender);
  callbacks[0]([zira, huihui]);
  await first;
  assert.equal(h.calls.length, 0);
  h.controller.stop("new", sender);
  callbacks[1]([zira, huihui]);
  await second;
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
});

test("cold-start native voice discovery is retried without using a default voice", async () => {
  const h = harness();
  let enumerations = 0;
  h.api.tts.getVoices = (callback) => callback(++enumerations < 3 ? [] : [zira]);
  await h.controller.play(message("cold-start"), sender);
  assert.equal(enumerations, 3);
  assert.equal(h.calls[0].options.voiceName, zira.voiceName);
  h.controller.stop("cold-start", sender);
  assert.equal(h.timers.size, 0);
});

test("only the owning frame/request can stop speech; tab navigation/closure stops it", async () => {
  const h = harness();
  await h.controller.play(message("owned"), sender);
  h.controller.stop("owned", { tab: { id: 8 }, frameId: 0 });
  h.controller.stop("owned", { tab: { id: 7 }, frameId: 1 });
  h.controller.stopTab(8);
  assert.equal(h.api.stops, 0);
  h.controller.stopTab(7);
  assert.equal(h.api.stops, 1);
  assert.equal(h.timers.size, 0);
});

test("missing voices, API failures and engine errors are explicit and clear active state", async () => {
  for (const failure of ["empty", "getVoices", "speak", "event"]) {
    const h = harness();
    if (failure === "empty") h.api.tts.getVoices = (callback) => callback([]);
    if (failure === "getVoices") h.api.tts.getVoices = (callback) => {
      h.api.runtime.lastError = { message: "voice enumeration failed" };
      callback();
      delete h.api.runtime.lastError;
    };
    if (failure === "speak") h.api.tts.speak = (_text, _options, callback) => {
      h.api.runtime.lastError = { message: "audio device failed" };
      callback();
      delete h.api.runtime.lastError;
    };
    if (failure === "event") {
      await h.controller.play(message(failure), sender);
      h.calls[0].options.onEvent({ type: "error", errorMessage: "engine failed" });
    } else await assert.rejects(h.controller.play(message(failure), sender));
    assert.equal(h.events.at(-1).state, "error");
    assert.ok(h.events.at(-1).error);
    assert.equal(h.timers.size, 0);
  }
});

test("start and playback watchdogs stop unresponsive engines", async () => {
  for (const started of [false, true]) {
    const h = harness();
    await h.controller.play(message("timeout"), sender);
    if (started) h.calls[0].options.onEvent({ type: "start" });
    const timer = [...h.timers.values()][0];
    assert.equal(timer.delay, started ? 300000 : 10000);
    timer.callback();
    assert.equal(h.events.at(-1).state, "error");
    assert.equal(h.api.stops, 1);
    assert.equal(h.timers.size, 0);
  }
});

test("empty/oversized input and missing browser API fail without speaking", async () => {
  const h = harness();
  for (const text of ["", " ", "x".repeat(32769)]) {
    await assert.rejects(h.controller.play({ ...message("invalid"), text }, sender));
  }
  await assert.rejects(h.controller.play(message("no-tab"), {}));
  delete h.api.tts;
  await assert.rejects(h.controller.play(message("no-api"), sender), /不支持/);
  assert.equal(h.calls.length, 0);
});

function backgroundHarness(config = {}, modelOutput = null) {
  let listener;
  const requests = [];
  const event = { addListener() {} };
  const chrome = {
    runtime: { onInstalled: event, onMessage: { addListener(value) { listener = value; } } },
    contextMenus: { onClicked: event },
    tabs: { onRemoved: event, onUpdated: event },
    storage: {
      sync: { get(defaults, callback) { callback({ ...defaults, ...config }); } },
      local: { async get() { return {}; }, async set() {} }
    },
    i18n: { detectLanguage(_text, callback) { callback({ isReliable: false, languages: [] }); } }
  };
  const context = vm.createContext({
    chrome, console: { log() {} }, setTimeout, clearTimeout,
    async fetch(url, options) {
      requests.push({ url, options });
      if (modelOutput !== null) return { ok: true, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelOutput) } }] }); } };
      return { ok: true, async json() { return [[["你好", "Hello"]], null, "en"]; } };
    }
  });
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  return { requests, send: (msg) => new Promise((resolve) => listener(msg, sender, resolve)) };
}

test("Google selection returns detected source plus target; page batches still contain strings", async () => {
  const h = backgroundHarness();
  const single = await h.send({ type: "TRANSLATE", text: "Hello", targetLang: "zh-CN" });
  assert.equal(single.ok, true);
  assert.equal(single.translated, "你好");
  assert.equal(single.sourceLang, "en");
  assert.equal(single.targetLang, "zh-CN");
  const batch = await h.send({ type: "TRANSLATE_BATCH", texts: ["Hello", "Hello"], targetLang: "zh-CN" });
  assert.deepEqual(Array.from(batch.results), ["你好", "你好"]);
  assert.match(h.requests[0].url, /sl=auto&tl=zh-CN/);
});

test("custom model selection requests source metadata without changing batch/test array protocol", async () => {
  const config = { provider: "openai", apiUrl: "https://translation.invalid/v1" };
  const h = backgroundHarness(config, { sourceLang: "en-GB", translations: ["你好"] });
  const single = await h.send({ type: "TRANSLATE", text: "Hello" });
  assert.equal(single.ok, true);
  assert.equal(single.sourceLang, "en-GB");
  assert.equal(single.translated, "你好");
  assert.match(JSON.parse(h.requests[0].options.body).messages[0].content, /sourceLang/);
  const legacy = backgroundHarness(config, ["你好"]);
  assert.equal((await legacy.send({ type: "TRANSLATE", text: "Hello" })).sourceLang, null);
  assert.equal((await legacy.send({ type: "TRANSLATE_BATCH", texts: ["Hello"] })).results[0], "你好");
  assert.equal((await legacy.send({ type: "TEST" })).sample, "你好");
  assert.doesNotMatch(JSON.parse(legacy.requests[1].options.body).messages[0].content, /sourceLang/);
});

test("invalid model metadata response produces an explicit translation failure", async () => {
  const h = backgroundHarness({ provider: "openai", apiUrl: "https://translation.invalid" }, { sourceLang: "en" });
  const result = await h.send({ type: "TRANSLATE", text: "Hello" });
  assert.equal(result.ok, false);
  assert.match(result.error, /有效译文/);
});

test("content script acknowledges speech status even when the result was closed", () => {
  let listener;
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), context);
  let acknowledged = false;
  listener({ type: "SPEECH_STATUS", requestId: "closed-result", state: "playing" }, {}, (reply) => { acknowledged = reply.ok; });
  assert.equal(acknowledged, true);
});
