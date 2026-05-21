const DEFAULT_SETTINGS = {
  enabled: true,
  pausedUntil: 0,
  detailedMode: false,
  showStatusWidget: true,
  materialMode: false,
  materialContext: "",
  materialSources: [],
  materialRevision: 0,
  apiProviders: ["openrouter", "gemini"],
  openaiApiKey: "",
  openrouterApiKey: "",
  geminiApiKey: "",
  apiKey: "",
};

const PROVIDER_OPENAI = "openai";
const PROVIDER_OPENROUTER = "openrouter";
const PROVIDER_GEMINI = "gemini";
const PROVIDER_CAPI = "capi";
const DEFAULT_PROVIDER_ORDER = [PROVIDER_OPENROUTER, PROVIDER_GEMINI];
const PROVIDER_DISPLAY_NAMES = {
  [PROVIDER_OPENAI]: "OpenAI",
  [PROVIDER_OPENROUTER]: "OpenRouter",
  [PROVIDER_GEMINI]: "Gemini",
  [PROVIDER_CAPI]: "CAPI",
};
const ALL_PROVIDERS = [
  PROVIDER_OPENAI,
  PROVIDER_GEMINI,
  PROVIDER_OPENROUTER,
  PROVIDER_CAPI,
];

const MATERIAL_CONTEXT_LIMIT = 120000;
const MATERIAL_PER_SOURCE_LIMIT = 35000;
const MATERIAL_SOURCE_LIMIT = 12;
const SUPPORTED_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".html",
  ".htm",
  ".log",
  ".rtf",
]);

const statusText = document.getElementById("statusText");
const statusNote = document.getElementById("statusNote");
const enabledToggle = document.getElementById("enabledToggle");
const detailedToggle = document.getElementById("detailedToggle");
const statusWidgetToggle = document.getElementById("statusWidgetToggle");
const materialModeToggle = document.getElementById("materialModeToggle");
const materialsInput = document.getElementById("materialsInput");
const materialsText = document.getElementById("materialsText");
const importMaterialsButton = document.getElementById("importMaterialsButton");
const clearMaterialsButton = document.getElementById("clearMaterialsButton");
const materialsNote = document.getElementById("materialsNote");
const providerListContainer = document.getElementById("providerList");
const providerOpenAICheckbox = document.getElementById("providerOpenAI");
const providerOpenRouterCheckbox = document.getElementById("providerOpenRouter");
const providerGeminiCheckbox = document.getElementById("providerGemini");
const providerCapiCheckbox = document.getElementById("providerCapi");
const providerRows = Array.from(document.querySelectorAll("[data-provider-row]"));
const providerMoveButtons = Array.from(
  document.querySelectorAll("[data-provider-move]")
);
const openaiApiKeyInput = document.getElementById("openaiApiKeyInput");
const openrouterApiKeyInput = document.getElementById("openrouterApiKeyInput");
const geminiApiKeyInput = document.getElementById("geminiApiKeyInput");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
const clearApiKeyButton = document.getElementById("clearApiKeyButton");
const apiKeyNote = document.getElementById("apiKeyNote");
const pauseNote = document.getElementById("pauseNote");
const resumeButton = document.getElementById("resumeButton");
const pauseButtons = Array.from(document.querySelectorAll("[data-pause-minutes]"));

let providerOrderDraft = [...DEFAULT_PROVIDER_ORDER];

function normalizeProviderOrder(value, options = {}) {
  const fallbackToDefault = options.fallbackToDefault !== false;
  const candidates = Array.isArray(value) ? value : [];
  const allowed = new Set([
    PROVIDER_OPENAI,
    PROVIDER_OPENROUTER,
    PROVIDER_GEMINI,
    PROVIDER_CAPI,
  ]);
  const seen = new Set();
  const normalized = [];

  for (const item of candidates) {
    const provider = String(item || "").trim().toLowerCase();
    if (!allowed.has(provider) || seen.has(provider)) {
      continue;
    }
    seen.add(provider);
    normalized.push(provider);
  }

  if (!normalized.length && fallbackToDefault) {
    return [...DEFAULT_PROVIDER_ORDER];
  }

  return normalized;
}

