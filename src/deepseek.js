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

export function buildSummaryQuestionPrompt({ question, summary, simulationInputs, planEvents, monthlyTableCsv, tableMetadata }) {
  return {
    task: 'analyze_financial_simulation',
    user_question: question,
    summary_metrics: summary,
    simulation_inputs: simulationInputs,
    configured_plan_events: planEvents,
    monthly_simulation_table: {
      format: 'CSV',
      metadata: tableMetadata,
      data: monthlyTableCsv,
    },
    instructions: [
      'Answer the user question using only the supplied simulation data and plan configuration.',
      'The simulation_inputs object is the complete input snapshot used for this run: run settings, accounts, account return schedules, cash-flow blocks, global returns, market events, and withdrawal order.',
      'Use the monthly table for date-specific claims and cite exact dates and values.',
      'When explaining why a balance changes, distinguish observed timing/correlation from proven causation.',
      'The p10, median, p90, and mean columns are simulated net worth. Account columns are mean balances, not median balances.',
      'Be concise, practical, and explicit when the supplied data cannot establish a cause.',
      'Do not claim guaranteed returns or outcomes. This is planning analysis, not individualized financial advice.',
      'Return exactly one JSON object and no Markdown.',
    ],
    output_shape: {
      answer: 'plain-text answer, up to 1800 characters',
      evidence: [{ date: 'YYYY-MM or empty', metric: 'string', value: 'string', explanation: 'string' }],
      caveats: ['short string'],
      follow_up_questions: ['short string'],
    },
  };
}

export function buildSummaryFollowUpPrompt(question) {
  return {
    task: 'follow_up_financial_simulation_analysis',
    user_question: question,
    instructions: [
      'Continue the existing analysis using the simulation table and prior conversation already provided.',
      'Use exact dates and values for data claims, and distinguish correlation from proven causation.',
      'Be concise and practical. Return exactly one JSON object and no Markdown.',
    ],
    output_shape: {
      answer: 'plain-text answer, up to 1800 characters',
      evidence: [{ date: 'YYYY-MM or empty', metric: 'string', value: 'string', explanation: 'string' }],
      caveats: ['short string'],
      follow_up_questions: ['short string'],
    },
  };
}

export function validateSummaryAnswer(value) {
  const root = requireObject(value, 'Response');
  const answer = String(root.answer || '').trim().slice(0, 3000);
  if (!answer) throw new Error('DeepSeek returned an empty answer.');
  const evidence = Array.isArray(root.evidence) ? root.evidence.slice(0, 8).map((item, index) => {
    requireObject(item, `evidence[${index}]`);
    return {
      date: String(item.date || '').trim().slice(0, 20),
      metric: String(item.metric || '').trim().slice(0, 100),
      value: String(item.value || '').trim().slice(0, 100),
      explanation: String(item.explanation || '').trim().slice(0, 300),
    };
  }) : [];
  const cleanList = value => Array.isArray(value) ? value.slice(0, 5).map(item => String(item || '').trim().slice(0, 300)).filter(Boolean) : [];
  return {
    answer,
    evidence,
    caveats: cleanList(root.caveats),
    followUpQuestions: cleanList(root.follow_up_questions),
  };
}

function parseModelJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { throw new Error('DeepSeek did not return valid JSON. Try a more specific prompt.'); }
}

export async function requestDeepSeekConversation(apiKey, messages) {
  if (!apiKey) throw new Error('Add a DeepSeek API key in Simulation settings first.');
  if (!Array.isArray(messages) || !messages.length) throw new Error('DeepSeek conversation is empty.');
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
        { role: 'system', content: 'You analyze financial simulations from supplied data. Return only the requested strict JSON object. Never include Markdown.' },
        ...messages,
      ],
    }),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new Error(body?.error?.message || `DeepSeek request failed (${response.status}).`);
  const content = body?.choices?.[0]?.message?.content;
  return { value: parseModelJson(content), assistantContent: String(content || '') };
}

export async function requestDeepSeek(apiKey, prompt) {
  const response = await requestDeepSeekConversation(apiKey, [{ role: 'user', content: JSON.stringify(prompt) }]);
  return response.value;
}
