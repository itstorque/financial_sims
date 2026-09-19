// Core simulation engine: monthly timeline, per-account returns schedules,
// progressive-tax-aware income crediting, and particle-filter propagation
// of uncertainty (error bars).

import { ReturnsSchedule } from './returnsSchedule.js';
import { blockActiveInMonth, sampledMonthlyAmount } from './blocks.js';
import { computeAnnualTax } from './taxes.js';
import { ParticleFilter } from './particleFilter.js';

export { ReturnsSchedule };

export function monthIndex(startDate, monthsFromStart) {
  const d = new Date(startDate);
  d.setDate(1);
  d.setMonth(d.getMonth() + monthsFromStart);
  return d;
}

function randNormal(mu = 0, sigma = 1) {
  if (sigma === 0) return mu;
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * sigma + mu;
}

function percentile(sortedVals, p) {
  const idx = Math.min(sortedVals.length - 1, Math.max(0, Math.floor(sortedVals.length * p)));
  return sortedVals[idx];
}

/** Precompute each block's sampled (noisy) contribution for every month of the sim. */
function precomputeBlockAmounts(blocks, startDate, months) {
  const perMonth = [];
  for (let m = 0; m < months; m++) {
    const date = monthIndex(startDate, m);
    const row = {};
    for (const b of blocks) {
      if (blockActiveInMonth(b, date)) row[b.id] = sampledMonthlyAmount(b);
    }
    perMonth.push(row);
  }
  return perMonth;
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

class ParticleState {
  constructor(accountBalances, blockAmounts, effectiveRatesByYear) {
    this.accountBalances = accountBalances; // {id: number}
    this.blockAmounts = blockAmounts;       // shared reference, immutable
    this.effectiveRatesByYear = effectiveRatesByYear; // shared reference, immutable
  }
  clone() {
    return new ParticleState({ ...this.accountBalances }, this.blockAmounts, this.effectiveRatesByYear);
  }
  total() {
    return Object.values(this.accountBalances).reduce((s, v) => s + v, 0);
  }
}

export class Simulator {
  constructor({
    startDate, months, accounts, blocks, globalReturnsSchedule,
    city = 'Default', numParticles = 300, useParticleFilter = true,
    retirementMonthIndex = null,
  }) {
    this.startDate = new Date(startDate);
    this.months = months;
    this.accounts = accounts;
    this.blocks = blocks;
    this.globalReturnsSchedule = globalReturnsSchedule || new ReturnsSchedule([]);
    this.city = city;
    this.numParticles = numParticles;
    this.useParticleFilter = useParticleFilter;
    this.retirementMonthIndex = retirementMonthIndex;
  }

  _returnsScheduleFor(account) {
    return account.useCustomReturns && account.returnsSchedule ? account.returnsSchedule : this.globalReturnsSchedule;
  }

  run() {
    const { startDate, months, accounts, blocks, city } = this;
    const defaultChecking = firstAccountOfType(accounts, 'checking');

    // 1) Build N independent particles, each with its own noise draws for
    //    block amounts and its own resulting effective tax rates by year.
    let particles = [];
    for (let i = 0; i < this.numParticles; i++) {
      const blockAmounts = precomputeBlockAmounts(blocks, startDate, months);
      const effectiveRatesByYear = computeEffectiveRatesByYear(blocks, accounts, blockAmounts, startDate, months, city);
      const balances = {};
      for (const [id, acc] of Object.entries(accounts)) balances[id] = acc.balance;
      particles.push(new ParticleState(balances, blockAmounts, effectiveRatesByYear));
    }

    const pf = new ParticleFilter(particles, { enabled: this.useParticleFilter, essThresholdFraction: 0.5, resamplePenalty: 0.02 });

    const timeline = []; // per month: {p10,p50,p90,mean}
    const byAccountTypeTimeline = []; // per month: {checking,hysa,taxable,retirement,debt}
    let resampleEvents = 0;
    let fireSuccessRate = null;
    let fireNumber = null;

    for (let m = 0; m < months; m++) {
      const date = monthIndex(startDate, m);
      const year = date.getFullYear();

      for (const p of pf.particles) {
        // --- apply returns to every account ---
        for (const [id, acc] of Object.entries(accounts)) {
          const sched = this._returnsScheduleFor(acc).getFor(date);
          const schedSigmaMonthly = (sched.sigma || 0) / Math.sqrt(12);
          const extraSigma = acc.sigma || 0;
          const totalSigma = Math.sqrt(schedSigmaMonthly ** 2 + extraSigma ** 2);
          const mu = sched.annual / 12;
          const noise = randNormal(mu, totalSigma);
          p.accountBalances[id] *= (1 + noise);
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
          } else {
            // expense
            const sourceId = b.sourceAccountId && accounts[b.sourceAccountId] ? b.sourceAccountId : defaultChecking?.id;
            if (sourceId) p.accountBalances[sourceId] -= amt;

            // optional: expense also functions as a debt payment
            if (b.debtAccountId && accounts[b.debtAccountId]) {
              const debtAcc = accounts[b.debtAccountId];
              const paidDown = Math.min(amt, -p.accountBalances[b.debtAccountId]); // don't overpay past zero
              p.accountBalances[b.debtAccountId] += Math.max(0, paidDown);
            }
          }
        }
      }

      // --- collect stats for this month across the ensemble ---
      const totals = pf.particles.map(p => p.total()).sort((a, b) => a - b);
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      timeline.push({ p10: percentile(totals, 0.10), p50: percentile(totals, 0.50), p90: percentile(totals, 0.90), mean });

      const typeSums = { checking: 0, hysa: 0, taxable: 0, retirement: 0, debt: 0 };
      for (const p of pf.particles) {
        for (const [id, acc] of Object.entries(accounts)) {
          typeSums[acc.type] = (typeSums[acc.type] || 0) + p.accountBalances[id] / pf.particles.length;
        }
      }
      byAccountTypeTimeline.push(typeSums);

      if (this.retirementMonthIndex != null && m === this.retirementMonthIndex) {
        fireNumber = this._fireNumberAt(m);
        fireSuccessRate = totals.filter(v => v >= fireNumber).length / totals.length;
      }

      // --- particle-filter weighting + resampling ---
      pf.updateWeights(p => p.total());
      const resampled = pf.maybeResample(p => p.clone());
      if (resampled) resampleEvents++;
    }

    const finalTotals = pf.particles.map(p => p.total());
    const bankruptCount = finalTotals.filter(v => v < 0).length;
    const solvencyRate = 1 - bankruptCount / finalTotals.length;

    const fireStats = fireSuccessRate != null
      ? { fireNumber, successRate: fireSuccessRate, retirementMonthIndex: this.retirementMonthIndex }
      : null;

    return {
      timeline,
      byAccountTypeTimeline,
      solvencyRate,
      resampleEvents,
      fireStats,
      finalParticles: pf.particles,
    };
  }

  /** 25x the nominal annual continuous-expense run-rate active at month `m` (excludes debt paydowns). */
  _fireNumberAt(m) {
    const date = monthIndex(this.startDate, m);
    let annualExpense = 0;
    for (const b of this.blocks) {
      if (b.category !== 'expense' || b.kind !== 'continuous') continue;
      if (b.debtAccountId) continue; // debt payments aren't "living expenses"
      if (!blockActiveInMonth(b, date)) continue;
      annualExpense += b.amount;
    }
    return annualExpense * 25;
  }
}

