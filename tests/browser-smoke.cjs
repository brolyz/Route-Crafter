// Keep browser tooling outside the static app; see README for the command.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
        headless: true, args: ['--no-sandbox']
    });
    try {
        const page = await browser.newPage();
        const errors = [], dialogs = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        let fetches = 0;
        const nodes = [
            { type: 'node', id: 1, lon: -0.09, lat: 51.505 },
            { type: 'node', id: 2, lon: -0.086, lat: 51.505 },
            { type: 'node', id: 3, lon: -0.086, lat: 51.508 },
            { type: 'node', id: 4, lon: -0.09, lat: 51.508 }
        ];
        const ways = [[1, 2], [2, 3], [3, 4], [4, 1]].map((nodes, index) => ({
            type: 'way', id: 10 + index, nodes, tags: { highway: 'residential', name: `Road ${index}` }
        }));
        await page.route('https://overpass-api.de/api/interpreter', route => {
            fetches++;
            return route.fulfill({ json: { version: 0.6, elements: [...nodes, ...ways] } });
        });
        // Network-independent smoke test. Tile availability is a separate check.
        await page.route(/https:\/\/(?:[abc]\.tile\.openstreetmap\.org|mt[0-3]\.google\.com)\//, route =>
            route.fulfill({ contentType: 'image/png', body: Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }));
        await page.goto(process.env.ROUTE_CRAFTER_URL || 'http://127.0.0.1:8000/', { waitUntil: 'load' });
        await page.waitForFunction(() => window.app && typeof window.main === 'function');
        const maps = await page.evaluate(() => {
            const maps = window.app.mapManager.getBaseMaps();
            return ['Google Maps', 'Google Satellite', 'Google Hybrid'].map(name => {
                const layer = maps[name];
                window.app.mapManager.getMap().addLayer(layer);
                const coords = { x: 1, y: 1, z: 2 };
                const url = layer.getTileUrl(coords);
                window.app.mapManager.getMap().removeLayer(layer);
                return { name, url, attribution: layer.options.attribution };
            });
        });
        for (const [index, mode] of ['m', 's', 'y'].entries()) {
            assert(maps[index].url.includes(`lyrs=${mode}&x=1&y=1&z=`));
            assert(maps[index].attribution.includes('Google'));
        }

        await page.selectOption('#searchRules', 'draw_area');
        await page.evaluate(() => window.app.mapManager.getMap().fire(L.Draw.Event.CREATED, {
            layerType: 'polygon', layer: L.polygon([[51.503, -0.092], [51.503, -0.084], [51.51, -0.084], [51.51, -0.092]])
        }));
        await page.click('#previewGPXButton');
        await page.waitForFunction(() => window.app.roadProcessor.getGeoJsonLayer()?.getLayers().length > 0 &&
            !document.getElementById('previewGPXButton').classList.contains('button-loading'));
        assert.equal(fetches, 1);
        await page.evaluate(() => window.app.mapManager.handleSetDepot(L.latLng(51.505, -0.09)));
        await page.click('#generateRouteButton');
        await page.waitForFunction(() => window.app.routeGenerated);

        // Exercise the real drawing handler, including the Leaflet.draw CREATED event.
        await page.click('#drawExclusionButton');
        await page.evaluate(() => {
            const draw = window.app.routeEditor.activeDraw;
            [[51.5049, -0.0887], [51.5049, -0.0873], [51.5051, -0.0873], [51.5051, -0.0887]]
                .forEach(coord => draw.addVertex(L.latLng(...coord)));
            draw.completeShape();
        });
        assert.equal(await page.evaluate(() => window.app.mapManager.getDrawnItems().getLayers().length), 1,
            'exclusions must not become fetch areas');
        assert.equal(await page.evaluate(() => window.app.routingManager.getRoutePoints().length), 0,
            'editing must invalidate a previously generated route');

        await page.click('#drawPassageButton');
        await page.evaluate(() => {
            const draw = window.app.routeEditor.activeDraw;
            [[51.50505, -0.089], [51.504, -0.089], [51.504, -0.087], [51.50505, -0.087]]
                .forEach(coord => draw.addVertex(L.latLng(...coord)));
            draw.completeShape();
        });
        const edits = await page.evaluate(() => {
            const app = window.app;
            const features = app.roadProcessor.getGeoJsonLayer().toGeoJSON().features;
            const polygon = app.routeEditor.layers.getLayers().find(layer => layer.options.routeEditType === 'exclusion').toGeoJSON();
            const excludedSegments = features.flatMap(feature => feature.geometry.coordinates.slice(1).map((coord, index) =>
                turf.booleanPointInPolygon(turf.midpoint(turf.point(feature.geometry.coordinates[index]), turf.point(coord)), polygon)));
            const manual = features.find(feature => feature.properties.isManual);
            return { excludedSegments, manual, status: document.getElementById('routeEditsStatus').textContent };
        });
        assert(edits.manual.properties.isRouteRequired);
        assert.deepEqual(edits.manual.geometry.coordinates[0], [-0.089, 51.505]);
        assert(edits.excludedSegments.every(inside => !inside));
        assert(!edits.status.includes('disconnected'));
        assert.equal(fetches, 1, 'edits must reuse fetched roads');

        await page.click('#generateRouteButton');
        await page.waitForFunction(() => window.app.routeGenerated);
        const route = await page.evaluate(() => window.app.routingManager.getRoutePoints());
        assert(route.some(point => point[0] === 51.504 && point[1] === -0.089), 'solver must traverse the manual bypass');
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportGPXButton')]);
        const gpx = await fs.readFile(await download.path(), 'utf8');
        assert(gpx.includes('<gpx') && gpx.includes('lat="51.504" lon="-0.089"'), 'GPX must include the bypass');

        // Exercise the native edit/save and delete/save toolbar, not just synthetic events.
        await page.getByTitle('Edit exclusions and manual passages', { exact: true }).click();
        await page.evaluate(() => {
            const editor = window.app.routeEditor;
            const passage = editor.layers.getLayers().find(layer => layer.options.routeEditType === 'passage');
            passage.setLatLngs([[51.505, -0.089], [51.5035, -0.089], [51.5035, -0.087], [51.505, -0.087]]);
            passage.edited = true;
        });
        await page.locator('.leaflet-draw-actions:visible a').filter({ hasText: /^Save$/ }).click();
        assert.equal(await page.evaluate(() => window.app.routingManager.getRoutePoints().length), 0);
        assert(await page.evaluate(() => window.app.roadProcessor.getGeoJsonLayer().toGeoJSON().features
            .find(feature => feature.properties.isManual).geometry.coordinates.some(coord => coord[1] === 51.5035)));
        await page.getByTitle('Delete exclusions and manual passages', { exact: true }).click();
        await page.evaluate(() => {
            window.app.routeEditor.layers.getLayers().forEach(layer => layer.fire('click'));
        });
        await page.locator('.leaflet-draw-actions:visible a').filter({ hasText: /^Save$/ }).click();
        assert.equal(await page.evaluate(() => window.app.roadProcessor.getGeoJsonLayer().getLayers().length), 4,
            'deleting edits must restore original roads');
        await page.click('#clearButton');
        assert.equal(await page.evaluate(() => window.app.routeEditor.layers.getLayers().length), 0);
        assert.equal(await page.evaluate(() => window.app.roadProcessor.originalRoadFeatures.length), 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(dialogs, []);
        console.log('PASS: Google layer modes; fetch → exclusion → snapped passage → solver → GPX; edit/delete/reset; no JS errors.');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
