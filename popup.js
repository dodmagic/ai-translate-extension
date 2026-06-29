const DEF = { targetLang: "zh-CN", provider: "google", apiUrl: "", apiKey: "", model: "gpt-5.4-mini" };
const $ = (id) => document.getElementById(id);
const setStatus = (m, c) => { $("status").textContent = m || ""; $("status").style.color = c || "#9aa"; };

let cfg = { ...DEF };
chrome.storage.sync.get(DEF, (c) => { cfg = c; $("lang").value = c.targetLang; $("provider").value = c.provider; $("apiUrl").value = c.apiUrl; $("apiKey").value = c.apiKey; $("model").value = c.model; render(); });

function render() {
  const isOpenai = $("provider").value === "openai";
  const done = isOpenai && cfg.apiUrl && cfg.apiKey;
  $("openai").style.display = isOpenai && !done ? "block" : "none";
  $("cfgSummary").style.display = isOpenai && done ? "block" : "none";
  $("sumModel").textContent = cfg.model;
}

$("lang").addEventListener("change", () => chrome.storage.sync.set({ targetLang: $("lang").value }));
$("provider").addEventListener("change", () => { cfg.provider = $("provider").value; chrome.storage.sync.set({ provider: cfg.provider }); render(); });
$("edit").addEventListener("click", () => { $("cfgSummary").style.display = "none"; $("openai").style.display = "block"; });

function readForm() { return { provider: "openai", apiUrl: $("apiUrl").value.trim(), apiKey: $("apiKey").value.trim(), model: $("model").value.trim() || "gpt-5.4-mini" }; }

$("save").addEventListener("click", () => { const f = readForm(); cfg = { ...cfg, ...f }; chrome.storage.sync.set(f, () => { setStatus("已保存", "#8c9"); render(); }); });

$("test").addEventListener("click", () => {
  const f = readForm(); setStatus("测试中…");
  chrome.runtime.sendMessage({ type: "TEST", cfg: f }, (r) => setStatus(r?.ok ? "✓ 测试成功: " + r.sample : "✗ " + (r?.error || "无响应"), r?.ok ? "#8c9" : "#f88"));
});

$("showLog").addEventListener("click", () => { const el = $("log"); if (el.style.display === "block") { el.style.display = "none"; return; } chrome.storage.local.get("aitLog", ({ aitLog = [] }) => { el.style.display = "block"; el.textContent = aitLog.join("\n") || "暂无日志"; }); });

function getActiveTab(cb) { chrome.tabs.query({ active: true, currentWindow: true }, (t) => cb(t[0])); }

function refreshBtn() {
  getActiveTab((tab) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "PAGE_STATE" }, (r) => {
      if (chrome.runtime.lastError) { $("page").textContent = "翻译当前页面（中英对照）"; return; }
      $("page").textContent = r && r.translated ? "还原原文" : "翻译当前页面（中英对照）";
    });
  });
}
refreshBtn();

$("page").addEventListener("click", () => getActiveTab((tab) => {
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "TRANSLATE_PAGE" });
  $("page").textContent = $("page").textContent.startsWith("还原") ? "翻译当前页面（中英对照）" : "还原原文";
}));
