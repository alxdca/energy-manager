import { historyGroups, defaultHistorySelection, allHistorySelection, historyTable, formatHistoryValue, validHistoryDate, shiftHistoryDate, todayInZurich, latestHistoryDate } from './history-data.js';

const storageKey = 'energy-manager-history-columns-v2';
const pageSize = 100;

export async function requestHistoryJson(url, signal) {
  const request = new AbortController();
  let timedOut = false;
  const cancel = () => request.abort();
  if (signal?.aborted) request.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 12000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: request.signal });
    if (!response.ok) throw new Error('L’historique est momentanément indisponible.');
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error('Le chargement a pris trop de temps. Réessayez.');
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error('L’historique est momentanément indisponible.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

const chartNumber = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 0 });

export function batteryForecastMessage(day) {
  if (!day || day.date < todayInZurich()) return '';
  const projection = day.historicalEstimated?.projection;
  if (!projection) return '';
  const reasons = {
    soc_unavailable: 'niveau de charge récent indisponible',
    forecast_unavailable: 'prévisions solaires ou de consommation incomplètes',
    car_forecast_unavailable: 'prévision de recharge voiture indisponible',
    car_coordination_unavailable: 'coordination avec la voiture indisponible',
    manual_override: 'commande manuelle non confirmée',
    manual_charge_invalid: 'paramètres de charge manuelle indisponibles',
    owned_charge_invalid: 'paramètres de charge automatique indisponibles',
    controller_unavailable: 'contrôleur indisponible',
    controller_limits: 'limites du contrôleur indisponibles',
    awaiting_evaluation: 'en attente du prochain bilan',
  };
  if (projection.status === 'unavailable' || projection.reason) {
    const prefix = projection.status === 'available' ? 'Prévision batterie partielle' : 'Prévision batterie indisponible';
    return `${prefix} : ${reasons[projection.reason] ?? 'données nécessaires indisponibles'}.`;
  }
  return projection.assumption === 'passive_operation' ? 'Batterie prévue selon la production et la consommation, sans recharge programmée.' : '';
}

