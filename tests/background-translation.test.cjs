const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const google = (text) => [[[text, "source"]], null, "auto"];

function fixture(options = {}) {
  let listener;
  const requests = [];
  const stored = { openchatSettings: options.settings || {}, ...options.stored };
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    chrome: {
      runtime: {
        onMessage: { addListener(value) { listener = value; } },
        onInstalled: { addListener() {} },
      },
      storage: { local: {
        async get(key) { return { [key]: stored[key] }; },
        async set(values) { Object.assign(stored, values); },
        async remove(key) { delete stored[key]; },
      } },
      i18n: options.detect ? { detectLanguage: options.detect } : {},
    },
    async fetch(url, init = {}) {
      const request = { url: new URL(url), init };
      requests.push(request);
      const payload = await (options.respond || (() => google("测试译文")))(request);
      if (payload.httpStatus) return { ok: false, status: payload.httpStatus, headers: { get() { return "30"; } }, async text() { return ""; } };
      return { ok: true, async text() { return JSON.stringify(payload); } };
    },
  });
  vm.runInContext(source, context, { filename: "background.js" });
  const send = (message) => new Promise((resolve) => listener(message, {}, resolve));
  return { requests, stored, context, send, translate: (items) => send({ type: "translate", items }) };
}

test("every incoming language can use automatic detection with a Chinese target", async () => {
  const page = fixture();
  for (const text of ["Сколько стоит доставка?", "¿Está disponible?", "Can you send photos?"]) {
    assert.equal((await page.translate([{ text, source: "auto", target: "zh-CN" }])).ok, true);
  }
  assert.equal(page.requests.length, 3);
  assert.ok(page.requests.every(({ url }) => url.searchParams.get("sl") === "auto" && url.searchParams.get("tl") === "zh-CN"));
  const settings = await page.send({ type: "getSettings" });
  assert.equal(settings.settings.autoDetectIncoming, true);
});

test("DeepL auto detection omits source_lang instead of sending AUTO", async () => {
  const page = fixture({
    settings: { engine: "deepl", apiSettings: { deepl: { apiKey: "test-only-key" } } },
    respond: () => ({ translations: [{ text: "配送需要多久？" }] }),
  });
  assert.equal((await page.translate([{ text: "Сколько времени?", source: "auto", target: "zh-CN" }])).translations[0], "配送需要多久？");
  const body = new URLSearchParams(page.requests[0].init.body);
  assert.equal(body.has("source_lang"), false);
  assert.equal(body.get("target_lang"), "ZH");
});

test("ordinary prose is translated while URLs and wallet identifiers remain exact", async () => {
  const url = "https://example.com/model-126600?ref=Leo&value=100";
  const address = "0x" + "a".repeat(40);
  const page = fixture({ respond: ({ url }) => {
    const text = url.searchParams.get("q");
    assert.ok(!text.includes("https://example.com"));
    assert.ok(!text.includes(address));
    return google("请查看 ZXQREF0QXZ，地址是 ZXQREF1QXZ");
  } });
  const result = await page.translate([{ text: `Please see ${url}, address ${address}`, source: "auto", target: "zh-CN" }]);
  assert.equal(result.translations[0], `请查看 ${url}，地址是 ${address}`);
});

test("a provider that corrupts a reference falls back without displaying a damaged URL", async () => {
  const page = fixture({
    settings: { engine: "relay", apiSettings: { relay: { apiKey: "test-key", baseUrl: "https://relay.example/v1", model: "test" } } },
    respond: ({ url, init }) => {
      if (url.host === "relay.example") {
        const prompt = JSON.parse(init.body).messages[0].content;
        assert.ok(prompt.includes("Never add facts, promises or explanations"));
        return { choices: [{ message: { content: "请查看被损坏的标记" } }] };
      }
      return google("请查看 ZXQREF0QXZ");
    },
  });
  const result = await page.translate([{ text: "Please see https://example.com/123", source: "auto", target: "zh-CN" }]);
  assert.equal(result.translations[0], "请查看 https://example.com/123");
  assert.equal(page.requests.length, 2);
});

test("MyMemory resolves a concrete source with the built-in detector", async () => {
  const page = fixture({
    settings: { engine: "mymemory" },
    detect: async () => ({ languages: [{ language: "ru", percentage: 99 }] }),
    respond: ({ url }) => {
      assert.equal(url.searchParams.get("langpair"), "ru|zh-CN");
      return { responseStatus: 200, responseData: { translatedText: "请告诉我价格" } };
    },
  });
  assert.equal((await page.translate([{ text: "Скажите цену", source: "auto", target: "zh-CN" }])).translations[0], "请告诉我价格");
});

test("a MyMemory service error is never returned as a successful translation", async () => {
  const page = fixture({ settings: { engine: "mymemory" }, respond: ({ url }) => url.host.includes("mymemory")
    ? { responseStatus: 403, responseData: { translatedText: "INVALID LANGUAGE PAIR" } }
    : google("你好") });
  const result = await page.translate([{ text: "Hello", source: "en", target: "zh-CN" }]);
  assert.equal(result.translations[0], "你好");
  assert.equal(page.requests.length, 2);
});

test("matching requests share one network call and use the local cache", async () => {
  let reply;
  const page = fixture({ respond: () => new Promise((resolve) => { reply = resolve; }) });
  const item = { text: "Hello", source: "auto", target: "zh-CN" };
  const first = page.translate([item]);
  const second = page.translate([item]);
  await new Promise(setImmediate);
  assert.equal(page.requests.length, 1);
  reply(google("你好"));
  assert.equal((await first).translations[0], "你好");
  assert.equal((await second).translations[0], "你好");
  assert.equal((await page.translate([item])).translations[0], "你好");
  assert.equal(page.requests.length, 1);
});

test("loaded and newly written cache stay within entry and character budgets", async () => {
  const entries = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`old${i}`, "x".repeat(3000)]));
  const page = fixture({ stored: { openchatTranslationCache: entries } });
  assert.ok((await page.send({ type: "cacheStats" })).size <= 500);
  assert.ok(vm.runInContext("cacheChars", page.context) <= 500000);
  await page.translate([{ text: "New incoming message", source: "auto", target: "zh-CN" }]);
  assert.ok(vm.runInContext("cacheChars", page.context) <= 500000);
  assert.ok((await page.send({ type: "cacheStats" })).size <= 500);
});

test("oversized batches and messages are rejected before network work", async () => {
  const page = fixture();
  const item = { text: "Hello", source: "auto", target: "zh-CN" };
  assert.equal((await page.translate(Array(33).fill(item))).ok, false);
  assert.equal((await page.translate([{ ...item, text: "a".repeat(5001) }])).ok, false);
  assert.equal(page.requests.length, 0);
});

test("a rate-limited provider cools down instead of receiving repeated requests", async () => {
  const page = fixture({ respond: () => ({ httpStatus: 429 }) });
  const item = { text: "First message", source: "auto", target: "zh-CN" };
  assert.equal((await page.translate([item])).ok, false);
  assert.equal((await page.translate([{ ...item, text: "Different message" }])).ok, false);
  assert.equal(page.requests.length, 1);
});
