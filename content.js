(() => {
  "use strict";

  if (window.__openChatTranslatorLoaded) return;
  window.__openChatTranslatorLoaded = true;

  const state = {
    settings: null,
    scanned: new WeakMap(),
    pending: new Map(),
    mutedChats: new Set(),
    activeChatKey: "",
    activeChatLabel: "当前对话",
    boundComposers: new WeakSet(),
    composerOriginal: "",
    composerTranslated: "",
    composerWriting: false,
  };

  const MUTED_CHATS_KEY = "openchatMutedChats";

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
      button.textContent = muted ? "恢复翻译" : "暂停翻译";
      button.title = muted ? `恢复${state.activeChatLabel}的自动翻译` : `暂停${state.activeChatLabel}的自动翻译`;
      button.setAttribute("aria-label", button.title);
      button.dataset.muted = muted ? "true" : "false";
    });
    document.querySelectorAll(".wst-compose-action").forEach((button) => {
      button.disabled = currentChatMuted() || Boolean(state.composerBusy);
      button.title = currentChatMuted() ? "当前对话已暂停翻译，点击恢复翻译" : "翻译草稿，再次点击恢复原文";
      button.setAttribute("aria-label", button.title);
    });
  }

  async function refreshActiveChat() {
    const next = readActiveChat();
    if (next.key === state.activeChatKey) {
      if (next.label && next.label !== state.activeChatLabel) {
        state.activeChatLabel = next.label;
        updateChatToggle();
      }
      return;
    }
    state.activeChatKey = next.key;
    state.activeChatLabel = next.label;
    state.composerOriginal = "";
    state.composerTranslated = "";
    updateChatToggle();
    if (currentChatMuted()) removeAllTranslations();
  }

  async function setCurrentChatMuted(muted) {
    if (!state.activeChatKey) return false;
    if (muted) state.mutedChats.add(state.activeChatKey);
    else state.mutedChats.delete(state.activeChatKey);
    await chrome.storage.local.set({ [MUTED_CHATS_KEY]: Array.from(state.mutedChats).slice(-200) });
    updateChatToggle();
    if (muted) removeAllTranslations();
    return true;
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
    if (!state.settings?.enabled || currentChatMuted()) return;
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
    if (!composer || !original || state.composerBusy || currentChatMuted()) return false;
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
        items: [{ text: original, source: state.settings.sourceLang, target: state.settings.targetLang, engine: state.settings.engine }],
      });
      if (!result.ok || !result.translations?.[0]) return false;
      state.composerOriginal = original;
      state.composerTranslated = result.translations[0];
      const written = await writeComposer(composer, state.composerTranslated);
      if (written && sendAfter) setTimeout(() => sendComposer(composer), 80);
      return written;
    } finally {
      state.composerBusy = false;
    }
  }

  function sendComposer(composer) {
    const sendButton = document.querySelector("button[data-testid='send'], button[aria-label='Send'], button[title='Send']");
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      return true;
    }
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
    return false;
  }

  function setComposerStatus(footer, text, error = false) {
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
    const composer = readComposer();
    const footer = composer?.closest("footer") || composer?.parentElement;
    if (!composer || !footer) return;
    if (getComputedStyle(footer).position === "static") footer.style.position = "relative";
    let action = footer.querySelector(".wst-compose-action");
    if (!action) {
      action = document.createElement("button");
      action.className = "wst-compose-action";
      action.type = "button";
      action.textContent = "翻译";
      action.title = "翻译草稿，再次点击恢复原文";
      action.setAttribute("aria-label", "翻译草稿，再次点击恢复原文");
      action.addEventListener("click", async () => {
        if (state.composerBusy || currentChatMuted()) return;
        action.disabled = true;
        action.textContent = "…";
        setComposerStatus(footer, "正在翻译草稿");
        const restoring = state.composerTranslated && composerText(composer) === state.composerTranslated;
        const written = await translateComposer(false);
        action.textContent = "翻译";
        updateChatToggle();
        if (written) setComposerStatus(footer, restoring ? "已恢复原文" : "已写入译文");
        else setComposerStatus(footer, "翻译失败，请检查设置或网络", true);
      });
      footer.appendChild(action);
    }

    let chatToggle = footer.querySelector(".wst-chat-toggle");
    if (!chatToggle) {
      chatToggle = document.createElement("button");
      chatToggle.className = "wst-chat-toggle";
      chatToggle.type = "button";
      chatToggle.addEventListener("click", async () => {
        const muted = !currentChatMuted();
        await setCurrentChatMuted(muted);
        setComposerStatus(footer, muted ? "已暂停当前对话翻译" : "已恢复当前对话翻译");
      });
      footer.appendChild(chatToggle);
    }

    if (!state.boundComposers.has(composer)) {
      state.boundComposers.add(composer);
      composer.addEventListener("input", () => {
        if (state.composerWriting) return;
        if (state.composerTranslated && composerText(composer) !== state.composerTranslated) {
          state.composerOriginal = "";
          state.composerTranslated = "";
        }
      });
      composer.addEventListener("keydown", (event) => {
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

  async function loadMutedChats() {
    const stored = await chrome.storage.local.get(MUTED_CHATS_KEY);
    state.mutedChats = new Set(Array.isArray(stored[MUTED_CHATS_KEY]) ? stored[MUTED_CHATS_KEY] : []);
  }

  const observer = new MutationObserver((mutations) => {
    if (!state.settings?.enabled) return;
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scanMessages(node);
      });
    }
    refreshActiveChat();
    decorateComposer();
  });

  document.addEventListener("pointerover", (event) => {
    if (!state.settings?.enabled) return;
    const target = event.target instanceof Element ? event.target.closest(messageSelectors.join(",")) : null;
    if (target) decorateMessage(target);
  }, { passive: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[MUTED_CHATS_KEY]) {
      state.mutedChats = new Set(Array.isArray(changes[MUTED_CHATS_KEY].newValue) ? changes[MUTED_CHATS_KEY].newValue : []);
      updateChatToggle();
      if (currentChatMuted()) removeAllTranslations();
    }
    if (changes.openchatSettings) {
      state.settings = publicSettings(changes.openchatSettings.newValue);
      document.documentElement.dataset.openchatTranslator = state.settings.enabled ? "on" : "off";
      scanMessages();
      decorateComposer();
    }
  });

  (async () => {
    await loadSettings();
    await loadMutedChats();
    await refreshActiveChat();
    scanMessages();
    decorateComposer();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (!state.settings?.enabled) return;
      refreshActiveChat();
      scanMessages();
      decorateComposer();
    }, 1500);
  })();
})();
