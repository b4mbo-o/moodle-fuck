const HINT_STYLE_ID = "moodle-hint-style";
const HINT_PANEL_CLASS = "moodle-hint-panel";
const STATUS_WIDGET_ID = "moodle-hint-status-widget";
const PRIMARY_QUESTION_SELECTOR = ".que";
const FALLBACK_QUESTION_SELECTOR = "[id^='question-']";
const SUBQUESTION_SELECTOR = ".subquestion";
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_IMAGES_PER_QUESTION = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const answerCache = new Map();
const imageDataUrlCache = new Map();
const pendingAnswers = new Map();
const taskQueue = [];

let activeRequests = 0;
let scanScheduled = false;
let deferredScanRequested = false;

const runtimeState = {
  phase: "booting",
  message: "Starting...",
  questionCount: 0,
  readyCount: 0,
  errorCount: 0,
  queueCount: 0,
};

const DEFAULT_SETTINGS = {
  enabled: true,
  pausedUntil: 0,
  detailedMode: false,
  showStatusWidget: true,
  materialMode: false,
  freeApiMode: false,
  materialRevision: 0,
};

let currentSettings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;

function normalizeText(value) {
  return (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSettings(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    pausedUntil: Number(raw.pausedUntil) || 0,
    detailedMode: Boolean(raw.detailedMode),
    showStatusWidget: raw.showStatusWidget !== false,
    materialMode: Boolean(raw.materialMode),
    freeApiMode: Boolean(raw.freeApiMode),
    materialRevision: Number(raw.materialRevision) || 0,
  };
}

function getRequestCacheKey(question, settings = currentSettings) {
  return JSON.stringify({
    questionKey: question.key,
    detailedMode: Boolean(settings.detailedMode),
    materialMode: Boolean(settings.materialMode),
    freeApiMode: Boolean(settings.freeApiMode),
    materialRevision: Number(settings.materialRevision) || 0,
  });
}

function isPaused(settings = currentSettings) {
  return !settings.enabled || settings.pausedUntil > Date.now();
}

function formatPausedUntil(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function getPausedMessage(settings = currentSettings) {
  if (!settings.enabled) {
    return "Disabled from popup.";
  }

  if (settings.pausedUntil > Date.now()) {
    return `Paused until ${formatPausedUntil(settings.pausedUntil)}.`;
  }

  return "";
}

function syncStatusWidgetVisibility() {
  const widget = document.getElementById(STATUS_WIDGET_ID);
  if (!widget) {
    return;
  }

  widget.style.display = currentSettings.showStatusWidget ? "" : "none";
}

function loadSettings(force = false) {
  if (settingsLoaded && !force) {
    return Promise.resolve(currentSettings);
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      currentSettings = normalizeSettings(items);
      settingsLoaded = true;
      syncStatusWidgetVisibility();
      resolve(currentSettings);
    });
  });
}

