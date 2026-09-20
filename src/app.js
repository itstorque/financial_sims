import { Simulator } from './sim.js';
import { initUI } from './ui.js';
import { renderBalanceChart, renderCompositionChart } from './plot.js';

const state = { accounts: null, blocks: null, globalReturnsSchedule: null, marketEvents: [] };
let lastChartData = null;

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
    const inflationRate = (parseFloat(document.getElementById('inflationRate').value) || 0) / 100;
    const capGainsEnabled = document.getElementById('capGainsEnabled').checked;
    const capGainsRate = (parseFloat(document.getElementById('capGainsRate').value) || 0) / 100;
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
      marketEvents: state.marketEvents,
      city,
      numParticles,
      useParticleFilter,
      retirementMonthIndex,
      inflationRate,
      capitalGains: { enabled: capGainsEnabled, rate: capGainsRate },
      withdrawalOrder: state.withdrawalOrder || [],
    });

    const out = sim.run();

    const labels = Array.from({ length: months }, (_, i) => {
      const d = new Date(startDate); d.setDate(1); d.setMonth(d.getMonth() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });

    const median = out.timeline.map(t => t.p50);
    const p10 = out.timeline.map(t => t.p10);
    const p90 = out.timeline.map(t => t.p90);

    lastChartData = { labels, median, p10, p90, byAccountTimeline: out.byAccountTimeline, marketEventStats: out.marketEventStats, individualTraces: out.individualTraces };
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
    for (const event of out.marketEventStats || []) {
      parts.push(`<span>${escapeHtml(event.name)} triggered: <b>${(event.triggerRate * 100).toFixed(1)}%</b> of paths</span>`);
    }
    summary.innerHTML = parts.join('');
  });

  function inflationFactorAt(monthIndex) {
    const rate = (parseFloat(document.getElementById('inflationRate').value) || 0) / 100;
    return Math.pow(1 + rate, monthIndex / 12);
  }

  function maybeDeflateSeries(series) {
    if (!document.getElementById('realDollars').checked) return series;
    return series.map((v, m) => v / inflationFactorAt(m));
  }

  function maybeDeflateAccountTimeline(rows) {
    if (!document.getElementById('realDollars').checked) return rows;
    return rows.map((row, m) => {
      const factor = inflationFactorAt(m);
      return Object.fromEntries(Object.entries(row).map(([id, v]) => [id, v / factor]));
    });
  }

  function renderBalance() {
    if (!lastChartData) return;
    const { labels, median, p10, p90 } = lastChartData;
    const showTraces = document.getElementById('showIndividualTraces').checked;
    const traceCount = parseInt(document.getElementById('individualTraceCount').value, 10) || 25;
    const individualTraces = showTraces ? lastChartData.individualTraces.slice(0, traceCount).map(maybeDeflateSeries) : [];
    renderBalanceChart(document.getElementById('balanceChart'), labels, maybeDeflateSeries(median), maybeDeflateSeries(p10), maybeDeflateSeries(p90), document.getElementById('balanceScale').value, lastChartData.marketEventStats, individualTraces);
  }

  function selectedAccountIds() {
    return [...document.querySelectorAll('#accountFilterMenu input:checked')].map(input => input.value);
  }

  function renderAccountMix() {
    if (!lastChartData) return;
    renderCompositionChart(document.getElementById('compositionChart'), lastChartData.labels, maybeDeflateAccountTimeline(lastChartData.byAccountTimeline), state.accounts, selectedAccountIds(), document.getElementById('compositionScale').value, lastChartData.marketEventStats);
  }

  function renderAccountFilters() {
    const menu = document.getElementById('accountFilterMenu');
    menu.innerHTML = Object.values(state.accounts).map(account => `<label><input type="checkbox" value="${escapeHtml(account.id)}" checked/> <span>${escapeHtml(account.name)}</span></label>`).join('');
    menu.querySelectorAll('input').forEach(input => input.addEventListener('change', renderAccountMix));
  }

  document.getElementById('balanceScale').addEventListener('change', renderBalance);
  document.getElementById('compositionScale').addEventListener('change', renderAccountMix);
  document.getElementById('realDollars').addEventListener('change', () => { renderBalance(); renderAccountMix(); });
  document.getElementById('showIndividualTraces').addEventListener('change', event => {
    document.getElementById('individualTraceCount').disabled = !event.target.checked;
    renderBalance();
  });
  document.getElementById('individualTraceCount').addEventListener('change', renderBalance);

  function resizePlots() {
    requestAnimationFrame(() => {
      Plotly.Plots.resize(document.getElementById('balanceChart'));
      Plotly.Plots.resize(document.getElementById('compositionChart'));
    });
  }

  function closeExpandedChart() {
    const card = document.querySelector('.chart-card.is-fullscreen');
    if (!card) return;
    card.classList.remove('is-fullscreen');
    document.body.classList.remove('plot-fullscreen-open');
    document.querySelectorAll('[data-fullscreen]').forEach(button => {
      button.textContent = '⛶';
      button.title = 'Full screen';
      button.setAttribute('aria-label', 'Full screen');
      button.setAttribute('aria-pressed', 'false');
    });
    resizePlots();
  }

  document.querySelectorAll('[data-fullscreen]').forEach(button => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      const card = document.getElementById(button.dataset.fullscreen);
      if (card.classList.contains('is-fullscreen')) {
        closeExpandedChart();
        return;
      }
      closeExpandedChart();
      card.classList.add('is-fullscreen');
      document.body.classList.add('plot-fullscreen-open');
      button.textContent = '×';
      button.title = 'Exit full screen';
      button.setAttribute('aria-label', 'Exit full screen');
      button.setAttribute('aria-pressed', 'true');
      resizePlots();
    });
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeExpandedChart();
  });
}

main();


