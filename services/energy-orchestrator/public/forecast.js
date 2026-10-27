(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  if (!byId('solar-forecast') && !byId('today-solar-forecast') && !byId('weather-state')) return;
  const text = (id, value) => {
    const element = byId(id);
    if (element) element.textContent = value;
  };
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const integer = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 1 });
  const dateFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', weekday: 'short', day: 'numeric', month: 'short' });
  const timeFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });
  const states = {
    online: ['', 'Connectée', 'online'],
    stale: ['À actualiser', 'Ancienne', 'warning'],
    offline: ['Indisponible', 'Indisponible', ''],
    not_configured: ['Localisation à définir', 'Non configurée', ''],
  };
  const desktopHome = document.body?.dataset.page === 'accueil'
    ? window.matchMedia('(min-width: 701px)')
    : null;
  const visible = () => !document.hidden && (desktopHome?.matches ?? true);

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function weather(code) {
    if (!Number.isInteger(code)) return '';
    if (code === 0) return 'Ensoleillé';
    if (code === 1) return 'Peu nuageux';
    if (code === 2) return 'Éclaircies';
    if (code === 3) return 'Couvert';
    if ([45, 48].includes(code)) return 'Brouillard';
    if ([51, 53, 55].includes(code)) return 'Bruine';
    if ([56, 57, 66, 67].includes(code)) return 'Pluie verglaçante';
    if ([61, 63, 65].includes(code)) return 'Pluie';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Neige';
    if ([80, 81, 82].includes(code)) return 'Averses';
    if ([95, 96, 99].includes(code)) return 'Orages';
    return '';
  }

  function localDate(date) {
    const parts = Object.fromEntries(dayParts.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  // Accept complete calendar days only: a missing hour is unknown, never zero.
  function hourlySeries(series, date, key, dailyTotal, tolerance) {
    if (!validDate(date) || !Array.isArray(series) || ![23, 24, 25].includes(series.length)) return null;
    let previousEnd;
    let sum = 0;
    for (const row of series) {
      if (!row || typeof row !== 'object' || typeof row.start !== 'string' || typeof row.end !== 'string'
        || !row.start.endsWith('Z') || !row.end.endsWith('Z') || !numeric(row[key]) || row[key] < 0) return null;
      const start = Date.parse(row.start);
      const end = Date.parse(row.end);
      if (!Number.isFinite(start) || end - start !== 3600000 || (previousEnd !== undefined && start !== previousEnd)
        || localDate(new Date(start)) !== date) return null;
      if (previousEnd === undefined && timeFormat.format(new Date(start)) !== '00:00') return null;
      previousEnd = end;
      sum += row[key];
    }
    const nextDate = new Date(`${date}T12:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    if (localDate(new Date(previousEnd)) !== nextDate.toISOString().slice(0, 10)
      || timeFormat.format(new Date(previousEnd)) !== '00:00'
      || !numeric(dailyTotal) || Math.abs(sum - dailyTotal) > tolerance) return null;
    return series;
  }

  function publishedSeries(data, series, quarters, key, total, tolerance) {
    let hours, from, end;
    if (data.forecastPeriod !== undefined) {
      const period = data.forecastPeriod;
      const start = Date.parse(period?.start), until = Date.parse(period?.end), cutoff = Date.parse(period?.from);
      const count = (until - start) / 3600000;
      if (![23, 24, 25].includes(count) || !Number.isFinite(cutoff) || cutoff % 3600000 !== 0 || cutoff < start || cutoff > until) return null;
      hours = Array.from({ length: count }, (_, index) => ({ start: new Date(start + index * 3600000).toISOString(),
        end: new Date(start + (index + 1) * 3600000).toISOString(), known: 0 }));
      if (!hourlySeries(hours, data.date, 'known', 0, 0)) return null;
      from = cutoff; end = until;
    } else {
      if (!hourlySeries(series, data.date, key, total, tolerance)) return null;
      hours = series.map(row => ({ start: row.start, end: row.end }));
      from = Date.parse(hours[0].start); end = Date.parse(hours.at(-1).end);
    }
    const valid = (values, step) => {
      if (!Array.isArray(values)) return false;
      let cursor = from, sum = 0;
      for (const row of values) {
        const start = Date.parse(row?.start), finish = Date.parse(row?.end);
        if (typeof row?.start !== 'string' || !row.start.endsWith('Z') || typeof row?.end !== 'string' || !row.end.endsWith('Z')
          || start !== cursor || !Number.isFinite(finish) || finish <= start || finish - start > step || finish % step !== 0
          || !numeric(row[key]) || row[key] < 0) return false;
        cursor = finish; sum += row[key];
      }
      return cursor === end && numeric(total) && Math.abs(sum - total) <= tolerance;
    };
    if (!valid(series, 3600000)) return null;
    const native = quarters !== undefined && quarters !== null;
    if (native && !valid(quarters, 900000)) return null;
    if (native && series.some(hour => Math.abs(quarters.filter(point => Date.parse(point.start) >= Date.parse(hour.start)
      && Date.parse(point.end) <= Date.parse(hour.end)).reduce((sum, point) => sum + point[key], 0) - hour[key]) > tolerance)) return null;
    return { total };
  }

  function render(prefix, value) {
    const scoped = id => byId(`${prefix}${id}`);
    const write = (id, value) => text(`${prefix}${id}`, value);
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const productionForecast = publishedSeries(data, data.hourly, data.quarterHourly, 'estimatedProductionKwh', data.estimatedProductionKwh, .051);
    const learned = Object.hasOwn(data, 'householdForecast');
    const consumption = learned ? data.householdForecast : data.consumption;
    const consumptionForecast = consumption ? publishedSeries(learned ? { date: data.date } : data, consumption.hourly, learned ? consumption.slots : consumption.quarterHourly,
      'estimatedConsumptionKwh', consumption.estimatedConsumptionKwh, .001) : null;
    const storedDay = Object.hasOwn(data, 'dailyTotals');
    const totals = data.dailyTotals;
    const storedTotal = key => validDate(data.date) && totals?.date === data.date
      && numeric(totals[key]) && totals[key] >= 0 ? totals[key] : null;
    const productionTotal = storedDay ? storedTotal('productionKwh') : productionForecast?.total
      ?? (data.hourly == null && data.quarterHourly == null ? data.estimatedProductionKwh : null);
    const consumptionTotal = storedDay ? storedTotal('consumptionKwh') : consumptionForecast?.total
      ?? (!learned && consumption?.hourly == null && consumption?.quarterHourly == null ? consumption?.estimatedConsumptionKwh : null);
    let state = Object.hasOwn(states, data.status) ? data.status : 'offline';
    if ((state === 'online' || state === 'stale')
      && (!validDate(data.date) || !numeric(productionTotal) || productionTotal < 0)) state = 'offline';
    const available = storedDay ? numeric(productionTotal) : state === 'online' || state === 'stale';
    const labels = states[state];
    const panel = scoped('solar-forecast');
    if (panel) panel.dataset.state = state;
    write('forecast-energy', available ? decimal.format(productionTotal) : '—');
    const hasConsumption = storedDay ? numeric(consumptionTotal) : validDate(data.date) && consumption && typeof consumption === 'object'
      && consumption.date === data.date && (learned ? ['measured_history', 'recent_average', 'configured_baseline', 'mixed'].includes(consumption.source) && consumption.scope === 'household_excluding_car' && consumption.excludesCar === true
        : consumption.source === 'configured_baseline' && consumption.excludesCar === true)
      && numeric(consumptionTotal) && consumptionTotal >= 0;
    write('forecast-consumption', hasConsumption ? integer.format(consumptionTotal) : '—');
    const chargingTotal = storedTotal('chargingKwh');
    write('forecast-car', chargingTotal !== null ? decimal.format(chargingTotal) : '—');
    write('forecast-date', available || hasConsumption ? dateFormat.format(new Date(`${data.date}T12:00:00Z`)) : '');
    write('forecast-location', typeof data.locationName === 'string' ? data.locationName : '');
    const details = [];
    if (available) {
      const condition = weather(data.weatherCode);
      if (condition) details.push(condition);
      if (numeric(data.temperatureMinC) && numeric(data.temperatureMaxC) && data.temperatureMinC <= data.temperatureMaxC) {
        details.push(`${integer.format(data.temperatureMinC)}–${integer.format(data.temperatureMaxC)} °C`);
      }
    }
    const weatherSummary = details.join(' - ') || 'Météo indisponible';
    write('forecast-status', available
      ? [weatherSummary, state === 'stale' ? labels[0] : ''].filter(Boolean).join(' · ')
      : hasConsumption ? (state === 'not_configured' ? 'Solaire à configurer' : 'Solaire indisponible') : labels[0]);
    const refreshTime = value => {
      const date = typeof value === 'string' ? new Date(value) : null;
      return date && Number.isFinite(date.getTime()) ? timeFormat.format(date) : '—';
    };
    write('forecast-updated', `Bilan : ${refreshTime(data.estimates?.calculatedAt)} · Solaire : ${refreshTime(available ? data.fetchedAt : null)}`);
    const device = prefix === '' ? byId('weather-state') : null;
    if (device) {
      device.textContent = labels[1];
      device.className = `connection-state${labels[2] ? ` ${labels[2]}` : ''}`;
    }
  }

  function createReader(prefix, endpoint) {
    let activeRead = null;
    let timer;
    let refreshStartedAt = 0;

    function schedule() {
      clearTimeout(timer);
      if (visible() && !activeRead) timer = setTimeout(refresh, Math.min(10000, Math.max(1000, refreshStartedAt + 10000 - Date.now())));
    }

    async function refresh() {
      if (activeRead || !visible()) return;
      clearTimeout(timer);
      refreshStartedAt = Date.now();
      const request = { controller: new AbortController(), timeout: null, cancel: null };
      activeRead = request;
      try {
        const operation = (async () => {
          const response = await fetch(endpoint, { signal: request.controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('Prévision indisponible');
          return response.json();
        })();
        const deadline = new Promise((_, reject) => {
          request.cancel = () => reject(new Error('Prévision indisponible'));
          request.timeout = setTimeout(() => {
            request.controller.abort();
            request.cancel();
          }, 8000);
        });
        const data = await Promise.race([operation, deadline]);
        if (activeRead === request && visible()) render(prefix, data);
      } catch {
        if (activeRead === request && visible()) render(prefix, { status: 'offline' });
      } finally {
        clearTimeout(request.timeout);
        if (activeRead === request) {
          activeRead = null;
          schedule();
        }
      }
    }

    function visibilityChanged() {
      clearTimeout(timer);
      if (!visible()) {
        const request = activeRead;
        activeRead = null;
        if (request) {
          clearTimeout(request.timeout);
          request.controller.abort();
          request.cancel();
        }
        return;
      }
      refresh();
    }

    return { refresh, visibilityChanged };
  }

  const readers = [];
  if (byId('today-solar-forecast')) readers.push(createReader('today-', '/api/forecast/today'));
  if (byId('solar-forecast') || byId('weather-state')) readers.push(createReader('', '/api/forecast'));
  const visibilityChanged = () => readers.forEach(reader => reader.visibilityChanged());
  document.addEventListener('visibilitychange', visibilityChanged);
  desktopHome?.addEventListener('change', visibilityChanged);
  readers.forEach(reader => reader.refresh());
})();
