// Chart helpers
export function renderBalanceChart(ctx, labels, median, p10, p90, markers = []) {
  if (window._balanceChart) window._balanceChart.destroy();
  window._balanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'P90', data: p90, borderColor: 'rgba(75,192,192,0.2)', pointRadius: 0, tension: 0.2, fill: '+1' },
        { label: 'Median', data: median, borderColor: 'rgba(20,100,255,1)', pointRadius: 0, tension: 0.2 },
        { label: 'P10', data: p10, borderColor: 'rgba(75,192,192,0.2)', pointRadius: 0, tension: 0.2, fill: false },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true },
        annotation: undefined,
      },
      scales: {
        y: { ticks: { callback: val => formatCurrency(val) } },
      },
    },
  });
}

const ACCOUNT_TYPE_COLORS = {
  checking: 'rgba(54,162,235,0.7)',
  hysa: 'rgba(75,192,192,0.7)',
  taxable: 'rgba(153,102,255,0.7)',
  retirement: 'rgba(255,159,64,0.7)',
  debt: 'rgba(255,99,132,0.7)',
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
    tension: 0.2,
  }));
  window._compositionChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true } },
      scales: {
        y: { stacked: true, ticks: { callback: val => formatCurrency(val) } },
      },
    },
  });
}

function formatCurrency(v) {
  if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
  return '$' + v.toFixed(0);
}

