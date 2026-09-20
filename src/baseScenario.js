// The "base" scenario: a concrete, opinionated starting plan for a dual-income
// household in San Francisco, used to seed the app on first load (and always
// available afterward as a named scenario to reload). All figures below are
// stated assumptions — meant to be edited, not treated as advice.
//
// Household: both partners 25 today. Partner A earns $160k/yr (salary,
// cash/pre-tax), Partner B earns $240k/yr (salary, cash/pre-tax), plus $60k/yr
// in stock compensation (RSUs, treated as pre-tax ordinary income landing in
// a taxable brokerage). Plans to buy a $1.2M SF house in Jan 2028 (20% down,
// ~6.75% 30-yr fixed — a rough "typical" SF rate assumption), and to have two
// kids (in 6 and 8 years from today), each with a variable SF cost-of-living
// curve (see childCostModel.js). Starting balances: $500k Roth IRA, $300k
// traditional retirement (401k/IRA), $200k savings (HYSA), $50k checking.

import { Account, nextAccountId } from './accounts.js';
import { ReturnsSchedule, defaultReturnsSchedule } from './returnsSchedule.js';
import { createBlock, createLoanBlock } from './blocks.js';
import { childCostAmountSchedule } from './childCostModel.js';

export const BASE_SCENARIO_NAME = 'Base Case — SF Household';

// Bump this whenever buildBaseScenario()'s figures/structure change. ui.js
// compares this against a value stashed in localStorage and re-seeds both the
// named scenario and (if untouched) the working session when it goes stale —
// otherwise a browser that already saved an older "Base Case" would keep
// showing outdated numbers forever (named scenarios are normally treated as
// user data and never silently overwritten).
export const BASE_SCENARIO_VERSION = 2;

function monthsFromNow(years) {
  const d = new Date();
  d.setMonth(d.getMonth() + Math.round(years * 12));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function buildBaseScenario() {
  const checking = new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 50000 });
  const hysa = new Account({ id: 'hysa', name: 'Savings (HYSA)', type: 'hysa', balance: 200000 });
  const taxable = new Account({ id: 'taxable', name: 'Taxable Brokerage', type: 'taxable', balance: 0 });
  const retirement = new Account({ id: 'retirement', name: '401k / IRA (combined)', type: 'retirement', balance: 300000 });
  const roth = new Account({ id: 'roth', name: 'Roth IRA', type: 'roth', balance: 500000 });

  const homeLoanDebtId = nextAccountId();
  const homeLoanDebt = new Account({
    id: homeLoanDebtId, name: 'Home loan', type: 'debt', balance: 0,
    useCustomReturns: true, returnsSchedule: new ReturnsSchedule([], { defaultAnnual: 0.0675, defaultSigma: 0 }),
  });

  const accounts = {
    [checking.id]: checking,
    [hysa.id]: hysa,
    [taxable.id]: taxable,
    [retirement.id]: retirement,
    [roth.id]: roth,
    [homeLoanDebt.id]: homeLoanDebt,
  };

  const purchaseMonth = '2028-01';
  const kid1BirthMonth = monthsFromNow(6);
  const kid2BirthMonth = monthsFromNow(8);

  const blocks = [
    createBlock({
      category: 'income', kind: 'continuous', description: 'Partner A salary',
      amount: 160000, startMonth: monthsFromNow(0), preTax: true, targetAccountId: checking.id,
    }),
    createBlock({
      category: 'income', kind: 'continuous', description: 'Partner B salary',
      amount: 240000, startMonth: monthsFromNow(0), preTax: true, targetAccountId: checking.id,
    }),
    createBlock({
      category: 'income', kind: 'continuous', description: 'Stock compensation (RSUs)',
      amount: 60000, startMonth: monthsFromNow(0), preTax: true, targetAccountId: taxable.id, sigma: 0.15,
    }),
    createBlock({
      category: 'expense', kind: 'continuous', description: 'Living costs (excl. housing)',
      amount: 70000, startMonth: monthsFromNow(0), sourceAccountId: checking.id, sigma: 0.05,
    }),
    createLoanBlock({
      description: 'House purchase (SF)', startMonth: purchaseMonth,
      purchasePrice: 1200000, downPaymentPct: 0.20, annualRate: 0.0675, termYears: 30,
      sourceAccountId: hysa.id, debtAccountId: homeLoanDebt.id,
    }),
    createBlock({
      category: 'expense', kind: 'continuous', description: 'Kid 1 — cost of living (SF est.)',
      startMonth: kid1BirthMonth, sourceAccountId: checking.id,
      useCustomSchedule: true, amountSchedule: childCostAmountSchedule(kid1BirthMonth),
    }),
    createBlock({
      category: 'expense', kind: 'continuous', description: 'Kid 2 — cost of living (SF est.)',
      startMonth: kid2BirthMonth, sourceAccountId: checking.id,
      useCustomSchedule: true, amountSchedule: childCostAmountSchedule(kid2BirthMonth),
    }),
  ];

  const settings = {
    currentAge: '25',
    retireAge: '55',
    city: 'San Francisco, CA',
    numParticles: '300',
    useParticleFilter: true,
    inflationRate: '3',
    realDollars: false,
    capGainsEnabled: false,
    capGainsRate: '15',
  };

  const notes = [
    'ASSUMPTIONS (edit freely):',
    '- Both partners are 25 today. Retirement age set to 55 as a placeholder FIRE target — change as desired.',
    '- Partner A: $160k/yr salary (pre-tax, cash). Partner B: $240k/yr salary (pre-tax, cash). Plus $60k/yr RSU/stock comp (pre-tax, ~15% amount volatility, vests into the taxable brokerage).',
    `- Living costs (excl. housing): $70k/yr, 5% noise. Adjust to match your real budget.`,
    `- House: $1.2M in San Francisco, purchase month ${purchaseMonth}, 20% down ($240k) from Savings (HYSA), 30-yr fixed at 6.75% (a rough "typical SF rate" placeholder — check current rates). Note: the down payment exceeds the $200k starting Savings balance, so by the purchase date it relies on savings built up from income between now and then (or edit the plan if you want a smaller/larger cushion).`,
      `- Kid 1: born ~${kid1BirthMonth} (6 years from now). Kid 2: born ~${kid2BirthMonth} (8 years from now). Each modeled with an SF-calibrated cost-of-living curve by age (infant/toddler daycare years are the most expensive) — see childCostModel.js. These are illustrative, not sourced from real SF childcare pricing data.`,
    '- Starting balances are placeholders: Checking $50k, Savings (HYSA) $200k, Taxable $0, Retirement (401k/IRA, combined) $300k, Roth IRA $500k.',
    '- Market returns use the global default schedule (edit under "Global Returns Schedule").',
    '- Inflation defaults to 3%/yr, escalating most income/expense blocks; capital gains tax on taxable-brokerage withdrawals is off by default (enable it under "Simulation Settings"). Retirement withdrawal order defaults to Savings → Taxable → Retirement → Roth (reorder under "Retirement Withdrawal Order").',
  ].join('\n');

  return {
    name: BASE_SCENARIO_NAME,
    settings,
    notes,
    state: {
      accounts, blocks, globalReturnsSchedule: defaultReturnsSchedule(), marketEvents: [],
      // Tax-efficient default drawdown order: cash-like savings first, then
      // taxable brokerage (capital gains), then traditional retirement
      // (ordinary income when withdrawn, not modeled here), then Roth last so
      // it compounds tax-free the longest. Checking is excluded — it's
      // typically the primary spending account topped up by this cascade.
      withdrawalOrder: [hysa.id, taxable.id, retirement.id, roth.id],
    },
  };
}
