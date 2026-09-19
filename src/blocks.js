// Income & expense "blocks" — the building blocks a user adds to the plan.
//
// category: 'income' | 'expense'
// kind:     'one-time' | 'continuous'   (continuous = recurring monthly)
// A block runs from `startMonth` (YYYY-MM) to `endMonth` (YYYY-MM, inclusive,
// or null = runs through the end of the simulation / a life-event like
// retirement, handled by the caller passing an endMonth).
//
// `amount` is the ANNUAL amount for continuous blocks (spread evenly over the
// 12 months), or the total one-time amount for one-time blocks.
//
// `preTax` (income only): true = amount is GROSS pay, taxes are computed and
// only the net lands in the target account (unless the target is a
// tax-deferred retirement account, in which case the full gross amount is
// contributed and federal/state income tax is deferred — FICA still applies).
// false = amount is already NET/post-tax and is credited in full.
//
// `sigma` (optional, fraction e.g. 0.05) adds independent noise to the amount
// each month it applies, propagated through the particle simulation.

let _idCounter = 0;
export function nextBlockId() {
  return 'blk_' + (++_idCounter) + '_' + Date.now().toString(36);
}

export function createBlock({
  id, category, kind = 'continuous', description = '', amount = 0,
  startMonth, endMonth = null, preTax = false, targetAccountId = null,
  sourceAccountId = null, sigma = 0,
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
    sigma: Number(sigma) || 0,
  };
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Is this block active in the given calendar month? */
export function blockActiveInMonth(block, date) {
  const key = monthKey(date);
  if (block.startMonth && key < block.startMonth) return false;
  if (block.endMonth && key > block.endMonth) return false;
  if (block.kind === 'one-time') {
    return key === block.startMonth;
  }
  return true;
}

/** Nominal (noise-free) amount contributed/withdrawn in a given active month. */
export function nominalMonthlyAmount(block) {
  if (block.kind === 'one-time') return block.amount;
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
export function sampledMonthlyAmount(block) {
  const nominal = nominalMonthlyAmount(block);
  if (!block.sigma) return nominal;
  const noisy = nominal * (1 + randNormal(0, block.sigma));
  // Don't let noise flip the sign of a normally-positive amount.
  return nominal >= 0 ? Math.max(0, noisy) : Math.min(0, noisy);
}
