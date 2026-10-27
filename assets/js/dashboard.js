/* RCPI Fars Dashboard — static GitHub Pages app (No GEE)
   Fixes:
   - Prevent zoom/pan from triggering year change (no zoom listeners that call render)
   - Hard-cancel stale raster renders (requestId)
   - Remove layer overlap: remove old layer immediately before loading new
   - Keep performance: resolution=128, small LRU cache, no HEAD boot checks
*/
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

    // IMPORTANT: request cancellation / last-wins rendering
    mainRequestId: 0,

    // keep first-fit behavior only once
    mainLoadedOnce: false,

    // Optional boundary layers
    boundaryLayers: [],

    // Raster LRU cache (url -> Promise<georaster>)
    rasterCache: new Map()
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

  function setStatus(id, message, kind = 'info') {
    const el = $(id);
    if (!el) return;
    el.className = `status-box ${kind}`;
    el.textContent = message;
  }

  function toFa(value, digits = 4) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('fa-IR', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function safeNumber(value) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
    return Number(value);
  }

  // ---------- Catalog helpers ----------
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
    const select = $('period-select');
    const val = select ? select.value : '2020';

    if (val === 'bau' || val === 'ssp245' || val === 'ssp585') {
      return forecastEntry(val);
    }
    return historicalEntry(Number(val));
  }

  function entryFromToken(token) {
    const [kind, value] = String(token || '').split(':');
    if (kind === 'historical') return historicalEntry(Number(value));
    if (kind === 'forecast') return forecastEntry(value);
    return null;
  }

  function getBandIndex(entry, bandName) {
    const mapBands =
      entry?.bands ||
      (entry?.group === 'historical' ? state.catalog?.historicalBands : null) ||
      {};

    if (mapBands[bandName] !== undefined) return Number(mapBands[bandName]);

    const defaults = { RCPI: 0, CLASS: 1, TPPI: 2, HEDI: 3 };
    return defaults[bandName] ?? 0;
  }

  // ---------- Color helpers ----------
  function colorToRgb(hex) {
    const clean = String(hex).replace('#', '');
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
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

    if (!Number.isFinite(value) || value < min || value > max) return 'rgba(0,0,0,0)';

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

    const noData = raster?.noDataValue;
    if (noData !== undefined && noData !== null && value === Number(noData)) return 'rgba(0,0,0,0)';
    if (value < -9000) return 'rgba(0,0,0,0)';

    if (bandName === 'CLASS') {
      const classId = Math.round(value);
      return classId >= 1 && classId <= 4 ? CLASS_COLORS[classId - 1] : 'rgba(0,0,0,0)';
    }

    return continuousColor(value, bandName);
  }

  // ---------- Raster loading (LRU cache) ----------
  async function getParsedRaster(entry) {
    if (!entry || !entry.path) throw new Error('مسیر فایل نقشه برای این انتخاب تعریف نشده است.');
    if (typeof window.parseGeoraster !== 'function') {
      throw new Error('کتابخانه parseGeoraster بارگذاری نشده است.');
    }

    const url = new URL(entry.path, document.baseURI).href;

    let rasterPromise = state.rasterCache.get(url);

    if (rasterPromise) {
      // refresh LRU
      state.rasterCache.delete(url);
      state.rasterCache.set(url, rasterPromise);
    } else {
      rasterPromise = (async () => {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`فایل نقشه پیدا نشد: ${entry.path}`);
        const buffer = await res.arrayBuffer();
        return window.parseGeoraster(buffer);
      })();

      state.rasterCache.set(url, rasterPromise);

      // LRU limit
      while (state.rasterCache.size > 10) {
        const oldest = state.rasterCache.keys().next().value;
        if (oldest === url) break;
        state.rasterCache.delete(oldest);
      }
    }

    try {
      return await rasterPromise;
    } catch (err) {
      if (state.rasterCache.get(url) === rasterPromise) state.rasterCache.delete(url);
      throw err;
    }
  }

  async function loadRasterLayer(entry, bandName, opacity) {
    if (typeof window.GeoRasterLayer !== 'function') {
      throw new Error('کتابخانه GeoRasterLayer بارگذاری نشده است.');
    }

    const raster = await getParsedRaster(entry);
    const bandIndex = getBandIndex(entry, bandName);

    // Basic bounds check
    const n = raster?.numberOfRasters;
    if (!Number.isInteger(bandIndex) || bandIndex < 0 || (Number.isFinite(n) && bandIndex >= n)) {
      throw new Error(`باند ${bandName} در فایل ${entry.path} وجود ندارد.`);
    }

    return new window.GeoRasterLayer({
      georaster: raster,
      opacity,
      // performance
      resolution: 128,
      pixelValuesToColorFn: (values) => pixelColor(values, raster, bandName, bandIndex)
    });
  }

  // ---------- Legend ----------
  function legendRows(bandName) {
    if (bandName === 'CLASS') {
      return CLASS_LABELS.map(
        (label, idx) =>
          `<div class="legend-item">
             <span class="legend-swatch" style="background:${CLASS_COLORS[idx]}"></span>
             <span>کلاس ${idx + 1}: ${label}</span>
           </div>`
      ).join('');
    }

    const stops = bandName === 'RCPI' ? RCPI_STOPS : INDEX_STOPS;
    const unit = bandName === 'RCPI' ? 'RCPI' : bandName;

    return `
      <div class="legend-gradient"></div>
      <div class="legend-scale">
        <span>${toFa(stops[0].v, 2)}</span>
        <span>${unit}</span>
        <span>${toFa(stops[stops.length - 1].v, 2)}</span>
      </div>
    `;
  }

  function updateLegend(bandName) {
    const titles = {
      CLASS: 'راهنمای طبقات RCPI',
      RCPI: 'مقدار پیوسته RCPI',
      TPPI: 'مقدار TPPI',
      HEDI: 'مقدار HEDI'
    };
    if ($('legend-title')) $('legend-title').textContent = titles[bandName] || 'راهنما';
    if ($('legend-content')) $('legend-content').innerHTML = legendRows(bandName);
    if ($('map-band-caption')) $('map-band-caption').textContent = titles[bandName] || bandName;
  }

  function periodCurrentLabel() {
    const select = $('period-select');
    if (!select) return 'نقشه انتخاب‌شده';
    const opt = select.options[select.selectedIndex];
    return opt ? opt.text : 'نقشه انتخاب‌شده';
  }

  // ---------- MAIN MAP RENDER (key fix) ----------
  async function renderMainMap({ fitOnce = false } = {}) {
    const entry = currentEntry();
    const bandName = $('band-select') ? $('band-select').value : 'CLASS';
    const opacity = $('opacity-select') ? Number($('opacity-select').value) / 100 : 0.86;

    const title = periodCurrentLabel();

    // increment requestId (last request wins)
    const requestId = ++state.mainRequestId;

    if ($('map-title')) $('map-title').textContent = title;
    if ($('map-subtitle')) $('map-subtitle').textContent = `${bandName} · GeoTIFF`;

    updateLegend(bandName);

    const btn = $('load-map-btn');
    if (btn) btn.disabled = true;

    setStatus('map-status', `در حال بارگذاری «${title}»…`, 'info');

    try {
      if (!entry) throw new Error('برای انتخاب فعلی، نقشه‌ای تعریف نشده است.');
      if (!state.mainMap) throw new Error('نقشه اصلی مقداردهی نشده است.');

      // IMPORTANT: remove old layer immediately to prevent overlap illusion
      if (state.mainLayer && state.mainMap.hasLayer(state.mainLayer)) {
        state.mainMap.removeLayer(state.mainLayer);
        state.mainLayer = null;
      }

      const newLayer = await loadRasterLayer(entry, bandName, opacity);

      // If another request started while we awaited, drop this layer
      if (requestId !== state.mainRequestId) return;

      newLayer.addTo(state.mainMap);
      state.mainLayer = newLayer;

      // Fit bounds only once (or when explicitly requested)
      if (!state.mainLoadedOnce || fitOnce) {
        const bounds = newLayer.getBounds();
        state.mainMap.fitBounds(bounds, { padding: [16, 16], maxZoom: 8 });
        state.mainLoadedOnce = true;
      }

      setStatus('map-status', `نقشه «${title}» نمایش داده شد.`, 'success');
    } catch (err) {
      if (requestId !== state.mainRequestId) return;
      setStatus('map-status', err?.message || 'بارگذاری نقشه ناموفق بود.', 'warning');
    } finally {
      if (requestId === state.mainRequestId && btn) btn.disabled = false;
    }
  }

  // ---------- Maps init ----------
  function initMainMap() {
    const center = state.catalog?.mapCenter || [29.3, 53.0];
    const zoom = state.catalog?.mapZoom || 6.5;

    state.mainMap = L.map('main-map', {
      zoomControl: true,
      preferCanvas: true
    }).setView(center, zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap'
    }).addTo(state.mainMap);

    state.mainMap.attributionControl.setPrefix('');

    // IMPORTANT: do NOT call renderMainMap on zoomend/moveend
    // (We intentionally add no handlers here.)
  }

  function initCompareMap() {
    const center = state.catalog?.mapCenter || [29.3, 53.0];
    const zoom = state.catalog?.mapZoom || 6.5;

    state.compareMap = L.map('compare-map', {
      zoomControl: true,
      keyboard: false,
      preferCanvas: true
    }).setView(center, zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap'
    }).addTo(state.compareMap);

    state.compareMap.attributionControl.setPrefix('');
  }

  async function loadOptionalBoundary() {
    try {
      const res = await fetch('data/fars.geojson', { cache: 'force-cache' });
      if (!res.ok) return;
      const geojson = await res.json();

      [state.mainMap, state.compareMap].forEach((map) => {
        if (!map) return;

        map.createPane('farsBoundaryPane');
        map.getPane('farsBoundaryPane').style.zIndex = 650;

        const outline = L.geoJSON(geojson, {
          pane: 'farsBoundaryPane',
          style: {
            color: '#1c344d',
            weight: 2,
            opacity: 0.95,
            fillOpacity: 0
          }
        }).addTo(map);

        state.boundaryLayers.push(outline);
      });
    } catch (_) {}
  }

  // ---------- Compare ----------
  function populateCompareSelects() {
    const historical = (state.catalog?.historicalYears || [])
      .slice()
      .reverse()
      .map((year) => ({ value: `historical:${year}`, label: `سال ${year}` }));

    const future = (state.catalog?.forecasts || []).map((item) => ({
      value: `forecast:${item.key}`,
      label: item.label
    }));

    const all = [...historical, ...future];
    const options = all.map((it) => `<option value="${it.value}">${it.label}</option>`).join('');

    if ($('compare-left')) $('compare-left').innerHTML = options;
    if ($('compare-right')) $('compare-right').innerHTML = options;

    if ($('compare-left')) $('compare-left').value = 'historical:2020';
    if ($('compare-right')) $('compare-right').value = 'forecast:bau';
  }

  async function renderCompare() {
    const leftEntry = entryFromToken($('compare-left')?.value);
    const rightEntry = entryFromToken($('compare-right')?.value);
    const band = $('compare-band') ? $('compare-band').value : 'CLASS';
    const btn = $('compare-btn');

    if (!leftEntry || !rightEntry || !state.compareMap) return;

    if (leftEntry.path === rightEntry.path) {
      setStatus('compare-status', 'دو نقشه متفاوت انتخاب کنید.', 'warning');
      return;
    }

    if (btn) btn.disabled = true;
    setStatus('compare-status', 'در حال آماده‌سازی لایه‌ها…', 'info');

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

      state.compareControl = L.control.sideBySide(leftLayer, rightLayer).addTo(state.compareMap);

      setStatus('compare-status', 'مقایسه آماده است.', 'success');
    } catch (err) {
      setStatus('compare-status', err?.message || 'خطا در بارگذاری.', 'warning');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- Charts/KPIs (as before; keep minimal & safe) ----------
  function chartBaseOptions(yLabel = 'مقدار') {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: '#c5d0df',
            font: { family: 'Vazirmatn', size: 10 },
            usePointStyle: true,
            boxWidth: 7
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#91a2b8', font: { family: 'Vazirmatn', size: 9 }, maxRotation: 0 },
          grid: { color: 'rgba(148,163,184,.08)' }
        },
        y: {
          title: { display: true, text: yLabel, color: '#9aaabe', font: { family: 'Vazirmatn', size: 10 } },
          ticks: { color: '#91a2b8', font: { family: 'Vazirmatn', size: 9 } },
          grid: { color: 'rgba(148,163,184,.10)' }
        }
      }
    };
  }

  function createOrUpdateChart(key, canvasId, config) {
    if (!window.Chart) return;
    const canvas = $(canvasId);
    if (!canvas) return;

    Chart.defaults.font.family = 'Vazirmatn';
    Chart.defaults.color = '#9aaabe';

    if (state.charts[key]) {
      state.charts[key].data = config.data;
      state.charts[key].options = config.options;
      state.charts[key].update();
      return;
    }

    state.charts[key] = new Chart(canvas, config);
  }

  function renderCharts() {
    if (!state.summary || !window.Chart) return;

    const summary = state.summary;

    const years = Array.from({ length: 40 }, (_, i) => 1996 + i);
    const historic = new Map((summary.historical || []).map((it) => [Number(it.year), safeNumber(it.mean)]));
    const forecastList = summary.forecasts || [];
    const forecastByKey = new Map(forecastList.map((it) => [it.key, it]));

    const trendDatasets = [{
      label: 'میانگین تاریخی RCPI',
      data: years.map((y) => (y <= 2025 ? (historic.get(y) ?? null) : null)),
      borderColor: '#53a7dc',
      backgroundColor: 'rgba(83,167,220,.15)',
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.25
    }];

    [
      { key: 'bau', label: 'BAU 2035', color: '#d93b49' },
      { key: 'ssp245', label: 'SSP2-4.5 2035', color: '#f3bd4f' },
      { key: 'ssp585', label: 'SSP5-8.5 2035', color: '#ff7f0e' }
    ].forEach((sc) => {
      const r = forecastByKey.get(sc.key);
      trendDatasets.push({
        label: sc.label,
        data: years.map((y) => (y === 2035 ? safeNumber(r?.mean) : null)),
        borderColor: sc.color,
        backgroundColor: sc.color,
        pointRadius: 5,
        showLine: false
      });
    });

    const trendOptions = chartBaseOptions('میانگین RCPI');
    trendOptions.scales.x.ticks.callback = (_, idx) => (idx % 4 === 0 || idx === 39 ? years[idx] : '');

    createOrUpdateChart('trend', 'trend-chart', {
      type: 'line',
      data: { labels: years.map(String), datasets: trendDatasets },
      options: trendOptions
    });

    createOrUpdateChart('scenario', 'scenario-chart', {
      type: 'bar',
      data: {
        labels: forecastList.map((it) => String(it.label).replace(' — ', '\n')),
        datasets: [{
          label: 'میانگین RCPI',
          data: forecastList.map((it) => safeNumber(it.mean)),
          backgroundColor: ['#d93b49', '#f3bd4f', '#ff7f0e'],
          borderRadius: 7
        }]
      },
      options: (() => {
        const o = chartBaseOptions('میانگین RCPI');
        o.scales.y.min = 0;
        o.scales.y.max = 1;
        return o;
      })()
    });

    const thresholds = summary.thresholds || {};
    createOrUpdateChart('thresholds', 'threshold-chart', {
      type: 'bar',
      data: {
        labels: ['P25', 'P50', 'P75'],
        datasets: [{
          label: 'آستانه RCPI',
          data: [safeNumber(thresholds.p25), safeNumber(thresholds.p50), safeNumber(thresholds.p75)],
          backgroundColor: ['#2ca02c', '#ffbb78', '#d62728'],
          borderRadius: 7
        }]
      },
      options: (() => {
        const o = chartBaseOptions('مقدار آستانه');
        o.plugins.legend.display = false;
        o.scales.y.min = 0;
        o.scales.y.max = 1;
        return o;
      })()
    });

    // area chart based on active period
    const periodVal = $('period-select') ? $('period-select').value : '2020';
    const activeRow =
      (periodVal === 'bau' || periodVal === 'ssp245' || periodVal === 'ssp585')
        ? forecastByKey.get(periodVal)
        : (summary.historical || []).find((row) => Number(row.year) === Number(periodVal));

    const areas = activeRow?.classAreasKm2 || [null, null, null, null];

    createOrUpdateChart('area', 'area-chart', {
      type: 'bar',
      data: {
        labels: summary.classes || CLASS_LABELS,
        datasets: [{
          label: 'مساحت (کیلومترمربع)',
          data: areas.map(safeNumber),
          backgroundColor: summary.classColors || CLASS_COLORS,
          borderRadius: 7
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }

  function renderKpis() {
    const thresholds = state.summary?.thresholds || {};
    const bau = (state.summary?.forecasts || []).find((it) => it.key === 'bau');

    if ($('kpi-p25')) $('kpi-p25').textContent = toFa(thresholds.p25);
    if ($('kpi-p50')) $('kpi-p50').textContent = toFa(thresholds.p50);
    if ($('kpi-p75')) $('kpi-p75').textContent = toFa(thresholds.p75);
    if ($('kpi-bau-mean')) $('kpi-bau-mean').textContent = toFa(bau?.mean);
  }

  // ---------- Controls ----------
  function setupControls() {
    // Only these events trigger map render:
    //  - changing period
    //  - changing band
    //  - clicking load button
    // Zoom should never call renderMainMap.
    $('period-select')?.addEventListener('change', () => {
      if ($('map-title')) $('map-title').textContent = periodCurrentLabel();
      renderCharts();
      renderMainMap();
    });

    $('band-select')?.addEventListener('change', () => {
      updateLegend($('band-select').value);
      renderMainMap();
    });

    $('load-map-btn')?.addEventListener('click', () => renderMainMap({ fitOnce: false }));

    $('opacity-select')?.addEventListener('input', () => {
      const v = Number($('opacity-select').value);
      if ($('opacity-output')) $('opacity-output').textContent = `${v.toLocaleString('fa-IR')}٪`;
      if (state.mainLayer && typeof state.mainLayer.setOpacity === 'function') {
        state.mainLayer.setOpacity(v / 100);
      }
    });

    $('compare-btn')?.addEventListener('click', renderCompare);
  }

  // ---------- Boot ----------
  async function boot() {
    try {
      const [catalogRes, summaryRes] = await Promise.all([
        fetch('data/map_catalog.json', { cache: 'force-cache' }),
        fetch('data/summary.json', { cache: 'force-cache' })
      ]);

      if (!catalogRes.ok) throw new Error('map_catalog.json بارگذاری نشد.');
      if (!summaryRes.ok) throw new Error('summary.json بارگذاری نشد.');

      state.catalog = await catalogRes.json();
      state.summary = await summaryRes.json();

      initMainMap();
      initCompareMap();

      populateCompareSelects();
      await loadOptionalBoundary();

      setupControls();

      renderKpis();
      renderCharts();

      // default legend & initial render
      updateLegend($('band-select')?.value || 'CLASS');

      // ensure leaflet sizes computed then render + fit once
      setTimeout(() => {
        state.mainMap?.invalidateSize();
        state.compareMap?.invalidateSize();
        renderMainMap({ fitOnce: true });
      }, 80);
    } catch (err) {
      console.error(err);
      setStatus('map-status', err?.message || 'خطا در راه‌اندازی داشبورد.', 'warning');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
