import { concat, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, hexToString, keccak256, parseSignature, size, slice, stringToHex, toHex } from "viem";
import { ABI, CHAIN_ID, TOKENS, TYPES, USDC_DOMAIN } from "./contracts.js";

// The payment that matches an invoice, with the invoice reference ON CHAIN:
//   memo — the bytes "inv:<reference>" appended after the call's ABI arguments. Token contracts ignore trailing
//          calldata (checked on Pacific for USDC, WPROS and a plain PROS transfer); explorers show it in the input
//          data, and `verify` reads it back from the transaction.
//   once — for USDC: an EIP-3009 authorization whose nonce is the invoice's fingerprint keccak(payee, reference).
//          USDC accepts a nonce once per payer, so that invoice number can be paid to that payee only once — even if
//          two people press "pay". The signed authorization is then sent as an unsigned transaction (any sender).
//   direct — a plain transfer from the payer (USDC, WPROS) or a PROS transfer, carrying the memo.

export const MEMO_PREFIX = "inv:";
export const memoOf = (reference) => stringToHex(`${MEMO_PREFIX}${reference}`);

/** An invoice's on-chain identity for one payee: the same reference to the same payee is the same invoice. */
export const invoiceNonce = (payee, reference) => keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "string" }], ["pharos-invoice-pay/v1", getAddress(payee), normRef(reference)]));
export const normRef = (r) => String(r).trim().toUpperCase().replace(/\s+/g, "");

export function directTx(p) {
  const memo = memoOf(p.reference);
  if (p.token === "PROS") return { chainId: CHAIN_ID, from: p.payer ?? undefined, to: p.payee, value: toHex(p.units), data: memo };
  const t = TOKENS[p.token];
  return { chainId: CHAIN_ID, from: p.payer ?? undefined, to: t.address, value: "0x0", data: concat([encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [p.payee, p.units] }), memo]) };
}

/** What the payer signs for "once" (USDC): valid from now for `days`, nonce = the invoice's fingerprint. */
export function onceTypedData(p, { now, days = 14 }) {
  return { domain: USDC_DOMAIN, types: { TransferWithAuthorization: TYPES.TransferWithAuthorization }, primaryType: "TransferWithAuthorization", message: { from: p.payer, to: p.payee, value: p.units, validAfter: 0n, validBefore: BigInt(now + days * 86400), nonce: invoiceNonce(p.payee, p.reference) } };
}

/** The signed authorization as an unsigned transaction (any sender), with the memo. */
export function onceTx(typed, signature, reference) {
  const m = typed.message;
  const { r, s, v, yParity } = parseSignature(signature);
  const data = encodeFunctionData({ abi: ABI.usdc, functionName: "transferWithAuthorization", args: [m.from, m.to, BigInt(m.value), BigInt(m.validAfter), BigInt(m.validBefore), m.nonce, Number(v ?? 27n + BigInt(yParity)), r, s] });
  return { chainId: CHAIN_ID, to: TOKENS.USDC.address, value: "0x0", data: concat([data, memoOf(reference)]) };
}

/** Splits calldata into the call and the memo after its ABI arguments. */
export function readMemo(data) {
  const sel = slice(data, 0, 4);
  const argBytes = { "0xa9059cbb": 64, "0xe3ee160e": 9 * 32 }[sel]; // transfer, transferWithAuthorization
  const tail = argBytes == null ? data : size(data) > 4 + argBytes ? slice(data, 4 + argBytes) : null;
  if (!tail || tail === "0x") return null;
  let text;
  try {
    text = hexToString(tail);
  } catch {
    return null;
  }
  return text.startsWith(MEMO_PREFIX) ? text.slice(MEMO_PREFIX.length) : null;
}

/**
 * Reads a payment back from the chain: the memo in the transaction's input, and what actually moved (Transfer
 * logs for tokens, the value for PROS). Says whether it matches the invoice.
 */
export async function verifyPayment(client, hash, expected = null) {
  const [tx, rc] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const reference = readMemo(tx.input);
  let paid = null;
  if (tx.to && Object.values(TOKENS).some((t) => t.address === getAddress(tx.to))) {
    const token = Object.values(TOKENS).find((t) => t.address === getAddress(tx.to));
    for (const log of rc.logs) {
      if (getAddress(log.address) !== token.address) continue;
      try {
        const d = decodeEventLog({ abi: ABI.erc20, data: log.data, topics: log.topics });
        if (d.eventName === "Transfer") paid = { token: token.symbol, from: d.args.from, to: d.args.to, units: d.args.value.toString() };
      } catch {}
    }
    if (!paid && rc.status === "success") {
      try {
        const call = decodeFunctionData({ abi: tx.input.startsWith("0xa9059cbb") ? ABI.erc20 : ABI.usdc, data: tx.input });
        paid = { token: token.symbol, from: tx.from, to: call.args[call.functionName === "transfer" ? 0 : 1], units: null };
      } catch {}
    }
  } else if (tx.value > 0n) {
    paid = { token: "PROS", from: tx.from, to: tx.to, units: tx.value.toString() };
  }
  const result = { hash, block: Number(rc.blockNumber), status: rc.status, reference, paid };
  if (expected) {
    const checks = [
      ["reference", normRef(reference ?? "") === normRef(expected.reference), reference, expected.reference],
      ["payee", paid?.to && getAddress(paid.to) === getAddress(expected.payee), paid?.to, expected.payee],
      ["amount", paid?.units === String(expected.units), paid?.units, String(expected.units)],
      ["token", paid?.token === expected.token, paid?.token, expected.token],
      ["status", rc.status === "success", rc.status, "success"],
    ];
    result.matches = checks.every((c) => c[1]);
    result.checks = checks.map(([what, ok, got, want]) => ({ what, ok, got, want }));
  }
  return result;
}

/** For "once": has this invoice already been paid by this payer? (its nonce consumed on USDC) */
export const invoiceUsed = (client, payer, payee, reference, blockNumber) =>
  client.readContract({ address: TOKENS.USDC.address, abi: ABI.usdc, functionName: "authorizationState", args: [payer, invoiceNonce(payee, reference)], ...(blockNumber != null ? { blockNumber } : {}) });

/** Finds the transaction that consumed an invoice's nonce: binary search on authorizationState, then that block's log. */
export async function findInvoicePayment(client, payer, payee, reference, { since = 1n, head } = {}) {
  let hi = head ?? (await client.getBlockNumber());
  if (!(await invoiceUsed(client, payer, payee, reference, hi))) return null;
  let lo = BigInt(since);
  const at = (n) => invoiceUsed(client, payer, payee, reference, n).catch(() => false);
  if (await at(lo)) return { block: Number(lo), hash: null, note: "paid before the searched range" };
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await at(mid)) hi = mid;
    else lo = mid;
  }
  const logs = await client.getLogs({ address: TOKENS.USDC.address, event: ABI.usdc.find((x) => x.name === "AuthorizationUsed"), args: { authorizer: payer, nonce: invoiceNonce(payee, reference) }, fromBlock: hi, toBlock: hi });
  return { block: Number(hi), hash: logs[0]?.transactionHash ?? null };
}