function renderNodeText(node, options = {}) {
  const {
    blankToken = " [blank] ",
    targetSelect = null,
    otherSelectToken = " ___ ",
  } = options;

  if (!node) {
    return "";
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node;

  if (
    element.matches(".accesshide, .sr-only, script, style, label.subq") ||
    element.matches(".moodle-hint-anchor") ||
    element.matches(`#${STATUS_WIDGET_ID}`)
  ) {
    return "";
  }

  // Inline dropdowns (gapselect). When a target is set, mark it as [blank] and
  // the others as neutral placeholders. When a counter is set, number them
  // [1], [2], ... so all blanks can be answered jointly in one request.
  if (element.matches("select")) {
    if (targetSelect) {
      return element === targetSelect ? blankToken : otherSelectToken;
    }
    if (options.selectCounter) {
      options.selectCounter.value += 1;
      return ` [${options.selectCounter.value}] `;
    }
    return blankToken;
  }

  if (
    element.matches(SUBQUESTION_SELECTOR) ||
    element.matches("input, textarea")
  ) {
    // Multi-blank subquestion groups (e.g. several related answers in one
    // problem). Number every blank [1], [2], ... in document order so the
    // whole passage can be solved jointly in one request.
    if (options.blankCounter) {
      options.blankCounter.value += 1;
      return ` [${options.blankCounter.value}] `;
    }
    return blankToken;
  }

  if (element.tagName === "SUP") {
    return `^${renderChildrenText(element, options)}`;
  }

  if (element.tagName === "BR") {
    return "\n";
  }

  const text = renderChildrenText(element, options);
  if (/^(P|DIV|LI|TR|TD|TH)$/.test(element.tagName)) {
    return `${text}\n`;
  }

  return text;
}

function renderChildrenText(element, options = {}) {
  return Array.from(element.childNodes)
    .map((childNode) => renderNodeText(childNode, options))
    .join("");
}

function ensureStyles() {
  if (document.getElementById(HINT_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = HINT_STYLE_ID;
  style.textContent = `
    .moodle-hint-anchor {
      display: flex;
      justify-content: flex-end;
      margin-top: 12px;
    }

    .${HINT_PANEL_CLASS} {
      width: min(360px, 100%);
      box-sizing: border-box;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 14px;
      background: linear-gradient(180deg, #fff7ed 0%, #ffffff 100%);
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
      color: #1f2937;
      padding: 14px 16px;
      font-family: "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif;
      line-height: 1.55;
    }

    .${HINT_PANEL_CLASS}[data-state="loading"] {
      background: linear-gradient(180deg, #eff6ff 0%, #ffffff 100%);
    }

    .${HINT_PANEL_CLASS}[data-state="error"] {
      background: linear-gradient(180deg, #fff1f2 0%, #ffffff 100%);
      border-color: rgba(190, 24, 93, 0.16);
    }

    .${HINT_PANEL_CLASS}[data-state="manual"] {
      background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);
      border-color: rgba(15, 23, 42, 0.1);
    }

    .${HINT_PANEL_CLASS}[data-state="manual"] .moodle-hint-answer {
      color: #64748b;
      font-weight: 600;
    }

    .moodle-hint-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }

    .moodle-hint-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: #9a3412;
    }

    .moodle-hint-status {
      font-size: 12px;
      color: #64748b;
      white-space: nowrap;
    }

    .moodle-hint-answer {
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .moodle-hint-reason {
      margin-top: 8px;
      font-size: 13px;
      color: #475569;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .moodle-hint-meta {
      margin-top: 10px;
      font-size: 12px;
      color: #64748b;
    }

    .moodle-hint-actions {
      margin-top: 10px;
      display: none;
      justify-content: flex-end;
    }

    .${HINT_PANEL_CLASS}[data-state="error"] .moodle-hint-actions,
    .${HINT_PANEL_CLASS}[data-state="manual"] .moodle-hint-actions {
      display: flex;
    }

    .moodle-hint-retry {
      appearance: none;
      border: 1px solid rgba(15, 23, 42, 0.18);
      border-radius: 8px;
      background: #ffffff;
      color: #0f172a;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      padding: 6px 10px;
      cursor: pointer;
    }

    .moodle-hint-retry:hover {
      border-color: rgba(15, 23, 42, 0.34);
    }

    .moodle-hint-reason:empty,
    .moodle-hint-meta:empty {
      display: none;
    }

    #${STATUS_WIDGET_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      width: min(320px, calc(100vw - 32px));
      box-sizing: border-box;
      border: 1px solid rgba(15, 23, 42, 0.14);
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      box-shadow: 0 16px 36px rgba(15, 23, 42, 0.28);
      padding: 14px 16px;
      font-family: "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif;
      backdrop-filter: blur(8px);
    }

    #${STATUS_WIDGET_ID}[data-phase="running"] {
      background: rgba(3, 105, 161, 0.94);
    }

    #${STATUS_WIDGET_ID}[data-phase="ready"] {
      background: rgba(15, 118, 110, 0.94);
    }

    #${STATUS_WIDGET_ID}[data-phase="idle"] {
      background: rgba(51, 65, 85, 0.94);
    }

    #${STATUS_WIDGET_ID}[data-phase="error"] {
      background: rgba(159, 18, 57, 0.95);
    }

    .moodle-status-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .moodle-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: rgba(248, 250, 252, 0.92);
    }

    .moodle-status-pill::before {
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: #f59e0b;
      box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.12);
      flex: none;
    }

    #${STATUS_WIDGET_ID}[data-phase="running"] .moodle-status-pill::before {
      background: #38bdf8;
    }

    #${STATUS_WIDGET_ID}[data-phase="ready"] .moodle-status-pill::before {
      background: #34d399;
    }

    #${STATUS_WIDGET_ID}[data-phase="idle"] .moodle-status-pill::before {
      background: #94a3b8;
    }

    #${STATUS_WIDGET_ID}[data-phase="error"] .moodle-status-pill::before {
      background: #fb7185;
    }

    .moodle-status-message {
      margin-top: 10px;
      font-size: 14px;
      line-height: 1.5;
      color: #f8fafc;
    }

    .moodle-status-meta {
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.5;
      color: rgba(226, 232, 240, 0.9);
      white-space: pre-wrap;
    }

    @media (max-width: 900px) {
      .moodle-hint-anchor {
        justify-content: stretch;
      }

      .${HINT_PANEL_CLASS} {
        width: 100%;
      }

      #${STATUS_WIDGET_ID} {
        right: 12px;
        left: 12px;
        bottom: 12px;
        width: auto;
      }
    }
  `;

  (document.head || document.documentElement).appendChild(style);
}

function buildQuestionKey(questionText, options, uniqueId = "", imageUrls = []) {
  return JSON.stringify({
    questionText,
    options,
    uniqueId,
    imageUrls,
  });
}

function ensureStatusWidget() {
  let widget = document.getElementById(STATUS_WIDGET_ID);
  if (widget) {
    syncStatusWidgetVisibility();
    return widget;
  }

  widget = document.createElement("aside");
  widget.id = STATUS_WIDGET_ID;
  widget.dataset.phase = "booting";
  widget.innerHTML = `
    <div class="moodle-status-title">
      <span>MoodleFuck</span>
      <span class="moodle-status-pill">Booting</span>
    </div>
    <div class="moodle-status-message">Content script started.</div>
    <div class="moodle-status-meta">Waiting for page scan...</div>
  `;

  (document.body || document.documentElement).appendChild(widget);
  syncStatusWidgetVisibility();
  return widget;
}

function setStatus(phase, message, extra = {}) {
  runtimeState.phase = phase;
  runtimeState.message = message;
  runtimeState.questionCount = extra.questionCount ?? runtimeState.questionCount;
  runtimeState.readyCount = extra.readyCount ?? runtimeState.readyCount;
  runtimeState.errorCount = extra.errorCount ?? runtimeState.errorCount;
  runtimeState.queueCount = extra.queueCount ?? runtimeState.queueCount;

  const widget = ensureStatusWidget();
  widget.dataset.phase = phase;

  const labelMap = {
    booting: "Booting",
    scanning: "Scanning",
    running: "Working",
    ready: "Ready",
    idle: "Idle",
    error: "Error",
  };

  const meta = [
    `Questions: ${runtimeState.questionCount}`,
    `Ready: ${runtimeState.readyCount}`,
    `Errors: ${runtimeState.errorCount}`,
    `Queue: ${runtimeState.queueCount}`,
  ].join(" | ");

  widget.querySelector(".moodle-status-pill").textContent =
    labelMap[phase] || phase;
  widget.querySelector(".moodle-status-message").textContent = message;
  widget.querySelector(".moodle-status-meta").textContent = meta;
}

function getFallbackRootFromQuestionText(questionNode) {
  let current = questionNode.parentElement;

  while (current && current !== document.body && current !== document.documentElement) {
    if (current.querySelector(".answer") || current.querySelector(SUBQUESTION_SELECTOR)) {
      return current;
    }

    current = current.parentElement;
  }

  return questionNode.parentElement;
}

function getQuestionRoots() {
  const primaryRoots = Array.from(
    document.querySelectorAll(PRIMARY_QUESTION_SELECTOR)
  );
  if (primaryRoots.length) {
    return primaryRoots;
  }

  const fallbackRoots = Array.from(
    document.querySelectorAll(FALLBACK_QUESTION_SELECTOR)
  );
  if (fallbackRoots.length) {
    return fallbackRoots;
  }

  const derivedRoots = Array.from(document.querySelectorAll(".qtext"))
    .map((questionNode) => getFallbackRootFromQuestionText(questionNode))
    .filter(Boolean);

  return Array.from(new Set(derivedRoots));
}

function getOwningQuestionRoot(element) {
  return (
    element.closest(".que") ||
    element.closest("[id^='question-']") ||
    element.closest(".content") ||
    element.closest(".formulation") ||
    element.parentElement
  );
}

function getQuestionLabel(questionRoot) {
  const qno = normalizeText(questionRoot.querySelector(".qno")?.textContent);
  if (qno) {
    return `Question ${qno}`;
  }

  const heading = normalizeText(questionRoot.querySelector(".no")?.textContent);
  return heading || "Question";
}

function extractQuestionText(questionRoot) {
  const questionNode = questionRoot.querySelector(".qtext");
  if (questionNode) {
    return normalizeText(renderNodeText(questionNode));
  }

  const formulation =
    questionRoot.matches(".formulation")
      ? questionRoot
      : questionRoot.querySelector(".formulation");

  if (!formulation) {
    return "";
  }

  return normalizeText(renderNodeText(formulation));
}

function isFormControlFilled(element) {
  if (!element) {
    return false;
  }

  if (element.tagName === "SELECT") {
    return Boolean(normalizeText(element.value));
  }

  if (element.type === "checkbox" || element.type === "radio") {
    return Boolean(element.checked);
  }

  return Boolean(normalizeText(element.value));
}

function anyFormControlFilled(elements) {
  return (elements || []).some((element) => isFormControlFilled(element));
}

function answerRootHasExistingAnswer(questionRoot) {
  const answerRoot = questionRoot.querySelector(".answer");
  if (!answerRoot) {
    return false;
  }

  // Moodle checkbox groups pair each visible checkbox with a hidden input
  // carrying the "unchecked" fallback value (e.g. value="0"). That hidden
  // input always has a non-empty value, so it must be excluded here or
  // every checkbox question would look "already answered".
  return anyFormControlFilled(
    Array.from(
      answerRoot.querySelectorAll("input:not([type='hidden']), textarea, select")
    )
  );
}

function extractOptions(questionRoot) {
  const answerRoot = questionRoot.querySelector(".answer");
  if (!answerRoot) {
    return [];
  }

  const candidateGroups = [
    answerRoot.querySelectorAll("[data-region='answer-label']"),
    answerRoot.querySelectorAll("label"),
    answerRoot.querySelectorAll("option"),
    answerRoot.querySelectorAll(":scope > div"),
  ];

  const results = [];
  const seen = new Set();

  for (const candidates of candidateGroups) {
    for (const element of candidates) {
      if (
        element.closest(".qtype_multichoice_clearchoice") ||
        (element.matches("option") && !normalizeText(element.value))
      ) {
        continue;
      }

      const text = normalizeText(element.innerText || element.textContent || "");
      if (!text) {
        continue;
      }

      if (
        /^(clear my choice|reset answer)$/i.test(text) ||
        text.includes("\u30af\u30ea\u30a2") ||
        seen.has(text)
      ) {
        continue;
      }

      seen.add(text);
      results.push(text);
    }

    if (results.length) {
      return results;
    }
  }

  return results;
}

function getPromptContainer(subquestion) {
  return (
    subquestion.closest("p, li, td, th") ||
    subquestion.parentElement ||
    subquestion
  );
}

// Walks `root`'s children in document order, collecting rendered text for
// every node that comes strictly BEFORE `targetNode`. When a child contains
// the target (e.g. a <ul> wrapping several <li> blanks), it recurses into
// that child instead of skipping it wholesale, so earlier siblings inside
// the same wrapper (e.g. an earlier <li> in the same list) are still
// captured — then stops, since nothing after that ancestor at this level
// can precede the target. Returns true once the target has been reached.
function collectTextBeforeNode(root, targetNode, collector) {
  for (const child of Array.from(root.children)) {
    if (child === targetNode) {
      return true;
    }

    if (
      child.matches?.(".moodle-hint-anchor") ||
      child.matches?.(`#${STATUS_WIDGET_ID}`)
    ) {
      continue;
    }

    if (child.contains(targetNode)) {
      collectTextBeforeNode(child, targetNode, collector);
      return true;
    }

    // Other blanks (e.g. a sibling <li> in the same list) render as a
    // neutral placeholder, not the [blank] marker reserved for the target.
    const text = normalizeText(
      renderNodeText(child, { blankToken: " ___ " })
    );
    if (text) {
      collector.push(text);
    }
  }

  return false;
}

function extractPromptContext(questionRoot, promptContainer) {
  const formulation =
    questionRoot.matches(".formulation")
      ? questionRoot
      : questionRoot.querySelector(".formulation");

  if (!formulation || !promptContainer) {
    return "";
  }

  const contextParts = [];
  collectTextBeforeNode(formulation, promptContainer, contextParts);
  return contextParts.join("\n");
}

function extractSubquestionOptions(subquestion) {
  const select = subquestion.querySelector("select");
  if (!select) {
    return [];
  }

  return Array.from(select.options)
    .map((option) => normalizeText(option.textContent || option.innerText || ""))
    .filter((optionText) => optionText && optionText !== "-");
}

function extractTextAroundSubquestion(promptContainer, subquestion) {
  let before = "";
  let after = "";
  let foundTarget = false;

  for (const childNode of Array.from(promptContainer.childNodes)) {
    const isTargetNode =
      childNode === subquestion ||
      (childNode instanceof Element && childNode.contains(subquestion));

    if (isTargetNode) {
      foundTarget = true;
      continue;
    }

    const text = renderNodeText(childNode);
    if (!text) {
      continue;
    }

    if (foundTarget) {
      after += ` ${text}`;
    } else {
      before += ` ${text}`;
    }
  }

  return {
    before: normalizeText(before),
    after: normalizeText(after),
  };
}

function guessBlankVariableName(before) {
  const normalized = normalizeText(before);

  // Physics/formula style: "I1 = [blank] A" — pull out the "I1".
  const equalsMatch = normalized.match(/([A-Za-z][A-Za-z0-9_]{0,6})\s*=\s*$/);
  if (equalsMatch) {
    return equalsMatch[1];
  }

  // Label style: "元素名1 : [blank]" / "...を表す単位の記号 : [blank]" — use
  // the label text itself so the model gets a real anchor instead of a
  // generic "Blank N"/"Symbol" name that can't distinguish repeated blanks.
  // The label may span multiple sibling nodes (e.g. <strong>...</strong>
  // followed by a plain text node), so allow internal spaces — just not
  // another colon, which would pull in an unrelated earlier clause.
  const colonMatch = normalized.match(/([^:：]{1,40})\s*[:：]\s*$/);
  if (colonMatch) {
    return normalizeText(colonMatch[1]);
  }

  return "";
}

function inferSubquestionFieldInfo(questionRoot, promptContainer, subquestion, index) {
  const { before, after } = extractTextAroundSubquestion(promptContainer, subquestion);
  // The instruction that determines symbol/katakana requirements (e.g.
  // "カタカナで...答えよ") often sits in an earlier paragraph outside this
  // blank's own <li>, not in its immediate before/after text — pull in the
  // broader (correctly document-ordered) preceding context too.
  const broaderContext = extractPromptContext(questionRoot, promptContainer);
  const beforeCompact = `${broaderContext} ${before}`.toLowerCase().replace(/\s+/g, "");
  const afterCompact = after.toLowerCase().replace(/\s+/g, "");
  const variableName = guessBlankVariableName(before);

  const symbolKeywords = [
    /symbol/i,
    /unit/i,
    /\u8A18\u53F7/,
    /\u5358\u4F4D/,
  ];
  const nameKeywords = [
    /name/i,
    /\u540D\u524D/,
    /\u540D\u79F0/,
    /\u30AB\u30BF\u30AB\u30CA/,
  ];

  const beforeHasSymbol = symbolKeywords.some((pattern) => pattern.test(beforeCompact));
  const beforeHasName = nameKeywords.some((pattern) => pattern.test(beforeCompact));
  const afterHasSymbol = symbolKeywords.some((pattern) => pattern.test(afterCompact));
  const afterHasName = nameKeywords.some((pattern) => pattern.test(afterCompact));

  if (beforeHasSymbol || afterHasSymbol) {
    return { type: "symbol", label: "Symbol", variableName };
  }

  if (beforeHasName || afterHasName) {
    return { type: "name", label: "Name", variableName };
  }

  return {
    type: "blank",
    label: `Blank ${index}`,
    variableName,
  };
}

function buildSubquestionText(questionRoot, promptContainer) {
  const contextText = extractPromptContext(questionRoot, promptContainer);
  const promptText = normalizeText(renderNodeText(promptContainer));

  return [contextText, promptText].filter(Boolean).join("\n");
}

function getSubquestionLabel(questionRoot, promptText, index, fieldInfo) {
  const matchedPromptLabel = promptText.match(/question\s*([0-9]+)/i);
  const suffix = fieldInfo?.label ? ` ${fieldInfo.label}` : "";

  if (matchedPromptLabel) {
    return `Question ${matchedPromptLabel[1]}${suffix}`;
  }

  const baseLabel = getQuestionLabel(questionRoot);
  return fieldInfo?.label
    ? `${baseLabel} ${fieldInfo.label}`
    : `${baseLabel} Blank ${index}`;
}

function extractSubquestions() {
  const countsByRoot = new Map();
  const blanksByRoot = new Map();

  const blanks = Array.from(document.querySelectorAll(SUBQUESTION_SELECTOR))
    .map((subquestion) => {
      const questionRoot = getOwningQuestionRoot(subquestion);
      if (!questionRoot) {
        return null;
      }

      const nextIndex = (countsByRoot.get(questionRoot) || 0) + 1;
      countsByRoot.set(questionRoot, nextIndex);

      const promptContainer = getPromptContainer(subquestion);
      const fieldInfo = inferSubquestionFieldInfo(
        questionRoot,
        promptContainer,
        subquestion,
        nextIndex
      );
      const questionText = buildSubquestionText(questionRoot, promptContainer);
      if (!questionText) {
        return null;
      }

      const inputElement = subquestion.querySelector(
        "input:not([type='hidden']), textarea, select"
      );
      const uniqueId =
        inputElement?.id ||
        inputElement?.name ||
        `${getQuestionLabel(questionRoot)}-${nextIndex}`;
      const options = extractSubquestionOptions(subquestion);

      const blank = {
        key: buildQuestionKey(questionText, options, uniqueId),
        label: getSubquestionLabel(
          questionRoot,
          questionText,
          nextIndex,
          fieldInfo
        ),
        questionRoot,
        questionText,
        options,
        anchorElement: promptContainer,
        targetType: fieldInfo.type,
        fieldLabel: fieldInfo.label,
        requestKey: uniqueId,
        uniqueId,
        inputElement,
        variableName: fieldInfo.variableName || "",
        hasExistingAnswer: isFormControlFilled(inputElement),
      };

      const siblingList = blanksByRoot.get(questionRoot) || [];
      siblingList.push(blank);
      blanksByRoot.set(questionRoot, siblingList);

      return blank;
    })
    .filter(Boolean);

  // When a question root has several related free-text blanks (e.g. a
  // multi-part physics problem with I, I1, I2, V3...), solve them jointly in
  // one request instead of one isolated request per blank. Isolated requests
  // can't stay consistent with each other (e.g. re-deriving a different
  // circuit topology for each current, or forgetting a later part builds on
  // an earlier one).
  for (const [questionRoot, group] of blanksByRoot) {
    if (group.length < 2 || group.some((blank) => blank.options.length)) {
      // Groups with dropdown options (e.g. matching-type subquestions) keep
      // using the existing independent per-blank flow.
      continue;
    }

    const formulation = questionRoot.matches(".formulation")
      ? questionRoot
      : questionRoot.querySelector(".formulation");
    if (!formulation) {
      continue;
    }

    const markedText = buildMultiBlankMarkedText(formulation);
    if (!markedText) {
      continue;
    }

    // Prefer a real anchor like "I1" over a generic "Blank 2" so the model
    // has an explicit index-to-quantity mapping, not just the passage text.
    const nameCounts = new Map();
    for (const blank of group) {
      const name = blank.variableName || blank.label;
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
    const nameOccurrence = new Map();
    const groupBlanks = group.map((blank) => {
      const baseName = blank.variableName || blank.label;
      let label = baseName;
      if (nameCounts.get(baseName) > 1) {
        // Disambiguate repeated names (e.g. "I" asked again in a later part).
        const occurrence = (nameOccurrence.get(baseName) || 0) + 1;
        nameOccurrence.set(baseName, occurrence);
        label = `${baseName} (occurrence ${occurrence} of ${nameCounts.get(baseName)})`;
      }
      return { label, fieldType: blank.targetType };
    });
    const groupRequestKey = `${group[0].uniqueId}-group`;
    // These are solved together in one request, so if any sibling already
    // has an answer, treat the whole group as already attempted.
    const groupHasExistingAnswer = group.some((blank) => blank.hasExistingAnswer);

    group.forEach((blank, index) => {
      blank.groupMarkedText = markedText;
      blank.groupIndex = index;
      blank.groupBlanks = groupBlanks;
      blank.groupRequestKey = groupRequestKey;
      blank.hasExistingAnswer = groupHasExistingAnswer;
    });
  }

  return blanks;
}

function getImageContainer(questionRoot) {
  return (
    questionRoot.querySelector(".qtext") ||
    (questionRoot.matches(".formulation")
      ? questionRoot
      : questionRoot.querySelector(".formulation")) ||
    questionRoot
  );
}

function collectQuestionImageElements(container) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll("img")).filter((img) => {
    if (
      img.closest(`.${HINT_PANEL_CLASS}`) ||
      img.closest(".moodle-hint-anchor") ||
      img.closest(`#${STATUS_WIDGET_ID}`)
    ) {
      return false;
    }

    // Skip tiny decorations (icons, emoticons) once dimensions are known.
    if (
      img.complete &&
      img.naturalWidth > 0 &&
      (img.naturalWidth < 32 || img.naturalHeight < 32)
    ) {
      return false;
    }

    return Boolean(img.currentSrc || img.src);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error("Failed to read image blob."));
    reader.readAsDataURL(blob);
  });
}

async function fetchImageAsDataUrl(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status}): ${url}`);
  }

  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large to send: ${url}`);
  }

  return blobToDataUrl(blob);
}