function normalizeSettings(raw = {}) {
  const pausedUntil = Number(raw.pausedUntil) || 0;
  const legacyApiKey = String(raw.apiKey || "").trim();
  const apiProviders = normalizeProviderOrder(raw.apiProviders);
  const materialSources = Array.isArray(raw.materialSources)
    ? raw.materialSources
        .map((source) => ({
          name: String(source?.name || "").trim().slice(0, 120),
          chars: Number(source?.chars) || 0,
          kind: String(source?.kind || "").trim().slice(0, 40),
        }))
        .filter((source) => source.name && source.chars > 0)
    : [];

  return {
    enabled: raw.enabled !== false,
    pausedUntil,
    detailedMode: Boolean(raw.detailedMode),
    showStatusWidget: raw.showStatusWidget !== false,
    materialMode: Boolean(raw.materialMode),
    materialContext: typeof raw.materialContext === "string" ? raw.materialContext : "",
    materialSources,
    materialRevision: Number(raw.materialRevision) || 0,
    apiProviders,
    openaiApiKey: String(raw.openaiApiKey || legacyApiKey).trim(),
    openrouterApiKey: String(raw.openrouterApiKey || "").trim(),
    geminiApiKey: String(raw.geminiApiKey || "").trim(),
  };
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      resolve(normalizeSettings(items));
    });
  });
}

function saveSettings(partialSettings) {
  return new Promise((resolve) => {
    chrome.storage.local.set(partialSettings, () => resolve());
  });
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function cleanMaterialText(value) {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getFileExtension(filename) {
  const name = String(filename || "").toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex) : "";
}

function looksBinaryText(text) {
  const value = String(text || "");
  if (!value) {
    return false;
  }

  const sample = value.slice(0, 10000);
  let suspiciousCount = 0;

  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    if ((code >= 0 && code < 32 && !isAllowedControl) || code === 65533) {
      suspiciousCount += 1;
    }
  }

  return suspiciousCount / sample.length > 0.03;
}

function decodePdfEscapes(input) {
  return input
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([0-7]{1,3})/g, (_, octal) =>
      String.fromCharCode(parseInt(octal, 8))
    );
}

