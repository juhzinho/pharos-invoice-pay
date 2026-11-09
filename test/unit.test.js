import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { concat, decodeFunctionData, encodeFunctionData, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decimalStyle, parseWritten, toUnits, wordsToValue } from "../lib/money.js";
import { checkAddress, dateField, extract } from "../lib/extract.js";
import { analyze } from "../lib/checks.js";
import { directTx, invoiceNonce, memoOf, onceTx, onceTypedData, readMemo } from "../lib/pay.js";
import { ABI, TOKENS } from "../lib/contracts.js";

const dir = new URL("../invoices/", import.meta.url);
const vendors = JSON.parse(await readFile(new URL("vendors.json", dir), "utf8")).vendors;
const load = async (f) => { const b = await readFile(new URL(f, dir)); return extract(b.toString("utf8"), { name: f, bytes: b }); };

// ───────── amounts ─────────
test("written amounts: unambiguous styles, the document's style deciding, and a real ambiguity reported", () => {
  assert.deepEqual(parseWritten("1,250.00"), { value: "1250.00" });
  assert.deepEqual(parseWritten("1.250,00"), { value: "1250.00" });
  assert.deepEqual(parseWritten("1 250,00"), { value: "1250.00" });
  assert.deepEqual(parseWritten("€ 99,90"), { value: "99.90" });
  assert.deepEqual(parseWritten("1.250.000"), { value: "1250000" });
  assert.deepEqual(parseWritten("0.125"), { value: "0.125" }, "a leading zero has no thousands");
  assert.deepEqual(parseWritten("1,250", ","), { value: "1.250" });
  assert.deepEqual(parseWritten("1,250", "."), { value: "1250" });
  assert.match(parseWritten("1.850").ambiguous, /could be 1850 or 1\.850/);
  assert.equal(decimalStyle(["Subtotal 1,100.00", "Tax 150.00"]), ".");
  assert.equal(decimalStyle(["Total 2.400,00 EUR"]), ",");
  assert.equal(decimalStyle(["Total: 1.850"]), null);
});

test("token units are exact; more decimals than the token has is refused", () => {
  assert.equal(toUnits("1250.40", 6), 1_250_400_000n);
  assert.equal(toUnits("0.000001", 6), 1n);
  assert.throws(() => toUnits("1.0000001", 6), /more decimals/);
  assert.equal(toUnits("12.5", 18), 12_500_000_000_000_000_000n);
});

test("amounts in words", () => {
  assert.equal(wordsToValue("One thousand two hundred fifty US dollars"), "1250.00");
  assert.equal(wordsToValue("two thousand four hundred and five dollars and 40 cents"), "2405.40");
  assert.equal(wordsToValue("twelve hundred"), "1200.00");
  assert.equal(wordsToValue("see attached"), null);
});

test("dates: ISO, month names, and day/month order only when the numbers decide it", () => {
  assert.equal(dateField("Nov 24, 2026").value, "2026-11-24");
  assert.equal(dateField("30 November 2026").value, "2026-11-30");
  assert.equal(dateField("30.11.2026").value, "2026-11-30");
  const amb = dateField("04.11.2026");
  assert.equal(amb.value, null);
  assert.match(amb.ambiguous, /2026-11-04 \(day first\) or 2026-04-11 \(month first\)/);
});

test("addresses: a mixed-case address with a wrong checksum is a typo; all lower-case cannot be checked", () => {
  const a = "0x79989eF9BE1Dba15db9e19D2bd62616ae68A1D18";
  assert.deepEqual(checkAddress(a), { ok: true, address: a, checksummed: true });
  assert.match(checkAddress(a.replace("eF9", "eF8")).why, /checksum does not match/);
  assert.equal(checkAddress(a.toLowerCase()).checksummed, false);
  assert.equal(checkAddress("0x123").ok, false);
});

// ───────── the four formats ─────────
test("text e-mail: every field with the line it came from", async () => {
  const ex = await load("acme-design.txt");
  assert.equal(ex.format, "text");
  const f = ex.fields;
  assert.equal(f.reference.value, "INV-2026-0142");
  assert.equal(f.amount.value, "1250.00");
  assert.equal(f.currency.value, "USD");
  assert.equal(f.payeeName.value, "Acme Design Studio");
  assert.equal(f.chainId.value, 1672);
  assert.deepEqual(f.lineItems.map((x) => x.value), ["800.00", "300.00"]);
  assert.match(f.amount.source.text, /^Amount due: 1,250\.00 USD$/);
  assert.equal(ex.lines[f.amount.source.line - 1].trim(), f.amount.source.text);
});

test("PDF: text rebuilt into lines, columns kept apart, labels without colons read", async () => {
  const ex = await load("northwind-hosting.pdf");
  assert.equal(ex.format, "pdf");
  assert.equal(ex.pages, 1);
  assert.equal(ex.fields.reference.value, "NW-88213");
  assert.equal(ex.fields.payeeName.value, "Northwind Hosting");
  assert.equal(ex.fields.dueDate.value, "2026-11-24");
  assert.deepEqual(ex.fields.lineItems.map((x) => x.value), ["390.00", "62.00", "30.00"]);
  assert.equal(ex.fields.amount.source.text, "Total due   482.00 USDC");
});

test("JSON (UBL-style keys) and EIP-681 (amount in base units, the token's address is not a payee)", async () => {
  const j = await load("orbit-cloud.json");
  assert.equal(j.format, "json");
  assert.equal(j.fields.amount.value, "950.00");
  assert.equal(j.fields.amount.source.path, "LegalMonetaryTotal.PayableAmount");
  const e = await load("lumen-payment-request.txt");
  assert.equal(e.format, "eip681");
  assert.equal(e.fields.amount.value, "320");
  assert.equal(e.fields.currency.value, "USDC");
  assert.equal(e.fields.payee.source.param, "address");
  assert.equal(e.conflicts.length, 0);
});

