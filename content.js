(() => {
  "use strict";

  if (window.__openChatTranslatorLoaded) return;
  window.__openChatTranslatorLoaded = true;

  const state = {
    settings: null,
    scanned: new WeakMap(),
    pending: new Map(),
    composerOriginal: "",
    composerTranslated: "",
  };

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

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: "No response" });
      });
    });
  }

  function publicSettings(settings) {
    if (!settings) return settings;
    const { apiSettings: _apiSettings, ...safeSettings } = settings;
    return safeSettings;
  }

  function textFromMessage(message) {
    const candidates = Array.from(message.querySelectorAll(
      "[data-testid='selectable-text'], .selectable-text, span[dir='auto'], span[dir='ltr'], span[dir='rtl']",
    ));
    const text = candidates
      .map((element) => element.innerText || element.textContent || "")
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter((value) => value && !/^\d{1,2}:\d{2}$/.test(value))
      .sort((left, right) => right.length - left.length)[0] || message.innerText || "";
    return text.replace(/\s+/g, " ").trim();
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
    removeTranslation(message);
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
    if (!state.settings?.enabled) return;
    const sourceText = textFromMessage(message);
    if (!sourceText || sourceText.length > 5000) return;
    const outgoing = isOutgoing(message);
    if (outgoing && !state.settings.translateOutgoing) return;
    const id = messageId(message, sourceText);
    // Settings describe the user's language and the contact's language. Incoming
    // messages therefore travel from contact -> user; outgoing drafts use user -> contact.
    const source = outgoing ? state.settings.sourceLang : state.settings.targetLang;
    const target = outgoing ? state.settings.targetLang : state.settings.sourceLang;
    const previous = state.scanned.get(message);
    if (!force && previous?.source === sourceText && previous.target === target && previous.translated) return;
    const key = `${id}|${sourceText}|${source}|${target}`;
    if (state.pending.has(key)) return;
    state.pending.set(key, true);
    const result = await send({ type: "translate", items: [{ text: sourceText, source, target, engine: state.settings.engine }] });
    state.pending.delete(key);
    if (result.ok && result.translations?.[0]) renderTranslation(message, result.translations[0], sourceText, target);
  }

  function decorateMessage(message) {
    if (!(message instanceof HTMLElement) || message.dataset.wstMessage === "true") return;
    const parentMessage = message.parentElement?.closest(messageSelectors.join(","));
    if (parentMessage && parentMessage !== message) return;
    const text = textFromMessage(message);
    if (!text) return;
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
    if (state.settings.autoTranslate) translateMessage(message);
  }

  function scanMessages(root = document) {
    const selector = messageSelectors.join(",");
    if (root instanceof Element && root.matches(selector)) decorateMessage(root);
    root.querySelectorAll?.(selector).forEach(decorateMessage);
  }

  function readComposer() {
    return document.querySelector("footer [contenteditable='true'], [role='textbox'][contenteditable='true']");
  }

  function composerText(composer) {
    return (composer?.innerText || composer?.textContent || "").replace(/\u200b/g, "").trim();
  }

  function writeComposer(composer, value) {
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
        inputType: "insertText",
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
        inputType: "insertText",
        data: value,
      }));
    } catch {
      composer.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
    composer.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return composerText(composer) === value;
  }

  async function translateComposer(sendAfter = false) {
    const composer = readComposer();
    const original = composerText(composer);
    if (!composer || !original || state.composerBusy) return false;
    state.composerBusy = true;
    if (state.composerTranslated && original === state.composerTranslated) {
      const restored = writeComposer(composer, state.composerOriginal);
      state.composerTranslated = "";
      state.composerOriginal = "";
      state.composerBusy = false;
      return restored;
    }
    try {
      const result = await send({
        type: "translate",
        items: [{ text: original, source: state.settings.sourceLang, target: state.settings.targetLang, engine: state.settings.engine }],
      });
      if (!result.ok || !result.translations?.[0]) return false;
      state.composerOriginal = original;
      state.composerTranslated = result.translations[0];
      const written = writeComposer(composer, state.composerTranslated);
      if (written && sendAfter) setTimeout(() => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true })), 30);
      return written;
    } finally {
      state.composerBusy = false;
    }
  }

  function decorateComposer() {
    const composer = readComposer();
    const footer = composer?.closest("footer") || composer?.parentElement;
    if (!composer || !footer || footer.querySelector(".wst-compose-action")) return;
    if (getComputedStyle(footer).position === "static") footer.style.position = "relative";
    const action = document.createElement("button");
    action.className = "wst-compose-action";
    action.type = "button";
    action.textContent = "T";
    action.title = "翻译草稿，再次点击恢复原文";
    action.setAttribute("aria-label", "翻译草稿");
    action.addEventListener("click", async () => {
      if (state.composerBusy) return;
      const previous = action.textContent;
      action.disabled = true;
      action.textContent = "...";
      const written = await translateComposer(false);
      action.disabled = false;
      action.textContent = previous;
      if (!written) action.title = "翻译失败，请检查引擎或 API 设置";
    });
    footer.appendChild(action);
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.altKey) {
        event.preventDefault();
        translateComposer(state.settings.sendAfterTranslate);
      }
    });
  }

  async function loadSettings() {
    const result = await send({ type: "getSettings" });
    state.settings = publicSettings(result.settings || {
      enabled: true,
      engine: "google",
      sourceLang: "zh-CN",
      targetLang: "en",
      autoTranslate: true,
      translateOutgoing: true,
      sendAfterTranslate: false,
      translationColor: "#2563eb",
      fontSize: 13,
    });
    document.documentElement.dataset.openchatTranslator = state.settings.enabled ? "on" : "off";
  }

  const observer = new MutationObserver((mutations) => {
    if (!state.settings?.enabled) return;
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scanMessages(node);
      });
    }
    decorateComposer();
  });

  document.addEventListener("pointerover", (event) => {
    if (!state.settings?.enabled) return;
    const target = event.target instanceof Element ? event.target.closest(messageSelectors.join(",")) : null;
    if (target) decorateMessage(target);
  }, { passive: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.openchatSettings) return;
    state.settings = publicSettings(changes.openchatSettings.newValue);
    document.documentElement.dataset.openchatTranslator = state.settings.enabled ? "on" : "off";
    scanMessages();
    decorateComposer();
  });

  (async () => {
    await loadSettings();
    scanMessages();
    decorateComposer();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (!state.settings?.enabled) return;
      scanMessages();
      decorateComposer();
    }, 1500);
  })();
})();
