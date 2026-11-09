// Writes the sample invoices in invoices/ — four formats, clean ones and ones with a real problem each — and the
// vendor book. Vendor addresses are derived from the vendor's name (plain EOAs on Pacific, no code, never funded).
import { writeFile } from "node:fs/promises";
import { getAddress, keccak256, toHex } from "viem";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { TOKENS } from "../lib/contracts.js";

const addr = (seed) => getAddress(`0x${keccak256(toHex(`pharos-invoice-pay demo vendor: ${seed}`)).slice(26)}`);
const V = {
  acme: { name: "Acme Design Studio", address: addr("acme") },
  northwind: { name: "Northwind Hosting", address: addr("northwind") },
  orbit: { name: "Orbit Cloud", address: addr("orbit") },
  lumen: { name: "Lumen Translations", address: addr("lumen") },
  atlas: { name: "Atlas Consulting", address: addr("atlas") },
  harbor: { name: "Harbor Studio Rentals", address: addr("harbor") },
};
const out = (f, s) => writeFile(new URL(`../invoices/${f}`, import.meta.url), s);
// a one-character typo in a checksummed address: the checksum no longer matches
const typo = (a) => { const i = a.slice(2).search(/[a-f]/) + 2; return a.slice(0, i) + (a[i] === "a" ? "b" : "a") + a.slice(i + 1); };

await out("vendors.json", JSON.stringify({ note: "The payer's own vendor book: the payee addresses confirmed out of band. An invoice that names a vendor with a different address is stopped.", vendors: Object.values(V) }, null, 2));

// 1 · e-mail, clean (USD paid in USDC)
await out("acme-design.txt", `From: Acme Design Studio <billing@acme-design.example>
To: accounts@payer.example
Subject: Invoice INV-2026-0142 — brand refresh, November

Hello,

Please find our invoice below.

Invoice number: INV-2026-0142
Invoice date: 2026-11-02
Due date: 2026-11-30

Description                         Qty   Amount
Brand refresh — logo system           1   800.00
Website art direction                  1   300.00

Subtotal:   1,100.00 USD
Tax (13.6%):  150.00 USD
Amount due: 1,250.00 USD
Amount in words: One thousand two hundred fifty US dollars

Network: Pharos Pacific (chain 1672), USDC accepted
Pay to: ${V.acme.address}

Thank you,
Acme Design Studio
`);

// 3 · structured JSON, UBL-style keys — the lines do not add up to what is payable
await out("orbit-cloud.json", JSON.stringify({
  ID: "OC-2026-11-007",
  IssueDate: "2026-11-01",
  DueDate: "2026-11-25",
  DocumentCurrencyCode: "USDC",
  network: { chainId: 1672 },
  AccountingSupplierParty: { Party: { PartyName: { Name: V.orbit.name } } },
  PayeeParty: { EndpointID: V.orbit.address },
  InvoiceLine: [
    { Item: { Name: "Compute — 3 nodes, October" }, LineExtensionAmount: { value: "600.00", currencyID: "USDC" } },
    { Item: { Name: "Object storage, 4 TB" }, LineExtensionAmount: { value: "200.00", currencyID: "USDC" } },
    { Item: { Name: "Support plan" }, LineExtensionAmount: { value: "100.00", currencyID: "USDC" } },
  ],
  LegalMonetaryTotal: { LineExtensionAmount: { value: "900.00", currencyID: "USDC" }, PayableAmount: { value: "950.00", currencyID: "USDC" } },
}, null, 2));

// 4 · EIP-681 payment request inside a message, clean
await out("lumen-payment-request.txt", `Payment request from Lumen Translations
Reference: LT-5521 (Portuguese localisation, 4,000 words)
Amount: 320.00 USDC on Pharos Pacific

Open in your wallet:
ethereum:${TOKENS.USDC.address}@1672/transfer?address=${V.lumen.address}&uint256=320000000
`);

// 6 · e-mail with a mistyped address (checksum)
await out("atlas-typo.txt", `From: Atlas Consulting <ar@atlas.example>
Subject: Invoice AC-1187

Invoice number: AC-1187
Invoice date: 2026-11-05
Due date: 2026-12-05
Amount due: 2,400.00 USDC
Network: Pharos Pacific (1672)
Wallet: ${typo(V.atlas.address)}
`);

