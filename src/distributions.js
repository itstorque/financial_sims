// Shared random-number and probability-distribution utilities.
// All samplers accept an injected RNG so complete simulation runs can be
// reproduced from a scenario seed.

export const DISTRIBUTION_FAMILIES = ['normal', 'lognormal', 'studentT', 'triangular', 'uniform', 'discreteUniform', 'discrete'];

export function createSeededRandom(seed) {
  const text = String(seed ?? '').trim();
  if (!text) return Math.random;
  let state = 2166136261;
  for (let i = 0; i < text.length; i++) {
    state ^= text.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return function seededRandom() {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randNormal(random = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape, random) {
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = randNormal(random);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function normalizeDistribution(spec, fallbackScale = 0) {
  if (!spec || typeof spec !== 'object') return { family: 'normal', scale: Math.max(0, Number(fallbackScale) || 0) };
  const family = DISTRIBUTION_FAMILIES.includes(spec.family) ? spec.family : 'normal';
  const normalized = { ...spec, family };
  if (family === 'normal' || family === 'lognormal' || family === 'studentT') normalized.scale = Math.max(0, Number(spec.scale ?? fallbackScale) || 0);
  if (family === 'studentT') normalized.degreesOfFreedom = Math.max(2.01, Number(spec.degreesOfFreedom) || 7);
  if (family === 'triangular') {
    const scale = Math.max(0, Number(spec.scale ?? fallbackScale) || 0);
    normalized.low = Number.isFinite(Number(spec.low)) ? Number(spec.low) : -scale;
    normalized.mode = Number.isFinite(Number(spec.mode)) ? Number(spec.mode) : 0;
    normalized.high = Number.isFinite(Number(spec.high)) ? Number(spec.high) : scale;
    if (normalized.low > normalized.high) [normalized.low, normalized.high] = [normalized.high, normalized.low];
    normalized.mode = Math.min(normalized.high, Math.max(normalized.low, normalized.mode));
  }
  if (family === 'uniform') {
    const scale = Math.max(0, Number(spec.scale ?? fallbackScale) || 0);
    normalized.low = Number.isFinite(Number(spec.low)) ? Number(spec.low) : -scale;
    normalized.high = Number.isFinite(Number(spec.high)) ? Number(spec.high) : scale;
    if (normalized.low > normalized.high) [normalized.low, normalized.high] = [normalized.high, normalized.low];
  }
  if (family === 'discreteUniform') {
    const scale = Math.max(0, Number(spec.scale ?? fallbackScale) || 0);
    normalized.values = Array.isArray(spec.values) && spec.values.length
      ? spec.values.map(Number).filter(Number.isFinite)
      : [-scale, 0, scale];
    if (!normalized.values.length) normalized.values = [0];
  }
  if (family === 'discrete') {
    normalized.outcomes = Array.isArray(spec.outcomes) && spec.outcomes.length
      ? spec.outcomes.map(item => ({ value: Number(item.value) || 0, weight: Math.max(0, Number(item.weight) || 0) }))
      : [{ value: 0, weight: 1 }];
  }
  return normalized;
}

// Samples an additive shock centered at zero. `scale` is a standard deviation
// for normal/Student-t and a log-space standard deviation for lognormal.
export function sampleShock(spec, random = Math.random) {
  const dist = normalizeDistribution(spec);
  if (dist.family === 'normal') return dist.scale === 0 ? 0 : randNormal(random) * dist.scale;
  if (dist.family === 'studentT') {
    const df = dist.degreesOfFreedom;
    const rawT = randNormal(random) / Math.sqrt((2 * sampleGamma(df / 2, random)) / df);
    return rawT * dist.scale * Math.sqrt((df - 2) / df);
  }
  if (dist.family === 'lognormal') {
    return Math.exp(-0.5 * dist.scale ** 2 + dist.scale * randNormal(random)) - 1;
  }
  if (dist.family === 'triangular') {
    const { low, mode, high } = dist;
    if (high === low) return low;
    const u = random();
    const split = (mode - low) / (high - low);
    return u < split
      ? low + Math.sqrt(u * (high - low) * (mode - low))
      : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
  }
  if (dist.family === 'uniform') return dist.low + random() * (dist.high - dist.low);
  if (dist.family === 'discreteUniform') return dist.values[Math.min(dist.values.length - 1, Math.floor(random() * dist.values.length))];
  const total = dist.outcomes.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return dist.outcomes[0]?.value || 0;
  let target = random() * total;
  for (const item of dist.outcomes) {
    target -= item.weight;
    if (target <= 0) return item.value;
  }
  return dist.outcomes.at(-1).value;
}

export function sampleRelativeValue(expectedValue, spec, random = Math.random) {
  const value = Number(expectedValue) || 0;
  const sampled = value * (1 + sampleShock(spec, random));
  return value >= 0 ? Math.max(0, sampled) : Math.min(0, sampled);
}

/** Expected additive shock for projections. Sampling code remains the source
 * of path variation; this is used only for average/expected UI lines. */
export function distributionMean(spec) {
  const dist = normalizeDistribution(spec);
  if (dist.family === 'normal' || dist.family === 'studentT' || dist.family === 'lognormal') return 0;
  if (dist.family === 'triangular') return (dist.low + dist.mode + dist.high) / 3;
  if (dist.family === 'uniform') return (dist.low + dist.high) / 2;
  if (dist.family === 'discreteUniform') return dist.values.reduce((sum, value) => sum + value, 0) / dist.values.length;
  const totalWeight = dist.outcomes.reduce((sum, item) => sum + item.weight, 0);
  return totalWeight > 0 ? dist.outcomes.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight : 0;
}

export function distributionRange(spec) {
  const dist = normalizeDistribution(spec);
  if ((dist.family === 'normal' || dist.family === 'studentT' || dist.family === 'lognormal') && dist.scale === 0) return { min: 0, max: 0 };
  if (dist.family === 'triangular') return { min: dist.low, max: dist.high };
  if (dist.family === 'uniform') return { min: dist.low, max: dist.high };
  if (dist.family === 'discreteUniform') return { min: Math.min(...dist.values), max: Math.max(...dist.values) };
  if (dist.family === 'discrete') {
    const values = dist.outcomes.filter(item => item.weight > 0).map(item => item.value);
    return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: 0, max: 0 };
  }
  const histogram = distributionHistogram(dist);
  return { min: histogram.min, max: histogram.max };
}

/** Build a stable, display-oriented histogram of relative outcomes. The
 * outer 1% on each side is trimmed so heavy tails do not flatten the chart. */
export function distributionHistogram(spec, { sampleCount = 2000, binCount = 36 } = {}) {
  const dist = normalizeDistribution(spec);
  const random = createSeededRandom(`preview:${JSON.stringify(dist)}`);
  const values = Array.from({ length: sampleCount }, () => Math.max(-1, sampleShock(dist, random))).sort((a, b) => a - b);
  let min = values[Math.floor(values.length * 0.01)];
  let max = values[Math.min(values.length - 1, Math.floor(values.length * 0.99))];
  min = Math.min(min, 0);
  max = Math.max(max, 0);
  if (!(max > min)) { min -= 0.01; max += 0.01; }
  const counts = new Array(binCount).fill(0);
  for (const value of values) {
    const clipped = Math.min(max, Math.max(min, value));
    const index = Math.min(binCount - 1, Math.floor((clipped - min) / (max - min) * binCount));
    counts[index]++;
  }
  const peak = Math.max(1, ...counts);
  return {
    min,
    max,
    expectedPosition: (0 - min) / (max - min),
    bins: counts.map(count => count / peak),
  };
}
