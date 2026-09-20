const overlay = document.getElementById('appLoading');
const message = document.getElementById('appLoadingMessage');
const detail = document.getElementById('appLoadingDetail');
const progressWrap = document.getElementById('appLoadingProgress');
const progressBar = document.getElementById('appLoadingBar');
const progressValue = document.getElementById('appLoadingPercent');

export function showLoading(label = 'Loading…', { progress = false, detailText = '' } = {}) {
  message.textContent = label;
  detail.textContent = detailText;
  progressWrap.hidden = !progress;
  if (progress) updateLoadingProgress(0, label, detailText);
  overlay.hidden = false;
  document.body.setAttribute('aria-busy', 'true');
}

export function updateLoadingProgress(value, label, detailText) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  progressBar.value = percent;
  progressValue.textContent = `${percent}%`;
  if (label) message.textContent = label;
  if (detailText !== undefined) detail.textContent = detailText;
}

export function hideLoading() {
  overlay.hidden = true;
  progressWrap.hidden = true;
  progressBar.value = 0;
  progressValue.textContent = '0%';
  detail.textContent = '';
  document.body.removeAttribute('aria-busy');
}

export function showLoadingError(error) {
  const text = error?.message || String(error || 'The operation could not be completed.');
  showLoading('Something went wrong', { detailText: text });
  overlay.classList.add('error');
}

export async function withLoading(label, operation) {
  overlay.classList.remove('error');
  showLoading(label);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    return await operation();
  } finally {
    hideLoading();
  }
}
