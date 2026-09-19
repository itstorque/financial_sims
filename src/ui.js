// Renders and wires up all editable forms: accounts, income/expense blocks,
// the global returns schedule, and the house-affordability calculator.
// State objects (Account, block plain-objects, ReturnsSchedule) are mutated
// in place by input listeners so `app.js` can read `state` directly at
// "Run Simulation" time.

import { Account, ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, defaultAccounts, nextAccountId } from './accounts.js';
import { createBlock } from './blocks.js';
import { defaultReturnsSchedule } from './returnsSchedule.js';
import { cities } from './taxes.js';
import { maxHomePrice } from './affordability.js';

function todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function pct(v) { return ((v || 0) * 100).toFixed(1); }

export function initUI(state) {
  state.accounts = state.accounts || defaultAccounts();
  state.blocks = state.blocks || [];
  state.globalReturnsSchedule = state.globalReturnsSchedule || defaultReturnsSchedule();

  if (state.blocks.length === 0) {
    const checking = Object.values(state.accounts).find(a => a.type === 'checking');
    const retirement = Object.values(state.accounts).find(a => a.type === 'retirement');
    state.blocks.push(createBlock({ category: 'income', kind: 'continuous', description: 'Salary', amount: 95000, startMonth: todayMonth(), preTax: true, targetAccountId: checking?.id }));
    state.blocks.push(createBlock({ category: 'income', kind: 'continuous', description: '401k contribution', amount: 15000, startMonth: todayMonth(), preTax: true, targetAccountId: retirement?.id }));
    state.blocks.push(createBlock({ category: 'expense', kind: 'continuous', description: 'Living costs', amount: 48000, startMonth: todayMonth(), sourceAccountId: checking?.id, sigma: 0.05 }));
  }

  const accountsDiv = document.getElementById('accounts');
  const blocksDiv = document.getElementById('blocks');
  const segmentsDiv = document.getElementById('returnsSegments');
  const citySelect = document.getElementById('citySelect');
  const defaultAnnualInput = document.getElementById('defaultAnnual');
  const defaultSigmaInput = document.getElementById('defaultSigma');

  for (const c of cities()) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    citySelect.appendChild(opt);
  }
  citySelect.value = 'Default';

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

  function renderAccounts() {
    accountsDiv.innerHTML = '';
    for (const acc of Object.values(state.accounts)) {
      const el = document.createElement('div'); el.className = 'account';
      el.innerHTML = `
        <div class="card-header"><strong>${acc.name}</strong><button class="remove" type="button">remove</button></div>
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
        </div>`;
      accountsDiv.appendChild(el);

      el.querySelector('.remove').addEventListener('click', () => { delete state.accounts[acc.id]; renderAccounts(); renderBlocks(); });
      el.querySelector('.acc-name').addEventListener('input', e => { acc.name = e.target.value; el.querySelector('strong').textContent = acc.name; renderBlocks(); });
      el.querySelector('.acc-type').addEventListener('change', e => { acc.type = e.target.value; renderAccounts(); renderBlocks(); });
      el.querySelector('.acc-balance').addEventListener('input', e => { acc.balance = parseFloat(e.target.value || 0); });
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
  }

  function renderBlocks() {
    blocksDiv.innerHTML = '';
    state.blocks.forEach((b, idx) => {
      const el = document.createElement('div'); el.className = 'block';
      const isIncome = b.category === 'income';
      el.innerHTML = `
        <div class="card-header"><strong>${isIncome ? 'Income' : 'Expense'}</strong><button class="remove" type="button">remove</button></div>
        <div class="row">
          <label>Description <input type="text" class="b-desc" value="${b.description}"/></label>
          <label>Kind <select class="b-kind">
            <option value="continuous" ${b.kind === 'continuous' ? 'selected' : ''}>Continuous (monthly)</option>
            <option value="one-time" ${b.kind === 'one-time' ? 'selected' : ''}>One-time</option>
          </select></label>
        </div>
        <div class="row">
          <label>${b.kind === 'one-time' ? 'Amount $' : 'Annual amount $'} <input type="number" class="b-amount" value="${b.amount}"/></label>
          <label>σ % (optional) <input type="number" step="0.1" class="b-sigma" value="${pct(b.sigma)}"/></label>
        </div>
        <div class="row">
          <label>Start month <input type="month" class="b-start" value="${b.startMonth || ''}"/></label>
          <label>End month (blank = ongoing) <input type="month" class="b-end" value="${b.endMonth || ''}"/></label>
        </div>
        <div class="row">
          ${isIncome ? `
            <label>Target account <select class="b-target">${accountOptions(b.targetAccountId, a => a.type !== 'debt')}</select></label>
            <label class="inline"><input type="checkbox" class="b-pretax" ${b.preTax ? 'checked' : ''}/> Pre-tax (gross pay)</label>
          ` : `
            <label>Paid from <select class="b-source">${accountOptions(b.sourceAccountId, a => a.type !== 'debt')}</select></label>
            <label>Pay down debt (optional) <select class="b-debt">${accountOptions(b.debtAccountId, a => a.type === 'debt')}</select></label>
          `}
        </div>`;
      blocksDiv.appendChild(el);

      el.querySelector('.remove').addEventListener('click', () => { state.blocks.splice(idx, 1); renderBlocks(); });
      el.querySelector('.b-desc').addEventListener('input', e => { b.description = e.target.value; });
      el.querySelector('.b-kind').addEventListener('change', e => { b.kind = e.target.value; renderBlocks(); });
      el.querySelector('.b-amount').addEventListener('input', e => { b.amount = parseFloat(e.target.value || 0); });
      el.querySelector('.b-sigma').addEventListener('input', e => { b.sigma = parseFloat(e.target.value || 0) / 100; });
      el.querySelector('.b-start').addEventListener('input', e => { b.startMonth = e.target.value; });
      el.querySelector('.b-end').addEventListener('input', e => { b.endMonth = e.target.value || null; });
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
    renderAccounts(); renderBlocks();
  });

  document.getElementById('addIncome').addEventListener('click', () => {
    const checking = Object.values(state.accounts).find(a => a.type === 'checking');
    state.blocks.push(createBlock({ category: 'income', kind: 'continuous', description: 'New income', amount: 50000, startMonth: todayMonth(), preTax: true, targetAccountId: checking?.id }));
    renderBlocks();
  });
  document.getElementById('addExpense').addEventListener('click', () => {
    const checking = Object.values(state.accounts).find(a => a.type === 'checking');
    state.blocks.push(createBlock({ category: 'expense', kind: 'continuous', description: 'New expense', amount: 12000, startMonth: todayMonth(), sourceAccountId: checking?.id }));
    renderBlocks();
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

  renderAccounts();
  renderBlocks();
  renderGlobalSegments();

  return { getCity: () => citySelect.value };
}

