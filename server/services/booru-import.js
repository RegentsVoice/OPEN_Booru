import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TEMP_DIR, logger } from '../config.js';
import { detectMediaType, getMimeType } from './media-process.js';

export const importTemp = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

import { BOORU_SITES, siteFromHost } from '../../shared/booru-sites.js';

export { BOORU_SITES, siteFromHost };

setInterval(() => {
    const now = Date.now();
    for (const [id, data] of importTemp.entries()) {
        if (now - data.created > 15 * 60 * 1000) {
            try { fs.unlinkSync(data.tempPath); } catch (e) {}
            importTemp.delete(id);
            logger.info(`Cleaned stale import temp ${id}`);
        }
    }
}, 5 * 60 * 1000);

function guessExtFromUrl(url, contentType) {
    try {
        const u = new URL(url);
        const base = path.basename(u.pathname);
        const ext = path.extname(base).toLowerCase();
        if (ext && ext.length <= 5) return ext;
    } catch (e) {}
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
    if (ct.includes('png')) return '.png';
    if (ct.includes('webp')) return '.webp';
    if (ct.includes('gif')) return '.gif';
    if (ct.includes('webm')) return '.webm';
    if (ct.includes('mp4')) return '.mp4';
    return '.bin';
}

async function fetchText(url, headers = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        redirect: 'follow'
    });
    const text = await res.text();
    return { res, text };
}

async function fetchJson(url, headers = {}) {
    const { res, text } = await fetchText(url, { Accept: 'application/json', ...headers });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        err.body = text.slice(0, 200);
        throw err;
    }
    const trimmed = text.trim();
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
        const err = new Error('API returned XML instead of JSON (often means missing or invalid API credentials)');
        err.code = 'credentials_required';
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        const err = new Error('Invalid JSON from API');
        err.body = text.slice(0, 200);
        throw err;
    }
}

function tagsFromDanbooruPost(post) {
    const parts = [];
    for (const key of ['tag_string_general', 'tag_string_character', 'tag_string_copyright', 'tag_string_artist', 'tag_string_meta']) {
        if (post[key]) parts.push(post[key]);
    }
    if (!parts.length && post.tag_string) parts.push(post.tag_string);
    return parts.join(' ').trim().split(/\s+/).filter(Boolean);
}

function tagsFromE621Post(post) {
    const tags = post.tags || {};
    const parts = [];
    for (const key of ['general', 'character', 'copyright', 'artist', 'species', 'meta']) {
        if (Array.isArray(tags[key])) parts.push(...tags[key]);
    }
    return parts.filter(Boolean);
}

function tagsFromGelbooruPost(post) {
    const raw = post.tags || post.tag_string || '';
    return String(raw).trim().split(/\s+/).filter(Boolean);
}

function gelbooruAuthQuery(creds) {
    if (!creds) return '';
    const uid = creds.user_id || creds.account_id || '';
    const key = creds.api_key || '';
    if (!uid || !key) return '';
    return `&api_key=${encodeURIComponent(key)}&user_id=${encodeURIComponent(uid)}`;
}

