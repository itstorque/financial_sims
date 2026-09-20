import { Simulator } from './sim.js';
import { initUI } from './ui.js';
import { renderBalanceChart, renderCompositionChart } from './plot.js';
import { buildResultsDataFrameRows, rowsToCsv, buildPythonSnippet } from './exportData.js';
import { ACCOUNT_TYPE_LABELS } from './accounts.js';
import { loanDownPaymentAmount, loanMonthlyPayment } from './blocks.js';
import { buildSummaryQuestionPrompt, buildSummaryFollowUpPrompt, validateSummaryAnswer, requestDeepSeekConversation } from './deepseek.js';
import { serializeState } from './persistence.js';
import { showLoading, updateLoadingProgress, hideLoading, showLoadingError, withLoading } from './loading.js';

const state = { accounts: null, blocks: null, globalReturnsSchedule: null, marketEvents: [] };
let lastChartData = null;
const THEME_KEY = 'finSim.theme.v1';
const SIDEBAR_KEY = 'finSim.sidebar.v1';

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

  const themeToggle = document.getElementById('themeToggle');

  function updateThemeToggle() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    themeToggle.setAttribute('aria-pressed', String(isDark));
    themeToggle.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
    themeToggle.title = `Switch to ${isDark ? 'light' : 'dark'} mode`;
    themeToggle.querySelector('.theme-toggle-icon').textContent = isDark ? '☀' : '☾';
  }

  updateThemeToggle();
  themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
    updateThemeToggle();
    renderBalance();
    renderAccountMix();
  });

  const sidebarToggle = document.getElementById('sidebarToggle');

  function updateSidebarToggle() {
    const isCollapsed = document.documentElement.dataset.sidebar === 'collapsed';
    sidebarToggle.setAttribute('aria-expanded', String(!isCollapsed));
    sidebarToggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} sidebar`);
    sidebarToggle.title = `${isCollapsed ? 'Expand' : 'Collapse'} sidebar`;
  }

  updateSidebarToggle();
  sidebarToggle.addEventListener('click', () => {
    const isCollapsed = document.documentElement.dataset.sidebar === 'collapsed';
    if (isCollapsed) delete document.documentElement.dataset.sidebar;
    else document.documentElement.dataset.sidebar = 'collapsed';
    try { localStorage.setItem(SIDEBAR_KEY, isCollapsed ? 'expanded' : 'collapsed'); } catch {}
    updateSidebarToggle();
    setTimeout(resizePlots, 200);
  });

  // View switching: "Plots", "Reports", and "Tracks" are dedicated full
  // pages (hiding the Plan <main>); "Plan" lives inside <main> and is
  // reached by scrolling to its anchor (the original left-column layout).
  const mainEl = document.querySelector('main');
  const plotsViewEl = document.getElementById('plotsView');
  const summaryViewEl = document.getElementById('summaryView');
  const reportsViewEl = document.getElementById('reportsView');
  const tracksViewEl = document.getElementById('tracksView');
  const topbarTitleEl = document.querySelector('.topbar-title');
  const navLinks = [...document.querySelectorAll('#appNavigation a[data-view]')];
  const VIEW_HASHES = { plan: '#scenarios', summary: '#summary', plots: '#plots', reports: '#reports', tracks: '#tracks' };
  const VIEW_TITLES = { plan: 'Plan', summary: 'Summary', plots: 'Plots', reports: 'Reports', tracks: 'Tracks' };

  // The tracks page-view fills the remaining viewport below the sticky
  // topbar (video-editor style), so keep --topbar-h in sync with its
  // actual rendered height.
  const topbarEl = document.querySelector('.topbar');
  function updateTopbarHeightVar() {
    document.documentElement.style.setProperty('--topbar-h', `${topbarEl.offsetHeight}px`);
  }
  updateTopbarHeightVar();
  if (window.ResizeObserver) new ResizeObserver(updateTopbarHeightVar).observe(topbarEl);
  else window.addEventListener('resize', updateTopbarHeightVar);

  function viewForHash() {
    if (location.hash === '#plots') return 'plots';
    if (location.hash === '#summary') return 'summary';
    if (location.hash === '#reports') return 'reports';
    if (location.hash === '#tracks') return 'tracks';
    return 'plan';
  }

  function setActiveView(view, { updateHash = true } = {}) {
    if (!(view in VIEW_HASHES)) view = 'plan';
    mainEl.classList.toggle('view-hidden', view !== 'plan');
    summaryViewEl.classList.toggle('view-hidden', view !== 'summary');
    plotsViewEl.classList.toggle('view-hidden', view !== 'plots');
    reportsViewEl.classList.toggle('view-hidden', view !== 'reports');
    tracksViewEl.classList.toggle('view-hidden', view !== 'tracks');
    for (const link of navLinks) {
      const isActive = link.dataset.view === view;
      link.classList.toggle('active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    topbarTitleEl.textContent = VIEW_TITLES[view];
    if (updateHash) {
      try { history.replaceState(null, '', VIEW_HASHES[view]); } catch {}
    }
    if (view === 'plots') { renderPlotsEmptyState(); renderBalance(); renderAccountMix(); }
    else if (view === 'summary') { renderSummaryView(); }
    else if (view === 'reports') { renderReportsView(); }
    else if (view === 'tracks') { ui.activateTracksView(); }
    else { document.getElementById('scenarios')?.scrollIntoView({ block: 'start' }); ui.refreshCashFlowList(); }
    setTimeout(resizePlots, 50);
  }

  async function switchView(view, options) {
    const normalizedView = view in VIEW_HASHES ? view : 'plan';
    const label = VIEW_TITLES[normalizedView];
    await withLoading(`Opening ${label}…`, async () => {
      setActiveView(normalizedView, options);
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
  }

  navLinks.forEach(link => link.addEventListener('click', async event => {
    event.preventDefault();
    await switchView(link.dataset.view);
  }));
  window.addEventListener('hashchange', () => switchView(viewForHash(), { updateHash: false }));
  setActiveView(viewForHash(), { updateHash: false });

  const summaryAskDialog = document.getElementById('summaryAskDialog');
  const summaryAskForm = document.getElementById('summaryAskForm');
  const summaryAskPrompt = document.getElementById('summaryAskPrompt');
  const summaryAskStatus = document.getElementById('summaryAskStatus');
  const summaryAskResult = document.getElementById('summaryAskResult');
  const summaryAskConversation = document.getElementById('summaryAskConversation');
  const summaryAskFollowups = document.getElementById('summaryAskFollowups');
  const summaryAskWelcome = document.getElementById('summaryAskWelcome');
  const summaryAskContent = summaryAskDialog.querySelector('.summary-ask-content');
  let summaryConversationMessages = [];
  let summaryConversationTurns = [];
  let summaryPendingQuestion = null;
  let summaryPendingError = null;

  function resetSummaryConversation() {
    summaryConversationMessages = [];
    summaryConversationTurns = [];
    summaryPendingQuestion = null;
    summaryPendingError = null;
    summaryAskConversation.replaceChildren();
    summaryAskFollowups.replaceChildren();
    summaryAskResult.classList.add('view-hidden');
    summaryAskPrompt.value = '';
    summaryAskStatus.textContent = '';
    summaryAskStatus.classList.remove('error');
  }

  function renderSummaryConversation() {
    summaryAskConversation.replaceChildren(...summaryConversationTurns.map(turn => {
      const container = document.createElement('section');
      container.className = 'summary-ask-turn';
      const question = document.createElement('div');
      question.className = 'summary-ask-question';
      question.textContent = turn.question;
      const answer = document.createElement('div');
      answer.className = 'summary-ask-answer';
      answer.textContent = turn.result.answer;
      container.append(question, answer);
      if (turn.result.evidence.length) {
        const evidence = document.createElement('div');
        evidence.className = 'summary-ask-evidence';
        evidence.replaceChildren(...turn.result.evidence.map(item => {
          const row = document.createElement('div');
          const date = document.createElement('time');
          const metric = document.createElement('b');
          const detail = document.createElement('span');
          date.textContent = item.date || 'Plan';
          metric.textContent = [item.metric, item.value].filter(Boolean).join(': ');
          detail.textContent = item.explanation;
          row.append(date, metric, detail);
          return row;
        }));
        container.append(evidence);
      }
      const caveatLines = turn.result.caveats.map(item => `Caveat: ${item}`);
      if (caveatLines.length) {
        const caveats = document.createElement('div');
        caveats.className = 'summary-ask-caveats';
        caveats.textContent = caveatLines.join('\n');
        container.append(caveats);
      }
      return container;
    }));

    if (summaryPendingQuestion || summaryPendingError) {
      const pending = summaryPendingError || { question: summaryPendingQuestion };
      const container = document.createElement('section');
      container.className = 'summary-ask-turn';
      const question = document.createElement('div');
      question.className = 'summary-ask-question';
      question.textContent = pending.question;
      const answer = document.createElement('div');
      if (summaryPendingError) {
        answer.className = 'summary-ask-answer error';
        answer.textContent = summaryPendingError.message;
      } else {
        answer.className = 'summary-ask-answer is-loading';
        answer.innerHTML = '<span class="summary-ask-typing" aria-hidden="true"><i></i><i></i><i></i></span><span>DeepSeek is thinking…</span>';
      }
      container.append(question, answer);
      summaryAskConversation.appendChild(container);
    }

    summaryAskFollowups.replaceChildren();
    const latest = summaryConversationTurns.at(-1);
    for (const followUp of summaryPendingQuestion || summaryPendingError ? [] : latest?.result.followUpQuestions || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = followUp;
      button.addEventListener('click', () => {
        summaryAskPrompt.value = followUp;
        summaryAskForm.requestSubmit();
      });
      summaryAskFollowups.appendChild(button);
    }
    const hasConversation = summaryConversationTurns.length > 0 || summaryPendingQuestion || summaryPendingError;
    summaryAskWelcome.classList.toggle('view-hidden', Boolean(hasConversation));
    summaryAskResult.classList.toggle('view-hidden', !hasConversation);
    requestAnimationFrame(() => { summaryAskContent.scrollTop = summaryAskContent.scrollHeight; });
  }

  function closeSummaryAsk() {
    summaryAskDialog.close();
  }

  document.getElementById('summaryAskButton').addEventListener('click', () => {
    if (!lastChartData) return;
    summaryAskStatus.textContent = '';
    summaryAskStatus.classList.remove('error');
    renderSummaryConversation();
    summaryAskDialog.showModal();
    summaryAskPrompt.focus();
  });
  document.getElementById('closeSummaryAsk').addEventListener('click', closeSummaryAsk);
  document.getElementById('newSummaryConversation').addEventListener('click', () => {
    resetSummaryConversation();
    summaryAskPrompt.focus();
  });
  document.querySelectorAll('[data-summary-question]').forEach(button => {
    button.addEventListener('click', () => {
      summaryAskPrompt.value = button.dataset.summaryQuestion;
      summaryAskPrompt.focus();
    });
  });

  document.getElementById('runSim').addEventListener('click', async () => {
    const runButton = document.getElementById('runSim');
    const curAge = parseInt(document.getElementById('currentAge').value, 10);
    const retireAge = parseInt(document.getElementById('retireAge').value, 10);
    const numParticles = parseInt(document.getElementById('numParticles').value, 10) || 300;
    const useParticleFilter = document.getElementById('useParticleFilter').checked;
    const seed = document.getElementById('simulationSeed').value.trim();
    const inflationRate = (parseFloat(document.getElementById('inflationRate').value) || 0) / 100;
    const inflationVolatility = (parseFloat(document.getElementById('inflationVolatility').value) || 0) / 100;
    const inflationPersistence = parseFloat(document.getElementById('inflationPersistence').value) || 0;
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
      inflationModel: { volatility: inflationVolatility, persistence: inflationPersistence, distribution: { family: 'normal', scale: inflationVolatility } },
      seed,
      capitalGains: { enabled: capGainsEnabled, rate: capGainsRate },
      withdrawalOrder: state.withdrawalOrder || [],
    });

    runButton.disabled = true;
    showLoading('Preparing simulation', { progress: true, detailText: 'Validating inputs' });
    try {
    const out = await sim.runAsync(({ percent, phase, detail }) => updateLoadingProgress(percent, phase, detail));
    updateLoadingProgress(98, 'Rendering results', 'Updating charts, summary, and reports');
    await new Promise(resolve => requestAnimationFrame(resolve));
    resetSummaryConversation();

    const labels = Array.from({ length: months }, (_, i) => {
      const d = new Date(startDate); d.setDate(1); d.setMonth(d.getMonth() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });

    const median = out.timeline.map(t => t.p50);
    const p10 = out.timeline.map(t => t.p10);
    const p90 = out.timeline.map(t => t.p90);
    const mean = out.timeline.map(t => t.mean);

    lastChartData = {
      labels, median, p10, p90, mean,
      assetOnlyP10: out.assetOnlyTimeline.map(point => point.p10),
      assetOnlyMedian: out.assetOnlyTimeline.map(point => point.p50),
      assetOnlyP90: out.assetOnlyTimeline.map(point => point.p90),
      byAccountTimeline: out.byAccountTimeline,
      marketEventStats: out.marketEventStats,
      individualTraces: out.individualTraces,
      individualTraceMeta: out.individualTraceMeta,
      inflationTimeline: out.inflationTimeline,
      fireStats: out.fireStats,
      solvencyRate: out.solvencyRate,
      resampleEvents: out.resampleEvents,
      useParticleFilter,
      retirementMonthIndex,
      months,
      bankruptcyCount: out.bankruptcyCount,
      particleCount: out.particleCount,
      maximumDebt: out.maximumDebt,
      maximumDebtStats: out.maximumDebtStats,
      endingBelowStartingCount: out.endingBelowStartingCount,
      retirementReadinessTimeline: out.retirementReadinessTimeline,
      simulationInputs: {
        run: {
          startDate: startDate.toISOString(),
          months,
          currentAge: curAge,
          retirementAge: retireAge,
          retirementMonthIndex,
          city,
          numParticles,
          useParticleFilter,
          inflationRate,
          inflationVolatility,
          inflationPersistence,
          seed,
          capitalGains: { enabled: capGainsEnabled, rate: capGainsRate },
        },
        state: JSON.parse(JSON.stringify(serializeState(state))),
      },
    };
    renderBalance();
    renderAccountFilters();
    renderAccountMix();
    renderPlotsEmptyState();
    renderSummaryView();
    renderReportsView();

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
    updateLoadingProgress(100, 'Simulation complete', 'Results are ready');
    await new Promise(resolve => requestAnimationFrame(resolve));
    } catch (error) {
      console.error(error);
      alert(error?.message || 'The simulation could not be completed.');
    } finally {
      runButton.disabled = false;
      hideLoading();
    }
  });

  function inflationFactorAt(monthIndex) {
    if (lastChartData?.inflationTimeline?.[monthIndex]) return lastChartData.inflationTimeline[monthIndex].p50;
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

  // Shows a reminder to run the simulation instead of stale/empty charts on
  // the Plots page (mirrors the same pattern used by renderSummaryView /
  // renderReportsView for their respective empty states).
  function renderPlotsEmptyState() {
    const emptyEl = document.getElementById('plotsEmptyState');
    const contentEl = document.getElementById('plotsContent');
    const hasData = !!lastChartData;
    emptyEl.classList.toggle('view-hidden', hasData);
    contentEl.classList.toggle('view-hidden', !hasData);
  }

  function renderBalance() {
    if (!lastChartData) return;
    const { labels, median, p10, p90 } = lastChartData;
    const showTraces = document.getElementById('showIndividualTraces').checked;
    const traceCount = parseInt(document.getElementById('individualTraceCount').value, 10) || 25;
    const individualTraces = showTraces ? lastChartData.individualTraces.slice(0, traceCount).map((values, index) => ({ values: maybeDeflateSeries(values), ...lastChartData.individualTraceMeta[index] })) : [];
    const deflatedMedian = maybeDeflateSeries(median);
    const deflatedP10 = maybeDeflateSeries(p10);
    const deflatedP90 = maybeDeflateSeries(p90);
    const scale = document.getElementById('balanceScale').value;
    renderBalanceChart(document.getElementById('balanceChart'), labels, deflatedMedian, deflatedP10, deflatedP90, scale, lastChartData.marketEventStats, individualTraces);
  }

  function selectedAccountIds() {
    return [...document.querySelectorAll('#accountFilterMenu input:checked')].map(input => input.value);
  }

  function renderAccountMix() {
    if (!lastChartData) return;
    const deflatedTimeline = maybeDeflateAccountTimeline(lastChartData.byAccountTimeline);
    const scale = document.getElementById('compositionScale').value;
    const visibleIds = selectedAccountIds();
    renderCompositionChart(document.getElementById('compositionChart'), lastChartData.labels, deflatedTimeline, state.accounts, visibleIds, scale, lastChartData.marketEventStats);
  }

  function renderAccountFilters() {
    const menu = document.getElementById('accountFilterMenu');
    menu.innerHTML = Object.values(state.accounts).map(account => `<label><input type="checkbox" value="${escapeHtml(account.id)}" checked/> <span>${escapeHtml(account.name)}</span></label>`).join('');
    menu.querySelectorAll('input').forEach(input => input.addEventListener('change', renderAccountMix));
  }

  function formatPercent(v) {
    return `${((v || 0) * 100).toFixed(1)}%`;
  }

  // Milestones for the Reports checkpoint table: today, retirement (if set
  // and within the window), then every 10 years after that, plus the final
  // simulated month. A Set naturally de-dupes when e.g. retirement falls
  // exactly on a 10-year boundary or at the very end of the window.
  function milestoneMonthIndices(months, retirementMonthIndex) {
    const indices = new Set([0]);
    const hasRetirement = retirementMonthIndex != null && retirementMonthIndex > 0 && retirementMonthIndex < months;
    if (hasRetirement) indices.add(retirementMonthIndex);
    const start = hasRetirement ? retirementMonthIndex : 0;
    for (let m = start + 120; m < months; m += 120) indices.add(m);
    indices.add(months - 1);
    return [...indices].sort((a, b) => a - b);
  }

  function summaryPlanEvents() {
    const events = [];
    for (const block of state.blocks) {
      if (block.kind === 'loan') {
        events.push({ month: block.startMonth, tone: 'expense', title: block.description, detail: `${formatMoney(block.purchasePrice)} purchase · ${formatMoney(loanDownPaymentAmount(block))} down · ${formatMoney(loanMonthlyPayment(block))}/mo` });
        continue;
      }
      if (block.kind === 'one-time') {
        events.push({ month: block.startMonth, tone: block.category, title: block.description, detail: `${formatMoney(block.amount)} one-time ${block.category}` });
        continue;
      }
      if (block.useCustomSchedule) {
        for (const clip of block.amountSchedule.entries.filter(entry => Number(entry.annualAmount) !== 0)) {
          events.push({ month: clip.from, tone: block.category, title: `${block.description}: ${clip.name || 'new period'}`, detail: `${formatMoney(clip.annualAmount)}/yr through ${clip.to}` });
        }
      } else {
        events.push({ month: block.startMonth, tone: block.category, title: block.description, detail: `${formatMoney(block.amount)}/yr${block.endMonth ? ` through ${block.endMonth}` : ''}` });
      }
    }
    for (const event of state.marketEvents || []) {
      events.push({ month: `Next ${event.triggerWindowMonths} mo`, tone: 'risk', title: event.name, detail: `${formatPercent(event.probability)} probability · ${formatPercent(event.annualReturn)} return for ${event.durationMonths} mo` });
    }
    return events.sort((a, b) => String(a.month).localeCompare(String(b.month)));
  }

  function toughestYears(labels, median) {
    const yearly = [];
    let previous = median[0];
    for (let index = 11; index < median.length; index += 12) {
      const value = median[index];
      const change = previous !== 0 ? value / previous - 1 : 0;
      yearly.push({ year: labels[index].slice(0, 4), value, change });
      previous = value;
    }
    return yearly.sort((a, b) => a.change - b.change).slice(0, 5);
  }

  function retirementRecommendation(data, currentAge, targetAge) {
    const success = data.fireStats?.successRate ?? 0;
    const readiness = data.retirementReadinessTimeline || [];
    const firstStrongMonth = readiness.findIndex(point => point.successRate >= 0.9);
    const suggestedAge = firstStrongMonth >= 0 ? currentAge + firstStrongMonth / 12 : null;
    if (success >= 0.9) return { tone: 'good', title: `Target retirement at ${targetAge} looks resilient`, detail: `${formatPercent(success)} of paths reach the FIRE target. Maintain the plan and revisit assumptions periodically.` };
    if (success >= 0.75) return { tone: 'watch', title: `Retirement at ${targetAge} is plausible, but has limited margin`, detail: `${formatPercent(success)} of paths reach the target.${suggestedAge && suggestedAge > targetAge ? ` A roughly 90%-confidence age is ${Math.ceil(suggestedAge)}.` : ' Consider more savings or lower retirement spending.'}` };
    if (success >= 0.5) return { tone: 'risk', title: `Consider delaying retirement beyond ${targetAge}`, detail: `${formatPercent(success)} of paths reach the target.${suggestedAge ? ` The model first reaches 90% confidence near age ${Math.ceil(suggestedAge)}.` : ' No age in this simulation reaches 90% confidence.'}` };
    return { tone: 'danger', title: `The current retirement target is high risk`, detail: `Only ${formatPercent(success)} of paths reach the FIRE target. Consider delaying retirement, increasing contributions, or reducing planned spending.` };
  }

  function worstDrawdown(labels, values) {
    let peak = values[0];
    let peakIndex = 0;
    let worst = { rate: 0, peakIndex: 0, troughIndex: 0 };
    for (let index = 1; index < values.length; index++) {
      if (values[index] > peak) { peak = values[index]; peakIndex = index; }
      if (peak <= 0) continue;
      const rate = values[index] / peak - 1;
      if (rate < worst.rate) worst = { rate, peakIndex, troughIndex: index };
    }
    return { ...worst, peakDate: labels[worst.peakIndex], troughDate: labels[worst.troughIndex] };
  }

  function buildSummaryInsights({ data, startingNetWorth, retirementIndex, median, p10, fireNumber, currentAge, targetAge, drawdown }) {
    const insights = [];
    const bankruptcyRate = data.particleCount ? data.bankruptcyCount / data.particleCount : 0;
    const belowStartRate = data.particleCount ? data.endingBelowStartingCount / data.particleCount : 0;
    if (bankruptcyRate > .1) insights.push({ tone: 'danger', title: 'Material insolvency risk', detail: `${formatPercent(bankruptcyRate)} of paths encounter an unpaid shortfall or finish negative. Increase liquid reserves or reduce fixed commitments.` });
    else if (bankruptcyRate > 0) insights.push({ tone: 'watch', title: 'Some paths run out of available funds', detail: `${data.bankruptcyCount} paths become insolvent. Review the toughest years and withdrawal order.` });
    else insights.push({ tone: 'good', title: 'No simulated insolvencies', detail: `All ${data.particleCount} paths covered modeled obligations through the simulation window.` });

    if (p10[retirementIndex] < fireNumber) insights.push({ tone: 'watch', title: 'Downside retirement case misses the target', detail: `P10 at retirement is ${formatMoney(p10[retirementIndex])}, versus a ${formatMoney(fireNumber)} FIRE target. Preserve flexibility in timing or spending.` });
    else insights.push({ tone: 'good', title: 'Downside case clears the retirement target', detail: `Even P10 at age ${targetAge} is ${formatMoney(p10[retirementIndex])}.` });

    if (drawdown.rate <= -1) insights.push({ tone: 'watch', title: 'Median net worth crosses below zero', detail: `The median reaches ${formatMoney(median[drawdown.troughIndex])} in ${drawdown.troughDate}, usually reflecting leveraged debt. This is not automatically insolvency; compare it with liquid reserves and shortfall outcomes.` });
    else if (drawdown.rate < -.2) insights.push({ tone: 'watch', title: 'Plan experiences a meaningful drawdown', detail: `Median net worth falls ${formatPercent(Math.abs(drawdown.rate))} from ${drawdown.peakDate} to ${drawdown.troughDate}. Maintain enough liquidity to avoid forced selling.` });
    else insights.push({ tone: 'good', title: 'Median path has limited drawdown', detail: `Worst peak-to-trough decline is ${formatPercent(Math.abs(drawdown.rate))}.` });

    if (data.maximumDebt > startingNetWorth * .75) insights.push({ tone: 'watch', title: 'Debt is large relative to starting wealth', detail: `Peak debt of ${formatMoney(data.maximumDebt)} equals ${formatPercent(data.maximumDebt / Math.max(1, startingNetWorth))} of starting net worth.` });
    if (belowStartRate > .05) insights.push({ tone: 'watch', title: 'Some paths lose ground over the full horizon', detail: `${data.endingBelowStartingCount} of ${data.particleCount} paths finish below starting net worth.` });

    const first90 = data.retirementReadinessTimeline.findIndex(point => point.successRate >= .9);
    if (first90 >= 0) {
      const age = currentAge + first90 / 12;
      insights.push({ tone: age <= targetAge ? 'good' : 'watch', title: '90% confidence milestone', detail: `The plan first reaches a 90% FIRE-success rate near age ${Math.ceil(age)}.` });
    } else {
      insights.push({ tone: 'danger', title: '90% confidence is not reached', detail: 'No month in the modeled horizon reaches a 90% FIRE-success rate.' });
    }
    return insights;
  }

  function summaryRangeMarkup(range) {
    if (!range || !document.getElementById('summaryShowRanges').checked) return '';
    const lower = Number(range.lower);
    const center = Number(range.center);
    const upper = Number(range.upper);
    if (![lower, center, upper].every(Number.isFinite)) return '';
    const low = Math.min(lower, upper);
    const high = Math.max(lower, upper);
    const position = high === low ? 50 : Math.min(100, Math.max(0, (center - low) / (high - low) * 100));
    const label = `P10 ${formatMoney(low)}; median ${formatMoney(center)}; P90 ${formatMoney(high)}`;
    return `<div class="summary-error-range" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      <div class="summary-error-values"><span class="${low < 0 ? 'negative' : ''}">P10 ${formatMoney(low)}</span><span>P90 ${formatMoney(high)}</span></div>
      <div class="summary-error-whisker"><i></i><b style="left:${position}%"></b></div>
    </div>`;
  }

  function summaryQuestionContext() {
    if (!lastChartData) return null;
    const data = lastChartData;
    const median = maybeDeflateSeries(data.median);
    const assetOnlyMedian = maybeDeflateSeries(data.assetOnlyMedian);
    const p10 = maybeDeflateSeries(data.p10);
    const p90 = maybeDeflateSeries(data.p90);
    const mean = maybeDeflateSeries(data.mean);
    const accountTimeline = maybeDeflateAccountTimeline(data.byAccountTimeline);
    const allRows = buildResultsDataFrameRows(data.labels, { p10, p50: median, p90, mean }, accountTimeline, state.accounts);
    const maxRows = 1200;
    let rowIndices = allRows.map((_, index) => index);
    if (allRows.length > maxRows) {
      const important = new Set([0, allRows.length - 1, data.retirementMonthIndex]);
      const lowIndex = median.indexOf(Math.min(...median));
      const highIndex = median.indexOf(Math.max(...median));
      for (const center of [lowIndex, highIndex, data.retirementMonthIndex]) {
        for (let offset = -6; offset <= 6; offset++) important.add(center + offset);
      }
      const stride = Math.ceil(allRows.length / (maxRows - important.size));
      for (let index = 0; index < allRows.length; index += stride) important.add(index);
      rowIndices = [...important].filter(index => index >= 0 && index < allRows.length).sort((a, b) => a - b).slice(0, maxRows);
    }
    const rows = rowIndices.map(index => allRows[index]);
    const lowIndex = median.indexOf(Math.min(...median));
    const highIndex = median.indexOf(Math.max(...median));
    const retirementIndex = Math.min(data.months - 1, data.retirementMonthIndex);
    const currentAge = parseInt(document.getElementById('currentAge').value, 10) || 0;
    const targetAge = parseInt(document.getElementById('retireAge').value, 10) || currentAge;
    const realDollars = document.getElementById('realDollars').checked;
    const fireNumber = realDollars ? (data.fireStats?.fireNumber || 0) / inflationFactorAt(retirementIndex) : (data.fireStats?.fireNumber || 0);
    return {
      summary: {
        currency_basis: realDollars ? "today's dollars" : 'nominal dollars',
        current_age: currentAge,
        target_retirement_age: targetAge,
        simulation_start: data.labels[0],
        simulation_end: data.labels.at(-1),
        particles: data.particleCount,
        starting_net_worth: Math.round(Object.values(state.accounts).reduce((sum, account) => sum + Number(account.balance || 0), 0)),
        lowest_median: { date: data.labels[lowIndex], value: Math.round(median[lowIndex]) },
        highest_median: { date: data.labels[highIndex], value: Math.round(median[highIndex]) },
        retirement: {
          date: data.labels[retirementIndex],
          p10: Math.round(p10[retirementIndex]),
          median: Math.round(median[retirementIndex]),
          p90: Math.round(p90[retirementIndex]),
          fire_target: Math.round(fireNumber),
          success_rate: data.fireStats?.successRate ?? null,
        },
        solvency_rate: data.solvencyRate,
        insolvent_paths: data.bankruptcyCount,
        maximum_debt_observed: Math.round(data.maximumDebt),
        paths_finishing_below_start: data.endingBelowStartingCount,
        rare_market_events: (data.marketEventStats || []).map(event => ({ name: event.name, trigger_rate: event.triggerRate })),
      },
      simulationInputs: {
        ...data.simulationInputs,
        display: {
          realDollars: document.getElementById('realDollars').checked,
          dollarBasis: document.getElementById('realDollars').checked ? "today's dollars" : 'nominal dollars',
        },
      },
      planEvents: summaryPlanEvents().slice(0, 100),
      monthlyTableCsv: rowsToCsv(rows),
      tableMetadata: {
        row_count: rows.length,
        complete_monthly_history: rows.length === allRows.length,
        total_months: allRows.length,
        values_rounded_to_cents: true,
        account_columns_are_mean_balances: true,
        omitted_rows_policy: rows.length === allRows.length ? 'none' : 'annual sampling plus six-month windows around median extrema and retirement',
      },
    };
  }

  summaryAskForm.addEventListener('submit', async event => {
    event.preventDefault();
    const question = summaryAskPrompt.value.trim();
    const submitButton = document.getElementById('submitSummaryAsk');
    if (!question) {
      summaryAskStatus.classList.add('error');
      summaryAskStatus.textContent = 'Enter a question about the simulation.';
      return;
    }
    const apiKey = document.getElementById('deepseekApiKey').value.trim();
    if (summaryConversationTurns.length >= 12) {
      summaryAskStatus.classList.add('error');
      summaryAskStatus.textContent = 'This conversation has reached 12 questions. Start a new conversation to continue.';
      return;
    }
    submitButton.disabled = true;
    summaryAskStatus.classList.remove('error');
    summaryAskStatus.textContent = '';
    summaryPendingQuestion = question;
    summaryPendingError = null;
    summaryAskPrompt.value = '';
    renderSummaryConversation();
    try {
      let userContent;
      if (summaryConversationMessages.length === 0) {
        const context = summaryQuestionContext();
        if (!context) throw new Error('Run the simulation before asking a question.');
        userContent = JSON.stringify(buildSummaryQuestionPrompt({ question, ...context }));
      } else {
        userContent = JSON.stringify(buildSummaryFollowUpPrompt(question));
      }
      const pendingMessages = [...summaryConversationMessages, { role: 'user', content: userContent }];
      const response = await requestDeepSeekConversation(apiKey, pendingMessages);
      const result = validateSummaryAnswer(response.value);
      summaryConversationMessages = [...pendingMessages, { role: 'assistant', content: response.assistantContent }];
      summaryConversationTurns.push({ question, result });
      summaryPendingQuestion = null;
      renderSummaryConversation();
    } catch (error) {
      summaryPendingQuestion = null;
      summaryPendingError = { question, message: error.message || 'Unable to analyze the simulation.' };
      renderSummaryConversation();
    } finally {
      submitButton.disabled = false;
      summaryAskPrompt.focus();
    }
  });

  function renderSummaryView() {
    const empty = document.getElementById('summaryEmptyState');
    const content = document.getElementById('summaryContent');
    if (!lastChartData) {
      const askButton = document.getElementById('summaryAskButton');
      askButton.disabled = true;
      askButton.title = 'Run the simulation before asking a question';
      empty.classList.remove('view-hidden');
      content.classList.add('view-hidden');
      return;
    }
    empty.classList.add('view-hidden');
    content.classList.remove('view-hidden');
    const askButton = document.getElementById('summaryAskButton');
    askButton.disabled = false;
    askButton.title = 'Ask DeepSeek about this simulation';

    const data = lastChartData;
    const median = maybeDeflateSeries(data.median);
    const p10 = maybeDeflateSeries(data.p10);
    const p90 = maybeDeflateSeries(data.p90);
    const assetOnlyP10 = maybeDeflateSeries(data.assetOnlyP10);
    const assetOnlyMedian = maybeDeflateSeries(data.assetOnlyMedian);
    const assetOnlyP90 = maybeDeflateSeries(data.assetOnlyP90);
    const startBalance = Object.values(state.accounts).reduce((sum, account) => sum + Number(account.balance || 0), 0);
    const minValue = Math.min(...median);
    const minAssetValue = Math.min(...assetOnlyMedian);
    const maxValue = Math.max(...median);
    const minIndex = median.indexOf(minValue);
    const minAssetIndex = assetOnlyMedian.indexOf(minAssetValue);
    const maxIndex = median.indexOf(maxValue);
    const retirementIndex = Math.min(data.months - 1, data.retirementMonthIndex);
    const retirementMedian = median[retirementIndex];
    const currentAge = parseInt(document.getElementById('currentAge').value, 10) || 0;
    const targetAge = parseInt(document.getElementById('retireAge').value, 10) || currentAge;
    const bankruptcyRate = data.particleCount ? data.bankruptcyCount / data.particleCount : 0;
    const belowStartRate = data.particleCount ? data.endingBelowStartingCount / data.particleCount : 0;
    const drawdown = worstDrawdown(data.labels, median);
    const first90Index = data.retirementReadinessTimeline.findIndex(point => point.successRate >= .9);
    const first90Age = first90Index >= 0 ? currentAge + first90Index / 12 : null;
    const cards = [
      { label: 'Starting net worth', value: formatMoney(startBalance), sub: `${Object.keys(state.accounts).length} accounts` },
      { label: 'Lowest median assets', value: formatMoney(minAssetValue), sub: `${data.labels[minAssetIndex]} · debt excluded`, range: { lower: assetOnlyP10[minAssetIndex], center: minAssetValue, upper: assetOnlyP90[minAssetIndex] } },
      { label: 'Lowest median assets less debt', value: formatMoney(minValue), sub: `${data.labels[minIndex]} · home asset excluded`, tone: minValue < 0 ? 'watch' : '', range: { lower: p10[minIndex], center: minValue, upper: p90[minIndex] } },
      { label: 'Highest median balance', value: formatMoney(maxValue), sub: data.labels[maxIndex], range: { lower: p10[maxIndex], center: maxValue, upper: p90[maxIndex] } },
      { label: 'Peak debt (median path)', value: formatMoney(data.maximumDebtStats?.p50 || 0), sub: `Nominal across paths · worst ${formatMoney(data.maximumDebt)}`, range: { lower: data.maximumDebtStats?.p10, center: data.maximumDebtStats?.p50, upper: data.maximumDebtStats?.p90 } },
      { label: 'Insolvent simulations', value: `${data.bankruptcyCount} / ${data.particleCount}`, sub: `${formatPercent(bankruptcyRate)} ever had a shortfall or ended negative`, tone: bankruptcyRate > .1 ? 'danger' : bankruptcyRate > 0 ? 'watch' : 'good' },
      { label: 'At target retirement', value: formatMoney(retirementMedian), sub: `Median · ${data.labels[retirementIndex]}`, range: { lower: p10[retirementIndex], center: retirementMedian, upper: p90[retirementIndex] } },
      { label: 'Worst median drawdown', value: drawdown.rate <= -1 ? '>100%' : formatPercent(Math.abs(drawdown.rate)), sub: `${drawdown.peakDate} → ${drawdown.troughDate}`, tone: drawdown.rate < -.2 ? 'watch' : 'good' },
      { label: '90% confidence age', value: first90Age == null ? 'Not reached' : String(Math.ceil(first90Age)), sub: first90Age == null ? 'Within modeled horizon' : `${Math.ceil(first90Age - currentAge)} years from now`, tone: first90Age == null ? 'danger' : first90Age > targetAge ? 'watch' : 'good' },
      { label: 'Finish below start', value: `${data.endingBelowStartingCount} / ${data.particleCount}`, sub: formatPercent(belowStartRate), tone: belowStartRate > .1 ? 'watch' : 'good' },
    ];
    document.getElementById('summaryHeroCards').innerHTML = cards.map(card => `
      <div class="summary-hero-card ${card.tone || ''} ${Number(card.range?.lower) < 0 ? 'range-negative' : ''}"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(card.value)}</strong><small>${escapeHtml(card.sub)}</small>${summaryRangeMarkup(card.range)}</div>`).join('');

    const recommendation = retirementRecommendation(data, currentAge, targetAge);
    document.getElementById('retirementRecommendation').className = `summary-recommendation ${recommendation.tone}`;
    document.getElementById('retirementRecommendation').innerHTML = `<span class="summary-recommendation-icon">${recommendation.tone === 'good' ? '✓' : '!'}</span><div><span>Retirement recommendation</span><h3>${escapeHtml(recommendation.title)}</h3><p>${escapeHtml(recommendation.detail)}</p></div>`;

    const displayedFireNumber = document.getElementById('realDollars').checked ? (data.fireStats?.fireNumber || 0) / inflationFactorAt(retirementIndex) : (data.fireStats?.fireNumber || 0);
    const insights = buildSummaryInsights({ data, startingNetWorth: startBalance, retirementIndex, median, p10, fireNumber: displayedFireNumber, currentAge, targetAge, drawdown });
    document.getElementById('summaryInsights').innerHTML = insights.map(insight => `<div class="summary-insight ${insight.tone}"><i>${insight.tone === 'good' ? '✓' : '!'}</i><div><strong>${escapeHtml(insight.title)}</strong><span>${escapeHtml(insight.detail)}</span></div></div>`).join('');

    const events = summaryPlanEvents();
    document.getElementById('summaryEvents').innerHTML = events.length ? events.map(event => `
      <div class="summary-event"><time>${escapeHtml(event.month || 'Ongoing')}</time><i class="${event.tone}"></i><div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.detail)}</span></div></div>`).join('') : '<p class="small">No major events configured.</p>';

    document.getElementById('summaryToughYears').innerHTML = toughestYears(data.labels, median).map((year, index) => `
      <div class="summary-stress"><span class="summary-stress-rank">${index + 1}</span><div><strong>${year.year}</strong><small>Median ends at ${formatMoney(year.value)}</small></div><b class="${year.change < 0 ? 'negative' : ''}">${year.change >= 0 ? '+' : ''}${formatPercent(year.change)}</b></div>`).join('');

    const fireNumber = displayedFireNumber;
    const gap = retirementMedian - fireNumber;
    const success = data.fireStats?.successRate || 0;
    const progress = fireNumber > 0 ? Math.min(100, Math.max(0, retirementMedian / fireNumber * 100)) : 0;
    document.getElementById('summaryRetirementStanding').innerHTML = `
      <div class="retirement-standing-grid">
        <div><span>P10</span><strong>${formatMoney(p10[retirementIndex])}</strong></div>
        <div class="primary"><span>Median</span><strong>${formatMoney(retirementMedian)}</strong></div>
        <div><span>P90</span><strong>${formatMoney(p90[retirementIndex])}</strong></div>
        <div><span>FIRE target</span><strong>${formatMoney(fireNumber)}</strong></div>
        <div><span>Median gap</span><strong class="${gap < 0 ? 'negative' : 'positive'}">${gap >= 0 ? '+' : ''}${formatMoney(gap)}</strong></div>
        <div><span>Success probability</span><strong>${formatPercent(success)}</strong></div>
      </div>
      <div class="retirement-progress"><i style="width:${progress}%"></i></div>`;
  }

  function renderReportsView() {
    const emptyEl = document.getElementById('reportsEmptyState');
    const contentEl = document.getElementById('reportsContent');
    if (!lastChartData) {
      emptyEl.classList.remove('view-hidden');
      contentEl.classList.add('view-hidden');
      return;
    }
    emptyEl.classList.add('view-hidden');
    contentEl.classList.remove('view-hidden');

    const { labels, median, p10, p90, mean, fireStats, solvencyRate, resampleEvents, useParticleFilter, retirementMonthIndex, months, marketEventStats, byAccountTimeline } = lastChartData;
    const deflatedMedian = maybeDeflateSeries(median);
    const deflatedP10 = maybeDeflateSeries(p10);
    const deflatedP90 = maybeDeflateSeries(p90);
    const deflatedMean = maybeDeflateSeries(mean);
    const deflatedTimeline = maybeDeflateAccountTimeline(byAccountTimeline);

    const cards = [
      { label: 'Median balance at end', value: formatMoney(deflatedMedian.at(-1)) },
      { label: 'Solvency rate (final)', value: formatPercent(solvencyRate) },
    ];
    if (fireStats) {
      const displayedFireNumber = document.getElementById('realDollars').checked ? fireStats.fireNumber / inflationFactorAt(retirementMonthIndex) : fireStats.fireNumber;
      cards.push({ label: 'FIRE number at retirement', value: formatMoney(displayedFireNumber) });
      cards.push({ label: 'P(reach FIRE by retirement)', value: formatPercent(fireStats.successRate) });
    }
    if (useParticleFilter) cards.push({ label: 'Resample events', value: String(resampleEvents) });
    document.getElementById('reportsSummaryCards').innerHTML = cards.map(c => `
      <div class="report-card">
        <span class="report-card-label">${escapeHtml(c.label)}</span>
        <span class="report-card-value">${escapeHtml(c.value)}</span>
      </div>`).join('');

    const milestoneIndices = milestoneMonthIndices(months, retirementMonthIndex);
    document.getElementById('reportsMilestoneBody').innerHTML = milestoneIndices.map(i => `
      <tr>
        <td>${escapeHtml(labels[i])}${retirementMonthIndex === i ? ' <span class="small">(retirement)</span>' : ''}</td>
        <td>${formatMoney(deflatedP10[i])}</td>
        <td>${formatMoney(deflatedMedian[i])}</td>
        <td>${formatMoney(deflatedP90[i])}</td>
        <td>${formatMoney(deflatedMean[i])}</td>
      </tr>`).join('');

    const finalRow = deflatedTimeline.at(-1) || {};
    const totalNetWorth = Object.values(finalRow).reduce((s, v) => s + v, 0);
    const accountRows = Object.values(state.accounts)
      .map(account => {
        const balance = finalRow[account.id] || 0;
        const share = totalNetWorth !== 0 ? balance / totalNetWorth : 0;
        return { account, balance, share };
      })
      .sort((a, b) => b.balance - a.balance);
    document.getElementById('reportsAccountBody').innerHTML = accountRows.map(({ account, balance, share }) => `
      <tr>
        <td>${escapeHtml(account.name)}</td>
        <td>${escapeHtml(ACCOUNT_TYPE_LABELS[account.type] || account.type)}</td>
        <td>${formatMoney(balance)}</td>
        <td>${formatPercent(share)}</td>
      </tr>`).join('');

    const eventsCard = document.getElementById('reportsEventsCard');
    if (marketEventStats && marketEventStats.length > 0) {
      eventsCard.classList.remove('view-hidden');
      document.getElementById('reportsEventsBody').innerHTML = marketEventStats.map(event => `
        <tr>
          <td>${escapeHtml(event.name)}</td>
          <td>${formatPercent(event.configuredProbability)}</td>
          <td>${formatPercent(event.triggerRate)}</td>
        </tr>`).join('');
    } else {
      eventsCard.classList.add('view-hidden');
    }
  }

  // --- CSV / Python export (shared by the Plots and Reports pages) ---

  function currentResultsCsv() {
    if (!lastChartData) return '';
    const { labels, median, p10, p90, mean, byAccountTimeline } = lastChartData;
    const series = {
      p10: maybeDeflateSeries(p10),
      p50: maybeDeflateSeries(median),
      p90: maybeDeflateSeries(p90),
      mean: maybeDeflateSeries(mean),
    };
    const rows = buildResultsDataFrameRows(labels, series, maybeDeflateAccountTimeline(byAccountTimeline), state.accounts);
    return rowsToCsv(rows);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for browsers/contexts without the async Clipboard API.
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      textarea.remove();
      return ok;
    }
  }

  function downloadTextFile(filename, mimeType, content) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function wireExportToolbar(prefix) {
    const statusEl = document.getElementById(`${prefix}ExportStatus`);
    let statusTimer = null;
    const setStatus = message => {
      clearTimeout(statusTimer);
      statusEl.textContent = message;
      statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 3000);
    };

    document.getElementById(`${prefix}DownloadCsv`).addEventListener('click', async () => {
      if (!lastChartData) { setStatus('Run the simulation first.'); return; }
      await withLoading('Preparing CSV download…', async () => {
        downloadTextFile('financial-simulation-results.csv', 'text/csv', currentResultsCsv());
      });
      setStatus('Downloaded CSV.');
    });

    document.getElementById(`${prefix}CopyCsv`).addEventListener('click', async () => {
      if (!lastChartData) { setStatus('Run the simulation first.'); return; }
      const ok = await withLoading('Copying CSV…', () => copyToClipboard(currentResultsCsv()));
      setStatus(ok ? 'CSV copied to clipboard.' : 'Could not copy — try Download CSV instead.');
    });

    document.getElementById(`${prefix}CopyPython`).addEventListener('click', async () => {
      if (!lastChartData) { setStatus('Run the simulation first.'); return; }
      const ok = await withLoading('Preparing Python export…', () => copyToClipboard(buildPythonSnippet(currentResultsCsv())));
      setStatus(ok ? 'Python (pandas + matplotlib) snippet copied to clipboard.' : 'Could not copy — try Download CSV instead.');
    });
  }

  wireExportToolbar('plots');
  wireExportToolbar('reports');

  document.getElementById('balanceScale').addEventListener('change', renderBalance);
  document.getElementById('compositionScale').addEventListener('change', renderAccountMix);
  document.getElementById('realDollars').addEventListener('change', () => { resetSummaryConversation(); renderBalance(); renderAccountMix(); renderSummaryView(); renderReportsView(); });
  document.getElementById('summaryShowRanges').addEventListener('change', renderSummaryView);
  document.getElementById('showIndividualTraces').addEventListener('change', event => {
    document.getElementById('individualTraceCount').disabled = !event.target.checked;
    renderBalance();
  });
  document.getElementById('individualTraceCount').addEventListener('change', renderBalance);

  function resizePlots() {
    requestAnimationFrame(() => {
      for (const id of ['balanceChart', 'compositionChart']) {
        const el = document.getElementById(id);
        if (el?.data) Plotly.Plots.resize(el);
      }
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

main().then(hideLoading).catch(error => {
  console.error(error);
  showLoadingError(error);
});


