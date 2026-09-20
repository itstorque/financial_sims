// Node-based smoke test for the core math modules (not shipped to the
// browser bundle — just a dev-time sanity check). Run with: node test/smoke.mjs
import { computeAnnualTax, FEDERAL_BRACKETS_SINGLE } from '../src/taxes.js';
import { Simulator, drawFromAccounts, precomputeBlockAmounts } from '../src/sim.js';
import { Account, defaultAccounts, nextAccountId } from '../src/accounts.js';
import { createBlock, createLoanBlock, AmountSchedule, buildScheduleClips, spliceScheduleClip, blockActiveInMonth, nominalMonthlyAmount, loanDownPaymentAmount, loanPrincipal, loanMonthlyPayment } from '../src/blocks.js';
import { ReturnsSchedule, defaultReturnsSchedule } from '../src/returnsSchedule.js';
import { maxHomePrice, monthlyPI } from '../src/affordability.js';
import { createScenarioExport, reviveScenarioExport, serializeState, reviveState } from '../src/persistence.js';
import { childCostAmountSchedule, SF_CHILD_COST_BRACKETS } from '../src/childCostModel.js';
import { buildBaseScenario, BASE_SCENARIO_NAME } from '../src/baseScenario.js';
import { createMarketEvent, sampleMarketEvents, eventAppliesToAccount } from '../src/marketEvents.js';

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

const clips = buildScheduleClips(scheduleBlock.amountSchedule.entries, '2026-01', '2040-12');
assert(clips[0].from === '2026-01' && clips.at(-1).to === '2040-12', 'clip timeline covers the complete simulation window');
assert(clips[0].to === '2030-12' && clips[1].from === '2031-01', 'normalized clips retain adjacent schedule boundaries');
const firstClipAmount = clips[0].annualAmount;
assert(spliceScheduleClip(clips, 0, '2028-01') === true, 'splice accepts a month inside a clip');
assert(clips[0].to === '2027-12' && clips[1].from === '2028-01' && clips[1].annualAmount === firstClipAmount, 'splice creates contiguous clips and preserves settings');
assert(spliceScheduleClip(clips, 0, clips[0].from) === false, 'splice rejects a cut at the clip start');

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
assert(out.byAccountTimeline.length === 36, 'account-level composition timeline has one entry per month');
assert(Object.keys(out.byAccountTimeline[0]).length === Object.keys(accounts).length, 'account-level composition includes every account');
assert(out.individualTraces.length === 50, 'simulation exposes up to 50 representative individual paths');
assert(out.individualTraces.every(trace => trace.length === 36), 'every individual path spans the full simulation');
assert(out.individualTraces.every((trace, index) => trace.at(-1) === out.finalParticles[index].total()), 'individual path endpoints match final particle values');

// --- Cross-account drawdown ---
const drawdownAccounts = {
  checking: new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 100 }),
  hysa: new Account({ id: 'hysa', name: 'Savings', type: 'hysa', balance: 200 }),
  taxable: new Account({ id: 'taxable', name: 'Brokerage', type: 'taxable', balance: 300 }),
  debt: new Account({ id: 'debt', name: 'Debt', type: 'debt', balance: -500 }),
};
const drawdownBalances = Object.fromEntries(Object.entries(drawdownAccounts).map(([id, account]) => [id, account.balance]));
const drawdown = drawFromAccounts(drawdownBalances, drawdownAccounts, 450, 'checking');
assert(drawdown.shortfall === 0 && drawdown.withdrawn === 450, 'drawdown satisfies an expense across multiple asset accounts');
assert(drawdownBalances.checking === 0 && drawdownBalances.hysa === 0 && drawdownBalances.taxable === 150, 'drawdown uses checking, savings, then taxable brokerage');
assert(drawdownBalances.debt === -500, 'drawdown never treats a debt account as available funds');