function getImageDataUrl(url) {
  // Cache promises so concurrent scans share one fetch; drop failures so the
  // next scan can retry.
  let promise = imageDataUrlCache.get(url);
  if (!promise) {
    promise = fetchImageAsDataUrl(url).catch((error) => {
      imageDataUrlCache.delete(url);
      throw error;
    });
    imageDataUrlCache.set(url, promise);
  }

  return promise;
}

async function extractQuestionImages(container) {
  const imgElements = collectQuestionImageElements(container).slice(
    0,
    MAX_IMAGES_PER_QUESTION
  );

  const images = [];
  for (const img of imgElements) {
    const url = img.currentSrc || img.src;
    if (!url) {
      continue;
    }

    try {
      const dataUrl = await getImageDataUrl(url);
      images.push({ url, dataUrl });
    } catch (error) {
      console.warn("Failed to load question image:", url, error);
    }
  }

  return images;
}

async function attachQuestionImages(questions) {
  await Promise.all(
    questions.map(async (question) => {
      const container = getImageContainer(question.questionRoot);
      question.images = await extractQuestionImages(container);
      const imageUrls = question.images.map((image) => image.url);

      if (question.targetType === "gapfill") {
        question.key =
          buildQuestionKey(
            question.questionText,
            [],
            question.uniqueId || "",
            imageUrls
          ) + "#gapfill";
        return;
      }

      question.key = buildQuestionKey(
        question.questionText,
        question.options,
        question.uniqueId || "",
        imageUrls
      );
    })
  );

  return questions;
}