function danbooruAuthHeaders(creds) {
    if (!creds) return {};
    const login = creds.login || creds.user_id || creds.account_id || '';
    const key = creds.api_key || '';
    if (!login || !key) return {};
    const token = Buffer.from(`${login}:${key}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}

function normalizeCdnUrl(u) {
    if (!u) return u;
    return String(u).replace(/^(https?:\/\/[^/]+)\/+/i, '$1/').replace(/([^:])\/\/+/g, '$1/');
}

function preferMp4OverWebm(fileUrl) {
    const u = normalizeCdnUrl(fileUrl);
    if (/\.webm(\?|$)/i.test(u)) {
        return u.replace(/\.webm(\?|$)/i, '.mp4$1');
    }
    return u;
}

function refererForUrl(fileUrl, fallbackOrigin) {
    try {
        const host = new URL(fileUrl).hostname.toLowerCase();
        if (host.includes('gelbooru')) return 'https://gelbooru.com/';
        if (host.includes('rule34')) return 'https://rule34.xxx/';
        if (host.includes('realbooru')) return 'https://realbooru.com/';
        if (host.includes('xbooru')) return 'https://xbooru.com/';
        if (host.includes('hypnohub')) return 'https://hypnohub.net/';
        if (host.includes('tbib')) return 'https://tbib.org/';
        if (host.includes('safebooru')) return 'https://safebooru.org/';
        if (host.includes('derpibooru') || host.includes('trixiebooru') || host.includes('derpicdn')) return 'https://derpibooru.org/';
        if (host.includes('furbooru')) return 'https://furbooru.org/';
        if (host.includes('ponybooru')) return 'https://ponybooru.org/';
        if (host.includes('donmai.us')) return 'https://danbooru.donmai.us/';
        if (host.includes('e621') || host.includes('e926')) return 'https://e621.net/';
    } catch (e) {}
    return fallbackOrigin || 'https://gelbooru.com/';
}

async function scrapeGelbooruHtmlForMedia(pageUrl) {
    const { res, text } = await fetchText(pageUrl, {
        'User-Agent': UA,
        'Accept': 'text/html'
    });
    if (!res.ok) return null;
    const mp4 = text.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i);
    const webm = text.match(/<source[^>]+src=["']([^"']+\.webm[^"']*)["']/i);
    const original = text.match(/href=["'](https?:\/\/img\d*\.(?:gelbooru|realbooru)\.com[^"']+\.(?:mp4|webm|gif|png|jpe?g|zip))["'][^>]*>\s*Original/i)
        || text.match(/https?:\/\/img\d*\.(?:gelbooru|realbooru)\.com\/images\/[^"'<\s]+\.(?:mp4|webm)/i)
        || text.match(/href=["'](https?:\/\/realbooru\.com\/images\/[^"']+\.(?:mp4|webm|gif|png|jpe?g))["']/i)
        || text.match(/https?:\/\/[^"'\s]*realbooru\.com\/images\/[^"'<\s]+\.(?:mp4|webm|gif|png|jpe?g)/i);
    let fileUrl = null;
    if (mp4) fileUrl = mp4[1];
    else if (webm) fileUrl = webm[1];
    else if (original) fileUrl = Array.isArray(original) ? (original[1] || original[0]) : original;
    if (!fileUrl) {
        const og = text.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || text.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (og) fileUrl = og[1];
    }
    if (!fileUrl) return null;
    if (fileUrl.startsWith('//')) fileUrl = 'https:' + fileUrl;
    fileUrl = preferMp4OverWebm(normalizeCdnUrl(fileUrl));
    let tags = [];
    const ta = text.match(/<textarea[^>]*id=["']tags["'][^>]*>([^<]*)<\/textarea>/i);
    if (ta) tags = ta[1].trim().split(/\s+/).filter(Boolean);
    return { fileUrl, tags };
}

export async function resolveBooruUrl(inputUrl, credentialsBySite = null) {
    let url;
    try {
        url = new URL(inputUrl.trim());
    } catch {
        throw new Error('Invalid URL');
    }

    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const href = url.href;
    const siteId = siteFromHost(host);
    const creds = (credentialsBySite && siteId) ? credentialsBySite[siteId] : null;

    if (siteId === 'danbooru' || host.includes('donmai.us') || host === 'aibooru.online') {
        const m = url.pathname.match(/\/posts\/(\d+)/);
        if (!m) throw new Error('Danbooru post URL expected (/posts/ID)');
        const api = `${url.origin}/posts/${m[1]}.json`;
        try {
            const post = await fetchJson(api, danbooruAuthHeaders(creds));
            const fileUrl = post.file_url || post.large_file_url || post.preview_file_url;
            if (!fileUrl) throw new Error('No file URL in post');
            const tags = tagsFromDanbooruPost(post);
            const ext = path.extname(new URL(fileUrl).pathname) || '.jpg';
            return {
                fileUrl,
                tags,
                originalName: `${host.replace(/\./g, '_')}_${m[1]}${ext}`,
                source: 'danbooru',
                siteId: 'danbooru',
                width: post.image_width || 0,
                height: post.image_height || 0
            };
        } catch (err) {
            if (err.status === 401 || err.status === 403 || err.code === 'credentials_required') {
                const e = new Error('Danbooru requires login/API key for this post');
                e.code = 'credentials_required';
                e.site = 'danbooru';
                throw e;
            }
            throw err;
        }
    }

    if (siteId === 'e621' || host === 'e621.net' || host === 'e926.net') {
        const m = url.pathname.match(/\/posts\/(\d+)/);
        if (!m) throw new Error('e621 post URL expected (/posts/ID)');
        const api = `${url.origin}/posts/${m[1]}.json`;
        try {
            const data = await fetchJson(api, danbooruAuthHeaders(creds));
            const post = data.post || data;
            const file = post.file || {};
            const fileUrl = file.url || post.file_url;
            if (!fileUrl) throw new Error('No file URL in post');
            const tags = tagsFromE621Post(post);
            const ext = file.ext ? `.${file.ext}` : (path.extname(new URL(fileUrl).pathname) || '.jpg');
            return {
                fileUrl,
                tags,
                originalName: `e621_${m[1]}${ext}`,
                source: 'e621',
                siteId: 'e621',
                width: file.width || 0,
                height: file.height || 0
            };
        } catch (err) {
            if (err.status === 401 || err.status === 403 || err.code === 'credentials_required') {
                const e = new Error('e621 requires login/API key for this post');
                e.code = 'credentials_required';
                e.site = 'e621';
                throw e;
            }
            throw err;
        }
    }

    const gelbooruHosts = ['gelbooru.com', 'rule34.xxx', 'safebooru.org', 'xbooru.com', 'tbib.org', 'hypnohub.net', 'realbooru.com'];
    if (gelbooruHosts.some(h => host === h || host.endsWith('.' + h))) {
        let id = url.searchParams.get('id');
        if (!id) {
            const m = url.pathname.match(/\/(\d+)/);
            if (m) id = m[1];
        }
        if (!id) throw new Error('Post id not found in URL');

        const mappedSite = host.includes('rule34') ? 'rule34'
            : host.includes('realbooru') ? 'realbooru'
            : host.includes('xbooru') ? 'xbooru'
            : host.includes('hypnohub') ? 'hypnohub'
            : host.includes('tbib') ? 'tbib'
            : host.includes('safebooru') ? 'safebooru'
            : host.includes('gelbooru') ? 'gelbooru'
            : (siteId || 'gelbooru');

        const siteCreds = (credentialsBySite && credentialsBySite[mappedSite]) || creds;
        const authQ = gelbooruAuthQuery(siteCreds);

        const needsAuth = mappedSite === 'gelbooru' || mappedSite === 'rule34';

        if (needsAuth && !authQ) {
            const e = new Error(`${mappedSite} requires API key and user id`);
            e.code = 'credentials_required';
            e.site = mappedSite;
            throw e;
        }

        const api = `${url.protocol}//${url.host}/index.php?page=dapi&s=post&q=index&json=1&id=${encodeURIComponent(id)}${authQ}`;
        try {
            const data = await fetchJson(api);
            const list = Array.isArray(data) ? data
                : (data?.post ? (Array.isArray(data.post) ? data.post : [data.post]) : []);

            const post = list[0] || (data && data.file_url ? data : null);
            if (!post) {

                try {
                    const scraped = await scrapeGelbooruHtmlForMedia(href);
                    if (scraped && scraped.fileUrl) {
                        const ext = path.extname(new URL(scraped.fileUrl).pathname) || '.bin';
                        return {
                            fileUrl: scraped.fileUrl,
                            tags: scraped.tags || [],
                            originalName: `${host.replace(/\./g, '_')}_${id}${ext}`,
                            source: mappedSite,
                            siteId: mappedSite,
                            pageUrl: href,
                            width: 0,
                            height: 0
                        };
                    }
                } catch (e2) {}
                const e = new Error('Post not found (check id or API credentials)');
                if (needsAuth) {
                    e.code = 'credentials_required';
                    e.site = mappedSite;
                }
                throw e;
            }
            let fileUrl = post.file_url || post.sample_url || post.preview_url;
            if (!fileUrl) throw new Error('No file URL in post');
            if (!fileUrl.startsWith('http')) fileUrl = new URL(fileUrl, url.origin).href;
            fileUrl = preferMp4OverWebm(normalizeCdnUrl(fileUrl));

            const tags = tagsFromGelbooruPost(post);
            if (/\.(webm|mp4)(\?|$)/i.test(fileUrl) || (tags.includes('video') || tags.includes('animated'))) {
                try {
                    const scraped = await scrapeGelbooruHtmlForMedia(href);
                    if (scraped && scraped.fileUrl) {
                        fileUrl = scraped.fileUrl;
                        if (!tags.length && scraped.tags.length) tags.push(...scraped.tags);
                    }
                } catch (scrapeErr) {
                    logger.warn(`Gelbooru HTML scrape failed: ${scrapeErr.message}`);
                }
            }
            const ext = path.extname(new URL(fileUrl).pathname) || '.jpg';
            return {
                fileUrl,
                tags,
                originalName: `${host.replace(/\./g, '_')}_${id}${ext}`,
                source: mappedSite,
                siteId: mappedSite,
                pageUrl: href,
                width: parseInt(post.width, 10) || 0,
                height: parseInt(post.height, 10) || 0
            };
        } catch (err) {
            if (err.code === 'credentials_required') throw err;
            if (err.status === 401 || err.status === 403) {
                const e = new Error(`${mappedSite} API rejected credentials (HTTP ${err.status})`);
                e.code = 'credentials_required';
                e.site = mappedSite;
                throw e;
            }

            if (err.code === 'credentials_required' || (err.message && err.message.includes('XML'))) {
                const e = new Error(err.message);
                e.code = 'credentials_required';
                e.site = mappedSite;
                throw e;
            }
            throw err;
        }
    }

    const philomenaHosts = [
        { match: (h) => h === 'derpibooru.org' || h === 'trixiebooru.org' || h.endsWith('.derpibooru.org'), id: 'derpibooru', origin: 'https://derpibooru.org' },
        { match: (h) => h === 'furbooru.org' || h.endsWith('.furbooru.org'), id: 'furbooru', origin: 'https://furbooru.org' },
        { match: (h) => h === 'ponybooru.org' || h.endsWith('.ponybooru.org'), id: 'ponybooru', origin: 'https://ponybooru.org' }
    ];
    const philo = philomenaHosts.find(p => p.match(host));
    if (philo || siteId === 'derpibooru' || siteId === 'furbooru' || siteId === 'ponybooru') {
        const site = philo ? philo.id : siteId;
        const origin = philo ? philo.origin
            : (site === 'furbooru' ? 'https://furbooru.org'
                : site === 'ponybooru' ? 'https://ponybooru.org'
                    : 'https://derpibooru.org');
        let id = null;
        const mImg = url.pathname.match(/\/images\/(\d+)/);
        const mBare = url.pathname.match(/^\/(\d+)\/?$/);
        if (mImg) id = mImg[1];
        else if (mBare) id = mBare[1];
        else id = url.searchParams.get('id');
        if (!id) throw new Error(`${site} image URL expected (/images/ID or /ID)`);

        const siteCreds = (credentialsBySite && credentialsBySite[site]) || creds;
        const key = siteCreds?.api_key || siteCreds?.account_id || '';

        const qs = new URLSearchParams();

        if (site === 'derpibooru') qs.set('filter_id', '56027');
        if (key) qs.set('key', key);
        const qstr = qs.toString();
        const api = `${origin}/api/v1/json/images/${encodeURIComponent(id)}${qstr ? `?${qstr}` : ''}`;

        const data = await fetchJson(api, {
            'User-Agent': UA,
            'Accept': 'application/json'
        });
        const image = data.image || data;
        if (!image || !image.id) throw new Error('Image not found');

        const representations = image.representations || {};
        let fileUrl = representations.full || image.view_url || representations.large || representations.medium;
        if (!fileUrl) throw new Error('No file URL in Philomena response');

        if (fileUrl.startsWith('//')) fileUrl = 'https:' + fileUrl;
        else if (fileUrl.startsWith('/')) fileUrl = origin + fileUrl;

        let tags = [];
        if (Array.isArray(image.tags)) {
            tags = image.tags.map(t => String(t).trim().replace(/\s+/g, '_')).filter(Boolean);
        } else if (typeof image.tags === 'string') {
            tags = image.tags.trim().split(/,\s*/).map(t => t.replace(/\s+/g, '_')).filter(Boolean);
        }

        const mime = image.mime_type || '';
        let ext = path.extname(new URL(fileUrl).pathname);
        if (!ext || ext === '.') {
            if (mime.includes('png')) ext = '.png';
            else if (mime.includes('gif')) ext = '.gif';
            else if (mime.includes('webm')) ext = '.webm';
            else if (mime.includes('mp4') || mime.includes('video')) ext = '.mp4';
            else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
            else ext = '.jpg';
        }

        return {
            fileUrl,
            tags,
            originalName: `${site}_${id}${ext}`,
            source: site,
            siteId: site,
            pageUrl: href,
            width: image.width || 0,
            height: image.height || 0
        };
    }

    if (host === 'yande.re' || host === 'konachan.com' || host === 'konachan.net') {
        const m = url.pathname.match(/\/post\/show\/(\d+)/) || url.pathname.match(/\/posts\/(\d+)/);
        if (!m) throw new Error('Moebooru post URL expected');
        const api = `${url.origin}/post.json?tags=id:${m[1]}`;
        const list = await fetchJson(api);
        const post = Array.isArray(list) ? list[0] : null;
        if (!post) throw new Error('Post not found');
        const fileUrl = post.file_url || post.sample_url || post.jpeg_url;
        if (!fileUrl) throw new Error('No file URL in post');
        const tags = String(post.tags || '').trim().split(/\s+/).filter(Boolean);
        const ext = path.extname(new URL(fileUrl).pathname) || '.jpg';
        return {
            fileUrl,
            tags,
            originalName: `${host.replace(/\./g, '_')}_${m[1]}${ext}`,
            source: host === 'yande.re' ? 'yandere' : 'konachan',
            siteId: host === 'yande.re' ? 'yandere' : 'konachan',
            width: post.width || 0,
            height: post.height || 0
        };
    }

    const pathname = url.pathname.toLowerCase();
    const mediaExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mkv', '.mov'];
    if (mediaExts.some(e => pathname.endsWith(e))) {
        const ext = path.extname(pathname) || '.bin';
        const base = path.basename(pathname) || `import${ext}`;
        return {
            fileUrl: href,
            tags: [],
            originalName: base,
            source: 'direct',
            siteId: null,
            width: 0,
            height: 0
        };
    }

    throw new Error('Unsupported URL. Supported: Danbooru, Gelbooru, Rule34, Safebooru, e621, Yande.re, Konachan, or direct media link');
}

