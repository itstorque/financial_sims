// localStorage persistence: pure data (de)serialization + storage CRUD.
// Kept free of DOM access so it can be tested/reused independently of ui.js.

import { Account } from './accounts.js';
import { ReturnsSchedule } from './returnsSchedule.js';
import { createBlock, createLoanBlock } from './blocks.js';
import { createMarketEvent } from './marketEvents.js';

const AUTOSAVE_KEY = 'finSim.autosave.v1';
const SCENARIOS_KEY = 'finSim.scenarios.v1';

function serializeReturnsSchedule(rs) {
  return { entries: rs.entries.map(e => ({ ...e })), defaultAnnual: rs.defaultAnnual, defaultSigma: rs.defaultSigma, defaultDistribution: rs.defaultDistribution };
}

function reviveReturnsSchedule(data) {
  return new ReturnsSchedule((data && data.entries) || [], {
    defaultAnnual: data?.defaultAnnual ?? 0.06,
    defaultSigma: data?.defaultSigma ?? 0.08,
    defaultDistribution: data?.defaultDistribution,
  });
}

/** Convert the live in-memory state (Account instances, block objects, ReturnsSchedule) into plain JSON-safe data. */
export function serializeState(state) {
  return {
    accounts: Object.values(state.accounts).map(a => ({
      id: a.id, name: a.name, type: a.type, balance: a.balance, sigma: a.sigma,
      useCustomReturns: a.useCustomReturns,
      returnsSchedule: serializeReturnsSchedule(a.returnsSchedule),
    })),
    blocks: state.blocks.map(b => ({ ...b })),
    globalReturnsSchedule: serializeReturnsSchedule(state.globalReturnsSchedule),
    marketEvents: (state.marketEvents || []).map(event => ({ ...event })),
    withdrawalOrder: Array.isArray(state.withdrawalOrder) ? [...state.withdrawalOrder] : [],
  };
}

/** Build a portable, versioned snapshot suitable for downloading and sharing. */
export function createScenarioExport(name, settings, state, notes = '') {
  return {
    format: 'financial-sims-scenario',
    version: 2,
    name: name || 'Untitled scenario',
    exportedAt: new Date().toISOString(),
    settings: { ...settings },
    notes,
    state: serializeState(state),
  };
}

/** Validate and revive a portable scenario JSON object loaded from disk. */
export function reviveScenarioExport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Scenario file must contain a JSON object.');
  if (data.format !== 'financial-sims-scenario') throw new Error('This is not a Financial Simulator scenario file.');
  if (data.version !== 1 && data.version !== 2) throw new Error(`Unsupported scenario version: ${data.version ?? 'missing'}.`);
  if (!data.state || typeof data.state !== 'object') throw new Error('Scenario state is missing.');
  if (!Array.isArray(data.state.accounts) || !Array.isArray(data.state.blocks)) throw new Error('Scenario accounts or cash flows are invalid.');
  return {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Imported scenario',
    settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
    notes: typeof data.notes === 'string' ? data.notes : '',
    state: reviveState(data.state),
  };
}

/** Rebuild live objects (Account instances w/ nested ReturnsSchedule, blocks, global ReturnsSchedule) from plain data. */
export function reviveState(data) {
  const accounts = {};
  for (const a of data.accounts || []) {
    accounts[a.id] = new Account({
      id: a.id, name: a.name, type: a.type, balance: a.balance, sigma: a.sigma,
      useCustomReturns: a.useCustomReturns, returnsSchedule: reviveReturnsSchedule(a.returnsSchedule),
    });
  }
  const blocks = (data.blocks || []).map(b => (b.kind === 'loan' ? createLoanBlock(b) : createBlock(b)));
  const globalReturnsSchedule = reviveReturnsSchedule(data.globalReturnsSchedule);
  const marketEvents = (data.marketEvents || []).map(event => createMarketEvent(event));
  const withdrawalOrder = Array.isArray(data.withdrawalOrder) ? [...data.withdrawalOrder] : [];
  return { accounts, blocks, globalReturnsSchedule, marketEvents, withdrawalOrder };
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

// --- Autosave (silent, continuous background persistence of the working session) ---

export function saveAutosave(settings, state, notes = '') {
  const payload = { settings, state: serializeState(state), notes };
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
}

export function loadAutosave() {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) return null;
  const parsed = safeParse(raw);
  if (!parsed) return null;
  return { settings: parsed.settings || {}, state: reviveState(parsed.state || {}), notes: parsed.notes || '' };
}

export function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

// --- Named scenarios (explicit user-triggered save/load of a full plan) ---

function loadScenarioBank() {
  return safeParse(localStorage.getItem(SCENARIOS_KEY)) || {};
}

function saveScenarioBank(bank) {
  localStorage.setItem(SCENARIOS_KEY, JSON.stringify(bank));
}

export function listScenarios() {
  return Object.keys(loadScenarioBank()).sort((a, b) => a.localeCompare(b));
}

export function saveScenario(name, settings, state, notes = '') {
  const bank = loadScenarioBank();
  bank[name] = { settings, state: serializeState(state), notes, savedAt: new Date().toISOString() };
  saveScenarioBank(bank);
}

export function loadScenario(name) {
  const bank = loadScenarioBank();
  const entry = bank[name];
  if (!entry) return null;
  return { settings: entry.settings || {}, state: reviveState(entry.state || {}), notes: entry.notes || '' };
}

export function deleteScenario(name) {
  const bank = loadScenarioBank();
  delete bank[name];
  saveScenarioBank(bank);
}
