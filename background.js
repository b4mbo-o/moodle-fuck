const PROVIDER_OPENAI = "openai";
const PROVIDER_OPENROUTER = "openrouter";
const PROVIDER_GEMINI = "gemini";
const PROVIDER_CAPI = "capi";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const GEMINI_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CAPI_BASE_URL = "https://capi.voids.top/v2";
const CAPI_ENDPOINTS = [
  `${CAPI_BASE_URL}/chat/completions`,
  `${CAPI_BASE_URL}/chat`,
  `${CAPI_BASE_URL}/completions`,
];
const OPENROUTER_APP_URL = "https://openrouter.ai";
const OPENROUTER_APP_TITLE = "MoodleFuck";

const OPENAI_STANDARD_MODEL_IDS = ["gpt-5-mini", "gpt-4.1-mini", "gpt-4.1"];
const OPENAI_MATERIAL_ACCURACY_MODEL_IDS = [
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
];

const OPENROUTER_STANDARD_MODEL_IDS = [
  "openrouter/free",
  "meta-llama/llama-3.2-3b-instruct:free",
];
const OPENROUTER_MATERIAL_ACCURACY_MODEL_IDS = [
  "openrouter/free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "meta-llama/llama-3.2-3b-instruct:free",
];
const GEMINI_STANDARD_MODEL_IDS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
const GEMINI_MATERIAL_ACCURACY_MODEL_IDS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];
const CAPI_STANDARD_MODEL_IDS = ["gpt-4o-2024-11-20", "gpt-4o", "gpt-4.1"];
const CAPI_MATERIAL_ACCURACY_MODEL_IDS = [
  "gpt-4o-2024-11-20",
  "gpt-4.1",
  "gemini-2.5-flash",
];
const DEFAULT_PROVIDER_ORDER = [PROVIDER_OPENAI];
const MATERIAL_CONTEXT_MAX_CHARS = 120000;
const MATERIAL_REFERENCE_MAX_CHARS = 9000;
const MATERIAL_CHUNK_MAX_CHARS = 1400;
const MATERIAL_TOP_CHUNKS = 4;
const MATERIAL_MAX_TERMS = 40;
const REQUEST_MAX_ATTEMPTS = 4;
const REQUEST_MAX_BACKOFF_MS = 15000;
const MATERIAL_DEFAULTS = {
  materialMode: false,
  materialContext: "",
  materialSources: [],
  materialRevision: 0,
  apiProviders: DEFAULT_PROVIDER_ORDER,
  openaiApiKey: "",
  openrouterApiKey: "",
  geminiApiKey: "",
  apiKey: "",
};

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
  /(?:\u4F55\u500B|\u3044\u304F\u3064|\u4F55\u4EBA|\u4F55\u56DE|\u4F55\u672C|\u4F55\u679A|\u4F55\u6B73|\u4F55\u70B9|\u4F55%|\u4F55\u30D1\u30FC\u30BB\u30F3\u30C8|\u4F55\u4E57|\u6307\u6570|\[blank\]\s*\u4E57|\u4E57\u3067\u3042\u308B|how many|how much|number of|count|exponent|power)/i;

const answerCache = new Map();

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMaterialContext(value) {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s"'`.,!?;:()[\]{}<>/\\|_~-]+/g, "");
}

function containsJapanese(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function parseRetryAfterMs(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return 0;
  }

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  const epochMs = Date.parse(raw);
  if (!Number.isNaN(epochMs)) {
    return Math.max(0, epochMs - Date.now());
  }

  return 0;
}

function createHttpError(message, options = {}) {
  const error = new Error(message);
  error.status = Number(options.status) || 0;
  error.isRateLimit = Boolean(options.isRateLimit);
  error.isAuthError = Boolean(options.isAuthError);
  error.retryAfterMs = Number(options.retryAfterMs) || 0;
  return error;
}

function isRateLimitText(text) {
  return /rate[\s-]?limit|too many requests/i.test(normalizeText(text));
}

function isInvalidApiKeyText(text) {
  return /invalid\s*api\s*key|invalid\s*apikey|api\s*key\s*not\s*valid|unauthorized|forbidden|no\s*auth\s*credentials/i.test(
    normalizeText(text)
  );
}

