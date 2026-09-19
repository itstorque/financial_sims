// A ReturnsSchedule describes annualized return (and optional volatility)
// over time as a sequence of segments, e.g.:
//   [{from:'2026-04', to:'2026-12', annual:0.10, sigma:0.12},
//    {from:'2027-01', to:'2027-12', annual:-0.15, sigma:0.30}]
// Any month not covered by a segment falls back to `defaultAnnual`/`defaultSigma`.
// This lets you model things like "10% through year end, then a -15% year,
// then a steady 6% afterwards" (the trailing segment can use to:'9999-12').

export class ReturnsSchedule {
  constructor(entries = [], { defaultAnnual = 0.06, defaultSigma = 0.08 } = {}) {
    this.entries = entries.map(e => ({ ...e }));
    this.defaultAnnual = defaultAnnual;
    this.defaultSigma = defaultSigma;
  }

  static monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  getFor(date) {
    const key = ReturnsSchedule.monthKey(date);
    for (const e of this.entries) {
      if (e.from <= key && key <= e.to) {
        return { annual: e.annual, sigma: e.sigma ?? this.defaultSigma };
      }
    }
    return { annual: this.defaultAnnual, sigma: this.defaultSigma };
  }

  clone() {
    return new ReturnsSchedule(this.entries, { defaultAnnual: this.defaultAnnual, defaultSigma: this.defaultSigma });
  }
}

export function defaultReturnsSchedule() {
  // A gentle example schedule: strong short-term run-up, a down year, then
  // reverts to a steady long-run assumption via defaultAnnual.
  return new ReturnsSchedule([
    { from: '2026-04', to: '2026-12', annual: 0.10, sigma: 0.12 },
    { from: '2027-01', to: '2027-12', annual: -0.15, sigma: 0.25 },
  ], { defaultAnnual: 0.06, defaultSigma: 0.09 });
}
