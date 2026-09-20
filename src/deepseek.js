const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function validateClips(clips, window) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('The model must return at least one clip.');
  const normalized = clips.map((clip, index) => {
    requireObject(clip, `clips[${index}]`);
    if (!MONTH_PATTERN.test(clip.from) || !MONTH_PATTERN.test(clip.to)) throw new Error(`Clip ${index + 1} must use YYYY-MM dates.`);
    if (clip.from > clip.to) throw new Error(`Clip ${index + 1} ends before it starts.`);
    if (clip.from < window.from || clip.to > window.to) throw new Error(`Clip ${index + 1} falls outside ${window.from} to ${window.to}.`);
    const annualAmount = Number(clip.annualAmount);
    if (!Number.isFinite(annualAmount) || annualAmount < 0) throw new Error(`Clip ${index + 1} needs a non-negative annualAmount.`);
    return {
      from: clip.from,
      to: clip.to,
      name: String(clip.name || `Clip ${index + 1}`).trim().slice(0, 120) || `Clip ${index + 1}`,
      annualAmount,
    };
  }).sort((a, b) => a.from.localeCompare(b.from));
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index].from <= normalized[index - 1].to) throw new Error('The model returned overlapping clips.');
  }
  return normalized;
}

export function buildTrackPrompt({ request, window, accounts }) {
  return {
    task: 'create_cash_flow_track',
    user_request: request,
    simulation_window: window,
    available_accounts: accounts,
    instructions: [
      'Return exactly one JSON object and no Markdown.',
      'Amounts are non-negative annual US-dollar amounts. Use category to indicate income versus expense.',
      'Dates are inclusive YYYY-MM values inside the simulation window.',
      'Use multiple non-overlapping clips for changes over time. Use annualAmount 0 for pauses.',
      'Use an accountId from available_accounts, or null when no account is appropriate.',
    ],
    output_shape: {
      operation: 'add_track',
      track: {
        description: 'string',
        category: 'income | expense',
        preTax: 'boolean; relevant to income',
        inflationAdjusted: 'boolean',
        sigma: 'number from 0 to 0.5',
        accountId: 'available account id or null',
        clips: [{ from: 'YYYY-MM', to: 'YYYY-MM', name: 'string', annualAmount: 'number' }],
      },
    },
  };
}

export function buildTrackEditPrompt({ request, window, track, selectedClipIndex }) {
  return {
    task: 'edit_cash_flow_schedule',
    user_request: request,
    simulation_window: window,
    selected_clip_index: selectedClipIndex,
    current_track: track,
    instructions: [
      'Return exactly one JSON object and no Markdown.',
      'Return the complete replacement clips list, including unchanged clips.',
      'Amounts are non-negative annual US-dollar amounts and dates are inclusive YYYY-MM values.',
      'Clips must not overlap and must stay inside the simulation window. Use annualAmount 0 for pauses.',
      'Do not change the track id, category, account, tax, inflation, or volatility settings.',
    ],
    output_shape: {
      operation: 'replace_schedule',
      trackId: track.id,
      description: 'string; omit to keep unchanged',
      clips: [{ from: 'YYYY-MM', to: 'YYYY-MM', name: 'string', annualAmount: 'number' }],
    },
  };
}

export function validateTrackCreation(value, { window, accountIds }) {
  const root = requireObject(value, 'Response');
  const track = requireObject(root.track, 'track');
  if (root.operation !== 'add_track') throw new Error('The model returned the wrong operation.');
  if (!['income', 'expense'].includes(track.category)) throw new Error('Track category must be income or expense.');
  const description = String(track.description || '').trim().slice(0, 160);
  if (!description) throw new Error('The model must provide a track description.');
  const sigma = Number(track.sigma ?? 0);
  if (!Number.isFinite(sigma) || sigma < 0 || sigma > 0.5) throw new Error('Track sigma must be between 0 and 0.5.');
  const accountId = track.accountId == null || track.accountId === '' ? null : String(track.accountId);
  if (accountId && !accountIds.includes(accountId)) throw new Error('The model selected an unknown account.');
  return {
    description,
    category: track.category,
    preTax: track.category === 'income' && track.preTax === true,
    inflationAdjusted: track.inflationAdjusted !== false,
    sigma,
    accountId,
    clips: validateClips(track.clips, window),
  };
}

export function validateTrackEdit(value, { window, trackId }) {
  const root = requireObject(value, 'Response');
  if (root.operation !== 'replace_schedule' || root.trackId !== trackId) throw new Error('The model returned an edit for the wrong track.');
  return {
    description: root.description == null ? null : String(root.description).trim().slice(0, 160),
    clips: validateClips(root.clips, window),
  };
}

function parseModelJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { throw new Error('DeepSeek did not return valid JSON. Try a more specific prompt.'); }
}

export async function requestDeepSeek(apiKey, prompt) {
  if (!apiKey) throw new Error('Add a DeepSeek API key in Simulation settings first.');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You convert financial planning requests into strict JSON. Return only the requested JSON object. Never include prose or Markdown.' },
        { role: 'user', content: JSON.stringify(prompt) },
      ],
    }),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new Error(body?.error?.message || `DeepSeek request failed (${response.status}).`);
  return parseModelJson(body?.choices?.[0]?.message?.content);
}
