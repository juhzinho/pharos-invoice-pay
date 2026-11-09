#!/usr/bin/env node
// Invoice-to-Payment Agent for Pharos Pacific: an invoice (text, PDF, JSON or an EIP-681 payment request) → every
// field with where it was read → checks that flag gaps and disagreements instead of guessing → a payment summary and
// an unsigned transaction that carries the invoice reference on chain.
//   npm run invoice -- check invoices/acme-design.txt --payer 0x…     read, check, prepare (or say what blocks it)
//   npm run invoice -- assemble .invoice/INV-2026-0142.json --sig 0x…  "once" mode: the signed authorization → unsigned tx
//   npm run invoice -- verify --tx 0x… [--invoice <file> --payer 0x…]  read a payment back from chain (memo, what moved)
//   npm run invoice -- demo                                           pay the sample invoices on an Anvil fork
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import { getAddress, isAddress, recoverTypedDataAddress } from "viem";
import { makeClient } from "../../lib/chain.js";
import { extract } from "../../lib/extract.js";
import { analyze } from "../../lib/checks.js";
import { onceTx, verifyPayment } from "../../lib/pay.js";
import { renderCheck, renderVerify } from "../../lib/render.js";

const USAGE = `usage: npm run invoice -- check <invoice.txt|.pdf|.json> [--payer 0x…] [--mode auto|once|direct] [--vendors invoices/vendors.json] [--json]
       npm run invoice -- assemble <.invoice/<ref>.json> --sig 0x…
       npm run invoice -- verify --tx 0x… [--invoice <file> --payer 0x…]
       npm run invoice -- demo
Nothing is signed or sent by this tool: the payer's wallet signs.`;
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const usage = (m) => Object.assign(new Error(m), { usage: true });

const [cmd, ...argv] = process.argv.slice(2);
const flags = {};
const pos = [];
try {
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { pos.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    if (k === "json") { flags.json = true; continue; }
    if (!["payer", "mode", "vendors", "sig", "tx", "invoice"].includes(k)) throw usage(`unknown flag --${k}`);
    const v = argv[++i];
    if (v == null || v.startsWith("--")) throw usage(`--${k} needs a value`);
    flags[k] = v;
  }
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  const payer = flags.payer ? (isAddress(flags.payer, { strict: false }) ? getAddress(flags.payer.toLowerCase()) : (() => { throw usage("--payer: an address (0x…)"); })()) : null;
  if (flags.mode && !["auto", "once", "direct"].includes(flags.mode)) throw usage("--mode: auto, once or direct");
  const client = makeClient();
  const read = (path) => {
    if (!path) throw usage(`${cmd} needs a file`);
    if (!existsSync(path)) throw usage(`file not found: ${path}`);
    return readFileSync(path);
  };
  const vendorsOf = () => {
    const p = flags.vendors ?? (existsSync("invoices/vendors.json") ? "invoices/vendors.json" : null);
    if (!p) return [];
    try {
      return JSON.parse(readFileSync(p, "utf8")).vendors ?? [];
    } catch (e) {
      throw usage(`${p}: not a vendor book (${e.message})`);
    }
  };

  if (cmd === "demo") {
    execFileSync(process.execPath, ["scripts/fork-proof.js"], { stdio: "inherit" });
    process.exit(0);
  }
  if (cmd === "check") {
    const buf = read(pos[0]);
    const ex = await extract(buf.toString("utf8"), { name: basename(pos[0]), bytes: buf });
    const r = await analyze(ex, { client, payer, vendors: vendorsOf(), mode: flags.mode ?? "auto" });
    if (r.sign) {
      mkdirSync(".invoice", { recursive: true });
      const file = `.invoice/${r.resolved.reference.replace(/[^\w.-]+/g, "_")}.json`;
      writeFileSync(file, json({ invoice: pos[0], resolved: r.resolved, sign: r.sign }));
      r.signFile = file;
    }
    if (flags.json) console.log(json({ extraction: { format: ex.format, fields: ex.fields, conflicts: ex.conflicts }, ...r }));
    else {
      console.log(renderCheck(ex, r));
      if (r.sign) console.log(`\n  the typed data to sign is in ${r.signFile}\n  then: npm run invoice -- assemble ${r.signFile} --sig 0x…`);
      if (r.tx) console.log(json({ unsignedTransaction: r.tx }));
    }
    process.exit(r.decision === "blocked" ? 3 : 0);
  }
  if (cmd === "assemble") {
    let saved;
    try {
      saved = JSON.parse(read(pos[0]).toString("utf8"));
    } catch (e) {
      throw e.usage ? e : usage(`${pos[0]}: not a file written by "check" (${e.message})`);
    }
    if (!saved?.sign?.typedData) throw usage(`${pos[0]}: no authorization to assemble`);
    if (!/^0x[0-9a-fA-F]{130}$/.test(flags.sig ?? "")) throw usage("assemble needs the payer's signature: --sig 0x… (0x + 130 hex characters)");
    const t = saved.sign.typedData;
    const typed = { ...t, message: { ...t.message, value: BigInt(t.message.value), validAfter: BigInt(t.message.validAfter), validBefore: BigInt(t.message.validBefore) } };
    const who = await recoverTypedDataAddress({ ...typed, signature: flags.sig }).catch(() => null);
    if (who !== getAddress(typed.message.from)) throw usage(`the signature is not the payer's (${typed.message.from}) for this invoice${who ? ` — it was made by ${who}` : ""}`);
    const tx = onceTx(typed, flags.sig, saved.resolved.reference);
    const sim = await client.call({ account: typed.message.to, to: tx.to, data: tx.data }).then(() => ({ ok: true }), (e) => ({ ok: false, reason: String(e.details ?? e.shortMessage ?? e.message).replace(/^execution reverted:?\s*/i, "").split("\n")[0] }));
    console.log(json({ invoice: saved.resolved.reference, simulation: sim, unsignedTransaction: tx, note: "any account can send it; the memo inv:<reference> is in its input data" }));
    process.exit(sim.ok ? 0 : 3);
  }
  if (cmd === "verify") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(flags.tx ?? "")) throw usage("verify needs --tx <transaction hash>");
    let expected = null;
    if (flags.invoice) {
      const buf = read(flags.invoice);
      const r = await analyze(await extract(buf.toString("utf8"), { name: basename(flags.invoice), bytes: buf }), { client: null, vendors: [] });
      if (!r.resolved.payee || !r.resolved.units) throw usage(`${flags.invoice}: the invoice itself does not give a payee and an amount to compare with`);
      expected = r.resolved;
    }
    const v = await verifyPayment(client, flags.tx, expected).catch((e) => {
      if (/could not be found|not found/i.test(e.message)) throw usage(`transaction ${flags.tx} not found on Pharos Pacific`);
      throw e;
    });
    console.log(flags.json ? json(v) : renderVerify(v));
    process.exit(v.matches === false ? 3 : 0);
  }
  throw usage(`unknown command “${cmd}”`);
} catch (e) {
  console.error(`error: ${String(e.message).split("\n")[0]}`);
  if (e.usage) console.error(`\n${USAGE}`);
  process.exit(e.usage ? 2 : 1);
}
