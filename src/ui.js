// Renders and wires up all editable forms: accounts, income/expense blocks,
// the global returns schedule, and the house-affordability calculator.
// State objects (Account, block plain-objects, ReturnsSchedule) are mutated
// in place by input listeners so `app.js` can read `state` directly at
// "Run Simulation" time.

import { Account, ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, nextAccountId } from './accounts.js';
import { createBlock, createLoanBlock, AmountSchedule, buildScheduleClips, spliceScheduleClip, loanDownPaymentAmount, loanPrincipal, loanMonthlyPayment } from './blocks.js';
import { ReturnsSchedule } from './returnsSchedule.js';
import { cities } from './taxes.js';
import { maxHomePrice } from './affordability.js';
import { createScenarioExport, reviveScenarioExport, saveAutosave, loadAutosave, clearAutosave } from './persistence.js';
import { buildBaseScenario } from './baseScenario.js';
import { loadMeScenario } from './meScenario.js';
import { createMarketEvent } from './marketEvents.js';

function todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function pct(v) { return ((v || 0) * 100).toFixed(1); }

function formatCompactMoney(value) {
  const amount = Number(value) || 0;
  const sign = amount < 0 ? '−' : '';
  return `${sign}$${Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function safeFilename(value) {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'financial-scenario';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function keyToIdx(key) {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
}
function idxToKey(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}
function nextMonthKey(key) {
  return idxToKey(keyToIdx(key) + 1);
}

// The top-bar "settings" (as opposed to the full accounts/blocks/returns state).
function gatherSettings() {
  return {
    currentAge: document.getElementById('currentAge').value,
    retireAge: document.getElementById('retireAge').value,
    city: document.getElementById('citySelect').value,
    numParticles: document.getElementById('numParticles').value,
    useParticleFilter: document.getElementById('useParticleFilter').checked,
    inflationRate: document.getElementById('inflationRate').value,
    realDollars: document.getElementById('realDollars').checked,
    capGainsEnabled: document.getElementById('capGainsEnabled').checked,
    capGainsRate: document.getElementById('capGainsRate').value,
  };
}

function applySettings(settings) {
  if (!settings) return;
  if (settings.currentAge != null) document.getElementById('currentAge').value = settings.currentAge;
  if (settings.retireAge != null) document.getElementById('retireAge').value = settings.retireAge;
  if (settings.city != null) document.getElementById('citySelect').value = settings.city;
  if (settings.numParticles != null) document.getElementById('numParticles').value = settings.numParticles;
  if (settings.useParticleFilter != null) document.getElementById('useParticleFilter').checked = settings.useParticleFilter;
  if (settings.inflationRate != null) document.getElementById('inflationRate').value = settings.inflationRate;
  if (settings.realDollars != null) document.getElementById('realDollars').checked = settings.realDollars;
  if (settings.capGainsEnabled != null) document.getElementById('capGainsEnabled').checked = settings.capGainsEnabled;
  if (settings.capGainsRate != null) document.getElementById('capGainsRate').value = settings.capGainsRate;
}

function seedDefaultBlocksIfEmpty(state) {
  if (state.blocks.length > 0) return;
  const checking = Object.values(state.accounts).find(a => a.type === 'checking');
  const retirement = Object.values(state.accounts).find(a => a.type === 'retirement');
  state.blocks.push(createBlock({ category: 'income', kind: 'continuous', description: 'Salary', amount: 95000, startMonth: todayMonth(), preTax: true, targetAccountId: checking?.id }));
  state.blocks.push(createBlock({ category: 'income', kind: 'continuous', description: '401k contribution', amount: 15000, startMonth: todayMonth(), preTax: true, targetAccountId: retirement?.id }));
  state.blocks.push(createBlock({ category: 'expense', kind: 'continuous', description: 'Living costs', amount: 48000, startMonth: todayMonth(), sourceAccountId: checking?.id, sigma: 0.05 }));
}

export async function initUI(state) {
  const accountsDiv = document.getElementById('accounts');
  const blocksDiv = document.getElementById('blocks');
  const segmentsDiv = document.getElementById('returnsSegments');
  const marketEventsDiv = document.getElementById('marketEvents');
  const withdrawalOrderDiv = document.getElementById('withdrawalOrderList');
  const citySelect = document.getElementById('citySelect');
  const defaultAnnualInput = document.getElementById('defaultAnnual');
  const defaultSigmaInput = document.getElementById('defaultSigma');
  const scenarioNameInput = document.getElementById('scenarioName');
  const scenarioNotesInput = document.getElementById('scenarioNotes');
  const scenarioFileInput = document.getElementById('scenarioFile');
  const scenarioStatus = document.getElementById('scenarioStatus');
  const blockEditor = document.getElementById('blockEditor');
  const editorBlockList = document.getElementById('editorBlockList');
  const editorDetail = document.getElementById('editorDetail');
  const editorBlockCount = document.getElementById('editorBlockCount');
  const editorState = { blockId: null, clipIndex: 0, timelineScrollLeft: 0 };

  for (const c of cities()) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    citySelect.appendChild(opt);
  }
  citySelect.value = 'Default';

  // Prefer a personal `me.json` (gitignored, fetched from the filesystem) if
  // one is present; otherwise fall back to the generic example scenario.
  const meScenario = await loadMeScenario();
  const base = meScenario || buildBaseScenario();

  // Restore the last working session (if any) before falling back to the base scenario.
  const auto = loadAutosave();
  if (auto) {
    state.accounts = auto.state.accounts;
    state.blocks = auto.state.blocks;
    state.globalReturnsSchedule = auto.state.globalReturnsSchedule;
    state.marketEvents = auto.state.marketEvents || [];
    state.withdrawalOrder = auto.state.withdrawalOrder || [];
    applySettings(auto.settings);
    scenarioNotesInput.value = auto.notes || '';
  } else {
    state.accounts = base.state.accounts;
    state.blocks = base.state.blocks;
    state.globalReturnsSchedule = base.state.globalReturnsSchedule;
    state.marketEvents = base.state.marketEvents || [];
    state.withdrawalOrder = base.state.withdrawalOrder || [];
    applySettings(base.settings);
    scenarioNotesInput.value = base.notes;
    scenarioNameInput.value = base.name;
  }
  seedDefaultBlocksIfEmpty(state);

  defaultAnnualInput.value = pct(state.globalReturnsSchedule.defaultAnnual);
  defaultSigmaInput.value = pct(state.globalReturnsSchedule.defaultSigma);
  defaultAnnualInput.addEventListener('input', e => { state.globalReturnsSchedule.defaultAnnual = parseFloat(e.target.value || 0) / 100; });
  defaultSigmaInput.addEventListener('input', e => { state.globalReturnsSchedule.defaultSigma = parseFloat(e.target.value || 0) / 100; });

  function accountOptions(selectedId, filterFn = () => true) {
    const opts = ['<option value="">— none —</option>'];
    for (const a of Object.values(state.accounts)) {
      if (!filterFn(a)) continue;
      opts.push(`<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${a.name}</option>`);
    }
    return opts.join('');
  }

  function simulationWindow() {
    const currentAge = parseInt(document.getElementById('currentAge').value, 10) || 0;
    const retireAge = parseInt(document.getElementById('retireAge').value, 10) || currentAge;
    const years = Math.max(Math.max(0, retireAge - currentAge) + 30, 20);
    const from = todayMonth();
    return { from, to: idxToKey(keyToIdx(from) + years * 12 - 1) };
  }

  function canonicalizeBlockSchedule(block) {
    const window = simulationWindow();
    const sourceEntries = block.useCustomSchedule
      ? block.amountSchedule.entries
      : [{ from: block.startMonth || window.from, to: block.endMonth || window.to, name: block.description, annualAmount: block.amount }];
    block.amountSchedule = new AmountSchedule(buildScheduleClips(sourceEntries, window.from, window.to));
    block.useCustomSchedule = true;
    block.startMonth = window.from;
    block.endMonth = window.to;
  }

  function editorBlockById() {
    return state.blocks.find(block => block.id === editorState.blockId) || null;
  }

  function addEditorBlock(category) {
    const checking = Object.values(state.accounts).find(account => account.type === 'checking');
    const block = createBlock({
      category,
      kind: 'continuous',
      description: category === 'income' ? 'New income' : 'New expense',
      amount: category === 'income' ? 50000 : 12000,
      startMonth: todayMonth(),
      preTax: category === 'income',
      targetAccountId: category === 'income' ? checking?.id : null,
      sourceAccountId: category === 'expense' ? checking?.id : null,
    });
    state.blocks.push(block);
    editorState.blockId = block.id;
    editorState.clipIndex = 0;
    renderBlockEditor();
  }

  function renderEditorList() {
    editorBlockCount.textContent = state.blocks.length;
    editorBlockList.innerHTML = state.blocks.map(block => {
      const active = block.id === editorState.blockId;
      const type = block.kind === 'loan' ? 'Financed purchase' : block.category === 'income' ? 'Income' : 'Expense';
      const amount = block.kind === 'loan' ? block.purchasePrice : block.amount;
      return `
        <button class="editor-list-item ${active ? 'active' : ''}" data-block-id="${escapeHtml(block.id)}" type="button">
          <span class="flow-avatar ${block.category === 'income' ? 'income' : 'expense'}" aria-hidden="true">${block.category === 'income' ? '↓' : '↑'}</span>
          <span class="flow-copy"><strong>${escapeHtml(block.description || type)}</strong><small>${type} · ${formatCompactMoney(amount)}</small></span>
        </button>`;
    }).join('');
    editorBlockList.querySelectorAll('[data-block-id]').forEach(button => {
      button.addEventListener('click', () => {
        editorState.blockId = button.dataset.blockId;
        editorState.clipIndex = 0;
        renderBlockEditor();
      });
    });
  }

  function renderLoanEditor(block) {
    editorDetail.innerHTML = `
      <div class="detail-heading"><div><p class="eyebrow">Financed purchase</p><h3>${escapeHtml(block.description)}</h3></div></div>
      <div class="editor-form-grid">
        <label>Name <input data-loan-field="description" value="${escapeHtml(block.description)}"/></label>
        <label>Purchase month <input data-loan-field="startMonth" type="month" value="${block.startMonth || ''}"/></label>
        <label>Purchase price $ <input data-loan-field="purchasePrice" type="number" value="${block.purchasePrice}"/></label>
        <label>Down payment % <input data-loan-field="downPaymentPct" data-percent type="number" step="1" value="${(block.downPaymentPct * 100).toFixed(0)}"/></label>
        <label>Mortgage rate % <input data-loan-field="annualRate" data-percent type="number" step="0.05" value="${(block.annualRate * 100).toFixed(2)}"/></label>
        <label>Term (years) <input data-loan-field="termYears" type="number" value="${block.termYears}"/></label>
        <label>Paid from <select data-loan-field="sourceAccountId">${accountOptions(block.sourceAccountId, account => account.type !== 'debt')}</select></label>
      </div>
      <div class="editor-callout">Down payment <b>${formatCompactMoney(loanDownPaymentAmount(block))}</b><span></span>Loan <b>${formatCompactMoney(loanPrincipal(block))}</b><span></span>Payment <b>${formatCompactMoney(loanMonthlyPayment(block))}/mo</b></div>`;
    editorDetail.querySelectorAll('[data-loan-field]').forEach(input => {
      input.addEventListener('change', () => {
        const field = input.dataset.loanField;
        if (field === 'description' || field === 'startMonth' || field === 'sourceAccountId') block[field] = input.value || null;
        else block[field] = (parseFloat(input.value) || 0) / (input.hasAttribute('data-percent') ? 100 : 1);
        if (field === 'annualRate' && state.accounts[block.debtAccountId]) state.accounts[block.debtAccountId].returnsSchedule.defaultAnnual = block.annualRate;
        renderBlockEditor();
      });
    });
  }

  function renderClipStudio(block) {
    const clips = block.amountSchedule.entries;
    const isIncome = block.category === 'income';
    editorState.clipIndex = Math.min(editorState.clipIndex, Math.max(0, clips.length - 1));
    const selected = clips[editorState.clipIndex];
    const totalMonths = Math.max(1, keyToIdx(clips.at(-1).to) - keyToIdx(clips[0].from) + 1);
    const pixelsPerMonth = 8;
    const timelineWidth = totalMonths * pixelsPerMonth;
    let elapsedMonths = 0;
    const events = [];
    const timeline = clips.map((clip, index) => {
      const months = keyToIdx(clip.to) - keyToIdx(clip.from) + 1;
      const width = months * pixelsPerMonth;
      const previous = clips[index - 1];
      const next = clips[index + 1];
      const isPaused = clip.annualAmount === 0;
      if (isPaused) {
        if (!previous && next) {
          events.push(`<button class="timeline-event timeline-event--start" style="left:${(elapsedMonths + months) * pixelsPerMonth}px" data-clip-index="${index + 1}" type="button" title="Start: ${next.from}"><strong>Start</strong><time>${next.from}</time></button>`);
        } else if (previous && !next) {
          events.push(`<button class="timeline-event timeline-event--end" style="left:${elapsedMonths * pixelsPerMonth}px" data-clip-index="${index - 1}" type="button" title="End: ${previous.to}"><strong>End</strong><time>${previous.to}</time></button>`);
        } else if (previous && next) {
          events.push(`<button class="timeline-event timeline-event--pause" style="left:${elapsedMonths * pixelsPerMonth}px" data-clip-index="${index}" type="button" title="Pause: ${clip.from}"><strong>Pause</strong><time>${clip.from}</time></button>`);
          events.push(`<button class="timeline-event timeline-event--start" style="left:${(elapsedMonths + months) * pixelsPerMonth}px" data-clip-index="${index + 1}" type="button" title="Start: ${next.from}"><strong>Start</strong><time>${next.from}</time></button>`);
        }
        elapsedMonths += months;
        return `<button class="clip-gap ${index === editorState.clipIndex ? 'selected' : ''}" style="width:${width}px" data-clip-index="${index}" type="button" aria-label="No amount from ${clip.from} to ${clip.to}" title="No amount: ${clip.from} to ${clip.to}"></button>`;
      }
      if (!previous) {
        events.push(`<button class="timeline-event timeline-event--start timeline-event--edge-start" style="left:${elapsedMonths * pixelsPerMonth}px" data-clip-index="${index}" type="button" title="Start: ${clip.from}"><strong>Start</strong><time>${clip.from}</time></button>`);
      }
      if (!next) {
        events.push(`<button class="timeline-event timeline-event--end timeline-event--edge-end" style="left:${(elapsedMonths + months) * pixelsPerMonth}px" data-clip-index="${index}" type="button" title="End: ${clip.to}"><strong>End</strong><time>${clip.to}</time></button>`);
      }
      elapsedMonths += months;
      return `<button class="clip ${index === editorState.clipIndex ? 'selected' : ''} clip-color-${index % 5}" style="width:${width}px" data-clip-index="${index}" type="button" title="${escapeHtml(clip.name)}: ${clip.from} to ${clip.to}">
        <strong>${escapeHtml(clip.name)}</strong>
        <span class="clip-dates"><span><b>From</b><time>${clip.from}</time></span><span><b>To</b><time>${clip.to}</time></span></span>
        <small>${formatCompactMoney(clip.annualAmount)}/yr</small>
      </button>`;
    }).join('');

    const splitDefault = selected && selected.from !== selected.to ? nextMonthKey(selected.from) : selected?.from;
    editorDetail.innerHTML = `
      <div class="detail-heading">
        <div><p class="eyebrow">Timeline mode</p><h3>${escapeHtml(block.description)}</h3></div>
        <button id="useSimpleAmount" class="secondary" type="button">Use simple amount</button>
      </div>
      <section class="timeline-studio" aria-label="Amount schedule timeline">
        <div class="timeline-toolbar"><div><strong>Schedule clips</strong><p>Start, Pause, and End markers represent $0 periods. Select any clip or marker to edit it.</p></div><span>${clips[0]?.from} → ${clips.at(-1)?.to}</span></div>
        <div class="timeline-scroll">
          <div class="clip-track" style="width:${timelineWidth}px"><div class="timeline-events">${events.join('')}</div><div class="clip-segments">${timeline}</div></div>
          <div class="timeline-ruler" style="width:${timelineWidth}px"><span>${clips[0]?.from}</span><span>simulation timeline</span><span>${clips.at(-1)?.to}</span></div>
        </div>
      </section>
      <section class="editor-section clip-flow-settings">
        <div class="section-title"><strong>Cash-flow settings</strong><span>These settings apply to every clip on this timeline</span></div>
        <div class="editor-form-grid">
          <label>Cash-flow name <input id="clipFlowName" value="${escapeHtml(block.description)}"/></label>
          <label>Uncertainty σ % <input id="clipFlowSigma" type="number" step="0.1" value="${pct(block.sigma)}"/></label>
          ${isIncome
            ? `<label>Target account <select id="clipFlowAccount">${accountOptions(block.targetAccountId, account => account.type !== 'debt')}</select></label><label class="editor-check"><input id="clipFlowPretax" type="checkbox" ${block.preTax ? 'checked' : ''}/> Pre-tax income</label>`
            : `<label>Paid from <select id="clipFlowAccount">${accountOptions(block.sourceAccountId, account => account.type !== 'debt')}</select></label><label>Pay down debt <select id="clipFlowDebt">${accountOptions(block.debtAccountId, account => account.type === 'debt')}</select></label>`}
          <label class="editor-check"><input id="clipFlowInflation" type="checkbox" ${block.inflationAdjusted !== false ? 'checked' : ''}/> Escalate with inflation</label>
        </div>
      </section>
      ${selected ? `
      <section class="clip-inspector">
        <div class="clip-inspector-heading"><div><span class="clip-swatch clip-color-${editorState.clipIndex % 5}"></span><strong>Edit clip ${editorState.clipIndex + 1}</strong></div><span>${selected.from} → ${selected.to}</span></div>
        <div class="editor-form-grid">
          <label>Clip name <input id="clipName" value="${escapeHtml(selected.name)}"/></label>
          <label>Annual amount $ <input id="clipAmount" type="number" value="${selected.annualAmount}"/></label>
          <label>Starts <input value="${selected.from}" disabled/></label>
          <label>Ends <input value="${selected.to}" disabled/></label>
        </div>
        <div class="splice-panel">
          <div><strong>Splice clip</strong><p>Create a new clip beginning at this month. Both sides keep the current settings until edited.</p></div>
          <label>Cut at <input id="spliceMonth" type="month" min="${nextMonthKey(selected.from)}" max="${selected.to}" value="${splitDefault}" ${selected.from === selected.to ? 'disabled' : ''}/></label>
          <button id="spliceClip" type="button" ${selected.from === selected.to ? 'disabled' : ''}>✂ Splice</button>
          <button id="pauseClip" class="secondary" type="button">Pause</button>
        </div>
      </section>` : ''}`;

    const timelineScroll = editorDetail.querySelector('.timeline-scroll');
    timelineScroll.scrollLeft = editorState.timelineScrollLeft;
    timelineScroll.addEventListener('scroll', () => { editorState.timelineScrollLeft = timelineScroll.scrollLeft; }, { passive: true });
    editorDetail.querySelectorAll('[data-clip-index]').forEach(button => {
      button.addEventListener('click', () => {
        editorState.timelineScrollLeft = timelineScroll.scrollLeft;
        editorState.clipIndex = Number(button.dataset.clipIndex);
        renderBlockEditor();
      });
    });
    document.getElementById('useSimpleAmount').addEventListener('click', () => {
      const active = block.amountSchedule.entries.find(clip => clip.annualAmount !== 0) || block.amountSchedule.entries[0];
      block.amount = active?.annualAmount || 0;
      block.useCustomSchedule = false;
      renderBlockEditor();
    });
    document.getElementById('clipFlowName').addEventListener('change', event => { block.description = event.target.value; renderBlockEditor(); });
    document.getElementById('clipFlowSigma').addEventListener('change', event => { block.sigma = parseFloat(event.target.value || 0) / 100; });
    document.getElementById('clipFlowAccount').addEventListener('change', event => { if (isIncome) block.targetAccountId = event.target.value || null; else block.sourceAccountId = event.target.value || null; });
    document.getElementById('clipFlowPretax')?.addEventListener('change', event => { block.preTax = event.target.checked; });
    document.getElementById('clipFlowDebt')?.addEventListener('change', event => { block.debtAccountId = event.target.value || null; });
    document.getElementById('clipFlowInflation').addEventListener('change', event => { block.inflationAdjusted = event.target.checked; });
    if (!selected) return;
    document.getElementById('clipName').addEventListener('change', event => { selected.name = event.target.value.trim() || `Clip ${editorState.clipIndex + 1}`; renderBlockEditor(); });
    document.getElementById('clipAmount').addEventListener('change', event => { selected.annualAmount = parseFloat(event.target.value || 0); renderBlockEditor(); });
    document.getElementById('spliceClip').addEventListener('click', () => {
      if (spliceScheduleClip(clips, editorState.clipIndex, document.getElementById('spliceMonth').value)) {
        editorState.clipIndex += 1;
        renderBlockEditor();
      }
    });
    document.getElementById('pauseClip').addEventListener('click', () => { selected.annualAmount = 0; selected.name = 'Paused'; renderBlockEditor(); });
  }

  function renderRegularBlockEditor(block) {
    const isIncome = block.category === 'income';
    editorDetail.innerHTML = `
      <div class="detail-heading"><div><p class="eyebrow">${isIncome ? 'Income' : 'Expense'}</p><h3>${escapeHtml(block.description)}</h3></div></div>
      <section class="editor-section">
        <div class="section-title"><strong>Details</strong><span>Set the basic cash-flow behavior</span></div>
        <div class="editor-form-grid">
          <label>Name <input id="editBlockName" value="${escapeHtml(block.description)}"/></label>
          <label>Type <select id="editBlockKind"><option value="continuous" ${block.kind === 'continuous' ? 'selected' : ''}>Recurring</option><option value="one-time" ${block.kind === 'one-time' ? 'selected' : ''}>One-time</option></select></label>
          <label>${block.kind === 'one-time' ? 'Amount $' : 'Annual amount $'} <input id="editBlockAmount" type="number" value="${block.amount}" ${block.useCustomSchedule ? 'disabled' : ''}/></label>
          <label>Uncertainty σ % <input id="editBlockSigma" type="number" step="0.1" value="${pct(block.sigma)}"/></label>
          ${block.kind === 'one-time' ? `<label>Month <input id="editBlockStart" type="month" value="${block.startMonth || ''}"/></label>` : ''}
          ${isIncome
            ? `<label>Target account <select id="editBlockAccount">${accountOptions(block.targetAccountId, account => account.type !== 'debt')}</select></label><label class="editor-check"><input id="editBlockPretax" type="checkbox" ${block.preTax ? 'checked' : ''}/> Pre-tax income</label>`
            : `<label>Paid from <select id="editBlockAccount">${accountOptions(block.sourceAccountId, account => account.type !== 'debt')}</select></label><label>Pay down debt <select id="editBlockDebt">${accountOptions(block.debtAccountId, account => account.type === 'debt')}</select></label>`}
          <label class="editor-check"><input id="editBlockInflation" type="checkbox" ${block.inflationAdjusted !== false ? 'checked' : ''}/> Escalate with inflation</label>
        </div>
      </section>
      ${block.kind === 'continuous' ? `<section class="schedule-choice"><div><strong>${block.useCustomSchedule ? 'Clip schedule enabled' : 'Simple recurring amount'}</strong><p>${block.useCustomSchedule ? 'Edit named periods on the timeline below.' : 'Turn this into a timeline to vary it throughout the simulation.'}</p></div><button id="toggleClipSchedule" class="${block.useCustomSchedule ? 'secondary' : ''}" type="button">${block.useCustomSchedule ? 'Open clips' : 'Create clip timeline'}</button></section>` : ''}`;

    document.getElementById('editBlockName').addEventListener('change', event => { block.description = event.target.value; renderBlockEditor(); });
    document.getElementById('editBlockKind').addEventListener('change', event => { block.kind = event.target.value; if (block.kind === 'one-time') block.useCustomSchedule = false; renderBlockEditor(); });
    document.getElementById('editBlockAmount').addEventListener('change', event => { block.amount = parseFloat(event.target.value || 0); renderEditorList(); });
    document.getElementById('editBlockSigma').addEventListener('change', event => { block.sigma = parseFloat(event.target.value || 0) / 100; });
    document.getElementById('editBlockStart')?.addEventListener('change', event => { block.startMonth = event.target.value; });
    document.getElementById('editBlockAccount').addEventListener('change', event => { if (isIncome) block.targetAccountId = event.target.value || null; else block.sourceAccountId = event.target.value || null; });
    document.getElementById('editBlockPretax')?.addEventListener('change', event => { block.preTax = event.target.checked; });
    document.getElementById('editBlockDebt')?.addEventListener('change', event => { block.debtAccountId = event.target.value || null; });
    document.getElementById('editBlockInflation').addEventListener('change', event => { block.inflationAdjusted = event.target.checked; });
    if (block.kind !== 'continuous') return;
    document.getElementById('toggleClipSchedule').addEventListener('click', () => {
      if (!block.useCustomSchedule) canonicalizeBlockSchedule(block);
      renderBlockEditor();
    });
    if (block.useCustomSchedule) renderClipStudio(block);
  }

  function renderBlockEditor() {
    const block = editorBlockById();
    renderEditorList();
    if (!block) {
      editorDetail.innerHTML = '<div class="editor-empty"><span>✦</span><h3>Select a cash flow</h3><p>Choose an income or expense from the left to edit its details.</p></div>';
      return;
    }
    if (block.kind === 'loan') renderLoanEditor(block);
    else renderRegularBlockEditor(block);
  }

  function openBlockEditor(blockId) {
    editorState.blockId = blockId;
    editorState.clipIndex = 0;
    const block = editorBlockById();
    if (block?.useCustomSchedule) canonicalizeBlockSchedule(block);
    renderBlockEditor();
    blockEditor.showModal();
  }

  function closeBlockEditor() {
    blockEditor.close();
    renderBlocks();
  }

  document.getElementById('closeBlockEditor').addEventListener('click', closeBlockEditor);
  document.getElementById('editorAddIncome').addEventListener('click', () => addEditorBlock('income'));
  document.getElementById('editorAddExpense').addEventListener('click', () => addEditorBlock('expense'));
  blockEditor.addEventListener('click', event => { if (event.target === blockEditor) closeBlockEditor(); });
  blockEditor.addEventListener('close', () => renderBlocks());

  function renderSegmentRows(entries, container, onChange) {
    container.innerHTML = '';
    entries.forEach((seg, idx) => {
      const row = document.createElement('div'); row.className = 'segment';
      row.innerHTML = `
        <div class="row">
          <label>From (YYYY-MM) <input type="text" class="seg-from" value="${seg.from}" placeholder="2026-04"/></label>
          <label>To (YYYY-MM) <input type="text" class="seg-to" value="${seg.to}" placeholder="2026-12"/></label>
        </div>
        <div class="row">
          <label>Annual % <input type="number" step="0.1" class="seg-annual" value="${pct(seg.annual)}"/></label>
          <label>σ % <input type="number" step="0.1" class="seg-sigma" value="${pct(seg.sigma)}"/></label>
          <button class="remove seg-remove" type="button">remove</button>
        </div>`;
      container.appendChild(row);
      row.querySelector('.seg-from').addEventListener('input', e => { seg.from = e.target.value; });
      row.querySelector('.seg-to').addEventListener('input', e => { seg.to = e.target.value; });
      row.querySelector('.seg-annual').addEventListener('input', e => { seg.annual = parseFloat(e.target.value || 0) / 100; });
      row.querySelector('.seg-sigma').addEventListener('input', e => { seg.sigma = parseFloat(e.target.value || 0) / 100; });
      row.querySelector('.seg-remove').addEventListener('click', () => { entries.splice(idx, 1); onChange(); });
    });
  }

  function renderGlobalSegments() {
    renderSegmentRows(state.globalReturnsSchedule.entries, segmentsDiv, renderGlobalSegments);
  }
  document.getElementById('addReturnSegment').addEventListener('click', () => {
    state.globalReturnsSchedule.entries.push({ from: todayMonth(), to: todayMonth(), annual: 0.06, sigma: 0.08 });
    renderGlobalSegments();
  });

  function renderMarketEvents() {
    marketEventsDiv.innerHTML = '';
    if (!state.marketEvents.length) {
      marketEventsDiv.innerHTML = '<div class="empty-inline">No rare events configured. Normal return volatility still applies.</div>';
      return;
    }
    state.marketEvents.forEach((event, index) => {
      const card = document.createElement('div');
      card.className = 'market-event';
      card.innerHTML = `
        <div class="card-header">
          <div class="card-title"><strong>${escapeHtml(event.name)}</strong><span>${pct(event.probability)}% chance · next ${event.triggerWindowMonths} months · ${event.durationMonths} month duration</span></div>
          <button class="remove event-remove" type="button">Remove</button>
        </div>
        <div class="event-grid">
          <label>Event name <input class="event-name" value="${escapeHtml(event.name)}"/></label>
          <label>Probability % <input class="event-probability" type="number" min="0" max="100" step="0.1" value="${pct(event.probability)}"/></label>
          <label>Can begin within next (months) <input class="event-window" type="number" min="1" step="1" value="${event.triggerWindowMonths}"/></label>
          <label>Duration (months) <input class="event-duration" type="number" min="1" step="1" value="${event.durationMonths}"/></label>
          <label>Annual return during event % <input class="event-return" type="number" step="0.1" value="${pct(event.annualReturn)}"/></label>
          <label>Volatility σ % <input class="event-sigma" type="number" min="0" step="0.1" value="${pct(event.sigma)}"/></label>
          <label>Applies to <select class="event-scope"><option value="investments" ${event.scope === 'investments' ? 'selected' : ''}>Investment accounts</option><option value="all" ${event.scope === 'all' ? 'selected' : ''}>All non-debt accounts</option></select></label>
        </div>`;
      marketEventsDiv.appendChild(card);
      const updateSummary = () => {
        card.querySelector('.card-title strong').textContent = event.name;
        card.querySelector('.card-title span').textContent = `${pct(event.probability)}% chance · next ${event.triggerWindowMonths} months · ${event.durationMonths} month duration`;
      };
      card.querySelector('.event-name').addEventListener('input', e => { event.name = e.target.value; updateSummary(); });
      card.querySelector('.event-probability').addEventListener('input', e => { event.probability = Math.min(1, Math.max(0, parseFloat(e.target.value || 0) / 100)); updateSummary(); });
      card.querySelector('.event-window').addEventListener('input', e => { event.triggerWindowMonths = Math.max(1, Math.round(parseFloat(e.target.value || 1))); updateSummary(); });
      card.querySelector('.event-duration').addEventListener('input', e => { event.durationMonths = Math.max(1, Math.round(parseFloat(e.target.value || 1))); updateSummary(); });
      card.querySelector('.event-return').addEventListener('input', e => { event.annualReturn = parseFloat(e.target.value || 0) / 100; });
      card.querySelector('.event-sigma').addEventListener('input', e => { event.sigma = Math.max(0, parseFloat(e.target.value || 0) / 100); });
      card.querySelector('.event-scope').addEventListener('change', e => { event.scope = e.target.value; });
      card.querySelector('.event-remove').addEventListener('click', () => { state.marketEvents.splice(index, 1); renderMarketEvents(); });
    });
  }

  document.getElementById('addMarketEvent').addEventListener('click', () => {
    state.marketEvents.push(createMarketEvent({
      name: 'AI bubble / geopolitical crash',
      probability: 0.15,
      triggerWindowMonths: 24,
      durationMonths: 12,
      annualReturn: -0.35,
      sigma: 0.25,
      scope: 'investments',
    }));
    renderMarketEvents();
  });

  function renderNavAccounts() {
    const navAccounts = document.getElementById('navAccounts');
    navAccounts.innerHTML = Object.values(state.accounts).map(acc => `
      <div class="nav-account ${acc.type === 'debt' ? 'nav-account--debt' : ''}">
        <span class="nav-account-name">${escapeHtml(acc.name)}</span>
        <span class="nav-account-value">${formatCompactMoney(acc.balance)}</span>
      </div>`).join('');
  }

  /** Keeps `state.withdrawalOrder` in sync with the current non-debt accounts
   *  (auto-appending newly added accounts, dropping removed ones) and renders
   *  the reorderable "Retirement Withdrawal Order" list. */
  function renderWithdrawalOrder() {
    const eligibleIds = Object.values(state.accounts).filter(a => a.type !== 'debt').map(a => a.id);
    state.withdrawalOrder = (state.withdrawalOrder || []).filter(id => eligibleIds.includes(id));
    for (const id of eligibleIds) if (!state.withdrawalOrder.includes(id)) state.withdrawalOrder.push(id);

    withdrawalOrderDiv.innerHTML = '';
    if (state.withdrawalOrder.length === 0) {
      withdrawalOrderDiv.innerHTML = '<div class="empty-inline">Add a non-debt account to configure a withdrawal order.</div>';
      return;
    }
    state.withdrawalOrder.forEach((id, index) => {
      const acc = state.accounts[id];
      if (!acc) return;
      const row = document.createElement('div'); row.className = 'withdrawal-order-row';
      row.innerHTML = `
        <span class="withdrawal-order-index">${index + 1}</span>
        <span class="withdrawal-order-name">${escapeHtml(acc.name)}<small>${ACCOUNT_TYPE_LABELS[acc.type]}</small></span>
        <div class="withdrawal-order-actions">
          <button class="secondary wo-up" type="button" ${index === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(acc.name)} up">\u2191</button>
          <button class="secondary wo-down" type="button" ${index === state.withdrawalOrder.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(acc.name)} down">\u2193</button>
        </div>`;
      withdrawalOrderDiv.appendChild(row);
      row.querySelector('.wo-up').addEventListener('click', () => {
        if (index === 0) return;
        [state.withdrawalOrder[index - 1], state.withdrawalOrder[index]] = [state.withdrawalOrder[index], state.withdrawalOrder[index - 1]];
        renderWithdrawalOrder();
      });
      row.querySelector('.wo-down').addEventListener('click', () => {
        if (index === state.withdrawalOrder.length - 1) return;
        [state.withdrawalOrder[index + 1], state.withdrawalOrder[index]] = [state.withdrawalOrder[index], state.withdrawalOrder[index + 1]];
        renderWithdrawalOrder();
      });
    });
  }

  function renderAccounts(expandedId = null) {
    accountsDiv.innerHTML = '';
    for (const acc of Object.values(state.accounts)) {
      const el = document.createElement('div'); el.className = 'account';
      const isExpanded = acc.id === expandedId;
      el.innerHTML = `
        <div class="card-header">
          <div class="card-title">
            <strong>${acc.name}</strong>
            <span class="card-meta">${ACCOUNT_TYPE_LABELS[acc.type]} · ${formatCompactMoney(acc.balance)}</span>
          </div>
          <div class="card-actions">
            <button class="edit secondary" type="button" aria-expanded="${isExpanded}">${isExpanded ? 'Done' : 'Edit'}</button>
            <button class="remove" type="button">Remove</button>
          </div>
        </div>
        <div class="card-body" ${isExpanded ? '' : 'hidden'}>
        <div class="row">
          <label>Name <input type="text" class="acc-name" value="${acc.name}"/></label>
          <label>Type <select class="acc-type">${ACCOUNT_TYPES.map(t => `<option value="${t}" ${t === acc.type ? 'selected' : ''}>${ACCOUNT_TYPE_LABELS[t]}</option>`).join('')}</select></label>
        </div>
        <div class="row">
          <label>${acc.type === 'debt' ? 'Balance owed (enter negative)' : 'Balance $'} <input type="number" class="acc-balance" value="${acc.balance}"/></label>
          <label>Extra σ % (optional) <input type="number" step="0.1" class="acc-sigma" value="${pct(acc.sigma)}"/></label>
        </div>
        <label class="inline"><input type="checkbox" class="acc-custom" ${acc.useCustomReturns ? 'checked' : ''}/> Use a custom returns schedule for this account (e.g. debt APR)</label>
        <div class="acc-custom-schedule" style="display:${acc.useCustomReturns ? 'block' : 'none'}">
          <div class="row">
            <label>Default annual % <input type="number" step="0.1" class="acc-default-annual" value="${pct(acc.returnsSchedule.defaultAnnual)}"/></label>
            <label>Default σ % <input type="number" step="0.1" class="acc-default-sigma" value="${pct(acc.returnsSchedule.defaultSigma)}"/></label>
          </div>
          <div class="acc-segments"></div>
          <button class="acc-add-segment" type="button">+ Segment</button>
        </div>
        </div>`;
      accountsDiv.appendChild(el);

      const cardBody = el.querySelector('.card-body');
      const editButton = el.querySelector('.edit');
      editButton.addEventListener('click', () => {
        const willExpand = cardBody.hidden;
        cardBody.hidden = !willExpand;
        editButton.textContent = willExpand ? 'Done' : 'Edit';
        editButton.setAttribute('aria-expanded', String(willExpand));
      });
      el.querySelector('.remove').addEventListener('click', () => { delete state.accounts[acc.id]; renderAccounts(); renderBlocks(); });
      el.querySelector('.acc-name').addEventListener('input', e => { acc.name = e.target.value; el.querySelector('strong').textContent = acc.name; renderNavAccounts(); renderBlocks(); renderWithdrawalOrder(); });
      el.querySelector('.acc-type').addEventListener('change', e => { acc.type = e.target.value; renderAccounts(acc.id); renderBlocks(); });
      el.querySelector('.acc-balance').addEventListener('input', e => {
        acc.balance = parseFloat(e.target.value || 0);
        el.querySelector('.card-meta').textContent = `${ACCOUNT_TYPE_LABELS[acc.type]} · ${formatCompactMoney(acc.balance)}`;
        renderNavAccounts();
      });
      el.querySelector('.acc-sigma').addEventListener('input', e => { acc.sigma = parseFloat(e.target.value || 0) / 100; });

      const scheduleDiv = el.querySelector('.acc-custom-schedule');
      el.querySelector('.acc-custom').addEventListener('change', e => { acc.useCustomReturns = e.target.checked; scheduleDiv.style.display = acc.useCustomReturns ? 'block' : 'none'; });
      el.querySelector('.acc-default-annual').addEventListener('input', e => { acc.returnsSchedule.defaultAnnual = parseFloat(e.target.value || 0) / 100; });
      el.querySelector('.acc-default-sigma').addEventListener('input', e => { acc.returnsSchedule.defaultSigma = parseFloat(e.target.value || 0) / 100; });

      const accSegDiv = el.querySelector('.acc-segments');
      const rerenderAccSegs = () => renderSegmentRows(acc.returnsSchedule.entries, accSegDiv, rerenderAccSegs);
      rerenderAccSegs();
      el.querySelector('.acc-add-segment').addEventListener('click', () => {
        acc.returnsSchedule.entries.push({ from: todayMonth(), to: todayMonth(), annual: 0.06, sigma: 0.08 });
        rerenderAccSegs();
      });
    }

    renderNavAccounts();
    renderWithdrawalOrder();
  }

  /** Renders a horizontal "axis" showing each amount-schedule segment as a proportionally-sized bar, with gaps shown as $0. */
  function renderAmountTimeline(schedule, container) {
    container.innerHTML = '';
    const entries = schedule.entries;
    if (entries.length === 0) {
      container.innerHTML = '<div class="small">No segments</div>';
      return;
    }
    // Collapse to the *effective* (last-match-wins) value per contiguous range so the
    // visualization matches what the simulation will actually use, not raw entry order.
    const starts = new Set();
    for (const e of entries) { starts.add(keyToIdx(e.from)); starts.add(keyToIdx(e.to) + 1); }
    const sortedIdx = [...starts].sort((a, b) => a - b);
    const minIdx = sortedIdx[0];
    const maxIdxRaw = sortedIdx[sortedIdx.length - 1];
    const maxIdx = Math.min(maxIdxRaw, minIdx + 12 * 80); // cap visualization width at 80 years so "9999-12" tails don't blow up the scale
    const span = Math.max(1, maxIdx - minIdx);

    const bar = document.createElement('div'); bar.className = 'timeline-bar';
    for (let i = 0; i < sortedIdx.length - 1; i++) {
      const segStart = sortedIdx[i];
      const segEnd = Math.min(sortedIdx[i + 1], maxIdx);
      if (segStart >= maxIdx) break;
      const mid = new Date(Math.floor(segStart / 12), segStart % 12, 1);
      const amount = schedule.getAnnualAmountFor(mid);
      const widthPct = Math.max(0.5, ((segEnd - segStart) / span) * 100);
      const segEl = document.createElement('div');
      segEl.className = 'timeline-seg' + (amount === 0 ? ' zero' : amount < 0 ? ' negative' : '');
      segEl.style.width = widthPct + '%';
      segEl.textContent = Math.abs(amount) >= 1000 ? `$${Math.round(amount / 1000)}k` : `$${Math.round(amount)}`;
      segEl.title = `${idxToKey(segStart)} → ${idxToKey(segEnd - 1)}: $${Math.round(amount).toLocaleString()}/yr`;
      bar.appendChild(segEl);
    }
    container.appendChild(bar);
  }

  function renderAmountSegmentRows(block, container, updateTimeline) {
    container.innerHTML = '';
    block.amountSchedule.entries.forEach((seg, idx) => {
      const row = document.createElement('div'); row.className = 'segment';
      row.innerHTML = `
        <div class="row">
          <label>From (YYYY-MM) <input type="month" class="aseg-from" value="${seg.from}"/></label>
          <label>To (YYYY-MM, or 9999-12 for "forever") <input type="text" class="aseg-to" value="${seg.to}" placeholder="9999-12"/></label>
        </div>
        <div class="row">
          <label>Annual amount $ <input type="number" class="aseg-amount" value="${seg.annualAmount}"/></label>
          <button class="remove aseg-remove" type="button">remove</button>
        </div>`;
      container.appendChild(row);
      row.querySelector('.aseg-from').addEventListener('input', e => { seg.from = e.target.value; updateTimeline(); });
      row.querySelector('.aseg-to').addEventListener('input', e => { seg.to = e.target.value; updateTimeline(); });
      row.querySelector('.aseg-amount').addEventListener('input', e => { seg.annualAmount = parseFloat(e.target.value || 0); updateTimeline(); });
      row.querySelector('.aseg-remove').addEventListener('click', () => {
        block.amountSchedule.entries.splice(idx, 1);
        renderAmountSegmentRows(block, container, updateTimeline);
        updateTimeline();
      });
    });
  }

  function renderBlockScheduleEditor(block, container, timelineContainer) {
    renderAmountTimeline(block.amountSchedule, timelineContainer);
    renderAmountSegmentRows(block, container, () => renderAmountTimeline(block.amountSchedule, timelineContainer));
  }

  /** Renders a financed-purchase ("loan") block: down payment + amortizing mortgage against its linked debt account. */
  function renderLoanCard(b, idx, expandedIndex) {
    const el = document.createElement('div'); el.className = 'block';
    const isExpanded = idx === expandedIndex;
    const downPayment = loanDownPaymentAmount(b);
    const principal = loanPrincipal(b);
    const payment = loanMonthlyPayment(b);
    el.innerHTML = `
      <div class="card-header">
        <div class="card-title">
          <strong>${b.description || 'Financed purchase'}</strong>
          <span class="card-meta">Loan · ${formatCompactMoney(b.purchasePrice)} @ ${(b.annualRate * 100).toFixed(2)}%</span>
        </div>
        <div class="card-actions">
          <button class="edit secondary" type="button" aria-expanded="${isExpanded}">${isExpanded ? 'Done' : 'Edit'}</button>
          <button class="remove" type="button">Remove</button>
        </div>
      </div>
      <div class="card-body" ${isExpanded ? '' : 'hidden'}>
        <div class="row">
          <label>Description <input type="text" class="ln-desc" value="${b.description}"/></label>
          <label>Purchase month <input type="month" class="ln-start" value="${b.startMonth || ''}"/></label>
        </div>
        <div class="row">
          <label>Purchase price $ <input type="number" class="ln-price" value="${b.purchasePrice}"/></label>
          <label>Down payment % <input type="number" step="1" class="ln-down" value="${(b.downPaymentPct * 100).toFixed(0)}"/></label>
        </div>
        <div class="row">
          <label>Mortgage rate % (annual) <input type="number" step="0.05" class="ln-rate" value="${(b.annualRate * 100).toFixed(2)}"/></label>
          <label>Term (years) <input type="number" class="ln-term" value="${b.termYears}"/></label>
        </div>
        <div class="row">
          <label>Paid from <select class="ln-source">${accountOptions(b.sourceAccountId, a => a.type !== 'debt')}</select></label>
        </div>
        <div class="result small">
          Down payment: <b>${formatCompactMoney(downPayment)}</b> ·
          Loan amount: <b>${formatCompactMoney(principal)}</b> ·
          Monthly P&amp;I: <b>${formatCompactMoney(payment)}</b>/mo for ${b.termYears}y
        </div>
      </div>`;
    blocksDiv.appendChild(el);

    const cardBody = el.querySelector('.card-body');
    const editButton = el.querySelector('.edit');
    editButton.addEventListener('click', () => openBlockEditor(b.id));
    el.querySelector('.remove').addEventListener('click', () => {
      if (!confirm(`Remove "${b.description}" and its linked loan account? This can't be undone.`)) return;
      if (b.debtAccountId) delete state.accounts[b.debtAccountId];
      state.blocks.splice(idx, 1);
      renderAccounts();
      renderBlocks();
    });
    el.querySelector('.ln-desc').addEventListener('input', e => {
      b.description = e.target.value;
      el.querySelector('.card-title strong').textContent = b.description || 'Financed purchase';
      const debtAcc = state.accounts[b.debtAccountId];
      if (debtAcc) debtAcc.name = `${b.description} loan`;
    });
    el.querySelector('.ln-start').addEventListener('input', e => { b.startMonth = e.target.value; });
    el.querySelector('.ln-price').addEventListener('input', e => { b.purchasePrice = parseFloat(e.target.value || 0); renderBlocks(idx); });
    el.querySelector('.ln-down').addEventListener('input', e => { b.downPaymentPct = parseFloat(e.target.value || 0) / 100; renderBlocks(idx); });
    el.querySelector('.ln-rate').addEventListener('input', e => {
      b.annualRate = parseFloat(e.target.value || 0) / 100;
      const debtAcc = state.accounts[b.debtAccountId];
      if (debtAcc) debtAcc.returnsSchedule.defaultAnnual = b.annualRate;
      renderBlocks(idx);
    });
    el.querySelector('.ln-term').addEventListener('input', e => { b.termYears = parseFloat(e.target.value || 30); renderBlocks(idx); });
    el.querySelector('.ln-source').addEventListener('change', e => { b.sourceAccountId = e.target.value || null; });
  }

  function renderBlocks(expandedIndex = null) {
    blocksDiv.innerHTML = '';
    state.blocks.forEach((b, idx) => {
      if (b.kind === 'loan') { renderLoanCard(b, idx, expandedIndex); return; }
      const el = document.createElement('div'); el.className = 'block';
      const isIncome = b.category === 'income';
      const showSchedule = b.kind === 'continuous' && b.useCustomSchedule;
      const isExpanded = idx === expandedIndex;
      el.innerHTML = `
        <div class="card-header">
          <div class="card-title">
            <strong>${b.description || (isIncome ? 'Income' : 'Expense')}</strong>
            <span class="card-meta">${isIncome ? 'Income' : 'Expense'} · ${formatCompactMoney(b.amount)}/${b.kind === 'continuous' ? 'yr' : 'once'}</span>
          </div>
          <div class="card-actions">
            <button class="edit secondary" type="button" aria-expanded="${isExpanded}">${isExpanded ? 'Done' : 'Edit'}</button>
            <button class="remove" type="button">Remove</button>
          </div>
        </div>
        <div class="card-body" ${isExpanded ? '' : 'hidden'}>
        <div class="row">
          <label>Description <input type="text" class="b-desc" value="${b.description}"/></label>
          <label>Kind <select class="b-kind">
            <option value="continuous" ${b.kind === 'continuous' ? 'selected' : ''}>Continuous (monthly)</option>
            <option value="one-time" ${b.kind === 'one-time' ? 'selected' : ''}>One-time</option>
          </select></label>
        </div>
        ${b.kind === 'continuous' ? `
        <label class="inline"><input type="checkbox" class="b-custom-schedule" ${b.useCustomSchedule ? 'checked' : ''}/> Vary the amount over time (custom schedule)</label>
        ` : ''}
        <div class="b-flat-fields" style="display:${showSchedule ? 'none' : 'block'}">
          <div class="row">
            <label>${b.kind === 'one-time' ? 'Amount $' : 'Annual amount $'} <input type="number" class="b-amount" value="${b.amount}"/></label>
            <label>σ % (optional) <input type="number" step="0.1" class="b-sigma" value="${pct(b.sigma)}"/></label>
          </div>
          <div class="row">
            <label>Start month <input type="month" class="b-start" value="${b.startMonth || ''}"/></label>
            <label>End month (blank = ongoing) <input type="month" class="b-end" value="${b.endMonth || ''}"/></label>
          </div>
        </div>
        <div class="b-schedule-fields" style="display:${showSchedule ? 'block' : 'none'}">
          <div class="b-timeline"></div>
          <div class="b-schedule-rows"></div>
          <div class="row">
            <button class="b-add-segment" type="button">+ Segment</button>
            <label>σ % (optional, applies to all segments) <input type="number" step="0.1" class="b-schedule-sigma" value="${pct(b.sigma)}"/></label>
          </div>
        </div>
        <div class="row">
          ${isIncome ? `
            <label>Target account <select class="b-target">${accountOptions(b.targetAccountId, a => a.type !== 'debt')}</select></label>
            <label class="inline"><input type="checkbox" class="b-pretax" ${b.preTax ? 'checked' : ''}/> Pre-tax (gross pay)</label>
          ` : `
            <label>Paid from <select class="b-source">${accountOptions(b.sourceAccountId, a => a.type !== 'debt')}</select></label>
            <label>Pay down debt (optional) <select class="b-debt">${accountOptions(b.debtAccountId, a => a.type === 'debt')}</select></label>
          `}
        </div>
        </div>`;
      blocksDiv.appendChild(el);

      const cardBody = el.querySelector('.card-body');
      const editButton = el.querySelector('.edit');
      editButton.addEventListener('click', () => openBlockEditor(b.id));
      el.querySelector('.remove').addEventListener('click', () => { state.blocks.splice(idx, 1); renderBlocks(); });
      el.querySelector('.b-desc').addEventListener('input', e => { b.description = e.target.value; el.querySelector('.card-title strong').textContent = b.description || (isIncome ? 'Income' : 'Expense'); });
      el.querySelector('.b-kind').addEventListener('change', e => { b.kind = e.target.value; renderBlocks(idx); });
      el.querySelector('.b-amount')?.addEventListener('input', e => {
        b.amount = parseFloat(e.target.value || 0);
        el.querySelector('.card-meta').textContent = `${isIncome ? 'Income' : 'Expense'} · ${formatCompactMoney(b.amount)}/${b.kind === 'continuous' ? 'yr' : 'once'}`;
      });
      el.querySelector('.b-sigma')?.addEventListener('input', e => { b.sigma = parseFloat(e.target.value || 0) / 100; });
      el.querySelector('.b-start')?.addEventListener('input', e => { b.startMonth = e.target.value; });
      el.querySelector('.b-end')?.addEventListener('input', e => { b.endMonth = e.target.value || null; });
      el.querySelector('.b-schedule-sigma')?.addEventListener('input', e => { b.sigma = parseFloat(e.target.value || 0) / 100; });

      const customScheduleCheckbox = el.querySelector('.b-custom-schedule');
      if (customScheduleCheckbox) {
        customScheduleCheckbox.addEventListener('change', e => {
          b.useCustomSchedule = e.target.checked;
          if (b.useCustomSchedule && b.amountSchedule.entries.length === 0) {
            b.amountSchedule.entries.push({ from: b.startMonth || todayMonth(), to: '9999-12', annualAmount: b.amount });
          }
          renderBlocks(idx);
        });
      }

      if (showSchedule) {
        const timelineDiv = el.querySelector('.b-timeline');
        const rowsDiv = el.querySelector('.b-schedule-rows');
        renderBlockScheduleEditor(b, rowsDiv, timelineDiv);
        el.querySelector('.b-add-segment').addEventListener('click', () => {
          const entries = b.amountSchedule.entries;
          const last = entries[entries.length - 1];
          const from = last && last.to !== '9999-12' ? nextMonthKey(last.to) : todayMonth();
          entries.push({ from, to: '9999-12', annualAmount: last ? last.annualAmount : b.amount });
          renderBlockScheduleEditor(b, rowsDiv, timelineDiv);
        });
      }

      if (isIncome) {
        el.querySelector('.b-target').addEventListener('change', e => { b.targetAccountId = e.target.value || null; });
        el.querySelector('.b-pretax').addEventListener('change', e => { b.preTax = e.target.checked; });
      } else {
        el.querySelector('.b-source').addEventListener('change', e => { b.sourceAccountId = e.target.value || null; });
        el.querySelector('.b-debt').addEventListener('change', e => { b.debtAccountId = e.target.value || null; });
      }
    });
  }


  document.getElementById('addAccount').addEventListener('click', () => {
    const id = nextAccountId();
    state.accounts[id] = new Account({ id, name: 'New Account', type: 'checking', balance: 0 });
    renderAccounts(id); renderBlocks();
  });

  document.getElementById('addIncome').addEventListener('click', () => {
    const checking = Object.values(state.accounts).find(a => a.type === 'checking');
    state.blocks.push(createBlock({ category: 'income', kind: 'continuous', description: 'New income', amount: 50000, startMonth: todayMonth(), preTax: true, targetAccountId: checking?.id }));
    renderBlocks();
    openBlockEditor(state.blocks.at(-1).id);
  });
  document.getElementById('addExpense').addEventListener('click', () => {
    const checking = Object.values(state.accounts).find(a => a.type === 'checking');
    state.blocks.push(createBlock({ category: 'expense', kind: 'continuous', description: 'New expense', amount: 12000, startMonth: todayMonth(), sourceAccountId: checking?.id }));
    renderBlocks();
    openBlockEditor(state.blocks.at(-1).id);
  });

  document.getElementById('addLoan').addEventListener('click', () => {
    const checking = Object.values(state.accounts).find(a => a.type === 'checking');
    const debtId = nextAccountId();
    state.accounts[debtId] = new Account({
      id: debtId, name: 'Home loan', type: 'debt', balance: 0,
      useCustomReturns: true, returnsSchedule: new ReturnsSchedule([], { defaultAnnual: 0.0675, defaultSigma: 0 }),
    });
    state.blocks.push(createLoanBlock({
      description: 'Home purchase', startMonth: todayMonth(),
      purchasePrice: 800000, downPaymentPct: 0.2, annualRate: 0.0675, termYears: 30,
      sourceAccountId: checking?.id, debtAccountId: debtId,
    }));
    renderAccounts();
    renderBlocks();
    openBlockEditor(state.blocks.at(-1).id);
  });

  document.getElementById('computeAfford').addEventListener('click', () => {
    const res = maxHomePrice({
      grossMonthlyIncome: parseFloat(document.getElementById('affIncome').value || 0),
      existingMonthlyDebt: parseFloat(document.getElementById('affDebt').value || 0),
      downPaymentAmount: parseFloat(document.getElementById('affDown').value || 0),
      annualRate: parseFloat(document.getElementById('affRate').value || 0) / 100,
      termYears: parseFloat(document.getElementById('affTerm').value || 30),
      propertyTaxRate: parseFloat(document.getElementById('affTax').value || 0) / 100,
      annualInsurance: parseFloat(document.getElementById('affIns').value || 0),
      monthlyHOA: parseFloat(document.getElementById('affHOA').value || 0),
    });
    document.getElementById('affordResult').innerHTML = `
      <div>Max home price: <b>$${Math.round(res.maxPrice).toLocaleString()}</b></div>
      <div>Loan amount: $${Math.round(res.loanAmount).toLocaleString()}</div>
      <div>Monthly principal &amp; interest: $${Math.round(res.monthlyPI).toLocaleString()}</div>
      <div>Total monthly carrying cost (PITI+HOA): $${Math.round(res.monthlyCarrying).toLocaleString()}</div>`;
  });

  function loadStateAndSettings(data) {
    state.accounts = data.state.accounts;
    state.blocks = data.state.blocks;
    state.globalReturnsSchedule = data.state.globalReturnsSchedule;
    state.marketEvents = data.state.marketEvents || [];
    state.withdrawalOrder = data.state.withdrawalOrder || [];
    applySettings(data.settings);
    scenarioNotesInput.value = data.notes || '';
    defaultAnnualInput.value = pct(state.globalReturnsSchedule.defaultAnnual);
    defaultSigmaInput.value = pct(state.globalReturnsSchedule.defaultSigma);
    renderAccounts();
    renderBlocks();
    renderGlobalSegments();
    renderMarketEvents();
  }

  function applyImportedScenario(data, sourceLabel) {
    loadStateAndSettings(data);
    scenarioNameInput.value = data.name;
    saveAutosave(gatherSettings(), state, scenarioNotesInput.value);
    scenarioStatus.textContent = `Loaded "${sourceLabel}".`;
  }

  document.getElementById('exportScenario').addEventListener('click', () => {
    const name = scenarioNameInput.value.trim() || 'Untitled scenario';
    const payload = createScenarioExport(name, gatherSettings(), state, scenarioNotesInput.value);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFilename(name)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    scenarioStatus.textContent = `Exported "${name}" as JSON.`;
  });

  document.getElementById('loadScenario').addEventListener('click', () => {
    scenarioFileInput.click();
  });

  scenarioFileInput.addEventListener('change', async () => {
    const file = scenarioFileInput.files?.[0];
    if (!file) return;
    try {
      const data = reviveScenarioExport(JSON.parse(await file.text()));
      applyImportedScenario(data, file.name);
    } catch (error) {
      scenarioStatus.textContent = error instanceof SyntaxError ? 'The selected file is not valid JSON.' : error.message;
    } finally {
      scenarioFileInput.value = '';
    }
  });

  document.getElementById('loadExampleScenario').addEventListener('click', async () => {
    scenarioStatus.textContent = 'Loading me.example.json…';
    try {
      const response = await fetch('./me.example.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load me.example.json (${response.status}).`);
      applyImportedScenario(reviveScenarioExport(await response.json()), 'me.example.json');
    } catch (error) {
      scenarioStatus.textContent = error instanceof SyntaxError ? 'me.example.json is not valid JSON.' : error.message;
    }
  });

  document.getElementById('resetToBase').addEventListener('click', () => {
    // Clears the autosaved working session so the next load falls back to
    // `me.json` (if present) or the generic base scenario. This is the fix
    // for "my starting balances look stale" — the autosaved session always
    // takes priority over the base scenario, so updates to the base/me.json
    // numbers are otherwise invisible once a session has been autosaved.
    if (!confirm('Discard your current working session and reload the base scenario?')) return;
    clearAutosave();
    location.reload();
  });

  renderAccounts();
  renderBlocks();
  renderGlobalSegments();
  renderMarketEvents();

  // Continuously autosave the working session (debounced) so a page reload
  // doesn't lose in-progress edits, independent of the explicit named scenarios.
  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveAutosave(gatherSettings(), state, scenarioNotesInput.value), 400);
  }
  document.addEventListener('input', scheduleAutosave);
  document.addEventListener('change', scheduleAutosave);
  document.addEventListener('click', scheduleAutosave); // covers add/remove buttons (no input/change event)

  return { getCity: () => citySelect.value };
}

