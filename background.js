const DEFAULT_API_SETTINGS = {
  deepl: { apiKey: "", endpoint: "https://api-free.deepl.com/v2/translate" },
  openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { apiKey: "", model: "claude-3-5-haiku-latest" },
  gemini: { apiKey: "", model: "gemini-2.0-flash" },
  doubao: { apiKey: "", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "" },
  qwen: { apiKey: "", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  relay: { apiKey: "", baseUrl: "", model: "" },
};

const DEFAULTS = {
  enabled: true,
  engine: "google",
  sourceLang: "zh-CN",
  targetLang: "en",
  autoTranslate: true,
  translateOutgoing: true,
  sendAfterTranslate: false,
  showOriginal: true,
  translationColor: "#2563eb",
  fontSize: 13,
  apiSettings: DEFAULT_API_SETTINGS,
};

const CACHE_KEY = "openchatTranslationCache";
const SETTINGS_KEY = "openchatSettings";
const MAX_CACHE = 500;
let cache = null;

function mergeApiSettings(stored = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_API_SETTINGS).map(([provider, defaults]) => [
    provider,
    { ...defaults, ...(stored[provider] || {}) },
  ]));
}

function mergeSettings(stored = {}) {
  return { ...DEFAULTS, ...stored, apiSettings: mergeApiSettings(stored.apiSettings) };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY] || {});
}

async function loadCache() {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(CACHE_KEY);
  cache = new Map(Object.entries(stored[CACHE_KEY] || {}));
  return cache;
}

let saveTimer = null;
function scheduleCacheSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!cache) return;
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
  }, 250);
}

function normalizeLanguage(language) {
  return (language || "auto").toLowerCase().replace("_", "-");
}

function cacheKey(text, source, target, engine, variant = "") {
  return [engine, variant, normalizeLanguage(source), normalizeLanguage(target), text.trim()].join("|");
}

function providerError(provider, message) {
  return new Error(`${provider}: ${message}`);
}

async function fetchText(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const body = await fetchText(url, options, timeoutMs);
  if (body.trimStart().startsWith("<")) throw new Error("provider returned HTML instead of JSON");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("provider returned invalid JSON");
  }
}

function parseGoogleResponse(payload) {
  if (!Array.isArray(payload)) return "";
  return (payload[0] || []).map((part) => part?.[0] || "").join("").trim();
}

async function translateWithGoogle(text, source, target) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: source || "auto",
    tl: target,
    dt: "t",
    q: text,
  });
  const payload = await fetchJson(`https://translate.googleapis.com/translate_a/single?${params}`, {
    headers: { Accept: "application/json,text/plain,*/*" },
  });
  const translated = parseGoogleResponse(payload);
  if (!translated) throw new Error("returned no translated text");
  return translated;
}

async function translateWithMyMemory(text, source, target) {
  const params = new URLSearchParams({
    q: text,
    langpair: `${source || "auto"}|${target}`,
  });
  const payload = await fetchJson(`https://api.mymemory.translated.net/get?${params}`);
  const translated = payload?.responseData?.translatedText?.trim();
  if (!translated) throw new Error(payload?.responseDetails || "returned no translated text");
  return translated;
}

function requireKey(config, provider) {
  if (!config?.apiKey?.trim()) throw providerError(provider, "API key is not configured");
  return config.apiKey.trim();
}

function httpsBaseUrl(value, provider) {
  const base = String(value || "").trim().replace(/\/+$/, "");
  if (!base) throw providerError(provider, "endpoint is not configured");
  let url;
  try { url = new URL(base); } catch { throw providerError(provider, "endpoint is invalid"); }
  if (url.protocol !== "https:") throw providerError(provider, "endpoint must use HTTPS");
  return base;
}

function languageLabel(language) {
  return {
    "zh-cn": "Chinese Simplified",
    zh: "Chinese",
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    ja: "Japanese",
    ko: "Korean",
    ar: "Arabic",
    ru: "Russian",
    id: "Indonesian",
  }[normalizeLanguage(language)] || language || "the target language";
}

function translationPrompt(text, source, target) {
  const sourceText = source && normalizeLanguage(source) !== "auto" ? languageLabel(source) : "the source language";
  return `Translate the following message from ${sourceText} to ${languageLabel(target)}. Return only the translation. Preserve URLs, numbers, product names, emojis, line breaks, and tone.\n\n${text}`;
}

function extractChatCompletion(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("").trim();
  return "";
}

