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
  ["zh-CN", "中文"], ["en", "English"], ["es", "Español"], ["fr", "Français"],
  ["de", "Deutsch"], ["it", "Italiano"], ["pt", "Português"], ["ja", "日本語"],
  ["ko", "한국어"], ["ar", "العربية"], ["ru", "Русский"], ["id", "Bahasa Indonesia"],
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
  showStatus("Settings saved");
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
  $("cacheStats").textContent = `Cache ${stats?.size || 0}`;
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
  $("cacheStats").textContent = "Cache 0";
  showStatus("Translation cache cleared");
});

init();
