// Core simulation engine: monthly timeline, per-account returns schedules,
// progressive-tax-aware income crediting, and particle-filter propagation
// of uncertainty (error bars).

import { ReturnsSchedule } from './returnsSchedule.js';
import { blockActiveInMonth, nominalMonthlyAmount, uncertaintyForBlockDate, loanPrincipal, loanMonthlyPayment, loanPaymentWindow } from './blocks.js';
import { computeAnnualTax } from './taxes.js';
import { ParticleFilter } from './particleFilter.js';
import { createMarketEvent, sampleMarketEvents, activeMarketEvent } from './marketEvents.js';
import { createSeededRandom, normalizeDistribution, sampleRelativeValue, sampleShock } from './distributions.js';

export { ReturnsSchedule };

export function monthIndex(startDate, monthsFromStart) {
  const d = new Date(startDate);
  d.setDate(1);
  d.setMonth(d.getMonth() + monthsFromStart);
  return d;
}

/**
 * Parse a Date, or a "YYYY-MM-DD"/"YYYY-MM" string, into a *local* Date at
 * midnight on that day. Plain `new Date("2027-06-01")` parses date-only ISO
 * strings as UTC per spec, which silently shifts the calendar date (often by
 * a full day, sometimes crossing a month boundary) once read back with local
 * getters (getFullYear/getMonth/etc.) in any timezone behind UTC. Since the
 * whole simulation keys months via local getters, we must construct the
 * start date from local components instead of letting the string be
 * UTC-parsed.
 */
export function parseFlexibleDate(input) {
  if (input instanceof Date) return new Date(input.getTime());
  if (typeof input === 'string') {
    const m = input.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
  }
  return new Date(input);
}

function percentile(sortedVals, p) {
  const idx = Math.min(sortedVals.length - 1, Math.max(0, Math.floor(sortedVals.length * p)));
  return sortedVals[idx];
}

function monthKeyToIndex(key) {
  const [year, month] = String(key).split('-').map(Number);
  return year * 12 + month - 1;
}

/** Precompute each block's sampled (noisy) contribution for every month of the sim, escalated by the global inflation rate for blocks opted into it (default true — see blocks.js `inflationAdjusted`). */
export function precomputeBlockAmounts(blocks, startDate, months, inflationRateOrFactors = 0, random = Math.random) {
  const perMonth = [];
  const annualSamples = new Map();
  const growthStates = new Map();
  const normalizedStartDate = parseFlexibleDate(startDate);
  for (let m = 0; m < months; m++) {
    const date = monthIndex(normalizedStartDate, m);
    const inflationFactor = Array.isArray(inflationRateOrFactors)
      ? (inflationRateOrFactors[m] ?? 1)
      : Math.pow(1 + inflationRateOrFactors, m / 12);
    const row = {};
    for (const b of blocks) {
      if (!blockActiveInMonth(b, date)) continue;
      const nominal = nominalMonthlyAmount(b, date);
      const entry = b.useCustomSchedule ? b.amountSchedule?.getEntryFor(date) : null;
      const growthKey = `${b.id}:${entry?.from || b.startMonth || 'simulation-start'}`;
      const growthStartIndex = monthKeyToIndex(entry?.from || b.startMonth || ReturnsSchedule.monthKey(normalizedStartDate));
      const currentIndex = date.getFullYear() * 12 + date.getMonth();
      const elapsedYears = Math.max(0, Math.floor((currentIndex - growthStartIndex) / 12));
      let growthState = growthStates.get(growthKey) || { completedYears: 0, factor: 1 };
      while (growthState.completedYears < elapsedYears) {
        const realizedGrowth = (b.category === 'income' ? Number(b.annualGrowthRate) || 0 : 0)
          + sampleShock(normalizeDistribution(b.growthUncertainty, 0), random);
        growthState = { completedYears: growthState.completedYears + 1, factor: growthState.factor * Math.max(0, 1 + realizedGrowth) };
      }
      growthStates.set(growthKey, growthState);
      const sampleKey = b.kind === 'one-time' ? `${b.id}:once` : `${b.id}:${date.getFullYear()}:${entry?.from || 'simple'}:${entry?.to || ''}:growth-${elapsedYears}`;
      if (!annualSamples.has(sampleKey)) {
        const reportedValue = (b.kind === 'one-time' ? nominal : nominal * 12) * growthState.factor;
        annualSamples.set(sampleKey, sampleRelativeValue(reportedValue, uncertaintyForBlockDate(b, date), random));
      }
      let amt = b.kind === 'one-time' ? annualSamples.get(sampleKey) : annualSamples.get(sampleKey) / 12;
      if (b.inflationAdjusted !== false) amt *= inflationFactor;
      row[b.id] = amt;
    }
    perMonth.push(row);
  }
  return perMonth;
}

