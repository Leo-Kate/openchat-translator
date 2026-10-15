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
};

const CACHE_KEY = "openchatTranslationCache";
const SETTINGS_KEY = "openchatSettings";
const MAX_CACHE = 500;
let cache = null;

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
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

function cacheKey(text, source, target, engine) {
  return [engine, normalizeLanguage(source), normalizeLanguage(target), text.trim()].join("|");
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
      headers: { Accept: "application/json,text/plain,*/*" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Google Translate HTTP ${response.status}`);
  const body = await response.text();
  if (body.trimStart().startsWith("<")) throw new Error("Google Translate returned a blocked HTML response");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Google Translate returned invalid JSON");
  }
  const translated = parseGoogleResponse(payload);
  if (!translated) throw new Error("Google Translate returned no text");
  return translated;
}

async function translateWithMyMemory(text, source, target) {
  const params = new URLSearchParams({
    q: text,
    langpair: `${source || "auto"}|${target}`,
  });
  const response = await fetch(`https://api.mymemory.translated.net/get?${params}`);
  if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);
  const payload = await response.json();
  const translated = payload?.responseData?.translatedText?.trim();
  if (!translated) throw new Error(payload?.responseDetails || "MyMemory returned no text");
  return translated;
}

async function translateOne({ text, source, target, engine }) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (normalizeLanguage(source) === normalizeLanguage(target)) return clean;
  const translations = engine === "google"
    ? [translateWithGoogle, translateWithMyMemory]
    : [translateWithMyMemory, translateWithGoogle];
  let lastError;
  for (const provider of translations) {
    try {
      return await provider(clean, source, target);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Translation failed");
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
    const key = cacheKey(text, source, target, engine);
    if (currentCache.has(key)) {
      result.push(currentCache.get(key));
      continue;
    }
    const translated = await translateOne({ text, source, target, engine });
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
