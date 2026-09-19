// Standard mortgage-affordability math (front-end/back-end DTI ratios).
// Not tied to the Monte Carlo — a quick deterministic "what can I afford" tool.

/** Monthly principal+interest payment for a loan. */
export function monthlyPI(principal, annualRate, termYears) {
  const r = annualRate / 12;
  const n = termYears * 12;
  if (r === 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

/**
 * Estimate the maximum home price affordable given gross monthly income,
 * existing monthly debt payments, a down payment, and standard 28/36 DTI
 * guardrails (front-end: housing <= 28% of gross income; back-end: housing +
 * other debt <= 36%). Also folds in property tax, insurance, and HOA as
 * monthly carrying costs (PITI + HOA).
 */
export function maxHomePrice({
  grossMonthlyIncome,
  existingMonthlyDebt = 0,
  downPaymentAmount = 0,
  annualRate = 0.065,
  termYears = 30,
  propertyTaxRate = 0.011, // annual, % of home price
  annualInsurance = 1800,
  monthlyHOA = 0,
  frontEndRatio = 0.28,
  backEndRatio = 0.36,
}) {
  const frontEndBudget = grossMonthlyIncome * frontEndRatio;
  const backEndBudget = grossMonthlyIncome * backEndRatio - existingMonthlyDebt;
  const monthlyBudgetForHousing = Math.max(0, Math.min(frontEndBudget, backEndBudget));

  // Solve for home price P such that:
  //   monthlyPI(P - down, rate, term) + P*propertyTaxRate/12 + annualInsurance/12 + HOA = budget
  // Binary search since PI is nonlinear in P (but monotonic).
  let lo = downPaymentAmount, hi = downPaymentAmount + 20_000_000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const loanAmt = Math.max(0, mid - downPaymentAmount);
    const pi = monthlyPI(loanAmt, annualRate, termYears);
    const carrying = pi + (mid * propertyTaxRate) / 12 + annualInsurance / 12 + monthlyHOA;
    if (carrying > monthlyBudgetForHousing) hi = mid; else lo = mid;
  }
  const price = lo;
  const loanAmt = Math.max(0, price - downPaymentAmount);
  const pi = monthlyPI(loanAmt, annualRate, termYears);
  const monthlyCarrying = pi + (price * propertyTaxRate) / 12 + annualInsurance / 12 + monthlyHOA;

  return {
    maxPrice: price,
    loanAmount: loanAmt,
    monthlyPI: pi,
    monthlyCarrying,
    monthlyBudgetForHousing,
  };
}