function buildInflationPath(months, annualRate, model, random) {
  const factors = new Array(months);
  const volatility = Math.max(0, Number(model?.volatility) || 0);
  const persistence = Math.min(0.99, Math.max(0, Number(model?.persistence) || 0));
  const distribution = normalizeDistribution(model?.distribution, volatility);
  const baselineMonthlyRate = Math.pow(1 + annualRate, 1 / 12) - 1;
  let factor = 1;
  let deviation = 0;
  for (let m = 0; m < months; m++) {
    if (m > 0) {
      const innovation = sampleShock({ ...distribution, scale: (distribution.scale || 0) / Math.sqrt(12) }, random);
      deviation = persistence * deviation + Math.sqrt(1 - persistence ** 2) * innovation;
      factor *= 1 + Math.max(-0.95, baselineMonthlyRate + deviation);
    }
    factors[m] = factor;
  }
  return factors;
}

/** Aggregate pre-tax, non-retirement income by calendar year and compute the effective tax rate for each year. */
function computeEffectiveRatesByYear(blocks, accounts, blockAmounts, startDate, months, city) {
  const grossByYear = {};
  for (let m = 0; m < months; m++) {
    const date = monthIndex(startDate, m);
    const year = date.getFullYear();
    if (!(year in grossByYear)) grossByYear[year] = 0;
    for (const b of blocks) {
      if (b.category !== 'income' || !b.preTax) continue;
      const amt = blockAmounts[m][b.id];
      if (amt === undefined) continue;
      const target = accounts[b.targetAccountId];
      if (target && target.type === 'retirement') continue; // tax-deferred contribution
      grossByYear[year] += amt;
    }
  }
  const years = Object.keys(grossByYear).map(Number).sort((a, b) => a - b);
  const rates = {};
  years.forEach((year, idx) => {
    rates[year] = computeAnnualTax(grossByYear[year], city, idx).effectiveRate;
  });
  return rates;
}

function firstAccountOfType(accounts, type) {
  return Object.values(accounts).find(a => a.type === type);
}

const DRAWDOWN_PRIORITY = ['checking', 'hysa', 'taxable', 'roth', 'retirement'];

/**
 * Withdraw from the requested source first, then cascade across other asset
 * accounts. Asset balances never fall below zero. Any remainder is returned
 * as a shortfall so the particle can be marked insolvent without inventing
 * an overdraft balance.
 *
 * `options.withdrawalOrder` (array of account ids) lets the caller override
 * the default type-based cascade with an explicit, user-configured priority
 * (e.g. the "Retirement Withdrawal Order" list in the UI) — accounts not
 * present in that list still fall back to the default type-based cascade so
 * newly-added accounts are never silently skipped.
 *
 * `options.capitalGains` (`{enabled, rate}`) + `options.costBasis` (a
 * per-particle `{accountId: basisDollars}` map, mutated in place) apply a
 * simplified capital-gains tax whenever a `taxable`-type account is drawn
 * from: the withdrawal is grossed up so that, after tax on the gain portion,
 * the requested net amount is still delivered (or as much of it as the
 * account can cover). Cost basis is reduced proportionally to the principal
 * portion of what was withdrawn.
 */
