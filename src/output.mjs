// Output helpers. With --json, commands print exactly one JSON document to stdout (or NDJSON for streams);
// progress and hints go to stderr so stdout stays machine-readable.

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { dim: wrap(2), bold: wrap(1), red: wrap(31), green: wrap(32), yellow: wrap(33), blue: wrap(34), magenta: wrap(35), cyan: wrap(36) };

export const methodColor = (m) =>
  ({ GET: c.blue, POST: c.green, PUT: c.yellow, PATCH: c.magenta, DELETE: c.red })[m] ?? ((s) => s);

export function statusColor(status, injected) {
  if (injected) return c.yellow;
  if (status == null || status >= 500) return c.red;
  if (status >= 400) return c.yellow;
  return c.green;
}

export function json(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export const info = (msg) => process.stderr.write(msg + "\n");

/** Prints `data` as JSON with --json, else calls `human()`. */
export function out(ctx, data, human) {
  if (ctx.flags.json) json(data);
  else human();
}

const visible = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

/** A plain text table: rows of cells (strings), first row is the header. */
export function table(rows) {
  if (rows.length <= 1) return;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => visible(r[i]).length)));
  rows.forEach((r, ri) => {
    const line = r.map((cell, i) => (i === r.length - 1 ? String(cell ?? "") : String(cell ?? "") + " ".repeat(widths[i] - visible(cell).length))).join("  ");
    console.log(ri === 0 ? c.dim(line) : line);
  });
}

export function relative(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
