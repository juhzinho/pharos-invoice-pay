// The sample invoices paid for real on an Anvil fork of Pharos Pacific, then read back from the chain.
// Fresh test keys (generated per run, funded on the fork only) play the payer and a relayer. The agent reads,
// checks and prepares; the payer's key signs; the transactions are sent exactly as prepared.
//   1  Acme (e-mail, USD → USDC, "once"): the payer signs one authorization; a relayer sends it with the memo
//   2  Northwind (PDF, "direct"): a USDC transfer from the payer with the memo
//   3  Lumen (EIP-681, "once"): sent by an unrelated account — any sender works
//   4  every payment read back from chain: the memo decoded from the input data, what moved, matched to its invoice
//   5  Acme again: the check finds it already paid (and which transaction); the same authorization re-sent is refused
//   6  a transaction checked against the wrong invoice does not match
// Writes .invoice-proof/fork-proof.json; with --record, public/runs/fork-proof.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, pad, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startFork } from "../lib/fork.js";
import { CHAIN_ID, TOKENS, balanceSlot } from "../lib/contracts.js";

const fork = await startFork({ port: Number(process.env.FORK_PORT ?? 8553) });
process.env.PHAROS_RPC_URL = fork.url;
const { makeClient } = await import("../lib/chain.js");
const { extract } = await import("../lib/extract.js");
const { analyze } = await import("../lib/checks.js");
const { onceTx, verifyPayment } = await import("../lib/pay.js");

const chain = { id: CHAIN_ID, name: "Pacific fork", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [fork.url] } } };
const pub = createPublicClient({ chain, transport: http(fork.url, { timeout: 120_000 }) });
const rpc = (method, params = []) => pub.request({ method, params });
const client = makeClient();
const log = (m) => console.log(m);
const vendors = JSON.parse(await readFile(new URL("../invoices/vendors.json", import.meta.url), "utf8")).vendors;
const wallet = async (pk = generatePrivateKey()) => {
  const account = privateKeyToAccount(pk);
  await rpc("anvil_setBalance", [account.address, "0x56BC75E2D63100000"]); // 100 PROS, fork only
  return { account, w: createWalletClient({ account, chain, transport: http(fork.url) }) };
};
const read = async (f) => { const b = await readFile(new URL(`../invoices/${f}`, import.meta.url)); return extract(b.toString("utf8"), { name: f, bytes: b }); };
const reviveTyped = (t) => ({ ...t, message: { ...t.message, value: BigInt(t.message.value), validAfter: BigInt(t.message.validAfter), validBefore: BigInt(t.message.validBefore) } });
const send = async (w, tx, extra = {}) => pub.waitForTransactionReceipt({ hash: await w.w.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), ...extra }) });

const out = { recordedAt: new Date().toISOString(), network: "Anvil fork of Pharos Pacific", note: "test wallets: fresh keys funded on the fork only", payments: [], steps: [] };
try {
  const payer = await wallet();
  const relayer = await wallet();
  out.forkBlock = Number(await pub.getBlockNumber());
  await rpc("anvil_setStorageAt", [TOKENS.USDC.address, balanceSlot(TOKENS.USDC, payer.account.address), pad(toHex(10_000n * 10n ** 6n))]);
  out.payer = payer.account.address;
  log(`payer ${payer.account.address} funded with 10,000 USDC on the fork`);

  async function pay(file, { mode, sender }) {
    const ex = await read(file);
    const r = await analyze(ex, { client, payer: payer.account.address, vendors, mode });
    if (r.decision === "blocked") throw new Error(`${file} blocked: ${r.summary}`);
    let tx;
    if (r.sign) tx = onceTx(reviveTyped(r.sign.typedData), await payer.account.signTypedData(reviveTyped(r.sign.typedData)), r.resolved.reference);
    else tx = r.tx;
    const by = sender ?? payer;
    const rc = await send(by, tx);
    const v = await verifyPayment(client, rc.transactionHash, r.resolved);
    const row = { invoice: file, format: ex.format, mode: r.resolved.mode, reference: r.resolved.reference, payee: r.resolved.payee, amount: `${r.resolved.amount} ${r.resolved.token}`, sentBy: by === payer ? "the payer" : by.label, hash: rc.transactionHash, gasUsed: rc.gasUsed.toString(), status: rc.status, inputTail: tx.data.slice(-2 * (4 + r.resolved.reference.length)), verify: v, signed: r.sign ? "one EIP-712 authorization" : "the transaction itself" };
    out.payments.push(row);
    log(`  ${file} [${ex.format}, ${r.resolved.mode}] → ${rc.status} ${rc.transactionHash.slice(0, 12)}… · memo on chain “inv:${v.reference}” · matches invoice: ${v.matches}`);
    return { r, tx, rc, v };
  }

  log("1-3. pay the three clean invoices");
  relayer.label = "a relayer";
  const acme = await pay("acme-design.txt", { mode: "auto", sender: relayer });
  await pay("northwind-hosting.pdf", { mode: "direct" });
  const other = await wallet(); // yet another account: an EIP-3009 authorization does not care who submits it
  other.label = "an unrelated account";
  await pay("lumen-payment-request.txt", { mode: "auto", sender: other });

  log("5. Acme's invoice again");
  const again = await analyze(await read("acme-design.txt"), { client, payer: payer.account.address, vendors });
  const dup = again.flags.find((f) => f.code === "already-paid");
  log(`  check → ${again.decision}: ${dup?.message}`);
  const replay = await send(relayer, acme.tx, { gas: 200_000n });
  const why = await client.call({ account: relayer.account.address, to: acme.tx.to, data: acme.tx.data }).then(() => "accepted?!", (e) => String(e.details ?? e.shortMessage).replace(/^execution reverted:?\s*/i, ""));
  log(`  the same authorization re-sent → ${replay.status}: ${why}`);
  out.steps.push({ step: "already paid", decision: again.decision, flag: dup ?? null, foundTx: dup?.tx ?? null, sameAsFirst: dup?.tx === acme.rc.transactionHash, replay: { hash: replay.transactionHash, status: replay.status, reason: why } });

  log("6. a payment checked against the wrong invoice");
  const wrong = await analyze(await read("lumen-payment-request.txt"), { client: null, vendors: [] });
  const mismatch = await verifyPayment(client, acme.rc.transactionHash, wrong.resolved);
  log(`  Acme's transaction vs Lumen's invoice → matches: ${mismatch.matches} (${mismatch.checks.filter((c) => !c.ok).map((c) => c.what).join(", ")} differ)`);
  out.steps.push({ step: "wrong invoice", tx: acme.rc.transactionHash, invoice: "lumen-payment-request.txt", matches: mismatch.matches, differ: mismatch.checks.filter((c) => !c.ok).map((c) => c.what) });

  const target = process.argv.includes("--record") ? "public/runs/fork-proof.json" : ".invoice-proof/fork-proof.json";
  await mkdir(".invoice-proof", { recursive: true });
  await writeFile(target, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log(`wrote ${target}`);
} finally {
  fork.stop();
}
process.exit(0);
