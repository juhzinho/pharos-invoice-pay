import { getAddress, isAddress } from "viem";
import { decimalStyle, parseWritten, wordsToValue } from "./money.js";
import { TOKENS } from "./contracts.js";

// Four invoice formats → one extraction. Every field keeps where it came from (a line of the document, a JSON path,
// a URI parameter) so a person can check it, and conflicting candidates are kept as conflicts — never resolved by
// guessing. Checks (lib/checks.js) turn conflicts and gaps into flags.
//   text   — an e-mail or plain-text invoice
//   pdf    — a PDF invoice (text extracted with pdf.js, rebuilt into lines; columns kept apart)
//   json   — structured data: a simple schema or UBL-style keys (PayableAmount, PayeeParty, LineExtensionAmount…)
//   eip681 — a payment request URI (ethereum:<token>@<chainId>/transfer?address=…&uint256=…), alone or inside a text

const field = (value, raw, source, extra = {}) => ({ value, raw: raw == null ? null : String(raw), source, ...extra });
const CURRENCIES = [["US$", "USD"], ["R$", "BRL"], ["$", "USD"], ["€", "EUR"], ["£", "GBP"]];
const CODES = /\b(USDC|WPROS|PROS|USD|EUR|BRL|GBP|JPY|CHF|CAD|AUD|ETH|USDT)\b/i;

// ───────── format detection ─────────
export async function extract(input, { name = "invoice", bytes } = {}) {
  if (bytes && isPdf(bytes)) return extractPdf(bytes, name);
  const text = String(input ?? "").replace(/^﻿/, "");
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      return { format: "json", name, fields: {}, conflicts: [], lines: trimmed.split(/\r?\n/), error: `not valid JSON (${e.message})` };
    }
    return extractJson(obj, name, trimmed);
  }
  const lines = text.split(/\r?\n/);
  return lines.some((l) => /\bethereum:[0-9a-zA-Z]/.test(l)) ? extractEip681(lines, name) : extractText(lines, name, "text");
}

export const isPdf = (b) => b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

