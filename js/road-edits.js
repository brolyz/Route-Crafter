// Geometry shared by the map editor and the routing graph. Turf is vendored.
const coordinateKey = coord => coord.map(value => value.toFixed(8)).join(',');
const canonical = coord => coord.map(value => Number(value.toFixed(8)));
const samePoint = (a, b) => coordinateKey(a) === coordinateKey(b);

function project(point, a, b) {
    const scale = Math.cos(point[1] * Math.PI / 180);
    const dx = (b[0] - a[0]) * scale;
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1,
        ((point[0] - a[0]) * scale * dx + (point[1] - a[1]) * dy) / lengthSquared)) : 0;
    return { t, coordinate: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
}

function featureWithCoordinates(feature, coordinates) {
    return { ...feature, properties: { ...feature.properties }, geometry: { type: 'LineString', coordinates } };
}

function outsideExclusions(feature, polygons) {
    let pieces = [feature];
    for (const polygon of polygons) {
        const boundary = turf.polygonToLine(polygon);
        pieces = pieces.flatMap(piece => {
            if (!turf.booleanIntersects(piece, polygon)) return [piece];
            const result = [];
            let current = [];
            const flush = () => {
                if (current.length > 1) result.push(featureWithCoordinates(piece, current));
                current = [];
            };
            const coords = piece.geometry.coordinates;
            for (let i = 1; i < coords.length; i++) {
                const a = coords[i - 1], b = coords[i];
                if (samePoint(a, b)) continue;
                const cuts = [0, 1, ...turf.lineIntersect(turf.lineString([a, b]), boundary).features
                    .map(hit => project(hit.geometry.coordinates, a, b).t)]
                    .sort((x, y) => x - y).filter((t, index, all) => !index || t - all[index - 1] > 1e-10);
                const at = t => canonical([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
                for (let j = 1; j < cuts.length; j++) {
                    const start = at(cuts[j - 1]), end = at(cuts[j]);
                    const midpoint = turf.point(at((cuts[j - 1] + cuts[j]) / 2));
                    if (turf.booleanPointInPolygon(midpoint, polygon)) {
                        flush();
                    } else if (!samePoint(start, end)) {
                        if (current.length && !samePoint(current[current.length - 1], start)) flush();
                        if (!current.length) current.push(start);
                        current.push(end);
                    }
                }
            }
            flush();
            return result;
        });
    }
    return pieces;
}

function snapEndpoint(point, features, tolerance) {
    let nearest = point, nearestDistance = tolerance;
    for (const feature of features) {
        const coords = feature.geometry.coordinates;
        for (let i = 1; i < coords.length; i++) {
            const candidate = canonical(project(point, coords[i - 1], coords[i]).coordinate);
            const distance = turf.distance(turf.point(point), turf.point(candidate), { units: 'meters' });
            if (distance <= nearestDistance) {
                nearest = candidate;
                nearestDistance = distance;
            }
        }
    }
    return nearest;
}

function insertConnections(feature, points) {
    const coords = feature.geometry.coordinates;
    const result = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1], b = coords[i];
        const cuts = points.map(point => ({ ...project(point, a, b), point }))
            .filter(hit => hit.t > 0 && hit.t < 1 && samePoint(canonical(hit.coordinate), hit.point))
            .sort((x, y) => x.t - y.t);
        for (const hit of cuts) {
            if (!samePoint(result[result.length - 1], hit.point)) result.push(hit.point);
        }
        if (!samePoint(result[result.length - 1], b)) result.push(b);
    }
    return featureWithCoordinates(feature, result);
}

function countDisconnectedPassages(features) {
    const adjacent = new Map(), reachable = new Set(), queue = [];
    for (const feature of features) {
        const keys = feature.geometry.coordinates.map(coordinateKey);
        for (const key of keys) {
            if (!adjacent.has(key)) adjacent.set(key, new Set());
            if (!feature.properties.isManual && !reachable.has(key)) {
                reachable.add(key);
                queue.push(key);
            }
        }
        for (let i = 1; i < keys.length; i++) {
            adjacent.get(keys[i - 1]).add(keys[i]);
            adjacent.get(keys[i]).add(keys[i - 1]);
        }
    }
    for (let i = 0; i < queue.length; i++) {
        for (const neighbor of adjacent.get(queue[i])) {
            if (!reachable.has(neighbor)) {
                reachable.add(neighbor);
                queue.push(neighbor);
            }
        }
    }
    return features.filter(feature => feature.properties.isManual &&
        !feature.geometry.coordinates.some(coord => reachable.has(coordinateKey(coord)))).length;
}

export function applyRoadEdits(roads, exclusions = [], manualLines = [], snapMeters = 25) {
    // Always rebuild from the original roads so moving/deleting edits restores them.
    const normalize = feature => featureWithCoordinates(feature, feature.geometry.coordinates.map(canonical));
    let features = roads.filter(feature => feature.geometry.type === 'LineString')
        .map(normalize).flatMap(feature => outsideExclusions(feature, exclusions));
    const tolerance = Number.isFinite(snapMeters) && snapMeters >= 0 ? snapMeters : 25;
    for (const line of manualLines) {
        const manual = normalize(line);
        if (manual.geometry.coordinates.length < 2) continue;
        const coords = manual.geometry.coordinates;
        // Snap to segments, not just OSM vertices, and insert a shared graph vertex below.
        coords[0] = snapEndpoint(coords[0], features, tolerance);
        coords[coords.length - 1] = snapEndpoint(coords[coords.length - 1], features, tolerance);
        manual.properties = {
            name: 'Manual passage', highway: 'path', oneway: 'no', access: 'yes',
            isManual: true, isRouteRequired: true, isCovered: false,
            isOutsideBoundary: false, coveragePercent: 0, coverageSources: 'None'
        };
        features.push(...outsideExclusions(manual, exclusions));
    }

    // Only add intersections involving manual passages. OSM crossings may be bridges.
    const connections = features.map(() => []);
    const bounds = features.map(feature => turf.bbox(feature));
    for (let i = 0; i < features.length; i++) {
        if (!features[i].properties.isManual) continue;
        for (let j = 0; j < features.length; j++) {
            if (i === j || (features[j].properties.isManual && j < i)) continue;
            const a = bounds[i], b = bounds[j];
            if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
            const hits = turf.lineIntersect(features[i], features[j]).features.map(hit => canonical(hit.geometry.coordinates));
            connections[i].push(...hits, ...features[j].geometry.coordinates);
            connections[j].push(...hits, ...features[i].geometry.coordinates);
        }
    }
    features = features.map((feature, index) => insertConnections(feature, connections[index]));
    return { features, disconnectedPassages: countDisconnectedPassages(features) };
}
