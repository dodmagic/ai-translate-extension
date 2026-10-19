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
      "）。请在 Windows 语言设置中安装对应的文本转语音语音包并重启当前浏览器；不会改用男性、英式或默认声音。");
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
      if (stopEngine) {
        try { api.tts.stop(); }
        catch {
          state = "error";
          extra = {
            ...extra,
            code: extra.code || "TTS_STOP_FAILED",
            error: (extra.error ? extra.error + "；" : "") + "停止发音调用失败，请重新加载扩展并刷新网页",
            stopFailed: true
          };
        }
      }
      if (state === "error") request.reject(new Error(extra.error));
      else request.resolve({ ok: true });
      emit(request, state, { phase: request.phase, ...extra });
      return state === "error" ? { ok: false, error: extra.error } : { ok: true };
    }

    function stop(requestId, sender) {
      if (active?.id === requestId && owns(active, sender)) return finish(active, "stopped", {}, true);
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
      if (typeof api.tts?.getVoices !== "function" || typeof api.tts?.speak !== "function" || typeof api.tts?.stop !== "function") {
        throw new Error("当前浏览器的原生发音接口不可用，请重新加载扩展、确认发音权限并检查浏览器版本");
      }
      if (active) {
        const stopped = finish(active, "stopped", {}, true);
        if (!stopped.ok) throw new Error(stopped.error);
      }
      let resolve, reject;
      const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
      const request = { id: message.requestId, tabId: sender.tab.id, frameId: sender.frameId || 0, resolve, reject, phase: "voices" };
      active = request;
      request.timer = setTimeout(() => finish(request, "error", {
        code: request.phase === "voices" ? "TTS_VOICES_TIMEOUT" : "TTS_START_TIMEOUT",
        error: request.phase === "voices" ? "读取系统语音超时，请重新加载扩展后重试" : "发音启动超时，未收到播放事件，请检查系统语音包后重试"
      }, true), 10000);
      (async () => {
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
          if (active !== request) return;
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
            if (active !== request) return;
          }
        }
        const { voice, locale } = selected;
        request.phase = "start";
        api.tts.speak(message.text, {
          voiceName: voice.voiceName,
          lang: locale,
          enqueue: false,
          requiredEventTypes: ["start", "end"],
          onEvent(event) {
            if (active !== request) return;
            if (event.type === "start") {
              request.phase = "playing";
              clearTimeout(request.timer);
              request.timer = setTimeout(() => finish(request, "error", { code: "TTS_PLAYBACK_TIMEOUT", error: "发音超时，已停止，请缩短选择范围后重试" }, true), 300000);
              request.resolve({ ok: true });
              emit(request, "playing", { voiceName: voice.voiceName, lang: locale });
            } else if (event.type === "end") finish(request, "stopped");
            else if (event.type === "cancelled" || event.type === "interrupted") finish(request, "stopped");
            else if (event.type === "error") finish(request, "error", { code: "TTS_ENGINE_ERROR", error: "发音失败：" + (event.errorMessage || "系统语音错误") }, true);
          }
        }, () => {
          if (active !== request) return;
          const error = api.runtime.lastError;
          if (error) finish(request, "error", { code: "TTS_SPEAK_FAILED", error: "发音失败：" + error.message }, true);
          else request.resolve({ ok: true });
        });
      })().catch((error) => {
        if (active === request) finish(request, "error", {
          code: request.phase === "voices" ? "TTS_VOICES_FAILED" : "TTS_SPEAK_FAILED",
          error: error.message
        }, true);
      });
      return completion;
    }

    return { play, stop, stopTab };
  }

  return { resolveLanguage, selectVoice, createController };
})();