// ───────── PDF ─────────
export async function extractPdf(bytes, name) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines = [];
  for (let n = 1; n <= Math.min(doc.numPages, 10); n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    // group text runs by baseline (y), then order by x; a wide horizontal gap becomes a column break ("   ")
    const rows = [];
    for (const it of items) {
      if (!it.str?.trim()) continue;
      const [, , , , x, y] = it.transform;
      let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
      if (!row) rows.push((row = { y, runs: [] }));
      row.runs.push({ x, w: it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.runs.sort((a, b) => a.x - b.x);
      let s = "", end = null;
      for (const run of r.runs) {
        if (end != null) s += run.x - end > 18 ? "   " : run.x - end > 1.5 ? " " : "";
        s += run.s;
        end = run.x + run.w;
      }
      lines.push(s.replace(/\s+$/, ""));
    }
    if (n < doc.numPages) lines.push("");
  }
  await doc.destroy();
  const out = lines.some((l) => /\bethereum:[0-9a-zA-Z]/.test(l)) ? extractEip681(lines, name) : extractText(lines, name, "pdf");
  out.format = out.format === "eip681" ? "pdf+eip681" : "pdf";
  out.pages = lines.filter((l) => l === "").length + 1;
  return out;
}

// ───────── text (also used for PDF lines) ─────────
const LABELS = {
  reference: /\b(?:invoice\s*(?:no\.?|number|num\.?|#|id)|inv\.?\s*(?:no\.?|#)|bill\s*(?:no\.?|number|#))\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9\-\/_.]{1,39})/i,
  reference2: /\b(?:payment\s*reference|reference|ref\.?|our\s*ref)\s*(?:no\.?|#)?\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9\-\/_.]{1,39})/i,
  payeeLine: /\b(?:pay\s*to|payable\s*to|payee|remit\s*to|beneficiary|send\s*(?:payment|funds)\s*to|wallet|recipient|deposit\s*address|payment\s*address)\b/i,
  // a label is followed by ":" or, in a PDF's two-column layout, by a column gap (3+ spaces)
  payeeName: /^\s*(?:from|bill\s*from|billed\s*by|vendor|supplier|issuer|payee\s*name|company)\s*(?::|\s{3,})\s*(.+?)\s*$/i,
  due: /\b(?:amount\s*due|balance\s*due|total\s*due|due\s*amount|please\s*pay|amount\s*payable|to\s*pay)\b|^\s*amount\s*:/i,
  total: /\b(?:grand\s*total|invoice\s*total|total)\b(?!\s*due)/i,
  subtotal: /\bsub\s*-?\s*total\b/i,
  tax: /\b(?:tax|vat|gst|sales\s*tax)\b/i,
  paid: /\b(?:amount\s*paid|less\s*(?:deposit|paid)|paid\s*to\s*date|deposit\s*received)\b/i,
  dueDate: /\b(?:due\s*date|payment\s*due|due\s*by|due\s*on|pay\s*by)\s*[:]?\s*(.+)$/i,
  issueDate: /\b(?:invoice\s*date|date\s*of\s*issue|issue\s*date|issued(?:\s*on)?|date)\s*(?::|\s{3,})\s*(.+)$/i,
  currency: /\bcurrency\s*(?::|\s{3,})\s*([A-Za-z$€£]{1,5})/i,
  words: /\b(?:amount\s*in\s*words|in\s*words|the\s*sum\s*of|say)\s*[:]\s*(.+)$/i,
  network: /\b(?:network|chain|blockchain)\s*(?:id)?\s*(?::|\s{3,})\s*(.+)$/i,
};

function currencyIn(s) {
  const code = CODES.exec(s)?.[1]?.toUpperCase();
  if (code) return code;
  for (const [sym, c] of CURRENCIES) if (s.includes(sym)) return c;
  return null;
}
const amountIn = (s) => /(?:US\$|R\$|[$€£])?\s*(\d[\d.,\s ]*\d|\d)(?!.*\d)/.exec(s.replace(/\b(?:19|20)\d\d-\d\d-\d\d\b/g, ""));

export function extractText(lines, name, format = "text") {
  const fields = {};
  const conflicts = [];
  const notes = [];
  const style = decimalStyle(lines);
  const src = (i) => ({ line: i + 1, text: lines[i].trim() });
  const money = (i, label) => {
    const m = amountIn(lines[i].replace(label, " "));
    if (!m) return null;
    const p = parseWritten(m[1], style);
    return p && field(p.value, m[1].trim(), src(i), { ambiguous: p.ambiguous ?? null, currency: currencyIn(lines[i]) });
  };
  const firstWith = (re, fn) => {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { const v = fn(i); if (v) return v; }
    return null;
  };
  const allWith = (re, fn) => lines.map((l, i) => (re.test(l) ? fn(i) : null)).filter(Boolean);

  // reference: the invoice number, else a "reference"
  const ref = firstWith(LABELS.reference, (i) => field(LABELS.reference.exec(lines[i])[1].replace(/[.,;]$/, ""), lines[i].trim(), src(i))) ?? firstWith(LABELS.reference2, (i) => field(LABELS.reference2.exec(lines[i])[1].replace(/[.,;]$/, ""), lines[i].trim(), src(i)));
  if (ref) fields.reference = ref;

  // payee address: on a "pay to / wallet / …" line; two different ones are a conflict, not a choice
  const addrs = lines.flatMap((l, i) => [...l.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => ({ raw: m[0], i, labelled: LABELS.payeeLine.test(l) || (i > 0 && LABELS.payeeLine.test(lines[i - 1]) && !/0x[0-9a-fA-F]{40}/.test(lines[i - 1])) })));
  const labelled = addrs.filter((a) => a.labelled);
  const pool = labelled.length ? labelled : addrs;
  const distinct = [...new Map(pool.map((a) => [a.raw.toLowerCase(), a])).values()];
  if (distinct.length === 1) fields.payee = field(distinct[0].raw, distinct[0].raw, src(distinct[0].i), { labelled: distinct[0].labelled });
  else if (distinct.length > 1) conflicts.push({ field: "payee", values: distinct.map((a) => ({ value: a.raw, source: src(a.i) })), why: "more than one payee address in the document" });

  const nameF = firstWith(LABELS.payeeName, (i) => field(LABELS.payeeName.exec(lines[i])[1].replace(/<.*?>/g, "").trim(), lines[i].trim(), src(i)));
  if (nameF) fields.payeeName = nameF;

  // amounts: what is due, the total, subtotal, tax, already paid
  const dues = allWith(LABELS.due, (i) => money(i, LABELS.due));
  const totals = allWith(LABELS.total, (i) => (LABELS.subtotal.test(lines[i]) ? null : money(i, LABELS.total)));
  const subtotal = firstWith(LABELS.subtotal, (i) => money(i, LABELS.subtotal));
  const tax = firstWith(LABELS.tax, (i) => (LABELS.total.test(lines[i]) ? null : money(i, LABELS.tax)));
  const paid = firstWith(LABELS.paid, (i) => money(i, LABELS.paid));
  const uniq = (xs) => [...new Map(xs.map((x) => [x.value, x])).values()];
  const dueU = uniq(dues), totalU = uniq(totals);
  if (dueU.length > 1) conflicts.push({ field: "amount", values: dueU.map((d) => ({ value: d.value, source: d.source })), why: "the document states more than one amount due" });
  if (totalU.length > 1) conflicts.push({ field: "total", values: totalU.map((d) => ({ value: d.value, source: d.source })), why: "the document states more than one total" });
  const amount = dueU.length === 1 ? dueU[0] : !dueU.length && totalU.length === 1 ? totalU[0] : null;
  if (amount) fields.amount = amount;
  if (totalU.length === 1) fields.total = totalU[0];
  if (subtotal) fields.subtotal = subtotal;
  if (tax) fields.tax = tax;
  if (paid) fields.paid = paid;

  // currency: on the amount's own line, else a "Currency:" line
  const cur = amount?.currency ? field(amount.currency, amount.raw, amount.source) : firstWith(LABELS.currency, (i) => field(normCurrency(LABELS.currency.exec(lines[i])[1]), lines[i].trim(), src(i)));
  if (cur) fields.currency = cur;
  const curs = new Set([...dues, ...totals, subtotal, tax].filter((x) => x?.currency).map((x) => x.currency));
  if (curs.size > 1) conflicts.push({ field: "currency", values: [...curs].map((c) => ({ value: c })), why: "the amounts are written in different currencies" });

  // amount in words, dates, network
  const words = firstWith(LABELS.words, (i) => field(wordsToValue(LABELS.words.exec(lines[i])[1]), LABELS.words.exec(lines[i])[1].trim(), src(i))) ?? firstWith(/\(([a-z][a-z\s-]+(?:dollars?|usdc|pros)[a-z\s0-9/-]*)\)/i, (i) => { const raw = /\(([a-z][a-z\s-]+(?:dollars?|usdc|pros)[a-z\s0-9/-]*)\)/i.exec(lines[i])[1]; return field(wordsToValue(raw), raw, src(i)); });
  if (words) fields.amountInWords = words;
  const due = firstWith(LABELS.dueDate, (i) => dateField(LABELS.dueDate.exec(lines[i])[1], src(i)));
  if (due) fields.dueDate = due;
  const issue = firstWith(LABELS.issueDate, (i) => (LABELS.dueDate.test(lines[i]) ? null : dateField(LABELS.issueDate.exec(lines[i])[1], src(i))));
  if (issue) fields.issueDate = issue;
  const net = firstWith(LABELS.network, (i) => networkField(LABELS.network.exec(lines[i])[1], src(i)));
  if (net) fields.chainId = net;

  // line items: between a header with "Description"/"Item" and the subtotal/total
  const head = lines.findIndex((l) => /\b(description|item|service)\b/i.test(l) && /\b(amount|total|price)\b/i.test(l));
  if (head > -1) {
    const items = [];
    for (let i = head + 1; i < lines.length; i++) {
      if (LABELS.subtotal.test(lines[i]) || LABELS.total.test(lines[i]) || LABELS.due.test(lines[i])) break;
      const m = /^(.*?\S)\s{2,}.*?(\d[\d.,]*)\s*(?:[A-Z]{3,5})?\s*$/.exec(lines[i]);
      if (!m) continue;
      const p = parseWritten(m[2], style);
      if (p) items.push(field(p.value, m[2], src(i), { description: m[1].replace(/\s{2,}.*/, "") }));
    }
    if (items.length) fields.lineItems = items;
  }
  if (!style && [amount, subtotal, tax].some((x) => x?.ambiguous)) notes.push("the document never shows which decimal separator it uses");
  return { format, name, fields, conflicts, notes, lines, decimalStyle: style };
}

const normCurrency = (s) => { const t = String(s).trim().toUpperCase(); return { $: "USD", "US$": "USD", "€": "EUR", "£": "GBP", "R$": "BRL" }[t] ?? t; };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Dates as written: ISO, "Nov 30, 2026", "30 November 2026"; dd/mm vs mm/dd only when the numbers decide. */
export function dateField(raw, source) {
  const s = String(raw).trim();
  let m;
  const mk = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);
  if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(s))) return field(mk(+m[1], +m[2], +m[3]), s, source);
  const month = (w) => MONTHS[w.slice(0, 4).toLowerCase()] ?? MONTHS[w.slice(0, 3).toLowerCase()] ?? null;
  if ((m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s)) && month(m[1])) return field(mk(+m[3], month(m[1]), +m[2]), s, source);
  if ((m = /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s)) && month(m[2])) return field(mk(+m[3], month(m[2]), +m[1]), s, source);
  if ((m = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s))) {
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) return field(mk(+m[3], b, a), s, source);
    if (b > 12 && a <= 12) return field(mk(+m[3], a, b), s, source);
    if (a === b) return field(mk(+m[3], a, b), s, source);
    return field(null, s, source, { ambiguous: `“${s}” could be ${m[3]}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")} (day first) or ${m[3]}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")} (month first)` });
  }
  return null;
}

