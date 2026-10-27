(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const button = byId('household-train');
  if (!button) return;
  const status = byId('household-training-status');
  const error = byId('household-training-error');
  const dateFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' });
  const dayFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short' });
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });
  const numberFormat = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 2 });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = (id, value) => { const element = byId(id); if (element) element.textContent = value; };
  const number = (value, unit = '') => finite(value) && value >= 0 ? `${numberFormat.format(value)}${unit}` : '—';
  const count = value => Number.isInteger(value) && value >= 0 ? number(value) : '—';
  const date = value => {
    const parsed = typeof value === 'string' ? new Date(value) : null;
    return parsed && Number.isFinite(parsed.getTime()) ? dateFormat.format(parsed) : '—';
  };
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) ? dayFormat.format(new Date(`${value}T12:00:00Z`)) : '—';
  function today() {
    const parts = localDay.formatToParts(new Date());
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
  }
  function clock() {
    text('local-date', new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date()));
    text('local-time', new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }).format(new Date()));
  }
  let pending = false, timer, wasTraining = false;
  function show(data) {
    const running = data.state === 'training';
    const empty = data.training?.observations === 0;
    text('learning-state', running ? 'En cours' : data.state === 'error' ? 'Erreur' : empty ? 'En attente de mesures' : data.modelId ? 'Actif' : 'En attente');
    const trained = date(data.lastTrainedAt);
    status.textContent = running ? 'Apprentissage complet en cours…'
      : data.error ? 'Le dernier cycle a échoué. Nouvelle tentative automatique au prochain bilan.'
        : empty ? 'Aucune mesure maison hors recharge voiture disponible pour apprendre. Nouvelle tentative automatique au prochain bilan.'
        : trained !== '—' ? `Dernier apprentissage : ${trained}${data.weatherStatus === 'calibrated' ? ' · correction météo apprise' : ''}`
          : 'Le premier apprentissage attend le prochain bilan.';
    text('learning-last', trained);
    text('learning-next', typeof data.nextTrainingAt === 'string' && Number.isFinite(Date.parse(data.nextTrainingAt))
      ? Date.parse(data.nextTrainingAt) <= Date.now() ? 'Au prochain bilan' : date(data.nextTrainingAt) : 'Au prochain bilan');
    text('learning-version', typeof data.modelVersion === 'string' ? data.modelVersion : '—');
    const settings = data.settings;
    text('learning-frequency', settings?.automaticTraining === 'daily' ? 'Chaque jour · Zurich' : '—');
    text('learning-history-days', number(settings?.historyDays, ' jours + aujourd’hui'));
    text('learning-half-life', number(settings?.halfLifeDays, ' jours'));
    text('learning-step', number(settings?.stepMinutes, ' min'));
    text('learning-weekday-factor', finite(settings?.weekdayFactor) ? `× ${number(settings.weekdayFactor)}` : '—');
    text('learning-fallback-window', number(settings?.fallback?.windowHours, ' h'));
    text('learning-fallback-power', number(settings?.fallback?.baselinePowerW, ' W'));
    text('learning-weekday-rule', settings ? `Le poids du même jour de semaine s’applique après ${count(settings.minimumCompleteDays)} jours complets et ${count(settings.minimumMatchingWeekdays)} occurrences de ce jour pour le créneau.` : '');
    const training = data.training;
    text('learning-period', training ? `${day(training.from)} → ${day(training.to)}` : '—');
    text('learning-usable-days', count(training?.usableDays));
    text('learning-complete-days', count(training?.completeSamplingDays));
    text('learning-observations', count(training?.observations));
    text('learning-weather-days', count(training?.weatherDays));
    text('learning-weather-state', ({ calibrated: 'Apprise et validée', unavailable: 'Indisponible', insufficient_history: 'Historique insuffisant',
      not_identifiable: 'Effet non identifiable', not_validated: 'Gain non validé' })[data.weatherStatus] ?? '—');
    text('learning-weather-threshold', data.weatherStatus === 'calibrated' && finite(data.calibration?.balancePointC)
      ? `${numberFormat.format(data.calibration.balancePointC)} °C` : '—');
    text('learning-weather-slope', data.weatherStatus === 'calibrated' ? number(data.calibration?.slopeKwPerC, ' kW/°C') : '—');
    text('learning-weather-rule', settings ? `La correction météo exige au moins ${count(settings.minimumWeatherDays)} jours éligibles et un gain validé sur des jours séparés. Les températures historiques peuvent être publiées avec plusieurs jours de retard.` : '');
    error.textContent = typeof data.error === 'string' ? data.error : '';
    error.hidden = !error.textContent;
    if (wasTraining && !running && !data.error) window.dispatchEvent(new Event('household-forecast-updated'));
    wasTraining = running;
    return running;
  }
  function showForecast(forecast, requestedDate) {
    const valid = forecast && forecast.date === requestedDate && requestedDate === today() && Array.isArray(forecast.slots);
    const source = valid ? forecast.fallback?.source : null;
    const learned = valid ? forecast.slots.filter(slot => slot.source === 'learned_profile').length : null;
    const fallback = valid ? forecast.slots.filter(slot => slot.source === 'recent_average' || slot.source === 'configured_baseline').length : null;
    const coverage = value => valid && learned + fallback === forecast.slots.length && forecast.slots.length > 0
      ? `${count(value)} / ${count(forecast.slots.length)}` : '—';
    text('learning-forecast-status', !valid ? 'Aucune prévision enregistrée pour aujourd’hui.'
      : `Aujourd’hui · ${day(requestedDate)} · ${({ available: 'Profil disponible', learning: 'Profil en apprentissage', fallback: 'Prévision avec secours', unavailable: 'Prévision indisponible' })[forecast.status] ?? 'État inconnu'}`);
    text('learning-forecast-at', valid ? date(forecast.issuedAt) : '—');
    text('learning-forecast-kwh', valid ? number(forecast.estimatedConsumptionKwh, ' kWh') : '—');
    text('learning-forecast-learned', coverage(learned));
    text('learning-forecast-fallback', coverage(fallback));
    text('learning-forecast-source', !valid ? '—' : source === 'recent_average' ? 'Moyenne récente' : source === 'configured_baseline' ? 'Puissance configurée' : 'Aucun secours');
    text('learning-forecast-average', valid ? number(forecast.fallback?.averagePowerW, ' W') : '—');
    text('learning-forecast-samples', valid ? count(forecast.fallback?.samples) : '—');
  }
  async function refreshForecast() {
    const requestedDate = today();
    try {
      const response = await fetch(`/api/household/forecast?date=${requestedDate}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Prévision indisponible');
      showForecast((await response.json()).forecast, requestedDate);
    } catch {
      showForecast(null, requestedDate);
      text('learning-forecast-status', 'La prévision enregistrée est indisponible. Nouvelle tentative automatique.');
    }
  }
  async function refresh(manual = false) {
    if (pending || !manual && document.hidden) return;
    pending = true; clearTimeout(timer); clock();
    button.disabled = true;
    let running = false;
    try {
      const response = await fetch('/api/household/training', { method: manual ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('L’apprentissage maison est indisponible. Réessayez.');
      running = show(await response.json());
    } catch (failure) {
      text('learning-state', 'Indisponible');
      status.textContent = 'Impossible de vérifier l’état de l’apprentissage.';
      error.textContent = failure.message; error.hidden = false;
    } finally {
      if (!document.hidden) await refreshForecast();
      pending = false;
      button.disabled = running;
      if (!document.hidden) timer = setTimeout(() => refresh(), running ? 2000 : 30000);
    }
  }
  button.addEventListener('click', () => refresh(true));
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) refresh(); });
  refresh();
})();
