// AI 翻译 - 内容脚本
// 1) 选中文字翻译：选中后出现小图标，点击弹出译文
// 2) 整页翻译：每个文本段下方插入译文，中英对照

(function () {
  if (window.__aiTranslateLoaded) return;
  window.__aiTranslateLoaded = true;

  let pageTranslated = false;

  // ---------- 工具 ----------
  function alive() { return !!(chrome.runtime && chrome.runtime.id); }

  function getTargetLang(cb) {
    if (!alive()) return cb("zh-CN");
    try { chrome.storage.sync.get({ targetLang: "zh-CN" }, (c) => cb(c.targetLang)); }
    catch { cb("zh-CN"); }
  }

  function requestTranslate(text, targetLang) {
    return new Promise((resolve) => {
      if (!alive()) return resolve({ ok: false, error: "插件已重载，请刷新页面" });
      try {
        chrome.runtime.sendMessage({ type: "TRANSLATE", text, targetLang }, (r) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: "插件已重载，请刷新页面" });
          resolve(r || { ok: false, error: "无响应" });
        });
      } catch { resolve({ ok: false, error: "插件已重载，请刷新页面" }); }
    });
  }

  // ---------- 划词翻译 ----------
  let triggerBtn = null;
  let resultBox = null;

  function removeTrigger() {
    if (triggerBtn) { triggerBtn.remove(); triggerBtn = null; }
  }
  function removeResult() {
    if (resultBox) { resultBox.remove(); resultBox = null; }
  }

  document.addEventListener("mouseup", (e) => {
    if (triggerBtn && triggerBtn.contains(e.target)) return;
    if (resultBox && resultBox.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      removeTrigger();
      if (!text) { removeResult(); return; }
      const range = sel.getRangeAt(0).getBoundingClientRect();
      showTrigger(range, text);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (resultBox && !resultBox.contains(e.target)) removeResult();
    if (triggerBtn && !triggerBtn.contains(e.target)) removeTrigger();
  });

  function showTrigger(rect, text) {
    triggerBtn = document.createElement("div");
    triggerBtn.className = "ait-trigger";
    triggerBtn.textContent = "译";
    triggerBtn.style.top = window.scrollY + rect.bottom + 6 + "px";
    triggerBtn.style.left = window.scrollX + rect.left + "px";
    triggerBtn.addEventListener("click", () => { removeTrigger(); doSelectionTranslate(rect, text); });
    document.body.appendChild(triggerBtn);
  }

  async function doSelectionTranslate(rect, text) {
    removeResult();
    resultBox = document.createElement("div");
    resultBox.className = "ait-result";
    resultBox.style.top = window.scrollY + rect.bottom + 6 + "px";
    resultBox.style.left = window.scrollX + rect.left + "px";
    resultBox.innerHTML = '<div class="ait-result-loading">翻译中…</div>';
    document.body.appendChild(resultBox);
    getTargetLang(async (lang) => {
      const r = await requestTranslate(text, lang);
      if (!resultBox) return;
      if (r.ok) {
        resultBox.innerHTML = "";
        const t = document.createElement("div");
        t.className = "ait-result-text";
        t.textContent = r.translated;
        resultBox.appendChild(t);
      } else {
        resultBox.innerHTML = '<div class="ait-result-loading">翻译失败：' + (r.error || "") + "</div>";
      }
    });
  }

  // ---------- 整页翻译 ----------
  const SKIP_TAGS = new Set(["SCRIPT","STYLE","NOSCRIPT","CODE","PRE","TEXTAREA","INPUT","SELECT","BUTTON"]);

  function collectTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const txt = node.nodeValue.trim();
        if (txt.length < 2) return NodeFilter.FILTER_REJECT;
        if (!/[A-Za-z\u00C0-\u024F]/.test(txt)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest(".ait-inline, .ait-trigger, .ait-result")) return NodeFilter.FILTER_REJECT;
        const r = p.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  async function translatePage() {
    if (pageTranslated) {
      document.querySelectorAll(".ait-inline").forEach((e) => e.remove());
      pageTranslated = false;
      toast("已关闭译文");
      return;
    }
    const nodes = collectTextNodes();
    if (!nodes.length) { toast("未找到可翻译文本"); return; }
    toast("整页翻译中…共 " + nodes.length + " 段");
    const texts = nodes.map((n) => n.nodeValue.trim());
    getTargetLang((lang) => {
      const CHUNK = 25;
      const chunks = [];
      for (let i = 0; i < nodes.length; i += CHUNK) chunks.push(i);
      let done = 0;
      const apply = (idx, results) => {
        results.forEach((tr, j) => {
          if (!tr) return;
          const node = nodes[idx + j];
          if (!node || !node.parentElement) return;
          const span = document.createElement("span");
          span.className = "ait-inline";
          span.textContent = " " + tr;
          node.parentElement.insertBefore(span, node.nextSibling);
        });
        if (++done === chunks.length) { pageTranslated = true; toast("翻译完成"); }
      };
      // 多块并行下发，整页大幅提速
      chunks.forEach((start) => {
        const slice = texts.slice(start, start + CHUNK);
        if (!alive()) { apply(start, []); return; }
        try {
          chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts: slice, targetLang: lang }, (r) => {
            if (chrome.runtime.lastError) return apply(start, []);
            apply(start, r && r.ok ? r.results : []);
          });
        } catch { apply(start, []); }
      });
    });
  }

  function toast(msg) {
    let t = document.querySelector(".ait-toast");
    if (!t) { t = document.createElement("div"); t.className = "ait-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    clearTimeout(t.__h);
    t.__h = setTimeout(() => t.remove(), 2500);
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === "TRANSLATE_PAGE") translatePage();
    if (msg.type === "PAGE_STATE") { send({ translated: pageTranslated }); return true; }
    if (msg.type === "TRANSLATE_SELECTION") {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (text) doSelectionTranslate(sel.getRangeAt(0).getBoundingClientRect(), text);
    }
  });
})();
