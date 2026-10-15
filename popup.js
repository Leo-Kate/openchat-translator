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

const LANGUAGES = [
  ["auto", "自动检测"],
  ["zh-CN", "中文"], ["en", "英语"], ["es", "西班牙语"], ["fr", "法语"],
  ["de", "德语"], ["it", "意大利语"], ["pt", "葡萄牙语"], ["ja", "日语"],
  ["ko", "韩语"], ["ar", "阿拉伯语"], ["ru", "俄语"], ["id", "印度尼西亚语"],
];

const PROVIDER_META = {
  google: { help: "无需 Key。Google 公开接口可能受到网络或频率限制。" },
  mymemory: { help: "无需 Key。适合个人测试，有免费额度和频率限制。" },
  deepl: { fields: [["API Key", "apiKey", "password"], ["API 地址", "endpoint", "text"]], help: "支持 api-free.deepl.com 和 api.deepl.com。" },
  openai: { fields: [["API Key", "apiKey", "password"], ["API 地址", "baseUrl", "text"], ["模型", "model", "text"]], help: "使用 OpenAI Chat Completions 接口。" },
  anthropic: { fields: [["API Key", "apiKey", "password"], ["模型", "model", "text"]], help: "这里使用 Anthropic Messages API；Claude Code 本身不是独立翻译接口。" },
  gemini: { fields: [["API Key", "apiKey", "password"], ["模型", "model", "text"]], help: "使用 Google Gemini generateContent 接口。" },
  doubao: { fields: [["API Key", "apiKey", "password"], ["API 地址", "baseUrl", "text"], ["模型或 Endpoint ID", "model", "text"]], help: "豆包使用火山方舟的 OpenAI 兼容接口。" },
  qwen: { fields: [["API Key", "apiKey", "password"], ["API 地址", "baseUrl", "text"], ["模型", "model", "text"]], help: "通义千问使用 DashScope OpenAI 兼容接口。" },
  relay: { fields: [["API Key", "apiKey", "password"], ["中转站 API 地址", "baseUrl", "text"], ["模型", "model", "text"]], help: "支持返回 OpenAI Chat Completions 格式的 HTTPS 中转站。" },
};

const KNOWN_ORIGINS = new Set([
  "https://api-free.deepl.com",
  "https://api.deepl.com",
  "https://api.openai.com",
  "https://api.anthropic.com",
  "https://generativelanguage.googleapis.com",
  "https://ark.cn-beijing.volces.com",
  "https://dashscope.aliyuncs.com",
]);

const $ = (id) => document.getElementById(id);
const fields = ["enabled", "engine", "sourceLang", "targetLang", "autoTranslate", "translateOutgoing", "sendAfterTranslate", "showOriginal", "translationColor", "fontSize"];
let currentSettings = { ...DEFAULTS, apiSettings: DEFAULT_API_SETTINGS };

function mergeApiSettings(stored = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_API_SETTINGS).map(([provider, defaults]) => [
    provider,
    { ...defaults, ...(stored[provider] || {}) },
  ]));
}

function mergeSettings(stored = {}) {
  return { ...DEFAULTS, ...stored, apiSettings: mergeApiSettings(stored.apiSettings) };
}

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
    else resolve(response || { ok: false, error: "没有收到后台响应" });
  }));
}

function showStatus(message, error = false) {
  const element = $("status");
  element.textContent = message;
  element.className = `status show${error ? " error" : ""}`;
  setTimeout(() => element.classList.remove("show"), 3200);
}

function addConfigField(container, labelText, key, type, value) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.value = value || "";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.configField = key;
  label.appendChild(input);
  container.appendChild(label);
}

function renderProviderConfig(apiSettings) {
  const provider = $("engine").value;
  const container = $("providerConfig");
  container.replaceChildren();
  const meta = PROVIDER_META[provider] || PROVIDER_META.google;
  const config = apiSettings[provider] || {};
  for (const [label, key, type] of meta.fields || []) addConfigField(container, label, key, type, config[key]);
  const help = document.createElement("p");
  help.className = "provider-help";
  help.textContent = meta.help;
  container.appendChild(help);
}