// Inline dropdowns (Moodle "gapselect") live directly inside .qtext, not inside
// a .subquestion wrapper. Each <select> is one blank sharing the same sentence.
function getInlineSelects(container) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll("select")).filter(
    (select) => !select.closest(SUBQUESTION_SELECTOR)
  );
}

function extractSelectOptions(select) {
  return Array.from(select.options)
    .map((option) => normalizeText(option.textContent || option.innerText || ""))
    .filter((optionText) => optionText && optionText !== "-");
}

// The whole sentence with every blank numbered [1], [2], ... so the model can
// reason about all blanks together in a single request.
function buildGapfillMarkedText(container) {
  return normalizeText(
    renderNodeText(container, { selectCounter: { value: 0 } })
  );
}

// The whole passage with every free-text blank numbered [1], [2], ... in
// document order, so a multi-part problem (e.g. several related physics
// answers) can be solved jointly with shared, consistent reasoning instead
// of re-deriving each value from scratch in an isolated request.
function buildMultiBlankMarkedText(formulation) {
  return normalizeText(
    renderNodeText(formulation, { blankCounter: { value: 0 } })
  );
}

function buildGapfillBlanks(selects) {
  return selects.map((select, index) => ({
    label: `空白${index + 1}`,
    options: extractSelectOptions(select),
  }));
}

