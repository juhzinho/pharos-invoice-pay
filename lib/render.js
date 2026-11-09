const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33);
const SEV = { block: red("BLOCK"), warn: yellow("WARN "), info: dim("info ") };
const LABEL = { reference: "reference", payee: "payee", payeeName: "payee name", amount: "amount due", currency: "currency", total: "total", subtotal: "subtotal", tax: "tax", paid: "paid", dueDate: "due date", issueDate: "invoice date", chainId: "network", amountInWords: "in words" };
export const whereText = (s) => (!s ? "" : s.path ? `${s.path}` : s.param ? `line ${s.line}, URI ${s.param}` : `line ${s.line}: “${s.text.length > 70 ? `${s.text.slice(0, 67)}…` : s.text}”`);

export function renderCheck(ex, r) {
  const out = ["", bold(`${r.name} · ${r.format}`), ""];
  out.push(bold("  Read from the document"));
  for (const [k, label] of Object.entries(LABEL)) {
    const f = ex.fields[k];
    if (!f) continue;
    const v = f.value ?? red("unreadable");
    out.push(`    ${label.padEnd(13)} ${String(v).padEnd(44)} ${dim(whereText(f.source))}`);
  }
  for (const it of ex.fields.lineItems ?? []) out.push(`    ${"line item".padEnd(13)} ${`${it.value} — ${it.description}`.padEnd(44)} ${dim(whereText(it.source))}`);
  out.push("", bold("  Checks"));
  for (const f of r.flags) out.push(`    ${SEV[f.severity]} ${f.message}`);
  if (!r.flags.length) out.push(dim("    nothing to flag"));
  const d = r.decision === "ready" ? green(bold("READY")) : r.decision === "review" ? yellow(bold("REVIEW")) : red(bold("BLOCKED"));
  out.push("", `  ${d}  ${r.summary}`);
  if (r.sign) out.push("", bold("  Sign once") + `  ${r.sign.note}`);
  if (r.next) out.push(dim(`  next: ${r.next}`));
  return out.join("\n");
}

export function renderVerify(v) {
  const out = ["", bold(`Transaction ${v.hash}`), dim(`  block ${v.block} · ${v.status}`), ""];
  out.push(`  reference on chain   ${v.reference ? green(`inv:${v.reference}`) : red("none found in the input data")}`);
  if (v.paid) out.push(`  what moved           ${v.paid.units ?? "?"} units of ${v.paid.token} → ${v.paid.to}`);
  if (v.checks) {
    out.push("");
    for (const c of v.checks) out.push(`  ${c.ok ? green("✓") : red("✗")} ${c.what.padEnd(10)} ${c.ok ? "" : dim(`got ${c.got}, invoice says ${c.want}`)}`);
    out.push("", v.matches ? green(bold("  This transaction paid the invoice.")) : red(bold("  This transaction does not match the invoice.")));
  }
  return out.join("\n");
}
