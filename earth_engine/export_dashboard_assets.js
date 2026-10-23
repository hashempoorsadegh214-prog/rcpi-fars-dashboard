// ============================================================================
// RCPI Fars — Export assets for GitHub dashboard
// IMPORTANT: Paste this code at the VERY END of the existing Earth Engine
// RCPI script where these variables already exist:
//   classifiedCollection, region, CONFIG
// Do not run this file by itself in a separate Code Editor script.
// Exports: 30 historical multi-band GeoTIFFs + one annual-statistics CSV.
// ============================================================================

var dashboardYears = [];
for (var dashboardYear = 1996; dashboardYear <= 2025; dashboardYear++) {
  dashboardYears.push(dashboardYear);
}

// 1) Create one export task for each historical year.
// The fixed-threshold band CLASS_RAW is renamed to CLASS for the dashboard.
// Output band order: RCPI, CLASS, TPPI, HEDI.
dashboardYears.forEach(function(year) {
  var annualImage = ee.Image(
    classifiedCollection
      .filter(ee.Filter.eq('year', year))
      .first()
  );

  Export.image.toDrive({
    image: annualImage.select(
      ['RCPI', 'CLASS_RAW', 'TPPI', 'HEDI'],
      ['RCPI', 'CLASS', 'TPPI', 'HEDI']
    ).toFloat(),
    description: 'RCPI_Fars_' + year,
    folder: 'Fars_RCPI_Exports',
    fileNamePrefix: 'RCPI_Fars_' + year,
    region: region,
    scale: 1000,
    maxPixels: 1e13,
    fileFormat: 'GeoTIFF',
    formatOptions: {cloudOptimized: true}
  });
});

print('Historical dashboard export tasks created:', dashboardYears.length);
print('Expected output names: RCPI_Fars_1996.tif ... RCPI_Fars_2025.tif');

// 2) Create one compact CSV containing annual RCPI summaries and class areas.
var annualSummaryFeatures = ee.FeatureCollection(
  ee.List.sequence(1996, 2025).map(function(year) {
    year = ee.Number(year);
    var img = ee.Image(
      classifiedCollection
        .filter(ee.Filter.eq('year', year))
        .first()
    );

    var rcpiStats = img.select('RCPI').reduceRegion({
      reducer: ee.Reducer.mean().combine({
        reducer2: ee.Reducer.minMax(),
        sharedInputs: true
      }),
      geometry: region,
      scale: 1000,
      bestEffort: true,
      maxPixels: 1e13,
      tileScale: 4
    });

    var pixelAreaKm2 = ee.Image.pixelArea().divide(1e6).rename('area_km2');
    var areaAndClass = pixelAreaKm2.addBands(img.select('CLASS_RAW').rename('class'));
    var areaStats = areaAndClass.reduceRegion({
      reducer: ee.Reducer.sum().group({groupField: 1, groupName: 'class'}),
      geometry: region,
      scale: 1000,
      bestEffort: true,
      maxPixels: 1e13,
      tileScale: 4
    });
    var areaGroups = ee.List(ee.Dictionary(areaStats).get('groups', ee.List([])));
    var areaByClass = ee.Dictionary(areaGroups.iterate(function(group, accumulator) {
      group = ee.Dictionary(group);
      return ee.Dictionary(accumulator).set(
        ee.Number(group.get('class')).format(),
        group.get('sum')
      );
    }, ee.Dictionary({})));

    return ee.Feature(null, {
      year: year,
      rcpi_mean: rcpiStats.get('RCPI_mean'),
      rcpi_min: rcpiStats.get('RCPI_min'),
      rcpi_max: rcpiStats.get('RCPI_max'),
      class1_km2: areaByClass.get('1'),
      class2_km2: areaByClass.get('2'),
      class3_km2: areaByClass.get('3'),
      class4_km2: areaByClass.get('4')
    });
  })
);

Export.table.toDrive({
  collection: annualSummaryFeatures,
  description: 'RCPI_Fars_Annual_Summary',
  folder: 'Fars_RCPI_Exports',
  fileNamePrefix: 'RCPI_Fars_Annual_Summary',
  fileFormat: 'CSV'
});

print('Annual summary table export task created.');