export function renderHistoryChart(day, chart, svg, status, view = 'quarter') {
  const chartView = view === 'quarter' ? 'quarter' : 'hour';
  const model = historyTable(day, allHistorySelection, chartView);
  svg.replaceChildren();
  if (!model.hasData) {
    chart.hidden = true;
    status.hidden = false;
    status.textContent = 'Aucune donnée enregistrée pour le graphique de cette journée.';
    return;
  }
  chart.hidden = false;
  status.hidden = true;
  const rows = model.rows;
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const maximum = Math.max(0, ...rows.flatMap(row => [row.values.houseEstimated, row.values.houseMeasured]).filter(numeric),
    ...rows.flatMap(row => [row.values.carMeasured, row.values.carEstimated]).filter(numeric),
    ...rows.flatMap(row => [row.values.solarEstimated, row.values.solarMeasured]).filter(numeric));
  const step = maximum <= 2 ? .5 : maximum <= 5 ? 1 : 10 ** Math.floor(Math.log10(maximum));
  const ceiling = Math.max(step, Math.ceil(maximum / step) * step);
  const left = 42, right = 650, top = 24, bottom = 208;
  const width = (right - left) / rows.length;
  const x = index => left + (index + .5) * width;
  const y = value => bottom - value / ceiling * (bottom - top);
  const add = (tag, attributes = {}, label, parent = svg) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (label !== undefined) element.textContent = label;
    parent.append(element);
    return element;
  };
  const tooltip = (element, label) => add('title', {}, label, element);
  add('title', {}, 'Données énergétiques de la journée');
  const chartPeriod = chartView === 'quarter' ? 'par tranches de 15 minutes' : 'par heure';
  add('desc', {}, `Solaire ${chartPeriod}, prévu en barres larges et relevé en barres superposées. Maison ${chartPeriod}, prévue en ligne pointillée et relevée en ligne continue. Énergie en Wh sur l’axe gauche. Batterie ${chartPeriod}, relevée en violet continu et prévue en pointillé sur l’axe droit ; dernier niveau de chaque période, sans moyenne. Niveau de charge de la voiture en vert sur l’axe droit ; dernier relevé conservé jusqu’au suivant, y compris en veille. Chaque heure indique la fin de la période et aligne l’énergie avec le niveau de batterie. ${rows.length} ${chartView === 'quarter' ? 'tranches de 15 minutes' : 'heures'}, fuseau Europe/Zurich.`);
  add('text', { x: left, y: 13, class: 'chart-axis' }, 'Wh');
  for (const value of [0, ceiling / 2, ceiling]) {
    add('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'chart-grid' });
    add('text', { x: left - 8, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-axis' }, chartNumber.format(value * 1000));
  }
  rows.forEach((row, index) => {
    const hour = row.label.replace(/ \(\d+\)$/, '');
    if (['00:00', '06:00', '12:00', '18:00'].includes(hour) || index === rows.length - 1) {
      add('text', { x: x(index), y: 232, 'text-anchor': 'middle', class: 'chart-axis' }, hour.replace(':00', ' h'));
    }
  });
  const solarWidth = width;
  rows.forEach((row, index) => {
    const solarX = left + (index + .5) * solarWidth;
    for (const [key, className, fraction, label] of [
      ['solarEstimated', 'chart-solar', .3, 'Solaire prévu'],
      ['solarMeasured', 'chart-solar-measured', .17, 'Solaire relevé'],
    ]) {
      const value = row.values[key];
      if (!numeric(value)) continue;
      const bar = add('rect', { x: solarX - solarWidth * fraction, y: y(value), width: solarWidth * fraction * 2,
        height: bottom - y(value), rx: className === 'chart-solar' ? 2 : 1, class: className });
      tooltip(bar, `${row.label} · ${label} : ${chartNumber.format(value * 1000)} Wh`);
    }
  });
  const line = (key, className, label) => {
    let segment = [];
    const finish = () => {
      if (segment.length > 1) add('polyline', { points: segment.join(' '), class: className });
      segment = [];
    };
    rows.forEach((row, index) => {
      const value = row.values[key];
      if (!numeric(value)) { finish(); return; }
      segment.push(`${x(index)},${y(value)}`);
      const point = add('circle', { cx: x(index), cy: y(value), r: 3, class: `${className}-point` });
      tooltip(point, `${row.label} · ${label} : ${chartNumber.format(value * 1000)} Wh${['houseEstimated', 'carEstimated', 'carMeasured'].includes(key) && row.notes?.[key] ? `\n${row.notes[key]}` : ''}`);
    });
    finish();
  };
  line('houseEstimated', 'chart-demand', 'Maison prévue');
  line('houseMeasured', 'chart-demand-measured', 'Maison relevée');
  line('carMeasured', 'chart-car-measured', 'Recharge voiture');
  line('carEstimated', 'chart-car-estimated', 'Recharge voiture prévue');
  const ySoc = value => bottom - value / 100 * (bottom - top);
  add('text', { x: right + 8, y: 13, class: 'chart-axis chart-battery-axis chart-battery-unit' }, '% SOC');
  for (const value of [0, 50, 100]) add('text', { x: right + 8, y: ySoc(value) + 4, class: 'chart-axis chart-battery-axis' }, String(value));
  for (const [key, className, label] of [
    ['batteryMeasured', 'chart-battery-measured', 'Batterie relevée'],
    ['batteryEstimated', 'chart-battery-estimated', 'Batterie prévue'],
    ['carSocMeasured', 'chart-car-soc', 'Niveau voiture'],
  ]) {
    let segment = [];
    const finish = () => {
      if (segment.length > 1) add('polyline', { points: segment.join(' '), class: className });
      segment = [];
    };
    rows.forEach((row, index) => {
      const value = row.values[key];
      if (!numeric(value)) { finish(); return; }
      segment.push(`${x(index)},${ySoc(value)}`);
      const point = add('circle', { cx: x(index), cy: ySoc(value), r: 3, class: `${className}-point` });
      tooltip(point, `${row.label} · ${label} : ${chartNumber.format(value)} %\n${row.notes[key]}`);
    });
    finish();
  }
}

function initializeHistory() {
  const byId = id => document.getElementById(`history-${id}`);
  const elements = Object.fromEntries(['date', 'aggregation', 'date-form', 'previous', 'next', 'today', 'load', 'selection-count', 'field-groups',
    'select-all', 'select-none', 'selection', 'status', 'error', 'error-text', 'retry', 'results', 'day-summary', 'chart', 'chart-svg', 'chart-status', 'chart-frequency'].map(key => [key, byId(key)]));
  const selectionMedia = window.matchMedia?.('(max-width: 700px)');
  const sizeSelection = () => { elements.selection.open = !selectionMedia?.matches; };
  sizeSelection();
  selectionMedia?.addEventListener('change', sizeSelection);
  const validFields = new Set(allHistorySelection);
  let selection = new Set(defaultHistorySelection);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved) && saved.every(value => typeof value === 'string')) selection = new Set(saved.filter(value => validFields.has(value)));
  } catch { /* The controls remain usable when browser storage is unavailable. */ }
  const initialUrl = new URL(location.href);
  const viewFromUrl = url => url.searchParams.get('view') === 'hour' ? 'hour' : 'quarter';
  const cache = new Map();
  const state = { day: null, view: viewFromUrl(initialUrl), dayLoading: false, dayError: '', generation: 0, controller: null, page: 0, date: '' };
  const initialDate = value => validHistoryDate(value ?? '') ? (value > latestHistoryDate() ? latestHistoryDate() : value) : todayInZurich();
  function updateNavigation() {
    elements.date.max = latestHistoryDate();
    elements.next.disabled = state.date >= elements.date.max;
  }
  const inputs = new Map();
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const actionButton = (label, action) => {
    const node = make('button', '', label); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const persistSelection = () => { try { localStorage.setItem(storageKey, JSON.stringify([...selection])); } catch { /* Keep the choice for this visit. */ } };
  function updateUrl(replace = false) {
    const url = new URL(location.href); url.searchParams.set('date', state.date);
    url.searchParams.delete('step');
    if (state.view === 'quarter') url.searchParams.delete('view'); else url.searchParams.set('view', state.view);
    if (replace || url.href === location.href) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
  }
  const viewLabel = () => ({ quarter: 'Pas de 15 min', hour: 'Par heure' })[state.view];
  function updateSummary() {
    if (!state.day) return;
    const date = formatHistoryValue(state.date, { type: 'date' });
    const count = (Date.parse(state.day.periodEnd) - Date.parse(state.day.periodStart)) / (state.view === 'hour' ? 3600000 : 900000);
    const scope = 'Maison hors recharge voiture';
    elements['day-summary'].textContent = `${date} · ${state.view === 'hour' ? `${count} heures` : `${count} pas de 15 min`} · ${scope}`;
  }
  function updateSelection() {
    elements['selection-count'].textContent = `${selection.size} valeur${selection.size > 1 ? 's' : ''}`;
    for (const [key, input] of inputs) input.checked = selection.has(key);
  }
  function selectionChanged() {
    state.page = 0; persistSelection(); updateSelection(); renderResults();
  }
  for (const group of historyGroups) {
    const fields = make('fieldset', 'history-field-group'); fields.dataset.group = group.id;
    fields.append(make('legend', '', group.label));
    for (const field of group.columns) {
      const label = make('label', 'history-field'), input = make('input');
      input.type = 'checkbox'; input.name = 'history-column'; input.value = field.key;
      input.addEventListener('change', () => {
        if (input.checked) selection.add(field.key); else selection.delete(field.key);
        selectionChanged();
      });
      inputs.set(field.key, input);
      label.append(input, make('span', '', `${field.label} (${field.unit})`)); fields.append(label);
    }
    elements['field-groups'].append(fields);
  }
  elements['select-all'].addEventListener('click', () => { selection = new Set(allHistorySelection); selectionChanged(); });
  elements['select-none'].addEventListener('click', () => { selection = new Set(); selectionChanged(); });
  function renderResults() {
    const model = state.day ? historyTable(state.day, [...selection], state.view) : null;
    const fragment = document.createDocumentFragment();
    if (state.day && !selection.size) fragment.append(make('p', 'panel history-no-selection', 'Sélectionnez au moins une valeur à afficher.'));
    else if (model?.hasData) {
      const card = make('section', 'panel history-table-card'); card.setAttribute('aria-labelledby', 'history-table-heading');
      const heading = make('div', 'history-table-heading'), title = make('h2', '', 'Valeurs du jour'); title.id = 'history-table-heading';
      heading.append(title, make('span', 'history-frequency', viewLabel())); card.append(heading);
      const region = make('div', 'history-table-scroll'); region.tabIndex = 0;
      region.setAttribute('role', 'region'); region.setAttribute('aria-label', `Historique · ${viewLabel()} · tableau défilant`);
      const table = make('table', 'history-values');
      table.append(make('caption', 'sr-only', `Historique du ${formatHistoryValue(state.date, { type: 'date' })} · ${viewLabel()}`));
      const head = make('thead'), groups = make('tr'), values = make('tr');
      const time = make('th', 'history-time-heading', 'Période'); time.rowSpan = 2; time.scope = 'col'; groups.append(time);
      for (const group of model.groups) {
        const cell = make('th', '', group.label); cell.colSpan = group.columns.length; cell.scope = 'colgroup'; cell.dataset.group = group.id; groups.append(cell);
      }
      for (const field of model.columns) {
        const cell = make('th', '', field.label); cell.scope = 'col'; cell.dataset.group = field.groupId;
        cell.append(make('span', 'history-unit', field.unit)); values.append(cell);
      }
      head.append(groups, values); table.append(head);
      const pages = Math.max(1, Math.ceil(model.rows.length / pageSize)); state.page = Math.min(state.page, pages - 1);
      const body = make('tbody');
      for (const row of model.rows.slice(state.page * pageSize, (state.page + 1) * pageSize)) {
        const tr = make('tr'), time = make('td', 'history-time', row.rangeLabel);
        time.title = `${formatHistoryValue(row.start, { type: 'timestamp' })} → ${formatHistoryValue(row.end, { type: 'timestamp' })}`; tr.append(time);
        for (const field of model.columns) {
          const value = row.values[field.key], cell = make('td', '', formatHistoryValue(value, field));
          const raw = value === null || value === undefined ? 'Valeur indisponible'
            : `${field.unit === 'Wh' ? formatHistoryValue(value, field) : value} ${field.unit}`;
          cell.title = `${raw}${row.notes?.[field.key] ? `\n${row.notes[field.key]}` : ''}`; tr.append(cell);
        }
        body.append(tr);
      }
      table.append(body); region.append(table); card.append(region);
      const pagination = make('div', 'history-pagination');
      pagination.append(make('span', '', `${state.page * pageSize + 1}–${Math.min((state.page + 1) * pageSize, model.rows.length)} sur ${model.rows.length.toLocaleString('fr-CH')} lignes`));
      if (pages > 1) {
        const controls = make('div', 'history-pagination-actions');
        for (const [direction, label, id] of [[-1, 'Précédent', 'previous'], [1, 'Suivant', 'next']]) {
          const button = actionButton(label, () => {
            state.page += direction; renderResults(); document.getElementById(`history-page-${id}`)?.focus({ preventScroll: true });
          });
          button.id = `history-page-${id}`; button.disabled = state.page + direction < 0 || state.page + direction >= pages;
          button.setAttribute('aria-label', `Tableau historique · ${label.toLowerCase()}`); controls.append(button);
        }
        pagination.append(controls);
      }
      card.append(pagination); fragment.append(card);
    } else if (state.day && !state.dayLoading) {
      fragment.append(make('p', 'panel history-no-selection', 'Aucune valeur détaillée enregistrée pour cette période et cette sélection.'));
    }
    elements.results.replaceChildren(fragment);
    elements['chart-frequency'].textContent = `Solaire, maison, voiture et batterie : ${state.view === 'quarter' ? '15 min' : '1 h'}`;
    const batteryStatus = byId('battery-status');
    if (batteryStatus) {
      batteryStatus.textContent = batteryForecastMessage(state.day);
      batteryStatus.hidden = !batteryStatus.textContent;
    }
    const solarStatus = byId('solar-status'), solar = state.day?.solarForecast;
    if (solarStatus) {
      solarStatus.textContent = state.day?.date >= todayInZurich() && solar && solar.status !== 'online'
        ? `${solar.status === 'stale' ? 'Prévision solaire conservée' : 'Prévision solaire indisponible'}${solar.error ? ` : ${solar.error}` : '.'}` : '';
      solarStatus.hidden = !solarStatus.textContent;
    }
    if (state.day) renderHistoryChart(state.day, elements.chart, elements['chart-svg'], elements['chart-status'], state.view);
    else {
      elements.chart.hidden = true;
      elements['chart-svg'].replaceChildren();
      elements['chart-status'].hidden = false;
      elements['chart-status'].textContent = state.dayError ? 'Graphique indisponible.' : 'Chargement du graphique…';
    }
    elements.results.setAttribute('aria-busy', String(state.dayLoading));
    const error = state.dayError;
    elements.error.hidden = !error; elements['error-text'].textContent = error;
    if (state.dayLoading) elements.status.textContent = 'Chargement de l’historique…';
    else if (state.dayError) elements.status.textContent = 'La période n’a pas pu être chargée.';
    else if (!selection.size) elements.status.textContent = 'Aucune valeur sélectionnée.';
    else if (model?.hasData) elements.status.textContent = state.view === 'quarter' ? `${model.rows.length} pas de 15 min` : `${model.rows.length} ${state.view === 'hour' ? 'heures' : 'jours'}`;
    else elements.status.textContent = 'Aucune valeur détaillée pour cette période et cette sélection.';
  }
  async function loadDate(value, writeUrl = true, replace = false) {
    if (!validHistoryDate(value)) { elements.error.hidden = false; elements['error-text'].textContent = 'Choisissez une date valide.'; return; }
    updateNavigation();
    if (value > elements.date.max) {
      elements.date.value = state.date;
      elements.error.hidden = false;
      elements['error-text'].textContent = 'Les prévisions sont limitées aux sept prochains jours.';
      return;
    }
    state.controller?.abort(); const controller = new AbortController(); state.controller = controller;
    const generation = ++state.generation;
    state.date = value; elements.date.value = value; state.day = null; state.page = 0;
    updateNavigation();
    elements.aggregation.value = state.view;
    state.dayError = ''; state.dayLoading = true;
    elements['day-summary'].textContent = 'Lecture de la journée sélectionnée…';
    if (writeUrl) updateUrl(replace);
    updateSelection(); renderResults();
    try {
      let day = cache.get(value);
      if (!day) {
        day = await requestHistoryJson(`/api/history/day?date=${encodeURIComponent(value)}`, controller.signal);
        if (generation !== state.generation || controller.signal.aborted) return;
        if (day.date !== value || !Number.isFinite(Date.parse(day.periodStart)) || !Number.isFinite(Date.parse(day.periodEnd))
          || Date.parse(day.periodEnd) <= Date.parse(day.periodStart)) throw new Error('La réponse de l’historique est invalide.');
        cache.set(value, day);
        while (cache.size > 28) cache.delete(cache.keys().next().value);
      }
      if (generation !== state.generation || controller.signal.aborted) return;
      state.day = day; updateSummary(); updateSelection();
    } catch (error) {
      if (generation !== state.generation || controller.signal.aborted) return;
      state.dayError = error instanceof Error ? error.message : 'L’historique n’a pas pu être chargé.';
      controller.abort();
      elements['day-summary'].textContent = 'Choisissez une autre journée ou réessayez.';
    } finally {
      if (generation === state.generation) { state.dayLoading = false; renderResults(); }
    }
  }
  elements.aggregation.addEventListener('change', () => {
    state.view = elements.aggregation.value === 'hour' ? 'hour' : 'quarter';
    void loadDate(elements.date.value);
  });
  elements['date-form'].addEventListener('submit', event => { event.preventDefault(); cache.clear(); void loadDate(elements.date.value); });
  elements.previous.addEventListener('click', () => { const date = shiftHistoryDate(elements.date.value, -1); if (date) void loadDate(date); });
  elements.next.addEventListener('click', () => { if (!elements.next.disabled) { const date = shiftHistoryDate(elements.date.value, 1); if (date) void loadDate(date); } });
  elements.today.addEventListener('click', () => { void loadDate(todayInZurich()); });
  elements.retry.addEventListener('click', () => { cache.clear(); void loadDate(elements.date.value); });
  window.addEventListener('household-forecast-updated', () => { cache.clear(); void loadDate(elements.date.value, false); });
  window.addEventListener('popstate', () => {
    const url = new URL(location.href);
    state.view = viewFromUrl(url);
    const requested = url.searchParams.get('date'), date = initialDate(requested);
    void loadDate(date, date !== requested, true);
  });
  function updateClock() {
    updateNavigation();
    const now = new Date(), date = document.getElementById('local-date'), time = document.getElementById('local-time');
    if (date) date.textContent = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', weekday: 'short', day: 'numeric', month: 'short' }).format(now);
    if (time) time.textContent = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(now);
  }
  updateClock(); let clockTimer = setInterval(updateClock, 1000);
  window.addEventListener('pagehide', () => { state.controller?.abort(); clearInterval(clockTimer); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { cache.clear(); clearInterval(clockTimer); clockTimer = setInterval(updateClock, 1000); void loadDate(elements.date.value, false); }
  });
  updateSelection(); const requestedDate = initialUrl.searchParams.get('date');
  void loadDate(initialDate(requestedDate), true, true);
}

if (typeof document !== 'undefined' && document.getElementById('history-view')) initializeHistory();