function extractPdfTextLite(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const raw = new TextDecoder("latin1").decode(bytes);
  const chunks = [];

  const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  let match = tjRegex.exec(raw);
  while (match) {
    const decoded = decodePdfEscapes(match[1]);
    if (decoded.trim()) {
      chunks.push(decoded);
    }
    match = tjRegex.exec(raw);
  }

  const tjArrayRegex = /\[(.*?)\]\s*TJ/gs;
  let arrayMatch = tjArrayRegex.exec(raw);
  while (arrayMatch) {
    const inner = arrayMatch[1];
    const innerRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let part = innerRegex.exec(inner);
    while (part) {
      const decoded = decodePdfEscapes(part[1]);
      if (decoded.trim()) {
        chunks.push(decoded);
      }
      part = innerRegex.exec(inner);
    }
    arrayMatch = tjArrayRegex.exec(raw);
  }

  if (!chunks.length) {
    const fallbackUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return fallbackUtf8
      .replace(/[^ \n\r\t\u3000-\u30ff\u3400-\u9fffA-Za-z0-9.,:;!?%()\-_/]/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n");
  }

  return chunks.join("\n");
}

async function extractMaterialFromFile(file) {
  const filename = String(file?.name || "untitled");
  const extension = getFileExtension(filename);
  const isPdf = extension === ".pdf" || file.type === "application/pdf";
  const isTextFile = SUPPORTED_TEXT_EXTENSIONS.has(extension);
  let text = "";

  if (!isPdf && !isTextFile) {
    throw new Error(
      `Unsupported file type for ${filename}. Use PDF or text files (.txt/.md/.csv/.json/.tsv/.html/.log/.rtf).`
    );
  }

  try {
    if (isPdf) {
      const buffer = await file.arrayBuffer();
      text = extractPdfTextLite(buffer);
    } else {
      text = await file.text();
    }
  } catch (error) {
    throw new Error(`Failed to read ${filename}: ${error?.message || error}`);
  }

  if (looksBinaryText(text)) {
    throw new Error(`Skipped ${filename} because extracted text looks binary/garbled.`);
  }

  const cleaned = cleanMaterialText(text);
  if (!cleaned) {
    throw new Error(`No readable text found in ${filename}.`);
  }

  return {
    name: filename,
    kind: isPdf ? "pdf" : "text",
    text: truncateText(cleaned, MATERIAL_PER_SOURCE_LIMIT),
  };
}

function renderMaterialsSummary(settings) {
  const sources = settings.materialSources || [];
  const totalChars = Number(settings.materialContext?.length || 0);

  if (!sources.length) {
    materialsNote.textContent = settings.materialMode
      ? "Material mode is ON, but no source is registered."
      : "No reference material registered yet.";
    return;
  }

  const lines = [
    `Registered: ${sources.length} sources / ${totalChars.toLocaleString()} chars`,
    sources.map((source) => `${source.name} (${source.chars.toLocaleString()} chars)`).join("\n"),
  ];
  materialsNote.textContent = lines.join("\n");
}

function setProviderEnabled(providerId, enabled) {
  const normalized = normalizeProviderOrder(providerOrderDraft, {
    fallbackToDefault: false,
  });
  const currentIndex = normalized.indexOf(providerId);
  if (enabled) {
    if (currentIndex >= 0) {
      providerOrderDraft = normalized;
      return;
    }
    providerOrderDraft = [...normalized, providerId];
    return;
  }

  if (currentIndex < 0) {
    providerOrderDraft = normalized;
    return;
  }

  providerOrderDraft = normalized.filter((provider) => provider !== providerId);
}

function moveProvider(providerId, direction) {
  const normalized = normalizeProviderOrder(providerOrderDraft, {
    fallbackToDefault: false,
  });
  const currentIndex = normalized.indexOf(providerId);
  if (currentIndex < 0) {
    providerOrderDraft = normalized;
    return;
  }

  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= normalized.length) {
    providerOrderDraft = normalized;
    return;
  }

  const next = [...normalized];
  [next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
  providerOrderDraft = next;
}

function renderProviderPriority() {
  const selectedProviders = normalizeProviderOrder(providerOrderDraft, {
    fallbackToDefault: false,
  });
  const selectedSet = new Set(selectedProviders);
  const orderedDisplayProviders = [
    ...selectedProviders,
    ...ALL_PROVIDERS.filter((provider) => !selectedSet.has(provider)),
  ];
  const rowByProvider = new Map(
    providerRows.map((row) => [String(row.dataset.provider || ""), row])
  );

  if (providerOpenAICheckbox) {
    providerOpenAICheckbox.checked = selectedSet.has(PROVIDER_OPENAI);
  }
  if (providerOpenRouterCheckbox) {
    providerOpenRouterCheckbox.checked = selectedSet.has(PROVIDER_OPENROUTER);
  }
  if (providerGeminiCheckbox) {
    providerGeminiCheckbox.checked = selectedSet.has(PROVIDER_GEMINI);
  }
  if (providerCapiCheckbox) {
    providerCapiCheckbox.checked = selectedSet.has(PROVIDER_CAPI);
  }

  for (const providerId of orderedDisplayProviders) {
    const row = rowByProvider.get(providerId);
    if (!row) {
      continue;
    }

    const rankElement = row.querySelector("[data-provider-rank]");
    const rankIndex = selectedProviders.indexOf(providerId);
    const enabled = rankIndex >= 0;
    row.dataset.enabled = enabled ? "true" : "false";

    if (rankElement) {
      rankElement.textContent = enabled ? `#${rankIndex + 1}` : "OFF";
    }

    const upButton = row.querySelector('[data-provider-move="up"]');
    const downButton = row.querySelector('[data-provider-move="down"]');
    if (upButton) {
      upButton.disabled = !enabled || rankIndex <= 0;
    }
    if (downButton) {
      downButton.disabled = !enabled || rankIndex >= selectedProviders.length - 1;
    }

    if (providerListContainer) {
      providerListContainer.appendChild(row);
    }
  }
}

function renderApiKeySummary(settings) {
  const providerOrder = normalizeProviderOrder(settings.apiProviders);
  const openaiKey = String(settings.openaiApiKey || "").trim();
  const openrouterKey = String(settings.openrouterApiKey || "").trim();
  const geminiKey = String(settings.geminiApiKey || "").trim();

  const lines = [
    `Order: ${
      providerOrder.length
        ? providerOrder
            .map((providerId) => PROVIDER_DISPLAY_NAMES[providerId] || providerId)
            .join(" -> ")
        : "none"
    }`,
  ];
  lines.push(
    openaiKey
      ? `OpenAI key: set (****${openaiKey.slice(-4)})`
      : "OpenAI key: not set"
  );
  lines.push(
    openrouterKey
      ? `OpenRouter key: set (****${openrouterKey.slice(-4)})`
      : "OpenRouter key: not set"
  );
  lines.push(
    geminiKey
      ? `Gemini key: set (****${geminiKey.slice(-4)})`
      : "Gemini key: not set"
  );
  lines.push("CAPI key: not required");
  apiKeyNote.textContent = lines.join("\n");
}

function render(settings) {
  enabledToggle.checked = settings.enabled;
  detailedToggle.checked = settings.detailedMode;
  statusWidgetToggle.checked = settings.showStatusWidget;
  materialModeToggle.checked = settings.materialMode;
  providerOrderDraft = normalizeProviderOrder(settings.apiProviders);
  renderProviderPriority();
  openaiApiKeyInput.value = settings.openaiApiKey || "";
  openrouterApiKeyInput.value = settings.openrouterApiKey || "";
  geminiApiKeyInput.value = settings.geminiApiKey || "";
  renderApiKeySummary(settings);

  const now = Date.now();
  const paused = settings.enabled && settings.pausedUntil > now;

  if (!settings.enabled) {
    statusText.textContent = "Disabled";
    statusNote.textContent = "Hint generation is disabled from popup.";
    pauseNote.textContent = "";
    renderMaterialsSummary(settings);
    return;
  }

  if (paused) {
    statusText.textContent = "Paused";
    statusNote.textContent = `Paused until ${formatDateTime(settings.pausedUntil)}.`;
    pauseNote.textContent = `Resume at ${formatDateTime(settings.pausedUntil)}`;
    renderMaterialsSummary(settings);
    return;
  }

  statusText.textContent = "Active";
  statusNote.textContent = settings.detailedMode
    ? "Detailed mode is enabled."
    : "Standard mode is enabled.";
  pauseNote.textContent = "";
  renderMaterialsSummary(settings);
}

async function refresh() {
  const settings = await getSettings();
  render(settings);
}

enabledToggle.addEventListener("change", async () => {
  await saveSettings({
    enabled: enabledToggle.checked,
    pausedUntil: 0,
  });
  await refresh();
});

detailedToggle.addEventListener("change", async () => {
  await saveSettings({
    detailedMode: detailedToggle.checked,
  });
  await refresh();
});

statusWidgetToggle.addEventListener("change", async () => {
  await saveSettings({
    showStatusWidget: statusWidgetToggle.checked,
  });
  await refresh();
});

materialModeToggle.addEventListener("change", async () => {
  await saveSettings({
    materialMode: materialModeToggle.checked,
  });
  await refresh();
});

if (providerOpenAICheckbox) {
  providerOpenAICheckbox.addEventListener("change", () => {
    setProviderEnabled(PROVIDER_OPENAI, providerOpenAICheckbox.checked);
    renderProviderPriority();
  });
}

if (providerOpenRouterCheckbox) {
  providerOpenRouterCheckbox.addEventListener("change", () => {
    setProviderEnabled(PROVIDER_OPENROUTER, providerOpenRouterCheckbox.checked);
    renderProviderPriority();
  });
}

if (providerGeminiCheckbox) {
  providerGeminiCheckbox.addEventListener("change", () => {
    setProviderEnabled(PROVIDER_GEMINI, providerGeminiCheckbox.checked);
    renderProviderPriority();
  });
}

if (providerCapiCheckbox) {
  providerCapiCheckbox.addEventListener("change", () => {
    setProviderEnabled(PROVIDER_CAPI, providerCapiCheckbox.checked);
    renderProviderPriority();
  });
}

providerMoveButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const providerId = String(button.dataset.provider || "").toLowerCase();
    const direction = String(button.dataset.providerMove || "").toLowerCase();
    if (!providerId || !direction) {
      return;
    }

    moveProvider(providerId, direction === "up" ? "up" : "down");
    renderProviderPriority();
  });
});

