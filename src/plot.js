// Chart helpers
function axisBounds(labels, viewport, logX, logY) {
  const xMinIndex = viewport?.xMin ? labels.indexOf(viewport.xMin) : -1;
  const xMaxIndex = viewport?.xMax ? labels.indexOf(viewport.xMax) : -1;
  const yMin = viewport?.yMin === '' || viewport?.yMin == null ? NaN : Number(viewport.yMin);
  const yMax = viewport?.yMax === '' || viewport?.yMax == null ? NaN : Number(viewport.yMax);
  return {
    xMin: xMinIndex >= 0 ? (logX ? xMinIndex + 1 : labels[xMinIndex]) : undefined,
    xMax: xMaxIndex >= 0 ? (logX ? xMaxIndex + 1 : labels[xMaxIndex]) : undefined,
    yMin: Number.isFinite(yMin) && (!logY || yMin > 0) ? yMin : undefined,
    yMax: Number.isFinite(yMax) && (!logY || yMax > 0) ? yMax : undefined,
  };
}

function logCurrencyTick(value) {
  if (!(value > 0)) return '';
  const exponent = Math.log10(value);
  return Math.abs(exponent - Math.round(exponent)) < 1e-8 ? formatCurrency(value) : '';
}

function xScale(labels, logX, bounds, stacked = false) {
  return {
    type: logX ? 'logarithmic' : 'category',
    stacked,
    min: bounds.xMin,
    max: bounds.xMax,
    grid: { color: 'rgba(101,112,124,0.08)' },
    ticks: {
      color: '#65707c',
      autoSkip: true,
      maxTicksLimit: 8,
      maxRotation: 0,
      callback: logX ? value => labels[Math.max(0, Math.round(Number(value)) - 1)] || '' : undefined,
      font: { size: 10 },
    },
    border: { display: false },
  };
}

function yScale(logY, bounds, stacked = false) {
  return {
    type: logY ? 'logarithmic' : 'linear',
    stacked,
    min: bounds.yMin,
    max: bounds.yMax,
    grid: { color: 'rgba(101,112,124,0.12)' },
    ticks: {
      color: '#65707c',
      autoSkip: true,
      maxTicksLimit: logY ? 6 : 8,
      callback: logY ? logCurrencyTick : value => formatCurrency(value),
      font: { size: 10 },
    },
    border: { display: false },
  };
}

export function renderBalanceChart(ctx, labels, median, p10, p90, scaleMode = 'linear', viewport = {}) {
  if (window._balanceChart) window._balanceChart.destroy();
  const logX = scaleMode === 'log-x' || scaleMode === 'log-xy';
  const logY = scaleMode === 'log-y' || scaleMode === 'log-xy';
  const bounds = axisBounds(labels, viewport, logX, logY);
  const chartData = values => logX ? values.map((y, index) => ({ x: index + 1, y })) : values;
  window._balanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'P90', data: chartData(p90), borderColor: 'rgba(37,99,168,0.35)', backgroundColor: 'rgba(37,99,168,0.08)', borderWidth: 1, pointRadius: 0, tension: 0, fill: '+1' },
        { label: 'Median', data: chartData(median), borderColor: '#2563a8', backgroundColor: '#2563a8', borderWidth: 2, pointRadius: 0, tension: 0 },
        { label: 'P10', data: chartData(p10), borderColor: 'rgba(37,99,168,0.35)', borderWidth: 1, pointRadius: 0, tension: 0, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { usePointStyle: false, boxWidth: 14, boxHeight: 2, padding: 16, color: '#65707c', font: { size: 11, weight: 600 } } },
        tooltip: logX ? { callbacks: { title: items => labels[Math.max(0, Math.round(items[0].parsed.x) - 1)] || '' } } : {},
        annotation: undefined,
      },
      scales: {
        x: xScale(labels, logX, bounds),
        y: yScale(logY, bounds),
      },
    },
  });
}

const ACCOUNT_COLORS = ['rgba(52,120,190,.75)', 'rgba(22,131,111,.75)', 'rgba(93,75,154,.75)', 'rgba(180,130,40,.75)', 'rgba(180,35,44,.75)', 'rgba(82,95,115,.75)', 'rgba(48,148,167,.75)', 'rgba(173,82,135,.75)'];

export function renderCompositionChart(ctx, labels, byAccountTimeline, accounts, visibleAccountIds = null, scaleMode = 'linear', viewport = {}) {
  if (window._compositionChart) window._compositionChart.destroy();
  const logX = scaleMode === 'log-x' || scaleMode === 'log-xy';
  const logY = scaleMode === 'log-y' || scaleMode === 'log-xy';
  const bounds = axisBounds(labels, viewport, logX, logY);
  const chartData = values => logX ? values.map((y, index) => ({ x: index + 1, y })) : values;
  const accountList = Object.values(accounts);
  const visible = visibleAccountIds ? new Set(visibleAccountIds) : new Set(accountList.map(account => account.id));
  const datasets = accountList.filter(account => visible.has(account.id)).map(account => {
    const index = accountList.findIndex(candidate => candidate.id === account.id);
    return ({
    label: account.name,
    data: chartData(byAccountTimeline.map(row => row[account.id] || 0)),
    backgroundColor: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
    borderColor: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
    fill: true,
    pointRadius: 0,
    tension: 0,
    });
  });
  window._compositionChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { usePointStyle: false, boxWidth: 14, boxHeight: 6, padding: 14, color: '#65707c', font: { size: 11, weight: 600 } } },
        tooltip: logX ? { callbacks: { title: items => labels[Math.max(0, Math.round(items[0].parsed.x) - 1)] || '' } } : {},
      },
      scales: {
        x: xScale(labels, logX, bounds, true),
        y: yScale(logY, bounds, true),
      },
    },
  });
}

function formatCurrency(v) {
  const sign = v < 0 ? '−' : '';
  const value = Math.abs(v);
  if (value >= 1e9) return `${sign}$${(value / 1e9).toFixed(value >= 10e9 ? 0 : 1)}B`;
  if (value >= 1e6) return `${sign}$${(value / 1e6).toFixed(value >= 10e6 ? 0 : 1)}M`;
  if (value >= 1000) return `${sign}$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return `${sign}$${value.toFixed(0)}`;
}

