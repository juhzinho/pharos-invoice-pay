import { readFile } from "node:fs/promises";
import { makeClient } from "../lib/chain.js";
import { extract } from "../lib/extract.js";
import { analyze } from "../lib/checks.js";

// POST /api/check  { text?: string, pdfBase64?: string, name?: string, payer?: "0x…", mode?: "auto"|"once"|"direct" }
// Reads the invoice, checks it live on Pharos Pacific against the demo vendor book, and returns the extraction, the
// flags and — when nothing blocks — the payment summary with the unsigned transaction or the authorization to sign.
// Nothing is signed or sent.
const MAX = 2 * 1024 * 1024;
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

async function body(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX * 1.4) throw new Error("the invoice is too large (2 MB max)");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  const send = (status, b) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(json(b));
  if (req.method !== "POST") return send(405, { ok: false, error: "POST an invoice" });
  let input, bytes, text;
  try {
    try {
      input = await body(req);
    } catch (e) {
      throw new Error(/too large/.test(e.message) ? e.message : "the request body is not valid JSON");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("send { text } or { pdfBase64 }");
    if (typeof input.pdfBase64 === "string") {
      bytes = Buffer.from(input.pdfBase64, "base64");
      if (bytes.length > MAX) throw new Error("the invoice is too large (2 MB max)");
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new Error("pdfBase64 is not a PDF");
    } else if (typeof input.text === "string" && input.text.trim()) {
      if (input.text.length > 200_000) throw new Error("the invoice text is too long");
      text = input.text;
    } else throw new Error("send { text } or { pdfBase64 }");
    if (input.payer != null && !/^0x[0-9a-fA-F]{40}$/.test(String(input.payer))) throw new Error("payer: an address (0x…)");
    if (input.mode != null && !["auto", "once", "direct"].includes(input.mode)) throw new Error("mode: auto, once or direct");
  } catch (e) {
    return send(400, { ok: false, error: e.message });
  }
  try {
    const vendors = JSON.parse(await readFile(new URL("../invoices/vendors.json", import.meta.url), "utf8")).vendors;
    const name = String(input.name ?? (bytes ? "invoice.pdf" : "invoice.txt")).slice(0, 80);
    const ex = await extract(text ?? "", { name, bytes });
    const r = await analyze(ex, { client: makeClient(), payer: input.payer ?? null, vendors, mode: input.mode ?? "auto" });
    return send(200, { ok: true, network: "Pharos Pacific Mainnet", checkedAt: new Date().toISOString(), extraction: { format: ex.format, fields: ex.fields, conflicts: ex.conflicts, lines: ex.lines, pages: ex.pages ?? null }, ...r });
  } catch (e) {
    const busy = /timeout|ECONN|fetch failed|unreachable|429|rate/i.test(e.message);
    const bad = /Invalid PDF|PDF|password/i.test(e.message);
    return send(busy ? 503 : bad ? 400 : 500, { ok: false, error: busy ? "The Pharos Pacific RPC is not answering right now. Try again in a minute." : bad ? `could not read the PDF (${e.message.split("\n")[0]})` : e.message.split("\n")[0] });
  }
}
