// A simple, illustrative model of a child's cost-of-living in a high-cost
// metro (calibrated loosely to San Francisco). Real costs vary enormously by
// family — treat these as a reasonable *starting point* to edit, not gospel.
//
// Costs are annual, in today's dollars, and vary by the child's age band to
// capture the well-known "daycare is brutally expensive, school-age is
// cheaper, teens creep back up" shape of child-rearing costs.
import { AmountSchedule } from './blocks.js';

// [minAge, maxAge, annualCost] — inclusive age range in years.
export const SF_CHILD_COST_BRACKETS = [
  { minAge: 0, maxAge: 0, annualCost: 24000 },   // infant: part-time nanny share, gear, medical
  { minAge: 1, maxAge: 3, annualCost: 36000 },   // toddler: full-time SF daycare (~$2.5-3k/mo)
  { minAge: 4, maxAge: 4, annualCost: 30000 },   // pre-K
  { minAge: 5, maxAge: 13, annualCost: 18000 },  // school-age: after-school care + activities
  { minAge: 14, maxAge: 17, annualCost: 24000 }, // teen: activities, tutoring, driving
  { minAge: 18, maxAge: 99, annualCost: 0 },     // assumed independent / college costs not modeled here
];

function addYears(monthKey, years) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${y + years}-${String(m).padStart(2, '0')}`;
}
function addYearsMinusOneMonth(monthKey, years) {
  const [y, m] = monthKey.split('-').map(Number);
  const totalMonths = y * 12 + (m - 1) + years * 12 - 1;
  const yy = Math.floor(totalMonths / 12);
  const mm = (totalMonths % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

/**
 * Build an AmountSchedule of a child's estimated annual cost of living,
 * anchored to their birth month ("YYYY-MM"), using SF_CHILD_COST_BRACKETS.
 */
export function childCostAmountSchedule(birthMonth, brackets = SF_CHILD_COST_BRACKETS) {
  const entries = brackets.map(b => ({
    from: addYears(birthMonth, b.minAge),
    to: addYearsMinusOneMonth(birthMonth, b.maxAge + 1),
    annualAmount: b.annualCost,
  }));
  return new AmountSchedule(entries);
}
