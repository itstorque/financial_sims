// localStorage persistence: pure data (de)serialization + storage CRUD.
// Kept free of DOM access so it can be tested/reused independently of ui.js.

import { Account } from './accounts.js';
import { ReturnsSchedule } from './returnsSchedule.js';
import { createBlock, createLoanBlock } from './blocks.js';

const AUTOSAVE_KEY = 'finSim.autosave.v1';
const SCENARIOS_KEY = 'finSim.scenarios.v1';

function serializeReturnsSchedule(rs) {
  return { entries: rs.entries.map(e => ({ ...e })), defaultAnnual: rs.defaultAnnual, defaultSigma: rs.defaultSigma };
}

function reviveReturnsSchedule(data) {
  return new ReturnsSchedule((data && data.entries) || [], {
    defaultAnnual: data?.defaultAnnual ?? 0.06,
    defaultSigma: data?.defaultSigma ?? 0.08,
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
  };
}

/** Build a portable, versioned snapshot suitable for downloading and sharing. */
export function createScenarioExport(name, settings, state, notes = '') {
  return {
    format: 'financial-sims-scenario',
    version: 1,
    name: name || 'Untitled scenario',
    exportedAt: new Date().toISOString(),
    settings: { ...settings },
    notes,
    state: serializeState(state),
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
  return { accounts, blocks, globalReturnsSchedule };
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
