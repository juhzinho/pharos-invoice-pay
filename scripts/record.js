// Records every sample invoice checked live on Pharos Pacific Mainnet (read-only) → public/runs/checks.json, and
// copies the original documents to public/invoices/ so the site can show and open them.
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { makeClient } from "../lib/chain.js";
import { extract } from "../lib/extract.js";
import { analyze } from "../lib/checks.js";

const PAYER = "0x6eA08ca8F313d860808ef7431fc72c6FbcF4A72D"; // a real Pacific wallet holding USDC — read-only use
const ORDER = ["acme-design.txt", "northwind-hosting.pdf", "lumen-payment-request.txt", "acme-design-new-wallet.pdf", "orbit-cloud.json", "harbor-words.txt", "atlas-typo.txt", "ambiguous-amount.txt", "berlin-euro.txt", "missing-reference.json"];
const client = makeClient();
const dir = new URL("../invoices/", import.meta.url);
const vendors = JSON.parse(await readFile(new URL("vendors.json", dir), "utf8")).vendors;
await mkdir(new URL("../public/invoices/", import.meta.url), { recursive: true });
const files = (await readdir(dir)).filter((f) => f !== "vendors.json");
if (files.length !== ORDER.length || !ORDER.every((f) => files.includes(f))) throw new Error("invoices/ and ORDER differ");
const results = [];
for (const f of ORDER) {
  const buf = await readFile(new URL(f, dir));
  const ex = await extract(buf.toString("utf8"), { name: f, bytes: buf });
  const r = await analyze(ex, { client, payer: PAYER, vendors });
  await copyFile(new URL(f, dir), new URL(`../public/invoices/${f}`, import.meta.url));
  results.push({ file: f, extraction: { format: ex.format, fields: ex.fields, conflicts: ex.conflicts, lines: ex.lines, pages: ex.pages ?? null }, ...r });
  console.log(`${f.padEnd(28)} ${ex.format.padEnd(7)} ${r.decision.padEnd(8)} ${r.flags.filter((x) => x.severity === "block").map((x) => x.code).join(", ")}`);
}
await copyFile(new URL("vendors.json", dir), new URL("../public/invoices/vendors.json", import.meta.url));
await writeFile(new URL("../public/runs/checks.json", import.meta.url), JSON.stringify({ recordedAt: new Date().toISOString(), network: "Pharos Pacific Mainnet", payer: PAYER, vendors, results }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
process.exit(0);