export function drawFromAccounts(accountBalances, accounts, amount, preferredSourceId = null, options = {}) {
  const { withdrawalOrder = [], costBasis = null, capitalGains = null } = options;
  let remaining = Math.max(0, Number(amount) || 0);
  const orderedIds = [];
  const seen = new Set();
  const consider = id => {
    if (!id || seen.has(id)) return;
    const acc = accounts[id];
    if (!acc || acc.type === 'debt') return;
    seen.add(id);
    orderedIds.push(id);
  };
  consider(preferredSourceId);
  for (const id of withdrawalOrder) consider(id);
  for (const type of DRAWDOWN_PRIORITY) {
    for (const account of Object.values(accounts)) {
      if (account.type === type) consider(account.id);
    }
  }

  for (const id of orderedIds) {
    if (remaining <= 1e-9) break;
    const available = Math.max(0, accountBalances[id] || 0);
    if (available <= 0) continue;
    const acc = accounts[id];

    if (capitalGains?.enabled && acc.type === 'taxable' && costBasis) {
      const basis = Math.min(costBasis[id] ?? available, available);
      const gainFraction = Math.max(0, Math.min(1, (available - basis) / available));
      const rate = Math.max(0, capitalGains.rate || 0);
      const denom = 1 - gainFraction * rate;
      const grossWanted = denom > 0 ? remaining / denom : remaining;
      const gross = Math.min(grossWanted, available);
      const net = gross * (1 - gainFraction * rate);
      const basisPortion = gross * (basis / available);
      accountBalances[id] = available - gross;
      costBasis[id] = Math.max(0, basis - basisPortion);
      remaining -= net;
    } else {
      const withdrawn = Math.min(available, remaining);
      accountBalances[id] = available - withdrawn;
      remaining -= withdrawn;
    }
  }
  return { withdrawn: Math.max(0, amount - remaining), shortfall: Math.max(0, remaining) };
}

/** Precompute deterministic per-loan figures (principal, payment, payment window) once. */
function precomputeLoans(blocks) {
  return blocks.filter(b => b.kind === 'loan').map(b => ({
    block: b,
    principal: loanPrincipal(b),
    downPayment: b.purchasePrice * b.downPaymentPct,
    payment: loanMonthlyPayment(b),
    window: loanPaymentWindow(b), // [startKey, endKey]
  }));
}

class ParticleState {
  constructor(accountBalances, blockAmounts, effectiveRatesByYear, marketEventOccurrences = [], costBasis = {}, netWorthHistory = [], inflationFactors = []) {
    this.accountBalances = accountBalances; // {id: number}
    this.blockAmounts = blockAmounts;       // shared reference, immutable
    this.effectiveRatesByYear = effectiveRatesByYear; // shared reference, immutable
    this.marketEventOccurrences = marketEventOccurrences; // sampled once per path
    this.costBasis = costBasis; // {id: number} — tracked for 'taxable' accounts when capital-gains modeling is enabled
    this.netWorthHistory = netWorthHistory;
    this.inflationFactors = inflationFactors;
    this.maximumDebt = 0;
    this.hasShortfall = false;
    this.failureMonthIndex = null;
  }
  clone() {
    const clone = new ParticleState({ ...this.accountBalances }, this.blockAmounts, this.effectiveRatesByYear, this.marketEventOccurrences, { ...this.costBasis }, [...this.netWorthHistory], this.inflationFactors);
    clone.hasShortfall = this.hasShortfall;
    clone.failureMonthIndex = this.failureMonthIndex;
    clone.maximumDebt = this.maximumDebt;
    return clone;
  }
  total() {
    return Object.values(this.accountBalances).reduce((s, v) => s + v, 0);
  }
}