function isRetryableError(error) {
  if (!error) {
    return false;
  }

  if (error.isRateLimit) {
    return true;
  }

  if (error.status === 429) {
    return true;
  }

  if (error.status >= 500) {
    return true;
  }

  const message = normalizeText(error.message).toLowerCase();
  return /timeout|network|fetch failed|temporar|connection reset|econnreset|eai_again/i.test(
    message
  );
}

function getRetryDelayMs(error, attemptIndex) {
  const retryAfterMs = Number(error?.retryAfterMs) || 0;
  if (retryAfterMs > 0) {
    return Math.min(retryAfterMs, REQUEST_MAX_BACKOFF_MS);
  }

  const baseMs = error?.isRateLimit ? 1200 : 700;
  const exponentialMs = baseMs * Math.pow(2, Math.max(0, attemptIndex));
  const jitterMs = Math.floor(Math.random() * 250);
  return Math.min(exponentialMs + jitterMs, REQUEST_MAX_BACKOFF_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function buildRequestHeaders(providerId, credentials) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (providerId === PROVIDER_CAPI) {
    return headers;
  }

  if (providerId === PROVIDER_GEMINI) {
    const geminiApiKey = normalizeText(credentials?.geminiApiKey).replace(
      /^Bearer\s+/i,
      ""
    );
    if (geminiApiKey) {
      headers["x-goog-api-key"] = geminiApiKey;
    }
    return headers;
  }

  const rawKey =
    providerId === PROVIDER_OPENROUTER
      ? normalizeText(credentials?.openrouterApiKey)
      : normalizeText(credentials?.openaiApiKey);

  if (!rawKey) {
    return headers;
  }

  const hasBearerPrefix = /^Bearer\s+/i.test(rawKey);
  headers.Authorization = hasBearerPrefix ? rawKey : `Bearer ${rawKey}`;

  if (providerId === PROVIDER_OPENROUTER) {
    headers["HTTP-Referer"] = OPENROUTER_APP_URL;
    headers["X-OpenRouter-Title"] = OPENROUTER_APP_TITLE;
  }

  return headers;
}

function normalizeMaterialSources(sources) {
  if (!Array.isArray(sources)) {
    return [];
  }

  return sources
    .map((source) => ({
      name: normalizeText(source?.name || "").slice(0, 120),
      kind: normalizeText(source?.kind || "").toLowerCase().slice(0, 40),
      chars: Number(source?.chars) || 0,
    }))
    .filter((source) => source.name && source.chars > 0);
}

function normalizeProviderOrder(providers) {
  const rawProviders = Array.isArray(providers) ? providers : [];
  const allowed = new Set([
    PROVIDER_OPENAI,
    PROVIDER_OPENROUTER,
    PROVIDER_GEMINI,
    PROVIDER_CAPI,
  ]);
  const seen = new Set();
  const normalized = [];

  for (const provider of rawProviders) {
    const cleaned = normalizeText(provider).toLowerCase();
    if (!allowed.has(cleaned) || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    normalized.push(cleaned);
  }

  if (!normalized.length) {
    return [...DEFAULT_PROVIDER_ORDER];
  }

  return normalized;
}

function dedupeModels(modelIds) {
  const seen = new Set();
  const models = [];

  for (const modelId of modelIds) {
    const cleaned = normalizeText(modelId);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    models.push(cleaned);
  }

  return models;
}

function getModelChain(providerId, useAccuracyProfile = false) {
  if (providerId === PROVIDER_OPENROUTER) {
    return useAccuracyProfile
      ? dedupeModels(OPENROUTER_MATERIAL_ACCURACY_MODEL_IDS)
      : dedupeModels(OPENROUTER_STANDARD_MODEL_IDS);
  }

  if (providerId === PROVIDER_CAPI) {
    return useAccuracyProfile
      ? dedupeModels(CAPI_MATERIAL_ACCURACY_MODEL_IDS)
      : dedupeModels(CAPI_STANDARD_MODEL_IDS);
  }

  if (providerId === PROVIDER_GEMINI) {
    return useAccuracyProfile
      ? dedupeModels(GEMINI_MATERIAL_ACCURACY_MODEL_IDS)
      : dedupeModels(GEMINI_STANDARD_MODEL_IDS);
  }

  return useAccuracyProfile
    ? dedupeModels(OPENAI_MATERIAL_ACCURACY_MODEL_IDS)
    : dedupeModels(OPENAI_STANDARD_MODEL_IDS);
}

function buildProviderModelPlans(providerOrder, useAccuracyProfile = false) {
  const plans = [];

  for (const providerId of normalizeProviderOrder(providerOrder)) {
    const models = getModelChain(providerId, useAccuracyProfile);
    for (const model of models) {
      plans.push({ providerId, model });
    }
  }

  return plans;
}

function filterProvidersByCredentials(providerOrder, credentials) {
  const available = [];
  const normalizedProviders = normalizeProviderOrder(providerOrder);

  for (const providerId of normalizedProviders) {
    if (providerId === PROVIDER_CAPI) {
      available.push(providerId);
      continue;
    }

    if (
      providerId === PROVIDER_OPENAI &&
      normalizeText(credentials?.openaiApiKey)
    ) {
      available.push(providerId);
      continue;
    }

    if (
      providerId === PROVIDER_OPENROUTER &&
      normalizeText(credentials?.openrouterApiKey)
    ) {
      available.push(providerId);
      continue;
    }

    if (
      providerId === PROVIDER_GEMINI &&
      normalizeText(credentials?.geminiApiKey)
    ) {
      available.push(providerId);
    }
  }

  return available;
}

function uniqueTerms(terms) {
  return Array.from(new Set(terms.filter(Boolean)));
}

function tokenizeMaterialSearchTerms(question, options = []) {
  const combined = [question, ...(Array.isArray(options) ? options : [])]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");

  const lower = combined.toLowerCase();
  const latinTerms = lower.match(/[a-z0-9][a-z0-9+._%-]{1,}/g) || [];
  const numberTerms = lower.match(/-?\d+(?:\.\d+)?/g) || [];
  const japaneseOnly = lower.replace(/[^\u3040-\u30ff\u3400-\u9fff]/g, "");
  const jpBigrams = [];

  for (let index = 0; index < japaneseOnly.length - 1; index += 1) {
    jpBigrams.push(japaneseOnly.slice(index, index + 2));
    if (jpBigrams.length >= 20) {
      break;
    }
  }

  return uniqueTerms([...latinTerms, ...numberTerms, ...jpBigrams]).slice(
    0,
    MATERIAL_MAX_TERMS
  );
}

function splitMaterialIntoChunks(materialContext) {
  const cleaned = normalizeMaterialContext(materialContext);
  if (!cleaned) {
    return [];
  }

  const sourceBlocks = cleaned
    .split(/\n(?=## Source:\s*)/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks = [];

  for (const block of sourceBlocks) {
    const lines = block.split(/\r?\n/);
    const sourceLine = normalizeText(lines[0] || "");
    const sourceName = sourceLine.startsWith("## Source:")
      ? normalizeText(sourceLine.replace(/^## Source:\s*/i, "")) || "Material"
      : "Material";
    const bodyText = normalizeText(
      sourceLine.startsWith("## Source:")
        ? lines.slice(1).join("\n")
        : lines.join("\n")
    );

    if (!bodyText) {
      continue;
    }

    const paragraphs = bodyText
      .split(/\n{2,}/)
      .map((paragraph) => normalizeText(paragraph))
      .filter(Boolean);
    let currentChunk = "";

    const flushChunk = () => {
      const text = normalizeText(currentChunk);
      if (text) {
        chunks.push({
          source: sourceName,
          text,
        });
      }
      currentChunk = "";
    };

    const appendParagraph = (paragraph) => {
      if (!paragraph) {
        return;
      }

      if (!currentChunk) {
        currentChunk = paragraph;
        return;
      }

      if (currentChunk.length + 2 + paragraph.length <= MATERIAL_CHUNK_MAX_CHARS) {
        currentChunk += `\n\n${paragraph}`;
        return;
      }

      flushChunk();
      currentChunk = paragraph;
    };

    for (const paragraph of paragraphs.length ? paragraphs : [bodyText]) {
      if (paragraph.length <= MATERIAL_CHUNK_MAX_CHARS) {
        appendParagraph(paragraph);
        continue;
      }

      let start = 0;
      while (start < paragraph.length) {
        const slice = paragraph.slice(start, start + MATERIAL_CHUNK_MAX_CHARS);
        appendParagraph(slice);
        start += MATERIAL_CHUNK_MAX_CHARS;
      }
    }

    flushChunk();
  }

  return chunks;
}

function scoreMaterialChunk(chunkText, terms) {
  if (!chunkText || !Array.isArray(terms) || !terms.length) {
    return 0;
  }

  const haystack = chunkText.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (!term) {
      continue;
    }

    if (haystack.includes(term)) {
      score += term.length >= 4 ? 3 : 1;
    }
  }

  return score;
}

function buildMaterialReference(question, options, materialContext) {
  const chunks = splitMaterialIntoChunks(materialContext);
  if (!chunks.length) {
    return "";
  }

  const terms = tokenizeMaterialSearchTerms(question, options);
  const rankedChunks = chunks
    .map((chunk, index) => ({
      ...chunk,
      index,
      score: scoreMaterialChunk(chunk.text, terms),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });

  const selected = [];
  for (const candidate of rankedChunks) {
    if (selected.length >= MATERIAL_TOP_CHUNKS) {
      break;
    }

    if (candidate.score > 0 || selected.length === 0) {
      selected.push(candidate);
    }
  }

  if (!selected.length) {
    return "";
  }

  const lines = [];
  let usedChars = 0;

  for (const chunk of selected) {
    const header = `Source: ${chunk.source}`;
    const body = normalizeText(chunk.text);
    const section = `${header}\n${body}`;
    const remaining = MATERIAL_REFERENCE_MAX_CHARS - usedChars;
    if (remaining <= 0) {
      break;
    }

    const clipped = section.slice(0, remaining);
    lines.push(clipped);
    usedChars += clipped.length + 2;
  }

  return lines.join("\n\n");
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

function buildQuizPrompt(
  question,
  options,
  targetType = "standard",
  compactMode = false,
  detailedMode = false,
  materialContext = ""
) {
  const cleanedOptions = Array.isArray(options)
    ? options.map((option) => normalizeText(option)).filter(Boolean)
    : [];
  const answerMode = detectAnswerMode(question, cleanedOptions, targetType);
  const relevantMaterialReference = buildMaterialReference(
    question,
    cleanedOptions,
    materialContext
  );

  const instructions = [
    "Solve this quiz question.",
    "Do not greet.",
    "Do not explain your role.",
    "Return only one line.",
    "Do not add explanations or reasons.",
  ];

  if (question.includes("[blank]")) {
    instructions.push("The text contains one [blank] marker.");
    instructions.push("Return only the exact content that should replace [blank].");
    instructions.push("Do not rewrite the whole sentence or expression.");
  }

  if (detailedMode) {
    instructions.push("Think carefully before answering, but keep the output to the final answer only.");
  }

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

  const sections = [
    ...instructions,
  ];

  if (relevantMaterialReference) {
    sections.push(
      "",
      "Reference material is provided below.",
      "Prioritize this material over general memory when answering.",
      "",
      "Reference Material:",
      relevantMaterialReference
    );
  }

  return [
    ...sections,
    "",
    `Question: ${question}`,
    "Choices:",
    optionsBlock,
  ].join("\n");
}

function buildRequestPlans(
  question,
  options,
  targetType = "standard",
  detailedMode = false,
  materialContext = "",
  useAccuracyProfile = false,
  providerOrder = DEFAULT_PROVIDER_ORDER
) {
  const answerMode = detectAnswerMode(question, options, targetType);
  const hasMaterial = Boolean(normalizeMaterialContext(materialContext));
  const effectiveDetailedMode = detailedMode || useAccuracyProfile;

  const maxTokens = useAccuracyProfile
    ? answerMode === "short"
      ? 120
      : 64
    : effectiveDetailedMode
      ? answerMode === "short"
        ? hasMaterial
          ? 64
          : 40
        : hasMaterial
          ? 32
          : 20
      : answerMode === "short"
        ? hasMaterial
          ? 48
          : 24
        : hasMaterial
          ? 24
          : 12;
  const safeMaxTokens = Math.max(16, maxTokens);

  const providerModelPlans = buildProviderModelPlans(
    providerOrder,
    useAccuracyProfile
  );
  if (!providerModelPlans.length) {
    return [];
  }

  const [primaryPlan, ...fallbackPlans] = providerModelPlans;
  return [
    {
      providerId: primaryPlan.providerId,
      model: primaryPlan.model,
      prompt: buildQuizPrompt(
        question,
        options,
        targetType,
        false,
        effectiveDetailedMode,
        materialContext
      ),
      maxTokens: safeMaxTokens,
    },
    {
      providerId: primaryPlan.providerId,
      model: primaryPlan.model,
      prompt: buildQuizPrompt(
        question,
        options,
        targetType,
        true,
        effectiveDetailedMode,
        materialContext
      ),
      maxTokens: safeMaxTokens,
    },
    ...fallbackPlans.map((plan) => ({
      providerId: plan.providerId,
      model: plan.model,
      prompt: buildQuizPrompt(
        question,
        options,
        targetType,
        true,
        effectiveDetailedMode,
        materialContext
      ),
      maxTokens: safeMaxTokens,
    })),
  ];
}

function loadMaterialState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(MATERIAL_DEFAULTS, (items) => {
      const materialMode = Boolean(items.materialMode);
      const materialRevision = Number(items.materialRevision) || 0;
      const materialSources = normalizeMaterialSources(items.materialSources);
      const legacyApiKey = normalizeText(items.apiKey);
      const openaiApiKey = normalizeText(items.openaiApiKey || legacyApiKey);
      const openrouterApiKey = normalizeText(items.openrouterApiKey);
      const geminiApiKey = normalizeText(items.geminiApiKey);
      const apiProviders = normalizeProviderOrder(items.apiProviders);
      const materialContext = materialMode
        ? normalizeMaterialContext(items.materialContext).slice(
            0,
            MATERIAL_CONTEXT_MAX_CHARS
          )
        : "";
      const hasPdfSource = materialSources.some(
        (source) => source.kind === "pdf"
      );

      resolve({
        materialMode,
        materialRevision,
        materialContext,
        materialSources,
        hasPdfSource,
        apiProviders,
        openaiApiKey,
        openrouterApiKey,
        geminiApiKey,
      });
    });
  });
}

async function readJsonResponse(response) {
  const raw = await response.text();
  const rawTrimmed = raw.trim();
  const contentType = normalizeText(response.headers.get("content-type"));
  let data = {};

  if (rawTrimmed) {
    const looksJson =
      contentType.includes("application/json") ||
      rawTrimmed.startsWith("{") ||
      rawTrimmed.startsWith("[");

    if (looksJson) {
      try {
        data = JSON.parse(rawTrimmed);
      } catch (error) {
        if (!response.ok) {
          const isRateLimited =
            response.status === 429 || isRateLimitText(rawTrimmed);
          const isAuthError =
            response.status === 401 ||
            response.status === 403 ||
            isInvalidApiKeyText(rawTrimmed);
          throw createHttpError(
            isRateLimited
              ? `Rate limit (${response.status || 429})`
              : isAuthError
                ? "Invalid API key. Set a valid API key in the extension popup."
                : `Invalid JSON response: ${rawTrimmed.slice(0, 200)}`,
            {
              status: response.status,
              isRateLimit: isRateLimited,
              isAuthError,
              retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
            }
          );
        }

        throw new Error(`Invalid JSON response: ${rawTrimmed.slice(0, 200)}`);
      }
    }
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      rawTrimmed ||
      `HTTP ${response.status} ${response.statusText}`;
    const isRateLimited =
      response.status === 429 || isRateLimitText(message);
    const isAuthError =
      response.status === 401 ||
      response.status === 403 ||
      isInvalidApiKeyText(message);
    throw createHttpError(
      isRateLimited
        ? `Rate limit (${response.status || 429})`
        : isAuthError
          ? "Invalid API key. Set a valid API key in the extension popup."
          : message,
      {
        status: response.status,
        isRateLimit: isRateLimited,
        isAuthError,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      }
    );
  }

  if (!Object.keys(data).length && rawTrimmed) {
    if (isRateLimitText(rawTrimmed)) {
      throw createHttpError("Rate limit (429)", {
        status: 429,
        isRateLimit: true,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }

    if (isInvalidApiKeyText(rawTrimmed)) {
      throw createHttpError(
        "Invalid API key. Set a valid API key in the extension popup.",
        {
          status: 401,
          isAuthError: true,
        }
      );
    }

    return {
      text: rawTrimmed,
    };
  }

  return data;
}

function extractAnswer(data) {
  const extractTextParts = (value, collector = []) => {
    if (typeof value === "string") {
      if (value.trim()) {
        collector.push(value);
      }
      return collector;
    }

    if (!value) {
      return collector;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        extractTextParts(item, collector);
      }
      return collector;
    }

    if (typeof value === "object") {
      if (typeof value.text === "string" && value.text.trim()) {
        collector.push(value.text);
      }
      if (typeof value.content === "string" && value.content.trim()) {
        collector.push(value.content);
      }
      if (typeof value.output_text === "string" && value.output_text.trim()) {
        collector.push(value.output_text);
      }
      if (typeof value.value === "string" && value.value.trim()) {
        collector.push(value.value);
      }

      if (Array.isArray(value.content)) {
        extractTextParts(value.content, collector);
      }
      if (Array.isArray(value.output_text)) {
        extractTextParts(value.output_text, collector);
      }
      if (Array.isArray(value.parts)) {
        extractTextParts(value.parts, collector);
      }
    }

    return collector;
  };

  const getText = (value) =>
    extractTextParts(value)
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join("")
      .trim();

  if (data?.candidates?.length) {
    for (const candidate of data.candidates) {
      const candidateText = getText(candidate?.content?.parts || candidate?.content);
      if (candidateText) {
        return candidateText;
      }
    }
  }

  if (data?.choices?.length) {
    const firstChoice = data.choices[0];
    const messageContentText = getText(firstChoice?.message?.content);
    if (messageContentText) {
      return messageContentText;
    }

    const messageText = getText(firstChoice?.message);
    if (messageText) {
      return messageText;
    }

    const deltaText = getText(firstChoice?.delta?.content);
    if (deltaText) {
      return deltaText;
    }

    const plainChoiceText = getText(firstChoice?.text);
    if (plainChoiceText) {
      return plainChoiceText;
    }
  }

  for (const key of ["content", "text", "output", "response", "result", "message"]) {
    const text = getText(data?.[key]);
    if (text) {
      return text;
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
    /^(?:answer|\u7B54\u3048|\u56DE\u7B54)\s*[:\uFF1A]\s*/i,
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
      firstLine.match(/[\u30A0-\u30FF\u30FC]+/) ||
      rawAnswer.match(/[\u30A0-\u30FF\u30FC]+/);
    return katakanaMatch ? katakanaMatch[0] : firstLine;
  }

  if (answerMode === "number") {
    const normalizedAnswer = rawAnswer.replace(/[\u2212\u2013\u2014]/g, "-");
    const exponentMatch = normalizedAnswer.match(/\^\s*(-?\d+(?:\.\d+)?)/);
    if (
      exponentMatch &&
      /(?:\u4F55\u4E57|\u6307\u6570|\[blank\]\s*\u4E57|\u4E57\u3067\u3042\u308B|exponent|power)/i.test(question)
    ) {
      return exponentMatch[1];
    }

    const numericMatch = normalizedAnswer.match(/-?\d+(?:\.\d+)?/);
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
    return !/[\u30A0-\u30FF\u30FC]/.test(firstLine);
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
function getProviderEndpoints(providerId, model = "") {
  if (providerId === PROVIDER_OPENROUTER) {
    return [OPENROUTER_ENDPOINT];
  }

  if (providerId === PROVIDER_CAPI) {
    return [...CAPI_ENDPOINTS];
  }

  if (providerId === PROVIDER_GEMINI) {
    const modelId = normalizeText(model).replace(/^models\//i, "") || "gemini-2.5-flash";
    return [
      `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(modelId)}:generateContent`,
    ];
  }

  return [OPENAI_ENDPOINT];
}

function getProviderLabel(providerId) {
  if (providerId === PROVIDER_OPENROUTER) {
    return "OpenRouter";
  }

  if (providerId === PROVIDER_GEMINI) {
    return "Gemini";
  }

  if (providerId === PROVIDER_CAPI) {
    return "CAPI";
  }

  return "OpenAI";
}

async function requestChatCompletion(
  providerId,
  model,
  prompt,
  maxTokens,
  credentials
) {
  const baseMaxTokens =
    providerId === PROVIDER_OPENROUTER
      ? Math.max(48, Number(maxTokens) || 48)
      : providerId === PROVIDER_CAPI
        ? Math.max(24, Number(maxTokens) || 24)
      : providerId === PROVIDER_GEMINI
        ? Math.max(64, Number(maxTokens) || 64)
        : Math.max(16, Number(maxTokens) || 16);

  let lastError = null;
  const providerLabel = getProviderLabel(providerId);
  const endpointCandidates = getProviderEndpoints(providerId, model);

  for (let attempt = 0; attempt < REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const attemptMaxTokens =
      providerId === PROVIDER_OPENROUTER
        ? Math.min(320, baseMaxTokens * Math.pow(2, attempt))
        : providerId === PROVIDER_CAPI
          ? Math.min(256, baseMaxTokens * Math.pow(2, attempt))
        : providerId === PROVIDER_GEMINI
          ? Math.min(512, baseMaxTokens * Math.pow(2, attempt))
          : baseMaxTokens;
    let payload = null;

    if (providerId === PROVIDER_GEMINI) {
      payload = {
        systemInstruction: {
          role: "system",
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: attemptMaxTokens,
        },
      };
    } else {
      payload = {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: attemptMaxTokens,
      };
    }

    if (providerId === PROVIDER_OPENROUTER && payload) {
      payload.max_completion_tokens = attemptMaxTokens;
      payload.provider = { allow_fallbacks: true };
    }

    let shouldRetryAttempt = false;

    for (const endpoint of endpointCandidates) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: buildRequestHeaders(providerId, credentials),
          body: JSON.stringify(payload),
        });

        const data = await readJsonResponse(response);
        const bodyErrorMessage = normalizeText(
          data?.error?.message || data?.error || ""
        );
        if (bodyErrorMessage) {
          throw createHttpError(bodyErrorMessage, {
            status: Number(data?.error?.code) || response.status,
            isRateLimit: isRateLimitText(bodyErrorMessage),
            isAuthError: isInvalidApiKeyText(bodyErrorMessage),
            retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
          });
        }

        const answer = extractAnswer(data);
        if (answer) {
          const resolvedModel = normalizeText(
            data?.model || data?.modelVersion || model
          );
          return {
            answer,
            resolvedModel,
          };
        }

        const emptyError = createHttpError(`Empty response from ${endpoint}`, {
          status: response.status,
        });
        lastError = emptyError;
        console.warn(
          `${providerLabel} returned no answer for ${endpoint} (max_tokens=${attemptMaxTokens}):`,
          data
        );
        shouldRetryAttempt = attempt < REQUEST_MAX_ATTEMPTS - 1;
      } catch (error) {
        lastError = error;
        const canRetry =
          isRetryableError(error) && attempt < REQUEST_MAX_ATTEMPTS - 1;

        console.warn(
          `${providerLabel} request failed for ${endpoint} (attempt ${attempt + 1}/${REQUEST_MAX_ATTEMPTS}):`,
          error
        );

        if (canRetry) {
          shouldRetryAttempt = true;
        }
      }
    }

    if (shouldRetryAttempt) {
      const backoffMs = getRetryDelayMs(lastError, attempt);
      await sleep(backoffMs);
      continue;
    }

    if (lastError) {
      const authOrConfigError = Boolean(
        lastError.isAuthError ||
          /invalid\s*api\s*key|api\s*key\s*not\s*valid|unauthorized|forbidden/i.test(
            normalizeText(lastError.message)
          )
      );
      if (authOrConfigError && providerId !== PROVIDER_CAPI) {
        break;
      }
    }
  }

  if (providerId === PROVIDER_CAPI && lastError?.isAuthError) {
    throw new Error(
      "CAPI is currently rejecting anonymous requests (401). Switch provider order or try again later."
    );
  }

  throw new Error(
    lastError?.message || `Failed to get a response from ${providerLabel} API.`
  );
}

async function callCapiChat(
  question,
  options,
  requestKey = "",
  targetType = "standard",
  detailedMode = false,
  materialMode = false,
  materialRevision = 0,
  materialContext = "",
  useAccuracyProfile = false,
  providerOrder = DEFAULT_PROVIDER_ORDER,
  credentials = {}
) {
  const cleanedQuestion = normalizeText(question);
  const cleanedOptions = Array.isArray(options)
    ? options.map((option) => normalizeText(option)).filter(Boolean)
    : [];
  const cacheKey = JSON.stringify({
    requestKey: requestKey || cleanedQuestion,
    options: cleanedOptions,
    targetType,
    detailedMode: Boolean(detailedMode),
    materialMode: Boolean(materialMode),
    materialRevision: Number(materialRevision) || 0,
    useAccuracyProfile: Boolean(useAccuracyProfile),
    providerOrder: normalizeProviderOrder(providerOrder),
  });

  if (answerCache.has(cacheKey)) {
    const cached = answerCache.get(cacheKey);
    if (typeof cached === "string") {
      return { answer: cached, model: "" };
    }
    return cached;
  }

  let lastInvalidAnswer = "";
  let lastError = null;

  for (const plan of buildRequestPlans(
    cleanedQuestion,
    cleanedOptions,
    targetType,
    detailedMode,
    materialContext,
    useAccuracyProfile,
    providerOrder
  )) {
    try {
      const response = await requestChatCompletion(
        plan.providerId,
        plan.model,
        plan.prompt,
        plan.maxTokens,
        credentials
      );
      const rawAnswer = response.answer;
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

      const result = {
        answer: sanitizedAnswer,
        model: response.resolvedModel || plan.model,
        provider: plan.providerId,
      };
      answerCache.set(cacheKey, result);
      return result;
    } catch (error) {
      lastError = error;
      console.warn(
        `${getProviderLabel(plan.providerId)} request failed for model ${plan.model}:`,
        error
      );
    }
  }

  if (lastInvalidAnswer) {
    throw new Error(`Invalid answer from API: ${extractFirstLine(lastInvalidAnswer)}`);
  }

  const lastMessage = normalizeText(lastError?.message || "");
  if (
    lastMessage.includes("Empty response from https://openrouter.ai/api/v1/chat/completions")
  ) {
    throw new Error(
      "OpenRouter free returned an empty response. Please retry, or enable OpenAI fallback in API Providers."
    );
  }

  throw new Error(lastError?.message || "Failed to get a valid response from configured APIs.");
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "getAnswer") {
    return false;
  }

  const {
    question,
    options,
    requestKey,
    targetType,
    fieldLabel,
    detailedMode,
    materialMode,
    materialRevision,
  } = request;
  console.log("Received from content:", question, options, targetType, fieldLabel, detailedMode);

  loadMaterialState()
    .then((materialState) => {
      const activeProviders = filterProvidersByCredentials(
        materialState.apiProviders,
        materialState
      );
      if (!activeProviders.length) {
        throw new Error(
          "No usable API provider is configured. Enable OpenAI/OpenRouter/Gemini/CAPI and set required API keys in the popup."
        );
      }

      const shouldUseMaterial =
        Boolean(materialMode) &&
        materialState.materialMode &&
        Boolean(materialState.materialContext);
      const shouldUseAccuracyProfile =
        shouldUseMaterial && materialState.hasPdfSource;
      const selectedMaterialRevision = shouldUseMaterial
        ? Number(materialRevision || materialState.materialRevision || 0)
        : 0;
      const selectedMaterialContext = shouldUseMaterial
        ? materialState.materialContext
        : "";

      console.log("Model profile:", shouldUseAccuracyProfile ? "material-accuracy" : "standard");

      return callCapiChat(
        question,
        options,
        requestKey,
        targetType,
        detailedMode,
        shouldUseMaterial,
        selectedMaterialRevision,
        selectedMaterialContext,
        shouldUseAccuracyProfile,
        activeProviders,
        materialState
      );
    })
    .then((result) => {
      const answer = normalizeText(
        typeof result === "string" ? result : result?.answer || ""
      );
      const model = normalizeText(
        typeof result === "object" ? result?.model || "" : ""
      );
      const provider = normalizeText(
        typeof result === "object" ? result?.provider || "" : ""
      );

      console.log(
        "Parsed answer:",
        answer,
        "model:",
        model || "(unknown)",
        "provider:",
        provider || "(unknown)"
      );
      sendResponse({ answer, model, provider });
    })
    .catch((error) => {
      console.error("Error calling AI API:", error);
      sendResponse({
        error: normalizeText(error?.message || "Error fetching answer."),
      });
    });

  return true;
});

