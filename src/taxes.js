// Progressive tax model: federal brackets + state/city rates + FICA.
// NOTE: Simplified vs. real tax code (no itemized deductions, credits,
// phase-outs, qualified-dividend rates, AMT, etc.) but uses real
// marginal-bracket math so the *shape* of progressivity is correct.
// Single-filer brackets shown; treat this as a planning approximation,
// not tax advice.

// 2024 federal single-filer brackets (upTo = top of bracket, Infinity = no cap)
export const FEDERAL_BRACKETS_SINGLE = [
  { upTo: 11600, rate: 0.10 },
  { upTo: 47150, rate: 0.12 },
  { upTo: 100525, rate: 0.22 },
  { upTo: 191950, rate: 0.24 },
  { upTo: 243725, rate: 0.32 },
  { upTo: 609350, rate: 0.35 },
  { upTo: Infinity, rate: 0.37 },
];

export const FEDERAL_STANDARD_DEDUCTION_SINGLE = 14600;

// FICA (2024 figures). Social Security wage base grows over time; we let the
// simulation escalate it with a simple inflation assumption per year.
export const FICA = {
  socialSecurityRate: 0.062,
  socialSecurityWageBase2024: 168600,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareThreshold: 200000, // single filer
  wageBaseGrowth: 0.03, // assumed annual growth of the SS wage base
};

// City -> state/local tax assumptions. Where a state has real progressive
// brackets we model them; otherwise a flat approximation is used.
// `cityRate` is an additional flat local income tax (e.g. NYC).
export const CITY_TAX_TABLE = {
  'San Francisco, CA': {
    state: { type: 'brackets', brackets: [
      { upTo: 10412, rate: 0.01 },
      { upTo: 24684, rate: 0.02 },
      { upTo: 38959, rate: 0.04 },
      { upTo: 54081, rate: 0.06 },
      { upTo: 68350, rate: 0.08 },
      { upTo: 349137, rate: 0.093 },
      { upTo: 418961, rate: 0.103 },
      { upTo: 698271, rate: 0.113 },
      { upTo: Infinity, rate: 0.123 },
    ]},
    cityRate: 0,
  },
  'New York, NY': {
    state: { type: 'brackets', brackets: [
      { upTo: 8500, rate: 0.04 },
      { upTo: 11700, rate: 0.045 },
      { upTo: 13900, rate: 0.0525 },
      { upTo: 80650, rate: 0.055 },
      { upTo: 215400, rate: 0.06 },
      { upTo: 1077550, rate: 0.0685 },
      { upTo: Infinity, rate: 0.0965 },
    ]},
    cityRate: 0.03, // approximate flat NYC add-on
  },
  'Austin, TX': { state: { type: 'flat', rate: 0 }, cityRate: 0 },
  'Seattle, WA': { state: { type: 'flat', rate: 0 }, cityRate: 0 },
  'Miami, FL': { state: { type: 'flat', rate: 0 }, cityRate: 0 },
  'Denver, CO': { state: { type: 'flat', rate: 0.044 }, cityRate: 0 },
  'Chicago, IL': { state: { type: 'flat', rate: 0.0495 }, cityRate: 0 },
  Default: { state: { type: 'flat', rate: 0.05 }, cityRate: 0 },
};

export function cities() {
  return Object.keys(CITY_TAX_TABLE);
}

/** Apply marginal brackets to a taxable-income amount. */
export function progressiveTax(taxableIncome, brackets) {
  if (taxableIncome <= 0) return 0;
  let tax = 0;
  let prevCap = 0;
  for (const b of brackets) {
    if (taxableIncome <= prevCap) break;
    const slice = Math.min(taxableIncome, b.upTo) - prevCap;
    tax += slice * b.rate;
    prevCap = b.upTo;
  }
  return tax;
}

/** FICA taxes for a given wage amount and (inflated) SS wage base for the year. */
export function ficaTax(wages, ssWageBase = FICA.socialSecurityWageBase2024) {
  const ssTaxable = Math.min(wages, ssWageBase);
  const socialSecurity = ssTaxable * FICA.socialSecurityRate;
  const medicare = wages * FICA.medicareRate;
  const additionalMedicare = Math.max(0, wages - FICA.additionalMedicareThreshold) * FICA.additionalMedicareRate;
  return { socialSecurity, medicare, additionalMedicare, total: socialSecurity + medicare + additionalMedicare };
}

/**
 * Compute full annual tax breakdown for a given gross wage income.
 * `yearIndex` (0 = first sim year) is used to inflate the SS wage base.
 */
export function computeAnnualTax(grossWages, city = 'Default', yearIndex = 0) {
  const cityCfg = CITY_TAX_TABLE[city] || CITY_TAX_TABLE.Default;

  const taxableFederal = Math.max(0, grossWages - FEDERAL_STANDARD_DEDUCTION_SINGLE);
  const federal = progressiveTax(taxableFederal, FEDERAL_BRACKETS_SINGLE);

  let state = 0;
  if (cityCfg.state.type === 'brackets') {
    // States generally have their own (smaller) standard deduction; we reuse
    // taxable income at face value here for simplicity (no state deduction).
    state = progressiveTax(grossWages, cityCfg.state.brackets);
  } else {
    state = grossWages * cityCfg.state.rate;
  }

  const cityTax = grossWages * (cityCfg.cityRate || 0);

  const ssWageBase = FICA.socialSecurityWageBase2024 * Math.pow(1 + FICA.wageBaseGrowth, yearIndex);
  const fica = ficaTax(grossWages, ssWageBase);

  const totalTax = federal + state + cityTax + fica.total;
  const net = grossWages - totalTax;
  const effectiveRate = grossWages > 0 ? totalTax / grossWages : 0;

  return { gross: grossWages, federal, state, city: cityTax, fica, totalTax, net, effectiveRate };
}

// Backwards-compatible simple helper (flat approximation) — kept for callers
// that just want a quick net estimate without the full breakdown.
export function applyTaxes(grossIncome, city = 'Default') {
  return computeAnnualTax(grossIncome, city, 0);
}
