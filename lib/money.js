// Amounts as people write them on invoices — parsed exactly (decimal strings → bigint), never guessed.
// "1,250.00" and "1.250,00" are unambiguous; "1,250" or "1.250" alone could be 1250 or 1.25: the document's other
// numbers decide (a style seen elsewhere, e.g. "80.00"), and if nothing decides, the amount is reported as ambiguous.

const NUM = /^(\d{1,3}(?:[.,\s  ]\d{3})+|\d+)(?:([.,])(\d+))?$/;

/** The decimal style a document uses, from its unambiguous numbers: "." (1,250.00), "," (1.250,00) or null. */
export function decimalStyle(texts) {
  let dot = 0, comma = 0;
  for (const t of texts) {
    for (const m of String(t).matchAll(/\d[\d.,\s ]*\d/g)) {
      const s = m[0].replace(/[\s ]/g, "");
      if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s) || /^\d+\.\d{1,2}$/.test(s)) dot++;
      else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) comma++;
    }
  }
  return dot && !comma ? "." : comma && !dot ? "," : null;
}

/**
 * Parses one written amount. Returns { value: "1250.00" (canonical decimal string), ambiguous?: reason }.
 * `style` is the document's decimal separator when known.
 */
export function parseWritten(raw, style = null) {
  const s = String(raw).trim().replace(/^[^\d]+/, "").replace(/[^\d]+$/, "");
  if (!s) return null;
  const compact = s.replace(/[\s  ](?=\d{3}\b)/g, " ");
  // both separators: the last one is the decimal point
  if (/[.,]/.test(compact)) {
    const lastDot = compact.lastIndexOf("."), lastComma = compact.lastIndexOf(",");
    if (lastDot > -1 && lastComma > -1) {
      const dec = lastDot > lastComma ? "." : ",";
      const [i, f] = splitAt(compact, dec);
      return { value: `${i}.${f}` };
    }
    const sep = lastDot > -1 ? "." : ",";
    const parts = compact.split(sep);
    const tail = parts.at(-1);
    if (parts.length > 2) return parts.slice(1).every((p) => /^\d{3}$/.test(p)) ? { value: parts.join("").replace(/\s/g, "") } : null; // 1.250.000 → thousands
    if (tail.length !== 3) return { value: `${parts[0].replace(/\s/g, "")}.${tail}` }; // 12.5, 1250,00 → decimal
    // exactly three digits after a single separator: thousands or decimals?
    if (/^0/.test(parts[0])) return { value: `${parts[0]}.${tail}` }; // 0.125 — a leading zero has no thousands
    if (style === sep) return { value: `${parts[0].replace(/\s/g, "")}.${tail}` };
    if (style && style !== sep) return { value: `${parts[0]}${tail}`.replace(/\s/g, "") };
    return { value: `${parts[0]}${tail}`.replace(/\s/g, ""), ambiguous: `“${s}” could be ${parts[0]}${tail} or ${parts[0]}.${tail} — the document never shows which decimal separator it uses` };
  }
  return { value: compact.replace(/\s/g, "") };
}

function splitAt(s, dec) {
  const k = s.lastIndexOf(dec);
  return [s.slice(0, k).replace(/[.,\s]/g, ""), s.slice(k + 1)];
}

/** Canonical decimal string → bigint in token units; refuses more decimals than the token has. */
export function toUnits(value, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!m) throw new Error(`“${value}” is not an amount`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) throw new Error(`${value} has more decimals than the token's ${decimals}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function fromUnits(v, decimals, maxFrac = 6) {
  const x = BigInt(v), base = 10n ** BigInt(decimals);
  const f = (x % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return (x / base).toLocaleString("en-US") + (f ? `.${f}` : "");
}

// ───────── amounts in words (English), for the "digits vs words" check ─────────
const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE = { thousand: 1_000, million: 1_000_000 };

/** "one thousand two hundred fifty dollars and 40 cents" → "1250.40"; null when it is not a number in words. */
export function wordsToValue(text) {
  const t = String(text).toLowerCase().replace(/-/g, " ").replace(/[(),]/g, " ");
  const [whole, cents] = t.split(/\band\b(?=[^a-z]*(?:\d{1,2}|[a-z\s]+)\s*(?:cents?|\/100))/);
  const n = words(whole);
  if (n == null) return null;
  let c = 0;
  if (cents) {
    const m = /(\d{1,2})\s*(?:cents?|\/100)/.exec(cents);
    c = m ? Number(m[1]) : words(cents.replace(/cents?/, "")) ?? 0;
  }
  return `${n}.${String(c).padStart(2, "0")}`;
}

function words(s) {
  let total = 0, cur = 0, seen = false;
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (w in SMALL) { cur += SMALL[w]; seen = true; }
    else if (w === "hundred") { cur = (cur || 1) * 100; seen = true; }
    else if (w in SCALE) { total += (cur || 1) * SCALE[w]; cur = 0; seen = true; }
    else if (["and", "only", "us", "usd", "dollars", "dollar", "usdc", "pros", "exactly"].includes(w)) continue;
    else return null;
  }
  return seen ? total + cur : null;
}
