/* RCPI Fars Dashboard — static GitHub Pages app. Fast & Optimized Version. */
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
    boundaryLayers: [],
    mainRequestId: 0,
    mainRenderTimer: null,
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

  function toFa(value, digits = 4) {
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      !Number.isFinite(Number(value))
    ) {
      return '—';
    }

    return Number(value).toLocaleString('fa-IR', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
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
      path: state.catalog.historicalTemplate.replace(
        '{year}',
        String(year)
      ),
      bands: state.catalog.historicalBands || {
        RCPI: 0,
        CLASS: 1,
        TPPI: 2,
        HEDI: 3
      },
      group: 'historical'
    };
  }

  function forecastEntry(key) {
    return (state.catalog.forecasts || []).find(
      (item) => item.key === key
    ) || null;
  }

  function currentEntry() {
    const periodVal = $('period-select') ? $('period-select').value : '2020';

    if (periodVal === 'bau' || periodVal === 'ssp245' || periodVal === 'ssp585') {
      return forecastEntry(periodVal);
    }

    return historicalEntry(Number(periodVal));
  }

  function entryFromToken(token) {
    const [kind, value] = String(token || '').split(':');

    if (kind === 'historical') {
      return historicalEntry(Number(value));
    }

    if (kind === 'forecast') {
      return forecastEntry(value);
    }

    return null;
  }

  function colorToRgb(hex) {
    const clean = hex.replace('#', '');

    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  }

  function blendColor(a, b, ratio) {
    const ca = colorToRgb(a);
    const cb = colorToRgb(b);

    const rgb = ca.map(
      (v, i) => Math.round(v + (cb[i] - v) * ratio)
    );

    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function continuousColor(value, bandName) {
    const stops = bandName === 'RCPI'
      ? RCPI_STOPS
      : INDEX_STOPS;

    const min = stops[0].v;
    const max = stops[stops.length - 1].v;

    if (value < min || value > max) {
      return 'rgba(0,0,0,0)';
    }

    for (let i = 0; i < stops.length - 1; i += 1) {
      const left = stops[i];
      const right = stops[i + 1];

      if (value >= left.v && value <= right.v) {
        return blendColor(
          left.c,
          right.c,
          (value - left.v) / (right.v - left.v)
        );
      }
    }

    return stops[stops.length - 1].c;
  }

  function pixelColor(values, raster, bandName, bandIndex) {
    if (!values || values.length <= bandIndex) {
      return 'rgba(0,0,0,0)';
    }

    const value = Number(values[bandIndex]);

    if (!Number.isFinite(value)) {
      return 'rgba(0,0,0,0)';
    }

    const noData = raster.noDataValue;

    if (
      noData !== undefined &&
      noData !== null &&
      value === Number(noData)
    ) {
      return 'rgba(0,0,0,0)';
    }

    if (value < -9000) {
      return 'rgba(0,0,0,0)';
    }

    if (bandName === 'CLASS') {
      const classId = Math.round(value);

      return classId >= 1 && classId <= 4
        ? CLASS_COLORS[classId - 1]
        : 'rgba(0,0,0,0)';
    }

    return continuousColor(value, bandName);
  }

  function getBandIndex(entry, bandName) {
    const mapBands =
      entry.bands ||
      (
        entry.group === 'historical'
          ? state.catalog.historicalBands
          : null
      ) ||
      {};

    if (mapBands[bandName] !== undefined) {
      return Number(mapBands[bandName]);
    }

    const defaultIndices = {
      RCPI: 0,
      CLASS: 1,
      TPPI: 2,
      HEDI: 3
    };

    return defaultIndices[bandName] ?? 0;
  }

  async function getParsedRaster(entry) {
    if (!entry || !entry.path) {
      throw new Error(
        'مسیر فایل نقشه برای این انتخاب تعریف نشده است.'
      );
    }

    if (typeof window.parseGeoraster !== 'function') {
      throw new Error(
        'کتابخانه خواندن GeoTIFF بارگذاری نشد؛ اتصال اینترنت را بررسی کنید.'
      );
    }

    const url = new URL(entry.path, document.baseURI).href;
    let rasterPromise = state.rasterCache.get(url);

    if (rasterPromise) {
      state.rasterCache.delete(url);
      state.rasterCache.set(url, rasterPromise);
    } else {
      rasterPromise = (async () => {
        const response = await fetch(url, { cache: 'force-cache' });

        if (!response.ok) {
          throw new Error(
            `فایل نقشه پیدا نشد: ${entry.path}.`
          );
        }

        const buffer = await response.arrayBuffer();
        return window.parseGeoraster(buffer);
      })();

      state.rasterCache.set(url, rasterPromise);

      while (state.rasterCache.size > 10) {
        const oldestUrl = state.rasterCache.keys().next().value;
        if (oldestUrl === url) break;
        state.rasterCache.delete(oldestUrl);
      }
    }

    try {
      return await rasterPromise;
    } catch (error) {
      if (state.rasterCache.get(url) === rasterPromise) {
        state.rasterCache.delete(url);
      }
      throw error;
    }
  }

  async function loadRasterLayer(
    entry,
    bandName,
    opacity = 0.86
  ) {
    if (typeof window.GeoRasterLayer !== 'function') {
      throw new Error(
        'کتابخانه نمایش GeoTIFF بارگذاری نشد؛ صفحه را تازه‌سازی کنید.'
      );
    }

    const raster = await getParsedRaster(entry);
    const bandIndex = getBandIndex(entry, bandName);

    if (
      !Number.isInteger(bandIndex) ||
      bandIndex < 0 ||
      (
        raster.numberOfRasters &&
        bandIndex >= raster.numberOfRasters
      )
    ) {
      throw new Error(
        `باند ${bandName} در فایل ${entry.path} وجود ندارد.`
      );
    }

    // resolution: 128 به جای 256 جهت افزایش ۲ برابری سرعت پردازش گرافیکی مرورگر
    return new window.GeoRasterLayer({
      georaster: raster,
      opacity,
      resolution: 128,
      pixelValuesToColorFn: (values) =>
        pixelColor(values, raster, bandName, bandIndex)
    });
  }

  function periodCurrentLabel() {
    const select = $('period-select');
    if (!select) return 'نقشه انتخاب‌شده';
    const selectedOption = select.options[select.selectedIndex];
    return selectedOption ? selectedOption.text : 'نقشه انتخاب‌شده';
  }

  function legendRows(bandName) {
    if (bandName === 'CLASS') {
      return CLASS_LABELS.map(
        (label, index) =>
          `<div class="legend-item">` +
          `<span class="legend-swatch" style="background:${CLASS_COLORS[index]}"></span>` +
          `<span>کلاس ${index + 1}: ${label}</span>` +
          `</div>`
      ).join('');
    }

    const stops = bandName === 'RCPI'
      ? RCPI_STOPS
      : INDEX_STOPS;

    const unit = bandName === 'RCPI' ? 'RCPI' : bandName;

    return (
      `<div class="legend-gradient"></div>` +
      `<div class="legend-scale">` +
      `<span>${toFa(stops[0].v, 2)}</span>` +
      `<span>${unit}</span>` +
      `<span>${toFa(stops[stops.length - 1].v, 2)}</span>` +
      `</div>`
    );
  }

  function updateLegend(bandName) {
    const titles = {
      CLASS: 'راهنمای طبقات RCPI',
      RCPI: 'مقدار پیوسته RCPI',
      TPPI: 'مقدار TPPI',
      HEDI: 'مقدار HEDI'
    };

    $('legend-title').textContent = titles[bandName] || 'راهنما';
    $('legend-content').innerHTML = legendRows(bandName);
    $('map-band-caption').textContent = titles[bandName] || bandName;
  }

  async function renderMainMap() {
    const requestId = ++state.mainRequestId;
    const button = $('load-map-btn');
    const entry = currentEntry();
    const bandName = $('band-select').value;
    const opacity = Number($('opacity-select').value) / 100;
    const title = periodCurrentLabel();

    button.disabled = true;

    setStatus(
      'map-status',
      `در حال بارگذاری «${title}»…`,
      'info'
    );

    $('map-title').textContent = title;
    $('map-subtitle').textContent = `${bandName} · GeoTIFF`;

    updateLegend(bandName);

    try {
      if (!entry) {
        throw new Error('برای انتخاب فعلی، نقشه‌ای در فهرست تعریف نشده است.');
      }

      const newLayer = await loadRasterLayer(
        entry,
        bandName,
        opacity
      );

      if (requestId !== state.mainRequestId) return;

      const oldLayer = state.mainLayer;

      newLayer.addTo(state.mainMap);

      if (oldLayer) {
        state.mainMap.removeLayer(oldLayer);
      }

      state.mainLayer = newLayer;

      if (!state.mainLoadedOnce) {
        state.mainMap.fitBounds(
          newLayer.getBounds(),
          {
            padding: [16, 16],
            maxZoom: 8
          }
        );

        state.mainLoadedOnce = true;
      }

      setStatus(
        'map-status',
        `نقشه «${title}» نمایش داده شد.`,
        'success'
      );
    } catch (error) {
      if (requestId !== state.mainRequestId) return;

      let message = error.message || 'بارگذاری نقشه ناموفق بود.';

      if (state.mainLayer) {
        message += ' نقشه قبلی حفظ شده است.';
      }

      setStatus('map-status', message, 'warning');
    } finally {
      if (requestId === state.mainRequestId) {
        button.disabled = false;
      }
    }
  }

  function scheduleMainMapRender() {
    if (state.mainRenderTimer) {
      clearTimeout(state.mainRenderTimer);
    }

    state.mainRenderTimer = setTimeout(() => {
      state.mainRenderTimer = null;
      renderMainMap();
    }, 200);
  }

  function initMainMap() {
    const center = state.catalog.mapCenter || [29.3, 53.0];
    const zoom = state.catalog.mapZoom || 6.5;

    state.mainMap = L.map('main-map', {
      zoomControl: true,
      preferCanvas: true
    }).setView(center, zoom);

    L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap'
      }
    ).addTo(state.mainMap);

    state.mainMap.attributionControl.setPrefix('');
  }

  async function loadOptionalBoundary() {
    try {
      const response = await fetch('data/fars.geojson', { cache: 'force-cache' });
      if (!response.ok) return;

      const geojson = await response.json();

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

        if (!state.mainLoadedOnce) {
          map.fitBounds(outline.getBounds(), {
            padding: [12, 12],
            maxZoom: 8
          });
        }
      });
    } catch (_err) {}
  }

  function enableHorizontalOnlyPan(map) {
    map.dragging.disable();

    const container = map.getContainer();
    container.style.touchAction = 'pan-y';
    container.style.userSelect = 'none';
    container.style.cursor = 'grab';

    let activePointerId = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let dragAxis = null;

    function isControlTarget(target) {
      return target instanceof Element &&
        Boolean(
          target.closest(
            '.leaflet-control, .leaflet-control-container, ' +
            '.leaflet-sbs-range, input, button, select, textarea, a, ' +
            '[role="button"]'
          )
        );
    }

    container.addEventListener('pointerdown', (event) => {
      if (isControlTarget(event.target)) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.isPrimary === false) return;

      activePointerId = event.pointerId;
      startX = lastX = event.clientX;
      startY = event.clientY;
      dragAxis = null;
    });

    function onPointerMove(event) {
      if (event.pointerId !== activePointerId) return;

      const totalX = event.clientX - startX;
      const totalY = event.clientY - startY;

      if (dragAxis === null) {
        if (Math.hypot(totalX, totalY) < 4) return;

        dragAxis = Math.abs(totalX) > Math.abs(totalY) ? 'horizontal' : 'vertical';
        if (dragAxis === 'horizontal') {
          container.style.cursor = 'grabbing';
        }
      }

      if (dragAxis !== 'horizontal') return;

      if (event.cancelable) {
        event.preventDefault();
      }

      const deltaX = event.clientX - lastX;
      lastX = event.clientX;

      if (deltaX !== 0) {
        map.panBy([-deltaX, 0], { animate: false });
      }
    }

    function finishPointer(event) {
      if (event.pointerId !== activePointerId) return;
      activePointerId = null;
      dragAxis = null;
      container.style.cursor = 'grab';
    }

    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', finishPointer);
    document.addEventListener('pointercancel', finishPointer);
  }

  function configureCompareSlider() {
    const control = state.compareControl;
    const map = state.compareMap;

    if (!control || !map) return;

    const wrapper = control._container || map.getContainer().querySelector('.leaflet-sbs');
    const range = control._range || map.getContainer().querySelector('.leaflet-sbs-range');
    const divider = control._divider || map.getContainer().querySelector('.leaflet-sbs-divider');

    if (wrapper) {
      Object.assign(wrapper.style, {
        position: 'absolute',
        left: '0px',
        top: '0px',
        right: '0px',
        bottom: '0px',
        width: '100%',
        height: '100%',
        direction: 'ltr',
        pointerEvents: 'none'
      });
    }

    if (range) {
      range.setAttribute('dir', 'ltr');
      Object.assign(range.style, {
        position: 'absolute',
        left: '0px',
        right: 'auto',
        top: '50%',
        width: '100%',
        height: '42px',
        margin: '0',
        transform: 'translateY(-50%)',
        direction: 'ltr',
        pointerEvents: 'none'
      });
    }

    if (divider) divider.style.pointerEvents = 'none';

    if (typeof control._updateClip === 'function') {
      control._updateClip();
    }
  }

  function initCompareMap() {
    const center = state.catalog.mapCenter || [29.3, 53.0];
    const zoom = state.catalog.mapZoom || 6.5;

    state.compareMap = L.map('compare-map', {
      zoomControl: true,
      keyboard: false,
      preferCanvas: true
    }).setView(center, zoom);

    L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap'
      }
    ).addTo(state.compareMap);

    state.compareMap.attributionControl.setPrefix('');
    enableHorizontalOnlyPan(state.compareMap);

    state.compareMap.on('zoomend moveend resize viewreset', () => {
      window.requestAnimationFrame(() => configureCompareSlider());
    });
  }

  function populateCompareSelects() {
    const historical = (state.catalog.historicalYears || [])
      .slice()
      .reverse()
      .map((year) => ({
        value: `historical:${year}`,
        label: `سال ${year}`
      }));

    const future = (state.catalog.forecasts || []).map(
      (item) => ({
        value: `forecast:${item.key}`,
        label: item.label
      })
    );

    const all = [...historical, ...future];

    const options = all.map(
      (item) => `<option value="${item.value}">${item.label}</option>`
    ).join('');

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

    if (!leftEntry || !rightEntry) return;

    if (leftEntry.path === rightEntry.path) {
      setStatus('compare-status', 'دو نقشه متفاوت انتخاب کنید.', 'warning');
      return;
    }

    button.disabled = true;
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
      configureCompareSlider();

      setStatus('compare-status', 'مقایسه آماده است.', 'success');
    } catch (error) {
      setStatus('compare-status', error.message || 'خطا در بارگذاری.', 'warning');
    } finally {
      button.disabled = false;
    }
  }

  function safeNumber(value) {
    return (
      value === null ||
      value === undefined ||
      value === '' ||
      !Number.isFinite(Number(value))
    )
      ? null
      : Number(value);
  }

  function chartBaseOptions(yLabel = 'مقدار RCPI') {
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
      data: years.map((year) => (year <= 2025 ? historic.get(year) ?? null : null)),
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
    ].forEach((scenario) => {
      const result = forecastByKey.get(scenario.key);
      trendDatasets.push({
        label: scenario.label,
        data: years.map((year) => (year === 2035 ? safeNumber(result?.mean) : null)),
        borderColor: scenario.color,
        backgroundColor: scenario.color,
        pointRadius: 5,
        showLine: false
      });
    });

    const trendOptions = chartBaseOptions('میانگین RCPI');
    trendOptions.scales.x.ticks.callback = (_, index) => (index % 4 === 0 || index === 39 ? years[index] : '');

    createOrUpdateChart('trend', 'trend-chart', {
      type: 'line',
      data: { labels: years.map((year) => String(year)), datasets: trendDatasets },
      options: trendOptions
    });

    const scenarioOptions = chartBaseOptions('میانگین RCPI');
    scenarioOptions.scales.y.min = 0;
    scenarioOptions.scales.y.max = 1;

    createOrUpdateChart('scenario', 'scenario-chart', {
      type: 'bar',
      data: {
        labels: forecastList.map((item) => item.label.replace(' — ', '\n')),
        datasets: [{ label: 'میانگین RCPI', data: forecastList.map((item) => safeNumber(item.mean)), backgroundColor: ['#d93b49', '#f3bd4f', '#ff7f0e'], borderRadius: 7 }]
      },
      options: scenarioOptions
    });

    const thresholds = summary.thresholds || {};
    const thresholdOptions = chartBaseOptions('مقدار آستانه');
    thresholdOptions.plugins.legend.display = false;
    thresholdOptions.scales.y.min = 0;
    thresholdOptions.scales.y.max = 1;

    createOrUpdateChart('thresholds', 'threshold-chart', {
      type: 'bar',
      data: {
        labels: ['P25', 'P50', 'P75'],
        datasets: [{ label: 'آستانه RCPI', data: [safeNumber(thresholds.p25), safeNumber(thresholds.p50), safeNumber(thresholds.p75)], backgroundColor: ['#2ca02c', '#ffbb78', '#d62728'], borderRadius: 7 }]
      },
      options: thresholdOptions
    });

    const periodVal = $('period-select') ? $('period-select').value : '2020';
    let activeAreaRow = (periodVal === 'bau' || periodVal === 'ssp245' || periodVal === 'ssp585')
      ? forecastByKey.get(periodVal)
      : (summary.historical || []).find((row) => Number(row.year) === Number(periodVal));

    const areas = activeAreaRow?.classAreasKm2 || [null, null, null, null];

    const areaOptions = chartBaseOptions('مساحت (km²)');
    areaOptions.plugins.legend.display = false;
    areaOptions.scales.y.min = 0;

    createOrUpdateChart('area', 'area-chart', {
      type: 'bar',
      data: {
        labels: summary.classes || CLASS_LABELS,
        datasets: [{ label: 'مساحت (کیلومترمربع)', data: areas.map(safeNumber), backgroundColor: summary.classColors || CLASS_COLORS, borderRadius: 7 }]
      },
      options: areaOptions
    });

    const validAreas = areas.map(safeNumber);
    const totalArea = validAreas.reduce((sum, v) => sum + (v || 0), 0);
    const percentages = totalArea > 0 ? validAreas.map(v => v !== null ? Number(((v / totalArea) * 100).toFixed(1)) : null) : [null, null, null, null];

    createOrUpdateChart('donut', 'class-donut-chart', {
      type: 'doughnut',
      data: {
        labels: (summary.classes || CLASS_LABELS).map((label, idx) => `کلاس ${idx + 1}: ${label}`),
        datasets: [{ data: percentages, backgroundColor: summary.classColors || CLASS_COLORS, borderWidth: 2, borderColor: '#1e293b' }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom', rtl: true, labels: { color: '#c5d0df', font: { family: 'Vazirmatn', size: 10 }, usePointStyle: true } }
        }
      }
    });
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
    $('period-select').addEventListener('change', () => {
      $('map-title').textContent = periodCurrentLabel();
      renderCharts();
      scheduleMainMapRender();
    });

    $('load-map-btn').addEventListener('click', renderMainMap);

    $('band-select').addEventListener('change', () => {
      updateLegend($('band-select').value);
      scheduleMainMapRender();
    });

    $('opacity-select').addEventListener('input', () => {
      $('opacity-output').textContent = `${Number($('opacity-select').value).toLocaleString('fa-IR')}٪`;
      if (state.mainLayer && typeof state.mainLayer.setOpacity === 'function') {
        state.mainLayer.setOpacity(Number($('opacity-select').value) / 100);
      }
    });

    $('compare-btn').addEventListener('click', renderCompare);
  }

  async function boot() {
    try {
      const [catalogResponse, summaryResponse] = await Promise.all([
        fetch('data/map_catalog.json', { cache: 'force-cache' }),
        fetch('data/summary.json', { cache: 'force-cache' })
      ]);

      if (!catalogResponse.ok || !summaryResponse.ok) return;

      state.catalog = await catalogResponse.json();
      state.summary = await summaryResponse.json();

      populateCompareSelects();
      initMainMap();
      initCompareMap();
      await loadOptionalBoundary();

      setupControls();
      renderKpis();
      renderCharts();
      updateLegend('CLASS');

      setTimeout(() => {
        state.mainMap.invalidateSize();
        state.compareMap.invalidateSize();
        renderMainMap();
      }, 100);
    } catch (error) {
      console.error(error);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