const shortfallAccounts = {
  checking: new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 100 }),
  hysa: new Account({ id: 'hysa', name: 'Savings', type: 'hysa', balance: 50 }),
};
const shortfallBlock = createBlock({ category: 'expense', kind: 'one-time', description: 'Large expense', amount: 200, startMonth: '2026-01', sourceAccountId: 'checking' });
const shortfallOut = new Simulator({ startDate: '2026-01-01', months: 1, accounts: shortfallAccounts, blocks: [shortfallBlock], globalReturnsSchedule: new ReturnsSchedule([], { defaultAnnual: 0, defaultSigma: 0 }), numParticles: 10, useParticleFilter: false }).run();
assert(shortfallOut.finalParticles.every(p => Object.values(p.accountBalances).every(balance => balance >= 0)), 'asset accounts never become negative when funds are insufficient');
assert(shortfallOut.solvencyRate === 0, 'an unpaid withdrawal shortfall marks the path insolvent');

// --- Rare probabilistic market events ---
const certainCrash = createMarketEvent({ name: 'Certain test crash', probability: 1, triggerWindowMonths: 1, durationMonths: 1, annualReturn: -1.2, sigma: 0, scope: 'investments' });
const neverCrash = createMarketEvent({ name: 'Impossible test crash', probability: 0, triggerWindowMonths: 1, durationMonths: 1, annualReturn: -1.2, sigma: 0, scope: 'investments' });
assert(sampleMarketEvents([certainCrash], 12, () => 0).length === 1, '100% market event always triggers');
assert(sampleMarketEvents([neverCrash], 12, () => 0.5).length === 0, '0% market event never triggers');
assert(eventAppliesToAccount(certainCrash, { type: 'taxable' }) && !eventAppliesToAccount(certainCrash, { type: 'checking' }), 'investment event only targets market-linked accounts');

const eventAccounts = { taxable: new Account({ id: 'taxable', name: 'Brokerage', type: 'taxable', balance: 100 }) };
const zeroReturns = new ReturnsSchedule([], { defaultAnnual: 0, defaultSigma: 0 });
const crashOut = new Simulator({ startDate: '2026-01-01', months: 1, accounts: eventAccounts, blocks: [], globalReturnsSchedule: zeroReturns, marketEvents: [certainCrash], numParticles: 20, useParticleFilter: false }).run();
const noCrashOut = new Simulator({ startDate: '2026-01-01', months: 1, accounts: eventAccounts, blocks: [], globalReturnsSchedule: zeroReturns, marketEvents: [neverCrash], numParticles: 20, useParticleFilter: false }).run();
assert(Math.abs(crashOut.timeline[0].p50 - 90) < 1e-9, 'triggered event replaces normal return during its active month');
assert(noCrashOut.timeline[0].p50 === 100, 'non-triggered event leaves normal returns unchanged');
assert(crashOut.marketEventStats[0].triggerRate === 1, 'simulation reports realized event trigger rate');
assert(crashOut.marketEventStats[0].triggerMonths.length === 1 && crashOut.marketEventStats[0].triggerMonths[0].monthIndex === 0, 'simulation reports event start months for chart markers');
assert(crashOut.marketEventStats[0].triggerMonths[0].rate === 1, 'event marker reports the fraction of paths starting that month');

// --- Persistence round-trip (serialize -> revive should preserve shape/values) ---
const stateForSave = { accounts, blocks, globalReturnsSchedule: defaultReturnsSchedule() };
const serialized = serializeState(stateForSave);
const revived = reviveState(JSON.parse(JSON.stringify(serialized))); // force through JSON like localStorage would
assert(Object.keys(revived.accounts).length === Object.keys(accounts).length, 'revived account count matches');
assert(revived.accounts.checking.balance === accounts.checking.balance, 'revived account balance matches');
assert(revived.blocks.length === blocks.length, 'revived block count matches');
assert(revived.blocks[0].targetAccountId === blocks[0].targetAccountId, 'revived block targetAccountId preserved');
assert(revived.globalReturnsSchedule.getFor(new Date('2027-06-01')).annual === defaultReturnsSchedule().getFor(new Date('2027-06-01')).annual, 'revived returns schedule getFor matches original');

