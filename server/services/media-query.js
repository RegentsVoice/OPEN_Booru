export function parseTagFilter(tagsFilter) {
    if (!tagsFilter || !String(tagsFilter).trim()) return [];
    return String(tagsFilter).trim().split(/\s+/).filter(Boolean);
}
