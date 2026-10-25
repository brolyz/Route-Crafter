import { unzipSync } from '../vendor/fflate/0.8.2/browser.js';

export const MAX_AREA_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_KML_BYTES = 10 * 1024 * 1024;
const MAX_KML_DOCUMENTS = 64;
const MAX_COORDINATES = 200000;

class AreaImportError extends Error {}

export function extractKmzDocuments(bytes) {
    let totalSize = 0, count = 0;
    let files;
    try {
        files = unzipSync(bytes, { filter: entry => {
            // Images and other assets are not needed to import polygon geometry.
            if (!/\.kml$/i.test(entry.name) || entry.name.startsWith('__MACOSX/')) return false;
            totalSize += entry.originalSize;
            if (++count > MAX_KML_DOCUMENTS || totalSize > MAX_KML_BYTES) {
                throw new AreaImportError('The KMZ contains too much KML data (maximum 10 MB across 64 documents).');
            }
            return true;
        } });
    } catch (error) {
        if (error instanceof AreaImportError) throw error;
        throw new AreaImportError('Could not open the KMZ. Please choose a valid, unencrypted KMZ file.');
    }
    const documents = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
    if (!documents.length) throw new AreaImportError('The KMZ does not contain a KML document.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        return documents.map(([name, data]) => ({ name, text: decoder.decode(data) }));
    } catch (error) {
        throw new AreaImportError('The KML document must use UTF-8 encoding.');
    }
}

const children = (node, name) => Array.from(node.children).filter(child => child.localName === name);
const descendants = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));

export function parseKmlAreas(text, Parser = globalThis.DOMParser) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new AreaImportError('KML documents with DTD or entity declarations are not supported.');
    const document = new Parser().parseFromString(text, 'application/xml');
    if (descendants(document, 'parsererror').length || document.documentElement?.localName !== 'kml') {
        throw new AreaImportError('The file does not contain valid KML XML.');
    }
    let coordinateCount = 0;
    const readRing = boundary => {
        const ring = children(boundary, 'LinearRing')[0];
        const coordinates = ring && children(ring, 'coordinates')[0];
        if (!coordinates?.textContent.trim()) throw new AreaImportError('A polygon is missing its boundary coordinates.');
        const tuples = coordinates.textContent.trim().split(/\s+/);
        coordinateCount += tuples.length;
        if (coordinateCount > MAX_COORDINATES) throw new AreaImportError('The KML contains too many coordinates. Please simplify the area first.');
        const points = tuples.map(tuple => {
            const parts = tuple.split(',');
            const longitude = Number(parts[0]), latitude = Number(parts[1]);
            if (parts.length < 2 || parts.length > 3 || !parts[0].trim() || !parts[1].trim() ||
                !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
                longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
                throw new AreaImportError('A polygon contains invalid longitude/latitude coordinates.');
            }
            return [longitude, latitude]; // Altitude is not used for road queries.
        }).filter((point, index, all) => !index || point[0] !== all[index - 1][0] || point[1] !== all[index - 1][1]);
        if (new Set(points.map(point => point.join(','))).size < 3) {
            throw new AreaImportError('A polygon boundary needs at least three different points.');
        }
        const first = points[0], last = points[points.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
        const area = points.slice(1).reduce((sum, point, index) => sum +
            (points[index][0] - first[0]) * (point[1] - first[1]) -
            (point[0] - first[0]) * (points[index][1] - first[1]), 0);
        if (area === 0) throw new AreaImportError('A polygon boundary has no area.');
        return points;
    };
    const features = descendants(document, 'Polygon').map(polygon => {
        const outer = children(polygon, 'outerBoundaryIs');
        if (outer.length !== 1) throw new AreaImportError('A polygon must have one outer boundary.');
        let placemark = polygon.parentElement;
        while (placemark && placemark.localName !== 'Placemark') placemark = placemark.parentElement;
        const name = placemark && children(placemark, 'name')[0]?.textContent.trim();
        return {
            type: 'Feature', properties: { name: name || 'Imported area' },
            geometry: { type: 'Polygon', coordinates: [readRing(outer[0]), ...children(polygon, 'innerBoundaryIs').map(readRing)] }
        };
    });
    return { type: 'FeatureCollection', features };
}

export async function readAreaFile(file) {
    if (!/\.(kmz|kml)$/i.test(file.name)) throw new AreaImportError('Please choose a .kmz or .kml file.');
    if (!file.size || file.size > MAX_AREA_FILE_BYTES) throw new AreaImportError('Please choose a nonempty file no larger than 20 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let documents;
    if (/\.kmz$/i.test(file.name)) {
        documents = extractKmzDocuments(bytes);
    } else {
        if (bytes.length > MAX_KML_BYTES) throw new AreaImportError('KML documents must be no larger than 10 MB.');
        try {
            documents = [{ name: file.name, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }];
        } catch (error) {
            throw new AreaImportError('The KML document must use UTF-8 encoding.');
        }
    }
    const features = documents.flatMap(document => parseKmlAreas(document.text).features);
    if (!features.length) throw new AreaImportError('No polygon areas were found. Point markers, paths and external NetworkLinks are not imported.');
    return { type: 'FeatureCollection', features };
}