const eventState = { accounts, blocks, globalReturnsSchedule: defaultReturnsSchedule(), marketEvents: [certainCrash] };
const revivedEventState = reviveState(JSON.parse(JSON.stringify(serializeState(eventState))));
assert(revivedEventState.marketEvents.length === 1 && revivedEventState.marketEvents[0].probability === 1, 'rare market events survive persistence round-trip');

const withdrawalOrderState = { accounts, blocks, globalReturnsSchedule: defaultReturnsSchedule(), withdrawalOrder: ['taxable', 'retirement'] };
const revivedWithdrawalOrder = reviveState(JSON.parse(JSON.stringify(serializeState(withdrawalOrderState))));
assert(Array.isArray(revivedWithdrawalOrder.withdrawalOrder) && revivedWithdrawalOrder.withdrawalOrder.length === 2, 'withdrawalOrder survives persistence round-trip');
assert(revivedWithdrawalOrder.withdrawalOrder[0] === 'taxable' && revivedWithdrawalOrder.withdrawalOrder[1] === 'retirement', 'withdrawalOrder preserves account id sequence');
assert(reviveState(JSON.parse(JSON.stringify(serializeState({ accounts, blocks, globalReturnsSchedule: defaultReturnsSchedule() })))).withdrawalOrder.length === 0, 'missing withdrawalOrder revives to an empty array (backward compatible)');

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

const fs = await import('node:fs');
const path = await import('node:path');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const exampleImport = reviveScenarioExport(JSON.parse(fs.readFileSync(path.join(repoRoot, 'me.example.json'), 'utf8')));
assert(exampleImport.name.length > 0, 'JSON import loads the me.example.json scenario name');
assert(Object.keys(exampleImport.state.accounts).length === 6, 'JSON import loads all me.example.json accounts');
assert(exampleImport.state.accounts.roth.balance === 500000, 'JSON import preserves me.example.json account balances');

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

const loanAccounts = { checking: new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 500000 }), homeDebt: new Account({ id: 'homeDebt', name: 'Home loan', type: 'debt', balance: 0, useCustomReturns: true, returnsSchedule: new ReturnsSchedule([], { defaultAnnual: 0.0675, defaultSigma: 0 }) }) };
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
assert(Object.keys(base.state.accounts).length === 6, 'base scenario has 6 accounts (checking, hysa, taxable, retirement, roth, home debt)');
assert(base.state.accounts.roth.balance === 500000, 'base scenario Roth IRA starts at $500k');
assert(base.state.accounts.retirement.balance === 300000, 'base scenario retirement (401k/IRA) starts at $300k');
assert(base.state.accounts.hysa.balance === 200000, 'base scenario savings (HYSA) starts at $200k');
assert(base.state.accounts.checking.balance === 50000, 'base scenario checking starts at $50k');
assert(base.state.blocks.length === 7, 'base scenario has 7 blocks (3 income, living costs, loan, 2 kids)');
assert(base.state.blocks.some(b => b.kind === 'loan' && b.purchasePrice === 1200000), 'base scenario includes the $1.2M SF house loan block');
assert(base.state.withdrawalOrder.length === 4 && !base.state.withdrawalOrder.includes(base.state.accounts.checking.id), 'base scenario has a default retirement withdrawal order excluding checking');
assert(base.state.withdrawalOrder[0] === base.state.accounts.hysa.id, 'base scenario default withdrawal order drains savings (HYSA) first');
assert(base.state.withdrawalOrder.at(-1) === base.state.accounts.roth.id, 'base scenario default withdrawal order keeps Roth IRA last (compounds tax-free longest)');
assert(base.settings.inflationRate === '3' && base.settings.capGainsEnabled === false, 'base scenario has default inflation/capital-gains settings');
const baseSim = new Simulator({ startDate: new Date(), months: 24, accounts: base.state.accounts, blocks: base.state.blocks, globalReturnsSchedule: base.state.globalReturnsSchedule, city: base.settings.city, numParticles: 20, useParticleFilter: true, withdrawalOrder: base.state.withdrawalOrder });
const baseOut = baseSim.run();
assert(baseOut.timeline.length === 24, 'base scenario simulates without throwing');