export class Simulator {
  constructor({
    startDate, months, accounts, blocks, globalReturnsSchedule,
    city = 'Default', numParticles = 300, useParticleFilter = false,
    retirementMonthIndex = null, marketEvents = [],
    inflationRate = 0, capitalGains = null, withdrawalOrder = [],
    inflationModel = null, seed = '', random = null,
  }) {
    this.startDate = parseFlexibleDate(startDate);
    this.months = months;
    this.accounts = accounts;
    this.blocks = blocks;
    this.globalReturnsSchedule = globalReturnsSchedule || new ReturnsSchedule([]);
    this.city = city;
    this.numParticles = numParticles;
    this.useParticleFilter = useParticleFilter;
    this.retirementMonthIndex = retirementMonthIndex;
    this.marketEvents = marketEvents.map(event => createMarketEvent(event));
    // Global annual inflation rate (fraction, e.g. 0.03). Escalates the nominal
    // amount of any block with `inflationAdjusted !== false` over time.
    this.inflationRate = Number(inflationRate) || 0;
    this.inflationModel = inflationModel || { volatility: 0, persistence: 0.7, distribution: { family: 'normal', scale: 0 } };
    this.random = random || createSeededRandom(seed);
    // Optional, simplified capital-gains tax on taxable-brokerage withdrawals.
    // Off by default — a planning simplification (flat rate, no long/short-term
    // distinction, assumes the account's starting balance is 100% cost basis).
    this.capitalGains = capitalGains?.enabled
      ? { enabled: true, rate: Math.max(0, Number(capitalGains.rate) || 0) }
      : { enabled: false, rate: 0 };
    // User-configured retirement drawdown order (account ids, non-debt only).
    // Falls back to a sensible type-based cascade for any account not listed
    // (see DRAWDOWN_PRIORITY / drawFromAccounts above).
    this.withdrawalOrder = Array.isArray(withdrawalOrder)
      ? withdrawalOrder.filter(id => accounts[id] && accounts[id].type !== 'debt')
      : [];
  }

  _returnsScheduleFor(account) {
    return account.useCustomReturns && account.returnsSchedule ? account.returnsSchedule : this.globalReturnsSchedule;
  }