function networkField(raw, source) {
  const s = String(raw).toLowerCase();
  const id = /\b(\d{1,7})\b/.exec(s)?.[1];
  if (id) return field(Number(id), raw.trim(), source);
  if (/pharos|pacific/.test(s)) return field(1672, raw.trim(), source);
  const known = { ethereum: 1, base: 8453, polygon: 137, arbitrum: 42161, optimism: 10, bsc: 56, "bnb": 56, avalanche: 43114, solana: "solana" };
  for (const [k, v] of Object.entries(known)) if (s.includes(k)) return field(v, raw.trim(), source);
  return null;
}

// ───────── JSON (simple schema or UBL-style keys) ─────────
export function extractJson(obj, name, text) {
  const fields = {};
  const conflicts = [];
  const get = (paths) => {
    for (const p of paths) {
      const v = p.split(".").reduce((o, k) => (o == null ? undefined : Array.isArray(o) && /^\d+$/.test(k) ? o[+k] : o[k]), obj);
      if (v != null && v !== "") return { v, path: p };
    }
    return null;
  };
  const src = (path) => ({ path });
  const num = (x) => (typeof x === "object" && x ? x.value ?? x["#text"] ?? x._ ?? null : x);
  const cur = (x) => (typeof x === "object" && x ? x.currencyID ?? x.currency ?? null : null);
  const amountF = (paths) => {
    const g = get(paths);
    if (!g) return null;
    const raw = num(g.v);
    if (typeof raw === "number" && !Number.isSafeInteger(Math.round(raw * 100))) return field(null, raw, src(g.path), { ambiguous: "a JSON number too large to be exact — send amounts as strings" });
    const p = parseWritten(String(raw), ".");
    return p && field(p.value, raw, src(g.path), { currency: cur(g.v) ? normCurrency(cur(g.v)) : null });
  };
  const ref = get(["invoiceNumber", "invoice_number", "reference", "ID", "id", "InvoiceNumber", "Invoice.ID"]);
  if (ref) fields.reference = field(String(ref.v), ref.v, src(ref.path));
  const pay = get(["payee.address", "payee.wallet", "payeeAddress", "payTo", "pay_to", "recipient", "PayeeParty.EndpointID", "PaymentMeans.PayeeFinancialAccount.ID"]);
  if (pay) fields.payee = field(String(typeof pay.v === "object" ? pay.v.value ?? JSON.stringify(pay.v) : pay.v), pay.v, src(pay.path), { labelled: true });
  const pn = get(["payee.name", "payeeName", "vendor.name", "seller.name", "supplier.name", "AccountingSupplierParty.Party.PartyName.Name", "PayeeParty.PartyName.Name", "from"]);
  if (pn) fields.payeeName = field(String(pn.v), pn.v, src(pn.path));
  const amount = amountF(["amountDue", "amount_due", "balanceDue", "LegalMonetaryTotal.PayableAmount", "PayableAmount", "amount"]);
  if (amount) fields.amount = amount;
  const total = amountF(["total", "totalAmount", "LegalMonetaryTotal.TaxInclusiveAmount", "TaxInclusiveAmount"]);
  if (total) fields.total = total;
  const subtotal = amountF(["subtotal", "sub_total", "LegalMonetaryTotal.LineExtensionAmount", "LineExtensionAmount"]);
  if (subtotal) fields.subtotal = subtotal;
  const tax = amountF(["tax", "taxAmount", "TaxTotal.TaxAmount", "TaxAmount"]);
  if (tax) fields.tax = tax;
  const paid = amountF(["amountPaid", "paid", "LegalMonetaryTotal.PrepaidAmount", "PrepaidAmount"]);
  if (paid) fields.paid = paid;
  if (!fields.amount && total) fields.amount = total;
  const c = get(["currency", "DocumentCurrencyCode", "currencyCode"]);
  const curs = new Set([c ? normCurrency(c.v) : null, ...[fields.amount, fields.total, fields.subtotal, fields.tax].map((x) => x?.currency)].filter(Boolean));
  if (curs.size > 1) conflicts.push({ field: "currency", values: [...curs].map((v) => ({ value: v })), why: "the amounts are written in different currencies" });
  else if (curs.size === 1) fields.currency = field([...curs][0], c?.v ?? [...curs][0], c ? src(c.path) : fields.amount?.source);
  const d = get(["dueDate", "due_date", "DueDate", "PaymentMeans.PaymentDueDate"]);
  if (d) fields.dueDate = dateField(String(d.v), src(d.path)) ?? field(null, d.v, src(d.path));
  const iDate = get(["issueDate", "issue_date", "date", "IssueDate"]);
  if (iDate) fields.issueDate = dateField(String(iDate.v), src(iDate.path)) ?? field(null, iDate.v, src(iDate.path));
  const ch = get(["chainId", "chain_id", "network.chainId", "network"]);
  if (ch) fields.chainId = typeof ch.v === "number" || /^\d+$/.test(String(ch.v)) ? field(Number(ch.v), ch.v, src(ch.path)) : networkField(String(ch.v), src(ch.path));
  const w = get(["amountInWords", "amount_in_words"]);
  if (w) fields.amountInWords = field(wordsToValue(String(w.v)), w.v, src(w.path));
  const li = get(["lineItems", "line_items", "items", "InvoiceLine"]);
  if (li && Array.isArray(li.v)) {
    fields.lineItems = li.v.map((it, i) => {
      const raw = num(it.amount ?? it.total ?? it.LineExtensionAmount ?? it.lineTotal);
      const p = raw == null ? null : parseWritten(String(raw), ".");
      return field(p?.value ?? null, raw, src(`${li.path}.${i}`), { description: String(it.description ?? it.name ?? it.Item?.Name ?? `item ${i + 1}`) });
    });
  }
  return { format: "json", name, fields, conflicts, notes: [], lines: text.split(/\r?\n/) };
}