async function extractQuestions() {
  const gapfillQuestions = [];
  const standardQuestions = [];

  for (const questionRoot of getQuestionRoots()) {
    if (questionRoot.querySelector(SUBQUESTION_SELECTOR)) {
      continue;
    }

    const uniqueId = questionRoot.id || "";
    const container = getImageContainer(questionRoot);
    const inlineSelects = getInlineSelects(container);

    if (inlineSelects.length) {
      const baseText = extractQuestionText(questionRoot);
      gapfillQuestions.push({
        key: buildQuestionKey(baseText, [], uniqueId) + "#gapfill",
        label: getQuestionLabel(questionRoot),
        questionRoot,
        questionText: baseText,
        markedText: buildGapfillMarkedText(container),
        options: [],
        targetType: "gapfill",
        requestKey: uniqueId || baseText,
        uniqueId,
        blanks: buildGapfillBlanks(inlineSelects),
        hasExistingAnswer: anyFormControlFilled(inlineSelects),
        anchorElement:
          questionRoot.querySelector(".formulation") ||
          questionRoot.querySelector(".content") ||
          questionRoot,
      });
      continue;
    }

    const questionText = extractQuestionText(questionRoot);
    if (!questionText) {
      continue;
    }

    const options = extractOptions(questionRoot);
    standardQuestions.push({
      key: buildQuestionKey(questionText, options, uniqueId),
      label: getQuestionLabel(questionRoot),
      questionRoot,
      questionText,
      options,
      targetType: "standard",
      requestKey: questionRoot.id || questionText,
      uniqueId,
      hasExistingAnswer: answerRootHasExistingAnswer(questionRoot),
      anchorElement:
        questionRoot.querySelector(".formulation") ||
        questionRoot.querySelector(".content") ||
        questionRoot,
    });
  }

  const subquestions = extractSubquestions();
  const questions = [
    ...standardQuestions,
    ...gapfillQuestions,
    ...subquestions,
  ];
  await attachQuestionImages(questions);
  return questions;
}

function ensurePanel(question) {
  const existing = Array.from(
    document.querySelectorAll(`.${HINT_PANEL_CLASS}`)
  ).find((panel) => panel.dataset.questionKey === question.key);
  if (existing) {
    return existing;
  }

  const anchor = document.createElement("div");
  anchor.className = "moodle-hint-anchor";

  const isAlreadyAnswered = Boolean(question.hasExistingAnswer);

  const panel = document.createElement("aside");
  panel.className = HINT_PANEL_CLASS;
  panel.dataset.state = isAlreadyAnswered ? "manual" : "idle";
  panel.dataset.questionKey = question.key;
  panel.innerHTML = isAlreadyAnswered
    ? `
    <div class="moodle-hint-header">
      <div class="moodle-hint-title">${question.label} Hint</div>
      <div class="moodle-hint-status">Skipped</div>
    </div>
    <div class="moodle-hint-answer">Already answered — hint not generated.</div>
    <div class="moodle-hint-reason"></div>
    <div class="moodle-hint-meta"></div>
    <div class="moodle-hint-actions">
      <button class="moodle-hint-retry" type="button">Generate hint</button>
    </div>
  `
    : `
    <div class="moodle-hint-header">
      <div class="moodle-hint-title">${question.label} Hint</div>
      <div class="moodle-hint-status">Queued</div>
    </div>
    <div class="moodle-hint-answer">Waiting for turn...</div>
    <div class="moodle-hint-reason"></div>
    <div class="moodle-hint-meta"></div>
    <div class="moodle-hint-actions">
      <button class="moodle-hint-retry" type="button">Retry</button>
    </div>
  `;

  anchor.appendChild(panel);

  const anchorTarget =
    question.anchorElement ||
    question.questionRoot.querySelector(".formulation") ||
    question.questionRoot.querySelector(".content") ||
    question.questionRoot;

  if (anchorTarget?.parentNode) {
    anchorTarget.insertAdjacentElement("afterend", anchor);
  } else if (question.questionRoot) {
    question.questionRoot.appendChild(anchor);
  }

  const retryButton = panel.querySelector(".moodle-hint-retry");
  if (retryButton) {
    retryButton.addEventListener("click", () => {
      retryHint(question, panel);
    });
  }

  return panel;
}

function removePanel(panel) {
  const anchor = panel.closest(".moodle-hint-anchor");
  if (anchor) {
    anchor.remove();
    return;
  }

  panel.remove();
}

