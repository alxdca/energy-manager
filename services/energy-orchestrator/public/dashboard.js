(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const text = (id, value) => {
    const element = byId(id);
    if (element) element.textContent = value;
  };
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const powerFormatter = new Intl.NumberFormat('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const flowPowerFormatter = new Intl.NumberFormat('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const socFormatter = new Intl.NumberFormat('fr-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const wattFormatter = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 0 });
  const etaTime = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const observationTime = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const etaDay = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });
  const etaDate = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', weekday: 'short', day: 'numeric', month: 'short' });
  const etaSoc = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 2 });
  function showChargeEstimate(estimate) {
    const line = byId('flow-battery-charge-estimate');
    if (!line && !byId('planner-charge-remaining')) return;
    let label = '';
    let remainingLabel = '—';
    let completionLabel = '—';
    if (!document.hidden && estimate?.method === 'soc_trend' && numeric(estimate.targetSocPercent)
        && estimate.targetSocPercent > 0 && estimate.targetSocPercent <= 100) {
      const target = `cible ${etaSoc.format(estimate.targetSocPercent)} %`;
      if (estimate.status === 'estimating') {
        label = `${target} · durée et fin en calcul…`;
        remainingLabel = completionLabel = 'Calcul en cours…';
        const cutoff = new Date(estimate.chargingEndsAt);
        if (Number.isFinite(cutoff.getTime()) && cutoff.getTime() > Date.now()) {
          completionLabel = `Au plus tard ${etaTime.format(cutoff)}`;
          label = `${target} · durée en calcul… · arrêt au plus tard ${etaTime.format(cutoff)}`;
        }
      }
      if (estimate.status === 'not_charging') {
        label = `${target} · en attente de charge`;
        remainingLabel = 'En attente de charge';
      }
      if (estimate.status === 'target_reached') {
        label = `${target} atteinte`;
        remainingLabel = 'Cible atteinte';
      }
      if ((estimate.status === 'available' || estimate.status === 'window_limited' && estimate.chargingEndsAt === estimate.estimatedCompletionAt) && numeric(estimate.targetSocPercent) && estimate.targetSocPercent > 0 && estimate.targetSocPercent <= 100 &&
          numeric(estimate.remainingMinutes) && estimate.remainingMinutes > 0 && typeof estimate.estimatedCompletionAt === 'string' && typeof estimate.observedAt === 'string') {
        const completion = new Date(estimate.estimatedCompletionAt);
        const observed = new Date(estimate.observedAt);
        if (Number.isFinite(completion.getTime()) && Number.isFinite(observed.getTime()) && completion > observed
          && completion.getTime() > Date.now()) {
          const minutes = estimate.chargingEndsAt ? Math.ceil(estimate.remainingMinutes) : Math.max(5, Math.round(estimate.remainingMinutes / 5) * 5);
          const duration = minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60}` : ''}` : `${minutes} min`;
          const date = etaDay.format(completion) === etaDay.format(observed) ? '' : `${etaDate.format(completion)} à `;
          label = `${target} · encore ≈ ${duration} · fin vers ${date}${etaTime.format(completion)}`;
          remainingLabel = `≈ ${duration}`;
          completionLabel = `≈ ${date}${etaTime.format(completion)}`;
          if (estimate.status === 'window_limited' && estimate.chargingEndsAt === estimate.estimatedCompletionAt) {
            label = `${target} · encore ≈ ${duration} · arrêt à ${date}${etaTime.format(completion)} · cible non atteinte`;
            completionLabel = `${date}${etaTime.format(completion)} · cible non atteinte`;
          }
        }
      }
    }
    if (line) {
      line.textContent = label ? `Batterie : ${label}` : '';
      line.hidden = !label;
    }
    text('planner-charge-remaining', remainingLabel);
    text('planner-charge-end', completionLabel);
  }
  const dailyEnergyFormatter = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 1 });
  function showDailyEnergy(summary, updatedAt) {
    const details = byId('today-daily-energy');
    if (!details) return;
    const clear = () => {
      details.hidden = true;
      details.removeAttribute('title');
      text('today-daily-solar', '—');
      text('today-daily-household', '—');
      text('today-daily-energy-status', '');
    };
    if (document.body.dataset.page === 'previsions') return clear();
    const observed = typeof updatedAt === 'string' ? new Date(updatedAt) : null;
    if (document.hidden || !summary || typeof summary !== 'object' || Array.isArray(summary)
        || !observed || !Number.isFinite(observed.getTime())) return clear();
    const parts = etaDay.formatToParts(observed);
    const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
    const expected = summary.expectedSeconds;
    const knownSource = summary.method === 'recorded_energy' && summary.solarSource === 'GEN24 PV (DC)'
      && summary.householdSource === 'GEN24 household (AC)';
    const recordedMetric = metric => {
      if (!Number.isInteger(metric.sampleCount) || metric.sampleCount < 0
        || (metric.sampleCount === 0 ? metric.energyKwh !== null : metric.energyKwh === null)) return false;
      if (metric.firstObservedAt == null && metric.lastObservedAt == null) return true;
      const first = Date.parse(metric.firstObservedAt), last = Date.parse(metric.lastObservedAt);
      return Number.isFinite(first) && Number.isFinite(last) && first <= last && last <= Date.now() + 5000
        && etaDay.format(new Date(first)) === etaDay.format(observed) && etaDay.format(new Date(last)) === etaDay.format(observed);
    };
    const validMetric = metric => metric && typeof metric === 'object' && !Array.isArray(metric)
      && (metric.energyKwh === null || numeric(metric.energyKwh) && metric.energyKwh >= 0)
      && numeric(metric.coverageSeconds) && metric.coverageSeconds >= 0 && metric.coverageSeconds <= expected
      && recordedMetric(metric);
    if (summary.date !== date || summary.timeZone !== 'Europe/Zurich'
        || ![23, 24, 25].includes(summary.dayHours) || expected !== summary.dayHours * 3600
        || !['unavailable', 'partial', 'collecting', 'complete'].includes(summary.status)
        || !['ready', 'error'].includes(summary.storageStatus) || !knownSource
        || summary.householdIncludesCar !== true || !validMetric(summary.solar) || !validMetric(summary.household)) return clear();
    const samples = summary.solar.sampleCount + summary.household.sampleCount;
    text('today-daily-energy-status', `${summary.storageStatus === 'error' ? 'Enregistrement indisponible · ' : ''}${samples} relevés d’énergie conservés`);
    const times = [summary.solar.firstObservedAt, summary.household.firstObservedAt,
      summary.solar.lastObservedAt, summary.household.lastObservedAt].filter(at => typeof at === 'string').sort();
    details.setAttribute('title', times.length ? `Relevés horodatés de ${observationTime.format(new Date(times[0]))} à ${observationTime.format(new Date(times.at(-1)))}.` : '');
    for (const [id, metric] of [['today-daily-solar', summary.solar], ['today-daily-household', summary.household]]) {
      text(id, metric.energyKwh === null ? '—' : dailyEnergyFormatter.format(metric.energyKwh));
    }
    details.setAttribute('data-state', summary.storageStatus === 'error' ? 'error' : 'partial');
    details.hidden = false;
  }
  function powerParts(value, formatter = powerFormatter) {
    if (!numeric(value)) return { value: '—', unit: '' };
    const watts = Math.round(value * 1000);
    return Math.abs(watts) >= 1000
      ? { value: formatter.format(value), unit: 'kW' }
      : { value: wattFormatter.format(watts), unit: 'W' };
  }
  const power = (value, formatter) => {
    const parts = powerParts(value, formatter);
    return parts.unit ? `${parts.value} ${parts.unit}` : parts.value;
  };
  const timeFormatter = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dateFormatter = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', weekday: 'short', day: 'numeric', month: 'short' });
  const weekdayFormatter = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', weekday: 'long' });
  const time = value => timeFormatter.format(new Date(value));
  function showBatteryDevice(telemetry, automation) {
    const state = byId('battery-state');
    if (!state) return;
    const measured = !document.hidden && numeric(telemetry?.batterySocPercent)
      && telemetry.batterySocPercent >= 0 && telemetry.batterySocPercent <= 100
      && ['online', 'stale'].includes(telemetry.status);
    const live = measured && telemetry.status === 'online';
    const label = live ? 'Connectée' : measured ? 'Mesure ancienne'
      : telemetry?.status === 'not_configured' ? 'Non configurée' : 'Indisponible';
    state.textContent = label;
    state.className = `connection-state ${live ? 'online' : 'warning'}`;
    let activity = '';
    if (live) {
      const charge = telemetry.batteryChargeKw;
      const discharge = telemetry.batteryDischargeKw;
      const supplying = automation?.enabled === true && automation.status === 'holding' && automation.reason === 'solar_battery_support';
      if (automation?.enabled === true && automation.status === 'holding' && automation.reason !== 'solar_battery_support') activity = 'En réserve';
      else if (numeric(charge) && charge > 0 && discharge === 0) activity = `En charge · ${power(charge)}`;
      else if (numeric(discharge) && discharge > 0 && charge === 0) activity = `${supplying ? 'Soutien voiture' : 'En décharge'} · ${power(discharge)}`;
      else if (charge === 0 && discharge === 0) activity = 'Au repos';
    }
    text('battery-detail', [measured ? `${socFormatter.format(telemetry.batterySocPercent)} %` : 'Niveau de charge indisponible',
      activity, 'Via Fronius GEN24'].filter(Boolean).join(' · '));
  }
  function showCar(car, updatedAt) {
    const labels = { not_configured: 'Non connectée', connecting: 'Connexion…', online: 'Connectée', asleep: 'En veille', offline: 'Hors ligne', stale: 'Mesure ancienne', auth_required: 'À reconnecter', error: 'Indisponible' };
    const valid = !document.hidden && car && Object.hasOwn(labels, car.status);
    const connectionForm = byId('tesla-connection');
    if (connectionForm && valid) {
      connectionForm.hidden = !['not_configured', 'auth_required', 'error'].includes(car.status);
      if (connectionForm.hidden) connectionForm.open = false;
    }
    const label = valid ? labels[car.status] : 'Indisponible';
    const observed = valid && typeof car.observedAt === 'string' ? Date.parse(car.observedAt) : NaN;
    const current = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    const measured = valid && numeric(car.socPercent) && car.socPercent >= 0 && car.socPercent <= 100
      && Number.isFinite(observed) && Number.isFinite(current) && observed <= current + 5000;
    const fresh = measured && car.status === 'online' && current - observed <= 600000;
    const soc = measured ? `${socFormatter.format(car.socPercent)} %` : '—';
    const chargeLabels = { Charging: 'En charge', Complete: 'Charge terminée', Stopped: 'Charge arrêtée', Disconnected: 'Débranchée', NoPower: 'Sans alimentation', Starting: 'Démarrage' };
    const stateLabel = fresh && Object.hasOwn(chargeLabels, car.chargingState) ? chargeLabels[car.chargingState] : car?.status === 'online' && !fresh ? 'Mesure ancienne' : label;
    const dated = measured ? `${etaDate.format(new Date(observed))} à ${time(observed)}` : '';
    text('flow-car-soc', soc);
    text('flow-car-state', stateLabel);
    text('tesla-state', valid && car.status === 'online' && !fresh ? 'Mesure ancienne' : label);
    text('tesla-detail', [measured ? soc : 'Niveau de charge indisponible', valid ? car.error : null].filter(Boolean).join(' · '));
    for (const id of ['flow-car-soc', 'tesla-state']) {
      const element = byId(id);
      if (element) {
        element.classList.toggle('warning', valid && !fresh && car.status !== 'not_configured' && car.status !== 'connecting');
        if (id === 'tesla-state') element.removeAttribute('title');
        else element.setAttribute('title', dated ? `Dernier niveau connu · ${dated}` : label);
      }
    }
  }
  function showWattpilot(charger, updatedAt) {
    const labels = { not_configured: 'Non configuré', online: 'Connecté', stale: 'Mesures anciennes', offline: 'Hors ligne', error: 'Indisponible' };
    const valid = !document.hidden && charger && Object.hasOwn(labels, charger.status);
    const current = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    const freshTimestamp = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
      const observed = Date.parse(value);
      const [year, month, day] = value.slice(0, 10).split('-').map(Number);
      const calendar = new Date(Date.UTC(year, month - 1, day));
      return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
        && Number.isFinite(observed) && Number.isFinite(current) && observed <= current + 5000 && current - observed <= 30000;
    };
    const fresh = valid && charger.status === 'online' && charger.configured === true && charger.connected === true
      && charger.ready === true && charger.stale === false && freshTimestamp(charger.observedAt);
    const measured = fresh && numeric(charger.powerWatts) && charger.powerWatts >= 0 && freshTimestamp(charger.powerObservedAt);
    const watts = measured ? Math.round(charger.powerWatts + Number.EPSILON * charger.powerWatts) : null;
    const modeLabels = { pause: 'En pause', eco: 'Mode éco', normal: 'Mode normal' };
    const label = fresh ? labels.online : valid && charger.status === 'online' ? 'Mesures anciennes' : valid ? labels[charger.status] : 'Indisponible';
    text('wattpilot-state', label);
    const state = byId('wattpilot-state');
    if (state) state.className = `connection-state ${fresh ? 'online' : valid && (charger.status === 'stale' || charger.status === 'online') ? 'warning' : ''}`;
    const detail = fresh ? [
      modeLabels[charger.mode] || 'Mode inconnu',
      charger.phaseMode === 1 ? '1 phase' : charger.phaseMode === 3 ? '3 phases'
        : charger.phaseMode === 'auto' ? 'Phases auto' : null,
      numeric(charger.currentAmps) && Number.isInteger(charger.currentAmps) && charger.currentAmps >= 6 && charger.currentAmps <= 32 ? `${wattFormatter.format(charger.currentAmps)} A` : null,
      measured ? power(watts / 1000, flowPowerFormatter) : 'Puissance indisponible',
      charger.carConnected === true ? 'Voiture branchée' : charger.carConnected === false ? 'Voiture débranchée' : null,
      charger.controlEnabled === false ? 'Lecture seule' : null,
    ].filter(Boolean).join(' · ') : valid && typeof charger.error === 'string' && charger.error ? charger.error : 'État de la borne indisponible';
    text('wattpilot-detail', detail);
    text('flow-car-power', measured ? power(watts / 1000, flowPowerFormatter) : '—');
    return watts;
  }
  const automationReasons = new Map([
    ['grid_limit', 'Plafond de consommation de 16 kW atteint'],
    ['site_power_limit', 'Charge batterie réduite pour respecter 16 kW'],
    ['telemetry_unavailable', 'Mesures indisponibles'],
    ['soc_unavailable', 'Charge de la batterie inconnue'],
    ['grid_measurements_unavailable', 'Mesures réseau indisponibles'],
    ['forecast_unavailable', 'Prévision indisponible'],
    ['forecast_wrong_date', 'Prévision à renouveler'],
    ['hourly_forecast_unavailable', 'Prévision horaire indisponible'],
    ['consumption_unavailable', 'Prévision de consommation indisponible'],
    ['forecast_invalid', 'Prévision invalide'],
    ['state_unavailable', 'État du pilotage indisponible'],
    ['controller_unavailable', 'Pilotage indisponible'],
    ['controller_capabilities', 'Limites de charge indisponibles'],
    ['controller_limits', 'Limites de charge indisponibles'],
    ['owned_charge_invalid', 'Charge automatique non confirmée'],
    ['invalid_configuration', 'Configuration à vérifier'],
    ['invalid_clock', 'Horloge à vérifier'],
    ['outside_charging_window', 'Hors créneau de charge'],
    ['energy_shortfall', 'Charge prévue'],
    ['charging_insufficient_capacity_or_time', 'Couverture limitée'],
    ['target_reached', 'Cible atteinte'],
    ['target_reached_capacity_limited', 'Cible atteinte · couverture limitée'],
    ['holding_until_peak', 'Énergie conservée pour le prochain tarif haut'],
    ['preserving_energy', 'Énergie conservée'],
    ['awaiting_evaluation', 'En attente du prochain bilan'],
    ['not_started', 'Premier bilan en attente'],
    ['manual_override', 'Commande manuelle prioritaire'],
    ['disabled', 'Automatisation désactivée'],
    ['charging', 'Charge en cours'],
    ['automation_failed', 'Pilotage indisponible'],
    ['solar_battery_support', 'Soutien voiture avec le solaire stocké'],
  ]);
  function automationReason(plan, reason) {
    if (!(numeric(plan?.nextHighTariffUnmetKwh) && plan.nextHighTariffUnmetKwh > 1e-6)) {
      if (reason === 'charging_insufficient_capacity_or_time') reason = 'energy_shortfall';
      if (reason === 'target_reached_capacity_limited') reason = 'target_reached';
    }
    if (reason === 'energy_shortfall' && numeric(plan?.nextHighTariffChargeNeededKwh) && plan.nextHighTariffChargeNeededKwh >= 0) {
      return plan.nextHighTariffChargeNeededKwh > 1e-6 ? 'Charge nécessaire' : 'Charge de réserve';
    }
    return automationReasons.get(reason);
  }
  function showAutomation(automation) {
    const valid = !document.hidden && automation && typeof automation.enabled === 'boolean'
      && ['disabled', 'idle', 'charging', 'holding', 'manual_override', 'blocked', 'error'].includes(automation.status);
    let label = 'Automatisation indisponible';
    let deviceLabel = 'Inconnu';
    let deviceClass = 'connection-state';
    if (valid) {
      const status = automation.enabled ? automation.status : 'disabled';
      const reason = automationReason(automation.plan, automation.reason);
      if (status === 'disabled') {
        label = 'Planificateur désactivé';
        deviceLabel = 'Désactivée';
      } else if (status === 'manual_override') {
        label = 'Planificateur en pause · commande manuelle';
        deviceLabel = 'En pause';
      } else if (status === 'blocked' || status === 'error') {
        label = `Planificateur ${status === 'error' ? 'en erreur' : 'bloqué'} · ${reason || 'Bilan indisponible'}`;
        deviceLabel = status === 'error' ? 'Erreur' : 'Bloquée';
        deviceClass += ' warning';
      } else if (status === 'holding') {
        const until = typeof automation.holdUntil === 'string' ? new Date(automation.holdUntil) : null;
        const supplying = automation.reason === 'solar_battery_support';
        label = supplying ? 'Planificateur · soutien voiture avec le solaire stocké' : 'Planificateur · batterie en réserve';
        if (until && Number.isFinite(until.getTime())) label += ` jusqu’à ${time(until)}`;
        deviceLabel = supplying ? 'Soutien solaire' : 'Réserve';
        deviceClass += ' online';
      } else if (status === 'charging') {
        label = numeric(automation.plan?.powerKw) ? `Planificateur · charge ${power(automation.plan.powerKw)}` : 'Planificateur · en charge';
        if (numeric(automation.targetSocPercent) && automation.targetSocPercent > 0 && automation.targetSocPercent <= 100) {
          label += ` · cible ${etaSoc.format(automation.targetSocPercent)} %`;
        }
        label += ' · prévision estimée';
        deviceLabel = 'En charge';
        deviceClass += ' online';
      } else {
        const next = typeof automation.nextEvaluationAt === 'string' ? new Date(automation.nextEvaluationAt) : null;
        label = next && Number.isFinite(next.getTime()) ? `Planificateur · prochain bilan ${time(next)}` : 'Planificateur · en attente du prochain bilan';
        deviceLabel = 'Auto';
        deviceClass += ' online';
      }
      if ((status === 'charging' || status === 'holding' || status === 'idle' && automation.reason === 'target_reached_capacity_limited')
          && numeric(automation.plan?.nextHighTariffUnmetKwh) && automation.plan.nextHighTariffUnmetKwh > 1e-6) {
        label += ` · couverture limitée : manque ≈ ${dailyEnergyFormatter.format(automation.plan.nextHighTariffUnmetKwh)} kWh de batterie`;
      }
    }
    text('automation-status', label);
    text('planner-state', deviceLabel);
    const planner = byId('planner-state');
    if (planner) planner.className = deviceClass;
  }
  const carPlanReasons = new Map([
    ['manual_override', 'Recharge manuelle'], ['manual', 'Recharge manuelle'],
    ['not_started', 'En attente du premier bilan'], ['awaiting_evaluation', 'En attente du prochain bilan'],
    ['soc_unavailable', 'Niveau de charge à actualiser'], ['tesla_disconnected', 'Branchement Tesla à vérifier'],
    ['charger_unavailable', 'Borne indisponible'], ['car_unplugged', 'Voiture débranchée'],
    ['current_limits_unavailable', 'Courant disponible inconnu'], ['phase_control_unavailable', 'Réglage des phases indisponible'],
    ['site_unavailable', 'Mesures de la maison indisponibles'], ['battery_coordination_unavailable', 'Coordination avec la batterie indisponible'],
    ['vehicle_charge_limit', 'La limite Tesla est inférieure au minimum demandé'], ['target_reached', 'Minimum atteint'],
    ['required_solar', 'Recharge nécessaire avec le surplus solaire'], ['optional_solar', 'Complément avec le surplus solaire'],
    ['waiting_for_solar', 'En attente de surplus solaire'], ['waiting_for_window', 'En attente du prochain créneau'],
    ['grid_charge', 'Recharge nécessaire en heures creuses'], ['grid_charge_forecast_unavailable', 'Recharge nécessaire · prévision solaire indisponible'],
    ['deadline_infeasible', 'Minimum impossible à atteindre avant le départ'], ['grid_limit', 'Consommation totale limitée à 16 kW'],
    ['deadline_passed', 'Échéance dépassée'], ['target_override_invalid', 'Objectif de départ à vérifier'],
    ['state_unavailable', 'Planification indisponible'], ['ownership_lost', 'Commande manuelle prioritaire'],
    ['config_invalid', 'Paramètres de recharge à vérifier'],
    ['stopped', 'Planification arrêtée'], ['waking', 'Actualisation du niveau de charge Tesla'],
    ['controller_capabilities', 'Pilotage automatique indisponible sur la borne'],
    ['ownership_unavailable', 'Commande de la borne à vérifier'], ['reconciled', 'État de la borne vérifié'],
    ['refreshing_soc', 'Actualisation du niveau de charge Tesla'], ['safety_unavailable', 'Mesures de l’installation indisponibles'],
    ['solar_unverified', 'Surplus solaire non confirmé'], ['outside_charging_window', 'Hors créneau de recharge'],
    ['stopping', 'Arrêt de la recharge en cours'], ['stop_unconfirmed', 'Arrêt non confirmé'],
    ['automation_failed', 'Pilotage voiture indisponible'], ['shutdown_failed', 'Arrêt non confirmé'],
    ['controller_unavailable', 'Borne indisponible'],
    ['eco_default', 'Mode éco selon les réglages de la borne'],
    ['eco_soc_unavailable', 'Mode éco · niveau de charge Tesla à actualiser'],
    ['eco_car_unplugged', 'Mode éco · voiture débranchée'], ['eco_target_reached', 'Minimum atteint · mode éco'],
    ['eco_connection_unknown', 'Mode éco · branchement inconnu'],
    ['eco_tesla_disconnected', 'Mode éco · branchement Tesla à vérifier'], ['eco_deadline_passed', 'Échéance passée · mode éco'],
    ['night_minimum', 'Recharge du minimum du matin'],
    ['night_charge_solar_support', 'Recharge du matin · soutien du solaire stocké'],
    ['afternoon_minimum', 'Recharge de l’après-midi jusqu’à 30 %'],
  ]);
  function showCarPlanner(snapshot) {
    const badge = byId('car-planner-status');
    if (!badge) return;
    const automation = !document.hidden ? snapshot?.carAutomation : null;
    const states = ['manual', 'idle', 'charging', 'eco', 'paused', 'blocked', 'error', 'stopping', 'waking'];
    const valid = automation && typeof automation.enabled === 'boolean' && states.includes(automation.status)
      && !(automation.enabled && automation.status === 'manual')
      && (automation.enabled || ['manual', 'blocked', 'error', 'stopping'].includes(automation.status));
    const candidatePlan = valid && automation.plan && ['available', 'blocked'].includes(automation.plan.status)
      && ['charge', 'eco', 'pause', 'wait'].includes(automation.plan.action) ? automation.plan : null;
    const timestamp = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
      const date = new Date(value);
      const [year, month, day] = value.slice(0, 10).split('-').map(Number);
      const calendar = new Date(Date.UTC(year, month - 1, day));
      return Number.isFinite(date.getTime()) && calendar.getUTCFullYear() === year
        && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day ? date : null;
    };
    const current = timestamp(snapshot?.updatedAt);
    const plannedAt = timestamp(candidatePlan?.calculatedAt);
    const plan = plannedAt && current && plannedAt.getTime() <= current.getTime() + 5000 ? candidatePlan : null;
    const fresh = value => {
      const date = timestamp(value);
      return date && current && date.getTime() <= current.getTime() + 5000 && current.getTime() - date.getTime() <= 600000;
    };
    const percent = value => numeric(value) && value >= 0 && value <= 100 ? `${socFormatter.format(value)} %` : '—';
    const energy = value => numeric(value) && value >= 0 ? `≈ ${dailyEnergyFormatter.format(value)} kWh` : '—';
    const dateTime = value => {
      const date = timestamp(value);
      return date ? `${dateFormatter.format(date)} · ${time(date)}` : '—';
    };
    const target = !document.hidden ? plan?.target || snapshot?.carTarget : null;
    const deadline = timestamp(target?.deadline);
    const targetValid = numeric(target?.minimumSocPercent) && target.minimumSocPercent > 0
      && target.minimumSocPercent <= 100 && deadline;
    text('car-planner-target', targetValid ? `${etaSoc.format(target.minimumSocPercent)} % · ${dateTime(target.deadline)}` : '—');
    text('car-planner-target-label', target?.kind === 'afternoon' ? 'Minimum de l’après-midi' : 'Minimum du matin');
    const car = !document.hidden ? snapshot?.car : null;
    const observedCarAt = timestamp(car?.observedAt);
    const knownCar = ['online', 'stale', 'asleep', 'offline', 'connecting', 'auth_required', 'error'].includes(car?.status)
      && observedCarAt && current && observedCarAt.getTime() <= current.getTime() + 5000
      && numeric(car.socPercent) && car.socPercent >= 0 && car.socPercent <= 100;
    const measuredPlan = (!car || car.status === 'online') && plan && fresh(plan.observedAt)
      && numeric(plan.socPercent) && plan.socPercent >= 0 && plan.socPercent <= 100;
    text('car-planner-soc', percent(knownCar ? car.socPercent : measuredPlan ? plan.socPercent : null));
    const socElement = byId('car-planner-soc');
    const observedAt = knownCar ? car.observedAt : measuredPlan ? plan.observedAt : null;
    const historical = knownCar && (car.status !== 'online' || !fresh(car.observedAt));
    if (observedAt) socElement.setAttribute('title', `${historical ? 'Dernier niveau connu' : 'Mesure du'} ${dateTime(observedAt)}`);
    else socElement.removeAttribute('title');
    const labels = { manual: 'Manuel', idle: 'Auto · en attente', charging: 'Auto · en charge', eco: 'Auto · éco', paused: 'Auto · en pause',
      blocked: 'Bloquée', error: 'Indisponible', stopping: 'Arrêt en cours', waking: 'Lecture Tesla' };
    const oldPlan = valid && automation.enabled && ['idle', 'charging', 'paused'].includes(automation.status)
      && plan?.observedAt && !measuredPlan;
    badge.textContent = oldPlan ? 'Mesure ancienne' : valid ? labels[automation.status] : 'Indisponible';
    badge.className = `badge ${oldPlan || valid && (['blocked', 'error', 'stopping'].includes(automation.status) || plan?.feasible === false) ? 'warning'
      : valid && automation.enabled ? 'online' : 'neutral'}`;
    text('car-planner-reason', oldPlan ? 'Niveau de charge à actualiser'
      : valid ? carPlanReasons.get(automation.reason) || carPlanReasons.get(plan?.reason)
        || (automation.status === 'manual' ? 'Recharge manuelle' : 'Bilan indisponible') : 'Planification indisponible');
    const estimates = valid && automation.enabled && measuredPlan && !['manual', 'error', 'stopping', 'waking'].includes(automation.status);
    const nativeEco = plan?.action === 'eco' || plan?.source === 'eco';
    text('car-planner-remaining', energy(estimates ? plan.requiredAcKwh : null));
    text('car-planner-solar', energy(estimates && !nativeEco ? plan.solarKwh : null));
    text('car-planner-grid', energy(estimates && !nativeEco ? plan.gridKwh : null));
    const support = valid && automation.enabled && plan?.batterySupport && typeof plan.batterySupport === 'object' ? plan.batterySupport : null;
    const knownSolar = support?.available === true && numeric(support.solarStoredKwh) && support.solarStoredKwh >= 0
      && numeric(support.usableStoredKwh) && support.usableStoredKwh >= 0 && support.usableStoredKwh <= support.solarStoredKwh;
    byId('car-planner-battery-solar-row').hidden = !support;
    byId('car-planner-battery-reserve-row').hidden = !support;
    text('car-planner-battery-solar', energy(knownSolar ? support.usableStoredKwh : null));
    text('car-planner-battery-reserve', energy(support?.protectedStoredKwh));
    const finish = estimates && !nativeEco && plan.status === 'available' && plan.feasible === true
      && !['blocked', 'error', 'stopping', 'waking'].includes(automation.status) ? timestamp(plan.estimatedCompletionAt) : null;
    text('car-planner-finish', finish && current && finish.getTime() >= current.getTime()
      && deadline && finish.getTime() <= deadline.getTime() ? `≈ ${dateTime(plan.estimatedCompletionAt)}` : '—');
    text('car-planner-next', valid && automation.enabled ? dateTime(automation.nextEvaluationAt) : '—');
    const unmet = estimates && plan.feasible === false && numeric(plan.unmetKwh) && plan.unmetKwh > 0;
    byId('car-planner-unmet-row').hidden = !unmet;
    text('car-planner-unmet', energy(unmet ? plan.unmetKwh : null));
  }
  function showPlanner(snapshot) {
    if (!byId('planner-current-heading')) return;
    const current = Date.now();
    const details = !document.hidden ? snapshot?.planner : null;
    const automation = !document.hidden ? snapshot?.automation : null;
    const battery = details?.battery;
    const peak = details?.highTariff;
    const energy = value => numeric(value) && value >= 0 ? `${dailyEnergyFormatter.format(value)} kWh` : '—';
    const percent = value => numeric(value) && value >= 0 && value <= 100 ? `${etaSoc.format(value)} %` : '—';
    const dateTime = value => {
      const date = typeof value === 'string' ? new Date(value) : null;
      return date && Number.isFinite(date.getTime()) ? `${dateFormatter.format(date)} · ${time(date)}` : '—';
    };
    const validAutomation = automation && typeof automation.enabled === 'boolean'
      && ['disabled', 'idle', 'charging', 'holding', 'manual_override', 'blocked', 'error'].includes(automation.status);
    const status = validAutomation ? automation.enabled ? automation.status : 'disabled' : null;
    const showPredictions = validAutomation && automation.enabled && !['disabled', 'manual_override'].includes(status)
      && !(battery?.mode === 'manual' && battery.automated !== true);
    const hasCalculation = details && Object.hasOwn(details, 'calculation');
    const charging = hasCalculation ? details.calculation?.charging : snapshot?.charging;
    const upcoming = charging?.allowed === false && showPredictions ? details?.upcomingPlan : null;
    const windowStart = typeof upcoming?.start === 'string' ? new Date(upcoming.start) : null;
    const windowEnd = typeof upcoming?.end === 'string' ? new Date(upcoming.end) : null;
    const preview = windowStart && windowEnd && Number.isFinite(windowStart.getTime())
      && Number.isFinite(windowEnd.getTime()) && windowEnd > windowStart && windowEnd.getTime() > current
      && ['charge', 'hold', 'blocked'].includes(upcoming?.plan?.action) ? upcoming.plan : null;
    const futureStart = preview && windowStart.getTime() > current;
    const plan = showPredictions ? preview || (hasCalculation ? details.calculation?.plan : automation.plan) : null;
    // A closing-buffer preview may prepare a later tariff than the imminent one.
    const coveragePlan = preview && peak?.isCurrent !== true
      && Date.parse(peak?.start) !== windowEnd.getTime() + 5 * 60_000 ? null : plan;
    text('planner-period', preview ? futureStart ? 'Prochain créneau' : 'Créneau en cours' : showPredictions && charging?.allowed === true ? 'Créneau en cours' : '—');
    text('planner-window', preview ? `${dateTime(upcoming.start)} → ${dateTime(upcoming.end)}` : '—');
    byId('planner-window-row').hidden = !preview;
    text('planner-start-soc', futureStart ? percent(upcoming.estimatedSocPercent) : '—');
    byId('planner-start-soc-row').hidden = !futureStart;
    const controllerLabel = battery?.mode === 'auto' ? 'GEN24 · auto' : battery?.mode === 'manual'
      ? battery.automated === true ? battery.automationMode === 'supply' ? 'Soutien voiture · solaire'
        : battery.powerKw === 0 ? 'Planificateur · réserve' : 'Planificateur · charge' : 'Manuel'
      : 'Indisponible';
    text('planner-mode', controllerLabel);
    const mode = byId('planner-mode');
    mode.className = `badge ${['charging', 'holding', 'idle'].includes(status) ? 'online' : ['blocked', 'error'].includes(status) ? 'warning' : 'neutral'}`;
    text('planner-reason', validAutomation ? automationReason(coveragePlan, preview ? preview.reason : automation.reason) || 'Bilan indisponible' : 'Bilan indisponible');
    const afternoonGoal = plan?.afternoonTargetSocPercent;
    const afternoonGoalAt = typeof plan?.afternoonTargetAt === 'string' ? new Date(plan.afternoonTargetAt) : null;
    const showAfternoonGoal = numeric(afternoonGoal) && afternoonGoal >= 0 && afternoonGoal <= 100
      && afternoonGoalAt && Number.isFinite(afternoonGoalAt.getTime()) && afternoonGoalAt.getTime() > current;
    const todayParts = etaDay.formatToParts(new Date());
    const calendarPart = type => Number(todayParts.find(part => part.type === type).value);
    // Advance the Zurich calendar date, rather than 24 hours across a DST change.
    const tomorrow = new Date(Date.UTC(calendarPart('year'), calendarPart('month') - 1, calendarPart('day') + 1));
    const goalDay = showAfternoonGoal && etaDay.format(afternoonGoalAt) === etaDay.format(tomorrow) ? 'demain ' : '';
    text('planner-afternoon-goal-label', showAfternoonGoal ? `Objectif ${goalDay}à ${time(afternoonGoalAt)}` : '—');
    text('planner-afternoon-goal', showAfternoonGoal ? percent(afternoonGoal) : '—');
    byId('planner-afternoon-goal-row').hidden = !showAfternoonGoal;
    const afternoonEstimate = details?.afternoonEstimate;
    const matchingEstimate = showAfternoonGoal && Date.parse(afternoonEstimate?.at) === afternoonGoalAt.getTime();
    text('planner-afternoon-estimate-label', showAfternoonGoal ? `Batterie estimée ${goalDay}à ${time(afternoonGoalAt)}` : '—');
    text('planner-afternoon-estimate', percent(matchingEstimate ? afternoonEstimate.socPercent : null));
    byId('planner-afternoon-estimate-row').hidden = !showAfternoonGoal;

    const supplying = !preview && battery?.automated === true && battery.automationMode === 'supply';
    text('planner-power-label', supplying ? 'Soutien solaire maximal' : 'Consigne de puissance');
    text('planner-power', preview ? preview.action === 'blocked' ? '—' : power(preview.action === 'charge' ? preview.powerKw : 0)
      : numeric(battery?.powerKw) ? power(supplying ? Math.abs(battery.powerKw) : battery.powerKw) : '—');
    if (preview) {
      text('planner-charge-remaining', preview.action === 'charge' ? 'En attente du créneau' : '—');
      const completion = typeof upcoming.estimatedCompletionAt === 'string' ? Date.parse(upcoming.estimatedCompletionAt) : NaN;
      const knownCompletion = preview.action === 'charge' && numeric(upcoming.estimatedSocPercent)
        && upcoming.estimatedSocPercent >= 0 && upcoming.estimatedSocPercent <= 100
        && completion >= windowStart.getTime() && completion <= windowEnd.getTime() && completion > current;
      text('planner-charge-end', knownCompletion ? `≈ ${dateTime(upcoming.estimatedCompletionAt)}` : '—');
    }
    if (supplying) {
      text('planner-charge-remaining', '—');
      text('planner-charge-end', '—');
    }
    text('planner-next', validAutomation ? dateTime(automation.nextEvaluationAt) : '—');
    text('planner-last', validAutomation ? dateTime(automation.lastEvaluatedAt) : '—');
    const hold = validAutomation && status === 'holding' ? dateTime(automation.holdUntil) : '—';
    text('planner-hold-until', hold);
    byId('planner-hold-row').hidden = hold === '—';
    text('planner-soc', percent(battery?.socPercent));
    text('planner-available', energy(battery?.availableKwh));
    const breakdown = details?.chargeBreakdown;
    const matchingDeadline = showAfternoonGoal && Date.parse(breakdown?.end) === afternoonGoalAt.getTime();
    const storedBasisKwh = breakdown?.storedKwh;
    const matchingGap = matchingDeadline && numeric(storedBasisKwh) && storedBasisKwh >= 0
      && numeric(battery?.capacityKwh) && battery.capacityKwh > 0 && storedBasisKwh <= battery.capacityKwh
      && numeric(breakdown?.consumptionKwh) && breakdown.consumptionKwh >= 0
      && numeric(breakdown?.gapKwh) && Math.abs(breakdown.gapKwh
        - Math.max(0, afternoonGoal / 100 * battery.capacityKwh - storedBasisKwh + breakdown.consumptionKwh)) < 1e-6;
    const gapKwh = matchingGap ? breakdown.gapKwh : null;
    text('planner-gap-label', showAfternoonGoal ? `À ajouter pour ${goalDay}${time(afternoonGoalAt)}` : 'À ajouter pour la cible');
    text('planner-gap', energy(gapKwh));
    const matchingBreakdown = numeric(gapKwh) && gapKwh >= 0 && numeric(breakdown?.gapKwh)
      && Math.abs(breakdown.gapKwh - gapKwh) < 1e-6
      && matchingDeadline
      && [breakdown?.solarKwh, breakdown?.gridKwh, breakdown?.unmetKwh].every(value => numeric(value) && value >= 0)
      && Math.abs(breakdown.solarKwh + breakdown.gridKwh + breakdown.unmetKwh - gapKwh) < 1e-6;
    const estimatedEnergy = value => value > 0 ? `≈ ${energy(value)}` : energy(value);
    text('planner-gap-solar', matchingBreakdown ? estimatedEnergy(breakdown.solarKwh) : '—');
    text('planner-gap-grid', matchingBreakdown ? estimatedEnergy(breakdown.gridKwh) : '—');
    text('planner-gap-unmet', matchingBreakdown ? estimatedEnergy(breakdown.unmetKwh) : '—');
    byId('planner-gap-unmet-row').hidden = !matchingBreakdown || breakdown.unmetKwh < 1e-6;
  }
  let activeRead = null;
  let refreshStartedAt = 0;
  let timer;
  let lastConnectionState;

  function clock() {
    const now = new Date();
    text('local-time', time(now));
    text('local-date', dateFormatter.format(now));
    const marker = byId('now-marker');
    if (marker) {
      const parts = timeFormatter.formatToParts(now);
      const hours = Number(parts.find(part => part.type === 'hour').value);
      const minutes = Number(parts.find(part => part.type === 'minute').value);
      marker.style.left = `${Math.min(98.5, Math.max(1.5, (hours * 60 + minutes) / 1440 * 100))}%`;
      marker.hidden = false;
    }
  }

  function connection(state, message) {
    const labels = { online: 'Connexion rétablie', stale: 'Mesures anciennes', offline: 'GEN24 indisponible', not_configured: 'GEN24 non configuré' };
    const label = labels[state] || 'Tableau de bord indisponible';
    text('gen24-state', state === 'online' ? 'Connecté' : state === 'stale' ? 'Ancien' : state === 'not_configured' ? 'Non configuré' : 'Indisponible');
    const deviceState = byId('gen24-state');
    if (deviceState) deviceState.className = `connection-state ${state === 'online' ? 'online' : state === 'stale' ? 'warning' : ''}`;
    byId('connection-notice').hidden = !message;
    text('connection-notice', message || '');
    byId('flow-stage')?.classList.toggle('stale', state === 'stale');
    text('flow-state', state === 'online' ? 'EN DIRECT' : state === 'stale' ? 'ANCIEN' : 'EN ATTENTE');
    if (state !== lastConnectionState) {
      text('announcements', label);
      lastConnectionState = state;
    }
  }

  function readings(telemetry, automation, carPower = null) {
    if (!byId('flow-stage')) return;
    byId('flow-stage').classList.toggle('paused', document.hidden);
    const t = telemetry;
    const toWatts = value => {
      if (!numeric(value) || value < 0) return null;
      const watts = value * 1000;
      // Compensate for binary error at half-watt boundaries, e.g. 0.5005 kW.
      return Math.round(watts + Number.EPSILON * watts);
    };
    const values = [t.solarKw, t.gridImportKw, t.batteryDischargeKw, t.householdKw, t.batteryChargeKw, t.gridExportKw].map(toWatts);
    const [solar, gridImport, discharge, house, charge, gridExport] = values;
    const solarPower = solar !== null && t.solarKw < 0.005 ? 0 : solar;
    const grid = gridImport !== null && gridExport !== null ? gridImport - gridExport
      : gridExport > 0 ? -gridExport : gridImport;
    const battery = discharge !== null && charge !== null ? discharge - charge
      : charge > 0 ? -charge : discharge;
    const exporting = numeric(grid) && grid < 0;
    const charging = numeric(battery) && battery < 0;
    const discharging = numeric(battery) && battery > 0;
    const batteryPower = numeric(battery) ? Math.abs(battery) : null;
    const supplying = t.status === 'online' && automation?.enabled === true && automation.status === 'holding'
      && automation.reason === 'solar_battery_support';
    const holding = t.status === 'online' && automation?.enabled === true && automation.status === 'holding' && !supplying;
    let householdPower = house;
    if (t.status === 'online' && values.every(numeric)) {
      // Balance the rounded whole-watt readings before display formatting, including the solar filter.
      const adjustedHouseWatts = solarPower + grid + battery;
      householdPower = adjustedHouseWatts >= 0 ? adjustedHouseWatts : null;
    }
    if (numeric(householdPower) && numeric(carPower)) {
      householdPower = householdPower >= carPower ? householdPower - carPower : null;
    }
    const flowPower = watts => power(numeric(watts) ? watts / 1000 : null, flowPowerFormatter);
    text('flow-solar', flowPower(solarPower));
    text('flow-grid', flowPower(numeric(grid) ? Math.abs(grid) : null));
    const totalConsumptionKw = numeric(t.householdKw) && numeric(t.batteryChargeKw) ? t.householdKw + t.batteryChargeKw : null;
    const gridDirection = numeric(grid) ? exporting ? 'Injection' : grid > 0 ? 'Import' : 'Aucun échange' : 'Aucune mesure';
    text('flow-grid-direction', `${gridDirection}${numeric(totalConsumptionKw) && totalConsumptionKw > 16 ? ' · consommation totale > 16 kW' : ''}`);
    text('flow-home', flowPower(householdPower));
    byId('flow-home')?.setAttribute('title', numeric(carPower)
      ? 'Consommation maison hors recharge voiture, avec le résiduel des flux mesurés.'
      : 'Consommation maison incluant la recharge voiture, avec le résiduel des flux mesurés.');
    text('flow-battery', flowPower(batteryPower));
    text('flow-battery-soc', numeric(t.batterySocPercent) ? `${socFormatter.format(t.batterySocPercent)} %` : '—');
    text('flow-battery-direction', holding ? 'En réserve' : charging ? 'En charge' : discharging ? supplying ? 'Soutien voiture' : 'En décharge' : numeric(batteryPower) ? 'Au repos' : 'Aucune mesure');
    // Every connector runs from its component toward the central junction.
    for (const [id, value, reverse] of [
      ['solar-line', solarPower, false],
      ['grid-line', numeric(grid) ? Math.abs(grid) : null, exporting],
      ['battery-line', batteryPower, charging],
      ['home-line', householdPower, true],
      ['car-line', carPower, true],
    ]) {
      const line = byId(id);
      if (!line) continue;
      const flowing = numeric(value) && value > 0;
      line.classList.toggle('active', !document.hidden && (id === 'car-line' || t.status === 'online') && flowing);
      line.classList.toggle('reverse', flowing && reverse);
      line.classList.toggle('unavailable', !numeric(value));
    }
  }

  function policy(snapshot) {
    const target = snapshot.carTarget;
    text('car-target-value', String(target.minimumSocPercent));
    text('car-target-summary', `${weekdayFormatter.format(new Date(target.deadline))} à ${time(target.deadline)} · ${target.reason} · Fin réseau ${time(target.gridChargingEndsAt)}.`);
    const low = snapshot.tariff.kind === 'low';
    const c = snapshot.charging;
    const tariffBadge = byId('tariff-badge');
    if (!tariffBadge) return;
    tariffBadge.className = `badge tariff-badge ${low ? 'online' : 'warning'}`;
    text('tariff-badge', low ? 'Tarif bas' : 'Tarif haut');
    text('tariff-price', powerFormatter.format(snapshot.tariff.priceCts));
    text('tariff-until', `Tarif ${low ? 'bas' : 'haut'} jusqu’à ${time(snapshot.tariff.nextChangeAt)} · Zurich`);
    text('window-status', c.allowed ? 'Ouvert' : c.phase === 'buffer' ? 'Marge de sécurité' : 'Fermé');
    text('window-detail', c.allowed ? `${c.currentWindow === 'night' ? 'Nuit' : 'Après-midi'} jusqu’à ${time(c.nextWindow.end)}.` : `${c.nextWindow.label} le ${dateFormatter.format(new Date(c.nextWindow.start))} à ${time(c.nextWindow.start)}.`);
  }

  function clearReadings() {
    showBatteryDevice(null);
    showCar(null);
    showWattpilot(null);
    showAutomation(null);
    showPlanner(null);
    showCarPlanner(null);
    showDailyEnergy(null);
    showChargeEstimate(null);
    text('car-target-value', '—');
    text('car-target-summary', 'Objectif indisponible.');
    readings({ status: 'offline', solarKw: null, householdKw: null, gridImportKw: null, gridExportKw: null, batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null });
    text('tariff-badge', 'Tarif indisponible');
    const tariffBadge = byId('tariff-badge');
    if (tariffBadge) tariffBadge.className = 'badge tariff-badge neutral';
    text('tariff-price', '—');
    text('tariff-until', 'En attente de l’orchestrateur');
    text('window-status', 'Créneau indisponible');
    text('window-detail', 'Horaires ci-dessous.');
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden && !activeRead) timer = setTimeout(refresh, Math.min(10000, Math.max(1000, refreshStartedAt + 10000 - Date.now())));
  }

  async function refresh() {
    if (activeRead || document.hidden) return;
    refreshStartedAt = Date.now();
    clearTimeout(timer);
    const controller = new AbortController();
    const request = { controller };
    activeRead = request;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(document.body.dataset.page === 'planification' ? '/api/planner' : '/api/status', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('État indisponible');
      const snapshot = await response.json();
      if (activeRead !== request || document.hidden) return;
      showAutomation(snapshot.automation);
      showDailyEnergy(snapshot.dailyEnergy, snapshot.updatedAt);
      policy(snapshot);
      const carPower = showWattpilot(snapshot.wattpilot, snapshot.updatedAt);
      readings(snapshot.telemetry, snapshot.automation, carPower);
      showBatteryDevice(snapshot.telemetry, snapshot.automation);
      showCar(snapshot.car, snapshot.updatedAt);
      const t = snapshot.telemetry;
      const supplying = snapshot.automation?.status === 'holding' && snapshot.automation.reason === 'solar_battery_support';
      showChargeEstimate(t.status === 'online' && !supplying ? snapshot.batteryChargeEstimate : null);
      showPlanner(snapshot);
      showCarPlanner(snapshot);
      const fallback = t.status === 'stale' ? 'Mesures anciennes · état actuel non confirmé.' : t.status === 'not_configured' ? 'GEN24 non configuré.' : t.status === 'offline' ? 'GEN24 indisponible · nouvelle tentative automatique.' : '';
      connection(t.status, fallback);
    } catch {
      if (activeRead === request && !document.hidden) {
        clearReadings();
        connection('offline', 'Connexion perdue · nouvelle tentative automatique.');
      }
    } finally {
      clearTimeout(timeout);
      if (activeRead === request) {
        activeRead = null;
        schedule();
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) {
      const request = activeRead;
      activeRead = null;
      request?.controller.abort();
      showAutomation(null);
      showPlanner(null);
      showCarPlanner(null);
      byId('flow-stage')?.classList.add('paused');
      showChargeEstimate(null);
      showDailyEnergy(null);
      showCar(null);
      showBatteryDevice(null);
      showWattpilot(null);
      const carLine = byId('car-line');
      carLine?.classList.remove('active');
      carLine?.classList.remove('reverse');
      carLine?.classList.add('unavailable');
    }
    if (!document.hidden) refresh();
  });
  document.addEventListener('tesla-connection-change', () => {
    clearTimeout(timer);
    clearReadings();
    void refresh();
  });
  byId('flow-stage')?.classList.toggle('paused', document.hidden);
  clock();
  setInterval(clock, 1000);
  refresh();
})();
