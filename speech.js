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
  // Chrome's built-in Google online voices (female, natural-sounding). Preferred over macOS voices.
  const GOOGLE_VOICES = {
    "en-US": ["Google US English"],
    "zh-CN": ["Google 普通话（中国大陆）"],
    "zh-TW": ["Google 國語（臺灣）"],
    "ja-JP": ["Google 日本語"],
    "ko-KR": ["Google 한국의"],
    "fr-FR": ["Google français"],
    "de-DE": ["Google Deutsch"],
    "es-ES": ["Google español"],
    "es-MX": [],
    "fr-CA": []
  };
  const GOOGLE_TTS_EXTENSION_ID = "neajdppkdcdipfabeoofebfddakdcjhd";
  // macOS system female voices, tried last; Premium/Enhanced variants win over compact ones.
  // Chrome may report macOS voices by their localized names (e.g. 婷婷), so both forms are listed.
  const MAC_FEMALE_VOICES = {
    "en-US": ["Ava", "Zoe", "Allison", "Susan", "Samantha"],
    "zh-CN": ["Lili", "莉莉", "Tingting", "婷婷", "Ting-Ting", "Yu-shu", "语舒"],
    "zh-TW": ["Meijia", "Mei-Jia", "美佳"],
    "ja-JP": ["Kyoko", "O-ren"],
    "ko-KR": ["Yuna", "유나"],
    "fr-FR": ["Audrey", "Marie", "Aurélie"],
    "de-DE": ["Anna", "Petra", "Helena"],
    "es-ES": ["Mónica", "Marisol"],
    "es-MX": ["Paulina", "Angélica"],
    "fr-CA": ["Amélie", "Chantal"]
  };
  // Known male or novelty voices that must never be used as a fallback.
  const BLOCKED = /\b(?:Eddy|Grandpa|Reed|Rocko|Li-?Mu|Albert|Fred|Ralph|Junior|Daniel|Aaron|Tom|Alex|Evan|Nathan|Thomas|Jacques|Otoya|Hattori|Diego|Jorge|Juan|Carlos|Martin|Yannick|Rishi|Oliver|Arthur|David|Mark|Kangkang|Male|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Zarvox|UK|British|Australia|India)\b|李牧|康康/i;
  const NOVELTY = /^(?:Grandma|Shelley|Flo|Sandy)\b/i;
  const QUALITY = /premium|enhanced|高品质|高音质|优化|增强/i;
  const DEFAULT_LOCALES = { zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES" };
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    if (!locale) throw new Error(language ? "暂不支持该语言的女声发音：" + language : "无法可靠识别原文语言，不能选择发音。请尝试较完整的句子或谷歌翻译引擎。");
    const sameLocale = (v) => typeof v.lang === "string" && normalizeLang(v.lang) === locale.toLowerCase() &&
      v.gender !== "male";
    const native = (v) => !v.extensionId && v.remote !== true;
    const candidates = [
      ...FEMALE_VOICES[locale].map((name) => ({ pattern: new RegExp("^Microsoft " + name + "(?: Desktop)?(?: - .+)?$", "i"), ok: native })),
      ...GOOGLE_VOICES[locale].map((name) => ({
        pattern: new RegExp("^" + escapeRegExp(name) + "$", "i"),
        ok: (v) => !v.extensionId || v.extensionId === GOOGLE_TTS_EXTENSION_ID
      })),
      // e.g. "Samantha", "Ava (Premium)", "Lili (高品质)"
      ...MAC_FEMALE_VOICES[locale].map((name) => ({ pattern: new RegExp("^" + escapeRegExp(name) + "(?: [(（].*[)）])?$", "i"), ok: native }))
    ];
    for (const { pattern, ok } of candidates) {
      const matches = voices.filter((v) => ok(v) && sameLocale(v) && pattern.test(v.voiceName || ""));
      const voice = matches.find((v) => QUALITY.test(v.voiceName)) || matches[0];
      if (voice) return { voice, locale };
    }
    // Fallback: any other voice of this locale (Google or system) that is not a known male/novelty voice.
    const trusted = (v) => v.extensionId === GOOGLE_TTS_EXTENSION_ID || (!v.extensionId && (v.remote !== true || /^Google /i.test(v.voiceName || "")));
    const rest = voices.filter((v) => trusted(v) && sameLocale(v) && v.voiceName && !BLOCKED.test(v.voiceName));
    const rank = (v) => (/^Google /i.test(v.voiceName) ? 0 : QUALITY.test(v.voiceName) ? 1 : NOVELTY.test(v.voiceName) ? 3 : 2);
    const fallback = rest.sort((a, b) => rank(a) - rank(b))[0];
    if (fallback) return { voice: fallback, locale };
    const available = voices.filter((v) => typeof v.lang === "string" && normalizeLang(v.lang).split("-")[0] === locale.split("-")[0].toLowerCase())
      .map((v) => v.voiceName + "[" + v.lang + "]").slice(0, 12).join("、") || "无";
    throw new Error("未找到 " + locale + " 女声（Windows：Microsoft " + FEMALE_VOICES[locale].join(" / ") +
      "；Chrome：" + (GOOGLE_VOICES[locale][0] || "无") + "；macOS：" + MAC_FEMALE_VOICES[locale].slice(0, 3).join(" / ") +
      " 等）。Windows 请在语言设置中安装对应的文本转语音语音包，" +
      "macOS 请在 系统设置 › 辅助功能 › 朗读内容 › 系统声音 › 管理声音 中下载，然后重启浏览器；不会改用男性、英式或默认声音。" +
      "当前浏览器可用的同语种声音：" + available);
  }

  function normalizeLang(lang) {
    const code = lang.replace(/_/g, "-").toLowerCase();
    if (code === "cmn-cn" || code === "cmn-hans-cn" || code === "zh-hans-cn" || code === "zh-hans") return "zh-cn";
    if (code === "cmn-tw" || code === "cmn-hant-tw" || code === "zh-hant-tw" || code === "zh-hant") return "zh-tw";
    return code;
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