function collectApiSettings() {
  const apiSettings = mergeApiSettings(currentSettings.apiSettings);
  const provider = $("engine").value;
  const config = { ...(apiSettings[provider] || {}) };
  $("providerConfig").querySelectorAll("[data-config-field]").forEach((input) => {
    config[input.dataset.configField] = input.value.trim();
  });
  apiSettings[provider] = config;
  return apiSettings;
}

async function ensureEndpointPermission(provider, apiSettings) {
  if (!["relay", "openai", "doubao", "qwen", "deepl"].includes(provider)) return;
  const config = apiSettings[provider] || {};
  const endpoint = config.baseUrl || config.endpoint;
  if (!endpoint) {
    if (provider === "relay" || provider === "doubao") throw new Error("请先填写 API 地址");
    return;
  }
  let url;
  try { url = new URL(endpoint); } catch { throw new Error("API 地址格式不正确"); }
  if (url.protocol !== "https:") throw new Error("API 地址必须使用 HTTPS");
  const origin = url.origin;
  if (KNOWN_ORIGINS.has(origin) || !chrome.permissions?.request) return;
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new Error("没有获得中转站域名权限，设置未保存");
}

function readForm() {
  const form = {};
  for (const id of fields) form[id] = $(id).type === "checkbox" ? $(id).checked : $(id).value;
  form.fontSize = Number(form.fontSize);
  form.apiSettings = collectApiSettings();
  return form;
}

async function sendSettingsToTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "settingsChanged" }, () => void chrome.runtime.lastError);
}

async function save() {
  try {
    const settings = readForm();
    await ensureEndpointPermission(settings.engine, settings.apiSettings);
    await chrome.storage.local.set({ openchatSettings: settings });
    currentSettings = mergeSettings(settings);
    await sendSettingsToTab();
    showStatus("设置已保存");
  } catch (error) {
    showStatus(error.message || "设置保存失败", true);
  }
}

async function testProvider() {
  const button = $("testProvider");
  button.disabled = true;
  showStatus("正在测试当前翻译引擎");
  try {
    const draft = readForm();
    await ensureEndpointPermission(draft.engine, draft.apiSettings);
    const result = await send({
      type: "testProvider",
      provider: draft.engine,
      apiSettings: draft.apiSettings,
    });
    if (!result.ok) throw new Error(result.error || "引擎测试失败");
    showStatus(`测试成功：${result.translated}`);
  } catch (error) {
    showStatus(error.message || "引擎测试失败", true);
  } finally {
    button.disabled = false;
  }
}

function populateLanguages() {
  $("sourceLang").replaceChildren(...LANGUAGES.map(([value, label]) => new Option(label, value)));
  $("targetLang").replaceChildren(...LANGUAGES.filter(([value]) => value !== "auto").map(([value, label]) => new Option(label, value)));
}

function render(settings) {
  currentSettings = mergeSettings(settings);
  for (const id of fields) {
    const element = $(id);
    if (element.type === "checkbox") element.checked = Boolean(currentSettings[id]);
    else element.value = currentSettings[id];
  }
  $("fontSizeValue").value = `${currentSettings.fontSize}px`;
  $("liveDot").style.background = currentSettings.enabled ? "#22c55e" : "#94a3b8";
  renderProviderConfig(currentSettings.apiSettings);
}

async function init() {
  populateLanguages();
  const stored = await chrome.storage.local.get("openchatSettings");
  render(stored.openchatSettings || {});
  const stats = await send({ type: "cacheStats" });
  $("cacheStats").textContent = `缓存 ${stats?.size || 0}`;
}

$("save").addEventListener("click", save);
$("testProvider").addEventListener("click", testProvider);
$("engine").addEventListener("change", () => renderProviderConfig(currentSettings.apiSettings));
$("fontSize").addEventListener("input", (event) => { $("fontSizeValue").value = `${event.target.value}px`; });
$("swapLang").addEventListener("click", () => {
  const source = $("sourceLang").value;
  const target = $("targetLang").value;
  if (source === "auto") return showStatus("自动检测语言不能交换", true);
  $("sourceLang").value = target;
  $("targetLang").value = source;
});
$("clearCache").addEventListener("click", async () => {
  await send({ type: "clearCache" });
  $("cacheStats").textContent = "缓存 0";
  showStatus("翻译缓存已清空");
});

init();
