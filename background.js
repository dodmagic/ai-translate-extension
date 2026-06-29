// AI 翻译 - 后台服务
// 引擎：google(免费) / openai(OpenAI/Azure Foundry 兼容)
const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const DEFAULTS = { targetLang: "zh-CN", provider: "google", apiUrl: "", apiKey: "", model: "gpt-5.4-mini" };

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
  return ((await r.json())[0] || []).map((s) => s[0]).join("");
}

async function openaiBatch(texts, cfg) {
  const url = buildUrl(cfg.apiUrl);
  const sys = `你是翻译引擎。把 JSON 数组里的每条文本翻译成${langName(cfg.targetLang)}，只输出译文 JSON 数组，长度与输入一致，不要解释，不要 markdown。`;
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
  await log(`成功，返回 ${arr.length} 条`);
  return texts.map((_, i) => arr[i] || "");
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = ""; } } }));
  return out;
}
const getCfg = () => new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  (async () => {
    const cfg = await getCfg();
    if (msg.targetLang) cfg.targetLang = msg.targetLang;
    if (msg.cfg) Object.assign(cfg, msg.cfg);
    try {
      if (msg.type === "TRANSLATE") send({ ok: true, translated: cfg.provider === "openai" && cfg.apiUrl ? (await openaiBatch([msg.text], cfg))[0] : await googleTranslate(msg.text, cfg.targetLang) });
      else if (msg.type === "TRANSLATE_BATCH") send({ ok: true, results: cfg.provider === "openai" && cfg.apiUrl ? await openaiBatch(msg.texts, cfg) : await pool(msg.texts, 10, (t) => googleTranslate(t, cfg.targetLang)) });
      else if (msg.type === "TEST") { const r = await openaiBatch(["Hello world"], cfg); send({ ok: true, sample: r[0] }); }
    } catch (e) { send({ ok: false, error: e.message }); }
  })();
  return true;
});
