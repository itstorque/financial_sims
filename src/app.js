import { Simulator } from './sim.js';
import { initUI } from './ui.js';
import { renderBalanceChart, renderCompositionChart } from './plot.js';

const state = { accounts: null, blocks: null, globalReturnsSchedule: null };
let lastChartData = null;
const chartViews = { balance: {}, composition: {} };

function formatMoney(v) {
  return '$' + Math.round(v).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function main() {
  // initUI is async because it may need to fetch a personal me.json before
  // populating the initial state (see meScenario.js).
  const ui = await initUI(state);

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

    lastChartData = { labels, median, p10, p90, byAccountTimeline: out.byAccountTimeline };
    resetView('balance', false);
    resetView('composition', false);
    renderBalance();
    renderAccountFilters();
    renderAccountMix();

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

  function renderBalance() {
    if (!lastChartData) return;
    const { labels, median, p10, p90 } = lastChartData;
    renderBalanceChart(document.getElementById('balanceChart').getContext('2d'), labels, median, p10, p90, document.getElementById('balanceScale').value, chartViews.balance);
  }

  function selectedAccountIds() {
    return [...document.querySelectorAll('#accountFilterMenu input:checked')].map(input => input.value);
  }

  function renderAccountMix() {
    if (!lastChartData) return;
    renderCompositionChart(document.getElementById('compositionChart').getContext('2d'), lastChartData.labels, lastChartData.byAccountTimeline, state.accounts, selectedAccountIds(), document.getElementById('compositionScale').value, chartViews.composition);
  }

  function renderAccountFilters() {
    const menu = document.getElementById('accountFilterMenu');
    menu.innerHTML = Object.values(state.accounts).map(account => `<label><input type="checkbox" value="${escapeHtml(account.id)}" checked/> <span>${escapeHtml(account.name)}</span></label>`).join('');
    menu.querySelectorAll('input').forEach(input => input.addEventListener('change', renderAccountMix));
  }

  document.getElementById('balanceScale').addEventListener('change', renderBalance);
  document.getElementById('compositionScale').addEventListener('change', renderAccountMix);

  function viewInputs(prefix) {
    return {
      xMin: document.getElementById(`${prefix}XMin`),
      xMax: document.getElementById(`${prefix}XMax`),
      yMin: document.getElementById(`${prefix}YMin`),
      yMax: document.getElementById(`${prefix}YMax`),
    };
  }

  function renderChart(prefix) {
    if (prefix === 'balance') renderBalance();
    else renderAccountMix();
  }

  function applyView(prefix) {
    if (!lastChartData) return;
    const inputs = viewInputs(prefix);
    const xMinIndex = inputs.xMin.value ? lastChartData.labels.indexOf(inputs.xMin.value) : 0;
    const xMaxIndex = inputs.xMax.value ? lastChartData.labels.indexOf(inputs.xMax.value) : lastChartData.labels.length - 1;
    if (xMinIndex < 0 || xMaxIndex < 0 || xMinIndex >= xMaxIndex) {
      inputs.xMin.setCustomValidity('Choose a start month before the end month within the simulation.');
      inputs.xMin.reportValidity();
      return;
    }
    inputs.xMin.setCustomValidity('');
    const yMin = inputs.yMin.value === '' ? undefined : Number(inputs.yMin.value);
    const yMax = inputs.yMax.value === '' ? undefined : Number(inputs.yMax.value);
    if (yMin != null && yMax != null && yMin >= yMax) {
      inputs.yMin.setCustomValidity('Y minimum must be less than Y maximum.');
      inputs.yMin.reportValidity();
      return;
    }
    inputs.yMin.setCustomValidity('');
    chartViews[prefix] = { xMin: inputs.xMin.value, xMax: inputs.xMax.value, yMin, yMax };
    renderChart(prefix);
  }

  function resetView(prefix, render = true) {
    chartViews[prefix] = {};
    const inputs = viewInputs(prefix);
    inputs.xMin.value = lastChartData?.labels[0] || '';
    inputs.xMax.value = lastChartData?.labels.at(-1) || '';
    inputs.yMin.value = '';
    inputs.yMax.value = '';
    if (render) renderChart(prefix);
  }

  function zoomView(prefix, factor) {
    if (!lastChartData) return;
    const chart = prefix === 'balance' ? window._balanceChart : window._compositionChart;
    if (!chart) return;
    const inputs = viewInputs(prefix);
    const labels = lastChartData.labels;
    let xMin = Math.max(0, Math.round(chart.scales.x.min));
    let xMax = Math.min(labels.length - 1, Math.round(chart.scales.x.max));
    if (chart.scales.x.type === 'logarithmic') { xMin--; xMax--; }
    const xCenter = (xMin + xMax) / 2;
    const xHalf = Math.max(1, (xMax - xMin) * factor / 2);
    xMin = Math.max(0, Math.floor(xCenter - xHalf));
    xMax = Math.min(labels.length - 1, Math.ceil(xCenter + xHalf));

    const currentYMin = chart.scales.y.min;
    const currentYMax = chart.scales.y.max;
    let yMin;
    let yMax;
    if (chart.scales.y.type === 'logarithmic' && currentYMin > 0) {
      const logMin = Math.log10(currentYMin);
      const logMax = Math.log10(currentYMax);
      const center = (logMin + logMax) / 2;
      const half = (logMax - logMin) * factor / 2;
      yMin = 10 ** (center - half);
      yMax = 10 ** (center + half);
    } else {
      const center = (currentYMin + currentYMax) / 2;
      const half = Math.max(1, (currentYMax - currentYMin) * factor / 2);
      yMin = center - half;
      yMax = center + half;
    }
    inputs.xMin.value = labels[xMin];
    inputs.xMax.value = labels[xMax];
    inputs.yMin.value = Number(yMin.toPrecision(8));
    inputs.yMax.value = Number(yMax.toPrecision(8));
    applyView(prefix);
  }

  for (const prefix of ['balance', 'composition']) {
    document.getElementById(`${prefix}ApplyView`).addEventListener('click', () => applyView(prefix));
    document.getElementById(`${prefix}ResetView`).addEventListener('click', () => resetView(prefix));
    document.getElementById(`${prefix}ZoomIn`).addEventListener('click', () => zoomView(prefix, 0.5));
    document.getElementById(`${prefix}ZoomOut`).addEventListener('click', () => zoomView(prefix, 2));
  }

  document.querySelectorAll('[data-fullscreen]').forEach(button => {
    button.addEventListener('click', async () => {
      const card = document.getElementById(button.dataset.fullscreen);
      if (document.fullscreenElement === card) await document.exitFullscreen();
      else await card.requestFullscreen();
    });
  });

  document.addEventListener('fullscreenchange', () => {
    document.querySelectorAll('[data-fullscreen]').forEach(button => {
      button.textContent = document.fullscreenElement?.id === button.dataset.fullscreen ? 'Exit full screen' : 'Full screen';
    });
    requestAnimationFrame(() => {
      window._balanceChart?.resize();
      window._compositionChart?.resize();
    });
  });
}

main();