// 7 · a euro invoice: no EUR token on Pacific — never converted by guessing
await out("berlin-euro.txt", `From: Kanzlei Weber GmbH
Rechnung / Invoice number: KW-2026-311
Invoice date: 04.11.2026
Due date: 30.11.2026

Beratung (consulting), 12 h      2.400,00 EUR

Total due: 2.400,00 EUR
Pay to: ${addr("weber")}
`);

// 8 · JSON without an invoice number
await out("missing-reference.json", JSON.stringify({ payee: { name: V.harbor.name, address: V.harbor.address }, amountDue: "1850.00", currency: "USDC", dueDate: "2026-11-30", chainId: 1672 }, null, 2));

// 9 · an amount with no way to know the decimal separator
await out("ambiguous-amount.txt", `From: Harbor Studio Rentals
Invoice number: HSR-2211
Due date: 2026-11-30
Total: 1.850 USDC
Pay to: ${V.harbor.address}
`);

// 10 · digits and words disagree
await out("harbor-words.txt", `From: Harbor Studio Rentals
Invoice number: HSR-2212
Due date: 2026-12-30
Amount due: 1,850.00 USDC (one thousand five hundred eighty dollars)
Network: Pharos Pacific (1672)
Pay to: ${V.harbor.address}
`);

// ───────── PDFs ─────────
async function pdf(file, title, rows, foot = []) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("pharos-invoice-pay sample generator");
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  page.drawText(title, { x: 50, y, size: 20, font: bold });
  y -= 36;
  for (const r of rows) {
    if (r === "") { y -= 10; continue; }
    const [a, b, c] = Array.isArray(r) ? r : [r];
    page.drawText(a, { x: 50, y, size: 10.5, font: b == null && c == null ? bold : font });
    if (b != null) page.drawText(String(b), { x: c == null ? 260 : 360, y, size: 10.5, font });
    if (c != null) page.drawText(String(c), { x: 470, y, size: 10.5, font });
    y -= 17;
  }
  y -= 10;
  for (const f of foot) { page.drawText(f, { x: 50, y, size: 8.5, font, color: rgb(0.35, 0.35, 0.4) }); y -= 12; }
  await writeFile(new URL(`../invoices/${file}`, import.meta.url), await doc.save());
}

// 2 · PDF, clean, two columns + a line-item table
await pdf("northwind-hosting.pdf", "Northwind Hosting — Invoice", [
  ["Invoice number", "NW-88213"], ["Invoice date", "Nov 3, 2026"], ["Due date", "Nov 24, 2026"], ["Billed by", "Northwind Hosting"],
  "",
  ["Description", "Qty", "Amount"],
  ["Dedicated server, November", "1", "390.00"],
  ["Backups, 2 TB", "1", "62.00"],
  ["Static IPs", "3", "30.00"],
  "",
  ["Subtotal", "", "482.00"], ["Tax", "", "0.00"], ["Total due", "", "482.00 USDC"],
  "",
  ["Network", "Pharos Pacific (1672)"], ["Payment address", V.northwind.address],
], ["Northwind Hosting · billing@northwind.example · Pay in USDC on Pharos Pacific only."]);

// 5 · PDF that looks like Acme's but asks to pay a new address (the classic "we changed our bank details")
await pdf("acme-design-new-wallet.pdf", "Acme Design Studio — Invoice", [
  ["Invoice number", "INV-2026-0143"], ["Invoice date", "Nov 9, 2026"], ["Due date", "Nov 16, 2026"], ["From", "Acme Design Studio"],
  "",
  ["Description", "Qty", "Amount"],
  ["Brand refresh — final files", "1", "1,250.00"],
  "",
  ["Amount due", "", "1,250.00 USD"],
  "",
  ["Network", "Pharos Pacific (1672)"], ["Pay to", addr("not-acme")],
], ["IMPORTANT: our wallet has changed. Please use the new address above for this and all future invoices."]);

console.log("wrote invoices/: vendors.json and 10 invoices");
