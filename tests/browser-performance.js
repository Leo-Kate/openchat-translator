/* Real browser DOM regression tests. No WhatsApp account or network API is used.
 * Load this file in a blank Chrome tab, then call:
 *   await runOpenChatPerformanceTests(contentScriptSource)
 * The observer guard prevents a regressed script from freezing the test tab.
 */
globalThis.runOpenChatPerformanceTests = async function (source, stylesheet = "") {
  const results = [];
  const wait = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  async function fixture(options = {}) {
    const frame = document.createElement("iframe");
    frame.title = "Isolated translator regression fixture";
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const doc = win.document;
    const style = doc.createElement("style");
    style.textContent = stylesheet;
    doc.head.appendChild(style);
    doc.body.innerHTML = '<header data-testid="conversation-info-header"><span dir="auto">Test contact</span></header><main></main><footer><div contenteditable="true" role="textbox"></div></footer>';
    let hidden = false;
    Object.defineProperty(doc, "hidden", { get: () => hidden });
    const metrics = { observerCallbacks: 0, guardHit: false, documentScans: 0, subtreeScans: 0, domPasses: 0, observed: 0, unobserved: 0 };
    const nativeQueryAll = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = (selector) => {
      if (selector.includes("div.message-in")) metrics.documentScans++;
      return nativeQueryAll(selector);
    };
    const nativeElementQueryAll = win.Element.prototype.querySelectorAll;
    win.Element.prototype.querySelectorAll = function (selector) {
      if (selector.includes("div.message-in")) metrics.subtreeScans++;
      return nativeElementQueryAll.call(this, selector);
    };
    const settings = {
      enabled: true, autoTranslate: true, translateOutgoing: true,
      sourceLang: "zh-CN", targetLang: "en", engine: "google",
      autoDetectIncoming: true,
      translationColor: "#2563eb", fontSize: 13,
      ...options.settings,
    };
    const requests = [];
    const replies = [];
    const errors = [];
    const intervals = new Map();
    const observers = [];
    const timeouts = new Set();
    let intervalId = 0;
    let storageListener;
    const chrome = {
      runtime: {
        id: "test-extension",
        sendMessage(message, callback) {
          if (message.type === "getSettings") callback({ ok: true, settings });
          else {
            requests.push(message);
            const reply = () => callback(options.failure ? { ok: false, error: "Test provider unavailable" } : { ok: true, translations: message.items.map((item) => options.echo ? `译文(${item.text})` : "测试译文") });
            if (options.delayed) replies.push(reply);
            else reply();
          }
        },
      },
      storage: {
        local: { get(key, callback) { callback({}); }, set(value, callback) { callback(); } },
        onChanged: { addListener(listener) { storageListener = listener; } },
      },
    };
    const NativeObserver = win.MutationObserver;
    function GuardedObserver(callback) {
      let callbacksInTask = 0;
      let resetPending = false;
      const observer = new NativeObserver((records) => {
        metrics.observerCallbacks++;
        callbacksInTask++;
        if (!resetPending) {
          resetPending = true;
          win.setTimeout(() => { callbacksInTask = 0; resetPending = false; }, 0);
        }
        if (callbacksInTask >= 200) {
          metrics.guardHit = true;
          observer.disconnect();
          return;
        }
        callback(records);
      });
      observers.push(observer);
      return observer;
    }
    const captureTimeout = (callback, delay) => {
      if (delay === 80) metrics.domPasses++;
      const id = win.setTimeout(() => { timeouts.delete(id); callback(); }, delay);
      timeouts.add(id);
      return id;
    };
    const visible = new Set();
    let visibilityCallback;
    const visibilityObservers = [];
    function VisibilityObserver(callback, config) {
      visibilityCallback = callback;
      const observer = options.realVisibility ? new win.IntersectionObserver(callback, config) : null;
      if (observer) visibilityObservers.push(observer);
      return {
        observe(message) {
          metrics.observed++;
          visible.add(message);
          if (observer) observer.observe(message);
          else queueMicrotask(() => callback([{ target: message, isIntersecting: !options.offscreen }]));
        },
        unobserve(message) { metrics.unobserved++; visible.delete(message); observer?.unobserve(message); },
        disconnect() { visible.clear(); observer?.disconnect(); },
      };
    }
    win.Function("chrome", "MutationObserver", "IntersectionObserver", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "console", source)(
      chrome, GuardedObserver, VisibilityObserver,
      (callback) => { const id = ++intervalId; intervals.set(id, callback); return id; },
      (id) => intervals.delete(id), captureTimeout,
      (id) => { win.clearTimeout(id); timeouts.delete(id); },
      { error: (...args) => errors.push(args.map(String).join(" ")) },
    );
    await wait(0);
    return {
      doc, win, metrics, requests, errors, replies, chrome, settings,
      showMessage(message, value) { visibilityCallback([{ target: message, isIntersecting: value }]); },
      changeSettings(patch) {
        Object.assign(settings, patch);
        storageListener({ openchatSettings: { newValue: { ...settings } } }, "local");
      },
      addMessage(id = "message1", parent = doc.querySelector("main")) {
        const message = doc.createElement("div");
        message.className = "message-in";
        message.dataset.id = `false_testchat_${id}`;
        const text = doc.createElement("span");
        text.className = "selectable-text";
        text.textContent = `Hello ${id}`;
        message.appendChild(text);
        parent.appendChild(message);
        return message;
      },
      tick() { [...intervals.values()].forEach((callback) => callback()); },
      setHidden(value) { hidden = value; doc.dispatchEvent(new win.Event("visibilitychange")); },
      setEnabled(value) {
        settings.enabled = value;
        storageListener({ openchatSettings: { newValue: { ...settings } } }, "local");
      },
      dispose() {
        observers.forEach((observer) => observer.disconnect());
        visibilityObservers.forEach((observer) => observer.disconnect());
        timeouts.forEach((id) => win.clearTimeout(id));
        frame.remove();
      },
    };
  }

  async function check(name, action, options) {
    const page = await fixture(options);
    try {
      await action(page);
      assert(!page.metrics.guardHit, "MutationObserver guard reached 200 callbacks");
      assert(page.errors.length === 0, page.errors.join("; "));
      results.push({ name, pass: true, metrics: { ...page.metrics }, requests: page.requests.length });
    } catch (error) {
      results.push({ name, pass: false, error: error.message, metrics: { ...page.metrics }, requests: page.requests.length });
    } finally {
      page.dispose();
    }
  }

  await check("one unrelated DOM mutation settles without feedback", async (page) => {
    page.doc.body.appendChild(page.doc.createElement("section"));
    await wait();
    assert(page.metrics.observerCallbacks <= 3, `Unexpected callbacks: ${page.metrics.observerCallbacks}`);
    assert(page.metrics.documentScans === 1, "Unrelated mutations caused a full document scan");
    const before = page.metrics.observerCallbacks;
    await wait();
    assert(page.metrics.observerCallbacks === before, "Observer did not become idle");
  });

  await check("twenty idle heartbeats perform no DOM scans", async (page) => {
    const scans = page.metrics.documentScans + page.metrics.subtreeScans;
    for (let i = 0; i < 20; i++) page.tick();
    await wait();
    assert(page.metrics.documentScans + page.metrics.subtreeScans === scans, "Heartbeat scanned messages");
    assert(page.metrics.observerCallbacks === 0, "Heartbeat mutated the DOM");
  });

  await check("typing and extension UI updates do not schedule scans", async (page) => {
    const composer = page.doc.querySelector("[contenteditable]");
    for (let i = 0; i < 25; i++) composer.textContent = `Draft ${i}`;
    const status = page.doc.createElement("span");
    status.className = "wst-compose-status";
    page.doc.querySelector("footer").appendChild(status);
    status.textContent = "Test status";
    await wait();
    status.remove();
    await wait();
    assert(page.metrics.domPasses === 0, "Typing or extension UI scheduled a DOM pass");
    assert(page.metrics.documentScans === 1, "Typing caused a full document scan");
  });

  await check("a burst of new messages uses one pass and no duplicate translations", async (page) => {
    for (let i = 0; i < 25; i++) page.addMessage(`burst${i}`);
    await wait();
    assert(page.requests.length === 25, `Expected 25 translations, received ${page.requests.length}`);
    assert(page.doc.querySelectorAll(".wst-translation-row").length === 25, "New messages were not translated");
    assert(page.metrics.domPasses === 1, `Expected one DOM pass, received ${page.metrics.domPasses}`);
    assert(page.metrics.documentScans === 1, "New messages caused a full document scan");
  });

  await check("overlapping added subtrees are scanned once", async (page) => {
    const group = page.doc.createElement("section");
    page.doc.querySelector("main").appendChild(group);
    page.addMessage("nested", group);
    await wait();
    assert(page.metrics.subtreeScans === 1, `Expected one subtree scan, received ${page.metrics.subtreeScans}`);
    assert(page.requests.length === 1, "Nested message translation was duplicated");
  });

  await check("pause blocks new translations and resume processes missed messages", async (page) => {
    page.addMessage("first");
    await wait();
    page.doc.querySelector(".wst-chat-toggle").click();
    await wait();
    page.addMessage("paused");
    await wait();
    assert(page.requests.length === 1, "Paused chat issued a translation request");
    page.doc.querySelector(".wst-chat-toggle").click();
    await wait();
    assert(page.requests.length === 2, "Resume did not translate the new message");
    assert(page.doc.querySelectorAll(".wst-message-action").length === 2, "Resume duplicated message buttons");
  });

  await check("a replaced composer gets exactly one set of controls", async (page) => {
    const footer = page.doc.createElement("footer");
    footer.innerHTML = '<div contenteditable="true" role="textbox"></div>';
    page.doc.querySelector("footer").replaceWith(footer);
    await wait();
    assert(page.doc.querySelectorAll(".wst-compose-action").length === 1, "Composer translation control missing or duplicated");
    assert(page.doc.querySelectorAll(".wst-chat-toggle").length === 1, "Chat pause control missing or duplicated");
    assert(footer.previousElementSibling.classList.contains("wst-compose-tools"), "Controls did not follow the replacement footer");
  });

  await check("chat search is never selected as the message composer", async (page) => {
    const search = page.doc.createElement("div");
    search.contentEditable = "true";
    search.setAttribute("role", "textbox");
    search.textContent = "Search text";
    page.doc.body.prepend(search);
    const composer = page.doc.querySelector("footer [contenteditable]");
    composer.textContent = "Actual message";
    page.doc.querySelector(".wst-compose-action").click();
    await wait(350);
    assert(page.requests[0].items[0].text === "Actual message", "The search field was translated");
    assert(search.textContent === "Search text", "The search field was changed");
  });

  await check("hidden tab defers new messages until visible", async (page) => {
    page.setHidden(true);
    page.addMessage("hidden");
    page.tick();
    await wait();
    assert(page.requests.length === 0, "Hidden tab translated a new message");
    assert(page.metrics.documentScans === 1, "Hidden tab scanned the document");
    page.setHidden(false);
    await wait();
    assert(page.requests.length === 1, "Visible tab did not catch up");
  });

  await check("disable cancels queued scans and enable catches up", async (page) => {
    page.addMessage("disabled");
    await wait(0);
    page.setEnabled(false);
    await wait();
    assert(page.requests.length === 0, "Disabled extension processed queued work");
    page.setEnabled(true);
    await wait();
    assert(page.requests.length === 1, "Enabled extension did not catch up");
  });

  await check("invalidation cancels queued scans", async (page) => {
    page.addMessage("invalidated");
    await wait(0);
    page.chrome.runtime.id = undefined;
    page.tick();
    await wait();
    assert(page.requests.length === 0, "Invalidated extension processed queued work");
    assert(page.doc.querySelectorAll(".wst-reload-notice").length === 1, "Reload notice missing");
    assert(!page.doc.querySelector(".wst-compose-action"), "Invalidated control remains");
  });

  await check("a translation response cannot render after pause", async (page) => {
    page.addMessage("late");
    await wait();
    assert(page.replies.length === 1, "Expected a pending translation");
    page.doc.querySelector(".wst-chat-toggle").click();
    await wait(0);
    page.replies.shift()();
    await wait();
    assert(!page.doc.querySelector(".wst-translation-row"), "Late response rendered in paused chat");
  }, { delayed: true });

  await check("manual message translation still works", async (page) => {
    page.addMessage("manual");
    await wait();
    page.doc.querySelector(".wst-message-action").click();
    await wait();
    assert(page.requests.length === 2, "Manual translation button did not request translation");
  });

  await check("manual mode does not automatically translate new messages", async (page) => {
    page.addMessage("manual-only");
    await wait();
    assert(page.requests.length === 0, "Manual mode automatically translated a message");
    page.doc.querySelector(".wst-message-action").click();
    await wait();
    assert(page.requests.length === 1, "Manual mode translation button did not work");
  }, { settings: { autoTranslate: false } });

  await check("repeated clicks preserve pending request deduplication", async (page) => {
    page.addMessage("pending");
    await wait();
    const action = page.doc.querySelector(".wst-message-action");
    action.click();
    await wait(0);
    action.click();
    await wait(0);
    assert(page.requests.length === 1, "Duplicate click deleted another request's pending lock");
    page.replies.shift()();
    await wait();
    assert(page.doc.querySelectorAll(".wst-translation-row").length === 1, "Pending response was not rendered once");
  }, { delayed: true });

  await check("draft translation and restore still work", async (page) => {
    const composer = page.doc.querySelector("[contenteditable]");
    composer.textContent = "Test draft";
    const action = page.doc.querySelector(".wst-compose-action");
    action.click();
    await wait(350);
    assert(composer.textContent === "测试译文", "Draft was not translated");
    action.click();
    await wait(350);
    assert(composer.textContent === "Test draft", "Original draft was not restored");
    assert(page.requests.length === 1, "Restoring a draft made another API request");
  });

  await check("media-only bubble never translates its timestamp or stale plugin UI", async (page) => {
    const media = page.doc.createElement("div");
    media.className = "message-in";
    media.dataset.id = "false_testchat_photo";
    media.innerHTML = '<img alt="Photo"><span dir="auto">05:15</span>';
    page.doc.querySelector("main").appendChild(media);
    await wait();
    for (let i = 0; i < 8; i++) {
      media.dispatchEvent(new page.win.Event("pointerover", { bubbles: true }));
      await wait(0);
    }
    assert(page.requests.length === 0, `Media translated UI: ${page.requests.map((request) => request.items[0].text).join(" | ")}`);
    assert(!media.querySelector(".wst-translation-row"), "Media received a bogus translation");
  }, { echo: true });

  await check("repeated draft translation and restore never append duplicate text", async (page) => {
    const composer = page.doc.querySelector("[contenteditable]");
    const action = page.doc.querySelector(".wst-compose-action");
    composer.textContent = "Hello, hello";
    for (let i = 0; i < 3; i++) {
      action.click();
      await wait(200);
      assert(composer.textContent === "测试译文", "Translation appended to the existing draft");
      action.click();
      await wait(200);
      assert(composer.textContent === "Hello, hello", "Restore duplicated the original draft");
    }
    assert(page.requests.length === 3, "Restore sent a translation request");
  });

  await check("an empty composer explains the button without making a request", async (page) => {
    page.doc.querySelector(".wst-compose-action").click();
    await wait();
    assert(page.requests.length === 0, "An empty composer contacted a provider");
    assert(page.doc.querySelector(".wst-compose-status").textContent.includes("请先输入"), "Empty composer has no useful feedback");
  });

  await check("caption rescans never include previous translations or button text", async (page) => {
    const message = page.addMessage("caption");
    message.querySelector(".selectable-text").textContent = "Original caption";
    message.insertAdjacentHTML("afterbegin", '<img alt="Photo">');
    await wait();
    for (let i = 0; i < 10; i++) {
      message.dispatchEvent(new page.win.Event("pointerover", { bubbles: true }));
      await wait(0);
    }
    assert(page.requests.length === 1, "Unchanged caption translated repeatedly");
    assert(page.requests[0].items[0].text === "Original caption", "Caption input contains UI");
    assert(message.querySelectorAll(".wst-translation-row").length === 1, "Caption has duplicate translation rows");
  }, { echo: true });

  await check("videos, voice notes, files and QR bubbles have no translation controls", async (page) => {
    const examples = [
      '<video></video><div data-pre-plain-text="clip"><span dir="auto">00:25</span><span dir="auto">140 KB</span></div>',
      '<audio></audio><span dir="auto">00:10</span>',
      '<div data-testid="document-title"><span class="selectable-text">Invoice.pdf</span></div><span data-testid="media-info">140 KB</span>',
      '<canvas></canvas><span class="selectable-text">20:58</span>',
      '<img alt="QR code"><span class="selectable-text">140 KB</span>',
    ];
    for (let i = 0; i < examples.length; i++) {
      const message = page.addMessage(`media${i}`);
      message.innerHTML = examples[i];
    }
    await wait();
    assert(page.requests.length === 0, "Media metadata was submitted to a provider");
    assert(!page.doc.querySelector(".wst-message-action"), "Media has a translation button");
  });

  await check("pure links, wallet addresses and transaction hashes are skipped", async (page) => {
    const examples = [
      "https://example.com/product/long-russian-name?ref=123",
      "https://example.com/a https://example.com/b",
      "www.example.com/hello", "example.com/product",
      "0x" + "a".repeat(40), "a".repeat(64), "T" + "A".repeat(33),
    ];
    for (let i = 0; i < examples.length; i++) page.addMessage(`link${i}`).querySelector(".selectable-text").textContent = examples[i];
    await wait();
    assert(page.requests.length === 0, "A link or address was translated");
    assert(!page.doc.querySelector(".wst-message-action"), "A link or address has a translation button");
  });

  await check("link previews and quoted text never replace the actual message", async (page) => {
    const message = page.addMessage("preview");
    message.querySelector(".selectable-text").textContent = "Please see https://example.com/model-123";
    message.insertAdjacentHTML("afterbegin", '<div data-testid="link-preview"><span class="selectable-text">Long preview description that must never be translated as the original message body</span></div><div data-testid="quoted-message"><span class="selectable-text">Quoted text is not the new message either</span></div>');
    await wait();
    assert(page.requests.length === 1, "Ordinary text containing a URL was skipped");
    assert(page.requests[0].items[0].text === "Please see https://example.com/model-123", "Translated preview or quoted text");
  });

  await check("each incoming Russian, Spanish and English message uses automatic detection", async (page) => {
    for (const [i, text] of ["Сколько стоит доставка?", "¿Está disponible este modelo?", "Can you send more photos?"].entries()) {
      page.addMessage(`language${i}`).querySelector(".selectable-text").textContent = text;
    }
    await wait();
    assert(page.requests.length === 3, "A language was not translated");
    assert(page.requests.every((request) => request.items[0].source === "auto" && request.items[0].target === "zh-CN"), "Contact's fixed English setting leaked into incoming translation");
  });

  await check("fixed incoming language remains available when detection is disabled", async (page) => {
    page.addMessage("fixed");
    await wait();
    assert(page.requests[0].items[0].source === "es", "Fixed incoming source was ignored");
  }, { settings: { autoDetectIncoming: false, targetLang: "es" } });

  await check("draft reply language stays explicit while incoming language is automatic", async (page) => {
    const composer = page.doc.querySelector("[contenteditable]");
    composer.textContent = "您好，这款有货";
    page.doc.querySelector(".wst-compose-action").click();
    await wait(350);
    assert(page.requests.length === 1, "Draft request missing");
    assert(page.requests[0].items[0].source === "zh-CN" && page.requests[0].items[0].target === "es", "Incoming detection changed the reply target");
  }, { settings: { targetLang: "es" } });

  await check("offscreen history is deferred and entering view starts translation", async (page) => {
    const message = page.addMessage("outside");
    await wait();
    assert(page.requests.length === 0, "Offscreen history translated automatically");
    page.showMessage(message, true);
    await wait();
    assert(page.requests.length === 1, "Message entering view was not translated");
  }, { offscreen: true });

  await check("removed message nodes release visibility observers and queued work", async (page) => {
    const group = page.doc.createElement("section");
    page.doc.querySelector("main").appendChild(group);
    for (let i = 0; i < 30; i++) page.addMessage(`removed${i}`, group);
    await wait();
    const started = page.requests.length;
    group.remove();
    await wait(0);
    page.replies.splice(0).forEach((reply) => reply());
    await wait();
    assert(page.metrics.unobserved === 30, `Visibility targets retained: ${30 - page.metrics.unobserved}`);
    assert(page.requests.length === started, "Removed messages started new requests");
  }, { delayed: true });

  await check("a large history uses native visibility and only translates nearby messages", async (page) => {
    page.doc.head.insertAdjacentHTML("beforeend", '<style>body { margin:0 } main { height:120px; overflow:auto } .message-in { min-height:36px } footer { height:40px }</style>');
    const group = page.doc.createElement("section");
    for (let i = 0; i < 1000; i++) page.addMessage(`history${i}`, group);
    page.doc.querySelector("main").appendChild(group);
    await wait(400);
    assert(page.requests.length > 0 && page.requests.length < 20, `Initial 1000-message history requests: ${page.requests.length}`);
    const initial = page.requests.length;
    page.doc.querySelector("main").scrollTop = 36000;
    await wait(400);
    assert(page.requests.length > initial && page.requests.length < 40, "Scrolling flooded the provider or did not translate the visible history");
    group.remove();
    await wait();
    assert(page.metrics.unobserved === 1000, "Removed history still observed");
  }, { realVisibility: true });

  await check("failed automatic translations do not retry on every hover", async (page) => {
    const message = page.addMessage("failed");
    await wait();
    for (let i = 0; i < 10; i++) message.dispatchEvent(new page.win.Event("pointerover", { bubbles: true }));
    await wait();
    assert(page.requests.length === 1, "A failed provider was flooded with retries");
    message.querySelector(".wst-message-action").click();
    await wait();
    assert(page.requests.length === 2, "Explicit retry was blocked");
  }, { failure: true });

  await check("translation controls reserve their own row outside the native composer", async (page) => {
    page.doc.head.insertAdjacentHTML("beforeend", '<style>body { display:flex; flex-direction:column; margin:0 } main { height:40px } footer { display:flex; align-items:center; min-height:50px } [contenteditable] { min-height:24px; flex:1 }</style>');
    const toolbar = page.doc.querySelector(".wst-compose-tools");
    const footer = page.doc.querySelector("footer");
    assert(toolbar.nextElementSibling === footer, "Toolbar is not immediately above the input area");
    assert(!footer.querySelector(".wst-compose-action"), "Button still overlays the input area");
    assert(toolbar.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top, "Toolbar overlaps the native composer");
  });

  await check("controls fit a narrow dark window and disappear when disabled", async (page) => {
    page.win.frameElement.style.width = "320px";
    page.doc.head.insertAdjacentHTML("beforeend", '<style>body { --panel-background:#202c33; --primary:#fff; display:flex; flex-direction:column; margin:0; background:#111b21 } footer { display:flex; min-height:50px } [contenteditable] { flex:1; min-height:24px }</style>');
    const toolbar = page.doc.querySelector(".wst-compose-tools");
    assert(page.doc.documentElement.scrollWidth <= 320, "Toolbar causes horizontal overflow");
    if (stylesheet) {
      assert(page.win.getComputedStyle(toolbar).backgroundColor === "rgb(32, 44, 51)", "Toolbar ignores WhatsApp's dark panel color");
      page.setEnabled(false);
      await wait();
      assert(page.win.getComputedStyle(toolbar).display === "none", "Disabled extension leaves controls in the layout");
    }
  });

  await check("a pending draft cannot overwrite text edited by the user", async (page) => {
    const composer = page.doc.querySelector("[contenteditable]");
    composer.textContent = "Original draft";
    page.doc.querySelector(".wst-compose-action").click();
    await wait(0);
    composer.textContent = "Edited while waiting";
    composer.dispatchEvent(new page.win.Event("input", { bubbles: true }));
    page.replies.shift()();
    await wait(350);
    assert(composer.textContent === "Edited while waiting", "Late API response overwrote the user's edits");
  }, { delayed: true });

  await check("a pending draft cannot write into a different chat", async (page) => {
    const composer = page.doc.querySelector("[contenteditable]");
    composer.textContent = "Original draft";
    page.doc.querySelector(".wst-compose-action").click();
    await wait(0);
    page.doc.querySelector("header span").textContent = "Other contact";
    page.replies.shift()();
    await wait(350);
    assert(composer.textContent === "Original draft", "Old chat's translation was written after switching contact");
  }, { delayed: true });

  await check("a pending draft cannot write after disabling translation", async (page) => {
    const composer = page.doc.querySelector("[contenteditable]");
    composer.textContent = "Original draft";
    page.doc.querySelector(".wst-compose-action").click();
    await wait(0);
    page.setEnabled(false);
    page.replies.shift()();
    await wait(350);
    assert(composer.textContent === "Original draft", "Disabled extension wrote a late draft");
  }, { delayed: true });

  await check("a late response cannot translate recycled message text", async (page) => {
    const message = page.addMessage("recycled");
    await wait();
    message.dataset.id = "false_testchat_replacement";
    message.querySelector(".selectable-text").textContent = "Replacement text";
    page.replies.shift()();
    await wait(0);
    assert(!message.querySelector(".wst-translation-row"), "Recycled node displayed stale translation");
  }, { delayed: true });

  await check("automatic translation caps concurrent work and disable drops its backlog", async (page) => {
    for (let i = 0; i < 80; i++) page.addMessage(`slow${i}`);
    await wait();
    assert(page.requests.length > 0 && page.requests.length <= 2, `Automatic requests in flight: ${page.requests.length}`);
    const started = page.requests.length;
    page.setEnabled(false);
    page.replies.splice(0).forEach((reply) => reply());
    await wait();
    assert(page.requests.length === started, "Disabled extension started its queued API requests");
    assert(!page.doc.querySelector(".wst-translation-row"), "Disabled extension rendered a late automatic translation");
  }, { delayed: true });

  await check("queue overflow is deferred and eventually translates every visible message", async (page) => {
    for (let i = 0; i < 80; i++) page.addMessage(`overflow${i}`);
    await wait();
    for (let turn = 0; turn < 120 && page.requests.length < 80; turn++) {
      assert(page.replies.length <= 2, `Too many concurrent requests: ${page.replies.length}`);
      page.replies.splice(0).forEach((reply) => reply());
      await wait(10);
    }
    page.replies.splice(0).forEach((reply) => reply());
    await wait();
    assert(page.requests.length === 80, `Visible messages lost at the queue limit: ${80 - page.requests.length}`);
    assert(page.doc.querySelectorAll(".wst-translation-row").length === 80, "Deferred translations did not finish");
  }, { delayed: true });

  return { passed: results.filter((result) => result.pass).length, total: results.length, results };
};
