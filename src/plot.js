// Chart helpers
export function renderBalanceChart(ctx, labels, median, p10, p90, markers = []) {
  if (window._balanceChart) window._balanceChart.destroy();
  window._balanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'P90', data: p90, borderColor: 'rgba(37,99,168,0.35)', backgroundColor: 'rgba(37,99,168,0.08)', borderWidth: 1, pointRadius: 0, tension: 0, fill: '+1' },
        { label: 'Median', data: median, borderColor: '#2563a8', backgroundColor: '#2563a8', borderWidth: 2, pointRadius: 0, tension: 0 },
        { label: 'P10', data: p10, borderColor: 'rgba(37,99,168,0.35)', borderWidth: 1, pointRadius: 0, tension: 0, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { usePointStyle: false, boxWidth: 14, boxHeight: 2, padding: 16, color: '#65707c', font: { size: 11, weight: 600 } } },
        annotation: undefined,
      },
      scales: {
        x: { grid: { color: 'rgba(101,112,124,0.08)' }, ticks: { color: '#65707c', maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, border: { display: false } },
        y: { grid: { color: 'rgba(101,112,124,0.12)' }, ticks: { color: '#65707c', callback: val => formatCurrency(val), font: { size: 10 } }, border: { display: false } },
      },
    },
  });
}

const ACCOUNT_TYPE_COLORS = {
  checking: 'rgba(52, 120, 190, 0.75)',
  hysa: 'rgba(22, 131, 111, 0.75)',
  taxable: 'rgba(82, 95, 115, 0.75)',
  retirement: 'rgba(93, 75, 154, 0.75)',
  debt: 'rgba(180, 35, 44, 0.75)',
};

export function renderCompositionChart(ctx, labels, byTypeTimeline) {
  if (window._compositionChart) window._compositionChart.destroy();
  const types = Object.keys(ACCOUNT_TYPE_COLORS);
  const datasets = types.map(t => ({
    label: t,
    data: byTypeTimeline.map(row => row[t] || 0),
    backgroundColor: ACCOUNT_TYPE_COLORS[t],
    fill: true,
    pointRadius: 0,
    tension: 0,
  }));
  window._compositionChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, labels: { usePointStyle: false, boxWidth: 14, boxHeight: 6, padding: 14, color: '#65707c', font: { size: 11, weight: 600 } } } },
      scales: {
        x: { stacked: true, grid: { color: 'rgba(101,112,124,0.08)' }, ticks: { color: '#65707c', maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, border: { display: false } },
        y: { stacked: true, grid: { color: 'rgba(101,112,124,0.12)' }, ticks: { color: '#65707c', callback: val => formatCurrency(val), font: { size: 10 } }, border: { display: false } },
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

