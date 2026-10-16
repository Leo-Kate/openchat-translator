(() => {
  "use strict";

  if (window.__openChatTranslatorLoaded) return;
  window.__openChatTranslatorLoaded = true;

  const state = {
    settings: null,
    scanned: new WeakMap(),
    failures: new WeakMap(),
    pending: new Map(),
    mutedChats: new Set(),
    activeChatKey: "",
    activeChatLabel: "当前对话",
    boundComposers: new WeakSet(),
    composerOriginal: "",
    composerTranslated: "",
    composerWriting: false,
    composerRevision: 0,
    translationEpoch: 0,
    autoQueue: new Set(),
    autoActive: 0,
    autoTimer: null,
    autoOverflow: false,
    toolbar: null,
    observedMessages: new WeakSet(),
    visibleMessages: new WeakSet(),
    contextInvalidated: false,
    scanTimer: null,
    domTimer: null,
    scanRoots: new Set(),
    observer: null,
  };

  const MUTED_CHATS_KEY = "openchatMutedChats";
  const MAX_AUTO_ACTIVE = 2;
  const MAX_AUTO_QUEUE = 32;

  const messageSelectors = [
    "[data-testid='msg-container']",
    "div.message-in",
    "div.message-out",
    "[data-id^='true_']",
    "[data-id^='false_']",
    "[data-id^='true-']",
    "[data-id^='false-']",
  ];

  const LANG_LABELS = {
    "zh-CN": "中文",
    en: "English",
    es: "Español",
    fr: "Français",
    de: "Deutsch",
    it: "Italiano",
    pt: "Português",
    ja: "日本語",
    ko: "한국어",
    ar: "العربية",
    ru: "Русский",
    auto: "Auto",
  };

  function isContextInvalidated(error) {
    return /extension context invalidated|context invalidated/i.test(
      String(error?.message || error || ""),
    );
  }

  function markContextInvalidated() {
    if (state.contextInvalidated) return;
    state.contextInvalidated = true;
    state.settings = null;
    state.observer?.disconnect();
    visibilityObserver?.disconnect();
    clearInterval(state.scanTimer);
    cancelDomUpdate();
    cancelAutomaticTranslations();
    state.pending.clear();
    document.documentElement.dataset.openchatTranslator = "off";
    document.querySelectorAll(".wst-message-action, .wst-compose-action, .wst-chat-toggle, .wst-compose-tools, .wst-compose-status").forEach((element) => {
      element.remove();
    });
    const notice = document.createElement("aside");
    if (!document.body || document.querySelector(".wst-reload-notice")) return;
    notice.className = "wst-reload-notice";
    notice.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = "翻译扩展已更新 刷新 WhatsApp 后继续使用";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "刷新页面";
    reload.addEventListener("click", () => window.location.reload());
    notice.append(text, reload);
    document.body.appendChild(notice);
  }

  function extensionContextAvailable() {
    try {
      return !state.contextInvalidated && typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function safeStorageGet(key) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || {});
      };
      const fail = (error) => {
        if (settled) return;
        if (isContextInvalidated(error) || !extensionContextAvailable()) markContextInvalidated();
        finish({});
      };
      if (!extensionContextAvailable()) {
        markContextInvalidated();
        finish({});
        return;
      }
      try {
        const pending = chrome.storage.local.get(key, (result) => {
          try {
            const runtimeError = chrome.runtime.lastError;
            if (!extensionContextAvailable() || isContextInvalidated(runtimeError)) {
              markContextInvalidated();
              finish({});
            } else {
              finish(result);
            }
          } catch (error) {
            fail(error);
          }
        });
        if (pending && typeof pending.then === "function") pending.then(finish, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  function safeStorageSet(value) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (success) => {
        if (settled) return;
        settled = true;
        resolve(Boolean(success));
      };
      const fail = (error) => {
        if (settled) return;
        if (isContextInvalidated(error) || !extensionContextAvailable()) markContextInvalidated();
        finish(false);
      };
      if (!extensionContextAvailable()) {
        markContextInvalidated();
        finish(false);
        return;
      }
      try {
        const pending = chrome.storage.local.set(value, () => {
          try {
            const runtimeError = chrome.runtime.lastError;
            if (!extensionContextAvailable() || isContextInvalidated(runtimeError)) {
              markContextInvalidated();
              finish(false);
            } else {
              finish(!runtimeError);
            }
          } catch (error) {
            fail(error);
          }
        });
        if (pending && typeof pending.then === "function") pending.then(() => finish(true), fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  function send(message) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error) => {
        if (settled) return;
        if (isContextInvalidated(error) || !extensionContextAvailable()) markContextInvalidated();
        finish({ ok: false, error: error?.message || "后台通信失败" });
      };
      if (!extensionContextAvailable()) {
        markContextInvalidated();
        finish({ ok: false, error: "扩展已更新，请刷新 WhatsApp 页面" });
        return;
      }
      try {
        const pending = chrome.runtime.sendMessage(message, (response) => {
          try {
            const runtimeError = chrome.runtime.lastError;
            if (!extensionContextAvailable() || isContextInvalidated(runtimeError)) {
              markContextInvalidated();
              finish({ ok: false, error: "扩展已更新，请刷新 WhatsApp 页面" });
            } else if (runtimeError) {
              finish({ ok: false, error: runtimeError.message });
            } else {
              finish(response || { ok: false, error: "No response" });
            }
          } catch (error) {
            fail(error);
          }
        });
        if (pending && typeof pending.then === "function") pending.then((response) => {
          if (response !== undefined) finish(response);
        }, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  function publicSettings(settings) {
    if (!settings) return settings;
    const { apiSettings: _apiSettings, ...safeSettings } = settings;
    return { autoDetectIncoming: true, ...safeSettings };
  }

  function normalizeChatKey(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 180);
  }

  function readActiveChat() {
    const info = document.querySelector("[data-testid='conversation-info-header']");
    const header = info || Array.from(document.querySelectorAll("header")).find((element) => {
      const text = (element.innerText || "").trim();
      return text && text.length < 300 && !/whatsapp/i.test(text);
    });
    const message = document.querySelector("[data-testid='msg-container'][data-id], div.message-in[data-id], div.message-out[data-id]");
    const messageId = message?.getAttribute("data-id") || "";
    const messageChatId = messageId.match(/^(?:true|false)[_-]([^_-]+)[_-]/i)?.[1] || "";
    const label = (info?.querySelector("span[dir='auto'], span[title]")?.innerText || info?.innerText || header?.innerText || "")
      .replace(/\s+/g, " ").trim().split("\n")[0].slice(0, 120);
    const key = normalizeChatKey(messageChatId || info?.getAttribute("data-id") || label);
    return { key: key ? `chat:${key}` : "", label: label || "当前对话" };
  }

  function currentChatMuted() {
    return Boolean(state.activeChatKey && state.mutedChats.has(state.activeChatKey));
  }

  function removeAllTranslations() {
    document.querySelectorAll(".wst-translation-row").forEach((row) => {
      row.classList.add("wst-leaving");
      setTimeout(() => row.remove(), 140);
    });
  }

  function updateChatToggle() {
    document.querySelectorAll(".wst-chat-toggle").forEach((button) => {
      const muted = currentChatMuted();
      const text = muted ? "恢复翻译" : "暂停翻译";
      const title = muted ? `恢复${state.activeChatLabel}的自动翻译` : `暂停${state.activeChatLabel}的自动翻译`;
      // Replacing even identical text creates a childList mutation in Chrome.
      if (button.textContent !== text) button.textContent = text;
      if (button.title !== title) button.title = title;
      if (button.getAttribute("aria-label") !== title) button.setAttribute("aria-label", title);
      const value = muted ? "true" : "false";
      if (button.dataset.muted !== value) button.dataset.muted = value;
    });
    document.querySelectorAll(".wst-compose-action").forEach((button) => {
      button.disabled = currentChatMuted() || Boolean(state.composerBusy);
      button.title = currentChatMuted() ? "当前对话已暂停翻译，点击恢复翻译" : "翻译草稿，再次点击恢复原文";
      button.setAttribute("aria-label", button.title);
    });
  }

  function refreshActiveChat() {
    const next = readActiveChat();
    if (next.key === state.activeChatKey) {
      if (next.label && next.label !== state.activeChatLabel) {
        state.activeChatLabel = next.label;
        updateChatToggle();
      }
      return;
    }
    state.activeChatKey = next.key;
    cancelAutomaticTranslations();
    state.activeChatLabel = next.label;
    state.composerOriginal = "";
    state.composerTranslated = "";
    updateChatToggle();
    if (currentChatMuted()) removeAllTranslations();
  }

  async function setCurrentChatMuted(muted) {
    if (!state.activeChatKey || state.contextInvalidated) return false;
    const nextMutedChats = new Set(state.mutedChats);
    if (muted) nextMutedChats.add(state.activeChatKey);
    else nextMutedChats.delete(state.activeChatKey);
    const saved = await safeStorageSet({ [MUTED_CHATS_KEY]: Array.from(nextMutedChats).slice(-200) });
    if (!saved || state.contextInvalidated) return false;
    state.mutedChats = nextMutedChats;
    cancelAutomaticTranslations();
    updateChatToggle();
    if (muted) removeAllTranslations();
    else scheduleDomUpdate(document);
    return true;
  }

  function textFromMessage(message) {
    const textSelector = "[data-testid='selectable-text'], .selectable-text, [data-testid='msg-text']";
    const excluded = `${ownedSelector}, [data-testid='quoted-message'], [data-testid='quoted-text'], [data-testid='msg-meta'], [data-testid='msg-time'], [data-testid='link-preview'], [data-testid='document-title'], [data-testid='document-message'], [data-testid='audio-message'], [data-testid='media-info'], time, button`;
    const cleanText = (element) => {
      if (element.closest(excluded)) return "";
      const copy = element.cloneNode(true);
      copy.querySelectorAll(excluded).forEach((node) => node.remove());
      return (copy.textContent || "").replace(/\s+/g, " ").trim();
    };
    const isNonTranslatableText = (value) => {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (!text) return true;
      // A standalone link is already readable and often contains a long slug.
      if (!text.replace(/(?:(?:https?|ftp):\/\/|www\.)[^\s<>]+/gi, "").replace(/[\s,;，；。()（）<>]+/g, "")) return true;
      if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(text)) return true;
      // Common wallet addresses and transaction hashes are identifiers, not prose.
      if (/^0x[a-f0-9]{40}$/i.test(text)) return true;
      if (/^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,62})$/.test(text)) return true;
      if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(text)) return true;
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return true;
      if (/^[a-f0-9]{64}$/i.test(text)) return true;
      if (/^\d{1,2}:\d{2}(?:\s*[ap]m)?$/i.test(text)) return true;
      if (/^\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|TB)$/i.test(text)) return true;
      return false;
    };
    const candidates = Array.from(message.querySelectorAll(textSelector));
    // Only WhatsApp's message/caption text is authoritative. Never fall back to
    // the whole bubble: media bubbles contain timestamps and our own controls.
    if (candidates.length) {
      const text = candidates.map(cleanText).filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
      return isNonTranslatableText(text) ? "" : text;
    }
    return "";
  }

  function isOutgoing(message) {
    const dataId = message.getAttribute("data-id") || "";
    if (/^(true|outgoing)[_-]/i.test(dataId)) return true;
    if (/^(false|incoming)[_-]/i.test(dataId)) return false;
    return message.classList.contains("message-out") || Boolean(message.querySelector("[data-testid='msg-dblcheck'], [data-testid='msg-check']"));
  }

  function messageId(message, text) {
    return message.getAttribute("data-id") || message.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || text;
  }

  function setVisual(row) {
    row.style.setProperty("--wst-color", state.settings.translationColor);
    row.style.setProperty("--wst-size", `${state.settings.fontSize}px`);
  }

  function removeTranslation(message) {
    const row = message.querySelector(":scope > .wst-translation-row, .wst-translation-row");
    if (!row) return;
    row.classList.add("wst-leaving");
    setTimeout(() => row.remove(), 140);
  }

  function renderTranslation(message, translated, source, target) {
    message.querySelectorAll(".wst-translation-row").forEach((row) => row.remove());
    const row = document.createElement("div");
    row.className = "wst-translation-row";
    row.dataset.wstTranslation = "true";
    row.title = "Click to hide translation";
    setVisual(row);

    const label = document.createElement("span");
    label.className = "wst-translation-label";
    label.textContent = LANG_LABELS[target] || target;
    const text = document.createElement("span");
    text.className = "wst-translation-text";
    text.textContent = translated;
    const toggle = document.createElement("button");
    toggle.className = "wst-translation-action";
    toggle.type = "button";
    toggle.title = "Hide translation";
    toggle.setAttribute("aria-label", "Hide translation");
    toggle.textContent = "x";
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      removeTranslation(message);
    });
    row.append(label, text, toggle);
    row.addEventListener("click", () => removeTranslation(message));

    const anchor = message.querySelector("[data-testid='selectable-text'], .selectable-text")?.parentElement || message;
    anchor.appendChild(row);
    state.scanned.set(message, { id: messageId(message, source), source, target, translated });
  }

  async function translateMessage(message, force = false) {
    let key = "";
    let ownsPending = false;
    try {
      if (!state.settings?.enabled || currentChatMuted()) return;
      const sourceText = textFromMessage(message);
      if (!sourceText || sourceText.length > 5000) return;
      const outgoing = isOutgoing(message);
      if (outgoing && !state.settings.translateOutgoing) return;
      const id = messageId(message, sourceText);
      const settings = state.settings;
      const epoch = state.translationEpoch;
      // Settings describe the user's language and the contact's language. Incoming
      // messages therefore travel from contact -> user; outgoing drafts use user -> contact.
      const userLanguage = state.settings.sourceLang === "auto" ? "zh-CN" : state.settings.sourceLang;
      const contactLanguage = state.settings.targetLang || "auto";
      const source = outgoing ? userLanguage : (state.settings.autoDetectIncoming !== false ? "auto" : contactLanguage);
      const target = outgoing ? contactLanguage : userLanguage;
      // There is no safe target for an outgoing translation when the contact
      // language is set to auto. Incoming messages can still be auto-detected.
      if (outgoing && contactLanguage === "auto") return;
      const previous = state.scanned.get(message);
      if (!force && previous?.source === sourceText && previous.target === target && previous.sourceLanguage === source && previous.engine === settings.engine && previous.translated) return;
      const failed = state.failures.get(message);
      if (!force && failed?.text === sourceText && failed.engine === settings.engine && Date.now() - failed.at < 30000) return;
      key = `${epoch}|${id}|${sourceText}|${source}|${target}`;
      if (state.pending.has(key)) return;
      state.pending.set(key, true);
      ownsPending = true;
      const result = await send({ type: "translate", items: [{ text: sourceText, source, target, engine: state.settings.engine }] });
      if (state.contextInvalidated || !state.settings?.enabled || currentChatMuted() || message.isConnected === false) return;
      if (state.translationEpoch !== epoch || state.settings !== settings || messageId(message, sourceText) !== id || textFromMessage(message) !== sourceText) return;
      if (result.ok && result.translations?.[0]) {
        state.failures.delete(message);
        renderTranslation(message, result.translations[0], sourceText, target);
        Object.assign(state.scanned.get(message), { sourceLanguage: source, engine: settings.engine });
      } else state.failures.set(message, { text: sourceText, engine: settings.engine, at: Date.now() });
    } catch (error) {
      if (isContextInvalidated(error) || !extensionContextAvailable()) markContextInvalidated();
      else console.error("OpenChat Translator message translation failed", error);
    } finally {
      if (ownsPending) state.pending.delete(key);
    }
  }

  function cancelAutomaticTranslations() {
    state.translationEpoch++;
    state.autoQueue.clear();
    state.autoOverflow = false;
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
  }

  function pumpAutomaticTranslations() {
    if (state.autoTimer !== null || state.autoActive >= MAX_AUTO_ACTIVE ||
        !state.settings?.enabled || !state.settings.autoTranslate || state.contextInvalidated || document.hidden || currentChatMuted()) return;
    if (!state.autoQueue.size) {
      if (state.autoOverflow && state.autoActive === 0) {
        // Overflow is deferred, not forgotten. Refill only from still-visible
        // decorated messages after the bounded queue drains; no extra node list.
        state.autoTimer = setTimeout(() => {
          state.autoTimer = null;
          state.autoOverflow = false;
          if (!state.settings?.enabled || !state.settings.autoTranslate || document.hidden || currentChatMuted()) return;
          document.querySelectorAll("[data-wst-message='true']").forEach((message) => {
            if (!visibilityObserver || state.visibleMessages.has(message)) decorateMessage(message);
          });
        }, 80);
      }
      return;
    }
    // Yield between small groups, and never flood a slow provider with all of
    // the mounted conversation at once. Manual translation remains immediate.
    state.autoTimer = setTimeout(() => {
      state.autoTimer = null;
      if (!state.settings?.enabled || !state.settings.autoTranslate || state.contextInvalidated || document.hidden || currentChatMuted()) return;
      while (state.autoActive < MAX_AUTO_ACTIVE && state.autoQueue.size) {
        const message = state.autoQueue.values().next().value;
        state.autoQueue.delete(message);
        if (message.isConnected === false || (visibilityObserver && !state.visibleMessages.has(message))) continue;
        state.autoActive++;
        translateMessage(message).finally(() => {
          state.autoActive--;
          pumpAutomaticTranslations();
        });
      }
    }, 0);
  }

  function queueAutomaticTranslation(message, text) {
    if (document.hidden || currentChatMuted() || (visibilityObserver && !state.visibleMessages.has(message))) return;
    const outgoing = isOutgoing(message);
    if (outgoing && (!state.settings.translateOutgoing || !state.settings.targetLang || state.settings.targetLang === "auto")) return;
    const userLanguage = state.settings.sourceLang === "auto" ? "zh-CN" : state.settings.sourceLang;
    const source = outgoing ? userLanguage : (state.settings.autoDetectIncoming !== false ? "auto" : state.settings.targetLang);
    const target = outgoing ? state.settings.targetLang : userLanguage;
    const previous = state.scanned.get(message);
    if (previous?.source === text && previous.sourceLanguage === source && previous.target === target && previous.engine === state.settings.engine && previous.translated) return;
    const failed = state.failures.get(message);
    if (failed?.text === text && failed.engine === state.settings.engine && Date.now() - failed.at < 30000) return;
    if (state.autoQueue.size >= MAX_AUTO_QUEUE) {
      state.autoOverflow = true;
      return;
    }
    state.autoQueue.add(message);
    pumpAutomaticTranslations();
  }

  function decorateMessage(message) {
    if (!state.settings?.enabled || state.contextInvalidated || !(message instanceof HTMLElement)) return;
    const parentMessage = message.parentElement?.closest(messageSelectors.join(","));
    if (parentMessage && parentMessage !== message) return;
    const text = textFromMessage(message);
    if (!text) {
      message.querySelectorAll(".wst-translation-row, .wst-message-action").forEach((node) => node.remove());
      delete message.dataset.wstMessage;
      state.scanned.delete(message);
      return;
    }
    if (message.dataset.wstMessage === "true") {
      if (state.settings.autoTranslate) queueAutomaticTranslation(message, text);
      return;
    }
    message.dataset.wstMessage = "true";
    if (getComputedStyle(message).position === "static") message.style.position = "relative";
    const action = document.createElement("button");
    action.className = "wst-message-action";
    action.type = "button";
    action.textContent = "T";
    action.title = "Translate this message";
    action.setAttribute("aria-label", "Translate this message");
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      translateMessage(message, true);
    });
    message.appendChild(action);
    if (state.settings.autoTranslate) queueAutomaticTranslation(message, text);
  }

  function scanMessages(root = document) {
    if (!state.settings?.enabled || state.contextInvalidated) return;
    const selector = messageSelectors.join(",");
    if (root instanceof Element && root.matches(selector)) watchMessage(root);
    root.querySelectorAll?.(selector).forEach(watchMessage);
  }

  // Native visibility tracking batches geometry work and avoids translating the
  // entire mounted history. Weak sets do not keep old conversations alive.
  const visibilityObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        state.visibleMessages.add(entry.target);
        decorateMessage(entry.target);
      } else {
        state.visibleMessages.delete(entry.target);
        state.autoQueue.delete(entry.target);
      }
    }
  }, { rootMargin: "160px 0px" }) : null;

  function watchMessage(message) {
    if (message.parentElement?.closest(messageSelectors.join(","))) return;
    if (!visibilityObserver) return decorateMessage(message);
    if (!state.observedMessages.has(message)) {
      state.observedMessages.add(message);
      visibilityObserver.observe(message);
    } else if (state.visibleMessages.has(message)) decorateMessage(message);
  }

  function releaseMessages(root) {
    const release = (message) => {
      visibilityObserver?.unobserve(message);
      state.observedMessages.delete(message);
      state.visibleMessages.delete(message);
      state.autoQueue.delete(message);
    };
    if (root instanceof Element && root.matches(messageSelectors.join(","))) release(root);
    root.querySelectorAll?.(messageSelectors.join(",")).forEach(release);
  }

  function readComposer() {
    return document.querySelector("footer [contenteditable='true']");
  }

  function composerText(composer) {
    return (composer?.innerText || composer?.textContent || "").replace(/\u200b/g, "").trim();
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function writeComposer(composer, value) {
    if (!composer) return false;
    state.composerWriting = true;
    try {
      composer.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        composer.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          composed: true,
          inputType: "insertReplacementText",
          data: value,
        }));
      } catch {
        composer.dispatchEvent(new Event("beforeinput", { bubbles: true, composed: true }));
      }
      let changed = false;
      try { changed = document.execCommand("insertText", false, value); } catch { changed = false; }
      if (!changed || composerText(composer) !== value) composer.replaceChildren(document.createTextNode(value));
      try {
        composer.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertReplacementText",
          data: value,
        }));
      } catch {
        composer.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      composer.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      const end = document.createRange();
      end.selectNodeContents(composer);
      end.collapse(false);
      selection.removeAllRanges();
      selection.addRange(end);
      await nextFrame();
      return composerText(composer) === value;
    } finally {
      state.composerWriting = false;
    }
  }

  async function translateComposer(sendAfter = false) {
    const composer = readComposer();
    const original = composerText(composer);
    if (!state.settings?.enabled || state.contextInvalidated || !composer || !original || state.composerBusy || currentChatMuted()) return false;
    const settings = state.settings;
    const chat = readActiveChat();
    const revision = state.composerRevision;
    const stillCurrent = (text) => !state.contextInvalidated && state.settings === settings && settings.enabled &&
      !currentChatMuted() && composer.isConnected !== false && readComposer() === composer &&
      readActiveChat().key === chat.key && readActiveChat().label === chat.label && state.composerRevision === revision && composerText(composer) === text;
    state.composerBusy = true;
    try {
      if (state.composerTranslated && original === state.composerTranslated) {
        const restored = await writeComposer(composer, state.composerOriginal);
        state.composerTranslated = "";
        state.composerOriginal = "";
        return restored;
      }
      const result = await send({
        type: "translate",
        items: [{
          text: original,
          source: state.settings.sourceLang === "auto" ? "zh-CN" : state.settings.sourceLang,
          target: state.settings.targetLang,
          engine: state.settings.engine,
        }],
      });
      if (!result.ok || !result.translations?.[0] || !stillCurrent(original)) return false;
      state.composerOriginal = original;
      state.composerTranslated = result.translations[0];
      const written = await writeComposer(composer, state.composerTranslated);
      if (written && sendAfter) {
        const translated = state.composerTranslated;
        setTimeout(() => { if (stillCurrent(translated)) sendComposer(composer); }, 80);
      }
      return written;
    } catch (error) {
      if (isContextInvalidated(error) || !extensionContextAvailable()) markContextInvalidated();
      else console.error("OpenChat Translator composer translation failed", error);
      return false;
    } finally {
      state.composerBusy = false;
    }
  }

  function sendComposer(composer) {
    if (!state.settings?.enabled || state.contextInvalidated || currentChatMuted() || composer.isConnected === false || readComposer() !== composer) return false;
    const sendButton = document.querySelector("button[data-testid='send'], button[aria-label='Send'], button[title='Send']");
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      return true;
    }
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
    return false;
  }

  function setComposerStatus(footer, text, error = false) {
    if (state.contextInvalidated) return;
    let status = footer.querySelector(".wst-compose-status");
    if (!status) {
      status = document.createElement("span");
      status.className = "wst-compose-status";
      footer.appendChild(status);
    }
    status.textContent = text;
    status.dataset.error = error ? "true" : "false";
    clearTimeout(status.__wstTimer);
    status.__wstTimer = setTimeout(() => status.remove(), 3200);
  }

  function decorateComposer() {
    if (!state.settings?.enabled || state.contextInvalidated) return;
    const composer = readComposer();
    const footer = composer?.closest("footer") || composer?.parentElement;
    if (!composer || !footer) {
      state.toolbar?.remove();
      state.toolbar = null;
      return;
    }
    let toolbar = state.toolbar;
    if (!toolbar || toolbar.nextElementSibling !== footer) {
      toolbar?.remove();
      toolbar = document.createElement("div");
      toolbar.className = "wst-compose-tools";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "聊天翻译");
      footer.before(toolbar);
      state.toolbar = toolbar;
    }
    let action = toolbar.querySelector(".wst-compose-action");
    if (!action) {
      action = document.createElement("button");
      action.className = "wst-compose-action";
      action.type = "button";
      action.textContent = "翻译草稿";
      action.title = "翻译草稿，再次点击恢复原文";
      action.setAttribute("aria-label", "翻译草稿，再次点击恢复原文");
      action.addEventListener("click", async () => {
        if (state.composerBusy || currentChatMuted()) return;
        if (!composerText(readComposer())) {
          setComposerStatus(toolbar, "请先输入需要翻译的文字");
          return;
        }
        action.disabled = true;
        action.textContent = "…";
        setComposerStatus(toolbar, "正在翻译草稿");
        const restoring = state.composerTranslated && composerText(readComposer()) === state.composerTranslated;
        const written = await translateComposer(false);
        action.textContent = "翻译草稿";
        updateChatToggle();
        if (written) setComposerStatus(toolbar, restoring ? "已恢复原文" : "已写入译文");
        else setComposerStatus(toolbar, "草稿已更改或翻译未完成，请重试", true);
      });
      toolbar.appendChild(action);
    }

    let chatToggle = toolbar.querySelector(".wst-chat-toggle");
    if (!chatToggle) {
      chatToggle = document.createElement("button");
      chatToggle.className = "wst-chat-toggle";
      chatToggle.type = "button";
      chatToggle.addEventListener("click", async () => {
        const muted = !currentChatMuted();
        const saved = await setCurrentChatMuted(muted);
        setComposerStatus(toolbar, saved ? (muted ? "已暂停当前对话翻译" : "已恢复当前对话翻译") : "暂停状态保存失败，请重试", !saved);
      });
      toolbar.appendChild(chatToggle);
    }

    if (!state.boundComposers.has(composer)) {
      state.boundComposers.add(composer);
      composer.addEventListener("input", () => {
        if (state.composerWriting) return;
        state.composerRevision++;
        if (state.composerTranslated && composerText(composer) !== state.composerTranslated) {
          state.composerOriginal = "";
          state.composerTranslated = "";
        }
      });
      composer.addEventListener("keydown", (event) => {
        if (!state.settings?.enabled || state.contextInvalidated) return;
        if (event.key === "Enter" && event.altKey) {
          event.preventDefault();
          translateComposer(state.settings.sendAfterTranslate);
        }
      });
    }
    updateChatToggle();
  }

  async function loadSettings() {
    const result = await send({ type: "getSettings" });
    if (state.contextInvalidated) return;
    state.settings = publicSettings(result.settings || {
      enabled: true,
      engine: "google",
      sourceLang: "zh-CN",
      targetLang: "en",
      autoTranslate: true,
      autoDetectIncoming: true,
      translateOutgoing: true,
      sendAfterTranslate: false,
      translationColor: "#2563eb",
      fontSize: 13,
    });
    document.documentElement.dataset.openchatTranslator = state.settings.enabled ? "on" : "off";
  }

  async function loadMutedChats() {
    const stored = await safeStorageGet(MUTED_CHATS_KEY);
    if (state.contextInvalidated) return;
    state.mutedChats = new Set(Array.isArray(stored[MUTED_CHATS_KEY]) ? stored[MUTED_CHATS_KEY] : []);
  }

  const ownedSelector = ".wst-translation-row, .wst-message-action, .wst-compose-action, .wst-chat-toggle, .wst-compose-tools, .wst-compose-status, .wst-reload-notice";

  function nodeElement(node) {
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function isOwnedNode(node) {
    return Boolean(nodeElement(node)?.closest(ownedSelector));
  }

  function cancelDomUpdate() {
    clearTimeout(state.domTimer);
    state.domTimer = null;
    state.scanRoots.clear();
  }

  function scheduleDomUpdate(root) {
    if (!state.settings?.enabled || state.contextInvalidated || document.hidden) return;
    if (root) state.scanRoots.add(root);
    if (state.domTimer !== null) return;
    // One pass per burst of WhatsApp mutations, outside the observer microtask.
    state.domTimer = setTimeout(() => {
      state.domTimer = null;
      const roots = new Set(state.scanRoots);
      state.scanRoots.clear();
      if (!state.settings?.enabled || state.contextInvalidated || document.hidden) return;
      refreshActiveChat();
      for (const candidate of roots) {
        if (candidate.isConnected === false) continue;
        let ancestor = candidate.parentNode;
        while (ancestor && !roots.has(ancestor)) ancestor = ancestor.parentNode;
        if (!ancestor) scanMessages(candidate);
      }
      decorateComposer();
    }, 80);
  }

  const observer = new MutationObserver((mutations) => {
    if (!state.settings?.enabled || state.contextInvalidated || document.hidden) return;
    for (const mutation of mutations) {
      const target = nodeElement(mutation.target);
      // Our UI and composer keystrokes cannot introduce received messages.
      if (isOwnedNode(mutation.target) || target?.closest("[contenteditable='true']")) continue;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      if (mutation.type === "childList" && changed.every(isOwnedNode)) continue;
      for (const node of mutation.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.isConnected === false && !isOwnedNode(node)) releaseMessages(node);
      }
      scheduleDomUpdate();
      const message = target?.closest(messageSelectors.join(","));
      if (message) scheduleDomUpdate(message);
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !isOwnedNode(node)) scheduleDomUpdate(node);
      }
    }
  });
  state.observer = observer;

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelDomUpdate();
      cancelAutomaticTranslations();
    }
    else scheduleDomUpdate(document);
  });

  document.addEventListener("pointerover", (event) => {
    if (!state.settings?.enabled) return;
    const target = event.target instanceof Element ? event.target.closest(messageSelectors.join(",")) : null;
    if (target) decorateMessage(target);
  }, { passive: true });

  function onStorageChanged(changes, area) {
    if (state.contextInvalidated || area !== "local") return;
    if (changes[MUTED_CHATS_KEY]) {
      state.mutedChats = new Set(Array.isArray(changes[MUTED_CHATS_KEY].newValue) ? changes[MUTED_CHATS_KEY].newValue : []);
      cancelAutomaticTranslations();
      updateChatToggle();
      if (currentChatMuted()) removeAllTranslations();
      else scheduleDomUpdate(document);
    }
    if (changes.openchatSettings) {
      state.settings = publicSettings(changes.openchatSettings.newValue);
      document.documentElement.dataset.openchatTranslator = state.settings?.enabled ? "on" : "off";
      cancelDomUpdate();
      cancelAutomaticTranslations();
      if (!state.settings?.enabled) {
        visibilityObserver?.disconnect();
        state.observedMessages = new WeakSet();
        state.visibleMessages = new WeakSet();
      }
      scheduleDomUpdate(document);
    }
  }

  (async () => {
    try {
      if (!extensionContextAvailable()) {
        markContextInvalidated();
        return;
      }
      chrome.storage.onChanged.addListener(onStorageChanged);
      await loadSettings();
      if (state.contextInvalidated) return;
      await loadMutedChats();
      if (state.contextInvalidated) return;
      if (!document.hidden && state.settings?.enabled) {
        refreshActiveChat();
        scanMessages();
        decorateComposer();
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      state.scanTimer = setInterval(() => {
        if (state.contextInvalidated) return;
        if (!extensionContextAvailable()) {
          markContextInvalidated();
          return;
        }
        // Only check extension lifetime here; idle tabs must not rescan the DOM.
      }, 1500);
    } catch (error) {
      if (isContextInvalidated(error)) markContextInvalidated();
      else console.error("OpenChat Translator initialization failed", error);
    }
  })();
})();
