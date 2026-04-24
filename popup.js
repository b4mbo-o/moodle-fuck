const DEFAULT_SETTINGS = {
  enabled: true,
  pausedUntil: 0,
  detailedMode: false,
  showStatusWidget: true,
};

const statusText = document.getElementById("statusText");
const statusNote = document.getElementById("statusNote");
const enabledToggle = document.getElementById("enabledToggle");
const detailedToggle = document.getElementById("detailedToggle");
const statusWidgetToggle = document.getElementById("statusWidgetToggle");
const pauseNote = document.getElementById("pauseNote");
const resumeButton = document.getElementById("resumeButton");
const pauseButtons = Array.from(document.querySelectorAll("[data-pause-minutes]"));

function normalizeSettings(raw = {}) {
  const pausedUntil = Number(raw.pausedUntil) || 0;

  return {
    enabled: raw.enabled !== false,
    pausedUntil,
    detailedMode: Boolean(raw.detailedMode),
    showStatusWidget: raw.showStatusWidget !== false,
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

function render(settings) {
  enabledToggle.checked = settings.enabled;
  detailedToggle.checked = settings.detailedMode;
  statusWidgetToggle.checked = settings.showStatusWidget;

  const now = Date.now();
  const paused = settings.enabled && settings.pausedUntil > now;

  if (!settings.enabled) {
    statusText.textContent = "停止中";
    statusNote.textContent = "拡張をオフにしているので、ヒント生成は動きません。";
    pauseNote.textContent = "";
    return;
  }

  if (paused) {
    statusText.textContent = "一時停止中";
    statusNote.textContent = `${formatDateTime(settings.pausedUntil)} まで停止します。`;
    pauseNote.textContent = `再開予定: ${formatDateTime(settings.pausedUntil)}`;
    return;
  }

  statusText.textContent = "有効中";
  statusNote.textContent = settings.detailedMode
    ? "詳細モードでヒントを生成します。"
    : "通常モードでヒントを生成します。";
  pauseNote.textContent = "";
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (
    changes.enabled ||
    changes.pausedUntil ||
    changes.detailedMode ||
    changes.showStatusWidget
  ) {
    refresh();
  }
});

refresh();
