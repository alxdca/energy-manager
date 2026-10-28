(() => {
  'use strict';
  const devices = ['battery', 'car'];
  const element = (device, suffix) => document.getElementById(`${device}-${suffix}`);
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const numberFormatter = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 2 });
  const number = value => numberFormatter.format(value);
  const etaTime = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const etaDay = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });
  const etaDate = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', weekday: 'short', day: 'numeric', month: 'short' });
  function showChargeEstimate(estimate) {
    const line = element('battery', 'charge-estimate');
    let label = '';
    if (!document.hidden && controlsVisible() && !commandPending && estimate?.method === 'soc_trend') {
      if (estimate.status === 'estimating') label = 'Fin de charge : calcul en cours…';
      if (estimate.status === 'estimating' && typeof estimate.chargingEndsAt === 'string') {
        const cutoff = new Date(estimate.chargingEndsAt);
        if (Number.isFinite(cutoff.getTime())) label = `Fin de charge : calcul en cours… · arrêt au plus tard ${etaTime.format(cutoff)}`;
      }
      if (estimate.status === 'not_charging') label = 'En attente de charge';
      if (estimate.status === 'target_reached') label = 'Cible atteinte';
      if ((estimate.status === 'available' || estimate.status === 'window_limited' && estimate.chargingEndsAt === estimate.estimatedCompletionAt) && numeric(estimate.targetSocPercent) && estimate.targetSocPercent > 0 && estimate.targetSocPercent <= 100 &&
          numeric(estimate.remainingMinutes) && estimate.remainingMinutes > 0 && typeof estimate.estimatedCompletionAt === 'string' && typeof estimate.observedAt === 'string') {
        const completion = new Date(estimate.estimatedCompletionAt);
        const observed = new Date(estimate.observedAt);
        if (Number.isFinite(completion.getTime()) && Number.isFinite(observed.getTime()) && completion > observed) {
          const minutes = estimate.chargingEndsAt ? Math.ceil(estimate.remainingMinutes) : Math.max(5, Math.round(estimate.remainingMinutes / 5) * 5);
          const duration = minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60}` : ''}` : `${minutes} min`;
          const date = etaDay.format(completion) === etaDay.format(observed) ? '' : `${etaDate.format(completion)} à `;
          label = `${number(estimate.targetSocPercent)} % vers ${date}${etaTime.format(completion)} · ≈ ${duration}`;
          if (estimate.status === 'window_limited' && estimate.chargingEndsAt === estimate.estimatedCompletionAt) {
            label = `Arrêt à ${date}${etaTime.format(completion)} · ≈ ${duration} · cible ${number(estimate.targetSocPercent)} % non atteinte`;
          }
        }
      }
    }
    line.textContent = label;
    line.hidden = !label;
  }
  const power = value => {
    const watts = Math.round(value * 1000);
    return Math.abs(watts) >= 1000 ? `${number(value)} kW` : `${number(watts)} W`;
  };
  let state = {};
  let commandPending = false;
  let activeRead = null;
  let readGeneration = 0;
  let pollTimer;
  let refreshStartedAt = 0;
  let phasesInitialized = false;
  let phasesEdited = false;
  const desktopHome = document.body?.dataset.page === 'accueil'
    ? window.matchMedia('(min-width: 701px)')
    : null;
  const controlsVisible = () => desktopHome?.matches ?? true;
  const carAutomationStates = ['manual', 'idle', 'charging', 'eco', 'paused', 'blocked', 'error', 'stopping', 'waking'];
  const carAutomationLabels = { idle: 'en attente', charging: 'en charge', eco: 'éco', paused: 'en pause',
    blocked: 'bloqué', error: 'en erreur', stopping: 'arrêt en cours', waking: 'réveil Tesla' };
  const carAutomationReasons = new Map([
    ['soc_unavailable', 'Niveau de charge Tesla à actualiser.'], ['tesla_disconnected', 'Branchement Tesla à vérifier.'],
    ['car_unplugged', 'En attente du branchement de la voiture.'], ['charger_unavailable', 'Borne indisponible.'],
    ['battery_coordination_unavailable', 'Coordination avec la batterie indisponible.'],
    ['vehicle_charge_limit', 'La limite Tesla est inférieure au minimum demandé.'],
    ['deadline_infeasible', 'Minimum impossible à atteindre avant le départ.'], ['grid_limit', 'Consommation totale limitée à 16 kW.'],
    ['site_unavailable', 'Mesures de la maison indisponibles.'], ['waiting_for_window', 'En attente du prochain créneau.'],
    ['waiting_for_solar', 'En attente de surplus solaire.'], ['target_reached', 'Minimum atteint.'],
    ['required_solar', 'Recharge nécessaire avec le surplus solaire.'], ['optional_solar', 'Complément avec le surplus solaire.'],
    ['grid_charge', 'Recharge nécessaire en heures creuses.'], ['grid_charge_forecast_unavailable', 'Recharge nécessaire · prévision solaire indisponible.'],
    ['deadline_passed', 'Échéance dépassée.'],
    ['config_invalid', 'Paramètres de recharge à vérifier.'], ['target_override_invalid', 'Objectif de départ à vérifier.'],
    ['controller_capabilities', 'Pilotage automatique indisponible sur la borne.'],
    ['ownership_unavailable', 'Commande de la borne à vérifier.'], ['reconciled', 'État de la borne vérifié.'],
    ['refreshing_soc', 'Actualisation du niveau de charge Tesla.'], ['safety_unavailable', 'Mesures de l’installation indisponibles.'],
    ['solar_unverified', 'Surplus solaire non confirmé.'], ['outside_charging_window', 'Hors créneau de recharge.'],
    ['stopping', 'Arrêt de la recharge en cours.'], ['stop_unconfirmed', 'Arrêt non confirmé.'],
    ['automation_failed', 'Pilotage voiture indisponible.'], ['shutdown_failed', 'Arrêt non confirmé.'],
    ['not_started', 'En attente du premier bilan.'], ['awaiting_evaluation', 'En attente du prochain bilan.'],
    ['controller_unavailable', 'Borne indisponible.'],
    ['eco_default', 'Mode éco selon les réglages de la borne.'],
    ['eco_soc_unavailable', 'Mode éco · niveau de charge Tesla à actualiser.'],
    ['eco_car_unplugged', 'Mode éco · voiture débranchée.'], ['eco_target_reached', 'Minimum atteint · mode éco.'],
    ['eco_target_hysteresis', 'Minimum déjà atteint · reprise après une baisse de 5 points · mode éco.'],
    ['eco_connection_unknown', 'Mode éco · branchement inconnu.'],
    ['eco_tesla_disconnected', 'Mode éco · branchement Tesla à vérifier.'], ['eco_deadline_passed', 'Échéance passée · mode éco.'],
    ['night_minimum', 'Recharge du minimum du matin.'],
    ['night_charge_solar_support', 'Recharge du matin · soutien du solaire stocké.'],
    ['afternoon_minimum', 'Recharge de l’après-midi jusqu’à 30 %.'],
  ]);
  function validCarAutomation(value) {
    return value && typeof value.enabled === 'boolean' && carAutomationStates.includes(value.status)
      && !(value.enabled && value.status === 'manual')
      && (value.enabled || ['manual', 'blocked', 'error', 'stopping'].includes(value.status));
  }
  function showCarTarget(target) {
    const deadline = typeof target?.deadline === 'string' ? new Date(target.deadline) : null;
    const valid = numeric(target?.minimumSocPercent) && target.minimumSocPercent > 0 && target.minimumSocPercent <= 100
      && deadline && Number.isFinite(deadline.getTime());
    element('car', 'auto-target').textContent = valid
      ? `${target.kind === 'afternoon' ? 'Minimum de l’après-midi' : 'Minimum du matin'} : ${number(target.minimumSocPercent)} % · ${etaDate.format(deadline)} à ${etaTime.format(deadline)}.`
      : 'Objectif de recharge indisponible.';
  }

  function showCarPowerEstimate() {
    const input = element('car', 'current');
    const current = Number(input.value);
    const phases = Number(element('car', 'phases').value);
    const limits = state.car?.limits;
    const valid = state.car?.phaseSwitchingSupported === true && input.value.trim() !== ''
      && Number.isInteger(current) && current >= limits.minCurrentAmps && current <= limits.maxCurrentAmps
      && [1, 3].includes(phases);
    element('car', 'current-hint').textContent = valid
      ? `Puissance de charge estimée : ≈ ${power(current * phases * 230 / 1000)}`
      : 'Puissance de charge estimée : —';
  }

  function updateAvailability() {
    for (const device of devices) {
      const visible = controlsVisible() && !document.hidden;
      const enabled = visible && state[device]?.available === true && !commandPending;
      element(device, 'control-fields').disabled = !enabled;
      element(device, 'charge').disabled = !enabled;
      element(device, 'control-form').setAttribute('aria-busy', String(commandPending));
      const status = state[device];
      if (device === 'car') {
        element(device, 'phases').disabled = !enabled || status?.phaseSwitchingSupported !== true;
        element(device, 'eco').disabled = !enabled;
        element(device, 'pause').disabled = !visible || state.car?.canPause !== true || commandPending;
        element(device, 'auto').disabled = !visible || state.car?.canReturnToAuto !== true
          || !validCarAutomation(state.carAutomation) || commandPending;
        showCarPowerEstimate();
        continue;
      }
      element(device, 'auto').disabled = !visible || (status?.canReturnToAuto ?? status?.available) !== true || commandPending;
      element(device, 'soc').disabled = !enabled || !element(device, 'use-soc').checked;
      if (status) {
        const limits = status.limits;
        element(device, 'soc-hint').textContent = element(device, 'use-soc').checked
          ? `Limite : > ${number(limits.minSocPercent)} % et ≤ ${number(limits.maxSocPercent)} %.`
          : 'Sans limite : jusqu’à 100 %.';
      }
    }
  }

  function clearState(message) {
    state = {};
    showChargeEstimate(null);
    showCarTarget(null);
    for (const device of devices) {
      element(device, 'mode').textContent = 'Inconnu';
      element(device, 'control-note').textContent = message;
    }
    updateAvailability();
  }

  function showState(snapshot) {
    const battery = snapshot.battery;
    const limits = battery?.limits;
    if (!battery || !['manual', 'auto', 'unknown'].includes(battery.mode) || !limits ||
        !['minPowerKw', 'maxPowerKw', 'minSocPercent', 'maxSocPercent'].every(key => numeric(limits[key])) ||
        limits.minPowerKw <= 0 || limits.maxPowerKw < limits.minPowerKw || limits.maxSocPercent <= limits.minSocPercent) {
      throw new Error('État de pilotage invalide');
    }
    const car = snapshot.car;
    const carLimits = car?.limits;
    if (!car || !['pause', 'normal', 'eco', 'unknown'].includes(car.mode)
        || typeof car.available !== 'boolean' || typeof car.canPause !== 'boolean'
        || !carLimits || carLimits.minCurrentAmps !== 6
        || !(carLimits.maxCurrentAmps === null || Number.isInteger(carLimits.maxCurrentAmps)
          && carLimits.maxCurrentAmps >= 6 && carLimits.maxCurrentAmps <= 16)
        || (car.available && (carLimits.maxCurrentAmps === null || car.carConnected !== true || car.mode === 'unknown'))
        || !(car.currentAmps === null || Number.isInteger(car.currentAmps) && car.currentAmps >= 6 && car.currentAmps <= 32)
        || !(car.powerKw === null || numeric(car.powerKw) && car.powerKw >= 0)
        || ![true, false, null].includes(car.carConnected) || ![true, false, null].includes(car.charging)) {
      snapshot = { ...snapshot, car: { available: false, canPause: false, mode: 'unknown', currentAmps: null,
        powerKw: null, carConnected: null, charging: null, limits: { minCurrentAmps: 6, maxCurrentAmps: null },
        error: 'État de la borne indisponible.' } };
    }
    const phaseMode = [1, 3, 'auto'].includes(snapshot.car.phaseMode) ? snapshot.car.phaseMode : null;
    snapshot = { ...snapshot, car: { ...snapshot.car, phaseMode,
      phaseSwitchingSupported: snapshot.car.phaseSwitchingSupported === true && phaseMode !== null,
      canReturnToAuto: snapshot.car.canReturnToAuto === true,
      automated: snapshot.car.automated === true },
      carAutomation: validCarAutomation(snapshot.carAutomation) ? snapshot.carAutomation : null };
    state = snapshot;
    for (const device of devices) {
      const status = state[device];
      const limits = status.limits;
      if (device === 'car') {
        element(device, 'current').min = String(limits.minCurrentAmps);
        element(device, 'current').max = numeric(limits.maxCurrentAmps) ? String(limits.maxCurrentAmps) : '16';
        const labels = { pause: 'Pause', normal: 'Normal', eco: 'Éco', unknown: 'Inconnu' };
        const current = numeric(status.currentAmps) ? ` · ${number(status.currentAmps)} A` : '';
        const phases = status.phaseMode === 1 ? '1 phase' : status.phaseMode === 3 ? '3 phases'
          : status.phaseMode === 'auto' ? 'Phases auto' : '';
        const modeLabel = `${labels[status.mode]}${status.mode === 'unknown' ? '' : current}${phases ? ` · ${phases}` : ''}`;
        const automation = state.carAutomation;
        const automatic = automation && (automation.enabled || status.automated || automation.status === 'stopping');
        element(device, 'mode').textContent = automatic
          ? automation.status === 'charging' ? `Planificateur · ${modeLabel}`
            : `Planificateur · ${carAutomationLabels[automation.status] || 'en attente'}`
          : automation?.status === 'manual' ? `Manuel · ${modeLabel}`
            : status.automated ? 'Planification indisponible' : modeLabel;
        if (!phasesInitialized && !phasesEdited && status.available && status.phaseSwitchingSupported && [1, 3].includes(status.phaseMode)) {
          element(device, 'phases').value = String(status.phaseMode);
          phasesInitialized = true;
        }
        const connection = status.carConnected === true ? 'Voiture branchée' : status.carConnected === false ? 'Voiture débranchée' : 'Branchement inconnu';
        const charge = status.charging === true ? 'En charge' : status.charging === false ? 'En attente' : '';
        const automaticReason = automation?.enabled ? carAutomationReasons.get(automation.reason) : null;
        element(device, 'control-note').textContent = status.error || automation?.error
          || [automaticReason, connection, charge, numeric(status.powerKw) ? power(status.powerKw) : null].filter(Boolean).join(' · ');
        showCarTarget(automation?.plan?.target || snapshot.carTarget);
        continue;
      }
      element(device, 'power').min = String(limits.minPowerKw);
      element(device, 'power').max = String(limits.maxPowerKw);
      element(device, 'soc').min = String(Math.floor(limits.minSocPercent) + 1);
      element(device, 'soc').max = String(limits.maxSocPercent);
      let label = 'Inconnu';
      if (status.mode === 'auto') label = 'GEN24 · auto';
      if (status.mode === 'manual' && numeric(status.powerKw)) {
        const automated = status.automated === true;
        const authority = automated ? 'Planificateur' : 'Manuel';
        const holding = automated && status.automationMode === 'hold' && status.powerKw === 0;
        const supplying = automated && status.automationMode === 'supply';
        label = supplying ? 'Soutien voiture · solaire' : holding ? 'Planificateur · réserve' : status.powerKw === 0 ? `${authority} · veille` : status.powerKw > 0 ? `${authority} · charge ${power(status.powerKw)}` : `${authority} · décharge ${power(Math.abs(status.powerKw))}`;
        if (!holding && !supplying) label += status.powerKw > 0 && status.targetSocPercent === 100
          ? ' · jusqu’à 100 %'
          : numeric(status.targetSocPercent) ? ` · seuil ${number(status.targetSocPercent)} %` : ' · sans seuil';
      }
      element(device, 'mode').textContent = label;
      element(device, 'control-note').textContent = status.error || '';
    }
    showChargeEstimate(state.battery.automationMode === 'supply' ? null : state.battery.chargeEstimate);
    updateAvailability();
  }

  function scheduleRead() {
    clearTimeout(pollTimer);
    if (controlsVisible() && !document.hidden && !commandPending && !activeRead) pollTimer = setTimeout(refresh, Math.min(10000, Math.max(1000, refreshStartedAt + 10000 - Date.now())));
  }

  async function refresh(force = false) {
    if (!controlsVisible() || activeRead || commandPending || (document.hidden && !force)) return;
    clearTimeout(pollTimer);
    refreshStartedAt = Date.now();
    const request = { generation: ++readGeneration, controller: new AbortController() };
    activeRead = request;
    const timeout = setTimeout(() => request.controller.abort(), 8000);
    try {
      const response = await fetch('/api/controls', { cache: 'no-store', signal: request.controller.signal });
      if (!response.ok) throw new Error('État de pilotage indisponible');
      const snapshot = await response.json();
      if (request.generation === readGeneration && !document.hidden && controlsVisible()) showState(snapshot);
    } catch {
      if (request.generation === readGeneration && !document.hidden && controlsVisible()) clearState('État indisponible. Nouvelle mesure en attente.');
    } finally {
      clearTimeout(timeout);
      if (activeRead === request) {
        activeRead = null;
        scheduleRead();
      }
    }
  }

  function manualCommand(device, mode) {
    const limits = state[device].limits;
    if (device === 'car') {
      if (mode === 'pause') return { mode };
      const input = element(device, 'current').value.trim();
      const currentAmps = Number(input);
      if (!input || !Number.isInteger(currentAmps) || currentAmps < limits.minCurrentAmps
          || !numeric(limits.maxCurrentAmps) || currentAmps > limits.maxCurrentAmps) {
        throw new Error(`Courant : de ${number(limits.minCurrentAmps)} à ${number(limits.maxCurrentAmps)} A par phase, sans décimale.`);
      }
      if (state.car.phaseSwitchingSupported === true) {
        const phases = Number(element(device, 'phases').value);
        if (![1, 3].includes(phases)) throw new Error('Choisissez 1 phase ou 3 phases.');
        return { mode, currentAmps, phases };
      }
      return { mode, currentAmps };
    }
    const powerInput = element(device, 'power').value.trim();
    const powerKw = Number(powerInput);
    if (!powerInput || !Number.isFinite(powerKw) || powerKw < limits.minPowerKw || powerKw > limits.maxPowerKw) {
      throw new Error(`Puissance : de ${power(limits.minPowerKw)} à ${power(limits.maxPowerKw)}.`);
    }
    let targetSocPercent = null;
    if (element(device, 'use-soc').checked) {
      const socInput = element(device, 'soc').value.trim();
      targetSocPercent = Number(socInput);
      if (!socInput || !Number.isFinite(targetSocPercent) || targetSocPercent <= limits.minSocPercent || targetSocPercent > limits.maxSocPercent) {
        throw new Error(`Limite : > ${number(limits.minSocPercent)} % et ≤ ${number(limits.maxSocPercent)} %.`);
      }
    }
    return { mode: 'manual', powerKw, targetSocPercent };
  }

  async function submit(device, mode) {
    if (!controlsVisible() || document.hidden || commandPending) return;
    const feedback = element(device, 'feedback');
    const report = (status, message) => {
      feedback.setAttribute('data-state', status);
      feedback.textContent = message;
    };
    const available = device === 'car' && mode === 'auto'
      ? state.car?.canReturnToAuto === true && validCarAutomation(state.carAutomation)
      : device === 'car' && mode === 'pause' ? state.car?.canPause
      : mode === 'auto' ? state[device]?.canReturnToAuto ?? state[device]?.available : state[device]?.available;
    if (available !== true) {
      report('error', mode === 'auto' ? 'Mode Auto indisponible. Attendez la reconnexion.' : 'Charge manuelle indisponible. Attendez la reconnexion.');
      return;
    }
    let command;
    try {
      command = mode === 'auto' ? { mode: 'auto' } : manualCommand(device, mode);
    } catch (error) {
      report('error', error.message);
      return;
    }
    commandPending = true;
    clearTimeout(pollTimer);
    ++readGeneration;
    if (activeRead) {
      activeRead.controller.abort();
      activeRead = null;
    }
    clearState('Commande en cours…');
    report('pending', 'Envoi de la commande…');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), device === 'car' ? 50000 : 20000);
    try {
      const response = await fetch(`/api/controls/${device}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command), signal: controller.signal,
      });
      const result = await response.json();
      if (response.ok && result.success === true) {
        report('success', 'Commande acceptée. Vérification du mode…');
      } else if (result.outcome === 'unknown') {
        report('error', `Résultat inconnu. ${result.error || 'Réponse non confirmée.'} Vérifiez le mode avant de réessayer. Aucun renvoi automatique.`);
      } else {
        report('error', `${result.error || 'Commande refusée.'}${response.status === 409 ? ' Commande déjà en cours ? Vérifiez le mode avant de réessayer.' : ''}`);
      }
    } catch {
      report('error', 'Résultat inconnu : connexion interrompue ou délai dépassé. Vérifiez le mode avant de réessayer. Aucun renvoi automatique.');
    } finally {
      clearTimeout(timeout);
      commandPending = false;
      updateAvailability();
      await refresh(true);
    }
  }

  for (const device of devices) {
    element(device, 'control-form').addEventListener('submit', event => {
      event.preventDefault();
      return submit(device, device === 'car' ? 'normal' : 'manual');
    });
    if (device === 'car') {
      element(device, 'current').addEventListener('input', showCarPowerEstimate);
      element(device, 'phases').addEventListener('change', () => { phasesEdited = true; showCarPowerEstimate(); });
      element(device, 'eco').addEventListener('click', () => submit(device, 'eco'));
      element(device, 'pause').addEventListener('click', () => submit(device, 'pause'));
      element(device, 'auto').addEventListener('click', () => submit(device, 'auto'));
    } else {
      element(device, 'auto').addEventListener('click', () => submit(device, 'auto'));
      element(device, 'use-soc').addEventListener('change', updateAvailability);
    }
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (document.hidden) {
      ++readGeneration;
      const request = activeRead;
      activeRead = null;
      request?.controller.abort();
      clearState('Nouvelle mesure en attente.');
    }
    if (!document.hidden) refresh();
  });
  desktopHome?.addEventListener('change', () => {
    clearTimeout(pollTimer);
    if (!controlsVisible()) {
      ++readGeneration;
      if (activeRead) {
        activeRead.controller.abort();
        activeRead = null;
      }
      clearState(commandPending ? 'Commande en cours…' : 'Nouvelle mesure en attente.');
    } else {
      refresh();
    }
  });
  updateAvailability();
  refresh();
})();