  run() {
    const steps = this._runSteps();
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  async runAsync(onProgress = null) {
    const steps = this._runSteps();
    let step = steps.next();
    while (!step.done) {
      onProgress?.(step.value);
      await new Promise(resolve => setTimeout(resolve, 0));
      step = steps.next();
    }
    return step.value;
  }

  *_runSteps() {
    const { startDate, months, accounts, blocks, city } = this;
    const defaultChecking = firstAccountOfType(accounts, 'checking');
    const loans = precomputeLoans(blocks);
    const eventTriggerCounts = Object.fromEntries(this.marketEvents.map(event => [event.id, 0]));
    const eventStartCounts = Object.fromEntries(this.marketEvents.map(event => [event.id, {}]));

    // 1) Build N independent particles, each with its own noise draws for
    //    block amounts and its own resulting effective tax rates by year.
    let particles = [];
    const particleProgressInterval = Math.max(1, Math.ceil(this.numParticles / 20));
    yield { percent: 0, phase: 'Preparing simulation', detail: `Initializing ${this.numParticles.toLocaleString()} paths` };
    for (let i = 0; i < this.numParticles; i++) {
      const inflationFactors = buildInflationPath(months, this.inflationRate, this.inflationModel, this.random);
      const blockAmounts = precomputeBlockAmounts(blocks, startDate, months, inflationFactors, this.random);
      const effectiveRatesByYear = computeEffectiveRatesByYear(blocks, accounts, blockAmounts, startDate, months, city);
      const balances = {};
      const costBasis = {};
      for (const [id, acc] of Object.entries(accounts)) {
        balances[id] = acc.balance;
        // Simplifying assumption: the starting balance of a taxable account is
        // treated as 100% cost basis (no embedded unrealized gain at t=0).
        costBasis[id] = acc.type === 'taxable' ? acc.balance : 0;
      }
      const marketEventOccurrences = sampleMarketEvents(this.marketEvents, months, this.random);
      for (const occurrence of marketEventOccurrences) {
        eventTriggerCounts[occurrence.eventId]++;
        const starts = eventStartCounts[occurrence.eventId];
        starts[occurrence.startIndex] = (starts[occurrence.startIndex] || 0) + 1;
      }
      particles.push(new ParticleState(balances, blockAmounts, effectiveRatesByYear, marketEventOccurrences, costBasis, [], inflationFactors));
      if ((i + 1) % particleProgressInterval === 0 || i + 1 === this.numParticles) {
        yield { percent: Math.round((i + 1) / this.numParticles * 20), phase: 'Preparing simulation', detail: `Initialized ${(i + 1).toLocaleString()} of ${this.numParticles.toLocaleString()} paths` };
      }
    }

    const pf = new ParticleFilter(particles, { enabled: this.useParticleFilter, essThresholdFraction: 0.5, resamplePenalty: 0.02, random: this.random });

    const timeline = []; // per month: {p10,p50,p90,mean}
    const assetOnlyTimeline = []; // financial assets only; excludes all debt balances
    const byAccountTypeTimeline = []; // per month: {checking,hysa,taxable,retirement,debt}
    const byAccountTimeline = []; // per month: mean balance keyed by account id
    const retirementReadinessTimeline = []; // per month: FIRE target + share of paths above it
    const inflationTimeline = []; // per month: cumulative price-index percentiles
    let maximumDebt = 0;
    let resampleEvents = 0;
    let fireSuccessRate = null;
    let fireNumber = null;

    const monthProgressInterval = Math.max(1, Math.ceil(months / 100));
    for (let m = 0; m < months; m++) {
      const date = monthIndex(startDate, m);
      const year = date.getFullYear();
      const key = ReturnsSchedule.monthKey(date);

      for (const p of pf.particles) {
        // --- apply returns to every account ---
        for (const [id, acc] of Object.entries(accounts)) {
          const event = activeMarketEvent(this.marketEvents, p.marketEventOccurrences, m, acc);
          const sched = event
            ? { annual: event.annualReturn, sigma: event.sigma, distribution: event.distribution }
            : this._returnsScheduleFor(acc).getFor(date);
          const distribution = normalizeDistribution(sched.distribution, sched.sigma);
          const monthlyDistribution = { ...distribution, scale: (distribution.scale || 0) / Math.sqrt(12) };
          const extraDistribution = { family: 'normal', scale: (acc.sigma || 0) / Math.sqrt(12) };
          const mu = sched.annual / 12;
          const noise = mu + sampleShock(monthlyDistribution, this.random) + sampleShock(extraDistribution, this.random);
          p.accountBalances[id] *= (1 + noise);
          if (acc.type !== 'debt') p.accountBalances[id] = Math.max(0, p.accountBalances[id]);
        }

        // --- apply blocks active this month ---
        const row = p.blockAmounts[m];
        for (const b of blocks) {
          const amt = row[b.id];
          if (amt === undefined) continue;

          if (b.category === 'income') {
            const targetId = b.targetAccountId && accounts[b.targetAccountId] ? b.targetAccountId : defaultChecking?.id;
            if (!targetId) continue;
            const targetAcc = accounts[targetId];
            let credited = amt;
            if (b.preTax && !(targetAcc && targetAcc.type === 'retirement')) {
              const rate = p.effectiveRatesByYear[year] ?? 0;
              credited = amt * (1 - rate);
            }
            p.accountBalances[targetId] += credited;
            // New principal contributed to a taxable account is cost basis, not gain.
            if (targetAcc && targetAcc.type === 'taxable') p.costBasis[targetId] = (p.costBasis[targetId] || 0) + credited;
          } else {
            // expense
            const sourceId = b.sourceAccountId && accounts[b.sourceAccountId] ? b.sourceAccountId : defaultChecking?.id;
            const draw = drawFromAccounts(p.accountBalances, accounts, amt, sourceId, { withdrawalOrder: this.withdrawalOrder, costBasis: p.costBasis, capitalGains: this.capitalGains });
            if (draw.shortfall > 0) { p.hasShortfall = true; if (p.failureMonthIndex == null) p.failureMonthIndex = m; }

            // optional: expense also functions as a debt payment
            if (b.debtAccountId && accounts[b.debtAccountId]) {
              const paidDown = Math.min(draw.withdrawn, -p.accountBalances[b.debtAccountId]); // don't overpay past zero
              p.accountBalances[b.debtAccountId] += Math.max(0, paidDown);
            }
          }
        }

        // --- financed purchases (loan blocks): origination + amortized payment ---
        for (const loan of loans) {
          const { block, principal, downPayment, payment, window } = loan;
          const sourceId = block.sourceAccountId && accounts[block.sourceAccountId] ? block.sourceAccountId : defaultChecking?.id;

          if (key === block.startMonth) {
            if (accounts[block.debtAccountId]) p.accountBalances[block.debtAccountId] -= principal; // loan originated
            const draw = drawFromAccounts(p.accountBalances, accounts, downPayment, sourceId, { withdrawalOrder: this.withdrawalOrder, costBasis: p.costBasis, capitalGains: this.capitalGains });
            if (draw.shortfall > 0) { p.hasShortfall = true; if (p.failureMonthIndex == null) p.failureMonthIndex = m; }
          }
          if (key >= window[0] && key <= window[1]) {
            const draw = drawFromAccounts(p.accountBalances, accounts, payment, sourceId, { withdrawalOrder: this.withdrawalOrder, costBasis: p.costBasis, capitalGains: this.capitalGains });
            if (draw.shortfall > 0) { p.hasShortfall = true; if (p.failureMonthIndex == null) p.failureMonthIndex = m; }
            if (accounts[block.debtAccountId]) {
              const paidDown = Math.min(draw.withdrawn, -p.accountBalances[block.debtAccountId]); // don't overpay past zero
              p.accountBalances[block.debtAccountId] += Math.max(0, paidDown);
            }
          }
        }
      }

      // --- collect stats for this month across the ensemble ---
      for (const particle of pf.particles) particle.netWorthHistory.push(particle.total());
      const totals = pf.particles.map(p => p.total()).sort((a, b) => a - b);
      const assetTotals = pf.particles.map(p => Object.entries(accounts).reduce((sum, [id, account]) =>
        account.type === 'debt' ? sum : sum + (p.accountBalances[id] || 0), 0)).sort((a, b) => a - b);
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      timeline.push({ p10: percentile(totals, 0.10), p50: percentile(totals, 0.50), p90: percentile(totals, 0.90), mean });
      assetOnlyTimeline.push({
        p10: percentile(assetTotals, 0.10),
        p50: percentile(assetTotals, 0.50),
        p90: percentile(assetTotals, 0.90),
        mean: assetTotals.reduce((a, b) => a + b, 0) / assetTotals.length,
      });

      const fireNumbers = pf.particles.map(p => this._fireNumberAt(m, p.inflationFactors[m]));
      const monthlyFireNumber = percentile([...fireNumbers].sort((a, b) => a - b), 0.50);
      retirementReadinessTimeline.push({
        fireNumber: monthlyFireNumber,
        successRate: pf.particles.filter((p, index) => p.total() >= fireNumbers[index]).length / totals.length,
      });
      const inflationFactors = pf.particles.map(p => p.inflationFactors[m]).sort((a, b) => a - b);
      inflationTimeline.push({ p10: percentile(inflationFactors, 0.10), p50: percentile(inflationFactors, 0.50), p90: percentile(inflationFactors, 0.90) });

      const typeSums = { checking: 0, hysa: 0, taxable: 0, retirement: 0, roth: 0, debt: 0 };
      const accountSums = Object.fromEntries(Object.keys(accounts).map(id => [id, 0]));
      for (const p of pf.particles) {
        const debt = Object.entries(accounts).reduce((sum, [id, account]) =>
          account.type === 'debt' ? sum + Math.max(0, -(p.accountBalances[id] || 0)) : sum, 0);
        p.maximumDebt = Math.max(p.maximumDebt, debt);
        maximumDebt = Math.max(maximumDebt, debt);
        for (const [id, acc] of Object.entries(accounts)) {
          const meanContribution = p.accountBalances[id] / pf.particles.length;
          typeSums[acc.type] = (typeSums[acc.type] || 0) + meanContribution;
          accountSums[id] += meanContribution;
        }
      }
      byAccountTypeTimeline.push(typeSums);
      byAccountTimeline.push(accountSums);

      if (this.retirementMonthIndex != null && m === this.retirementMonthIndex) {
        fireNumber = monthlyFireNumber;
        fireSuccessRate = retirementReadinessTimeline.at(-1).successRate;
      }

      // --- particle-filter weighting + resampling ---
      pf.updateWeights(p => p.hasShortfall ? -1 : p.total());
      const resampled = pf.maybeResample(p => p.clone());
      if (resampled) resampleEvents++;
      if ((m + 1) % monthProgressInterval === 0 || m + 1 === months) {
        yield { percent: 20 + Math.round((m + 1) / months * 75), phase: 'Running simulation', detail: `Month ${(m + 1).toLocaleString()} of ${months.toLocaleString()}` };
      }
    }

    yield { percent: 96, phase: 'Finalizing results', detail: 'Aggregating outcomes and risk measures' };
    const finalTotals = pf.particles.map(p => p.total());
    const startingNetWorth = Object.values(accounts).reduce((sum, account) => sum + Number(account.balance || 0), 0);
    const bankruptCount = pf.particles.filter((p, index) => p.hasShortfall || finalTotals[index] < 0).length;
    const endingBelowStartingCount = finalTotals.filter(total => total < startingNetWorth).length;
    const peakDebts = pf.particles.map(particle => particle.maximumDebt).sort((a, b) => a - b);
    const solvencyRate = 1 - bankruptCount / finalTotals.length;

    const fireStats = fireSuccessRate != null
      ? { fireNumber, successRate: fireSuccessRate, retirementMonthIndex: this.retirementMonthIndex }
      : null;
    const traceLimit = Math.min(50, pf.particles.length);
    const orderedForTraces = [...pf.particles.filter(p => p.hasShortfall), ...pf.particles.filter(p => !p.hasShortfall)];
    const selectedTraceParticles = orderedForTraces.slice(0, traceLimit);
    const individualTraces = selectedTraceParticles.map(p => [...p.netWorthHistory]);
    const individualTraceMeta = selectedTraceParticles.map(p => ({ failed: p.hasShortfall, failureMonthIndex: p.failureMonthIndex }));

    return {
      timeline,
      assetOnlyTimeline,
      byAccountTypeTimeline,
      byAccountTimeline,
      retirementReadinessTimeline,
      inflationTimeline,
      solvencyRate,
      bankruptcyCount: bankruptCount,
      particleCount: this.numParticles,
      endingBelowStartingCount,
      maximumDebt,
      maximumDebtStats: {
        p10: percentile(peakDebts, 0.10),
        p50: percentile(peakDebts, 0.50),
        p90: percentile(peakDebts, 0.90),
      },
      resampleEvents,
      fireStats,
      marketEventStats: this.marketEvents.map(event => ({
        id: event.id,
        name: event.name,
        configuredProbability: event.probability,
        triggeredPaths: eventTriggerCounts[event.id],
        triggerRate: eventTriggerCounts[event.id] / this.numParticles,
        triggerMonths: Object.entries(eventStartCounts[event.id]).map(([monthIndex, count]) => ({
          monthIndex: Number(monthIndex),
          paths: count,
          rate: count / this.numParticles,
        })),
      })),
      individualTraces,
      individualTraceMeta,
      finalParticles: pf.particles,
    };
  }

  /** 25x the nominal (inflation-escalated) annual continuous-expense run-rate active at month `m` (excludes debt/loan paydowns). */
  _fireNumberAt(m, inflationFactor = Math.pow(1 + this.inflationRate, m / 12)) {
    const date = monthIndex(this.startDate, m);
    let annualExpense = 0;
    for (const b of this.blocks) {
      if (b.category !== 'expense' || b.kind !== 'continuous') continue;
      if (b.debtAccountId) continue; // debt payments aren't "living expenses"
      if (!blockActiveInMonth(b, date)) continue;
      let annual = nominalMonthlyAmount(b, date) * 12;
      if (b.inflationAdjusted !== false) annual *= inflationFactor;
      annualExpense += annual;
    }
    return annualExpense * 25;
  }
}