test("EIP-681: the text and the URI disagreeing is a conflict, not a choice", async () => {
  const ex = await extract(`Amount: 320.00 USDC\nReference: X-1\nethereum:${TOKENS.USDC.address}@1672/transfer?address=0x70efd0A826b7a69556F1f2fcFb52A968C7509289&uint256=3200000000`);
  assert.equal(ex.conflicts[0].field, "amount");
  assert.deepEqual(ex.conflicts[0].values.map((v) => v.value), ["320.00", "3200"]);
});

// ───────── the decision on every sample (no chain: the document alone) ─────────
test("the ten samples: three ready, seven blocked — each for its own reason", async () => {
  const expect = {
    "acme-design.txt": ["ready", []], "northwind-hosting.pdf": ["ready", []], "lumen-payment-request.txt": ["ready", []],
    "acme-design-new-wallet.pdf": ["blocked", ["payee-changed"]], "orbit-cloud.json": ["blocked", ["subtotal-vs-due"]], "harbor-words.txt": ["blocked", ["words-vs-digits"]],
    "atlas-typo.txt": ["blocked", ["payee-address"]], "ambiguous-amount.txt": ["blocked", ["ambiguous-amount", "ambiguous-total"]], "berlin-euro.txt": ["blocked", ["currency-unsupported"]], "missing-reference.json": ["blocked", ["missing-reference"]],
  };
  for (const [file, [decision, blocks]] of Object.entries(expect)) {
    const r = await analyze(await load(file), { client: null, vendors, now: Date.parse("2026-11-09T12:00:00Z") / 1000 });
    assert.equal(r.decision, decision, `${file}: ${r.summary}`);
    assert.deepEqual(r.flags.filter((x) => x.severity === "block").map((x) => x.code).sort(), [...blocks].sort(), file);
  }
});

test("a blocked invoice gets no transaction; a clean one gets the memo and, for USDC, an authorization with the invoice's fingerprint", async () => {
  const blocked = await analyze(await load("atlas-typo.txt"), { client: null, vendors });
  assert.equal(blocked.tx, undefined);
  assert.equal(blocked.sign, undefined);
  const payer = privateKeyToAccount(generatePrivateKey()).address;
  const r = await analyze(await load("acme-design.txt"), { client: null, vendors, payer });
  assert.equal(r.resolved.mode, "once");
  assert.equal(r.sign.typedData.message.nonce, invoiceNonce(r.resolved.payee, "INV-2026-0142"));
  assert.equal(r.resolved.memo, "inv:INV-2026-0142");
  const d = await analyze(await load("northwind-hosting.pdf"), { client: null, vendors, payer, mode: "direct" });
  assert.equal(readMemo(d.tx.data), "NW-88213");
  assert.deepEqual(decodeFunctionData({ abi: ABI.erc20, data: d.tx.data }).args, [d.resolved.payee, 482_000_000n]);
});

test("overdue and the vendor book: warnings that do not stop a correct payment", async () => {
  const r = await analyze(await load("acme-design.txt"), { client: null, vendors, now: Date.parse("2026-12-15T00:00:00Z") / 1000 });
  assert.equal(r.decision, "review");
  assert.ok(r.flags.some((f) => f.code === "overdue" && /2026-11-30/.test(f.message)));
  const unknown = await analyze(await load("acme-design.txt"), { client: null, vendors: [{ name: "Someone Else", address: "0x0000000000000000000000000000000000000001" }] });
  assert.ok(unknown.flags.some((f) => f.code === "payee-new"));
});

// ───────── memo and fingerprint ─────────
test("the memo is read back from transfer, transferWithAuthorization and a plain PROS payment", async () => {
  const to = "0x1111111111111111111111111111111111111111";
  const t = concat([encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [to, 1n] }), memoOf("INV-9")]);
  assert.equal(readMemo(t), "INV-9");
  assert.equal(readMemo(encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [to, 1n] })), null);
  assert.equal(readMemo(directTx({ payee: to, units: 5n, token: "PROS", reference: "P-1" }).data), "P-1");
  const payer = privateKeyToAccount(generatePrivateKey());
  const typed = onceTypedData({ payer: payer.address, payee: to, units: 10n, reference: "INV-10" }, { now: 1_800_000_000 });
  const tx = onceTx(typed, await payer.signTypedData(typed), "INV-10");
  assert.equal(readMemo(tx.data), "INV-10");
  assert.equal(decodeFunctionData({ abi: ABI.usdc, data: tx.data }).args[5], invoiceNonce(to, "INV-10"));
  assert.equal(readMemo(concat([encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [to, 1n] }), stringToHex("hello")])), null, "only an inv: memo counts");
});

test("the fingerprint is the payee and the reference (case and spaces do not make a new invoice)", () => {
  const a = "0x79989eF9BE1Dba15db9e19D2bd62616ae68A1D18";
  assert.equal(invoiceNonce(a, "inv-2026-0142"), invoiceNonce(a.toLowerCase(), " INV-2026-0142 "));
  assert.notEqual(invoiceNonce(a, "INV-2026-0142"), invoiceNonce(a, "INV-2026-0143"));
  assert.notEqual(invoiceNonce(a, "INV-1"), invoiceNonce("0x1111111111111111111111111111111111111111", "INV-1"));
});
