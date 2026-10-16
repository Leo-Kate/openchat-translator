const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// Exercise the unmodified content script through Chrome callbacks and DOM events.
// No private functions are exported, and no real chats or translation APIs are used.
function fixture(options = {}) {
  class Element {
    constructor(tag = "div") {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.events = {};
      this.style = { setProperty() {} };
      this.className = "";
      this.innerText = "";
      this.textContent = "";
      this.nodeType = 1;
      this.classList = {
        contains: (name) => this.className.split(" ").includes(name),
        add: (name) => { this.className += ` ${name}`; },
      };
    }
    append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
    appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
    before(node) {
      node.parentElement = this.parentElement;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, node);
    }
    get nextElementSibling() {
      return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null;
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] || null; }
    cloneNode() { return { textContent: this.textContent || this.innerText, querySelectorAll: () => [] }; }
    addEventListener(name, listener) { this.events[name] = listener; }
    closest(selector) { return selector === "footer" && this === composer ? footer : null; }
    matches() { return false; }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]).filter((node) => {
        return selector.split(",").some((part) => node.classList.contains(part.trim().replace(/^:scope > /, "").slice(1)));
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  const body = new Element("body");
  const footer = new Element("footer");
  const composer = new Element();
  footer.appendChild(composer);
  body.appendChild(footer);
  const header = new Element("header");
  header.innerText = "Test contact";
  const root = new Element("html");
  const messages = [];
  if (options.message) {
    const message = new Element();
    message.attributes["data-id"] = "false_testchat_message1";
    const text = new Element();
    text.innerText = "Hello";
    const findAll = message.querySelectorAll.bind(message);
    const find = message.querySelector.bind(message);
    message.querySelectorAll = (selector) => selector.includes("selectable-text") ? [text] : findAll(selector);
    message.querySelector = (selector) => selector.startsWith("[data-testid='selectable-text']") ? text : find(selector);
    message.appendChild(text);
    messages.push(message);
    body.appendChild(message);
  }
  const document = {
    body,
    documentElement: root,
    createElement: (tag) => new Element(tag),
    addEventListener() {},
    querySelector: (selector) => {
      if (selector.includes("contenteditable")) return composer;
      if (selector === "[data-testid='conversation-info-header']") return header;
      if (selector.includes("[data-id]")) return messages[0] || null;
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector.includes("message-in")) return messages;
      if (selector === "header") return [header];
      return body.querySelectorAll(selector);
    },
  };

  const settings = {
    enabled: true, sourceLang: "zh-CN", targetLang: "en", engine: "google",
    autoTranslate: Boolean(options.message), translateOutgoing: true,
    translationColor: "#2563eb", fontSize: 13,
  };
  const calls = [];
  const errors = [];
  const intervals = new Map();
  const timeouts = new Map();
  let timerId = 0;
  let observed = false;
  let storageReads = 0;
  let storageWrites = 0;
  let storageListener;
  let storedMuted = [];
  const runtime = {
    id: options.missingRuntime ? undefined : "test-extension",
    lastError: undefined,
    sendMessage: (message, callback) => {
      calls.push(message.type);
      if (options.send) return options.send(message, callback, runtime);
      callback({ ok: true, settings, translations: ["你好"] });
    },
  };
  const storage = {
    local: {
      get: async () => {
        storageReads++;
        if (options.get) return options.get();
        return {};
      },
      set: async (value) => {
        storageWrites++;
        if (options.set) await options.set();
        storedMuted = value.openchatMutedChats;
      },
    },
    onChanged: { addListener: (listener) => {
      if (options.listenerError) throw new Error("Extension context invalidated.");
      storageListener = listener;
    } },
  };
  const context = vm.createContext({
    document, chrome: { runtime, storage },
    window: { location: { reload() {} } },
    Element, HTMLElement: Element, Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      observe() { observed = true; }
      disconnect() { observed = false; }
    },
    getComputedStyle: () => ({ position: "relative" }),
    setInterval: (callback) => { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback, delay) => { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return {
    document, composer, footer, runtime, settings, calls, errors, intervals,
    get observed() { return observed; },
    get storageReads() { return storageReads; },
    get storageWrites() { return storageWrites; },
    get storedMuted() { return storedMuted; },
    get storageListener() { return storageListener; },
    find: (selector) => body.querySelector(selector),
    tick: () => [...intervals.values()].forEach((callback) => callback()),
    runTimeouts: (delay) => {
      [...timeouts.entries()].filter(([, task]) => task.delay === delay).forEach(([id, task]) => {
        timeouts.delete(id);
        task.callback();
      });
    },
    ready: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

function expectStopped(page) {
  assert.equal(page.document.documentElement.dataset.openchatTranslator, "off");
  assert.equal(page.observed, false);
  assert.equal(page.intervals.size, 0);
  assert.equal(page.document.body.querySelectorAll(".wst-reload-notice").length, 1);
  assert.equal(page.find(".wst-compose-action"), null);
  assert.deepEqual(page.errors, []);
}

test("a valid context initializes translation controls", async () => {
  const page = fixture();
  await page.ready();
  assert.equal(page.document.documentElement.dataset.openchatTranslator, "on");
  assert.equal(page.find(".wst-compose-action").textContent, "翻译草稿");
  assert.equal(page.find(".wst-chat-toggle").textContent, "暂停翻译");
  assert.equal(page.observed, true);
  assert.equal(page.intervals.size, 1);
  assert.deepEqual(page.errors, []);
});

test("an already invalid context never calls Chrome messaging or storage", async () => {
  const page = fixture({ missingRuntime: true });
  await page.ready();
  expectStopped(page);
  assert.deepEqual(page.calls, []);
  assert.equal(page.storageReads, 0);
  assert.equal(page.storageListener, undefined);
});

test("synchronous sendMessage invalidation is caught during startup", async () => {
  const page = fixture({ send() { throw new Error("Extension context invalidated."); } });
  await page.ready();
  expectStopped(page);
  assert.equal(page.storageReads, 0);
});

test("asynchronous lastError invalidation is caught", async () => {
  const page = fixture({ send(message, callback, runtime) {
    queueMicrotask(() => {
      runtime.lastError = { message: "Extension context invalidated." };
      callback();
      runtime.lastError = undefined;
    });
  } });
  await page.ready();
  expectStopped(page);
});

test("a rejected sendMessage Promise is caught even when no callback runs", async () => {
  const page = fixture({ send() { return Promise.reject(new Error("Extension context invalidated.")); } });
  await page.ready();
  expectStopped(page);
});

test("invalidation while reading lastError cannot escape its callback", async () => {
  const page = fixture({ send(message, callback, runtime) {
    queueMicrotask(() => {
      Object.defineProperty(runtime, "lastError", { get() { throw new Error("Extension context invalidated."); } });
      callback();
    });
  } });
  await page.ready();
  expectStopped(page);
});

test("a temporary missing receiver does not permanently disable the page", async () => {
  const page = fixture({ send(message, callback, runtime) {
    runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
    callback();
    runtime.lastError = undefined;
  } });
  await page.ready();
  assert.equal(page.document.documentElement.dataset.openchatTranslator, "on");
  assert.ok(page.find(".wst-compose-action"));
  assert.equal(page.find(".wst-reload-notice"), null);
});

test("reload detection stops scanning and makes existing keyboard handlers inert", async () => {
  const page = fixture();
  await page.ready();
  page.runtime.id = undefined;
  page.tick();
  expectStopped(page);
  const before = page.calls.length;
  page.composer.innerText = "test draft";
  page.composer.events.keydown({ key: "Enter", altKey: true, preventDefault() { assert.fail("stale handler must not intercept typing"); } });
  page.tick();
  assert.equal(page.calls.length, before);
});

test("storage invalidation on pause is handled without a success message", async () => {
  const page = fixture({ set() { throw new Error("Extension context invalidated."); } });
  await page.ready();
  await page.find(".wst-chat-toggle").events.click();
  expectStopped(page);
  assert.equal(page.find(".wst-compose-status"), null);
});

test("a rejected storage Promise is caught without an unhandled rejection", async () => {
  const page = fixture({ set() { return Promise.reject(new Error("Extension context invalidated.")); } });
  await page.ready();
  await page.find(".wst-chat-toggle").events.click();
  expectStopped(page);
});

test("a rejected storage read Promise is caught during startup", async () => {
  const page = fixture({
    send(message, callback) {
      callback({ ok: true, settings: { enabled: true, autoTranslate: false, sourceLang: "zh-CN", targetLang: "en" } });
    },
    get() { return Promise.reject(new Error("Extension context invalidated.")); },
  });
  await page.ready();
  expectStopped(page);
});

test("failed persistence leaves pause state unchanged and can be retried", async () => {
  let fails = true;
  const page = fixture({ set() { if (fails) throw new Error("Storage unavailable"); } });
  await page.ready();
  const button = page.find(".wst-chat-toggle");
  await button.events.click();
  assert.equal(button.textContent, "暂停翻译");
  assert.equal(page.find(".wst-compose-status").dataset.error, "true");
  fails = false;
  await button.events.click();
  assert.equal(button.textContent, "恢复翻译");
  assert.equal(page.storedMuted.length, 1);
});

test("a late translation response cannot render after invalidation", async () => {
  let respond;
  const page = fixture({ message: true, send(message, callback) {
    if (message.type === "getSettings") {
      callback({ ok: true, settings: { enabled: true, autoTranslate: true, sourceLang: "zh-CN", targetLang: "en" } });
    } else respond = callback;
  } });
  await page.ready();
  page.runTimeouts(0);
  await page.ready();
  assert.equal(typeof respond, "function");
  page.runtime.id = undefined;
  page.tick();
  respond({ ok: true, translations: ["你好"] });
  await page.ready();
  expectStopped(page);
  assert.equal(page.find(".wst-translation-row"), null);
});

test("invalidation during listener registration is caught", async () => {
  const page = fixture({ listenerError: true });
  await page.ready();
  expectStopped(page);
});