// --- me.json loading (loadMeScenario) ---
{
  const { loadMeScenario } = await import('../src/meScenario.js');

  // 1) Missing file (404) should resolve to null, not throw.
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/me.json') {
      res.writeHead(404); res.end('not found');
    } else if (req.url === '/me.example.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(path.join(repoRoot, 'me.example.json')));
    } else if (req.url === '/bad.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not valid json');
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const missing = await loadMeScenario(`http://localhost:${port}/me.json`);
  assert(missing === null, 'loadMeScenario resolves to null on 404 (no me.json provided)');

  const malformed = await loadMeScenario(`http://localhost:${port}/bad.json`);
  assert(malformed === null, 'loadMeScenario resolves to null on invalid JSON instead of throwing');

  const loaded = await loadMeScenario(`http://localhost:${port}/me.example.json`);
  assert(loaded !== null, 'loadMeScenario successfully loads a valid scenario file');
  assert(Object.keys(loaded.state.accounts).length === 6, 'loaded me-scenario has the expected account count');
  assert(loaded.state.accounts.roth.balance === 500000, 'loaded me-scenario preserves Roth IRA balance');
  assert(typeof loaded.notes === 'string' && loaded.notes.length > 0, 'loaded me-scenario preserves notes');

  await new Promise(resolve => server.close(resolve));
}

// --- Custom withdrawal order overrides the default type-based cascade ---
{
  const accounts = {
    checking: new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 100 }),
    hysa: new Account({ id: 'hysa', name: 'Savings', type: 'hysa', balance: 200 }),
    taxable: new Account({ id: 'taxable', name: 'Brokerage', type: 'taxable', balance: 300 }),
  };
  const balances = Object.fromEntries(Object.entries(accounts).map(([id, a]) => [id, a.balance]));
  // Default cascade would drain checking, then hysa, then taxable. A custom
  // withdrawalOrder putting taxable BEFORE hysa should be respected instead.
  const draw = drawFromAccounts(balances, accounts, 250, 'checking', { withdrawalOrder: ['taxable', 'hysa'] });
  assert(draw.shortfall === 0, 'custom withdrawal order still fully satisfies the request');
  assert(balances.checking === 0, 'preferred source (checking) is always drained first regardless of withdrawalOrder');
  assert(balances.taxable === 150 && balances.hysa === 200, 'custom withdrawalOrder drains taxable before hysa (overriding the default type cascade)');
}

// --- Capital gains tax on taxable-account withdrawals (optional, off by default) ---
{
  const accounts = { taxable: new Account({ id: 'taxable', name: 'Brokerage', type: 'taxable', balance: 1000 }) };
  const balancesNoTax = { taxable: 1000 };
  const costBasisNoTax = { taxable: 400 }; // $600 of the $1000 balance is unrealized gain (60%)
  const drawNoTax = drawFromAccounts(balancesNoTax, accounts, 100, 'taxable', { capitalGains: { enabled: false, rate: 0.15 }, costBasis: costBasisNoTax });
  assert(drawNoTax.shortfall === 0 && balancesNoTax.taxable === 900, 'capital gains disabled: withdrawing $100 removes exactly $100 (no tax leakage)');

  const balancesTax = { taxable: 1000 };
  const costBasisTax = { taxable: 400 };
  const drawTax = drawFromAccounts(balancesTax, accounts, 100, 'taxable', { capitalGains: { enabled: true, rate: 0.15 }, costBasis: costBasisTax });
  assert(drawTax.shortfall === 0, 'capital gains enabled: a withdrawal well within the balance is still fully satisfied (grossed up for tax)');
  // gainFraction = (1000-400)/1000 = 0.6; gross = 100 / (1 - 0.6*0.15) = 100/0.91 ≈ 109.89
  const expectedGross = 100 / (1 - 0.6 * 0.15);
  assert(Math.abs((1000 - balancesTax.taxable) - expectedGross) < 1e-6, `capital gains enabled: account is debited the grossed-up amount ($${expectedGross.toFixed(2)}), not just the $100 requested`);
  assert(balancesTax.taxable < 900, 'capital gains enabled: more leaves the account than the flat $100 withdrawn without tax');
  assert(costBasisTax.taxable < 400 && costBasisTax.taxable > 0, 'capital gains enabled: cost basis shrinks proportionally to the principal portion withdrawn');
}

