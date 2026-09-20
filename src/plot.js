// Plotly chart helpers. Plotly provides direct pan, wheel zoom, box zoom,
// autoscale, reset, hover inspection, and image export through its modebar.

const ACCOUNT_COLORS = [
  'rgba(52,120,190,.76)',
  'rgba(22,131,111,.76)',
  'rgba(93,75,154,.76)',
  'rgba(180,130,40,.76)',
  'rgba(180,35,44,.76)',
  'rgba(82,95,115,.76)',
  'rgba(48,148,167,.76)',
  'rgba(173,82,135,.76)',
];

const PLOT_CONFIG = {
  responsive: true,
  scrollZoom: true,
  displaylogo: false,
  displayModeBar: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  toImageButtonOptions: { format: 'png', filename: 'financial-forecast', scale: 2 },
};

function scaleModes(scaleMode) {
  return {
    logX: scaleMode === 'log-x' || scaleMode === 'log-xy',
    logY: scaleMode === 'log-y' || scaleMode === 'log-xy',
  };
}

function geometricTicks(length, maxTicks = 8) {
  if (length <= 1) return [1];
  const ticks = new Set([1, length]);
  const ratio = length ** (1 / (maxTicks - 1));
  for (let i = 1; i < maxTicks - 1; i++) ticks.add(Math.max(1, Math.min(length, Math.round(ratio ** i))));
  return [...ticks].sort((a, b) => a - b);
}

function themeColors() {
  const styles = getComputedStyle(document.documentElement);
  const color = name => styles.getPropertyValue(name).trim();
  return {
    accent: color('--accent'),
    accentSoft: color('--plot-accent-soft'),
    band: color('--plot-band'),
    card: color('--card'),
    danger: color('--danger'),
    ink: color('--ink'),
    muted: color('--muted'),
    path: color('--plot-path'),
    grid: color('--plot-grid'),
    axis: color('--plot-axis'),
  };
}

function axes(labels, scaleMode, colors) {
  const { logX, logY } = scaleModes(scaleMode);
  const xaxis = {
    type: logX ? 'log' : 'date',
    gridcolor: colors.grid,
    linecolor: colors.axis,
    tickfont: { color: colors.muted, size: 10 },
    fixedrange: false,
    rangeslider: { visible: false },
  };
  if (logX) {
    const ticks = geometricTicks(labels.length);
    xaxis.tickmode = 'array';
    xaxis.tickvals = ticks;
    xaxis.ticktext = ticks.map(index => labels[index - 1]);
  }
  const yaxis = {
    type: logY ? 'log' : 'linear',
    gridcolor: colors.grid,
    linecolor: colors.axis,
    tickfont: { color: colors.muted, size: 10 },
    tickprefix: '$',
    tickformat: '~s',
    nticks: logY ? 6 : 8,
    fixedrange: false,
  };
  return { xaxis, yaxis, logX, logY };
}

function eventDecorations(labels, marketEventStats, logX, colors) {
  const markers = (marketEventStats || []).flatMap(event => (event.triggerMonths || []).map(trigger => ({ ...trigger, name: event.name })));
  const visible = markers.filter(marker => marker.monthIndex >= 0 && marker.monthIndex < labels.length);
  return {
    shapes: visible.map(marker => ({
      type: 'line',
      xref: 'x',
      yref: 'paper',
      x0: logX ? marker.monthIndex + 1 : labels[marker.monthIndex],
      x1: logX ? marker.monthIndex + 1 : labels[marker.monthIndex],
      y0: 0,
      y1: 1,
      line: { color: `rgba(190,35,48,${Math.min(.9, .35 + marker.rate * 3)})`, width: Math.min(3, 1 + marker.rate * 8), dash: 'dash' },
    })),
    annotations: visible.filter(marker => marker.rate >= .01).slice(0, 8).map((marker, index) => ({
      xref: 'x',
      yref: 'paper',
      x: logX ? marker.monthIndex + 1 : labels[marker.monthIndex],
      y: .98 - (index % 3) * .06,
      text: `${marker.name} ${(marker.rate * 100).toFixed(1)}%`,
      textangle: -90,
      showarrow: false,
      xanchor: 'left',
      font: { color: colors.danger, size: 9 },
    })),
  };
}