// ───────── EIP-681 payment request ─────────
export function extractEip681(lines, name) {
  const i = lines.findIndex((l) => /\bethereum:[0-9a-zA-Z]/.test(l));
  // the text around the URI is read without the URI line (its token contract is not a payee); the URI is read below
  const base = { ...extractText(lines.map((l, j) => (j === i ? "" : l)), name, "eip681"), lines };
  const uri = /ethereum:[^\s"'<>]+/.exec(lines[i])[0];
  const src = (param) => ({ line: i + 1, text: lines[i].trim(), param });
  const m = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40}|[^@/?]+)(?:@(\d+))?(?:\/([a-zA-Z]\w*))?(?:\?(.*))?$/.exec(uri);
  const conflicts = [...base.conflicts];
  const fields = { ...base.fields };
  if (!m) return { ...base, conflicts, error: `“${uri}” is not an EIP-681 payment request` };
  const [, target, chain, fn, query] = m;
  const q = new URLSearchParams(query ?? "");
  const fromUri = {};
  if (chain) fromUri.chainId = field(Number(chain), `@${chain}`, src("chain_id"));
  if (fn === "transfer") {
    const token = Object.values(TOKENS).find((t) => t.address && t.address.toLowerCase() === target.toLowerCase());
    fromUri.currency = field(token?.symbol ?? null, target, src("target"), token ? {} : { unknownToken: target });
    if (q.get("address")) fromUri.payee = field(q.get("address"), q.get("address"), src("address"), { labelled: true });
    const units = q.get("uint256");
    if (units) fromUri.amount = field(unitsToDecimal(units, token?.decimals), units, src("uint256"), token ? { inUnits: true } : { ambiguous: "the amount is in the token's base units, and the token is unknown" });
  } else if (!fn) {
    fromUri.payee = field(target, target, src("target"), { labelled: true });
    fromUri.currency = field("PROS", "(native)", src("target"));
    if (q.get("value")) fromUri.amount = field(unitsToDecimal(q.get("value"), 18), q.get("value"), src("value"), { inUnits: true });
  } else {
    return { ...base, conflicts, error: `the payment request calls “${fn}”, not a transfer` };
  }
  // the URI is what a wallet would execute: where the surrounding text says something else, that is a conflict
  for (const [k, f] of Object.entries(fromUri)) {
    const t = fields[k];
    const differs = t && t.value != null && f.value != null && String(t.value).toLowerCase() !== String(f.value).toLowerCase() && !(k === "currency" && t.value === "USD" && f.value === "USDC") && !(k === "amount" && sameAmount(t.value, f.value));
    if (differs) conflicts.push({ field: k, values: [{ value: t.value, source: t.source }, { value: f.value, source: f.source }], why: "the text of the request and its payment URI disagree" });
    fields[k] = f;
  }
  for (const k of ["memo", "ref", "reference", "message"]) if (q.get(k) && !fields.reference) fields.reference = field(q.get(k), q.get(k), src(k), { nonStandard: true });
  return { ...base, format: "eip681", fields, conflicts, uri };
}

