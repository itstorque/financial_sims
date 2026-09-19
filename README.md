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

- **Accounts**: Checking, HYSA, Taxable brokerage, Retirement (401k/IRA), and Debt (loans/credit cards). Each can have its own custom returns schedule (e.g. a credit card's APR) or use the shared default.
- **Income/Expense blocks**: one-time or continuous (recurring monthly), with an optional Gaussian error bar (σ%), a date range, and — for income — a pre-tax/post-tax checkbox.
- **Progressive taxes**: real marginal-bracket math for federal income tax (2024 single-filer brackets + standard deduction), state brackets/flat rates and local tax by city (dropdown), and FICA (Social Security up to the wage base + Medicare + additional Medicare surtax). Traditional-retirement contributions (income blocks targeting a `retirement` account with "pre-tax" checked) are excluded from taxable income for the year (tax-deferred) but still subject to FICA. Effective tax rate is computed **per calendar year** from all pre-tax income active that year, then applied to each month's credited amount. This is a planning approximation, not tax advice (no itemized deductions/credits/AMT/etc).
- **Debts as "appreciating" accounts**: a debt account's negative balance grows via its returns schedule (interest), and expense blocks can optionally target a debt account to pay it down.
- **Monte Carlo with a particle filter**: each of N particles independently samples noise for account returns (from the returns schedule's σ) and for block amounts (their own σ). Optionally, a lightweight particle filter (weight + systematic resampling when effective sample size drops) down-weights bankrupt trajectories so the ensemble stays representative of solvent futures — this is a modeling choice you can toggle off for plain, unweighted Monte Carlo.
- **FIRE math**: the "FIRE number" (25× nominal annual living expenses at your target retirement date) is compared against the simulated portfolio distribution to report a probability of reaching FIRE by your retirement age.
- **House affordability**: a standalone 28/36-DTI mortgage calculator (binary-searches the max home price whose PITI+HOA fits your budget).

## Project layout

- `index.html`, `styles.css` — page shell and styling
- `src/`
  - `sim.js` — simulation loop: applies returns + blocks month-by-month, drives the particle filter, computes FIRE stats
  - `accounts.js` — `Account` model (types incl. `debt`), per-account custom returns
  - `blocks.js` — income/expense block model, active-month logic, noise sampling
  - `returnsSchedule.js` — piecewise annual-return/σ schedule (e.g. "10% through Dec, -15% in 2027, 6% after")
  - `taxes.js` — federal/state/city progressive brackets + FICA
  - `particleFilter.js` — generic weighted resampling (systematic resampling, effective sample size)
  - `affordability.js` — mortgage/DTI max-home-price calculator
  - `ui.js` — renders and wires all editable forms (mutates the shared `state` in place)
  - `plot.js` — Chart.js wrappers (percentile bands, stacked account composition)
  - `app.js` — entry point: reads controls, runs `Simulator`, renders charts + summary stats
- `test/smoke.mjs` — a dev-only Node script (`node test/smoke.mjs`) sanity-checking tax progressivity, sim output shape, debt growth, and affordability math

## Known simplifications (documented, not hidden)

- Single-filer tax brackets only; no itemized deductions, credits, phase-outs, capital-gains rates, or state standard deductions.
- Retirement contribution limits (e.g. 401k caps) are not enforced.
- Expense "debt payments" that exceed the remaining balance don't roll over as a credit.
- The particle filter's bankruptcy-weighting introduces mild survivorship bias by design — a documented trade-off for keeping the percentile bands meaningful (toggle it off for raw Monte Carlo).

## Ideas for next iterations

- Withdrawal-ordering strategies in retirement (e.g. taxable → traditional → Roth).
- Social Security benefit estimation and claiming-age modeling.
- Per-block custom probability distributions (not just Gaussian).
- Saving/loading scenarios (e.g. to `localStorage` or exportable JSON).
