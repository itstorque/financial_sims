// Pure, DOM-free helpers for exporting simulation results as a CSV
// ("pandas DataFrame"-shaped table: one row per month, one column per
// percentile/mean series plus one column per account) and as a ready-to-run
// Python snippet (pandas + matplotlib) that embeds that same data.
//
// Kept dependency-free of the DOM so it can be unit-tested directly (see
// test/smoke.mjs) and reused from any UI surface (Plots page, Reports page).

/** Turn an account name into a stable, CSV/pandas-friendly column key like "acct_Savings_HYSA". Collisions get a numeric suffix. */
export function accountColumnKey(name, used = new Set()) {
  const base = 'acct_' + String(name || 'account').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'acct_account';
  let key = base;
  let i = 2;
  while (used.has(key)) key = `${base}_${i++}`;
  used.add(key);
  return key;
}

/**
 * Build one row per month combining the net-worth percentile/mean series
 * with each account's mean balance that month.
 *
 * @param {string[]} labels - "YYYY-MM" month labels, aligned with the other arrays.
 * @param {{p10:number[], p50:number[], p90:number[], mean:number[]}} series
 * @param {Array<Record<string, number>>} byAccountTimeline - per-month {accountId: balance}.
 * @param {Record<string, {id:string, name:string}>} accounts
 */
export function buildResultsDataFrameRows(labels, series, byAccountTimeline, accounts) {
  const accountList = Object.values(accounts || {});
  const used = new Set();
  const columnByAccountId = new Map(accountList.map(a => [a.id, accountColumnKey(a.name, used)]));

  return labels.map((month, i) => {
    const row = {
      month,
      p10: round2(series.p10?.[i]),
      p50: round2(series.p50?.[i]),
      p90: round2(series.p90?.[i]),
      mean: round2(series.mean?.[i]),
    };
    const accountRow = byAccountTimeline?.[i] || {};
    for (const account of accountList) {
      row[columnByAccountId.get(account.id)] = round2(accountRow[account.id] ?? 0);
    }
    return row;
  });
}

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Convert an array of uniform row objects (as produced by buildResultsDataFrameRows) into a CSV string. */
export function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const columns = Object.keys(rows[0]);
  const header = columns.map(csvEscape).join(',');
  const body = rows.map(row => columns.map(col => csvEscape(row[col])).join(',')).join('\n');
  return header + '\n' + body;
}

// Base64 encode a UTF-8 string in either a browser or Node environment.
function toBase64(str) {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)));
  return Buffer.from(str, 'utf8').toString('base64');
}

// Insert a newline every `width` characters purely so the generated Python
// source doesn't have one absurdly long line; the decode step strips
// newlines back out before base64-decoding.
function wrapBase64(b64, width = 100) {
  const lines = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines.join('\n');
}

/**
 * Build a self-contained Python snippet (pandas + matplotlib) that embeds
 * the given CSV data (base64-encoded, so arbitrary account names/characters
 * can never break the generated Python source) and reconstructs it into a
 * DataFrame, then plots the net-worth percentile band and, if present, a
 * stacked area chart of account balances over time.
 */
export function buildPythonSnippet(csvString) {
  const b64 = wrapBase64(toBase64(csvString));
  return `# Paste into a Python REPL / Jupyter cell. Requires: pandas, matplotlib
import base64
import io
import pandas as pd
import matplotlib.pyplot as plt

_csv_b64 = """
${b64}
"""
csv_text = base64.b64decode(_csv_b64.replace("\\n", "")).decode("utf-8")
df = pd.read_csv(io.StringIO(csv_text), parse_dates=["month"]).set_index("month")

fig, ax = plt.subplots(figsize=(10, 6))
ax.plot(df.index, df["p50"], label="Median net worth", color="#2563a8", linewidth=2)
ax.fill_between(df.index, df["p10"], df["p90"], alpha=0.15, color="#2563a8", label="P10-P90 range")
ax.set_title("Net worth forecast")
ax.set_xlabel("Date")
ax.set_ylabel("Net worth ($)")
ax.legend()
fig.tight_layout()

account_cols = [c for c in df.columns if c.startswith("acct_")]
if account_cols:
    fig2, ax2 = plt.subplots(figsize=(10, 6))
    df[account_cols].plot.area(ax=ax2, linewidth=0)
    ax2.set_title("Account balances over time")
    ax2.set_xlabel("Date")
    ax2.set_ylabel("Balance ($)")
    fig2.tight_layout()

plt.show()
`;
}
