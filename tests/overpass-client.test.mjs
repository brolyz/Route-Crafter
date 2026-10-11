import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getOverpassRequestEndpoints, requestOverpass } from '../js/overpass-client.js';

const main = 'https://overpass-api.de/api/interpreter';
const coffee = 'https://overpass.private.coffee/api/interpreter';
const query = '[out:json][timeout:60];way[highway](51.504,-0.091,51.506,-0.087);out geom;';
const data = { elements: [] };
const jsonResponse = value => Response.json(value);

test('a 504 switches to another global server and preserves the query', async () => {
    const calls = [], attempts = [];
    const result = await requestOverpass(query, {
        onAttempt: attempt => attempts.push(attempt),
        fetchImpl: async (endpoint, options) => {
            calls.push(endpoint);
            assert.equal(options.method, 'POST');
            assert.equal(new URLSearchParams(options.body).get('data'), query);
            assert(options.signal instanceof AbortSignal);
            return endpoint === main ? new Response('Gateway Timeout', { status: 504 }) : jsonResponse(data);
        }
    });
    assert.deepEqual(calls, [main, coffee]);
    assert.equal(result.endpoint, coffee);
    assert.deepEqual(result.data, data);
    assert.deepEqual(attempts.map(value => value.attempt), [1, 2]);
});

test('temporary HTTP failures and network failures recover through failover', async t => {
    for (const status of [408, 429, 500, 502, 503]) {
        await t.test(`HTTP ${status}`, async () => {
            let calls = 0;
            await requestOverpass(query, { fetchImpl: async () => ++calls === 1
                ? new Response('', { status }) : jsonResponse(data) });
            assert.equal(calls, 2);
        });
    }
    let calls = 0;
    await requestOverpass(query, { fetchImpl: async () => {
        if (++calls === 1) throw new TypeError('Failed to fetch');
        return jsonResponse(data);
    } });
    assert.equal(calls, 2);
});

test('HTTP 200 with a timeout remark rejects partial results before trying another server', async () => {
    let calls = 0;
    const result = await requestOverpass(query, { fetchImpl: async () => ++calls === 1
        ? jsonResponse({ elements: [{ type: 'way', id: 1 }], remark: 'runtime error: Query timed out' })
        : jsonResponse(data) });
    assert.equal(calls, 2);
    assert.deepEqual(result.data, data);
});

test('invalid queries and access denials do not trigger retries', async t => {
    for (const status of [400, 401, 403]) {
        await t.test(`HTTP ${status}`, async () => {
            let calls = 0;
            await assert.rejects(requestOverpass(query, { fetchImpl: async () => {
                calls++;
                return new Response('', { status });
            } }), new RegExp(String(status)));
            assert.equal(calls, 1);
        });
    }
});

test('custom and regional endpoints keep queries on the selected server', async () => {
    for (const endpoint of ['https://overpass.osm.ch/api/interpreter', 'https://example.org/api/interpreter']) {
        assert.deepEqual(getOverpassRequestEndpoints(endpoint), [endpoint]);
        const calls = [];
        await assert.rejects(requestOverpass(query, { endpoint, fetchImpl: async candidate => {
            calls.push(candidate);
            return new Response('', { status: 504 });
        } }), /trying 1 Overpass server/);
        assert.deepEqual(calls, [endpoint]);
    }
});

test('a hung request is aborted and the next attempt succeeds', async () => {
    let calls = 0, aborted = false;
    const result = await requestOverpass(query, { timeoutMs: 10, fetchImpl: async (_, { signal }) => {
        if (++calls > 1) return jsonResponse(data);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Request aborted', 'AbortError'));
        }, { once: true }));
    } });
    assert.equal(aborted, true);
    assert.equal(result.endpoint, coffee);
});

test('unreadable and incomplete responses retry, and exhausted attempts give useful guidance', async () => {
    let calls = 0;
    const result = await requestOverpass(query, { fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response('<html>Gateway error</html>');
        if (calls === 2) return jsonResponse({ version: 0.6 });
        return jsonResponse(data);
    } });
    assert.equal(calls, 3);
    assert.deepEqual(result.data, data);
    calls = 0;
    await assert.rejects(requestOverpass(query, { fetchImpl: async () => {
        calls++;
        return new Response('', { status: 504 });
    } }), /trying 3 Overpass servers.*smaller area/);
    assert.equal(calls, 3);
});

test('the preferred global instance stays first and empty results are successful', async () => {
    assert.equal(getOverpassRequestEndpoints(coffee)[0], coffee);
    let calls = 0;
    const result = await requestOverpass(query, { endpoint: coffee, fetchImpl: async () => {
        calls++;
        return jsonResponse(data);
    } });
    assert.equal(calls, 1);
    assert.equal(result.endpoint, coffee);
});

test('geometry-only Overpass ways retain road tags and shared routing coordinates', () => {
    const require = createRequire(import.meta.url);
    const osmtogeojson = require('../vendor/osmtogeojson/3.0.0-beta.5/osmtogeojson.js');
    const result = osmtogeojson({ elements: [{
        type: 'way', id: 1, nodes: [10, 20], tags: { highway: 'residential', oneway: 'yes' },
        geometry: [{ lat: 51.505, lon: -0.09 }, { lat: 51.505, lon: -0.086 }]
    }] });
    assert.equal(result.features[0].geometry.type, 'LineString');
    assert.equal(result.features[0].properties.highway, 'residential');
    assert.equal(result.features[0].properties.oneway, 'yes');
    assert.deepEqual(result.features[0].geometry.coordinates, [[-0.09, 51.505], [-0.086, 51.505]]);
});
