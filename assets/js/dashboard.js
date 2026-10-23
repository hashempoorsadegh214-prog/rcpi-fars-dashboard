/* RCPI Fars Dashboard — static GitHub Pages app. No Earth Engine credentials are used. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    catalog: null,
    summary: null,
    mainMap: null,
    compareMap: null,
    mainLayer: null,
    compareLayers: [],
    compareControl: null,
    charts: {},
    mainLoadedOnce: false,
    boundaryLayers: []
  };

  const CLASS_COLORS = ['#2ca02c', '#ffbb78', '#ff7f0e', '#d62728'];
  const CLASS_LABELS = ['کم', 'متوسط', 'زیاد', 'بسیار زیاد'];
  const RCPI_STOPS = [
    { v: 0.15, c: '#2b83ba' },
    { v: 0.325, c: '#abdda4' },
    { v: 0.50, c: '#ffffbf' },
    { v: 0.675, c: '#fdae61' },
    { v: 0.85, c: '#d7191c' }
  ];
  const INDEX_STOPS = [
    { v: 0.0, c: '#2b83ba' },
    { v: 0.25, c: '#abdda4' },
    { v: 0.5, c: '#ffffbf' },
    { v: 0.75, c: '#fdae61' },
    { v: 1.0, c: '#d7191c' }
  ];

  function toFa(value, digits = 4) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('fa-IR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function setStatus(id, message, kind = 'info') {
    const target = $(id);
    if (!target) return;
    target.className = `status-box ${kind}`;
    target.textContent = message;
  }

  function historicalEntry(year) {
    return {
      key: `historical-${year}`,
      label: `سال ${year}`,
      year,
      path: state.catalog.historicalTemplate.replace('{year}', String(year)),
      bands: state.catalog.historicalBands || { RCPI: 0, CLASS: 1, TPPI: 2, HEDI: 3 },
      group: 'historical'
    };
  }

  function forecastEntry(key) {
    return (state.catalog.forecasts || []).find((item) => item.key === key) || null;
  }

  function currentEntry() {
    const source = $('source-select').value;
    if (source === 'historical') return historicalEntry(Number($('year-select').value));
    return forecastEntry(source);
  }

  function entryFromToken(token) {
    const [kind, value] = String(token || '').split(':');
    if (kind === 'historical') return historicalEntry(Number(value));
    if (kind === 'forecast') return forecastEntry(value);
    return null;
  }

  function allEntries() {
    const years = (state.catalog.historicalYears || []).map(historicalEntry);
    const futures = (state.catalog.forecasts || []).map((item) => ({ ...item, group: 'forecast' }));
    return [...years, ...futures];
  }

  function colorToRgb(hex) {
    const clean = hex.replace('#', '');
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
  }

  function blendColor(a, b, ratio) {
    const ca = colorToRgb(a);
    const cb = colorToRgb(b);
    const rgb = ca.map((v, i) => Math.round(v + (cb[i] - v) * ratio));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function continuousColor(value, bandName) {
    const stops = bandName === 'RCPI' ? RCPI_STOPS : INDEX_STOPS;
    const min = stops[0].v;
    const max = stops[stops.length - 1].v;
    if (value < min || value > max) return 'rgba(0,0,0,0)';
    for (let i = 0; i < stops.length - 1; i += 1) {
      const left = stops[i];
      const right = stops[i + 1];
      if (value >= left.v && value <= right.v) {
        return blendColor(left.c, right.c, (value - left.v) / (right.v - left.v));
      }
    }
    return stops[stops.length - 1].c;
  }

  function pixelColor(values, raster, bandName, bandIndex) {
    if (!values || values.length <= bandIndex) return 'rgba(0,0,0,0)';
    const value = Number(values[bandIndex]);
    if (!Number.isFinite(value)) return 'rgba(0,0,0,0)';
    const noData = raster.noDataValue;
    if (noData !== undefined && noData !== null && value === Number(noData)) return 'rgba(0,0,0,0)';
    if (value < -9000) return 'rgba(0,0,0,0)';

    if (bandName === 'CLASS') {
      const classId = Math.round(value);
      return classId >= 1 && classId <= 4 ? CLASS_COLORS[classId - 1] : 'rgba(0,0,0,0)';
    }
    return continuousColor(value, bandName);
  }

  function getBandIndex(entry, bandName) {
    const mapBands = entry.bands || (entry.group === 'historical' ? state.catalog.historicalBands : null) || {};
    if (mapBands[bandName] !== undefined) return Number(mapBands[bandName]);
    const defaultIndices = { RCPI: 0, CLASS: 1, TPPI: 2, HEDI: 3 };
    return defaultIndices[bandName] ?? 0;
  }

  async function loadRasterLayer(entry, bandName, opacity = 0.86) {
    if (!entry || !entry.path) throw new Error('مسیر فایل نقشه برای این انتخاب تعریف نشده است.');
    if (typeof window.parseGeoraster !== 'function') throw new Error('کتابخانه خواندن GeoTIFF بارگذاری نشد؛ اتصال اینترنت یا CDN را بررسی کن.');
    if (typeof window.GeoRasterLayer !== 'function') throw new Error('کتابخانه نمایش GeoTIFF بارگذاری نشد؛ صفحه را تازه‌سازی کن.');

    const url = new URL(entry.path, document.baseURI).href;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`فایل نقشه پیدا نشد: ${entry.path}. فایل GeoTIFF را با همین نام در مخزن قرار بده.`);
    }
    const buffer = await response.arrayBuffer();
    const raster = await window.parseGeoraster(buffer);
    const bandIndex = getBandIndex(entry, bandName);
    if (raster.numberOfRasters && bandIndex >= raster.numberOfRasters) {
      throw new Error(`باند ${bandName} در فایل ${entry.path} وجود ندارد. ترتیب باندها را در data/map_catalog.json اصلاح کن.`);
    }

    return new window.GeoRasterLayer({
      georaster: raster,
      opacity,
      resolution: 128,
      pixelValuesToColorFn: (values) => pixelColor(values, raster, bandName, bandIndex)
    });
  }

  function sourceLabel(source, year) {
    if (source === 'historical') return `سری تاریخی — ${year}`;
    const item = forecastEntry(source);
    return item ? item.label : 'نقشه انتخاب‌شده';
  }

  function legendRows(bandName) {
    if (bandName === 'CLASS') {
      return CLASS_LABELS.map((label, index) => `<div class="legend-item"><span class="legend-swatch" style="background:${CLASS_COLORS[index]}"></span><span>کلاس ${index + 1}: ${label}</span></div>`).join('');
    }
    const stops = bandName === 'RCPI' ? RCPI_STOPS : INDEX_STOPS;
    const unit = bandName === 'RCPI' ? 'RCPI' : bandName;
    return `<div class="legend-gradient"></div><div class="legend-scale"><span>${toFa(stops[0].v, 2)}</span><span>${unit}</span><span>${toFa(stops[stops.length - 1].v, 2)}</span></div>`;
  }

  function updateLegend(bandName) {
    const titles = { CLASS: 'راهنمای طبقات RCPI', RCPI: 'مقدار پیوسته RCPI', TPPI: 'مقدار TPPI', HEDI: 'مقدار HEDI' };
    $('legend-title').textContent = titles[bandName] || 'راهنما';
    $('legend-content').innerHTML = legendRows(bandName);
    $('map-band-caption').textContent = titles[bandName] || bandName;
  }

  async function renderMainMap() {
    const button = $('load-map-btn');
    const entry = currentEntry();
    const bandName = $('band-select').value;
    const opacity = Number($('opacity-select').value) / 100;
    button.disabled = true;
    setStatus('map-status', 'در حال بارگذاری نقشه…', 'info');
    $('map-title').textContent = sourceLabel($('source-select').value, $('year-select').value);
    $('map-subtitle').textContent = `${bandName} · GeoTIFF`;
    updateLegend(bandName);

    try {
      const newLayer = await loadRasterLayer(entry, bandName, opacity);
      const oldLayer = state.mainLayer;
      newLayer.addTo(state.mainMap);
      if (oldLayer) state.mainMap.removeLayer(oldLayer);
      state.mainLayer = newLayer;
      if (!state.mainLoadedOnce) {
        state.mainMap.fitBounds(newLayer.getBounds(), { padding: [16, 16], maxZoom: 8 });
        state.mainLoadedOnce = true;
      }
      setStatus('map-status', `نقشه «${sourceLabel($('source-select').value, $('year-select').value)}» نمایش داده شد.`, 'success');
    } catch (error) {
      setStatus('map-status', error.message || 'بارگذاری نقشه ناموفق بود.', 'warning');
    } finally {
      button.disabled = false;
    }
  }

  function initMainMap() {
    const center = state.catalog.mapCenter || [29.3, 53.0];
    const zoom = state.catalog.mapZoom || 6.5;
    state.mainMap = L.map('main-map', { zoomControl: true }).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.mainMap);
    state.mainMap.attributionControl.setPrefix('');
  }

  async function loadOptionalBoundary() {
    try {
      const response = await fetch('data/fars.geojson', { cache: 'no-store' });
      if (!response.ok) return;
      const geojson = await response.json();
      [state.mainMap, state.compareMap].forEach((map) => {
        map.createPane('farsBoundaryPane');
        map.getPane('farsBoundaryPane').style.zIndex = 650;
        const outline = L.geoJSON(geojson, {
          pane: 'farsBoundaryPane',
          style: { color: '#1c344d', weight: 2, opacity: 0.95, fillOpacity: 0 }
        }).addTo(map);
        state.boundaryLayers.push(outline);
        if (!state.mainLoadedOnce) map.fitBounds(outline.getBounds(), { padding: [12, 12], maxZoom: 8 });
      });
    } catch (_optionalBoundaryError) {
      // Optional file. Raster export masks still control the actual study area.
    }
  }

  function initCompareMap() {
    const center = state.catalog.mapCenter || [29.3, 53.0];
    const zoom = state.catalog.mapZoom || 6.5;
    state.compareMap = L.map('compare-map', { zoomControl: true }).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.compareMap);
    state.compareMap.attributionControl.setPrefix('');
  }

  function populateYearSelect() {
    const years = state.catalog.historicalYears || [];
    $('year-select').innerHTML = years.slice().reverse().map((year) => `<option value="${year}" ${year === 2020 ? 'selected' : ''}>${year}</option>`).join('');
  }

  function populateCompareSelects() {
    const historical = (state.catalog.historicalYears || []).slice().reverse().map((year) => ({ value: `historical:${year}`, label: `سال ${year}` }));
    const future = (state.catalog.forecasts || []).map((item) => ({ value: `forecast:${item.key}`, label: item.label }));
    const all = [...historical, ...future];
    const options = all.map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
    $('compare-left').innerHTML = options;
    $('compare-right').innerHTML = options;
    $('compare-left').value = 'historical:2020';
    $('compare-right').value = 'forecast:bau';
  }

  async function renderCompare() {
    const leftEntry = entryFromToken($('compare-left').value);
    const rightEntry = entryFromToken($('compare-right').value);
    const band = $('compare-band').value;
    const button = $('compare-btn');
    if (!leftEntry || !rightEntry) {
      setStatus('compare-status', 'یکی از نقشه‌های انتخابی در فهرست وجود ندارد.', 'warning');
      return;
    }
    if (leftEntry.path === rightEntry.path) {
      setStatus('compare-status', 'برای مقایسه اسلایدی، دو نقشه متفاوت انتخاب کن.', 'warning');
      return;
    }

    button.disabled = true;
    setStatus('compare-status', 'در حال آماده‌سازی دو لایه برای مقایسه…', 'info');
    try {
      const [leftLayer, rightLayer] = await Promise.all([
        loadRasterLayer(leftEntry, band, 0.92),
        loadRasterLayer(rightEntry, band, 0.92)
      ]);

      if (state.compareControl) {
        state.compareMap.removeControl(state.compareControl);
        state.compareControl = null;
      }
      state.compareLayers.forEach((layer) => state.compareMap.removeLayer(layer));
      state.compareLayers = [leftLayer, rightLayer];
      leftLayer.addTo(state.compareMap);
      rightLayer.addTo(state.compareMap);

      if (typeof L.control.sideBySide !== 'function') throw new Error('افزونه اسلایدر مقایسه بارگذاری نشد. صفحه را تازه‌سازی کن.');
      state.compareControl = L.control.sideBySide(leftLayer, rightLayer).addTo(state.compareMap);
      state.compareMap.fitBounds(leftLayer.getBounds(), { padding: [16, 16], maxZoom: 8 });
      $('compare-left-label').textContent = leftEntry.label || leftEntry.year || 'نقشه اول';
      $('compare-right-label').textContent = rightEntry.label || rightEntry.year || 'نقشه دوم';
      setStatus('compare-status', 'مقایسه آماده است؛ دستگیره عمودی روی نقشه را بکش.', 'success');
      setTimeout(() => state.compareMap.invalidateSize(), 100);
    } catch (error) {
      setStatus('compare-status', error.message || 'ساخت مقایسه ناموفق بود.', 'warning');
    } finally {
      button.disabled = false;
    }
  }

  function safeNumber(value) {
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  }

  function chartBaseOptions(yLabel = 'مقدار RCPI') {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#c5d0df', font: { family: 'Vazirmatn', size: 10 }, usePointStyle: true, boxWidth: 7 } },
        tooltip: { titleFont: { family: 'Vazirmatn' }, bodyFont: { family: 'Vazirmatn' } }
      },
      scales: {
        x: { ticks: { color: '#91a2b8', font: { family: 'Vazirmatn', size: 9 }, maxRotation: 0, autoSkip: true }, grid: { color: 'rgba(148,163,184,.08)' } },
        y: { title: { display: true, text: yLabel, color: '#9aaabe', font: { family: 'Vazirmatn', size: 10 } }, ticks: { color: '#91a2b8', font: { family: 'Vazirmatn', size: 9 } }, grid: { color: 'rgba(148,163,184,.10)' }, beginAtZero: false }
      }
    };
  }

  function createOrUpdateChart(key, canvasId, config) {
    if (state.charts[key]) {
      state.charts[key].data = config.data;
      state.charts[key].options = config.options;
      state.charts[key].update();
      return;
    }
    const canvas = $(canvasId);
    if (!canvas || typeof Chart !== 'function') return;
    Chart.defaults.font.family = 'Vazirmatn';
    Chart.defaults.color = '#9aaabe';
    state.charts[key] = new Chart(canvas, config);
  }

  function renderCharts() {
    if (!state.summary || typeof Chart !== 'function') return;
    const summary = state.summary;
    const years = Array.from({ length: 40 }, (_, i) => 1996 + i);
    const historic = new Map((summary.historical || []).map((item) => [Number(item.year), safeNumber(item.mean)]));
    const forecastList = summary.forecasts || [];
    const forecastByKey = new Map(forecastList.map((item) => [item.key, item]));

    const trendDatasets = [{
      label: 'میانگین تاریخی RCPI',
      data: years.map((year) => year <= 2025 ? historic.get(year) ?? null : null),
      borderColor: '#53a7dc', backgroundColor: 'rgba(83,167,220,.15)', borderWidth: 2, pointRadius: 2, tension: 0.25, spanGaps: false
    }];
    [
      { key: 'bau', label: 'BAU 2035', color: '#d93b49' },
      { key: 'ssp245', label: 'SSP2-4.5 2035', color: '#f3bd4f' },
      { key: 'ssp585', label: 'SSP5-8.5 2035', color: '#ff7f0e' }
    ].forEach((scenario) => {
      const result = forecastByKey.get(scenario.key);
      trendDatasets.push({
        label: scenario.label,
        data: years.map((year) => year === 2035 ? safeNumber(result?.mean) : null),
        borderColor: scenario.color, backgroundColor: scenario.color, pointRadius: 5, pointHoverRadius: 7, showLine: false
      });
    });
    createOrUpdateChart('trend', 'trend-chart', {
      type: 'line', data: { labels: years.map((year) => String(year)), datasets: trendDatasets },
      options: { ...chartBaseOptions('میانگین RCPI'), scales: { ...chartBaseOptions('میانگین RCPI').scales, x: { ...chartBaseOptions('میانگین RCPI').scales.x, ticks: { ...chartBaseOptions('میانگین RCPI').scales.x.ticks, callback: (_, index) => index % 4 === 0 || index === 39 ? years[index] : '' } } } }
    });

    createOrUpdateChart('scenario', 'scenario-chart', {
      type: 'bar', data: {
        labels: forecastList.map((item) => item.label.replace(' — ', '\n')),
        datasets: [{ label: 'میانگین RCPI', data: forecastList.map((item) => safeNumber(item.mean)), backgroundColor: ['#d93b49', '#f3bd4f', '#ff7f0e'], borderRadius: 7, maxBarThickness: 48 }]
      }, options: { ...chartBaseOptions('میانگین RCPI'), scales: { ...chartBaseOptions('میانگین RCPI').scales, y: { ...chartBaseOptions('میانگین RCPI').scales.y, min: 0, max: 1 } } }
    });

    const thresholds = summary.thresholds || {};
    createOrUpdateChart('thresholds', 'threshold-chart', {
      type: 'bar', data: {
        labels: ['P25', 'P50', 'P75'],
        datasets: [{ label: 'آستانه RCPI', data: [safeNumber(thresholds.p25), safeNumber(thresholds.p50), safeNumber(thresholds.p75)], backgroundColor: ['#2ca02c', '#ffbb78', '#d62728'], borderRadius: 7, maxBarThickness: 55 }]
      }, options: { ...chartBaseOptions('مقدار آستانه'), plugins: { ...chartBaseOptions().plugins, legend: { display: false } }, scales: { ...chartBaseOptions().scales, y: { ...chartBaseOptions().scales.y, min: 0, max: 1 } } }
    });

    const chosenSource = $('source-select')?.value || 'historical';
    let activeAreaRow = null;
    if (chosenSource === 'historical') {
      activeAreaRow = (summary.historical || []).find((row) => Number(row.year) === Number($('year-select')?.value));
    } else {
      activeAreaRow = forecastByKey.get(chosenSource) || null;
    }
    const areas = activeAreaRow?.classAreasKm2 || [null, null, null, null];
    createOrUpdateChart('area', 'area-chart', {
      type: 'bar', data: {
        labels: summary.classes || CLASS_LABELS,
        datasets: [{ label: 'مساحت (کیلومترمربع)', data: areas.map(safeNumber), backgroundColor: summary.classColors || CLASS_COLORS, borderRadius: 7, maxBarThickness: 60 }]
      }, options: { ...chartBaseOptions('مساحت (km²)'), plugins: { ...chartBaseOptions().plugins, legend: { display: false } }, scales: { ...chartBaseOptions().scales, y: { ...chartBaseOptions().scales.y, min: 0 } } }
    });

    const historicalCount = (summary.historical || []).filter((row) => safeNumber(row.mean) !== null).length;
    $('trend-note').textContent = historicalCount ? `داده آماری ${historicalCount} سال از فایل summary.json خوانده شد.` : 'هنوز میانگین سالانه ۱۹۹۶ تا ۲۰۲۵ در summary.json ثبت نشده است؛ نمودار تاریخی عمداً بدون داده ساختگی است.';
    const scenarioCount = forecastList.filter((row) => safeNumber(row.mean) !== null).length;
    $('scenario-note').textContent = `آمار میانگین ثبت‌شده برای ${scenarioCount} سناریو از ۳ سناریو موجود است.`;
    const knownAreaCount = areas.filter((v) => safeNumber(v) !== null).length;
    $('area-note').textContent = knownAreaCount ? `مساحت ${knownAreaCount} طبقه از سناریوی انتخاب‌شده نمایش داده شده است.` : 'آمار مساحت واقعی طبقات هنوز ثبت نشده است؛ پس از محاسبه در Earth Engine این نمودار به‌روزرسانی می‌شود.';
  }

  function renderKpis() {
    const thresholds = state.summary?.thresholds || {};
    const bau = (state.summary?.forecasts || []).find((item) => item.key === 'bau');
    $('kpi-p25').textContent = toFa(thresholds.p25);
    $('kpi-p50').textContent = toFa(thresholds.p50);
    $('kpi-p75').textContent = toFa(thresholds.p75);
    $('kpi-bau-mean').textContent = toFa(bau?.mean);
  }

  function setupControls() {
    $('source-select').addEventListener('change', () => {
      const historical = $('source-select').value === 'historical';
      $('year-control-wrap').hidden = !historical;
      $('map-title').textContent = sourceLabel($('source-select').value, $('year-select').value);
      renderCharts();
    });
    $('load-map-btn').addEventListener('click', renderMainMap);
    $('year-select').addEventListener('change', () => {
      $('map-title').textContent = sourceLabel($('source-select').value, $('year-select').value);
      renderCharts();
    });
    $('band-select').addEventListener('change', () => updateLegend($('band-select').value));
    $('opacity-select').addEventListener('input', () => {
      $('opacity-output').textContent = `${Number($('opacity-select').value).toLocaleString('fa-IR')}٪`;
      if (state.mainLayer && typeof state.mainLayer.setOpacity === 'function') state.mainLayer.setOpacity(Number($('opacity-select').value) / 100);
    });
    $('compare-btn').addEventListener('click', renderCompare);
    $('compare-band').addEventListener('change', () => {
      if (state.compareLayers.length) renderCompare();
    });
    document.querySelectorAll('.nav-link').forEach((link) => {
      link.addEventListener('click', () => {
        document.querySelectorAll('.nav-link').forEach((item) => item.classList.remove('active'));
        link.classList.add('active');
        if (link.getAttribute('href') === '#compare-section') setTimeout(() => state.compareMap?.invalidateSize(), 120);
        if (link.getAttribute('href') === '#map-section') setTimeout(() => state.mainMap?.invalidateSize(), 120);
      });
    });
  }

  function parseNumberOrNull(raw) {
    const value = String(raw ?? '').trim().replace(/^"|"$/g, '');
    if (!value || value.toLowerCase() === 'null' || value.toLowerCase() === 'nan') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function mergeAnnualCsv(csvText) {
    const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const headers = lines[0].split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
    const rows = new Map();
    lines.slice(1).forEach((line) => {
      const cells = line.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
      const row = {};
      headers.forEach((header, index) => { row[header] = cells[index] ?? ''; });
      const year = Number(row.year);
      if (Number.isFinite(year)) rows.set(year, row);
    });
    if (!state.summary.historical) state.summary.historical = [];
    for (let year = 1996; year <= 2025; year += 1) {
      const csvRow = rows.get(year);
      if (!csvRow) continue;
      let target = state.summary.historical.find((item) => Number(item.year) === year);
      if (!target) {
        target = { year, mean: null, min: null, max: null, classAreasKm2: [null, null, null, null] };
        state.summary.historical.push(target);
      }
      target.mean = parseNumberOrNull(csvRow.rcpi_mean);
      target.min = parseNumberOrNull(csvRow.rcpi_min);
      target.max = parseNumberOrNull(csvRow.rcpi_max);
      target.classAreasKm2 = [
        parseNumberOrNull(csvRow.class1_km2),
        parseNumberOrNull(csvRow.class2_km2),
        parseNumberOrNull(csvRow.class3_km2),
        parseNumberOrNull(csvRow.class4_km2)
      ];
    }
  }

  async function boot() {
    try {
      const [catalogResponse, summaryResponse] = await Promise.all([
        fetch('data/map_catalog.json', { cache: 'no-store' }),
        fetch('data/summary.json', { cache: 'no-store' })
      ]);
      if (!catalogResponse.ok) throw new Error('فایل data/map_catalog.json بارگذاری نشد. ساختار پوشه‌های داشبورد را تغییر نده.');
      if (!summaryResponse.ok) throw new Error('فایل data/summary.json بارگذاری نشد.');
      state.catalog = await catalogResponse.json();
      state.summary = await summaryResponse.json();
      // Optional CSV: export it from Earth Engine and upload as data/annual_summary.csv.
      // If it is absent, the dashboard continues with the values in summary.json.
      try {
        const csvResponse = await fetch('data/annual_summary.csv', { cache: 'no-store' });
        if (csvResponse.ok) mergeAnnualCsv(await csvResponse.text());
      } catch (_optionalCsvError) {
        // Optional file: absence should not prevent the dashboard from opening.
      }
      populateYearSelect();
      populateCompareSelects();
      initMainMap();
      initCompareMap();
      await loadOptionalBoundary();
      setupControls();
      renderKpis();
      renderCharts();
      updateLegend('CLASS');
      $('year-control-wrap').hidden = false;
      setStatus('map-status', 'رابط داشبورد آماده است. برای نمایش نقشه، فایل GeoTIFF سال یا سناریوی انتخابی را در پوشه مشخص‌شده قرار بده.', 'warning');
      $('compare-status').textContent = 'برای ساخت مقایسه واقعی، هر دو فایل انتخاب‌شده باید در پوشه data/maps موجود باشند.';
      setTimeout(() => { state.mainMap.invalidateSize(); state.compareMap.invalidateSize(); }, 150);
    } catch (error) {
      setStatus('map-status', error.message || 'راه‌اندازی داشبورد ناموفق بود.', 'error');
      console.error(error);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