function cleanupPanels(questions) {
  const validKeys = new Set(questions.map((question) => question.key));
  const seenKeys = new Set();

  for (const panel of Array.from(document.querySelectorAll(`.${HINT_PANEL_CLASS}`))) {
    const key = panel.dataset.questionKey || "";
    if (!validKeys.has(key) || seenKeys.has(key)) {
      removePanel(panel);
      continue;
    }

    seenKeys.add(key);
  }
}

function updatePanel(panel, payload) {
  panel.dataset.state = payload.state;
  panel.querySelector(".moodle-hint-status").textContent = payload.status;
  panel.querySelector(".moodle-hint-answer").textContent = payload.answer;
  panel.querySelector(".moodle-hint-reason").textContent = payload.reason || "";
  panel.querySelector(".moodle-hint-meta").textContent = payload.meta || "";

  const retryButton = panel.querySelector(".moodle-hint-retry");
  if (retryButton) {
    retryButton.textContent = payload.state === "manual" ? "Generate hint" : "Retry";
  }
}

function retryHint(question, panel) {
  const isFirstGeneration = panel.dataset.state === "manual";

  loadSettings().then((settings) => {
    if (isPaused(settings)) {
      updatePanel(panel, {
        state: "idle",
        status: "Paused",
        answer: getPausedMessage(settings) || "Paused.",
        reason: "",
        meta: "",
      });
      return;
    }

    delete panel.dataset.loadedKey;
    delete panel.dataset.loadingKey;

    const cacheKey = getRequestCacheKey(question, settings);
    answerCache.delete(cacheKey);
    pendingAnswers.delete(cacheKey);

    updatePanel(panel, {
      state: "loading",
      status: isFirstGeneration ? "Loading..." : "Retrying...",
      answer: isFirstGeneration ? "Generating hint..." : "Retrying hint...",
      reason: "",
      meta: "",
    });

    enqueue(() => hydratePanel(question, panel, { force: true }));
  });
}

function clearQueuedTasks() {
  taskQueue.length = 0;
  runtimeState.queueCount = activeRequests;
}

function resetPanelLoadState({ clearLoaded = false } = {}) {
  for (const panel of Array.from(document.querySelectorAll(`.${HINT_PANEL_CLASS}`))) {
    delete panel.dataset.loadingKey;

    if (clearLoaded) {
      delete panel.dataset.loadedKey;
    }
  }
}

function markLoadingPanelsPaused(message) {
  const pausedMessage = message || "Paused.";

  for (const panel of Array.from(document.querySelectorAll(`.${HINT_PANEL_CLASS}`))) {
    if (panel.dataset.state !== "loading") {
      continue;
    }

    updatePanel(panel, {
      state: "idle",
      status: "Paused",
      answer: pausedMessage,
      reason: "",
      meta: "",
    });
  }
}

function getPanelStats() {
  const panels = Array.from(document.querySelectorAll(`.${HINT_PANEL_CLASS}`));

  return panels.reduce(
    (stats, panel) => {
      const state = panel.dataset.state;

      if (state === "ready") {
        stats.readyCount += 1;
      } else if (state === "error") {
        stats.errorCount += 1;
      } else if (state === "loading") {
        stats.loadingCount += 1;
      }

      return stats;
    },
    { readyCount: 0, errorCount: 0, loadingCount: 0 }
  );
}

function parseAnswerText(answerPayload) {
  const answerText =
    typeof answerPayload === "string"
      ? answerPayload
      : answerPayload?.answer || "";
  const modelName = normalizeText(
    typeof answerPayload === "object" ? answerPayload?.model || "" : ""
  );
  const providerName = normalizeText(
    typeof answerPayload === "object" ? answerPayload?.provider || "" : ""
  );
  const expression = normalizeText(
    typeof answerPayload === "object" ? answerPayload?.expression || "" : ""
  );

  const answer = String(answerText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!answer) {
    return {
      answer: "No hint available.",
      reason: "",
      meta: "",
    };
  }

  // Fallback events (a provider failing over to the next) are logged in the
  // popup's Logs panel instead of cluttering every hint with them.
  return {
    answer,
    reason: expression ? `式: ${expression}` : "",
    meta:
      modelName && providerName
        ? `Provider: ${providerName} | Model: ${modelName}`
        : modelName
          ? `Model: ${modelName}`
          : providerName
            ? `Provider: ${providerName}`
            : "",
  };
}

function requestAnswer(question) {
  const cacheKey = getRequestCacheKey(question);

  if (answerCache.has(cacheKey)) {
    return Promise.resolve(answerCache.get(cacheKey));
  }

  if (pendingAnswers.has(cacheKey)) {
    return pendingAnswers.get(cacheKey);
  }

  const promise = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "getAnswer",
        question: question.questionText,
        options: question.options,
        images: (question.images || []).map((image) => image.dataUrl),
        requestKey: question.requestKey || question.key,
        targetType: question.targetType || "standard",
        fieldLabel: question.fieldLabel || "",
        detailedMode: Boolean(currentSettings.detailedMode),
        materialMode: Boolean(currentSettings.materialMode),
        materialRevision: Number(currentSettings.materialRevision) || 0,
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        const responseError = normalizeText(response?.error || "");
        if (responseError) {
          reject(new Error(responseError));
          return;
        }

        const answer = normalizeText(response?.answer || "");
        if (!answer || /^error fetching answer\.?$/i.test(answer)) {
          reject(new Error("No answer found."));
          return;
        }

        const result = {
          answer,
          model: normalizeText(response?.model || ""),
          provider: normalizeText(response?.provider || ""),
          expression: normalizeText(response?.expression || ""),
          fallbackNote: normalizeText(response?.fallbackNote || ""),
        };

        answerCache.set(cacheKey, result);
        resolve(result);
      }
    );
  }).finally(() => {
    pendingAnswers.delete(cacheKey);
  });

  pendingAnswers.set(cacheKey, promise);
  return promise;
}

function enqueue(task) {
  taskQueue.push(task);
  setStatus("running", "Preparing hints...", {
    queueCount: taskQueue.length + activeRequests,
  });
  runQueue();
}

function runQueue() {
  if (isPaused(currentSettings)) {
    return;
  }

  while (activeRequests < MAX_CONCURRENT_REQUESTS && taskQueue.length) {
    const task = taskQueue.shift();
    activeRequests += 1;

    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error("Hint task failed:", error);
      })
      .finally(() => {
        activeRequests -= 1;
        if (taskQueue.length + activeRequests > 0) {
          if (isPaused(currentSettings)) {
            setStatus("idle", getPausedMessage(currentSettings), {
              queueCount: activeRequests,
            });
          } else {
            setStatus("running", "Preparing hints...", {
              queueCount: taskQueue.length + activeRequests,
            });
          }
        }

        if (
          activeRequests === 0 &&
          taskQueue.length === 0 &&
          deferredScanRequested &&
          !isPaused(currentSettings)
        ) {
          deferredScanRequested = false;
          scheduleScan();
        }

        runQueue();
      });
  }
}