export async function downloadImportToTemp(resolved, userId) {
    const referer = refererForUrl(resolved.fileUrl, resolved.pageUrl || undefined);
    let downloadUrl = preferMp4OverWebm(normalizeCdnUrl(resolved.fileUrl));
    let res = await fetch(downloadUrl, {
        headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Referer': referer,
            'Origin': referer.replace(/\/$/, '')
        },
        redirect: 'manual'
    });

    if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) {
            const next = loc.startsWith('http') ? loc : new URL(loc, downloadUrl).href;

            if (/hotlink\.php/i.test(next)) {
                res = await fetch(downloadUrl, {
                    headers: {
                        'User-Agent': UA,
                        'Accept': '*/*',
                        'Referer': referer
                    },
                    redirect: 'follow'
                });
            } else {
                res = await fetch(next, {
                    headers: {
                        'User-Agent': UA,
                        'Accept': '*/*',
                        'Referer': referer
                    },
                    redirect: 'follow'
                });
            }
        }
    } else if (!res.ok) {

        res = await fetch(downloadUrl, {
            headers: {
                'User-Agent': UA,
                'Accept': '*/*',
                'Referer': referer
            },
            redirect: 'follow'
        });
    }
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    const contentLengthHeader = res.headers.get('content-length');
    const expectedSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

    let originalName = resolved.originalName;
    if (!path.extname(originalName)) {
        originalName += guessExtFromUrl(resolved.fileUrl, contentType);
    }

    const tempId = crypto.randomBytes(16).toString('hex');
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(TEMP_DIR, `import_${tempId}_${safeName}`);

    if (!res.body || typeof res.body.getReader !== 'function') {
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('Downloaded file is empty');
        if (expectedSize > 0 && buf.length < expectedSize) {
            throw new Error(`Incomplete download: got ${buf.length} of ${expectedSize} bytes`);
        }
        fs.writeFileSync(tempPath, buf);
    } else {
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) {
                chunks.push(Buffer.from(value));
                received += value.length;
            }
        }
        if (!received) throw new Error('Downloaded file is empty');
        if (expectedSize > 0 && received < expectedSize) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
            throw new Error(`Incomplete download: got ${received} of ${expectedSize} bytes`);
        }
        const buf = Buffer.concat(chunks, received);
        fs.writeFileSync(tempPath, buf);
    }

    const stat = fs.statSync(tempPath);
    if (!stat.size) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
        throw new Error('Downloaded file is empty');
    }
    if (expectedSize > 0 && stat.size < expectedSize) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
        throw new Error(`Incomplete download: got ${stat.size} of ${expectedSize} bytes`);
    }

    const fd = fs.openSync(tempPath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    const isMp4 = head.slice(4, 8).toString('ascii') === 'ftyp';
    const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    const isGif = head.slice(0, 3).toString('ascii') === 'GIF';
    const isPng = head[0] === 0x89 && head.slice(1, 4).toString('ascii') === 'PNG';
    const isJpeg = head[0] === 0xff && head[1] === 0xd8;
    const isWebp = head.slice(0, 4).toString('ascii') === 'RIFF';
    const looksOk = isMp4 || isWebm || isGif || isPng || isJpeg || isWebp || stat.size > 1024;
    if (!looksOk) {
        logger.warn(`Import file magic bytes unexpected for ${originalName}: ${head.toString('hex')}`);
    }

    const mediaType = detectMediaType(originalName);
    const entry = {
        tempPath,
        originalName,
        fileSize: stat.size,
        tags: resolved.tags || [],
        mediaType,
        sourceUrl: resolved.fileUrl,
        source: resolved.source,
        width: resolved.width || 0,
        height: resolved.height || 0,
        expectedSize: expectedSize || stat.size,
        created: Date.now(),
        userId
    };
    importTemp.set(tempId, entry);
    logger.info(`Import downloaded ${originalName}: ${stat.size} bytes (expected ${expectedSize || 'unknown'})`);

    return {
        tempId,
        originalName,
        fileSize: stat.size,
        expectedSize: expectedSize || stat.size,
        tags: entry.tags,
        mediaType,
        mime: getMimeType(originalName),
        width: entry.width,
        height: entry.height,
        source: entry.source,
        complete: expectedSize ? stat.size >= expectedSize : true
    };
}

