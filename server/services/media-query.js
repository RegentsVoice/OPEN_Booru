/**
 * Media query helpers (list/filter tags). Currently gallery routes own the SQL;
 * move heavy queries here as they grow.
 */
export function parseTagFilter(tagsFilter) {
    if (!tagsFilter || !String(tagsFilter).trim()) return [];
    return String(tagsFilter).trim().split(/\s+/).filter(Boolean);
}