// --- Inflation escalates block amounts over time in precomputeBlockAmounts ---
{
  const inflatedBlock = createBlock({ category: 'expense', kind: 'continuous', description: 'Rent', amount: 12000, startMonth: '2026-01', sourceAccountId: 'checking' });
  const fixedBlock = createBlock({ category: 'expense', kind: 'continuous', description: 'Fixed contract', amount: 12000, startMonth: '2026-01', sourceAccountId: 'checking', inflationAdjusted: false });
  const amountsNoInflation = precomputeBlockAmounts([inflatedBlock], '2026-01-01', 24, 0);
  const amountsWithInflation = precomputeBlockAmounts([inflatedBlock, fixedBlock], '2026-01-01', 24, 0.03);
  assert(amountsNoInflation[12][inflatedBlock.id] === 1000, 'zero inflation: month-12 amount matches the flat $1000/mo nominal');
  const expectedYear2 = (12000 * Math.pow(1.03, 1)) / 12;
  assert(Math.abs(amountsWithInflation[12][inflatedBlock.id] - expectedYear2) < 1e-6, '3% inflation: one year in, the inflation-adjusted block escalates to ~$1030/mo');
  assert(amountsWithInflation[12][fixedBlock.id] === 1000, 'a block with inflationAdjusted:false stays fixed in nominal dollars regardless of the inflation rate');
}

// --- Simulator wiring: inflationRate/capitalGains/withdrawalOrder flow through end-to-end ---
{
  const accounts = {
    checking: new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 0 }),
    taxable: new Account({ id: 'taxable', name: 'Brokerage', type: 'taxable', balance: 50000 }),
  };
  const rentBlock = createBlock({ category: 'expense', kind: 'continuous', description: 'Rent', amount: 24000, startMonth: '2026-01', sourceAccountId: 'checking' });
  const flatSim = new Simulator({
    startDate: '2026-01-01', months: 12, accounts, blocks: [rentBlock],
    globalReturnsSchedule: new ReturnsSchedule([], { defaultAnnual: 0, defaultSigma: 0 }),
    numParticles: 5, useParticleFilter: false,
    withdrawalOrder: ['taxable'],
  });
  const flatOut = flatSim.run();
  assert(flatOut.byAccountTypeTimeline.at(-1).taxable < 50000, 'expenses draw down the taxable account when it is placed in withdrawalOrder ahead of checking depletion');

  const accounts2 = {
    checking: new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 0 }),
    taxable: new Account({ id: 'taxable', name: 'Brokerage', type: 'taxable', balance: 50000 }),
  };
  const gainsSim = new Simulator({
    startDate: '2026-01-01', months: 12, accounts: accounts2, blocks: [createBlock({ category: 'expense', kind: 'continuous', description: 'Rent', amount: 24000, startMonth: '2026-01', sourceAccountId: 'checking' })],
    globalReturnsSchedule: new ReturnsSchedule([], { defaultAnnual: 0, defaultSigma: 0 }),
    numParticles: 5, useParticleFilter: false,
    withdrawalOrder: ['taxable'],
    capitalGains: { enabled: true, rate: 0.15 },
  });
  const gainsOut = gainsSim.run();
  // With a $0 starting cost basis assumption disabled at t=0 (basis == balance == $50k), there's
  // no unrealized gain yet, so enabling capital gains shouldn't change month-1 behavior meaningfully,
  // but the mechanism must not throw and must still track a valid (non-negative) balance.
  assert(gainsOut.timeline.length === 12, 'capital-gains-enabled simulation runs to completion without throwing');
  assert(gainsOut.byAccountTypeTimeline.at(-1).taxable <= 50000, 'capital-gains-enabled simulation still draws down the taxable account as expected');
}

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