function commonLayout(element, labels, scaleMode, marketEventStats) {
  const colors = themeColors();
  const { xaxis, yaxis, logX, logY } = axes(labels, scaleMode, colors);
  const events = eventDecorations(labels, marketEventStats, logX, colors);
  return {
    autosize: true,
    margin: { l: 64, r: 18, t: 36, b: 44 },
    paper_bgcolor: colors.card,
    plot_bgcolor: colors.card,
    font: { color: colors.ink },
    hovermode: 'x unified',
    dragmode: 'pan',
    uirevision: `${element.id}:${scaleMode}`,
    legend: { orientation: 'h', x: 0, y: 1.12, font: { color: colors.muted, size: 10 } },
    xaxis,
    yaxis,
    shapes: events.shapes,
    annotations: events.annotations,
    transition: { duration: 0 },
    meta: { logX, logY, colors },
  };
}

function xValues(labels, logX) {
  return logX ? labels.map((_, index) => index + 1) : labels;
}

function hoverTemplate(logX) {
  return logX ? '%{customdata}<br>%{fullData.name}: $%{y:,.0f}<extra></extra>' : '%{x|%b %Y}<br>%{fullData.name}: $%{y:,.0f}<extra></extra>';
}

export function renderBalanceChart(element, labels, median, p10, p90, scaleMode = 'linear', marketEventStats = [], individualTraces = []) {
  const layout = commonLayout(element, labels, scaleMode, marketEventStats);
  const x = xValues(labels, layout.meta.logX);
  const customdata = layout.meta.logX ? labels : undefined;
  const hovertemplate = hoverTemplate(layout.meta.logX);
  const pathTraces = individualTraces.map((path, index) => {
    const values = Array.isArray(path) ? path : path.values;
    const failed = !Array.isArray(path) && path.failed;
    return {
    name: failed ? `Failed path ${index + 1}` : `Path ${index + 1}`,
    x,
    y: values,
    customdata,
    type: 'scatter',
    mode: 'lines',
    line: { color: failed ? layout.meta.colors.danger : layout.meta.colors.path, width: failed ? 1.25 : .75 },
    hovertemplate,
    showlegend: false,
  }; });
  const traces = [
    ...pathTraces,
    { name: 'P10', x, y: p10, customdata, type: 'scatter', mode: 'lines', line: { color: layout.meta.colors.accentSoft, width: 1 }, hovertemplate },
    { name: 'P90', x, y: p90, customdata, type: 'scatter', mode: 'lines', line: { color: layout.meta.colors.accentSoft, width: 1 }, fill: 'tonexty', fillcolor: layout.meta.colors.band, hovertemplate },
    { name: 'Median', x, y: median, customdata, type: 'scatter', mode: 'lines', line: { color: layout.meta.colors.accent, width: 2 }, hovertemplate },
  ];
  return Plotly.react(element, traces, layout, PLOT_CONFIG);
}

export function renderCompositionChart(element, labels, byAccountTimeline, accounts, visibleAccountIds = null, scaleMode = 'linear', marketEventStats = []) {
  const layout = commonLayout(element, labels, scaleMode, marketEventStats);
  const x = xValues(labels, layout.meta.logX);
  const customdata = layout.meta.logX ? labels : undefined;
  const hovertemplate = hoverTemplate(layout.meta.logX);
  const accountList = Object.values(accounts);
  const visible = visibleAccountIds ? new Set(visibleAccountIds) : new Set(accountList.map(account => account.id));
  const traces = accountList.filter(account => visible.has(account.id)).map(account => {
    const color = ACCOUNT_COLORS[accountList.findIndex(candidate => candidate.id === account.id) % ACCOUNT_COLORS.length];
    return {
      name: account.name,
      x,
      y: byAccountTimeline.map(row => row[account.id] || 0),
      customdata,
      type: 'scatter',
      mode: 'lines',
      line: { color, width: 1.25 },
      stackgroup: layout.meta.logY ? undefined : 'accounts',
      hovertemplate,
    };
  });
  return Plotly.react(element, traces, layout, PLOT_CONFIG);
}
