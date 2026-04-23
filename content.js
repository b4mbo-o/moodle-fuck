const HINT_STYLE_ID = "moodle-hint-style";
const HINT_PANEL_CLASS = "moodle-hint-panel";
const STATUS_WIDGET_ID = "moodle-hint-status-widget";
const PRIMARY_QUESTION_SELECTOR = ".que";
const FALLBACK_QUESTION_SELECTOR = "[id^='question-']";
const SUBQUESTION_SELECTOR = ".subquestion";
const MAX_CONCURRENT_REQUESTS = 2;

const answerCache = new Map();
const pendingAnswers = new Map();
const taskQueue = [];

let activeRequests = 0;
let scanScheduled = false;

const runtimeState = {
  phase: "booting",
  message: "Starting...",
  questionCount: 0,
  readyCount: 0,
  errorCount: 0,
  queueCount: 0,
};

function normalizeText(value) {
  return (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderNodeText(node, options = {}) {
  const { blankToken = " [blank] " } = options;

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
    element.matches(".accesshide, script, style, label.subq") ||
    element.matches(".moodle-hint-anchor") ||
    element.matches(`#${STATUS_WIDGET_ID}`)
  ) {
    return "";
  }

  if (
    element.matches(SUBQUESTION_SELECTOR) ||
    element.matches("input, textarea, select")
  ) {
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

function buildQuestionKey(questionText, options, uniqueId = "") {
  return JSON.stringify({
    questionText,
    options,
    uniqueId,
  });
}

function ensureStatusWidget() {
  let widget = document.getElementById(STATUS_WIDGET_ID);
  if (widget) {
    return widget;
  }

  widget = document.createElement("aside");
  widget.id = STATUS_WIDGET_ID;
  widget.dataset.phase = "booting";
  widget.innerHTML = `
    <div class="moodle-status-title">
      <span>Moodle Hint</span>
      <span class="moodle-status-pill">Booting</span>
    </div>
    <div class="moodle-status-message">Content script started.</div>
    <div class="moodle-status-meta">Waiting for page scan...</div>
  `;

  (document.body || document.documentElement).appendChild(widget);
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

function extractPromptContext(questionRoot, promptContainer) {
  const formulation =
    questionRoot.matches(".formulation")
      ? questionRoot
      : questionRoot.querySelector(".formulation");

  if (!formulation || !promptContainer) {
    return "";
  }

  const contextParts = [];
  for (const child of Array.from(formulation.children)) {
    if (child === promptContainer) {
      break;
    }

    if (
      child.matches?.(".moodle-hint-anchor") ||
      child.matches?.(`#${STATUS_WIDGET_ID}`)
    ) {
      continue;
    }

    if (child.querySelector?.(SUBQUESTION_SELECTOR)) {
      continue;
    }

    const text = normalizeText(renderNodeText(child));
    if (text) {
      contextParts.push(text);
    }
  }

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

function inferSubquestionFieldInfo(promptContainer, subquestion, index) {
  const { before, after } = extractTextAroundSubquestion(promptContainer, subquestion);
  const normalizedBefore = before.replace(/\s+/g, "");
  const normalizedAfter = after.replace(/\s+/g, "");
  const symbolIndex = normalizedBefore.lastIndexOf("記号");
  const nameIndex = normalizedBefore.lastIndexOf("名称");

  if (symbolIndex > nameIndex) {
    return { type: "symbol", label: "記号" };
  }

  if (nameIndex > symbolIndex) {
    return { type: "name", label: "名称" };
  }

  if (normalizedAfter.startsWith("名称")) {
    return { type: "symbol", label: "記号" };
  }

  if (normalizedAfter.startsWith("記号")) {
    return { type: "symbol", label: "記号" };
  }

  return {
    type: "blank",
    label: `Blank ${index}`,
  };
}

function buildSubquestionText(questionRoot, promptContainer) {
  const contextText = extractPromptContext(questionRoot, promptContainer);
  const promptText = normalizeText(renderNodeText(promptContainer));

  return [contextText, promptText].filter(Boolean).join("\n");
}

function getSubquestionLabel(questionRoot, promptText, index, fieldInfo) {
  const matchedPromptLabel = promptText.match(/(?:問題|Question)\s*([0-9０-９]+)/u);
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

  return Array.from(document.querySelectorAll(SUBQUESTION_SELECTOR))
    .map((subquestion) => {
      const questionRoot = getOwningQuestionRoot(subquestion);
      if (!questionRoot) {
        return null;
      }

      const nextIndex = (countsByRoot.get(questionRoot) || 0) + 1;
      countsByRoot.set(questionRoot, nextIndex);

      const promptContainer = getPromptContainer(subquestion);
      const fieldInfo = inferSubquestionFieldInfo(
        promptContainer,
        subquestion,
        nextIndex
      );
      const questionText = buildSubquestionText(questionRoot, promptContainer);
      if (!questionText) {
        return null;
      }

      const inputElement = subquestion.querySelector("input, textarea, select");
      const uniqueId =
        inputElement?.id ||
        inputElement?.name ||
        `${getQuestionLabel(questionRoot)}-${nextIndex}`;
      const options = extractSubquestionOptions(subquestion);

      return {
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
      };
    })
    .filter(Boolean);
}

function extractQuestions() {
  const standardQuestions = getQuestionRoots()
    .map((questionRoot) => {
      if (questionRoot.querySelector(SUBQUESTION_SELECTOR)) {
        return null;
      }

      const questionText = extractQuestionText(questionRoot);
      if (!questionText) {
        return null;
      }

      const options = extractOptions(questionRoot);
      return {
        key: buildQuestionKey(questionText, options, questionRoot.id || ""),
        label: getQuestionLabel(questionRoot),
        questionRoot,
        questionText,
        options,
        targetType: "standard",
        requestKey: questionRoot.id || questionText,
        anchorElement:
          questionRoot.querySelector(".formulation") ||
          questionRoot.querySelector(".content") ||
          questionRoot,
      };
    })
    .filter(Boolean);

  const subquestions = extractSubquestions();
  return [...standardQuestions, ...subquestions];
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

  const panel = document.createElement("aside");
  panel.className = HINT_PANEL_CLASS;
  panel.dataset.state = "loading";
  panel.dataset.questionKey = question.key;
  panel.innerHTML = `
    <div class="moodle-hint-header">
      <div class="moodle-hint-title">${question.label} Hint</div>
      <div class="moodle-hint-status">Loading...</div>
    </div>
    <div class="moodle-hint-answer">Generating hint...</div>
    <div class="moodle-hint-reason"></div>
    <div class="moodle-hint-meta"></div>
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

function parseAnswerText(answerText) {
  const answer = String(answerText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!answer) {
    return {
      answer: "No hint available.",
      reason: "",
    };
  }

  return {
    answer,
    reason: "",
  };
}

function requestAnswer(question) {
  const cacheKey = question.key;

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
        requestKey: question.requestKey || question.key,
        targetType: question.targetType || "standard",
        fieldLabel: question.fieldLabel || "",
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        const answer = normalizeText(response?.answer || "");
        if (!answer || /^error fetching answer\.?$/i.test(answer)) {
          reject(new Error("No answer found."));
          return;
        }

        answerCache.set(cacheKey, answer);
        resolve(answer);
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
          setStatus("running", "Preparing hints...", {
            queueCount: taskQueue.length + activeRequests,
          });
        }
        runQueue();
      });
  }
}

async function hydratePanel(question, panel) {
  if (
    panel.dataset.loadedKey === question.key ||
    panel.dataset.loadingKey === question.key
  ) {
    return;
  }

  try {
    panel.dataset.loadingKey = question.key;
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

    const answerText = await requestAnswer(question);
    const parsed = parseAnswerText(answerText);

    panel.dataset.loadedKey = question.key;
    runtimeState.readyCount += 1;
    updatePanel(panel, {
      state: "ready",
      status: "Ready",
      answer: parsed.answer,
      reason: "",
      meta: "",
    });
    setStatus("running", `${question.label}: hint ready`, {
      readyCount: runtimeState.readyCount,
      queueCount: taskQueue.length + activeRequests,
    });
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
    setStatus("error", `${question.label}: failed to fetch hint`, {
      errorCount: runtimeState.errorCount,
      queueCount: taskQueue.length + activeRequests,
    });
  } finally {
    delete panel.dataset.loadingKey;

    if (activeRequests === 1 && taskQueue.length === 0) {
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

function processQuestions() {
  ensureStyles();
  ensureStatusWidget();

  setStatus("scanning", "Scanning page for quiz prompts...");

  const questions = extractQuestions();
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

    if (
      panel.dataset.loadedKey === question.key ||
      panel.dataset.loadingKey === question.key
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

  setStatus("scanning", "Scan scheduled...");
  scanScheduled = true;
  window.setTimeout(() => {
    scanScheduled = false;
    processQuestions();
  }, 250);
}

window.addEventListener("load", scheduleScan);
document.addEventListener("readystatechange", scheduleScan);

const observer = new MutationObserver((mutations) => {
  const shouldScan = mutations.some((mutation) => {
    if (!(mutation.target instanceof Element)) {
      return true;
    }

    if (
      mutation.target.closest(".moodle-hint-anchor") ||
      mutation.target.closest(`#${STATUS_WIDGET_ID}`)
    ) {
      return false;
    }

    const relevantAddedNode = Array.from(mutation.addedNodes).some((node) => {
      return (
        !(node instanceof Element) ||
        (!node.closest(".moodle-hint-anchor") &&
          !node.closest(`#${STATUS_WIDGET_ID}`))
      );
    });

    const relevantRemovedNode = Array.from(mutation.removedNodes).some((node) => {
      return (
        !(node instanceof Element) ||
        (!node.closest(".moodle-hint-anchor") &&
          !node.closest(`#${STATUS_WIDGET_ID}`))
      );
    });

    return relevantAddedNode || relevantRemovedNode;
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