saveApiKeyButton.addEventListener("click", async () => {
  const providers = normalizeProviderOrder(providerOrderDraft, {
    fallbackToDefault: false,
  });

  if (!providers.length) {
    apiKeyNote.textContent = "Select at least one provider.";
    return;
  }

  const openaiApiKey = String(openaiApiKeyInput.value || "").trim();
  const openrouterApiKey = String(openrouterApiKeyInput.value || "").trim();
  const geminiApiKey = String(geminiApiKeyInput.value || "").trim();

  await saveSettings({
    apiProviders: providers,
    openaiApiKey,
    openrouterApiKey,
    geminiApiKey,
    apiKey: openaiApiKey,
  });
  apiKeyNote.textContent = "API settings saved.";
  await refresh();
});

clearApiKeyButton.addEventListener("click", async () => {
  await saveSettings({
    openaiApiKey: "",
    openrouterApiKey: "",
    geminiApiKey: "",
    apiKey: "",
  });
  openaiApiKeyInput.value = "";
  openrouterApiKeyInput.value = "";
  geminiApiKeyInput.value = "";
  apiKeyNote.textContent = "API keys cleared.";
  await refresh();
});

pauseButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const minutes = Number(button.dataset.pauseMinutes) || 0;
    const pausedUntil = Date.now() + minutes * 60 * 1000;

    await saveSettings({
      enabled: true,
      pausedUntil,
    });
    await refresh();
  });
});

