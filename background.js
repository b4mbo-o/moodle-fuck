const BASE_URL = "https://capi.voids.top/v2";
const PRIMARY_MODEL_ID = "gemini-2.5-flash-lite";
const FALLBACK_MODEL_IDS = ["gpt-4o-2024-11-20"];
const ENDPOINTS = [
  `${BASE_URL}/chat/completions`,
  `${BASE_URL}/chat`,
  `${BASE_URL}/completions`,
];

const SYSTEM_PROMPT =
  "You solve Moodle quiz questions. " +
  "Never greet, chat casually, mention being an assistant, or ask follow-up questions. " +
  "When the question is in Japanese, answer in Japanese. " +
  "Return only the final answer on one line.";

const INVALID_ANSWER_PATTERNS = [
  /\bhello\b/i,
  /\bhi\b/i,
  /how can i assist/i,
  /how can i help/i,
  /i(?:'| a)m here to help/i,
  /assist you today/i,
  /as an ai/i,
  /please provide/i,
  /^certainly[.!]?$/i,
  /^of course[.!]?$/i,
];

const NUMBER_QUESTION_PATTERN =
  /(?:\u4F55\u500B|\u3044\u304F\u3064|\u4F55\u4EBA|\u4F55\u56DE|\u4F55\u672C|\u4F55\u679A|\u4F55\u6B73|\u4F55\u70B9|\u4F55%|\u4F55\u30D1\u30FC\u30BB\u30F3\u30C8|how many|how much|number of|count)/i;

const answerCache = new Map();

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s"'`.,!?;:()[\]{}<>/\\|_~-]+/g, "");
}

function containsJapanese(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function detectAnswerMode(question, options, targetType = "standard") {
  if (targetType === "symbol") {
    return "symbol";
  }

  if (targetType === "name") {
    return "name";
  }

  if (Array.isArray(options) && options.length) {
    return "choice";
  }

  if (NUMBER_QUESTION_PATTERN.test(question)) {
    return "number";
  }

  return "short";
}

function buildQuizPrompt(question, options, targetType = "standard", compactMode = false) {
  const cleanedOptions = Array.isArray(options)
    ? options.map((option) => normalizeText(option)).filter(Boolean)
    : [];
  const answerMode = detectAnswerMode(question, cleanedOptions, targetType);

  const instructions = [
    "Solve this quiz question.",
    "Do not greet.",
    "Do not explain your role.",
    "Return only one line.",
    "Do not add explanations or reasons.",
  ];

  if (containsJapanese(question)) {
    instructions.push("The answer must be in Japanese.");
  }

  if (answerMode === "choice") {
    instructions.push("Choose exactly one answer from the list.");
    instructions.push("Copy the chosen option text exactly.");
  } else if (answerMode === "symbol") {
    instructions.push("Return only the requested symbol.");
    instructions.push("Use only the symbol itself, such as f, p, n, u, m, c, d, da, h, k, M, G, T, P.");
  } else if (answerMode === "name") {
    instructions.push("Return only the requested name.");
    instructions.push("If the question asks for katakana, use katakana only.");
  } else if (answerMode === "number") {
    instructions.push("The answer should be a number.");
    instructions.push("Output digits only.");
  } else {
    instructions.push("Output only the short final answer.");
  }

  if (compactMode) {
    instructions.push("Keep the answer as short as possible.");
  }

  const optionsBlock = cleanedOptions.length
    ? cleanedOptions.join("\n")
    : "No options provided.";

  return [
    ...instructions,
    "",
    `Question: ${question}`,
    "Choices:",
    optionsBlock,
  ].join("\n");
}

function buildRequestPlans(question, options, targetType = "standard") {
  const answerMode = detectAnswerMode(question, options, targetType);
  const maxTokens = answerMode === "short" ? 24 : 12;

  return [
    {
      model: PRIMARY_MODEL_ID,
      prompt: buildQuizPrompt(question, options, targetType, false),
      maxTokens,
    },
    {
      model: PRIMARY_MODEL_ID,
      prompt: buildQuizPrompt(question, options, targetType, true),
      maxTokens,
    },
    ...FALLBACK_MODEL_IDS.map((model) => ({
      model,
      prompt: buildQuizPrompt(question, options, targetType, true),
      maxTokens,
    })),
  ];
}

async function readJsonResponse(response) {
  const raw = await response.text();
  let data = {};

  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON response: ${raw.slice(0, 200)}`);
    }
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `HTTP ${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return data;
}

function extractAnswer(data) {
  if (data?.choices?.length) {
    const firstChoice = data.choices[0];
    const content = firstChoice?.message?.content;

    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }

          if (item?.type === "text" && typeof item.text === "string") {
            return item.text;
          }

          return "";
        })
        .join("")
        .trim();

      if (text) {
        return text;
      }
    }

    if (typeof firstChoice?.text === "string" && firstChoice.text.trim()) {
      return firstChoice.text.trim();
    }
  }

  for (const key of ["content", "text", "output", "response", "result"]) {
    if (typeof data?.[key] === "string" && data[key].trim()) {
      return data[key].trim();
    }
  }

  return "";
}

