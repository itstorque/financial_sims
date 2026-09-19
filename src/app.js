import { Simulator } from './sim.js';
import { initUI } from './ui.js';
import { renderBalanceChart, renderCompositionChart } from './plot.js';

const state = { accounts: null, blocks: null, globalReturnsSchedule: null };
const ui = initUI(state);

function formatMoney(v) {
  return '$' + Math.round(v).toLocaleString();
}

document.getElementById('runSim').addEventListener('click', () => {
  const curAge = parseInt(document.getElementById('currentAge').value, 10);
  const retireAge = parseInt(document.getElementById('retireAge').value, 10);
  const numParticles = parseInt(document.getElementById('numParticles').value, 10) || 300;
  const useParticleFilter = document.getElementById('useParticleFilter').checked;
  const city = ui.getCity();

  const yearsToRetirement = Math.max(0, retireAge - curAge);
  const retirementMonthIndex = yearsToRetirement * 12;
  const totalYears = Math.max(yearsToRetirement + 30, 20); // simulate well past retirement
  const months = totalYears * 12;

  const startDate = new Date();

  const sim = new Simulator({
    startDate,
    months,
    accounts: state.accounts,
    blocks: state.blocks,
    globalReturnsSchedule: state.globalReturnsSchedule,
    city,
    numParticles,
    useParticleFilter,
    retirementMonthIndex,
  });

  const out = sim.run();

  const labels = Array.from({ length: months }, (_, i) => {
    const d = new Date(startDate); d.setDate(1); d.setMonth(d.getMonth() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  const median = out.timeline.map(t => t.p50);
  const p10 = out.timeline.map(t => t.p10);
  const p90 = out.timeline.map(t => t.p90);

  renderBalanceChart(document.getElementById('balanceChart').getContext('2d'), labels, median, p10, p90);
  renderCompositionChart(document.getElementById('compositionChart').getContext('2d'), labels, out.byAccountTypeTimeline);

  const summary = document.getElementById('summaryStats');
  const parts = [
    `<span>Median balance at end: <b>${formatMoney(median[median.length - 1])}</b></span>`,
    `<span>Solvency rate (final): <b>${(out.solvencyRate * 100).toFixed(1)}%</b></span>`,
  ];
  if (out.fireStats) {
    parts.push(`<span>FIRE number at retirement: <b>${formatMoney(out.fireStats.fireNumber)}</b></span>`);
    parts.push(`<span>P(reach FIRE by retirement): <b>${(out.fireStats.successRate * 100).toFixed(1)}%</b></span>`);
  }
  if (useParticleFilter) {
    parts.push(`<span>Resample events: <b>${out.resampleEvents}</b></span>`);
  }
  summary.innerHTML = parts.join('');
});

