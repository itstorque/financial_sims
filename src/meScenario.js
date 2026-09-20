// Loads a personal "me.json" scenario file from the filesystem (fetched as a
// static asset next to index.html) if one is present. This lets you keep
// your real financial data out of version control — `me.json` is listed in
// .gitignore — while still having the app seed itself with your real numbers
// on every load.
//
// `me.json` uses the exact same shape as the "Export JSON" button produces
// (see persistence.js: createScenarioExport). The easiest way to create your
// own: fill out the app with your real accounts/income/expenses, click
// "Export JSON" in the Scenarios panel, then save the downloaded file as
// `me.json` in the project root (same folder as index.html).
//
// If `me.json` doesn't exist (404, or fetch fails entirely e.g. opened via
// file:// without a local server) or can't be parsed/revived, this quietly
// resolves to null and the caller should fall back to the generic example
// scenario (see baseScenario.js).

import { reviveState } from './persistence.js';

export const ME_JSON_PATH = './me.json';

export async function loadMeScenario(path = ME_JSON_PATH) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-store' });
  } catch {
    return null; // e.g. no server / offline — fall back silently
  }
  if (!res.ok) return null; // most commonly a 404 (no me.json provided), which is expected

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.warn('me.json was found but is not valid JSON; ignoring it.', err);
    return null;
  }

  try {
    return {
      name: data.name || 'Me',
      settings: data.settings || {},
      notes: data.notes || '',
      state: reviveState(data.state || {}),
    };
  } catch (err) {
    console.warn('me.json was found but could not be loaded into the app; ignoring it.', err);
    return null;
  }
}
