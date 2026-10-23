// Paste this at the end of RCPI_Fars_BAU_2035.js after forecast2035 is defined.
// It exports exactly the four bands expected by the dashboard, in this order:
// RCPI, CLASS, TPPI, HEDI. CLASS is renamed from CLASS_RAW so that it is
// classified directly by the fixed P25/P50/P75 thresholds from reference year 2020.

Export.image.toDrive({
  image: forecast2035.select(
    ['RCPI', 'CLASS_RAW', 'TPPI', 'HEDI'],
    ['RCPI', 'CLASS', 'TPPI', 'HEDI']
  ).toFloat(),
  description: 'RCPI_Fars_2035_BAU',
  folder: 'Fars_RCPI_Exports',
  fileNamePrefix: 'RCPI_Fars_2035_BAU',
  region: region,
  scale: 1000,
  maxPixels: 1e13,
  fileFormat: 'GeoTIFF',
  formatOptions: { cloudOptimized: true }
});

print('Created export task: RCPI_Fars_2035_BAU');
