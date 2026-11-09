// End-to-end, live on Pharos Pacific Mainnet (read-only: nothing is signed for a real wallet, nothing is sent).
//   node test/e2e.js           mainnet checks (~1 min)
//   node test/e2e.js --fork    + the sample invoices paid and read back on an Anvil fork
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makeClient } from "../lib/chain.js";
import { extract } from "../lib/extract.js";
import { analyze } from "../lib/checks.js";
import { verifyPayment } from "../lib/pay.js";
import handler from "../api/check.js";

const root = new URL("..", import.meta.url);
const vendors = JSON.parse(readFileSync(new URL("invoices/vendors.json", root), "utf8")).vendors;
const PAYER = "0x6eA08ca8F313d860808ef7431fc72c6FbcF4A72D"; // a real Pacific wallet holding USDC
const REAL_TX = "0xfb883c8bd2600a9ab9d7f5c600c62d6c31149063e09d2b1173c1dd8bff7c47c1"; // a real USDC transferWithAuthorization on Pacific
const client = makeClient();
const load = async (f) => { const b = readFileSync(new URL(`invoices/${f}`, root)); return extract(b.toString("utf8"), { name: f, bytes: b }); };
const cli = (...args) => spawnSync(process.execPath, ["tasks/invoice/invoice.js", ...args], { encoding: "utf8", cwd: root });
let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}

await check("live: a USD invoice checked against the Chainlink USDC/USD peg, the payer's real balance and duplicates", async () => {
  const r = await analyze(await load("acme-design.txt"), { client, payer: PAYER, vendors });
  assert.equal(r.decision, "ready", r.summary);
  assert.ok(r.peg > 0.99 && r.peg < 1.01, String(r.peg));
  assert.ok(r.flags.some((f) => f.code === "usd-as-usdc"));
  assert.ok(Number(r.chain.payerBalance.replace(/,/g, "")) > 1250);
  assert.equal(r.sign.typedData.message.from, PAYER);
  assert.ok(r.chain.block > 22_000_000);
});

await check("live: a wallet without the money is blocked, with both amounts", async () => {
  const poor = privateKeyToAccount(generatePrivateKey()).address;
  const r = await analyze(await load("northwind-hosting.pdf"), { client, payer: poor, vendors });
  assert.equal(r.decision, "blocked");
  assert.match(r.flags.find((f) => f.code === "balance").message, /^The paying wallet holds 0 USDC; the invoice is 482 USDC\.$/);
});

await check("verify reads a real Pacific transaction: what moved, and that it carries no invoice memo", async () => {
  const v = await verifyPayment(client, REAL_TX);
  assert.equal(v.status, "success");
  assert.equal(v.block, 22_413_311);
  assert.equal(v.paid.token, "USDC");
  assert.ok(/^\d+$/.test(v.paid.units));
  assert.equal(v.reference, null);
  const lumen = await analyze(await load("lumen-payment-request.txt"), { client: null, vendors: [] });
  const m = await verifyPayment(client, REAL_TX, lumen.resolved);
  assert.equal(m.matches, false);
  assert.equal(m.checks.find((c) => c.what === "reference").ok, false);
});

