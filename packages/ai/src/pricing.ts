/**
 * Small price table, used when the provider does not report the cost itself (Anthropic never does; OpenRouter does
 * when asked). USD per million tokens [input, output]. Unknown model: null.
 */
const PRICES: Record<string, readonly [number, number]> = {
  "claude-fable-5-2": [8, 40],
  "claude-mythos-5-2": [8, 40],
  "claude-fable-5-1": [10, 50],
  "claude-mythos-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-opus-4-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
  "google/gemini-2.5-flash": [0.3, 2.5],
};

/** "anthropic/claude-opus-5.5" → "claude-opus-5-5", "claude-haiku-4-5-20251001" → "claude-haiku-4-5". */
export function priceKey(model: string): string {
  let m = model.trim().toLowerCase();
  if (m.startsWith("anthropic/")) m = m.slice("anthropic/".length).replace(/\./g, "-");
  m = m.replace(/-\d{8}$/, "");
  return m;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/** Cost in USD of one call, or null when the price of the model is unknown (or the variant, e.g. ":batch", is). */
export function costUsd(model: string, t: TokenCounts): number | null {
  const key = priceKey(model);
  if (key.includes(":")) return null;
  let price = PRICES[key];
  if (!price) return null;
  const totalInput = t.input + (t.cacheWrite ?? 0) + (t.cacheRead ?? 0);
  // Claude Haiku 5.5: higher rate beyond 100K prompt tokens
  if (key === "claude-haiku-5-5" && totalInput > 100_000) price = [0.5, 2.5];
  const [inPrice, outPrice] = price;
  const usd = (t.input * inPrice + (t.cacheWrite ?? 0) * inPrice * 1.25 + (t.cacheRead ?? 0) * inPrice * 0.1 + t.output * outPrice) / 1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}
