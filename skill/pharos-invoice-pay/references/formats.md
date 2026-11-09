# Invoice formats

| format | how it is read | where a field comes from |
|---|---|---|
| text / e-mail | label rules per line: `Invoice number`, `Reference`, `Pay to` / `Wallet` / `Payee`, `Amount due` / `Balance due` / `Total`, `Subtotal`, `Tax`, `Due date`, `Invoice date`, `Network`, `Amount in words`, `From`; a line-item table after a header with “Description … Amount” | `line N: “…”` |
| PDF | pdf.js text runs grouped by baseline into lines; a wide horizontal gap becomes a column break, so “Label   value” layouts read like “Label: value” | `line N` of the rebuilt text |
| JSON | a simple schema (`invoiceNumber`, `payee.address`, `amountDue`, `currency`, `lineItems[]`, `dueDate`, `chainId`) or UBL-style keys (`ID`, `PayeeParty.EndpointID`, `LegalMonetaryTotal.PayableAmount{value,currencyID}`, `LineExtensionAmount`, `TaxTotal.TaxAmount`, `InvoiceLine[]`, `DocumentCurrencyCode`) | the JSON path |
| EIP-681 | `ethereum:<token>@<chainId>/transfer?address=<payee>&uint256=<base units>` or `ethereum:<payee>@<chainId>?value=<wei>`; the text around it is read too, and a disagreement between text and URI is a conflict | `line N · URI <param>` |

## Amounts

Parsed as exact decimal strings. `1,250.00`, `1.250,00`, `1 250,00` are unambiguous. A single separator followed by
exactly three digits (`1,250`, `1.850`) is decided by the document's other numbers (a `,dd` or `.dd` elsewhere);
otherwise it is flagged `ambiguous-*`. A leading zero (`0.125`) is always a decimal.

## Dates

ISO, `Nov 24, 2026`, `30 November 2026`; `dd/mm/yyyy` vs `mm/dd/yyyy` only when one number is above 12 — else flagged.

## Flags

| code | severity |
|---|---|
| `missing-reference`, `missing-payee`, `missing-amount`, `missing-currency` | block |
| `conflict-<field>` (two values for one field) | block |
| `ambiguous-amount` / `-total` / `-subtotal` / `-tax` | block |
| `payee-address` (not an address / checksum typo) | block |
| `payee-changed`, `payee-other-vendor` (vendor book) | block |
| `sum-tax`, `subtotal-vs-due`, `sum-lines`, `total-vs-due`, `words-vs-digits` | block |
| `currency-unsupported`, `token-unknown`, `usdc-peg`, `wrong-network` | block |
| `balance`, `payee-blacklisted`, `payer-blacklisted`, `already-paid`, `amount-zero`, `amount-precision`, `mode` | block |
| `overdue`, `future-issue`, `ambiguous-dueDate`, `ambiguous-issueDate`, `payee-new`, `payee-unlabelled`, `payee-contract`, `no-gas`, `words-unread` | warn |
| `usd-as-usdc`, `payee-known`, `payee-no-checksum`, `network-unstated`, `partly-paid` | info |

## The memo

`inv:<reference>` as UTF-8 bytes appended after the call's ABI arguments (`transfer`, `transferWithAuthorization`) or
as the `data` of a PROS transfer. `verify` reads it back from the transaction input. USDC "once": the authorization
nonce is `keccak256(abi.encode("pharos-invoice-pay/v1", payee, upper(reference without spaces)))`.