await check("CLI: ready exits 0 and writes what to sign; blocked exits 3; verify and its mismatch; mistakes exit 2", async () => {
  const ok = cli("check", "invoices/acme-design.txt", "--payer", PAYER);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /READY {2}Pay 1,250 USDC to Acme Design Studio/);
  assert.match(ok.stdout, /line 19: “Amount due: 1,250\.00 USD”/);
  assert.match(ok.stdout, /\.invoice\/INV-2026-0142\.json/);
  const direct = cli("check", "invoices/northwind-hosting.pdf", "--payer", PAYER, "--mode", "direct");
  assert.equal(direct.status, 0, direct.stderr);
  const tx = JSON.parse(direct.stdout.slice(direct.stdout.indexOf("{"))).unsignedTransaction;
  assert.match(tx.data, /696e763a4e572d3838323133$/, "ends with inv:NW-88213");
  const bad = cli("check", "invoices/acme-design-new-wallet.pdf");
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /BLOCKED/);
  assert.match(bad.stdout, /address on file for Acme Design Studio/);
  const js = JSON.parse(cli("check", "invoices/berlin-euro.txt", "--json").stdout);
  assert.equal(js.decision, "blocked");
  assert.equal(js.extraction.fields.currency.value, "EUR");
  const v = cli("verify", "--tx", REAL_TX);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /none found in the input data/);
  assert.equal(cli("verify", "--tx", REAL_TX, "--invoice", "invoices/lumen-payment-request.txt").status, 3);
  const wrongSig = cli("assemble", ".invoice/INV-2026-0142.json", "--sig", await privateKeyToAccount(generatePrivateKey()).signMessage({ message: "x" }));
  assert.equal(wrongSig.status, 2);
  assert.match(wrongSig.stderr, /not the payer's/);
  for (const [args, re] of [[["pay"], /unknown command/], [["check", "nope.txt"], /file not found/], [["check", "invoices/acme-design.txt", "--payer", "0x1"], /--payer: an address/], [["check", "invoices/acme-design.txt", "--mode", "twice"], /--mode/], [["verify", "--tx", "0x12"], /verify needs --tx/], [["assemble", ".invoice/INV-2026-0142.json", "--sig", "0x1"], /--sig 0x…/], [["check", "invoices/acme-design.txt", "--bogus"], /unknown flag/]]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(" ")} → ${r.status}`);
    assert.match(r.stderr, re);
    assert.ok(!/at .*\.js:\d+/.test(r.stderr), "no stack trace");
  }
});

async function api(body, method = "POST") {
  const req = Object.assign(async function* () {}(), { method, url: "/api/check", body });
  return new Promise((resolve) => handler(req, { writeHead: (status) => ({ end: (s) => resolve({ status, json: JSON.parse(s) }) }) }));
}
await check("API: text and PDF read and checked live; bad input is a 400", async () => {
  const t = await api({ text: readFileSync(new URL("invoices/lumen-payment-request.txt", root), "utf8"), payer: PAYER });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.json.decision, "ready");
  assert.equal(t.json.extraction.format, "eip681");
  const p = await api({ pdfBase64: readFileSync(new URL("invoices/acme-design-new-wallet.pdf", root)).toString("base64"), name: "x.pdf" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.decision, "blocked");
  assert.ok(p.json.flags.some((f) => f.code === "payee-changed"));
  for (const [b, m] of [[{}], [{ text: " " }], [{ pdfBase64: Buffer.from("hello").toString("base64") }], [{ text: "x", payer: "0x1" }], [[1]], [{ text: "x" }, "GET"]]) {
    const r = await api(b, m);
    assert.ok([400, 405].includes(r.status), `${JSON.stringify(b)} → ${r.status}`);
    assert.equal(r.json.ok, false);
  }
  const broken = await api({ pdfBase64: Buffer.from("%PDF-1.7 broken").toString("base64") });
  assert.equal(broken.status, 400, JSON.stringify(broken.json));
});

if (process.argv.includes("--fork")) {
  await check("fork: three invoices paid and read back (memo, payee, amount); a second payment refused; the wrong invoice does not match", async () => {
    const r = spawnSync(process.execPath, ["scripts/fork-proof.js"], { encoding: "utf8", cwd: root, timeout: 600_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal((r.stdout.match(/matches invoice: true/g) ?? []).length, 3);
    assert.match(r.stdout, /check → blocked: Invoice INV-2026-0142 to this payee was already paid by this wallet — transaction 0x/);
    assert.match(r.stdout, /re-sent → reverted: FiatTokenV2: authorization is used or canceled/);
    assert.match(r.stdout, /matches: false \(reference, payee, amount differ\)/);
  });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
