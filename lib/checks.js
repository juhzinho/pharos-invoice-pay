import { getAddress } from "viem";
import { ABI, FEEDS, TOKENS } from "./contracts.js";
import { checkAddress } from "./extract.js";
import { fromUnits, toUnits } from "./money.js";
import { directTx, findInvoicePayment, invoiceNonce, invoiceUsed, memoOf, onceTypedData } from "./pay.js";

// From an extraction to a decision. Nothing is guessed: a gap or a disagreement becomes a flag that says what is
// wrong and where in the document it is.
//   block — no payment is prepared until a person resolves it
//   warn  — the payment is prepared; read this before signing
//   info  — how something was read or converted
const PEG_TOLERANCE = 0.005; // USD invoices are paid in USDC 1:1 only while USDC/USD is within 0.5 %

const flag = (severity, code, message, extra = {}) => ({ severity, code, message, ...extra });
const where = (f) => f?.source ?? null;
const normName = (s) => String(s ?? "").toLowerCase().replace(/<.*?>/g, "").replace(/\b(ltd|llc|inc|gmbh|sa|ltda|limited|co)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export async function analyze(ex, { client, payer = null, vendors = [], now = Math.floor(Date.now() / 1000), mode = "auto" } = {}) {
  const f = ex.fields ?? {};
  const flags = [];
  if (ex.error) flags.push(flag("block", "unreadable", ex.error));

  // 1 · required fields
  const need = { reference: "invoice number or reference", payee: "payee address", amount: "amount to pay", currency: "currency or token" };
  for (const [k, what] of Object.entries(need)) {
    const conflicted = ex.conflicts?.some((c) => c.field === k);
    if (!f[k]?.value && !conflicted && !f[k]?.ambiguous) flags.push(flag("block", `missing-${k}`, `No ${what} found in the document.`, { field: k }));
  }
  // 2 · disagreements inside the document
  for (const c of ex.conflicts ?? []) flags.push(flag("block", `conflict-${c.field}`, `${c.why}: ${c.values.map((v) => v.value).join(" vs ")} — not choosing one.`, { field: c.field, sources: c.values.map((v) => v.source).filter(Boolean) }));
  for (const k of ["amount", "total", "subtotal", "tax"]) if (f[k]?.ambiguous) flags.push(flag("block", `ambiguous-${k}`, `The ${k} ${f[k].ambiguous}.`, { field: k, source: where(f[k]) }));

  // 3 · payee address
  let payee = null;
  if (f.payee?.value) {
    const a = checkAddress(f.payee.value);
    if (!a.ok) flags.push(flag("block", "payee-address", `Payee address ${f.payee.value}: ${a.why}.`, { field: "payee", source: where(f.payee) }));
    else {
      payee = a.address;
      if (!a.checksummed) flags.push(flag("info", "payee-no-checksum", "The payee address is written without a checksum (all lower- or upper-case), so a typo in it cannot be detected — compare it with the vendor book.", { field: "payee", source: where(f.payee) }));
      if (f.payee.labelled === false) flags.push(flag("warn", "payee-unlabelled", "The only address in the document is not next to a “pay to / wallet” label.", { field: "payee", source: where(f.payee) }));
    }
  }

  // 4 · currency → token (never converted at a guessed rate)
  let token = null;
  let peg = null;
  const cur = f.currency?.value;
  if (cur === "USDC" || cur === "WPROS" || cur === "PROS") token = cur;
  else if (cur === "USD") {
    token = "USDC";
    if (client) {
      const [, answer] = await client.readContract({ address: FEEDS.USDC_USD, abi: ABI.feed, functionName: "latestRoundData" });
      peg = Number(answer) / 1e18;
    }
    if (peg != null && Math.abs(1 - peg) > PEG_TOLERANCE) flags.push(flag("block", "usdc-peg", `The invoice is in US dollars and USDC/USD is ${peg.toFixed(4)} (Chainlink) — more than 0.5 % off the peg, so 1 USDC is not 1 dollar right now.`, { field: "currency" }));
    else flags.push(flag("info", "usd-as-usdc", `The invoice is in US dollars: paid 1:1 in USDC${peg != null ? ` (USDC/USD ${peg.toFixed(4)} on the Chainlink feed)` : ""}.`, { field: "currency", source: where(f.currency) }));
  } else if (cur) {
    flags.push(flag("block", "currency-unsupported", `The invoice is in ${cur}. There is no ${cur} token here, and converting at a rate the invoice does not state would be a guess — ask the payee for a ${["EUR", "GBP", "BRL"].includes(cur) ? "USD/USDC" : "USDC"} amount.`, { field: "currency", source: where(f.currency) }));
  }
  if (f.currency?.unknownToken) flags.push(flag("block", "token-unknown", `The payment request names token ${f.currency.unknownToken}, which is not USDC or WPROS on Pacific.`, { field: "currency", source: where(f.currency) }));

  // 5 · amount in token units, and the arithmetic of the document
  let units = null;
  const dec = token ? TOKENS[token].decimals : 6;
  if (f.amount?.value && token) {
    try {
      units = toUnits(f.amount.value, dec);
      if (units === 0n) { flags.push(flag("block", "amount-zero", "The amount due is zero.", { field: "amount", source: where(f.amount) })); units = null; }
    } catch (e) {
      flags.push(flag("block", "amount-precision", `Amount ${f.amount.value}: ${e.message}.`, { field: "amount", source: where(f.amount) }));
    }
  }
  const val = (x) => (x?.value != null && !x.ambiguous ? toUnits(x.value, 6 + 12) : null); // exact comparison scale
  const show = (u) => fromUnits(u, 18, 6);
  const A = val(f.amount), T = val(f.total), S = val(f.subtotal), X = val(f.tax), P = val(f.paid);
  const items = (f.lineItems ?? []).map(val);
  if (S != null && X != null && (T ?? A) != null && S + X !== (T ?? A) && !(P != null && S + X - P === A)) flags.push(flag("block", "sum-tax", `Subtotal ${show(S)} + tax ${show(X)} = ${show(S + X)}, but the ${T != null ? "total" : "amount due"} is ${show(T ?? A)}.`, { field: "amount", sources: [where(f.subtotal), where(f.tax), where(f.total ?? f.amount)].filter(Boolean) }));
  // a subtotal with no tax line must be what is payable (unless a payment already made explains the difference)
  if (S != null && X == null && (T ?? A) != null && S !== (T ?? A) && !(P != null && S - P === A)) flags.push(flag("block", "subtotal-vs-due", `The subtotal is ${show(S)} but the ${T != null ? "total" : "amount due"} is ${show(T ?? A)}, and the document states no tax or other charge that explains the difference.`, { field: "amount", sources: [where(f.subtotal), where(f.total ?? f.amount)] }));
  if (items.length && items.every((v) => v != null)) {
    const sum = items.reduce((a, b) => a + b, 0n);
    const against = S ?? (X == null ? T ?? A : null);
    if (against != null && sum !== against) flags.push(flag("block", "sum-lines", `The line items add up to ${show(sum)}, but the ${S != null ? "subtotal" : T != null ? "total" : "amount due"} is ${show(against)}.`, { field: "amount", sources: [...(f.lineItems ?? []).map(where), where(f.subtotal ?? f.total ?? f.amount)].filter(Boolean) }));
  }
  if (T != null && A != null && T !== A) {
    if (P != null && T - P === A) flags.push(flag("info", "partly-paid", `Total ${show(T)} less ${show(P)} already paid = ${show(A)} due.`, { field: "amount" }));
    else flags.push(flag("block", "total-vs-due", `The total is ${show(T)} but the amount due is ${show(A)}, and nothing in the document explains the difference.`, { field: "amount", sources: [where(f.total), where(f.amount)] }));
  }
  if (f.amountInWords) {
    if (f.amountInWords.value == null) flags.push(flag("warn", "words-unread", `The amount in words (“${f.amountInWords.raw}”) could not be read as a number — check it against ${f.amount?.value ?? "the amount"} yourself.`, { field: "amount", source: where(f.amountInWords) }));
    else if (A != null && val(f.amountInWords) !== A) flags.push(flag("block", "words-vs-digits", `The amount in words says ${show(val(f.amountInWords))} (“${f.amountInWords.raw}”), the digits say ${show(A)}.`, { field: "amount", sources: [where(f.amountInWords), where(f.amount)] }));
  }

  // 6 · network
  if (f.chainId?.value != null && f.chainId.value !== 1672) flags.push(flag("block", "wrong-network", `The invoice asks for payment on chain ${f.chainId.value} (“${f.chainId.raw}”), not Pharos Pacific (1672).`, { field: "chainId", source: where(f.chainId) }));
  else if (f.chainId?.value == null) flags.push(flag("info", "network-unstated", "The invoice does not name a network; this prepares a payment on Pharos Pacific (1672) — make sure the payee expects it there.", { field: "chainId" }));

  // 7 · dates (they never change the payment; they tell the person what they are looking at)
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  for (const k of ["dueDate", "issueDate"]) if (f[k]?.ambiguous) flags.push(flag("warn", `ambiguous-${k}`, `The ${k === "dueDate" ? "due date" : "invoice date"} ${f[k].ambiguous}.`, { field: k, source: where(f[k]) }));
  if (f.dueDate?.value && f.dueDate.value < today) flags.push(flag("warn", "overdue", `Overdue: it was due on ${f.dueDate.value}.`, { field: "dueDate", source: where(f.dueDate) }));
  if (f.issueDate?.value && f.issueDate.value > today) flags.push(flag("warn", "future-issue", `The invoice is dated in the future (${f.issueDate.value}).`, { field: "issueDate", source: where(f.issueDate) }));

  // 8 · the vendor book: a known vendor asking to be paid somewhere new is the classic invoice fraud
  let vendor = null;
  if (vendors.length) {
    const byName = f.payeeName?.value ? vendors.find((v) => normName(v.name) && (normName(f.payeeName.value).includes(normName(v.name)) || normName(v.name).includes(normName(f.payeeName.value)))) : null;
    const byAddr = payee ? vendors.find((v) => getAddress(v.address) === payee) : null;
    vendor = byAddr ?? byName ?? null;
    if (byName && payee && getAddress(byName.address) !== payee) flags.push(flag("block", "payee-changed", `The invoice is from “${byName.name}”, but asks to be paid at ${payee} — the address on file for ${byName.name} is ${getAddress(byName.address)}. Confirm with the vendor through a channel you already trust before paying.`, { field: "payee", sources: [where(f.payeeName), where(f.payee)] }));
    else if (byAddr && byName && byAddr !== byName) flags.push(flag("block", "payee-other-vendor", `The address belongs to “${byAddr.name}” in the vendor book, but the invoice is from “${byName.name}”.`, { field: "payee" }));
    else if (!vendor && payee) flags.push(flag("warn", "payee-new", "This payee is not in the vendor book: a first payment to a new address — confirm it out of band.", { field: "payee", source: where(f.payee) }));
    else if (vendor) flags.push(flag("info", "payee-known", `Payee matches the vendor book: ${vendor.name}.`, { field: "payee" }));
  }

  // 9 · the chain: payee, payer, already paid?
  const chosen = mode === "auto" ? (token === "USDC" ? "once" : "direct") : mode;
  if (chosen === "once" && token && token !== "USDC") flags.push(flag("block", "mode", `“once” needs USDC (EIP-3009); this invoice is in ${token}.`));
  let chain = null;
  if (client && payee) {
    const head = await client.getBlock();
    const [code, payeeBl, payerBl, bal, pros, used] = await Promise.all([
      client.getCode({ address: payee, blockNumber: head.number }),
      token === "USDC" ? client.readContract({ address: TOKENS.USDC.address, abi: ABI.usdc, functionName: "isBlacklisted", args: [payee], blockNumber: head.number }) : false,
      token === "USDC" && payer ? client.readContract({ address: TOKENS.USDC.address, abi: ABI.usdc, functionName: "isBlacklisted", args: [payer], blockNumber: head.number }) : false,
      payer && token ? (token === "PROS" ? client.getBalance({ address: payer, blockNumber: head.number }) : client.readContract({ address: TOKENS[token].address, abi: ABI.erc20, functionName: "balanceOf", args: [payer], blockNumber: head.number })) : null,
      payer ? client.getBalance({ address: payer, blockNumber: head.number }) : null,
      payer && token === "USDC" && f.reference?.value ? invoiceUsed(client, payer, payee, f.reference.value, head.number) : false,
    ]);
    chain = { block: Number(head.number), timestamp: Number(head.timestamp), baseFeeGwei: Number(head.baseFeePerGas ?? 0n) / 1e9 };
    if (code && code !== "0x") flags.push(flag(code.startsWith("0xef0100") ? "info" : "warn", "payee-contract", code.startsWith("0xef0100") ? "The payee address has an EIP-7702 delegation (it is still a key-held account)." : "The payee address is a contract, not a wallet — make sure it can receive and forward the funds.", { field: "payee" }));
    if (payeeBl) flags.push(flag("block", "payee-blacklisted", "USDC has blacklisted the payee address: the transfer would revert.", { field: "payee" }));
    if (payerBl) flags.push(flag("block", "payer-blacklisted", "USDC has blacklisted the paying wallet.", { field: "payer" }));
    if (bal != null && units != null && bal < units) flags.push(flag("block", "balance", `The paying wallet holds ${fromUnits(bal, dec)} ${token}; the invoice is ${fromUnits(units, dec)} ${token}.`, { field: "payer" }));
    if (pros === 0n && chosen === "direct") flags.push(flag("warn", "no-gas", "The paying wallet has no PROS to pay gas for a direct transfer.", { field: "payer" }));
    if (used) {
      const found = await findInvoicePayment(client, payer, payee, f.reference.value, { head: head.number, since: head.number > 2_000_000n ? head.number - 2_000_000n : 1n });
      flags.push(flag("block", "already-paid", `Invoice ${f.reference.value} to this payee was already paid by this wallet${found?.hash ? ` — transaction ${found.hash} (block ${found.block})` : ""}. USDC would refuse a second payment with the same invoice fingerprint.`, { field: "reference", tx: found?.hash ?? null }));
    }
    if (bal != null) chain.payerBalance = fromUnits(bal, dec);
  }

  // 10 · the decision and, when nothing blocks, the payment
  const blocked = flags.filter((x) => x.severity === "block");
  const resolved = {
    reference: f.reference?.value ?? null, payee, payeeName: f.payeeName?.value ?? vendor?.name ?? null, token, units: units?.toString() ?? null,
    amount: units != null && token ? fromUnits(units, dec, dec) : null, dueDate: f.dueDate?.value ?? null, payer, mode: chosen,
    memo: f.reference?.value ? `inv:${f.reference.value}` : null, memoHex: f.reference?.value ? memoOf(f.reference.value) : null,
    fingerprint: payee && f.reference?.value ? invoiceNonce(payee, f.reference.value) : null,
  };
  const out = { format: ex.format, name: ex.name, decision: blocked.length ? "blocked" : flags.some((x) => x.severity === "warn") ? "review" : "ready", flags: sortFlags(flags), resolved, chain, peg };
  if (blocked.length) return { ...out, summary: `Not prepared: ${blocked.length} problem${blocked.length > 1 ? "s" : ""} to resolve first — ${blocked.map((b) => b.code).join(", ")}.` };

  out.summary = `Pay ${resolved.amount} ${token} to ${resolved.payeeName ? `${resolved.payeeName} ` : ""}(${payee}) for invoice ${resolved.reference}${resolved.dueDate ? `, due ${resolved.dueDate}` : ""}. The reference travels on chain as “${resolved.memo}”.`;
  if (chosen === "once") {
    if (!payer) out.next = "set the paying wallet (--payer) to prepare the authorization it signs";
    else out.sign = { kind: "eip3009", typedData: onceTypedData({ payer, payee, units, reference: resolved.reference }, { now: chain?.timestamp ?? now }), note: "one EIP-712 signature (eth_signTypedData_v4); its nonce is this invoice's fingerprint, so it can be paid once" };
  } else {
    out.tx = directTx({ payer, payee, units, token, reference: resolved.reference });
    if (client) out.tx.gas = toHexGas(await client.estimateGas({ account: payer ?? payee, to: out.tx.to, data: out.tx.data, value: BigInt(out.tx.value) }).catch(() => null));
  }
  return out;
}

const toHexGas = (g) => (g == null ? undefined : `0x${((g * 12n) / 10n).toString(16)}`);
const sortFlags = (fs) => [...fs].sort((a, b) => ["block", "warn", "info"].indexOf(a.severity) - ["block", "warn", "info"].indexOf(b.severity));
