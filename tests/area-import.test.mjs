import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../vendor/fflate/0.8.2/browser.js';
import { extractKmzDocuments, readAreaFile, MAX_KML_BYTES, MAX_AREA_FILE_BYTES } from '../js/area-import.js';

test('KMZ extraction supports nested KML documents and ignores image assets', () => {
    const archive = zipSync({
        'doc.kml': strToU8('<kml/>'), 'areas/second.KML': strToU8('<kml>second</kml>'),
        'images/map.png': new Uint8Array(100), '__MACOSX/._doc.kml': new Uint8Array(10)
    });
    assert.deepEqual(extractKmzDocuments(archive), [
        { name: 'areas/second.KML', text: '<kml>second</kml>' }, { name: 'doc.kml', text: '<kml/>' }
    ]);
});

test('invalid, empty and non-KML archives give actionable errors', () => {
    assert.throws(() => extractKmzDocuments(strToU8('not a zip')), /valid, unencrypted KMZ/);
    assert.throws(() => extractKmzDocuments(zipSync({})), /does not contain a KML/);
    assert.throws(() => extractKmzDocuments(zipSync({ 'readme.txt': strToU8('hi') })), /does not contain a KML/);
});

test('oversized KML content is rejected before decompression', () => {
    const archive = zipSync({ 'doc.kml': new Uint8Array(MAX_KML_BYTES + 1) });
    assert.throws(() => extractKmzDocuments(archive), /too much KML data/);
});

test('many embedded KML documents and invalid encoding are rejected', () => {
    const files = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`${i}.kml`, strToU8('<kml/>')]));
    assert.throws(() => extractKmzDocuments(zipSync(files)), /too much KML data/);
    assert.throws(() => extractKmzDocuments(zipSync({ 'doc.kml': new Uint8Array([255, 255]) })), /UTF-8/);
});

test('file extension and size validation happens before reading the file', async () => {
    const arrayBuffer = () => { throw new Error('File should not be read'); };
    await assert.rejects(readAreaFile({ name: 'area.zip', size: 20, arrayBuffer }), /choose a .kmz or .kml/);
    await assert.rejects(readAreaFile({ name: 'area.kmz', size: 0, arrayBuffer }), /nonempty/);
    await assert.rejects(readAreaFile({ name: 'area.kmz', size: MAX_AREA_FILE_BYTES + 1, arrayBuffer }), /20 MB/);
});
