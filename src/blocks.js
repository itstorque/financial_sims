// Income & expense "blocks" — the building blocks a user adds to the plan.
//
// category: 'income' | 'expense'
// kind:     'one-time' | 'continuous' | 'loan'
//   - 'one-time' / 'continuous': see below.
//   - 'loan': a financed purchase (e.g. a house). Handled specially by the
//     simulator (see sim.js) — it isn't a plain cash-flow amount, it
//     represents a down payment + an amortizing mortgage against a linked
//     debt account. See `createLoanBlock` below.
//
// A block runs from `startMonth` (YYYY-MM) to `endMonth` (YYYY-MM, inclusive,
// or null = runs through the end of the simulation / a life-event like
// retirement, handled by the caller passing an endMonth).
//
// `amount` is the ANNUAL amount for continuous blocks (spread evenly over the
// 12 months), or the total one-time amount for one-time blocks.
//
// A continuous block can instead opt into a piecewise `amountSchedule`
// (`useCustomSchedule: true`), letting the annual amount vary over time —
// e.g. "$120k/yr through 2030, then $60k/yr for 5 years (a sabbatical),
// then $0 for the rest of the simulation." Months not covered by any segment
// contribute $0 (nothing "falls back" the way account returns do).
//
// `preTax` (income only): true = amount is GROSS pay, taxes are computed and
// only the net lands in the target account (unless the target is a
// tax-deferred retirement account, in which case the full gross amount is
// contributed and federal/state income tax is deferred — FICA still applies).
// false = amount is already NET/post-tax and is credited in full.
//
// `sigma` (optional, fraction e.g. 0.05) adds independent noise to the amount
// each month it applies, propagated through the particle simulation.

import { monthlyPI } from './affordability.js';

let _idCounter = 0;
export function nextBlockId() {
  return 'blk_' + (++_idCounter) + '_' + Date.now().toString(36);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function keyToIdx(key) {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
}
function idxToKey(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Turn a possibly overlapping, open-ended amount schedule into named,
 * contiguous clips covering the visible simulation window. Existing
 * last-match-wins behavior is preserved when resolving overlaps.
 */
export function buildScheduleClips(entries, startMonth, endMonth) {
  const start = keyToIdx(startMonth);
  const end = keyToIdx(endMonth);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const clips = [];
  let active = null;
  for (let month = start; month <= end; month++) {
    const key = idxToKey(month);
    let sourceIndex = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].from <= key && key <= entries[i].to) sourceIndex = i;
    }
    const source = sourceIndex >= 0 ? entries[sourceIndex] : null;
    const annualAmount = Number(source?.annualAmount) || 0;
    const signature = sourceIndex >= 0 ? `source:${sourceIndex}` : 'gap';
    if (!active || active.signature !== signature) {
      if (active) clips.push(active);
      active = {
        signature,
        from: key,
        to: key,
        name: source?.name || '',
        annualAmount,
      };
    } else {
      active.to = key;
    }
  }
  if (active) clips.push(active);

  return clips.map((clip, index) => ({
    from: clip.from,
    to: clip.to,
    name: clip.name || (clip.annualAmount === 0 ? 'Paused' : `Clip ${index + 1}`),
    annualAmount: clip.annualAmount,
  }));
}

/** Split one canonical clip at `splitMonth`; that month begins the new clip. */
export function spliceScheduleClip(entries, clipIndex, splitMonth) {
  const clip = entries[clipIndex];
  if (!clip) return false;
  const split = keyToIdx(splitMonth);
  const start = keyToIdx(clip.from);
  const end = keyToIdx(clip.to);
  if (!Number.isFinite(split) || split <= start || split > end) return false;

  const left = { ...clip, to: idxToKey(split - 1) };
  const right = {
    ...clip,
    from: idxToKey(split),
    name: `${clip.name || 'Clip'} — next`,
  };
  entries.splice(clipIndex, 1, left, right);
  return true;
}

// A piecewise schedule of ANNUAL amounts over time, e.g.:
//   [{from:'2026-01', to:'2030-12', annualAmount:120000},
//    {from:'2031-01', to:'2035-12', annualAmount:60000}]
// Any month not covered by a segment contributes $0 (no implicit fallback —
// "silence" after the last segment means the income/expense has stopped).
// Segments are evaluated in array order and LATER entries win where ranges
// overlap — this lets you add a segment on top of an existing open-ended one
// (e.g. append a "$0 from 2035 onward" segment to cut off an earlier
// "$60k/yr forever" tail) without having to edit the earlier segment's `to`.
export class AmountSchedule {
  constructor(entries = []) {
    this.entries = entries.map(e => ({ ...e }));
  }
  getAnnualAmountFor(date) {
    const key = monthKey(date);
    let result = 0;
    for (const e of this.entries) {
      if (e.from <= key && key <= e.to) result = Number(e.annualAmount) || 0;
    }
    return result;
  }
  clone() {
    return new AmountSchedule(this.entries);
  }
}

