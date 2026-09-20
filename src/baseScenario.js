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
// curve (see childCostModel.js).

import { Account, nextAccountId } from './accounts.js';
import { ReturnsSchedule, defaultReturnsSchedule } from './returnsSchedule.js';
import { createBlock, createLoanBlock } from './blocks.js';
import { childCostAmountSchedule } from './childCostModel.js';

export const BASE_SCENARIO_NAME = 'Base Case — SF Household';

function monthsFromNow(years) {
  const d = new Date();
  d.setMonth(d.getMonth() + Math.round(years * 12));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function buildBaseScenario() {
  const checking = new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 25000 });
  const hysa = new Account({ id: 'hysa', name: 'House Fund (HYSA)', type: 'hysa', balance: 260000 });
  const taxable = new Account({ id: 'taxable', name: 'Taxable Brokerage', type: 'taxable', balance: 40000 });
  const retirement = new Account({ id: 'retirement', name: '401k / IRA (combined)', type: 'retirement', balance: 60000 });

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
  };

  const notes = [
    'ASSUMPTIONS (edit freely):',
    '- Both partners are 25 today. Retirement age set to 55 as a placeholder FIRE target — change as desired.',
    '- Partner A: $160k/yr salary (pre-tax, cash). Partner B: $240k/yr salary (pre-tax, cash). Plus $60k/yr RSU/stock comp (pre-tax, ~15% amount volatility, vests into the taxable brokerage).',
    `- Living costs (excl. housing): $70k/yr, 5% noise. Adjust to match your real budget.`,
    `- House: $1.2M in San Francisco, purchase month ${purchaseMonth}, 20% down ($240k) from the House Fund (HYSA), 30-yr fixed at 6.75% (a rough "typical SF rate" placeholder — check current rates).`,
      `- Kid 1: born ~${kid1BirthMonth} (6 years from now). Kid 2: born ~${kid2BirthMonth} (8 years from now). Each modeled with an SF-calibrated cost-of-living curve by age (infant/toddler daycare years are the most expensive) — see childCostModel.js. These are illustrative, not sourced from real SF childcare pricing data.`,
    '- Starting balances are placeholders: Checking $25k, House Fund (HYSA) $260k, Taxable $40k, Retirement (combined) $60k.',
    '- Market returns use the global default schedule (edit under "Global Returns Schedule").',
  ].join('\n');

  return {
    name: BASE_SCENARIO_NAME,
    settings,
    notes,
    state: { accounts, blocks, globalReturnsSchedule: defaultReturnsSchedule() },
  };
}
