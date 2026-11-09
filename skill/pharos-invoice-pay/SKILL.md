---
name: pharos-invoice-pay
description: Read an invoice or payment request — e-mail/plain text, PDF, structured JSON (simple or UBL-style) or an EIP-681 wallet link — and prepare the matching payment on Pharos Pacific Mainnet (USDC, WPROS or PROS). Every field is shown with the line it came from; missing fields and disagreements (totals that do not add up, words vs digits, a checksum typo, a known vendor asking to be paid at a new address, ambiguous separators or dates, a currency with no token, the wrong network, already paid) are flagged instead of guessed. The unsigned transaction carries the invoice reference on chain; for USDC the invoice can be paid only once. Use for "pay this invoice", "prepare payment from this PDF", "is this invoice OK to pay", "did we pay invoice X" on Pharos.
license: MIT
metadata:
  author: juhzinho
  version: "1.0.0"
  chain: "Pharos Pacific Mainnet (1672)"
---

# Pharos Invoice Pay

A Skill for an agent that turns invoices into payments without guessing.

```
invoice (text | PDF | JSON | EIP-681) ─▶ fields, each with its source line ─▶ checks ─┬─ BLOCKED: what is wrong, where
                                                                                     └─ READY / REVIEW: summary +
                    unsigned tx with "inv:<reference>" in its data  (USDC "once": nonce = keccak(payee, reference))
```

## When to use

- The user hands over an invoice, a bill, a payment request or a wallet link and wants it paid on Pharos.
- The user asks whether an invoice is safe to pay, or why it was stopped.
- The user asks whether a transaction paid a given invoice (`verify --tx`).

## What it checks (blocks unless noted)

Missing reference / payee / amount / currency · two different values for one of them · an address whose checksum
does not match (a typo) · **a vendor in the vendor book asking to be paid at a different address** · subtotal + tax
≠ total · line items ≠ subtotal · total ≠ amount due without a stated prepayment · amount in words ≠ digits · a
separator that could be thousands or decimals (`1.850`) · a currency with no token (EUR, GBP…; USD is paid 1:1 in
USDC only while the Chainlink USDC/USD feed is within 0.5 %) · a chain other than Pharos Pacific · the payer's
balance · the payee blacklisted by USDC · **already paid** (USDC "once": the invoice's nonce is consumed — the
paying transaction is found). Warnings: overdue, an ambiguous date, a payee not in the vendor book, a payee that is
a contract, no PROS for gas.

## How to run it

The executable lives in the repository root (`tasks/invoice/invoice.js`). From there:

```bash
npm install
npm run invoice -- check invoices/acme-design.txt --payer 0x…            # read, check, prepare (exit 3 if blocked)
npm run invoice -- check invoices/northwind-hosting.pdf --mode direct     # a transfer + memo instead of "once"
npm run invoice -- assemble .invoice/INV-2026-0142.json --sig 0x…         # "once": the payer's signature → unsigned tx
npm run invoice -- verify --tx 0x… --invoice invoices/acme-design.txt     # read a payment back: memo, what moved, match
npm run invoice -- demo                                                    # the clean samples paid on an Anvil fork
```

The vendor book (`invoices/vendors.json`, or `--vendors`) holds the payee addresses the payer has confirmed out of
band. Formats and flags: [references/formats.md](references/formats.md). Contracts and how they were confirmed:
[references/contracts.md](references/contracts.md).

## Rules for the agent

1. **Never resolve a flag yourself.** A blocked invoice goes back to the person with the flag and its source line;
   never pick one of two conflicting values, never convert a currency at a rate you looked up, never "fix" an address.
2. A `payee-changed` flag is a fraud signal: tell the person to confirm the new address with the vendor through a
   channel they already trust (not the e-mail or PDF that asked for the change).
3. Show the summary and the memo before the transaction; the payer's wallet signs. Never hold a key.
4. After a payment, `verify` it and report the reference read from chain and what actually moved.
