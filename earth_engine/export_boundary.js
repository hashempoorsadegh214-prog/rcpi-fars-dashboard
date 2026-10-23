// Paste this at the end of an Earth Engine script where roi_fc already exists.
// The exported file is optional; the raster maps work without it.
Export.table.toDrive({
  collection: roi_fc,
  description: 'Fars_Boundary_GeoJSON',
  folder: 'Fars_RCPI_Exports',
  fileNamePrefix: 'Fars_Boundary_GeoJSON',
  fileFormat: 'GeoJSON'
});
print('Created task: Fars_Boundary_GeoJSON');
