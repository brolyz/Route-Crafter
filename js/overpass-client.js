import { DEFAULT_OVERPASS_ENDPOINT, normalizeOverpassEndpoint } from './utils.js';

export const OVERPASS_QUERY_TIMEOUT_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 75000;
const GLOBAL_ENDPOINTS = [
    DEFAULT_OVERPASS_ENDPOINT,
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter'
];
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function requestError(message, retryable) {
    return Object.assign(new Error(message), { retryable });
}

// Only interchangeable public global instances participate in failover.
// A custom or regional endpoint must never silently send its query elsewhere.
export function getOverpassRequestEndpoints(endpoint) {
    const selected = normalizeOverpassEndpoint(endpoint);
    return GLOBAL_ENDPOINTS.includes(selected)
        ? [selected, ...GLOBAL_ENDPOINTS.filter(candidate => candidate !== selected)]
        : [selected];
}

export async function requestOverpass(query, {
    endpoint = DEFAULT_OVERPASS_ENDPOINT,
    onAttempt = () => {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetchImpl = globalThis.fetch
} = {}) {
    const endpoints = getOverpassRequestEndpoints(endpoint);
    let lastError;
    for (const [index, candidate] of endpoints.entries()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            onAttempt({ endpoint: candidate, attempt: index + 1, total: endpoints.length });
            const response = await fetchImpl(candidate, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept': 'application/json'
                },
                body: new URLSearchParams({ data: query }).toString(),
                signal: controller.signal
            });
            if (!response.ok) {
                const message = response.status === 400
                    ? 'Bad Request (400): Check the navigation filter and the selected area.'
                    : `Overpass server returned HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ''}.`;
                throw requestError(message, TRANSIENT_STATUSES.has(response.status));
            }
            let data;
            try {
                data = await response.json();
            } catch (error) {
                if (controller.signal.aborted) throw error;
                throw requestError('Overpass returned an unreadable response.', true);
            }
            // Overpass can return HTTP 200 with an error and partial results.
            if (data?.remark) {
                const transient = /timed out|timeout|runtime error|out of memory|rate limit/i.test(data.remark);
                throw requestError(transient
                    ? 'Overpass could not complete the query (timeout, overload or memory limit).'
                    : 'Overpass rejected the query. Check the navigation filter and selected area.', transient);
            }
            if (!data || !Array.isArray(data.elements)) {
                throw requestError('Overpass returned an incomplete response.', true);
            }
            return { data, endpoint: candidate };
        } catch (error) {
            lastError = controller.signal.aborted
                ? requestError('The Overpass request exceeded its time limit.', true)
                : error instanceof TypeError
                    ? requestError('Unable to reach the Overpass server. Check your connection.', true)
                    : error;
            if (!lastError.retryable) throw lastError;
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`Unable to fetch data after trying ${endpoints.length} Overpass server${endpoints.length === 1 ? '' : 's'}. ` +
        `${lastError.message} Try a smaller area, reduce the boundary buffer, or select another Overpass endpoint.`);
}
