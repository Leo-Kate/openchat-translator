const DEFAULTS = {
  enabled: true,
  engine: "mymemory",
  sourceLang: "zh-CN",
  targetLang: "en",
  autoTranslate: true,
  translateOutgoing: true,
  sendAfterTranslate: false,
  showOriginal: true,
  translationColor: "#2563eb",
  fontSize: 13,
};

const LANGUAGES = [
  ["zh-CN", "中文"], ["en", "英语"], ["es", "西班牙语"], ["fr", "法语"],
  ["de", "德语"], ["it", "意大利语"], ["pt", "葡萄牙语"], ["ja", "日语"],
  ["ko", "韩语"], ["ar", "阿拉伯语"], ["ru", "俄语"], ["id", "印度尼西亚语"],
];

const $ = (id) => document.getElementById(id);
const fields = ["enabled", "engine", "sourceLang", "targetLang", "autoTranslate", "translateOutgoing", "sendAfterTranslate", "showOriginal", "translationColor", "fontSize"];

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || { ok: false, error: "No response" })));
}

function readForm() {
  const form = {};
  for (const id of fields) form[id] = $(id).type === "checkbox" ? $(id).checked : $(id).value;
  form.fontSize = Number(form.fontSize);
  return form;
}

function showStatus(message, error = false) {
  const element = $("status");
  element.textContent = message;
  element.className = `status show${error ? " error" : ""}`;
  setTimeout(() => element.classList.remove("show"), 2800);
}

async function sendSettingsToTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "settingsChanged" }, () => void chrome.runtime.lastError);
}

async function save() {
  const settings = readForm();
  await chrome.storage.local.set({ openchatSettings: settings });
  await sendSettingsToTab();
  showStatus("设置已保存");
}

function populateLanguages() {
  for (const id of ["sourceLang", "targetLang"]) {
    $(id).replaceChildren(...LANGUAGES.map(([value, label]) => new Option(label, value)));
  }
}

function render(settings) {
  for (const id of fields) {
    const element = $(id);
    if (element.type === "checkbox") element.checked = Boolean(settings[id]);
    else element.value = settings[id];
  }
  $("fontSizeValue").value = `${settings.fontSize}px`;
  $("liveDot").style.background = settings.enabled ? "#22c55e" : "#94a3b8";
}

async function init() {
  populateLanguages();
  const stored = await chrome.storage.local.get("openchatSettings");
  const settings = { ...DEFAULTS, ...(stored.openchatSettings || {}) };
  render(settings);
  const stats = await send({ type: "cacheStats" });
  $("cacheStats").textContent = `缓存 ${stats?.size || 0}`;
}

$("save").addEventListener("click", save);
$("fontSize").addEventListener("input", (event) => { $("fontSizeValue").value = `${event.target.value}px`; });
$("swapLang").addEventListener("click", () => {
  const source = $("sourceLang").value;
  $("sourceLang").value = $("targetLang").value;
  $("targetLang").value = source;
});
$("clearCache").addEventListener("click", async () => {
  await send({ type: "clearCache" });
  $("cacheStats").textContent = "缓存 0";
  showStatus("翻译缓存已清空");
});

init();
