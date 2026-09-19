// Node-based smoke test for the core math modules (not shipped to the
// browser bundle — just a dev-time sanity check). Run with: node test/smoke.mjs
import { computeAnnualTax, FEDERAL_BRACKETS_SINGLE } from '../src/taxes.js';
import { Simulator } from '../src/sim.js';
import { defaultAccounts } from '../src/accounts.js';
import { createBlock } from '../src/blocks.js';
import { defaultReturnsSchedule } from '../src/returnsSchedule.js';
import { maxHomePrice } from '../src/affordability.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

// --- Tax progressivity ---
const low = computeAnnualTax(50000, 'Default', 0);
const high = computeAnnualTax(500000, 'Default', 0);
assert(high.effectiveRate > low.effectiveRate, `effective rate rises with income (${(low.effectiveRate*100).toFixed(1)}% -> ${(high.effectiveRate*100).toFixed(1)}%)`);
assert(low.federal > 0 && low.federal < 50000, 'federal tax on $50k is a plausible positive amount');

// Marginal bracket sanity: tax on income right at top of first bracket
const t1 = computeAnnualTax(FEDERAL_BRACKETS_SINGLE[0].upTo + 14600, 'Default', 0); // + standard deduction offset
assert(t1.federal > 0, 'bracket boundary tax computed without throwing');

// NYC vs Austin (no state/local tax) at same income should differ
const nyc = computeAnnualTax(150000, 'New York, NY', 0);
const austin = computeAnnualTax(150000, 'Austin, TX', 0);
assert(nyc.totalTax > austin.totalTax, `NYC total tax ($${nyc.totalTax.toFixed(0)}) > Austin ($${austin.totalTax.toFixed(0)})`);

// --- Simulation smoke test ---
const accounts = defaultAccounts();
const blocks = [
  createBlock({ category: 'income', kind: 'continuous', description: 'Salary', amount: 90000, startMonth: '2026-01', preTax: true, targetAccountId: 'checking' }),
  createBlock({ category: 'income', kind: 'continuous', description: '401k', amount: 15000, startMonth: '2026-01', preTax: true, targetAccountId: 'retirement' }),
  createBlock({ category: 'expense', kind: 'continuous', description: 'Living costs', amount: 45000, startMonth: '2026-01', sourceAccountId: 'checking', sigma: 0.05 }),
  createBlock({ category: 'expense', kind: 'one-time', description: 'New car', amount: 20000, startMonth: '2026-06', sourceAccountId: 'checking' }),
];

const sim = new Simulator({
  startDate: '2026-01-01',
  months: 36,
  accounts,
  blocks,
  globalReturnsSchedule: defaultReturnsSchedule(),
  city: 'Default',
  numParticles: 50,
  useParticleFilter: true,
  retirementMonthIndex: 24,
});
const out = sim.run();

assert(out.timeline.length === 36, 'timeline has one entry per month');
assert(out.timeline.every(t => t.p10 <= t.p50 && t.p50 <= t.p90), 'percentiles are monotonic (p10<=p50<=p90) every month');
assert(out.solvencyRate >= 0 && out.solvencyRate <= 1, `solvencyRate in [0,1] (${out.solvencyRate})`);
assert(out.fireStats && out.fireStats.fireNumber === 45000 * 25, `fireNumber = 25x annual living cost (${out.fireStats.fireNumber})`);
assert(out.fireStats.successRate >= 0 && out.fireStats.successRate <= 1, 'fire success rate in [0,1]');
assert(out.byAccountTypeTimeline.length === 36, 'composition timeline has one entry per month');

// --- Debt appreciation smoke test ---
const debtAccounts = defaultAccounts();
debtAccounts.debt = { id: 'debt', name: 'Credit Card', type: 'debt', balance: -5000, sigma: 0, useCustomReturns: true, returnsSchedule: defaultReturnsSchedule() };
debtAccounts.debt.returnsSchedule.defaultAnnual = 0.20; // 20% APR
debtAccounts.debt.returnsSchedule.defaultSigma = 0;
debtAccounts.debt.returnsSchedule.entries = [];
const debtBlocks = [
  createBlock({ category: 'expense', kind: 'continuous', description: 'CC payment', amount: 1200, startMonth: '2026-01', sourceAccountId: 'checking', debtAccountId: 'debt' }),
];
const debtSim = new Simulator({ startDate: '2026-01-01', months: 12, accounts: debtAccounts, blocks: debtBlocks, globalReturnsSchedule: defaultReturnsSchedule(), numParticles: 20, useParticleFilter: false });
const debtOut = debtSim.run();
assert(debtOut.timeline.length === 12, 'debt sim runs for 12 months without throwing');

// --- Affordability ---
const afford = maxHomePrice({ grossMonthlyIncome: 10000, existingMonthlyDebt: 200, downPaymentAmount: 60000, annualRate: 0.065, termYears: 30 });
assert(afford.maxPrice > 0, `max home price computed (${Math.round(afford.maxPrice)})`);
assert(afford.monthlyCarrying <= 10000 * 0.28 + 1, 'front-end DTI respected');

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
