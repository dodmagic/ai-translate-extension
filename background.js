// AI 翻译 - 后台服务
// 引擎：google(免费) / openai(OpenAI/Azure Foundry 兼容)
importScripts("speech.js");

const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const DEFAULTS = { targetLang: "zh-CN", provider: "google", apiUrl: "", apiKey: "", model: "gpt-5.4-mini" };

const speech = AitSpeech.createController(chrome, (request, status) => {
  chrome.tabs.sendMessage(request.tabId, status, { frameId: request.frameId }, () => {
    if (chrome.runtime.lastError && status.state === "playing") {
      speech.stop(request.id, { tab: { id: request.tabId }, frameId: request.frameId });
    }
  });
});
chrome.tabs.onRemoved.addListener((tabId) => speech.stopTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") speech.stopTab(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "sel", title: "AI 翻译选中文字", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "page", title: "翻译整个页面（中英对照）", contexts: ["page"] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "sel") chrome.tabs.sendMessage(tab.id, { type: "TRANSLATE_SELECTION" });
  else if (info.menuItemId === "page") chrome.tabs.sendMessage(tab.id, { type: "TRANSLATE_PAGE" });
});

const langName = (c) => ({ "zh-CN":"简体中文","zh-TW":"繁体中文","en":"English","ja":"日语","ko":"韩语","fr":"法语","de":"德语","es":"西班牙语" }[c] || c);

// 日志：写入 storage 供弹窗排错
async function log(line) {
  const t = new Date().toLocaleTimeString();
  const { aitLog = [] } = await chrome.storage.local.get("aitLog");
  aitLog.unshift("[" + t + "] " + line);
  console.log("[AI翻译]", line);
  await chrome.storage.local.set({ aitLog: aitLog.slice(0, 30) });
}

// 规范化 URL：兼容 OpenAI / Azure(v1 或经典) / Foundry
function buildUrl(apiUrl) {
  let u = (apiUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u + "/chat/completions";
  if (/openai\.azure\.com$/.test(u)) return u + "/openai/v1/chat/completions";
  return u + "/v1/chat/completions";
}

async function googleTranslate(text, lang) {
  const r = await fetch(`${GOOGLE_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  return { translated: (data[0] || []).map((s) => s[0]).join(""), sourceLang: data[2] || null };
}

function detectSourceLanguage(text) {
  return new Promise((resolve) => {
    chrome.i18n.detectLanguage(text, (result) => {
      const error = chrome.runtime.lastError;
      const best = result?.languages?.[0];
      resolve(!error && result?.isReliable && best?.language !== "und" ? best?.language || null : null);
    });
  });
}

async function openaiBatch(texts, cfg, includeLanguage = false) {
  const url = buildUrl(cfg.apiUrl);
  const sys = `你是翻译引擎。把 JSON 数组里的每条文本翻译成${langName(cfg.targetLang)}，` +
    (includeLanguage
      ? '只输出 JSON 对象 {"sourceLang":"原文语言的 BCP-47 代码，无法确定则为 null","translations":["译文"]}，translations 长度与输入一致，不要解释，不要 markdown。'
      : "只输出译文 JSON 数组，长度与输入一致，不要解释，不要 markdown。");
  const body = { model: cfg.model, messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(texts) }] };
  await log(`请求 ${url} model=${cfg.model} 段数=${texts.length}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey, "api-key": cfg.apiKey },
    body: JSON.stringify(body)
  });
  const raw = await res.text();
  if (!res.ok) { await log(`失败 HTTP ${res.status}: ${raw.slice(0,200)}`); throw new Error("HTTP " + res.status + " " + raw.slice(0, 150)); }
  const data = JSON.parse(raw);
  let out = (data.choices?.[0]?.message?.content || "[]").replace(/```json|```/g, "").trim();
  let arr; try { arr = JSON.parse(out); } catch { arr = [out]; }
  if (includeLanguage && !Array.isArray(arr)) {
    if (typeof arr?.translations?.[0] !== "string" || !arr.translations[0].trim()) throw new Error("模型未返回有效译文");
    await log("成功，返回划词译文");
    return { translated: arr.translations[0], sourceLang: typeof arr.sourceLang === "string" ? arr.sourceLang : null };
  }
  await log(`成功，返回 ${arr.length} 条`);
  if (includeLanguage) return { translated: arr[0] || "", sourceLang: await detectSourceLanguage(texts[0]) };
  return texts.map((_, i) => arr[i] || "");
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = ""; } } }));
  return out;
}
const getCfg = () => new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg.type === "SPEAK_SELECTION") {
    speech.play(msg, sender).then(send, (error) => send({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === "STOP_SELECTION_SPEECH") {
    send(speech.stop(msg.requestId, sender));
    return;
  }
  if (!["TRANSLATE", "TRANSLATE_BATCH", "TEST"].includes(msg.type)) return;
  (async () => {
    const cfg = await getCfg();
    if (msg.targetLang) cfg.targetLang = msg.targetLang;
    if (msg.cfg) Object.assign(cfg, msg.cfg);
    try {
      if (msg.type === "TRANSLATE") {
        const result = cfg.provider === "openai" && cfg.apiUrl
          ? await openaiBatch([msg.text], cfg, true)
          : await googleTranslate(msg.text, cfg.targetLang);
        send({ ok: true, ...result, targetLang: cfg.targetLang });
      }
      else if (msg.type === "TRANSLATE_BATCH") send({ ok: true, results: cfg.provider === "openai" && cfg.apiUrl ? await openaiBatch(msg.texts, cfg) : await pool(msg.texts, 10, async (t) => (await googleTranslate(t, cfg.targetLang)).translated) });
      else if (msg.type === "TEST") { const r = await openaiBatch(["Hello world"], cfg); send({ ok: true, sample: r[0] }); }
    } catch (e) { send({ ok: false, error: e.message }); }
  })();
  return true;
});
