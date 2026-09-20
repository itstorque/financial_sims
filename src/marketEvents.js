// Rare, path-dependent market regimes sampled independently for each particle.
// An event is sampled once per path. If it occurs, its start month is chosen
// uniformly within its trigger window and its annual return/sigma replace the
// normal return schedule for matching accounts during its duration.

let eventCounter = 0;

export function createMarketEvent({
  id,
  name = 'Market crash',
  probability = 0.15,
  triggerWindowMonths = 24,
  durationMonths = 12,
  annualReturn = -0.35,
  sigma = 0.25,
  scope = 'investments',
} = {}) {
  return {
    id: id || `event_${++eventCounter}_${Date.now().toString(36)}`,
    name,
    probability: Math.min(1, Math.max(0, Number(probability) || 0)),
    triggerWindowMonths: Math.max(1, Math.round(Number(triggerWindowMonths) || 1)),
    durationMonths: Math.max(1, Math.round(Number(durationMonths) || 1)),
    annualReturn: Number(annualReturn) || 0,
    sigma: Math.max(0, Number(sigma) || 0),
    scope: scope === 'all' ? 'all' : 'investments',
  };
}

export function sampleMarketEvents(events, simulationMonths, random = Math.random) {
  return events.flatMap(event => {
    if (random() >= event.probability) return [];
    const windowMonths = Math.max(1, Math.min(event.triggerWindowMonths, simulationMonths));
    const startIndex = Math.floor(random() * windowMonths);
    return [{
      eventId: event.id,
      startIndex,
      endIndex: Math.min(simulationMonths - 1, startIndex + event.durationMonths - 1),
    }];
  });
}

export function eventAppliesToAccount(event, account) {
  if (account.type === 'debt') return false;
  if (event.scope === 'all') return true;
  return account.type === 'taxable' || account.type === 'retirement' || account.type === 'roth';
}

export function activeMarketEvent(events, occurrences, monthIndex, account) {
  let active = null;
  for (const occurrence of occurrences) {
    if (monthIndex < occurrence.startIndex || monthIndex > occurrence.endIndex) continue;
    const event = events.find(candidate => candidate.id === occurrence.eventId);
    if (event && eventAppliesToAccount(event, account)) active = event;
  }
  return active;
}
