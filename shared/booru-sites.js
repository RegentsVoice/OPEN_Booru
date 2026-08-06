export const BOORU_SITES = [
    { id: 'gelbooru', name: 'Gelbooru', hostHints: ['gelbooru.com'], needsAuth: true, fields: ['user_id', 'api_key'] },
    { id: 'rule34', name: 'Rule34.xxx', hostHints: ['rule34.xxx'], needsAuth: true, fields: ['user_id', 'api_key'] },
    { id: 'realbooru', name: 'Realbooru', hostHints: ['realbooru.com'], needsAuth: false, fields: ['user_id', 'api_key'] },
    { id: 'xbooru', name: 'Xbooru', hostHints: ['xbooru.com'], needsAuth: false, fields: ['user_id', 'api_key'] },
    { id: 'hypnohub', name: 'Hypnohub', hostHints: ['hypnohub.net'], needsAuth: false, fields: ['user_id', 'api_key'] },
    { id: 'tbib', name: 'TBIB', hostHints: ['tbib.org'], needsAuth: false, fields: [] },
    { id: 'safebooru', name: 'Safebooru', hostHints: ['safebooru.org'], needsAuth: false, fields: [] },
    { id: 'derpibooru', name: 'Derpibooru', hostHints: ['derpibooru.org', 'trixiebooru.org'], needsAuth: false, fields: ['api_key'] },
    { id: 'furbooru', name: 'Furbooru', hostHints: ['furbooru.org'], needsAuth: false, fields: ['api_key'] },
    { id: 'ponybooru', name: 'Ponybooru', hostHints: ['ponybooru.org'], needsAuth: false, fields: ['api_key'] },
    { id: 'danbooru', name: 'Danbooru', hostHints: ['donmai.us', 'danbooru.donmai.us', 'aibooru.online'], needsAuth: false, fields: ['login', 'api_key'] },
    { id: 'e621', name: 'e621 / e926', hostHints: ['e621.net', 'e926.net'], needsAuth: false, fields: ['login', 'api_key'] },
    { id: 'yandere', name: 'Yande.re', hostHints: ['yande.re'], needsAuth: false, fields: [] },
    { id: 'konachan', name: 'Konachan', hostHints: ['konachan.com', 'konachan.net'], needsAuth: false, fields: [] }
];

export function siteFromHost(hostname) {
    const host = String(hostname || '').replace(/^www\./, '').toLowerCase();
    for (const s of BOORU_SITES) {
        if (s.hostHints.some(h => host === h || host.endsWith('.' + h) || host.includes(h))) {
            return s.id;
        }
    }
    return null;
}
