/**
 * Token accounting and USD cost for Claude models.
 *
 * Rates are $ per million tokens, from Anthropic's published pricing.
 * Cache rates are derived from the base input rate via fixed multipliers:
 *   cache read      0.1x     (a cache hit)
 *   5m cache write  1.25x    (ephemeral_5m_input_tokens)
 *   1h cache write  2.0x     (ephemeral_1h_input_tokens)
 */

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

// $/MTok — { in, out }. Keys are matched by longest-prefix, so dated
// snapshots like "claude-haiku-4-5-20251001" resolve to their family.
const MODEL_RATES = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-mythos-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

// Claude Sonnet 5 introductory pricing runs through 2026-08-31.
const SONNET_5_INTRO = { in: 2, out: 10 };
const SONNET_5_INTRO_ENDS = Date.parse("2026-09-01T00:00:00Z");

// Claude Code writes a placeholder assistant record with model "<synthetic>"
// when a turn did not come from the API at all — most often
// "API Error: Connection closed mid-response". Its usage is all zeros, so it
// costs nothing; it is listed here so it reads as genuinely free rather than
// as an unknown model we failed to price.
const SYNTHETIC_MODELS = new Set(["<synthetic>"]);
const FREE = { in: 0, out: 0 };

// Short aliases that Claude Code writes into Agent/Task spawn inputs
// (`model: "haiku"`), as opposed to the resolved IDs in assistant records.
const ALIASES = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
  mythos: "claude-mythos-5",
};

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    total: 0,
  };
}

function addTokens(target, other) {
  target.input += other.input;
  target.output += other.output;
  target.cacheCreate5m += other.cacheCreate5m;
  target.cacheCreate1h += other.cacheCreate1h;
  target.cacheRead += other.cacheRead;
  target.total += other.total;
  return target;
}

/** Pull a normalized token bucket out of one assistant record's `message.usage`. */
function tokensFromUsage(usage) {
  const t = emptyTokens();
  if (!usage) return t;

  t.input = usage.input_tokens || 0;
  t.output = usage.output_tokens || 0;
  t.cacheRead = usage.cache_read_input_tokens || 0;

  const created = usage.cache_creation_input_tokens || 0;
  const split = usage.cache_creation;
  if (split) {
    t.cacheCreate5m = split.ephemeral_5m_input_tokens || 0;
    t.cacheCreate1h = split.ephemeral_1h_input_tokens || 0;
    // Trust the total if the split doesn't add up (forward-compat with new tiers).
    const splitSum = t.cacheCreate5m + t.cacheCreate1h;
    if (splitSum < created) t.cacheCreate5m += created - splitSum;
  } else {
    t.cacheCreate5m = created;
  }

  t.total =
    t.input + t.output + t.cacheCreate5m + t.cacheCreate1h + t.cacheRead;
  return t;
}

/** Resolve a model string (ID, dated snapshot, or short alias) to its rates. */
function ratesFor(model, at) {
  if (!model) return null;
  if (SYNTHETIC_MODELS.has(model)) return FREE;
  const id = ALIASES[model] || model;

  if (id.startsWith("claude-sonnet-5")) {
    const when = at ? Date.parse(at) : Date.now();
    if (Number.isFinite(when) && when < SONNET_5_INTRO_ENDS) {
      return SONNET_5_INTRO;
    }
  }

  if (MODEL_RATES[id]) return MODEL_RATES[id];

  // Dated snapshot, e.g. claude-haiku-4-5-20251001 -> claude-haiku-4-5.
  let best = null;
  for (const key of Object.keys(MODEL_RATES)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? MODEL_RATES[best] : null;
}

/**
 * USD for one token bucket on a given model.
 * Returns null when the model is unknown, so callers can surface "unpriced"
 * rather than silently reporting $0.
 */
function costUsd(tokens, model, at) {
  const r = ratesFor(model, at);
  if (!r) return null;
  const billable =
    tokens.input * r.in +
    tokens.cacheCreate5m * r.in * CACHE_WRITE_5M_MULT +
    tokens.cacheCreate1h * r.in * CACHE_WRITE_1H_MULT +
    tokens.cacheRead * r.in * CACHE_READ_MULT +
    tokens.output * r.out;
  return billable / 1e6;
}

function isKnownModel(model) {
  return ratesFor(model) !== null;
}

module.exports = {
  emptyTokens,
  addTokens,
  tokensFromUsage,
  costUsd,
  ratesFor,
  isKnownModel,
  MODEL_RATES,
};
