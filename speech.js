const AitSpeech = (() => {
  // Chrome no longer reports gender; accept only documented Microsoft female voices.
  const FEMALE_VOICES = {
    "en-US": ["Zira"],
    "zh-CN": ["Huihui", "Yaoyao"],
    "zh-TW": ["Hanhan", "Yating"],
    "ja-JP": ["Haruka", "Ayumi"],
    "ko-KR": ["Heami"],
    "fr-FR": ["Hortense", "Julie"],
    "de-DE": ["Hedda", "Katja"],
    "es-ES": ["Helena", "Laura"],
    "es-MX": ["Sabina"],
    "fr-CA": ["Caroline"]
  };
  const DEFAULT_LOCALES = { zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES" };

  function resolveLanguage(language) {
    if (typeof language !== "string") return null;
    const code = language.trim().replace(/_/g, "-").toLowerCase();
    if (/^en(?:-|$)/.test(code)) return "en-US";
    if (code === "zh-hans" || code.startsWith("zh-hans-")) return "zh-CN";
    if (code === "zh-hant" || code.startsWith("zh-hant-")) return "zh-TW";
    return Object.keys(FEMALE_VOICES).find((locale) => locale.toLowerCase() === code) || DEFAULT_LOCALES[code] || null;
  }

  function selectVoice(voices, language) {
    const locale = resolveLanguage(language);
    if (!locale) throw new Error(language ? "暂不支持该语言的微软女声：" + language : "无法可靠识别原文语言，不能选择发音。请尝试较完整的句子或谷歌翻译引擎。");
    for (const name of FEMALE_VOICES[locale]) {
      const pattern = new RegExp("^Microsoft " + name + "(?: Desktop)?(?: - .+)?$", "i");
      const voice = voices.find((v) => !v.extensionId && v.remote !== true &&
        typeof v.lang === "string" && v.lang.replace(/_/g, "-").toLowerCase() === locale.toLowerCase() &&
        pattern.test(v.voiceName || "") && v.gender !== "male");
      if (voice) return { voice, locale };
    }
    throw new Error("未找到 " + locale + " 微软女声（" + FEMALE_VOICES[locale].join(" / ") +
      "）。请在 Windows 语言设置中安装对应的文本转语音语音包并重启 Chrome；不会改用男性、英式或默认声音。");
  }

  function createController(api, notify) {
    let active = null;
    const owns = (request, sender) => request && request.tabId === sender.tab?.id && request.frameId === (sender.frameId || 0);
    const emit = (request, state, extra = {}) => notify(request, { type: "SPEECH_STATUS", requestId: request.id, state, ...extra });

    function finish(request, state, extra = {}, stopEngine = false) {
      if (active !== request) return;
      active = null;
      clearTimeout(request.timer);
      clearTimeout(request.retryTimer);
      request.wake?.();
      if (stopEngine) api.tts.stop();
      emit(request, state, extra);
    }

    function stop(requestId, sender) {
      if (active?.id === requestId && owns(active, sender)) finish(active, "stopped", {}, true);
      return { ok: true };
    }

    function stopTab(tabId) {
      if (active?.tabId === tabId) finish(active, "stopped", {}, true);
    }

    async function play(message, sender) {
      if (!Number.isInteger(sender.tab?.id)) throw new Error("发音只能从网页划词结果中启动");
      if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 100) throw new Error("无效的发音请求");
      if (typeof message.text !== "string" || !message.text.trim()) throw new Error("没有可播放的文字");
      if (message.text.length > 32768) throw new Error("选中文字过长，发音最多支持 32768 个字符，请缩短选择范围");
      if (!api.tts?.getVoices || !api.tts?.speak) throw new Error("当前浏览器不支持 Chrome 原生发音，请使用 Chrome 并重载扩展");
      if (active) finish(active, "stopped", {}, true);
      const request = { id: message.requestId, tabId: sender.tab.id, frameId: sender.frameId || 0 };
      active = request;
      request.timer = setTimeout(() => finish(request, "error", { error: "发音启动超时，请检查系统语音包后重试" }, true), 10000);
      try {
        let selected;
        // Native Windows voices may arrive after the first getVoices callback.
        for (let attempt = 0; attempt <= 8; attempt++) {
          const voices = await new Promise((resolve, reject) => {
            api.tts.getVoices((list) => {
              const error = api.runtime.lastError;
              if (error) reject(new Error("读取语音失败：" + error.message));
              else resolve(list || []);
            });
          });
          if (active !== request) return { ok: true };
          try {
            selected = selectVoice(voices, message.lang);
            break;
          } catch (error) {
            if (attempt === 8 || !resolveLanguage(message.lang)) throw error;
            await new Promise((resolve) => {
              request.wake = resolve;
              request.retryTimer = setTimeout(resolve, 250);
            });
            request.wake = null;
            if (active !== request) return { ok: true };
          }
        }
        const { voice, locale } = selected;
        await new Promise((resolve, reject) => {
          api.tts.speak(message.text, {
            voiceName: voice.voiceName,
            lang: locale,
            enqueue: false,
            requiredEventTypes: ["start", "end"],
            onEvent(event) {
              if (active !== request) return;
              if (event.type === "start") {
                clearTimeout(request.timer);
                request.timer = setTimeout(() => finish(request, "error", { error: "发音超时，已停止，请缩短选择范围后重试" }, true), 300000);
                emit(request, "playing", { voiceName: voice.voiceName, lang: locale });
              } else if (event.type === "end") finish(request, "stopped");
              else if (event.type === "cancelled" || event.type === "interrupted") finish(request, "stopped");
              else if (event.type === "error") finish(request, "error", { error: "发音失败：" + (event.errorMessage || "系统语音错误") }, true);
            }
          }, () => {
            const error = api.runtime.lastError;
            if (error) reject(new Error("发音失败：" + error.message));
            else resolve();
          });
        });
        return { ok: true };
      } catch (error) {
        if (active !== request) return { ok: true };
        finish(request, "error", { error: error.message }, true);
        throw error;
      }
    }

    return { play, stop, stopTab };
  }

  return { resolveLanguage, selectVoice, createController };
})();