function requestGapfillAnswer(question) {
  const cacheKey = getRequestCacheKey(question);

  if (answerCache.has(cacheKey)) {
    return Promise.resolve(answerCache.get(cacheKey));
  }

  if (pendingAnswers.has(cacheKey)) {
    return pendingAnswers.get(cacheKey);
  }

  const promise = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "getAnswer",
        question: question.markedText,
        blanks: question.blanks.map((blank) => ({
          label: blank.label,
          options: blank.options,
        })),
        images: (question.images || []).map((image) => image.dataUrl),
        requestKey: question.requestKey || question.key,
        targetType: "gapfill",
        detailedMode: Boolean(currentSettings.detailedMode),
        materialMode: Boolean(currentSettings.materialMode),
        materialRevision: Number(currentSettings.materialRevision) || 0,
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        const responseError = normalizeText(response?.error || "");
        if (responseError) {
          reject(new Error(responseError));
          return;
        }

        const answers = Array.isArray(response?.answers) ? response.answers : [];
        if (!answers.length) {
          reject(new Error("No answer found."));
          return;
        }

        const result = {
          answers,
          model: normalizeText(response?.model || ""),
          provider: normalizeText(response?.provider || ""),
          fallbackNote: normalizeText(response?.fallbackNote || ""),
        };

        answerCache.set(cacheKey, result);
        resolve(result);
      }
    );
  }).finally(() => {
    pendingAnswers.delete(cacheKey);
  });

  pendingAnswers.set(cacheKey, promise);
  return promise;
}

async function resolveGapfillAnswers(question) {
  const result = await requestGapfillAnswer(question);
  const lines = result.answers.map(
    (item, index) =>
      `${normalizeText(item?.label) || `空白${index + 1}`}: ${
        normalizeText(item?.answer) || "(不明)"
      }`
  );

  const model = normalizeText(result.model || "");
  const provider = normalizeText(result.provider || "");
  const meta =
    model && provider
      ? `Provider: ${provider} | Model: ${model}`
      : model
        ? `Model: ${model}`
        : provider
          ? `Provider: ${provider}`
          : "";

  return {
    answer: lines.join("\n"),
    reason: "",
    meta,
  };
}

function getGroupRequestCacheKey(question, settings = currentSettings) {
  return JSON.stringify({
    groupKey: question.groupRequestKey || question.groupMarkedText,
    markedText: question.groupMarkedText,
    detailedMode: Boolean(settings.detailedMode),
    materialMode: Boolean(settings.materialMode),
    freeApiMode: Boolean(settings.freeApiMode),
    materialRevision: Number(settings.materialRevision) || 0,
    imageUrls: (question.images || []).map((image) => image.url),
  });
}

function requestGroupBlankAnswers(question) {
  const cacheKey = getGroupRequestCacheKey(question);

  if (answerCache.has(cacheKey)) {
    return Promise.resolve(answerCache.get(cacheKey));
  }

  if (pendingAnswers.has(cacheKey)) {
    return pendingAnswers.get(cacheKey);
  }

  const promise = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "getAnswer",
        question: question.groupMarkedText,
        blanks: question.groupBlanks,
        images: (question.images || []).map((image) => image.dataUrl),
        requestKey: question.groupRequestKey || question.requestKey || question.key,
        targetType: "multiblank",
        detailedMode: Boolean(currentSettings.detailedMode),
        materialMode: Boolean(currentSettings.materialMode),
        materialRevision: Number(currentSettings.materialRevision) || 0,
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        const responseError = normalizeText(response?.error || "");
        if (responseError) {
          reject(new Error(responseError));
          return;
        }

        const answers = Array.isArray(response?.answers) ? response.answers : [];
        if (!answers.length) {
          reject(new Error("No answer found."));
          return;
        }

        const result = {
          answers,
          model: normalizeText(response?.model || ""),
          provider: normalizeText(response?.provider || ""),
          fallbackNote: normalizeText(response?.fallbackNote || ""),
        };

        answerCache.set(cacheKey, result);
        resolve(result);
      }
    );
  }).finally(() => {
    pendingAnswers.delete(cacheKey);
  });

  pendingAnswers.set(cacheKey, promise);
  return promise;
}

async function resolveGroupBlankAnswer(question) {
  const result = await requestGroupBlankAnswers(question);
  const item = result.answers[question.groupIndex];
  const answer = normalizeText(item?.answer || "");
  if (!answer) {
    throw new Error("No answer found for this blank.");
  }

  const expression = normalizeText(item?.expression || "");
  const model = normalizeText(result.model || "");
  const provider = normalizeText(result.provider || "");

  return {
    answer,
    reason: expression ? `式: ${expression}` : "",
    meta:
      model && provider
        ? `Provider: ${provider} | Model: ${model}`
        : model
          ? `Model: ${model}`
          : provider
            ? `Provider: ${provider}`
            : "",
  };
}

async function hydratePanel(question, panel, options = {}) {
  const force = Boolean(options.force);
  const settings = await loadSettings();
  const loadKey = getRequestCacheKey(question, settings);

  if (
    !force &&
    (panel.dataset.loadedKey === loadKey || panel.dataset.loadingKey === loadKey)
  ) {
    return;
  }

  if (isPaused(settings)) {
    return;
  }

  try {
    panel.dataset.loadingKey = loadKey;
    setStatus("running", `${question.label}: generating hint...`, {
      queueCount: taskQueue.length + activeRequests,
    });
    updatePanel(panel, {
      state: "loading",
      status: "Loading...",
      answer: "Generating hint...",
      reason: "",
      meta: "",
    });

    let parsed;
    if (question.blanks && question.blanks.length) {
      parsed = await resolveGapfillAnswers(question);
    } else if (question.groupMarkedText) {
      parsed = await resolveGroupBlankAnswer(question);
    } else {
      parsed = parseAnswerText(await requestAnswer(question));
    }

    panel.dataset.loadedKey = loadKey;
    runtimeState.readyCount += 1;
    updatePanel(panel, {
      state: "ready",
      status: "Ready",
      answer: parsed.answer,
      reason: parsed.reason,
      meta: parsed.meta,
    });
    if (!isPaused(currentSettings)) {
      setStatus("running", `${question.label}: hint ready`, {
        readyCount: runtimeState.readyCount,
        queueCount: taskQueue.length + activeRequests,
      });
    }
  } catch (error) {
    console.error("Failed to fetch answer:", error);
    runtimeState.errorCount += 1;
    updatePanel(panel, {
      state: "error",
      status: "Error",
      answer: "Could not fetch hint.",
      reason: normalizeText(error?.message || ""),
      meta: "",
    });
    if (!isPaused(currentSettings)) {
      setStatus("error", `${question.label}: failed to fetch hint`, {
        errorCount: runtimeState.errorCount,
        queueCount: taskQueue.length + activeRequests,
      });
    }
  } finally {
    delete panel.dataset.loadingKey;

    if (activeRequests === 1 && taskQueue.length === 0) {
      if (isPaused(currentSettings)) {
        setStatus("idle", getPausedMessage(currentSettings), {
          queueCount: 0,
        });
        return;
      }

      const nextPhase = runtimeState.readyCount > 0 ? "ready" : "idle";
      const nextMessage =
        runtimeState.readyCount > 0
          ? `Finished. ${runtimeState.readyCount} hint(s) ready.`
          : "No hints prepared yet.";

      setStatus(nextPhase, nextMessage, {
        queueCount: 0,
      });
    }
  }
}