function extractFirstLine(answer) {
  return String(answer || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function findMatchingOption(answer, options) {
  if (!Array.isArray(options) || !options.length) {
    return "";
  }

  const haystacks = [
    compactText(answer),
    compactText(extractFirstLine(answer)),
  ].filter(Boolean);

  return (
    options.find((option) => {
      const normalizedOption = compactText(option);
      return haystacks.some(
        (haystack) =>
          haystack === normalizedOption ||
          haystack.includes(normalizedOption) ||
          normalizedOption.includes(haystack)
      );
    }) || ""
  );
}

function sanitizeAnswer(answer, question, options, targetType = "standard") {
  const answerMode = detectAnswerMode(question, options, targetType);
  const rawAnswer = normalizeText(answer);
  const firstLine = extractFirstLine(rawAnswer).replace(
    /^(答え|回答|answer)\s*[:：]\s*/i,
    ""
  );

  if (!firstLine) {
    return "";
  }

  if (answerMode === "choice") {
    const matchedOption = findMatchingOption(rawAnswer, options);
    return matchedOption || firstLine;
  }

  if (answerMode === "symbol") {
    const symbolMatch =
      firstLine.match(/[A-Za-z\u00B5\u03BC]{1,3}/) ||
      rawAnswer.match(/[A-Za-z\u00B5\u03BC]{1,3}/);
    return symbolMatch ? symbolMatch[0] : firstLine;
  }

  if (answerMode === "name") {
    const katakanaMatch =
      firstLine.match(/[\u30A0-\u30FFー]+/) ||
      rawAnswer.match(/[\u30A0-\u30FFー]+/);
    return katakanaMatch ? katakanaMatch[0] : firstLine;
  }

  if (answerMode === "number") {
    const numericMatch = rawAnswer.match(/-?\d+(?:\.\d+)?/);
    return numericMatch ? numericMatch[0] : "";
  }

  return firstLine;
}

function isLikelyInvalidAnswer(answer, question, options, targetType = "standard") {
  const sanitized = sanitizeAnswer(answer, question, options, targetType);
  const firstLine = extractFirstLine(sanitized);
  if (!firstLine) {
    return true;
  }

  if (INVALID_ANSWER_PATTERNS.some((pattern) => pattern.test(sanitized))) {
    return true;
  }

  if (/^(the question asks|this question asks|the answer is)\b/i.test(firstLine)) {
    return true;
  }

  const answerMode = detectAnswerMode(question, options, targetType);

  if (answerMode === "choice") {
    return !findMatchingOption(firstLine, options);
  }

  if (answerMode === "symbol") {
    return !/^[A-Za-z\u00B5\u03BC]{1,3}$/.test(firstLine);
  }

  if (answerMode === "name") {
    return !/[\u30A0-\u30FFー]/.test(firstLine);
  }

  if (answerMode === "number") {
    return !/^-?\d+(?:\.\d+)?$/.test(firstLine);
  }

  if (
    containsJapanese(question) &&
    !containsJapanese(firstLine) &&
    /[A-Za-z]{2,}/.test(firstLine) &&
    !(Array.isArray(options) && options.length)
  ) {
    return true;
  }

  return false;
}

async function requestChatCompletion(model, prompt, maxTokens) {
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: maxTokens,
  };

  let lastError = null;

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await readJsonResponse(response);
      const answer = extractAnswer(data);
      if (answer) {
        return answer;
      }
    } catch (error) {
      lastError = error;
      console.warn(`capi request failed for ${endpoint}:`, error);
    }
  }

  throw new Error(lastError?.message || "Failed to get a response from capi.");
}

async function callCapiChat(question, options, requestKey = "", targetType = "standard") {
  const cleanedQuestion = normalizeText(question);
  const cleanedOptions = Array.isArray(options)
    ? options.map((option) => normalizeText(option)).filter(Boolean)
    : [];
  const cacheKey = JSON.stringify({
    requestKey: requestKey || cleanedQuestion,
    options: cleanedOptions,
    targetType,
  });

  if (answerCache.has(cacheKey)) {
    return answerCache.get(cacheKey);
  }

  let lastInvalidAnswer = "";
  let lastError = null;

  for (const plan of buildRequestPlans(cleanedQuestion, cleanedOptions, targetType)) {
    try {
      const rawAnswer = await requestChatCompletion(
        plan.model,
        plan.prompt,
        plan.maxTokens
      );
      const sanitizedAnswer = sanitizeAnswer(
        rawAnswer,
        cleanedQuestion,
        cleanedOptions,
        targetType
      );

      if (
        isLikelyInvalidAnswer(
          sanitizedAnswer,
          cleanedQuestion,
          cleanedOptions,
          targetType
        )
      ) {
        lastInvalidAnswer = rawAnswer;
        console.warn("Rejected invalid answer:", {
          model: plan.model,
          answer: rawAnswer,
        });
        continue;
      }

      answerCache.set(cacheKey, sanitizedAnswer);
      return sanitizedAnswer;
    } catch (error) {
      lastError = error;
      console.warn(`capi request failed for model ${plan.model}:`, error);
    }
  }

  if (lastInvalidAnswer) {
    throw new Error(`Invalid answer from API: ${extractFirstLine(lastInvalidAnswer)}`);
  }

  throw new Error(lastError?.message || "Failed to get a valid response from capi.");
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "getAnswer") {
    return false;
  }

  const { question, options, requestKey, targetType, fieldLabel } = request;
  console.log("Received from content:", question, options, targetType, fieldLabel);

  callCapiChat(question, options, requestKey, targetType)
    .then((answer) => {
      console.log("Parsed answer:", answer);
      sendResponse({ answer });
    })
    .catch((error) => {
      console.error("Error calling capi:", error);
      sendResponse({ answer: "Error fetching answer." });
    });

  return true;
});
