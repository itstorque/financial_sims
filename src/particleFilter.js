// Generic particle-filter utilities used to propagate uncertainty (error
// bars) forward through the simulation while avoiding particle degeneracy.
//
// Unlike a textbook particle filter (which corrects against real
// observations), here we don't have future ground-truth data to condition
// on. Instead we use the classic weight/resample machinery to down-weight
// (and eventually cull) particles that go bankrupt (sustained negative net
// worth), which keeps the surviving particle cloud representative of
// "plausible, solvent" futures rather than being dominated by a few runaway
// trajectories. This is a modeling choice — it can be disabled by the caller
// to get plain (unweighted) Monte Carlo.

/** Weight particles: 1.0 if solvent, a small epsilon if bankrupt. */
export function bankruptcyWeight(totalBalance, priorWeight = 1, penalty = 0.02) {
  const insolvent = totalBalance < 0;
  return insolvent ? priorWeight * penalty : priorWeight;
}

export function effectiveSampleSize(weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  const norm = weights.map(w => w / sum);
  const sumSq = norm.reduce((a, w) => a + w * w, 0);
  return sumSq === 0 ? weights.length : 1 / sumSq;
}

/** Systematic resampling: returns an array of indices to draw from `particles`. */
export function systematicResampleIndices(weights) {
  const n = weights.length;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map((_, i) => i); // degenerate: keep as-is
  const norm = weights.map(w => w / sum);
  const cumulative = [];
  let acc = 0;
  for (const w of norm) { acc += w; cumulative.push(acc); }

  const start = Math.random() / n;
  const indices = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = start + i / n;
    while (j < cumulative.length - 1 && cumulative[j] < target) j++;
    indices[i] = j;
  }
  return indices;
}

/**
 * ParticleFilter: holds an array of arbitrary particle state objects plus
 * weights, and supports weighted resampling when the effective sample size
 * drops below a threshold (fraction of N).
 */
export class ParticleFilter {
  constructor(particles, { essThresholdFraction = 0.5, resamplePenalty = 0.02, enabled = true } = {}) {
    this.particles = particles;
    this.weights = new Array(particles.length).fill(1);
    this.essThresholdFraction = essThresholdFraction;
    this.resamplePenalty = resamplePenalty;
    this.enabled = enabled;
  }

  /** Update weights from a scoring function `scoreFn(particle) -> totalBalance`. */
  updateWeights(scoreFn) {
    if (!this.enabled) return;
    this.weights = this.particles.map((p, i) => bankruptcyWeight(scoreFn(p), this.weights[i], this.resamplePenalty));
  }

  /** Resample (systematic) if ESS falls below threshold; deep-cloning particle state via `cloneFn`. */
  maybeResample(cloneFn) {
    if (!this.enabled) return false;
    const n = this.particles.length;
    const ess = effectiveSampleSize(this.weights);
    if (ess < this.essThresholdFraction * n) {
      const idx = systematicResampleIndices(this.weights);
      this.particles = idx.map(i => cloneFn(this.particles[i]));
      this.weights = new Array(n).fill(1);
      return true;
    }
    return false;
  }
}