resumeButton.addEventListener("click", async () => {
  await saveSettings({
    enabled: true,
    pausedUntil: 0,
  });
  await refresh();
});

importMaterialsButton.addEventListener("click", async () => {
  importMaterialsButton.disabled = true;
  importMaterialsButton.textContent = "Applying...";

  try {
    const files = Array.from(materialsInput.files || []).slice(0, MATERIAL_SOURCE_LIMIT);
    const pasted = cleanMaterialText(materialsText.value);
    const sources = [];
    const blocks = [];
    const warnings = [];

    if (pasted) {
      const text = truncateText(pasted, MATERIAL_PER_SOURCE_LIMIT);
      sources.push({
        name: "Pasted text",
        kind: "manual",
        chars: text.length,
      });
      blocks.push(`## Source: Pasted text\n${text}`);
    }

    for (const file of files) {
      try {
        const source = await extractMaterialFromFile(file);
        if (!source.text) {
          continue;
        }

        sources.push({
          name: source.name,
          kind: source.kind,
          chars: source.text.length,
        });
        blocks.push(`## Source: ${source.name}\n${source.text}`);
      } catch (error) {
        warnings.push(error?.message || String(error));
      }
    }

    if (!blocks.length) {
      materialsNote.textContent = warnings.length
        ? `No usable material was found.\n${warnings.join("\n")}`
        : "No usable material was found.";
      return;
    }

    const merged = truncateText(blocks.join("\n\n"), MATERIAL_CONTEXT_LIMIT);
    await saveSettings({
      materialMode: true,
      materialContext: merged,
      materialSources: sources,
      materialRevision: Date.now(),
    });

    materialsInput.value = "";
    materialsText.value = "";
    await refresh();

    if (warnings.length) {
      materialsNote.textContent = `${materialsNote.textContent}\n${warnings.join("\n")}`;
    }
  } catch (error) {
    materialsNote.textContent = `Failed to apply material: ${error?.message || error}`;
  } finally {
    importMaterialsButton.disabled = false;
    importMaterialsButton.textContent = "Apply Material";
  }
});

clearMaterialsButton.addEventListener("click", async () => {
  await saveSettings({
    materialContext: "",
    materialSources: [],
    materialRevision: Date.now(),
  });
  materialsInput.value = "";
  materialsText.value = "";
  await refresh();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  const watchedKeys = [
    "enabled",
    "pausedUntil",
    "detailedMode",
    "showStatusWidget",
    "materialMode",
    "materialContext",
    "materialSources",
    "materialRevision",
    "apiProviders",
    "openaiApiKey",
    "openrouterApiKey",
    "geminiApiKey",
    "apiKey",
  ];

  if (watchedKeys.some((key) => key in changes)) {
    refresh();
  }
});

refresh();
