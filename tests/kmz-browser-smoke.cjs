const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const polygon = `<Polygon><outerBoundaryIs><LinearRing><coordinates>
    -0.092,51.503,0 -0.084,51.503,0 -0.084,51.510,0 -0.092,51.510,0 -0.092,51.503,0
    </coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>
    -0.0887,51.5049 -0.0887,51.5051 -0.0873,51.5051 -0.0873,51.5049 -0.0887,51.5049
    </coordinates></LinearRing></innerBoundaryIs></Polygon>`;
const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder><Placemark>
    <name>Área de interesse</name>${polygon}</Placemark></Folder></Document></kml>`;

(async () => {
    const { zipSync, strToU8 } = await import('../vendor/fflate/0.8.2/browser.js');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
        headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const errors = [], dialogs = [], queries = [], unexpectedRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        const coordinates = [[-0.09, 51.505], [-0.086, 51.505], [-0.086, 51.508], [-0.09, 51.508]];
        await page.route('https://overpass-api.de/api/interpreter', route => {
            queries.push(new URLSearchParams(route.request().postData()).get('data'));
            return route.fulfill({ json: { elements: coordinates.map((coord, i) => ({
                type: 'way', id: 10 + i, nodes: [i + 1, (i + 1) % 4 + 1],
                tags: { highway: 'residential' }, geometry: [coord, coordinates[(i + 1) % 4]].map(([lon, lat]) => ({ lon, lat }))
            })) } });
        });
        await page.route('https://*.tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png',
            body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }));
        page.on('request', request => {
            if (request.url().startsWith('https://example.org/')) unexpectedRequests.push(request.url());
        });
        await page.goto(process.env.ROUTE_CRAFTER_URL || 'http://127.0.0.1:8000/', { waitUntil: 'load' });
        await page.waitForFunction(() => window.app?.mapManager);

        const parsing = await page.evaluate(async ({ polygon }) => {
            const { parseKmlAreas } = await import('/js/area-import.js');
            const parse = text => { try { return { result: parseKmlAreas(text) }; } catch (error) { return { error: error.message }; } };
            const prefixed = '<k:kml xmlns:k="http://www.opengis.net/kml/2.2"><k:Placemark><k:MultiGeometry>' +
                polygon.replace(/<(\/?)([A-Za-z]+)/g, '<$1k:$2') + polygon.replace(/<(\/?)([A-Za-z]+)/g, '<$1k:$2') +
                '</k:MultiGeometry></k:Placemark></k:kml>';
            const simple = coords => `<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
            return {
                prefixed: parse(prefixed), openRing: parse(simple('1,1 2,1 2,2 1,2')),
                invalidXml: parse('<kml><Polygon></kml>'), invalidCoordinate: parse(simple('181,1 2,1 2,2')),
                missingLatitude: parse(simple('1, 2,1 2,2')), shortRing: parse(simple('1,1 2,1')),
                collinear: parse(simple('1,1 2,2 3,3')), missingBoundary: parse('<kml><Polygon/></kml>'),
                entities: parse('<!DOCTYPE kml [<!ENTITY x "x">]><kml/>')
            };
        }, { polygon });
        assert.equal(parsing.prefixed.result.features.length, 2);
        assert.equal(parsing.prefixed.result.features[0].geometry.coordinates.length, 2);
        assert.deepEqual(parsing.openRing.result.features[0].geometry.coordinates[0], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]);
        for (const name of ['invalidXml', 'invalidCoordinate', 'missingLatitude', 'shortRing', 'collinear', 'missingBoundary', 'entities']) {
            assert(parsing[name].error, `${name} must be rejected`);
        }
        await page.evaluate(() => { document.getElementById('bufferSize').value = '0'; });
        const archive = zipSync({ 'doc.kml': strToU8(kml), 'files/image.png': new Uint8Array([1, 2, 3]) });
        await page.setInputFiles('#areaImportInput', { name: 'interest.KMZ', mimeType: 'application/vnd.google-earth.kmz', buffer: Buffer.from(archive) });
        await page.waitForFunction(() => document.getElementById('areaImportStatus').dataset.state === 'success');
        assert.equal(await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers().length), 1);
        assert.equal(await page.evaluate(() => window.app.areaManager.getHighlightedPolygons().length), 1);
        const imported = await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers()[0].toGeoJSON());
        assert.equal(imported.properties.name, 'Área de interesse');
        assert.equal(imported.geometry.coordinates.length, 2);
        await page.click('#previewGPXButton');
        await page.waitForFunction(() => window.app.roadsFetched && !document.getElementById('previewGPXButton').classList.contains('button-loading'));
        assert.equal(queries.length, 1);
        assert(queries[0].includes('51.503 -0.092') && queries[0].includes('51.51 -0.084'));
        const holeIsEmpty = await page.evaluate(() => {
            const roads = window.app.roadProcessor.getGeoJsonLayer().toGeoJSON().features;
            const rings = window.app.mapManager.getDrawnItems().getLayers()[0].toGeoJSON().geometry.coordinates;
            const hole = turf.polygon([rings[1]]);
            return roads.length === 5 && roads.every(feature => feature.geometry.coordinates.slice(1).every((coord, i) =>
                !turf.booleanPointInPolygon(turf.midpoint(turf.point(feature.geometry.coordinates[i]), turf.point(coord)), hole)));
        });
        assert(holeIsEmpty, 'streets must be trimmed around imported inner boundaries');
        await page.evaluate(() => window.app.mapManager.handleSetDepot(L.latLng(51.505, -0.09)));
        await page.click('#generateRouteButton');
        await page.waitForFunction(() => window.app.routeGenerated);
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportGPXButton')]);
        assert(download.suggestedFilename().endsWith('.gpx'));

        for (const file of [
            { name: 'broken.kmz', buffer: Buffer.from('not a ZIP') },
            { name: 'points.kml', buffer: Buffer.from('<kml><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark><NetworkLink><Link><href>https://example.org/remote.kml</href></Link></NetworkLink></kml>') },
            { name: 'bad.kml', buffer: Buffer.from('<kml><Polygon></kml>') }
        ]) {
            await page.setInputFiles('#areaImportInput', { ...file, mimeType: 'application/octet-stream' });
            await page.waitForFunction(() => document.getElementById('areaImportStatus').dataset.state === 'error');
            assert.equal(await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers().length), 1);
            assert.equal(await page.evaluate(() => window.app.routeGenerated), true, 'failed imports must preserve current route');
        }
        // Add a second plain KML without removing the first area or the existing route edits.
        await page.setInputFiles('#areaImportInput', { name: 'second.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(kml) });
        await page.waitForFunction(() => document.getElementById('areaImportStatus').dataset.state === 'success');
        assert.equal(await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers().length), 2);
        assert.equal(await page.evaluate(() => window.app.roadsStale), true);
        // Imported areas participate in the ordinary Leaflet edit/delete toolbar.
        await page.evaluate(() => window.app.mapManager.getDrawControl().getContainer().querySelector('.leaflet-draw-edit-remove').click());
        await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers().forEach(layer => layer.fire('click')));
        await page.locator('.leaflet-draw-actions:visible a').filter({ hasText: /^Save$/ }).click();
        assert.equal(await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers().length), 0);
        assert.equal(await page.evaluate(() => window.app.areaManager.getHighlightedPolygons().length), 0);
        await page.click('#clearButton');
        assert.equal(await page.locator('#areaImportStatus').textContent(), '');
        // Reset while an asynchronous file read is in progress must cancel its result.
        await page.evaluate(() => {
            const original = File.prototype.arrayBuffer;
            File.prototype.arrayBuffer = function () {
                return new Promise(resolve => { window.finishAreaRead = async () => {
                    File.prototype.arrayBuffer = original;
                    resolve(await original.call(this));
                }; });
            };
        });
        await page.setInputFiles('#areaImportInput', { name: 'delayed.kmz', mimeType: 'application/vnd.google-earth.kmz', buffer: Buffer.from(archive) });
        await page.waitForFunction(() => window.finishAreaRead);
        await page.click('#clearButton');
        await page.evaluate(() => window.finishAreaRead());
        await page.waitForFunction(() => !document.getElementById('importAreaButton').disabled);
        assert.equal(await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers().length), 0);
        assert.equal(await page.locator('#areaImportStatus').textContent(), '');
        assert.deepEqual(errors, []);
        assert.deepEqual(dialogs, []);
        assert.deepEqual(unexpectedRequests, []);
        console.log('PASS: KMZ/KML polygons, namespaces, holes, validation, local-only import, fetch → solver → GPX, additive imports, deletion and reset.');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
