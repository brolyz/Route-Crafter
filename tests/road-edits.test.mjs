import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { applyRoadEdits, clipRoadsToArea, splitRoadAtAreaBoundary } from '../js/road-edits.js';

const require = createRequire(import.meta.url);
globalThis.turf = require('../vendor/turf/6.5.0/turf.min.js');
const road = coords => turf.lineString(coords, { name: 'OSM road', oneway: 'yes', isRouteRequired: true });
const box = (west, south, east, north) => turf.bboxPolygon([west, south, east, north]);

test('area trimming clips crossings with both original endpoints outside the area', () => {
    const original = road([[0, 0], [0.01, 0]]);
    const trimmed = clipRoadsToArea([original], box(0.002, -0.001, 0.008, 0.001));
    assert.deepEqual(trimmed[0].geometry.coordinates, [[0.002, 0], [0.008, 0]]);
    assert.equal(trimmed[0].properties.oneway, 'yes');
    assert.deepEqual(original.geometry.coordinates, [[0, 0], [0.01, 0]]);
});

test('imported area holes are trimmed or marked as outside navigation boundaries', () => {
    const polygon = turf.polygon([
        [[0.002, -0.001], [0.008, -0.001], [0.008, 0.001], [0.002, 0.001], [0.002, -0.001]],
        [[0.004, -0.0005], [0.004, 0.0005], [0.006, 0.0005], [0.006, -0.0005], [0.004, -0.0005]]
    ]);
    const original = road([[0, 0], [0.01, 0]]);
    assert.deepEqual(clipRoadsToArea([original], polygon).map(feature => feature.geometry.coordinates), [
        [[0.002, 0], [0.004, 0]], [[0.006, 0], [0.008, 0]]
    ]);
    const split = splitRoadAtAreaBoundary(original, polygon);
    assert.equal(split.filter(feature => !feature.properties.isOutsideBoundary).length, 2);
    assert.deepEqual(split.filter(feature => feature.properties.isOutsideBoundary).map(feature => feature.geometry.coordinates), [
        [[0, 0], [0.002, 0]], [[0.004, 0], [0.006, 0]], [[0.008, 0], [0.01, 0]]
    ]);
});

test('exclusion cuts a crossing even when the original road has no vertex inside', () => {
    const original = road([[0, 0], [0.01, 0]]);
    const result = applyRoadEdits([original], [box(0.004, -0.001, 0.006, 0.001)]);
    assert.deepEqual(result.features.map(f => f.geometry.coordinates), [
        [[0, 0], [0.004, 0]], [[0.006, 0], [0.01, 0]]
    ]);
    assert.equal(result.features[0].properties.oneway, 'yes');
    assert.deepEqual(original.geometry.coordinates, [[0, 0], [0.01, 0]]);
    assert.deepEqual(applyRoadEdits([original]).features, [original]);
});

test('exclusions remove contained roads and boundary roads, leaving outside roads untouched', () => {
    const polygon = box(0, 0, 0.01, 0.01);
    const outside = road([[0.02, 0], [0.03, 0]]);
    const result = applyRoadEdits([
        road([[0.002, 0.002], [0.008, 0.008]]), road([[0, 0], [0.01, 0]]), outside
    ], [polygon]);
    assert.deepEqual(result.features, [outside]);
});

test('polygon holes remain traversable', () => {
    const polygon = turf.polygon([
        [[0, -0.01], [0.01, -0.01], [0.01, 0.01], [0, 0.01], [0, -0.01]],
        [[0.004, -0.001], [0.004, 0.001], [0.006, 0.001], [0.006, -0.001], [0.004, -0.001]]
    ]);
    assert.deepEqual(applyRoadEdits([road([[-0.001, 0], [0.011, 0]])], [polygon]).features
        .map(f => f.geometry.coordinates), [
        [[-0.001, 0], [0, 0]], [[0.004, 0], [0.006, 0]], [[0.01, 0], [0.011, 0]]
    ]);
});

test('manual endpoints snap to the middle of roads and insert shared graph vertices', () => {
    const result = applyRoadEdits([road([[0, 0], [0.01, 0]])], [], [
        turf.lineString([[0.004, 0.0001], [0.005, 0.001], [0.006, 0.0001]])
    ], 25);
    assert.deepEqual(result.features[0].geometry.coordinates, [[0, 0], [0.004, 0], [0.006, 0], [0.01, 0]]);
    const manual = result.features[1];
    assert.deepEqual(manual.geometry.coordinates, [[0.004, 0], [0.005, 0.001], [0.006, 0]]);
    assert.equal(manual.properties.isRouteRequired, true);
    assert.equal(manual.properties.isCovered, false);
    assert.equal(manual.properties.oneway, 'no');
    assert.equal(result.disconnectedPassages, 0);
});

test('manual crossings connect to each other and roads while OSM-only crossings stay separate', () => {
    const roads = [road([[-0.01, 0], [0.01, 0]]), road([[0.009, -0.01], [0.009, 0.01]])];
    const result = applyRoadEdits(roads, [], [
        turf.lineString([[0, -0.005], [0, 0.005]]),
        turf.lineString([[-0.005, 0.003], [0.005, 0.003]])
    ], 0);
    assert.deepEqual(result.features[0].geometry.coordinates, [[-0.01, 0], [0, 0], [0.01, 0]]);
    assert.deepEqual(result.features[1].geometry.coordinates, roads[1].geometry.coordinates);
    assert(result.features[2].geometry.coordinates.some(coord => coord[0] === 0 && coord[1] === 0.003));
    assert(result.features[3].geometry.coordinates.some(coord => coord[0] === 0 && coord[1] === 0.003));
    assert.equal(result.disconnectedPassages, 0);
});

test('distant passages are reported instead of snapping across arbitrary distances', () => {
    const manual = turf.lineString([[0.1, 0.1], [0.11, 0.1]]);
    const result = applyRoadEdits([road([[0, 0], [0.01, 0]])], [], [manual]);
    assert.deepEqual(result.features[1].geometry.coordinates, manual.geometry.coordinates);
    assert.equal(result.disconnectedPassages, 1);
});

test('exclusions win over manual passages and repeated edits do not accumulate or mutate input', () => {
    const roads = [road([[0, 0], [0.01, 0]])];
    const lines = [turf.lineString([[0.002, 0], [0.008, 0]])];
    const before = JSON.stringify({ roads, lines });
    const exclusions = [box(0.004, -0.001, 0.006, 0.001)];
    const first = applyRoadEdits(roads, exclusions, lines, 0);
    assert.deepEqual(first, applyRoadEdits(roads, exclusions, lines, 0));
    assert.equal(JSON.stringify({ roads, lines }), before);
    for (const feature of first.features) {
        const coords = feature.geometry.coordinates;
        for (let i = 1; i < coords.length; i++) {
            const midpoint = turf.midpoint(turf.point(coords[i - 1]), turf.point(coords[i]));
            assert.equal(turf.booleanPointInPolygon(midpoint, exclusions[0]), false);
        }
    }
});
