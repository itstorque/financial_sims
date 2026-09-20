# Financial Sims — Static Prototype

A fully client-side (no backend) financial planning simulator you can host on
GitHub Pages. Model accounts, income/expenses, taxes, and market-return
uncertainty, then explore FIRE/retirement outcomes with Monte Carlo.

## Run it locally

No build step — just serve the folder statically:

```bash
python3 -m http.server 8765
# then open http://localhost:8765/
```

(Opening `index.html` directly via `file://` also mostly works, but a local
server avoids any module-loading quirks in some browsers.)

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (root of the repo, or a `docs/` folder).
2. In the repo settings → **Pages**, set the source to the branch/folder you pushed (e.g. `main` / `/root`).
3. GitHub will publish it at `https://<user>.github.io/<repo>/` — no build/CI needed since it's static HTML/CSS/JS.

## What it models

- **Accounts**: Checking, HYSA, Taxable brokerage, Retirement (401k/IRA), Roth IRA, and Debt (loans/credit cards). Each can have its own custom returns schedule (e.g. a credit card's APR) or use the shared default.
- **Income/Expense blocks**: one-time or continuous (recurring monthly), with an optional Gaussian error bar (σ%), a date range, and — for income — a pre-tax/post-tax checkbox. Continuous blocks can also opt into a **custom amount schedule**: a piecewise timeline of annual amounts (e.g. "$120k/yr for 5 years, then $60k/yr, then $0"), edited via a visual segment timeline in the UI.
- **Financed purchases (loan blocks)**: a dedicated block type for a down payment + amortizing mortgage (or any loan), e.g. buying a house. Given a purchase price, down-payment %, annual rate, and term, it automatically originates a linked `debt` account for the loan principal at the purchase month and applies the standard fixed monthly P&I payment thereafter — reusing the normal debt-interest-accrual machinery for correct amortization.
- **Progressive taxes**: real marginal-bracket math for federal income tax (2024 single-filer brackets + standard deduction), state brackets/flat rates and local tax by city (dropdown), and FICA (Social Security up to the wage base + Medicare + additional Medicare surtax). Traditional-retirement contributions (income blocks targeting a `retirement` account with "pre-tax" checked) are excluded from taxable income for the year (tax-deferred) but still subject to FICA. Effective tax rate is computed **per calendar year** from all pre-tax income active that year, then applied to each month's credited amount. This is a planning approximation, not tax advice (no itemized deductions/credits/AMT/etc).
- **Debts as "appreciating" accounts**: a debt account's negative balance grows via its returns schedule (interest), and expense blocks can optionally target a debt account to pay it down.
- **Account drawdown waterfall with a configurable retirement withdrawal order**: withdrawals use the selected source first, then cascade through the accounts listed in "Retirement Withdrawal Order" (reorderable in the UI — e.g. savings → taxable → traditional retirement → Roth last, so Roth compounds tax-free the longest). Any account not explicitly ordered still falls back to a sensible type-based cascade. Asset accounts stop at $0; an uncovered remainder marks that simulation path insolvent instead of creating a negative cash or investment balance.
- **Inflation**: a global annual inflation rate ("Inflation & Taxes" panel) escalates continuous/one-time income and expense amounts over time in the simulation (each block has an "Escalate with inflation" toggle to opt out, e.g. for a fixed nominal contract). The FIRE number is computed in the same escalated nominal terms as the simulated balances. A "Show in today's $" toggle re-renders the existing forecast charts in inflation-adjusted terms instantly, without re-running the simulation.
- **Capital gains tax (optional)**: enable "Model capital gains tax on taxable-brokerage withdrawals" to apply a flat rate to the gain portion of any withdrawal from a `taxable`-type account, wherever it's drawn from (an expense, a loan payment, or the retirement withdrawal waterfall). Cost basis is tracked per account per Monte Carlo path, assuming the starting balance is 100% basis at t=0 (a stated simplification — no long/short-term distinction, no embedded gains at the start).
- **Monte Carlo with a particle filter**: each of N particles independently samples noise for account returns (from the returns schedule's σ) and for block amounts (their own σ). Optionally, a lightweight particle filter (weight + systematic resampling when effective sample size drops) down-weights bankrupt trajectories so the ensemble stays representative of solvent futures — this is a modeling choice you can toggle off for plain, unweighted Monte Carlo.
- **Rare market events**: add asymmetric risks such as a 15% chance of an AI/geopolitical crash beginning sometime in the next two years. Occurrence and start month are sampled independently for each Monte Carlo path; during the configured duration, the event return and volatility replace the ordinary schedule for investment accounts (or all non-debt accounts). The summary reports the realized share of paths in which each event triggered.
- **FIRE math**: the "FIRE number" (25× nominal annual living expenses at your target retirement date) is compared against the simulated portfolio distribution to report a probability of reaching FIRE by your retirement age.
- **House affordability**: a standalone 28/36-DTI mortgage calculator (binary-searches the max home price whose PITI+HOA fits your budget).
- **Dedicated Plots and Reports pages**: the sidebar's **Plots** page hosts the full interactive net-worth and account-mix charts (path overlays, log/linear axis toggles, account filtering, full screen); the **Reports** page is a distinct detailed-analysis view — summary cards (median balance, solvency rate, FIRE stats, resample events), a net-worth checkpoint table (today, retirement, then every 10 years, plus the final month), a final-account-balances breakdown, and a rare-market-event trigger table.
- **Export results as CSV / pandas / matplotlib**: both the Plots and Reports pages have an export toolbar to **Download CSV**, **Copy CSV**, or **Copy Python (pandas + matplotlib)** — the last one copies a self-contained Python snippet (with the CSV data embedded as base64) that reconstructs the exact same DataFrame and renders the net-worth band and account-composition charts with matplotlib. All three respect the "Show in today's $" toggle.
- **Persistence and sharing**: your working session (top settings + accounts/blocks/returns schedule + notes) auto-saves to the browser continuously. **Load JSON** imports a scenario selected from disk, while **Export JSON** creates a portable snapshot. **Test load example** always loads the bundled `me.example.json` fixture through the same import path.
- **Seeded base scenario**: when no autosaved session is available, a concrete example plan — "Base Case — SF Household" — is created: a dual-income household (two salaries + stock comp), a $1.2M SF house purchase via a loan block, and two child cost-of-living curves; see `src/baseScenario.js` for the exact assumptions.
- **Keep your real numbers out of git (`me.json`)**: if a `me.json` file exists next to `index.html`, it's loaded instead of the generic example on first run. `me.json` is listed in `.gitignore` so it's never committed. Create your own by filling out the app with your real data, clicking **Export JSON**, and saving the download as `me.json` at the project root — see `me.example.json` for the expected shape and `src/meScenario.js` for the loader.

## Project layout

- `index.html`, `styles.css` — page shell and styling
- `src/`
  - `sim.js` — simulation loop: applies returns + blocks month-by-month, drives the particle filter, computes FIRE stats
  - `accounts.js` — `Account` model (types incl. `debt`), per-account custom returns
  - `blocks.js` — income/expense block model, active-month logic, noise sampling
  - `returnsSchedule.js` — piecewise annual-return/σ schedule (e.g. "10% through Dec, -15% in 2027, 6% after")
  - `taxes.js` — federal/state/city progressive brackets + FICA
  - `particleFilter.js` — generic weighted resampling (systematic resampling, effective sample size)
  - `affordability.js` — mortgage/DTI max-home-price calculator (also used by loan blocks for the amortized payment formula)
  - `childCostModel.js` — an illustrative SF-calibrated cost-of-living-by-age curve for a child, as an `AmountSchedule` factory
  - `baseScenario.js` — builds the seeded "Base Case — SF Household" example plan (incomes, house loan, kids)
  - `meScenario.js` — fetches and revives an optional, gitignored `me.json` (your real data) in preference to the base scenario
  - `persistence.js` — serialize, validate, and revive scenario JSON (accounts, blocks, returns schedule, market events, withdrawal order) plus browser autosave persistence
  - `exportData.js` — DOM-free CSV/DataFrame-row builders and a matplotlib/pandas Python-snippet generator, used by the Plots and Reports export toolbars
  - `ui.js` — renders and wires all editable forms (mutates the shared `state` in place)
  - `plot.js` — Plotly-based chart wrappers (percentile bands, stacked account composition, zoom/pan)
  - `app.js` — entry point: reads controls, runs `Simulator`, switches between the Plan/Plots/Reports pages, renders charts + summary stats, wires CSV/Python export
- `test/smoke.mjs` — a dev-only Node script (`node test/smoke.mjs`) sanity-checking tax progressivity, sim output shape, debt/loan amortization, child-cost schedules, the base scenario, affordability math, and the CSV/Python export builders

## Known simplifications (documented, not hidden)

- Single-filer tax brackets only; no itemized deductions, credits, phase-outs, or state standard deductions. Capital gains tax (when enabled) is a flat rate with no long/short-term distinction, and assumes each taxable account's starting balance is 100% cost basis.
- Retirement contribution limits (e.g. 401k caps) are not enforced.
- Traditional-retirement withdrawals are not taxed as ordinary income when spent in retirement (only contributions are tax-deferred) — a known gap, see below.
- Expense "debt payments" that exceed the remaining balance don't roll over as a credit.
- The particle filter's bankruptcy-weighting introduces mild survivorship bias by design — a documented trade-off for keeping the percentile bands meaningful (toggle it off for raw Monte Carlo).

## Ideas for next iterations

- Tax traditional-retirement withdrawals as ordinary income (currently only contributions are tax-deferred; withdrawals are untaxed).
- Social Security benefit estimation and claiming-age modeling.
- Per-block custom probability distributions (not just Gaussian).
- Tracking home value/equity as an appreciating asset (loan blocks currently model the liability side only).
- Required minimum distributions (RMDs) from traditional retirement accounts.
