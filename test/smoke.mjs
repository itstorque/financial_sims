// Node-based smoke test for the core math modules (not shipped to the
// browser bundle — just a dev-time sanity check). Run with: node test/smoke.mjs
import { computeAnnualTax, FEDERAL_BRACKETS_SINGLE } from '../src/taxes.js';
import { Simulator } from '../src/sim.js';
import { Account, defaultAccounts, nextAccountId } from '../src/accounts.js';
import { createBlock, createLoanBlock, AmountSchedule, blockActiveInMonth, nominalMonthlyAmount, loanDownPaymentAmount, loanPrincipal, loanMonthlyPayment } from '../src/blocks.js';
import { ReturnsSchedule, defaultReturnsSchedule } from '../src/returnsSchedule.js';
import { maxHomePrice, monthlyPI } from '../src/affordability.js';
import { createScenarioExport, serializeState, reviveState } from '../src/persistence.js';
import { childCostAmountSchedule, SF_CHILD_COST_BRACKETS } from '../src/childCostModel.js';
import { buildBaseScenario, BASE_SCENARIO_NAME } from '../src/baseScenario.js';

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

// --- Custom amount schedule for income/expense blocks ---
const scheduleBlock = createBlock({
  category: 'income', kind: 'continuous', description: 'Variable income', startMonth: '2026-01',
  useCustomSchedule: true,
  amountSchedule: new AmountSchedule([
    { from: '2026-01', to: '2030-12', annualAmount: 120000 }, // $120k/yr for 5 years
    { from: '2031-01', to: '9999-12', annualAmount: 60000 },  // then $60k/yr forever
    { from: '2036-01', to: '9999-12', annualAmount: 0 },      // then $0 from 2036 on (overrides the tail above)
  ]),
});
assert(nominalMonthlyAmount(scheduleBlock, new Date(2027, 5, 1)) === 120000 / 12, 'schedule: $120k/yr period returns correct monthly amount');
assert(nominalMonthlyAmount(scheduleBlock, new Date(2032, 0, 1)) === 60000 / 12, 'schedule: $60k/yr period (after first ends) returns correct monthly amount');
assert(nominalMonthlyAmount(scheduleBlock, new Date(2038, 0, 1)) === 0, 'schedule: later $0 segment overrides the open-ended $60k tail');
assert(nominalMonthlyAmount(scheduleBlock, new Date(2020, 0, 1)) === 0, 'schedule: months before any segment contribute $0');
assert(blockActiveInMonth(scheduleBlock, new Date(2038, 0, 1)) === true, 'schedule-driven continuous blocks are always "active" (schedule itself zeroes out)');

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

// --- Persistence round-trip (serialize -> revive should preserve shape/values) ---
const stateForSave = { accounts, blocks, globalReturnsSchedule: defaultReturnsSchedule() };
const serialized = serializeState(stateForSave);
const revived = reviveState(JSON.parse(JSON.stringify(serialized))); // force through JSON like localStorage would
assert(Object.keys(revived.accounts).length === Object.keys(accounts).length, 'revived account count matches');
assert(revived.accounts.checking.balance === accounts.checking.balance, 'revived account balance matches');
assert(revived.blocks.length === blocks.length, 'revived block count matches');
assert(revived.blocks[0].targetAccountId === blocks[0].targetAccountId, 'revived block targetAccountId preserved');
assert(revived.globalReturnsSchedule.getFor(new Date('2027-06-01')).annual === defaultReturnsSchedule().getFor(new Date('2027-06-01')).annual, 'revived returns schedule getFor matches original');

// Persistence round-trip specifically for a custom amount-schedule block
const scheduleState = { accounts, blocks: [scheduleBlock], globalReturnsSchedule: defaultReturnsSchedule() };
const revivedSchedule = reviveState(JSON.parse(JSON.stringify(serializeState(scheduleState))));
const revivedBlock = revivedSchedule.blocks[0];
assert(revivedBlock.useCustomSchedule === true, 'revived block preserves useCustomSchedule flag');
assert(revivedBlock.amountSchedule.entries.length === 3, 'revived block preserves all amount-schedule segments');
assert(nominalMonthlyAmount(revivedBlock, new Date(2038, 0, 1)) === 0, 'revived amount schedule still evaluates correctly (last-match-wins $0 tail)');
assert(nominalMonthlyAmount(revivedBlock, new Date(2027, 5, 1)) === 120000 / 12, 'revived amount schedule still evaluates correctly (first segment)');

const exported = createScenarioExport('Base case', { currentAge: '35' }, stateForSave);
assert(exported.format === 'financial-sims-scenario' && exported.version === 1, 'scenario export includes format and version');
assert(exported.name === 'Base case' && exported.settings.currentAge === '35', 'scenario export includes name and settings');
assert(JSON.parse(JSON.stringify(exported)).state.accounts.length === Object.keys(accounts).length, 'scenario export is JSON-safe and includes accounts');

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