async function processQuestions() {
  ensureStyles();
  ensureStatusWidget();
  const settings = await loadSettings();

  setStatus("scanning", "Scanning page for quiz prompts...");

  if (isPaused(settings)) {
    setStatus("idle", getPausedMessage(settings), {
      queueCount: activeRequests,
    });
    return;
  }

  const questions = await extractQuestions();
  cleanupPanels(questions);
  runtimeState.questionCount = questions.length;

  if (!questions.length) {
    setStatus("idle", "No quiz prompts found on this page.", {
      questionCount: 0,
      readyCount: 0,
      errorCount: 0,
      queueCount: 0,
    });
    return;
  }

  const panelStats = getPanelStats();
  runtimeState.readyCount = panelStats.readyCount;
  runtimeState.errorCount = panelStats.errorCount;

  setStatus("running", `Found ${questions.length} question(s). Starting...`, {
    questionCount: questions.length,
    readyCount: runtimeState.readyCount,
    errorCount: runtimeState.errorCount,
    queueCount: taskQueue.length + activeRequests,
  });

  let enqueuedCount = 0;

  for (const question of questions) {
    const panel = ensurePanel(question);

    // Left as "manual" on creation because the field already had an answer;
    // never auto-fetch it, only via its own "Generate hint" button.
    if (panel.dataset.state === "manual") {
      continue;
    }

    const loadKey = getRequestCacheKey(question, settings);

    if (
      panel.dataset.loadedKey === loadKey ||
      panel.dataset.loadingKey === loadKey
    ) {
      continue;
    }

    enqueuedCount += 1;
    enqueue(() => hydratePanel(question, panel));
  }

  if (!enqueuedCount && taskQueue.length + activeRequests === 0) {
    const nextPhase =
      runtimeState.errorCount > 0 && runtimeState.readyCount === 0
        ? "error"
        : runtimeState.readyCount > 0
          ? "ready"
          : "idle";

    const nextMessage =
      runtimeState.readyCount > 0
        ? `Finished. ${runtimeState.readyCount} hint(s) ready.`
        : runtimeState.errorCount > 0
          ? "Hints failed to load."
          : "Questions found, but no new work was needed.";

    setStatus(nextPhase, nextMessage, {
      queueCount: 0,
    });
  }
}

function scheduleScan() {
  if (scanScheduled) {
    return;
  }

  if (isPaused(currentSettings)) {
    setStatus("idle", getPausedMessage(currentSettings), {
      queueCount: activeRequests,
    });
    return;
  }

  if (activeRequests > 0 || taskQueue.length > 0) {
    deferredScanRequested = true;
    return;
  }

  scanScheduled = true;
  window.setTimeout(() => {
    scanScheduled = false;
    processQuestions().catch((error) => {
      console.error("Failed to process quiz hints:", error);
      setStatus("error", "Failed to process quiz hints.", {
        queueCount: taskQueue.length + activeRequests,
      });
    });
  }, 250);
}

window.addEventListener("load", scheduleScan);
document.addEventListener("readystatechange", scheduleScan);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  const nextRawSettings = { ...currentSettings };
  let hasRelevantChange = false;

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in changes)) {
      continue;
    }

    nextRawSettings[key] = changes[key].newValue;
    hasRelevantChange = true;
  }

  if (!hasRelevantChange) {
    return;
  }

  const nextSettings = normalizeSettings(nextRawSettings);
  const detailedModeChanged =
    nextSettings.detailedMode !== currentSettings.detailedMode;
  const materialChanged =
    nextSettings.materialMode !== currentSettings.materialMode ||
    nextSettings.materialRevision !== currentSettings.materialRevision;
  const apiModeChanged =
    nextSettings.freeApiMode !== currentSettings.freeApiMode;
  const availabilityChanged =
    nextSettings.enabled !== currentSettings.enabled ||
    nextSettings.pausedUntil !== currentSettings.pausedUntil;

  currentSettings = nextSettings;
  settingsLoaded = true;
  syncStatusWidgetVisibility();

  if (detailedModeChanged || materialChanged || apiModeChanged) {
    answerCache.clear();
    pendingAnswers.clear();
    resetPanelLoadState({ clearLoaded: true });
  }

  if (isPaused(nextSettings)) {
    deferredScanRequested = false;
    clearQueuedTasks();
    resetPanelLoadState();
    markLoadingPanelsPaused(getPausedMessage(nextSettings));
    setStatus("idle", getPausedMessage(nextSettings), {
      queueCount: activeRequests,
    });
    return;
  }

  if (availabilityChanged || detailedModeChanged || materialChanged || apiModeChanged) {
    scheduleScan();
  }
});

const QUESTION_CONTENT_SELECTOR =
  ".que, .qtext, .formulation, .subquestion, .answer, select, textarea";

// Only a node that adds/removes real question content should trigger a rescan.
// This ignores the quiz timer, autosave markers, tooltips, and our own panels,
// which otherwise mutate constantly and cause the same question to be re-solved.
function isQuestionRelevantNode(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  if (
    node.closest(".moodle-hint-anchor") ||
    node.closest(`#${STATUS_WIDGET_ID}`)
  ) {
    return false;
  }

  return (
    node.matches(QUESTION_CONTENT_SELECTOR) ||
    Boolean(node.querySelector?.(QUESTION_CONTENT_SELECTOR))
  );
}

const observer = new MutationObserver((mutations) => {
  const shouldScan = mutations.some((mutation) => {
    if (
      mutation.target instanceof Element &&
      (mutation.target.closest(".moodle-hint-anchor") ||
        mutation.target.closest(`#${STATUS_WIDGET_ID}`))
    ) {
      return false;
    }

    return (
      Array.from(mutation.addedNodes).some(isQuestionRelevantNode) ||
      Array.from(mutation.removedNodes).some(isQuestionRelevantNode)
    );
  });

  if (shouldScan) {
    scheduleScan();
  }
});

if (document.body) {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
} else {
  window.addEventListener(
    "DOMContentLoaded",
    () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      scheduleScan();
    },
    { once: true }
  );
}

scheduleScan();