async function translateWithOpenAICompatible(text, source, target, config, provider) {
  const key = requireKey(config, provider);
  const base = httpsBaseUrl(config.baseUrl, provider);
  const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const payload = await fetchJson(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model?.trim(),
      temperature: 0.1,
      messages: [{ role: "user", content: translationPrompt(text, source, target) }],
    }),
  });
  const translated = extractChatCompletion(payload);
  if (!translated) throw providerError(provider, "returned no translated text");
  return translated;
}

async function translateWithAnthropic(text, source, target, config) {
  const key = requireKey(config, "Anthropic");
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model?.trim() || "claude-3-5-haiku-latest",
      max_tokens: 1000,
      messages: [{ role: "user", content: translationPrompt(text, source, target) }],
    }),
  });
  const translated = (payload?.content || []).map((part) => part?.text || "").join("").trim();
  if (!translated) throw providerError("Anthropic", "returned no translated text");
  return translated;
}

async function translateWithGemini(text, source, target, config) {
  const key = requireKey(config, "Gemini");
  const model = config.model?.trim() || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const payload = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: translationPrompt(text, source, target) }] }] }),
  });
  const translated = (payload?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join("").trim();
  if (!translated) throw providerError("Gemini", "returned no translated text");
  return translated;
}

function deeplLanguage(language) {
  const normalized = normalizeLanguage(language);
  return normalized === "zh-cn" || normalized === "zh" ? "ZH" : normalized.split("-")[0].toUpperCase();
}

async function translateWithDeepL(text, source, target, config) {
  const key = requireKey(config, "DeepL");
  const endpoint = httpsBaseUrl(config.endpoint || "https://api-free.deepl.com/v2/translate", "DeepL");
  const params = new URLSearchParams({ text, target_lang: deeplLanguage(target) });
  if (source && normalizeLanguage(source) !== "auto") params.set("source_lang", deeplLanguage(source));
  const payload = await fetchJson(endpoint, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const translated = payload?.translations?.[0]?.text?.trim();
  if (!translated) throw providerError("DeepL", "returned no translated text");
  return translated;
}

const PROVIDERS = {
  google: (text, source, target) => translateWithGoogle(text, source, target),
  mymemory: (text, source, target) => translateWithMyMemory(text, source, target),
  deepl: (text, source, target, config) => translateWithDeepL(text, source, target, config),
  openai: (text, source, target, config) => translateWithOpenAICompatible(text, source, target, config, "OpenAI"),
  anthropic: (text, source, target, config) => translateWithAnthropic(text, source, target, config),
  gemini: (text, source, target, config) => translateWithGemini(text, source, target, config),
  doubao: (text, source, target, config) => translateWithOpenAICompatible(text, source, target, config, "Doubao"),
  qwen: (text, source, target, config) => translateWithOpenAICompatible(text, source, target, config, "Qwen"),
  relay: (text, source, target, config) => translateWithOpenAICompatible(text, source, target, config, "Relay"),
};

async function translateOne({ text, source, target, engine, apiSettings }) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (normalizeLanguage(source) === normalizeLanguage(target)) return clean;
  const order = [...new Set([engine, "google", "mymemory"].filter(Boolean))];
  const errors = [];
  for (const provider of order) {
    const translate = PROVIDERS[provider];
    if (!translate) continue;
    try {
      return await translate(clean, source, target, apiSettings?.[provider] || {});
    } catch (error) {
      errors.push(error?.message || `${provider} failed`);
    }
  }
  throw new Error(errors.join("; ") || "No translation provider is configured");
}

async function translateMany(items) {
  const settings = await getSettings();
  const currentCache = await loadCache();
  const result = [];
  for (const item of items) {
    const text = String(item?.text || "").trim();
    if (!text) {
      result.push("");
      continue;
    }
    const source = item.source || settings.sourceLang;
    const target = item.target || settings.targetLang;
    const engine = item.engine || settings.engine;
    const providerConfig = settings.apiSettings?.[engine] || {};
    const variant = [providerConfig.baseUrl, providerConfig.endpoint, providerConfig.model].filter(Boolean).join("|");
    const key = cacheKey(text, source, target, engine, variant);
    if (currentCache.has(key)) {
      result.push(currentCache.get(key));
      continue;
    }
    const translated = await translateOne({ text, source, target, engine, apiSettings: settings.apiSettings });
    currentCache.set(key, translated);
    result.push(translated);
    scheduleCacheSave();
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate") {
    translateMany(Array.isArray(message.items) ? message.items : [message])
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "getSettings") {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  if (message?.type === "clearCache") {
    cache = new Map();
    chrome.storage.local.remove(CACHE_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "cacheStats") {
    loadCache().then((currentCache) => sendResponse({ ok: true, size: currentCache.size }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(SETTINGS_KEY);
  if (!current[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULTS });
});