export function createBlock({
  id, category, kind = 'continuous', description = '', amount = 0,
  startMonth, endMonth = null, preTax = false, targetAccountId = null,
  sourceAccountId = null, debtAccountId = null, sigma = 0,
  useCustomSchedule = false, amountSchedule = null,
} = {}) {
  return {
    id: id || nextBlockId(),
    category, // 'income' | 'expense'
    kind,      // 'one-time' | 'continuous'
    description,
    amount: Number(amount) || 0,
    startMonth,
    endMonth,
    preTax: !!preTax,
    targetAccountId,   // where income lands
    sourceAccountId,   // where an expense/debt-payment is drawn from (defaults to first checking-like account)
    debtAccountId,     // optional: an expense that also pays down a debt account
    sigma: Number(sigma) || 0,
    useCustomSchedule: !!useCustomSchedule, // continuous blocks only
    amountSchedule: amountSchedule instanceof AmountSchedule
      ? amountSchedule
      : new AmountSchedule((amountSchedule && amountSchedule.entries) || (startMonth ? [{ from: startMonth, to: '9999-12', annualAmount: amount }] : [])),
  };
}

// --- Financed purchases ("loan" blocks): down payment + amortizing mortgage ---
//
// A loan block ties together three effects, all driven off a handful of
// simple inputs (purchase price, down-payment %, annual rate, term):
//   1. At `startMonth`: a one-time cash outflow of the down payment from
//      `sourceAccountId`, AND the loan principal is "originated" into
//      `debtAccountId` (its balance jumps from 0 to -(loanAmount)).
//   2. Every month from `startMonth` through `startMonth + termYears*12 - 1`:
//      a fixed cash outflow (the standard amortized payment) from
//      `sourceAccountId`, applied as a paydown against `debtAccountId`.
//   3. The debt account's own returns schedule (set to the mortgage rate)
//      accrues interest on the outstanding balance every month, exactly like
//      any other debt account — so this reuses the normal debt-appreciation
//      machinery rather than reimplementing amortization from scratch.
//
// `debtAccountId` must point to a dedicated `debt`-type Account (typically
// auto-created alongside the block) with `balance: 0` and a custom returns
// schedule whose `defaultAnnual` equals the mortgage rate.
export function createLoanBlock({
  id, description = 'Home purchase', startMonth,
  purchasePrice = 0, downPaymentPct = 0.2, annualRate = 0.065, termYears = 30,
  sourceAccountId = null, debtAccountId = null,
} = {}) {
  return {
    id: id || nextBlockId(),
    category: 'expense',
    kind: 'loan',
    description,
    startMonth,
    endMonth: null,
    purchasePrice: Number(purchasePrice) || 0,
    downPaymentPct: Number(downPaymentPct) || 0,
    annualRate: Number(annualRate) || 0,
    termYears: Number(termYears) || 30,
    sourceAccountId,
    debtAccountId,
    sigma: 0,
  };
}

export function loanDownPaymentAmount(block) {
  return block.purchasePrice * block.downPaymentPct;
}
export function loanPrincipal(block) {
  return block.purchasePrice * (1 - block.downPaymentPct);
}
export function loanMonthlyPayment(block) {
  return monthlyPI(loanPrincipal(block), block.annualRate, block.termYears);
}
/** [startKey, endKey] (inclusive, "YYYY-MM" strings) during which the mortgage payment applies. */
export function loanPaymentWindow(block) {
  const startIdx = keyToIdx(block.startMonth);
  return [block.startMonth, idxToKey(startIdx + block.termYears * 12 - 1)];
}

/** Is this block active in the given calendar month? */
export function blockActiveInMonth(block, date) {
  if (block.kind === 'loan') return false; // loan blocks are applied via a dedicated code path in sim.js
  if (block.kind === 'one-time') {
    return monthKey(date) === block.startMonth;
  }
  if (block.useCustomSchedule) return true; // AmountSchedule itself zeroes out uncovered months
  const key = monthKey(date);
  if (block.startMonth && key < block.startMonth) return false;
  if (block.endMonth && key > block.endMonth) return false;
  return true;
}

/** Nominal (noise-free) amount contributed/withdrawn in a given active month. */
export function nominalMonthlyAmount(block, date) {
  if (block.kind === 'one-time') return block.amount;
  if (block.useCustomSchedule && block.amountSchedule) {
    return block.amountSchedule.getAnnualAmountFor(date) / 12;
  }
  return block.amount / 12;
}

function randNormal(mu = 0, sigma = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * sigma + mu;
}

/** Sampled monthly amount including optional Gaussian noise (sigma is a fraction of amount). */
export function sampledMonthlyAmount(block, date) {
  const nominal = nominalMonthlyAmount(block, date);
  if (!block.sigma) return nominal;
  const noisy = nominal * (1 + randNormal(0, block.sigma));
  // Don't let noise flip the sign of a normally-positive amount.
  return nominal >= 0 ? Math.max(0, noisy) : Math.min(0, noisy);
}