// --- Loan block math ---
const loanBlock = createLoanBlock({
  description: 'Test house', startMonth: '2028-01',
  purchasePrice: 1200000, downPaymentPct: 0.20, annualRate: 0.0675, termYears: 30,
  sourceAccountId: 'checking', debtAccountId: 'homeDebt',
});
assert(loanDownPaymentAmount(loanBlock) === 240000, 'loan down payment = 20% of purchase price');
assert(loanPrincipal(loanBlock) === 960000, 'loan principal = 80% of purchase price');
assert(Math.abs(loanMonthlyPayment(loanBlock) - monthlyPI(960000, 0.0675, 30)) < 1e-6, 'loan monthly payment matches standard amortization formula');
assert(blockActiveInMonth(loanBlock, new Date(2028, 0, 1)) === false, 'loan blocks report inactive via blockActiveInMonth (handled specially by sim.js)');

const loanAccounts = { checking: new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 300000 }), homeDebt: new Account({ id: 'homeDebt', name: 'Home loan', type: 'debt', balance: 0, useCustomReturns: true, returnsSchedule: new ReturnsSchedule([], { defaultAnnual: 0.0675, defaultSigma: 0 }) }) };
const loanSim = new Simulator({ startDate: '2027-06-01', months: 24, accounts: loanAccounts, blocks: [loanBlock], globalReturnsSchedule: defaultReturnsSchedule(), numParticles: 10, useParticleFilter: false });
const loanOut = loanSim.run();
assert(loanOut.timeline.length === 24, 'loan sim runs for 24 months without throwing');
// Month index 7 = 2028-01 (Jun'27=0 ... Jan'28=7): down payment + origination should have happened by then.
assert(loanOut.byAccountTypeTimeline[7].debt < 0, 'debt account balance goes negative once the loan originates');
assert(loanOut.byAccountTypeTimeline[23].debt > loanOut.byAccountTypeTimeline[7].debt, 'debt balance amortizes toward zero (less negative) over time as payments are made');

// --- Persistence round-trip for a loan block ---
const loanScenarioState = { accounts: loanAccounts, blocks: [loanBlock], globalReturnsSchedule: defaultReturnsSchedule() };
const revivedLoan = reviveState(JSON.parse(JSON.stringify(serializeState(loanScenarioState))));
assert(revivedLoan.blocks[0].kind === 'loan', 'revived block preserves kind=loan');
assert(revivedLoan.blocks[0].purchasePrice === 1200000, 'revived loan block preserves purchasePrice');
assert(Math.abs(loanMonthlyPayment(revivedLoan.blocks[0]) - loanMonthlyPayment(loanBlock)) < 1e-6, 'revived loan block computes the same monthly payment');

// --- Scenario notes persistence round-trip ---
const notesExport = createScenarioExport('Notes test', { currentAge: '30' }, loanScenarioState, 'Some assumptions here.');
assert(notesExport.notes === 'Some assumptions here.', 'scenario export includes notes');

// --- Child cost schedule ---
const kidSchedule = childCostAmountSchedule('2032-09');
assert(kidSchedule.getAnnualAmountFor(new Date(2032, 8, 1)) === SF_CHILD_COST_BRACKETS[0].annualCost, 'child cost schedule: infant-year cost matches bracket 0');
assert(kidSchedule.getAnnualAmountFor(new Date(2034, 8, 1)) === SF_CHILD_COST_BRACKETS[1].annualCost, 'child cost schedule: toddler-year cost matches bracket 1');
assert(kidSchedule.getAnnualAmountFor(new Date(2050, 8, 1)) === 0, 'child cost schedule: cost drops to $0 once past the modeled age range (18+)');

// --- Base scenario builds without throwing and has expected shape ---
const base = buildBaseScenario();
assert(base.name === BASE_SCENARIO_NAME, 'base scenario has expected name');
assert(Object.keys(base.state.accounts).length === 5, 'base scenario has 5 accounts (checking, hysa, taxable, retirement, home debt)');
assert(base.state.blocks.length === 7, 'base scenario has 7 blocks (3 income, living costs, loan, 2 kids)');
assert(base.state.blocks.some(b => b.kind === 'loan' && b.purchasePrice === 1200000), 'base scenario includes the $1.2M SF house loan block');
const baseSim = new Simulator({ startDate: new Date(), months: 24, accounts: base.state.accounts, blocks: base.state.blocks, globalReturnsSchedule: base.state.globalReturnsSchedule, city: base.settings.city, numParticles: 20, useParticleFilter: true });
const baseOut = baseSim.run();
assert(baseOut.timeline.length === 24, 'base scenario simulates without throwing');

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
