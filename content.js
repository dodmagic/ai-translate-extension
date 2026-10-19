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
  let speechRequest = null;

  function removeTrigger() {
    if (triggerBtn) { triggerBtn.remove(); triggerBtn = null; }
  }
  function removeResult() {
    stopSpeech();
    if (resultBox) { resultBox.remove(); resultBox = null; }
  }

  function resetSpeechButtons(box) {
    box.querySelectorAll(".ait-speech").forEach((button) => {
      button.textContent = button.dataset.label;
      button.setAttribute("aria-pressed", "false");
    });
  }

  function reportSpeechError(code) {
    console.warn("[AI翻译发音]", code);
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage({ type: "SPEECH_DIAGNOSTIC", code }, () => {
        if (chrome.runtime.lastError) console.warn("[AI翻译发音] 无法保存诊断，请重新加载扩展");
      });
    } catch { console.warn("[AI翻译发音] 无法保存诊断，请刷新网页"); }
  }

  function stopSpeech() {
    const request = speechRequest;
    if (!request) return;
    speechRequest = null;
    clearTimeout(request.timer);
    resetSpeechButtons(request.box);
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage({ type: "STOP_SELECTION_SPEECH", requestId: request.id }, (r) => {
        const error = chrome.runtime.lastError;
        if (resultBox === request.box && !speechRequest && (error || !r?.ok)) {
          request.status.textContent = "停止发音失败，请重载扩展并刷新页面";
          reportSpeechError("TTS_STOP_RESPONSE_FAILED");
        }
      });
    } catch {
      if (resultBox === request.box) request.status.textContent = "停止发音失败，请重载扩展并刷新页面";
    }
  }

  function addSpeechButton(box, bar, status, label, text, lang) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ait-speech";
    button.dataset.label = label;
    button.textContent = label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      if (speechRequest?.button === button) {
        stopSpeech();
        status.textContent = "已停止";
        return;
      }
      stopSpeech();
      if (!alive()) { status.textContent = "插件已重载，请刷新页面"; return; }
      if (!chrome.runtime.getManifest().permissions?.includes("tts")) {
        status.textContent = "扩展发音权限尚未生效，请在扩展管理页重新加载并确认权限，然后刷新网页";
        reportSpeechError("TTS_RELOAD_REQUIRED");
        return;
      }
      const request = { id: crypto.randomUUID(), button, box, status };
      speechRequest = request;
      button.textContent = "停止" + label;
      button.setAttribute("aria-pressed", "true");
      status.textContent = "正在准备发音…";
      const fail = (error) => {
        if (speechRequest !== request) return;
        stopSpeech();
        status.textContent = error;
      };
      request.timer = setTimeout(() => {
        fail("发音准备超时，后台未完成响应，请重新加载扩展并刷新网页后重试");
        reportSpeechError("TTS_FRONTEND_TIMEOUT");
      }, 12000);
      try {
        chrome.runtime.sendMessage({ type: "SPEAK_SELECTION", requestId: request.id, text, lang }, (r) => {
          const error = chrome.runtime.lastError;
          if (error) fail("发音服务不可用，请重载扩展并刷新页面");
          else if (!r?.ok) fail(r?.error || "发音失败：后台无响应");
        });
      } catch { fail("发音服务不可用，请重载扩展并刷新页面"); }
    });
    bar.appendChild(button);
  }

  window.addEventListener("pagehide", removeResult);

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
    const box = resultBox;
    getTargetLang(async (lang) => {
      if (resultBox !== box) return;
      const r = await requestTranslate(text, lang);
      if (resultBox !== box) return;
      if (r.ok) {
        box.innerHTML = "";
        const bar = document.createElement("div");
        bar.className = "ait-result-actions";
        const status = document.createElement("div");
        status.className = "ait-speech-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        addSpeechButton(box, bar, status, "原文发音", text, r.sourceLang);
        addSpeechButton(box, bar, status, "译文发音", r.translated, r.targetLang || lang);
        const close = document.createElement("button");
        close.type = "button";
        close.className = "ait-close";
        close.textContent = "关闭";
        close.setAttribute("aria-label", "关闭译文并停止发音");
        close.addEventListener("click", removeResult);
        bar.appendChild(close);
        box.appendChild(bar);
        const t = document.createElement("div");
        t.className = "ait-result-text";
        t.textContent = r.translated;
        box.appendChild(t);
        box.appendChild(status);
      } else {
        const error = document.createElement("div");
        error.className = "ait-result-loading";
        error.textContent = "翻译失败：" + (r.error || "");
        box.replaceChildren(error);
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
    if (msg.type === "SPEECH_STATUS") {
      send({ ok: true });
      const request = speechRequest;
      if (!request || request.id !== msg.requestId || resultBox !== request.box) return;
      clearTimeout(request.timer);
      if (msg.state === "playing") request.status.textContent = msg.voiceName + " · " + msg.lang + " · 女声";
      else {
        speechRequest = null;
        resetSpeechButtons(request.box);
        request.status.textContent = msg.state === "error" ? msg.error : "已停止";
      }
      return;
    }
    if (msg.type === "TRANSLATE_PAGE") translatePage();
    if (msg.type === "PAGE_STATE") { send({ translated: pageTranslated }); return true; }
    if (msg.type === "TRANSLATE_SELECTION") {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (text) doSelectionTranslate(sel.getRangeAt(0).getBoundingClientRect(), text);
    }
  });
})();