const sameAmount = (a, b) => { try { return Number(a) === Number(b); } catch { return false; } };
function unitsToDecimal(units, decimals) {
  const s = String(units);
  let v;
  if (/^\d+$/.test(s)) v = BigInt(s);
  else if (/^\d+(\.\d+)?e\d+$/i.test(s)) { // 1.25e6
    const [mant, exp] = s.toLowerCase().split("e");
    const [i, f = ""] = mant.split(".");
    if (f.length > Number(exp)) return null;
    v = BigInt(i + f.padEnd(Number(exp), "0"));
  } else return null;
  if (decimals == null) return null;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / base}${frac ? `.${frac}` : ""}`;
}

/** A field's address, checksummed — or why it is not usable. Mixed case with a wrong checksum is a likely typo. */
export function checkAddress(raw) {
  const s = String(raw ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, why: "not an address" };
  if (!isAddress(s, { strict: false })) return { ok: false, why: "not an address" };
  const lowerOrUpper = s.slice(2) === s.slice(2).toLowerCase() || s.slice(2) === s.slice(2).toUpperCase();
  if (!lowerOrUpper && getAddress(s) !== s) return { ok: false, why: `the checksum does not match (expected ${getAddress(s)}): one or more characters were mistyped`, checksummed: getAddress(s) };
  return { ok: true, address: getAddress(s), checksummed: !lowerOrUpper };
}
