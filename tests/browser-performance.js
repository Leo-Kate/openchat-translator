/* Real browser DOM regression tests. No WhatsApp account or network API is used.
 * Load this file in a blank Chrome tab, then call:
 *   await runOpenChatPerformanceTests(contentScriptSource)
 * The observer guard prevents a regressed script from freezing the test tab.
 */
globalThis.runOpenChatPerformanceTests = async function (source) {
  const results = [];
  const wait = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  async function fixture(options = {}) {
    const frame = document.createElement("iframe");
    frame.title = "Isolated translator regression fixture";
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const doc = win.document;
    doc.body.innerHTML = '<header data-testid="conversation-info-header"><span dir="auto">Test contact</span></header><main></main><footer><div contenteditable="true" role="textbox"></div></footer>';
    let hidden = false;
    Object.defineProperty(doc, "hidden", { get: () => hidden });
    const metrics = { observerCallbacks: 0, guardHit: false, documentScans: 0, subtreeScans: 0, domPasses: 0 };
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
            const reply = () => callback({ ok: true, translations: message.items.map(() => "测试译文") });
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
      const observer = new NativeObserver((records) => {
        metrics.observerCallbacks++;
        if (metrics.observerCallbacks >= 200) {
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
    win.Function("chrome", "MutationObserver", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "console", source)(
      chrome, GuardedObserver,
      (callback) => { const id = ++intervalId; intervals.set(id, callback); return id; },
      (id) => intervals.delete(id), captureTimeout,
      (id) => { win.clearTimeout(id); timeouts.delete(id); },
      { error: (...args) => errors.push(args.map(String).join(" ")) },
    );
    await wait(0);
    return {
      doc, win, metrics, requests, errors, replies, chrome,
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
    assert(footer.querySelectorAll(".wst-compose-action").length === 1, "Composer translation control missing or duplicated");
    assert(footer.querySelectorAll(".wst-chat-toggle").length === 1, "Chat pause control missing or duplicated");
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

  return { passed: results.filter((result) => result.pass).length, total: results.length, results };
};
