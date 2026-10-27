(() => {
  'use strict';
  const button = document.getElementById('household-train');
  if (!button) return;
  const status = document.getElementById('household-training-status');
  const error = document.getElementById('household-training-error');
  const dateFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' });
  let pending = false, timer, wasTraining = false;
  function show(data) {
    const running = data.state === 'training';
    button.disabled = running;
    const trained = typeof data.lastTrainedAt === 'string' ? new Date(data.lastTrainedAt) : null;
    status.textContent = running ? 'Apprentissage complet en cours…'
      : trained && Number.isFinite(trained.getTime()) ? `Dernier apprentissage : ${dateFormat.format(trained)} · ${data.training?.completeSamplingDays ?? 0} jours complets · ${data.weatherStatus === 'calibrated' ? 'correction météo apprise' : 'correction météo en attente'}`
        : 'Le premier apprentissage attend le prochain bilan.';
    error.textContent = typeof data.error === 'string' ? data.error : '';
    error.hidden = !error.textContent;
    if (wasTraining && !running && !data.error) window.dispatchEvent(new Event('household-forecast-updated'));
    wasTraining = running;
    return running;
  }
  async function refresh(manual = false) {
    if (pending || !manual && document.hidden) return;
    pending = true; clearTimeout(timer);
    button.disabled = true;
    let running = false;
    try {
      const response = await fetch('/api/household/training', { method: manual ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('L’apprentissage maison est indisponible. Réessayez.');
      running = show(await response.json());
    } catch (failure) {
      error.textContent = failure.message; error.hidden = false; button.disabled = false;
    } finally {
      pending = false;
      if (!document.hidden) timer = setTimeout(() => refresh(), running ? 2000 : 30000);
    }
  }
  button.addEventListener('click', () => refresh(true));
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) refresh(); });
  refresh();
})();
