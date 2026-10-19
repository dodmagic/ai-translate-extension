const { spawn } = require("node:child_process");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const assert = require("node:assert/strict");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); }
  };
}

async function main() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ai-translate-chrome-"));
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><html><body><p id='sample'>Hello world. This is a pronunciation test.</p><p id='chinese'>你好，欢迎使用划词翻译。</p></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const chrome = spawn(process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--user-data-dir=" + profile, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-size=1100,800", "about:blank"
  ], { stdio: "ignore" });
  const clients = [];
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
      catch (error) { if (!["ENOENT", "EBUSY"].includes(error.code)) throw error; await wait(100); }
    }
    assert.ok(port, "Chrome did not expose its isolated debugging endpoint");
    const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
    const browser = await connect(version.webSocketDebuggerUrl);
    clients.push(browser);
    const loaded = await browser.call("Extensions.loadUnpacked", { path: path.resolve(__dirname, "..") });
    console.log("CHROME", version.Browser, "EXTENSION", loaded.id);
    let targets;
    for (let i = 0; i < 50; i++) {
      targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
      if (targets.some((target) => target.type === "service_worker")) break;
      await wait(100);
    }
    const workerTarget = targets.find((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://" + loaded.id));
    assert.ok(workerTarget, "Extension service worker did not start");
    const worker = await connect(workerTarget.webSocketDebuggerUrl);
    clients.push(worker);
    await worker.call("Runtime.enable");
    await worker.call("Runtime.runIfWaitingForDebugger");
    const evaluate = async (client, expression) => {
      const result = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    console.log("WORKER_READY", await evaluate(worker, "({ready:!!chrome.tts, version:chrome.runtime.getManifest().version})"));
    const target = await browser.call("Target.createTarget", { url: "http://127.0.0.1:" + server.address().port });
    const pageTargets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
    const page = await connect(pageTargets.find((entry) => entry.id === target.targetId).webSocketDebuggerUrl);
    clients.push(page);
    await wait(1500);
    const tabId = await evaluate(worker, "chrome.tabs.query({url:'http://127.0.0.1/*'}).then(t => t[0].id)");
    await evaluate(worker, "globalThis.nativeEvents = []; globalThis.nativeSpeak = chrome.tts.speak; chrome.tts.speak = (text, options, callback) => { const onEvent = options.onEvent; options.onEvent = event => { nativeEvents.push(event); onEvent(event); }; nativeEvents.push({request:options.voiceName,lang:options.lang}); nativeSpeak(text, options, callback); }; true");
    const status = () => evaluate(page, "document.querySelector('.ait-speech-status')?.textContent || ''");
    async function waitStatus(pattern) {
      let value;
      for (let i = 0; i < 65; i++) {
        value = await status();
        if (pattern.test(value)) return value;
        await wait(200);
      }
      assert.match(value, pattern);
    }
    async function translate(selector, targetLang) {
      await evaluate(worker, `chrome.storage.sync.set({targetLang:${JSON.stringify(targetLang)}})`);
      await evaluate(page, `getSelection().selectAllChildren(document.querySelector(${JSON.stringify(selector)})); true`);
      await evaluate(worker, `chrome.tabs.sendMessage(${tabId}, {type:'TRANSLATE_SELECTION'})`);
      for (let i = 0; i < 100; i++) {
        if (await evaluate(page, "!!document.querySelector('.ait-speech') || document.querySelector('.ait-result')?.textContent?.includes('失败')")) break;
        await wait(200);
      }
      console.log("TRANSLATION", await evaluate(page, "document.querySelector('.ait-result')?.textContent"));
      assert.equal(await evaluate(page, "document.querySelectorAll('.ait-speech').length"), 2);
    }
    const clickSpeech = (index) => evaluate(page, `document.querySelectorAll('.ait-speech')[${index}].click(); true`);
    const isSpeaking = () => evaluate(worker, "new Promise(resolve => chrome.tts.isSpeaking(resolve))");
    await translate("#sample", "zh-CN");
    await clickSpeech(0);
    console.log("SOURCE_SPEECH", await waitStatus(/Zira.*en-US/));
    await clickSpeech(1);
    console.log("TARGET_SPEECH", await waitStatus(/Huihui.*zh-CN/));
    const events = await evaluate(worker, "nativeEvents.filter(e=>e.request || ['start','end','interrupted','cancelled'].includes(e.type))");
    console.log("NATIVE_EVENTS", events);
    assert.ok(events.some((event) => ["interrupted", "cancelled"].includes(event.type)));
    await evaluate(page, "document.querySelectorAll('.ait-speech')[1].click(); true");
    await wait(100);
    assert.equal(await isSpeaking(), false);
    console.log("STOP_BUTTON", await status());
    await clickSpeech(0);
    await waitStatus(/Zira/);
    await evaluate(page, "document.querySelector('.ait-close').click(); true");
    await wait(100);
    assert.equal(await isSpeaking(), false);
    assert.equal(await evaluate(page, "!!document.querySelector('.ait-result')"), false);
    console.log("CLOSE_STOPS", true);
    await translate("#chinese", "en");
    await clickSpeech(0);
    console.log("CHINESE_SOURCE", await waitStatus(/Huihui.*zh-CN/));
    await clickSpeech(1);
    console.log("ENGLISH_TARGET", await waitStatus(/Zira.*en-US/));
    await waitStatus(/已停止/);
    assert.equal(await isSpeaking(), false);
    assert.ok((await evaluate(worker, "nativeEvents")).some((event) => event.type === "end"));
    console.log("NATURAL_COMPLETION", true);
    await translate("#sample", "de");
    await clickSpeech(1);
    console.log("REAL_MISSING_GERMAN_VOICE", await waitStatus(/未找到 de-DE 微软女声/));
    assert.equal(await isSpeaking(), false);
    await evaluate(worker, "globalThis.instrumentedSpeak=chrome.tts.speak; chrome.tts.speak=(_text,options,callback)=>{callback();setTimeout(()=>options.onEvent({type:'error',errorMessage:'simulated engine failure'}),0);}; true");
    await clickSpeech(0);
    console.log("SIMULATED_ENGINE_FAILURE_UI", await waitStatus(/发音失败：simulated engine failure/));
    await evaluate(worker, "chrome.tts.speak=instrumentedSpeak; true");
    await clickSpeech(0);
    await waitStatus(/Zira/);
    await evaluate(page, "document.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); true");
    await wait(100);
    assert.equal(await isSpeaking(), false);
    assert.equal(await evaluate(page, "!!document.querySelector('.ait-result')"), false);
    console.log("OUTSIDE_CLOSE_STOPS", true);
    await evaluate(worker, `chrome.tabs.sendMessage(${tabId}, {type:'TRANSLATE_PAGE'})`);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(page, "document.querySelectorAll('.ait-inline').length >= 1")) break;
      await wait(200);
    }
    assert.ok(await evaluate(page, "document.querySelectorAll('.ait-inline').length >= 1"));
    console.log("PAGE_TRANSLATION", await evaluate(page, "Array.from(document.querySelectorAll('.ait-inline'), e => e.textContent)"));
    await evaluate(worker, `chrome.tabs.sendMessage(${tabId}, {type:'TRANSLATE_PAGE'})`);
    assert.equal(await evaluate(page, "document.querySelectorAll('.ait-inline').length"), 0);
    console.log("PAGE_RESTORE", true);
    await translate("#sample", "zh-CN");
    await clickSpeech(0);
    await waitStatus(/Zira/);
    await page.call("Page.navigate", { url: "http://127.0.0.1:" + server.address().port + "/next" });
    await wait(500);
    assert.equal(await isSpeaking(), false);
    console.log("NAVIGATION_STOPS", true);
    await evaluate(worker, "globalThis.realTranslate=googleTranslate; googleTranslate=async(text)=>{await new Promise(r=>setTimeout(r,text.startsWith('Hello')?500:20));return {translated:text.startsWith('Hello')?'old translation':'new translation',sourceLang:text.startsWith('Hello')?'en':'zh-CN'};}; true");
    await evaluate(page, "getSelection().selectAllChildren(document.querySelector('#sample')); true");
    await evaluate(worker, `chrome.tabs.sendMessage(${tabId}, {type:'TRANSLATE_SELECTION'})`);
    await wait(50);
    await evaluate(page, "getSelection().selectAllChildren(document.querySelector('#chinese')); true");
    await evaluate(worker, `chrome.tabs.sendMessage(${tabId}, {type:'TRANSLATE_SELECTION'})`);
    await wait(700);
    assert.equal(await evaluate(page, "document.querySelector('.ait-result-text').textContent"), "new translation");
    console.log("SIMULATED_OUT_OF_ORDER_TRANSLATIONS", true);
    await evaluate(worker, "googleTranslate=realTranslate; true");
  } finally {
    if (clients[0]) {
      try { await clients[0].call("Browser.close"); }
      catch (error) { console.error("Browser cleanup:", error.message); }
    }
    for (const client of clients) client.close();
    chrome.kill();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log("ISOLATED_PROFILE_REMOVED", true);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