export function getImportTemp(tempId) {
    return importTemp.get(tempId) || null;
}

export function removeImportTemp(tempId) {
    const entry = importTemp.get(tempId);
    if (!entry) return;
    try { fs.unlinkSync(entry.tempPath); } catch (e) {}
    importTemp.delete(tempId);
}

export function releaseImportTemp(tempId) {
    importTemp.delete(tempId);
}

export async function verifyBooruCredentials(site, { account_id, login, api_key } = {}) {
    const uid = String(account_id || login || '').trim();
    const key = String(api_key || '').trim();
    if (!site) return { ok: false, message: 'Invalid site' };
    if (!uid || !key) return { ok: false, message: 'User ID/login and API key required' };

    const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    try {
        if (site === 'gelbooru' || site === 'rule34' || site === 'realbooru') {
            const base = site === 'rule34'
                ? 'https://api.rule34.xxx/index.php'
                : site === 'realbooru'
                    ? 'https://realbooru.com/index.php'
                    : 'https://gelbooru.com/index.php';
            const referer = site === 'rule34' ? 'https://rule34.xxx/'
                : site === 'realbooru' ? 'https://realbooru.com/'
                : 'https://gelbooru.com/';
            const url = `${base}?page=dapi&s=post&q=index&json=1&limit=1&user_id=${encodeURIComponent(uid)}&api_key=${encodeURIComponent(key)}`;
            const res = await fetch(url, {
                headers: {
                    'User-Agent': browserUA,
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': referer
                },
                redirect: 'follow'
            });
            const text = await res.text();
            const trimmed = text.trim();

            if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                try {
                    const data = JSON.parse(trimmed);

                    if (typeof data === 'string' && /missing authentication|invalid/i.test(data)) {
                        return { ok: false, message: data };
                    }
                    if (data && data.success === false) {
                        return { ok: false, message: data.message || data.reason || 'Auth failed' };
                    }
                    return { ok: true };
                } catch {

                }
            }

            if (/missing authentication|invalid api|invalid user/i.test(trimmed)) {
                return { ok: false, message: trimmed.slice(0, 160) };
            }

            if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
                return { ok: false, message: 'API returned XML (invalid credentials)' };
            }

            if (!res.ok) {
                const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 120);
                return {
                    ok: false,
                    code: 'http_error',
                    status: res.status,
                    message: snippet || `HTTP ${res.status}`,

                    inconclusive: res.status === 401 || res.status === 403 || res.status === 429
                };
            }

            return { ok: false, message: 'Unexpected API response' };
        }

        if (site === 'derpibooru' || site === 'furbooru' || site === 'ponybooru') {
            const origin = site === 'furbooru' ? 'https://furbooru.org'
                : site === 'ponybooru' ? 'https://ponybooru.org'
                    : 'https://derpibooru.org';
            const key = api_key || account_id || login || '';
            if (!key) return { ok: false, message: 'API key required' };
            const res = await fetch(`${origin}/api/v1/json/filters/user?key=${encodeURIComponent(key)}`, {
                headers: { 'User-Agent': browserUA, Accept: 'application/json' }
            });
            if (res.status === 401 || res.status === 403) {
                return { ok: false, message: `HTTP ${res.status}` };
            }
            if (!res.ok) {

                const res2 = await fetch(`${origin}/api/v1/json/search/images?q=id:1&per_page=1&key=${encodeURIComponent(key)}`, {
                    headers: { 'User-Agent': browserUA, Accept: 'application/json' }
                });
                if (res2.status === 401 || res2.status === 403) {
                    return { ok: false, message: `HTTP ${res2.status}` };
                }
                if (!res2.ok) {
                    return { ok: false, message: `HTTP ${res2.status}`, inconclusive: true };
                }
                return { ok: true };
            }
            return { ok: true };
        }

        if (site === 'danbooru') {
            const token = Buffer.from(`${uid}:${key}`).toString('base64');
            const res = await fetch('https://danbooru.donmai.us/posts.json?limit=1', {
                headers: {
                    'User-Agent': browserUA,
                    Accept: 'application/json',
                    Authorization: `Basic ${token}`
                }
            });
            if (res.status === 401 || res.status === 403) {
                return { ok: false, message: `HTTP ${res.status}`, inconclusive: false };
            }
            if (!res.ok) {
                return { ok: false, message: `HTTP ${res.status}`, inconclusive: true, status: res.status };
            }
            return { ok: true };
        }

        if (site === 'e621') {
            const token = Buffer.from(`${uid}:${key}`).toString('base64');
            const res = await fetch('https://e621.net/posts.json?limit=1', {
                headers: {
                    'User-Agent': browserUA,
                    Accept: 'application/json',
                    Authorization: `Basic ${token}`
                }
            });
            if (res.status === 401 || res.status === 403) {
                return { ok: false, message: `HTTP ${res.status}` };
            }
            if (!res.ok) {
                return { ok: false, message: `HTTP ${res.status}`, inconclusive: true, status: res.status };
            }
            return { ok: true };
        }

        return { ok: true };
    } catch (err) {
        return { ok: false, message: err.message || 'Network error', inconclusive: true };
    }
}
