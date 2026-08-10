import fs from 'fs';
import path from 'path';
import { logger, getClipModelId } from '../config.js';
import { userDbs, getUserMediaPath, saveUserDatabases } from '../db/index.js';
import {
    dhashBuffer,
    dhashImageVariants,
    dhashVideoFramesBuffer,
    decryptToBuffer,
    hammingDistance,
    bucketKey,
    isLowInfoHash,
    mapPool,
    medianDHash,
    sampleEvenly
} from '../lib/phash.js';
import {
    embedImageBuffer,
    embedVideoBuffer,
    embeddingToBase64,
    embeddingFromBase64,
    cosineSimilarity,
    preloadEmbedModel
} from '../lib/embed.js';

export const scanJobs = new Map();

const DEFAULT_THRESHOLD = 5;
const DEFAULT_FRAME_INTERVAL = 1;
const MAX_FRAMES = 400;

const DEFAULT_MIN_VIDEO_HITS = 4;

const DEFAULT_MIN_IMAGE_VIDEO_HITS = 2;
const DEFAULT_MIN_GIF_HITS = 2;
const DEFAULT_MIN_GIF_VIDEO_HITS = 2;

const DEFAULT_COSINE_THRESHOLD = 0.93;

const DEFAULT_CROSS_TYPE_COSINE = 0.93;

const DEFAULT_SAME_TYPE_ONLY = false;
const DEFAULT_CONCURRENCY = Math.min(
    4,
    Math.max(2, parseInt(process.env.PHASH_CONCURRENCY || '4', 10) || 4)
);

let scanOpts = {
    threshold: DEFAULT_THRESHOLD,
    intervalSec: DEFAULT_FRAME_INTERVAL,
    concurrency: DEFAULT_CONCURRENCY,
    minVideoHits: DEFAULT_MIN_VIDEO_HITS,
    minImageVideoHits: DEFAULT_MIN_IMAGE_VIDEO_HITS,
    minGifHits: DEFAULT_MIN_GIF_HITS,
    minGifVideoHits: DEFAULT_MIN_GIF_VIDEO_HITS,
    cosineThreshold: DEFAULT_COSINE_THRESHOLD,
    crossTypeCosine: DEFAULT_CROSS_TYPE_COSINE,
    sameTypeOnly: DEFAULT_SAME_TYPE_ONLY
};

export function ensurePhashSchema(mainDb) {
    try {
        mainDb.exec(`ALTER TABLE media ADD COLUMN phash TEXT`);
    } catch (_) {}
    try {
        mainDb.exec(`ALTER TABLE media ADD COLUMN phash_status TEXT DEFAULT 'pending'`);
    } catch (_) {}
    try {
        mainDb.exec(`ALTER TABLE media ADD COLUMN embedding TEXT`);
    } catch (_) {}
    mainDb.exec(`
        CREATE TABLE IF NOT EXISTS media_frames (
            media_id INTEGER NOT NULL,
            t REAL NOT NULL,
            phash TEXT NOT NULL,
            PRIMARY KEY (media_id, t)
        );
        CREATE INDEX IF NOT EXISTS idx_media_frames_phash ON media_frames(phash);
        CREATE INDEX IF NOT EXISTS idx_media_phash ON media(phash);
        CREATE TABLE IF NOT EXISTS duplicate_skips (
            a_id INTEGER NOT NULL,
            b_id INTEGER NOT NULL,
            skipped_at INTEGER NOT NULL,
            PRIMARY KEY (a_id, b_id)
        );
        CREATE TABLE IF NOT EXISTS duplicate_pairs (
            a_id INTEGER NOT NULL,
            b_id INTEGER NOT NULL,
            similarity REAL,
            distance REAL,
            reason TEXT,
            a_time REAL,
            b_time REAL,
            hit_count INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (a_id, b_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dup_pairs_sim ON duplicate_pairs(similarity);
        CREATE TABLE IF NOT EXISTS user_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
    syncClipModelMeta(mainDb);
}

export function syncClipModelMeta(mainDb) {
    if (!mainDb) return false;
    let changed = false;
    try {
        const modelId = getClipModelId();
        let stored = null;
        try {
            const stmt = mainDb.prepare(`SELECT value FROM user_meta WHERE key = 'clip_model'`);
            if (stmt.step()) stored = stmt.get()[0];
            stmt.free();
        } catch (_) {}
        if (stored !== modelId) {
            try {
                mainDb.run(`UPDATE media SET embedding = NULL`);
            } catch (_) {}
            mainDb.run(
                `INSERT OR REPLACE INTO user_meta (key, value) VALUES ('clip_model', ?)`,
                [modelId]
            );
            changed = true;
        }
    } catch (err) {
        logger.warn(`syncClipModelMeta: ${err.message}`);
    }
    return changed;
}

export function invalidateClipEmbeddingsForLoadedUsers() {
    let n = 0;
    for (const [, entry] of userDbs) {
        if (!entry || !entry.main) continue;
        try {
            entry.main.exec(`CREATE TABLE IF NOT EXISTS user_meta (key TEXT PRIMARY KEY, value TEXT)`);
            entry.main.run(`UPDATE media SET embedding = NULL`);
            entry.main.run(
                `INSERT OR REPLACE INTO user_meta (key, value) VALUES ('clip_model', ?)`,
                [getClipModelId()]
            );
            if (entry.dbBid) saveUserDatabases(entry.dbBid);
            n++;
        } catch (err) {
            logger.warn(`invalidate embeddings: ${err.message}`);
        }
    }
    return n;
}

export async function computeMediaPhash(dbEntry, mediaRow) {
    const {
        id, container_name, media_type, file_size,
        media_offset, encryption_iv, duration
    } = mediaRow;

    const mediaDir = dbEntry.mediaDir || getUserMediaPath(dbEntry.mediaBid);
    const containerPath = path.join(mediaDir, container_name);
    if (!fs.existsSync(containerPath)) {
        throw new Error(`Container missing: ${container_name}`);
    }

    let iv = encryption_iv;
    if (!Buffer.isBuffer(iv) && !(iv instanceof Uint8Array)) {
        iv = Buffer.from(iv || []);
    } else {
        iv = Buffer.from(iv);
    }

    const mediaBuf = await decryptToBuffer(
        containerPath,
        media_offset || 0,
        file_size,
        dbEntry.masterKey,
        iv
    );

    try {
        let embedding = null;

        if (media_type === 'image') {
            try {
                embedding = await embedImageBuffer(mediaBuf);
            } catch (err) {
                logger.warn(`CLIP embed image id=${id}: ${err.message}`);
            }

            const variants = await dhashImageVariants(mediaBuf);
            const primary = variants[0]?.hash || null;
            const frames = variants.map((v, i) => ({
                t: -(i + 1),
                hash: v.hash
            }));
            return {
                id,
                phash: primary,
                frames,
                embedding: embeddingToBase64(embedding)
            };
        }

        const dur = duration || 0;
        try {
            embedding = await embedVideoBuffer(mediaBuf, {
                frameCount: media_type === 'gif' ? 10 : 10,
                duration: dur
            });
        } catch (err) {
            logger.warn(`CLIP embed ${media_type} id=${id}: ${err.message}`);
        }

        let intervalSec = scanOpts.intervalSec || DEFAULT_FRAME_INTERVAL;
        if (media_type === 'gif') {
            intervalSec = Math.min(intervalSec, 0.25);
        } else if (dur > 0 && dur < 15) {
            intervalSec = Math.min(intervalSec, Math.max(0.3, dur / 12));
        }

        const allFrames = await dhashVideoFramesBuffer(mediaBuf, {
            intervalSec,
            maxFrames: MAX_FRAMES,
            duration: dur
        });
        const primary = medianDHash(allFrames.map((f) => f.hash));
        const frames = sampleEvenly(allFrames, media_type === 'gif' ? 16 : 20);

        return {
            id,
            phash: primary,
            frames,
            embedding: embeddingToBase64(embedding)
        };
    } finally {
        mediaBuf.fill?.(0);
    }
}

let dbWriteChain = Promise.resolve();
function withDbLock(fn) {
    const run = dbWriteChain.then(fn, fn);
    dbWriteChain = run.catch(() => {});
    return run;
}

function persistPhashResult(dbEntry, result) {
    return withDbLock(() => {
        const main = dbEntry.main;
        const { id, phash, frames, embedding } = result;
        main.run(`DELETE FROM media_frames WHERE media_id = ?`, [id]);
        main.run(
            `UPDATE media SET phash = ?, phash_status = 'done', embedding = ? WHERE id = ?`,
            [phash || null, embedding || null, id]
        );
        for (const f of frames || []) {
            main.run(
                `INSERT OR REPLACE INTO media_frames (media_id, t, phash) VALUES (?, ?, ?)`,
                [id, f.t, f.hash]
            );
        }
    });
}

export function clearPhashData(dbBid) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) throw new Error('User database not loaded');
    ensurePhashSchema(dbEntry.main);
    dbEntry.main.run(`DELETE FROM media_frames`);
    try { dbEntry.main.run(`DELETE FROM duplicate_pairs`); } catch (_) {}
    dbEntry.main.run(`UPDATE media SET phash = NULL, phash_status = 'pending', embedding = NULL`);
    saveUserDatabases(dbBid);
}

export async function backfillPhashes(dbBid, onProgress, forceAll = true) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) throw new Error('User database not loaded');
    ensurePhashSchema(dbEntry.main);

    const rows = [];
    const where = forceAll
        ? ''
        : `WHERE phash_status IS NULL OR phash_status != 'done' OR phash IS NULL OR embedding IS NULL`;
    const stmt = dbEntry.main.prepare(`
        SELECT id, file_hash, container_name, media_type, file_size, media_offset,
               encryption_iv, original_name, duration, phash_status
        FROM media
        ${where}
        ORDER BY id
    `);
    while (stmt.step()) {
        const r = stmt.get();
        rows.push({
            id: r[0], file_hash: r[1], container_name: r[2], media_type: r[3],
            file_size: r[4], media_offset: r[5], encryption_iv: r[6],
            original_name: r[7], duration: r[8], phash_status: r[9]
        });
    }
    stmt.free();

    const total = rows.length;
    let done = 0;
    const concurrency = scanOpts.concurrency || DEFAULT_CONCURRENCY;
    logger.info(`phash backfill: ${total} items, concurrency=${concurrency}, forceAll=${forceAll}`);
    if (onProgress) onProgress(0, total, null);

    for (const row of rows) {
        try {
            dbEntry.main.run(`UPDATE media SET phash_status = 'computing' WHERE id = ?`, [row.id]);
        } catch (_) {}
    }

    await mapPool(rows, concurrency, async (row) => {
        try {
            const result = await computeMediaPhash(dbEntry, row);
            await persistPhashResult(dbEntry, result);
        } catch (err) {
            logger.error(`phash fail id=${row.id}: ${err.message}`);
            await withDbLock(() => {
                try {
                    dbEntry.main.run(
                        `UPDATE media SET phash_status = 'error' WHERE id = ?`,
                        [row.id]
                    );
                } catch (_) {}
            });
        }
        done++;
        if (onProgress) onProgress(done, total, row.id);
        if (done % 10 === 0) {
            await withDbLock(() => {
                try { saveUserDatabases(dbBid); } catch (_) {}
            });
        }
    });

    saveUserDatabases(dbBid);
    return { processed: done, total };
}

function countFrameHits(framesA, framesB, maxHamming = 8) {
    if (!framesA?.length || !framesB?.length) {
        return { hits: 0, bestDist: 64, aTime: null, bTime: null };
    }
    let hits = 0;
    let bestDist = 64;
    let bestA = null;
    let bestB = null;
    const usedB = new Set();
    for (const fa of framesA) {
        if (!fa.hash || isLowInfoHash(fa.hash)) continue;
        let localBest = 64;
        let localIdx = -1;
        for (let j = 0; j < framesB.length; j++) {
            if (usedB.has(j)) continue;
            const fb = framesB[j];
            if (!fb.hash || isLowInfoHash(fb.hash)) continue;
            const d = hammingDistance(fa.hash, fb.hash);
            if (d < localBest) {
                localBest = d;
                localIdx = j;
            }
        }
        if (localIdx >= 0 && localBest <= maxHamming) {
            hits++;
            usedB.add(localIdx);
            if (localBest < bestDist) {
                bestDist = localBest;
                bestA = fa.t;
                bestB = framesB[localIdx].t;
            }
        }
    }
    return { hits, bestDist, aTime: bestA, bTime: bestB };
}

export function findDuplicatePairs(dbBid, threshold = DEFAULT_THRESHOLD) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) throw new Error('User database not loaded');
    ensurePhashSchema(dbEntry.main);

    const cosineTh = scanOpts.cosineThreshold || DEFAULT_COSINE_THRESHOLD;
    const crossTh = scanOpts.crossTypeCosine || DEFAULT_CROSS_TYPE_COSINE;
    const sameTypeOnly = !!scanOpts.sameTypeOnly;

    const skips = new Set();
    try {
        const skipStmt = dbEntry.main.prepare(`SELECT a_id, b_id FROM duplicate_skips`);
        while (skipStmt.step()) {
            const [a, b] = skipStmt.get();
            skips.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        }
        skipStmt.free();
    } catch (_) {}

    const items = [];
    const stmt = dbEntry.main.prepare(`
        SELECT id, file_hash, media_type, width, height, duration, file_size,
               original_name, display_name, created_at, phash, embedding
        FROM media
        WHERE embedding IS NOT NULL AND embedding != ''
    `);
    while (stmt.step()) {
        const r = stmt.get();
        const emb = embeddingFromBase64(r[11]);
        if (!emb || !emb.length) continue;
        items.push({
            id: r[0], file_hash: r[1], media_type: r[2] || 'unknown',
            width: r[3], height: r[4], duration: r[5], file_size: r[6],
            original_name: r[7], display_name: r[8], created_at: r[9],
            phash: r[10], embedding: emb
        });
    }
    stmt.free();

    const pairs = [];
    pairs._embCount = items.length;
    const n = items.length;

    for (let i = 0; i < n; i++) {
        const a = items[i];
        const typeA = a.media_type || 'unknown';
        const embA = a.embedding;
        for (let j = i + 1; j < n; j++) {
            const b = items[j];
            const typeB = b.media_type || 'unknown';
            if (sameTypeOnly && typeA !== typeB) continue;

            const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
            if (skips.has(key)) continue;

            const needed = typeA === typeB ? cosineTh : crossTh;
            const sim = cosineSimilarity(embA, b.embedding);
            if (sim < needed) continue;

            pairs.push({
                a, b,
                distance: Math.round((1 - sim) * 1000) / 1000,
                reason: `CLIP ${typeA}↔${typeB} (sim=${sim.toFixed(3)}${typeA === typeB ? '' : ', cross'})`,
                aTime: null,
                bTime: null,
                hitCount: 1,
                similarity: sim
            });
        }
    }

    pairs.sort((x, y) => (y.similarity || 0) - (x.similarity || 0));
    return pairs;
}

export function findPairsForSingleMedia(dbBid, mediaId) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) return [];
    ensurePhashSchema(dbEntry.main);

    const cosineTh = scanOpts.cosineThreshold || DEFAULT_COSINE_THRESHOLD;
    const crossTh = scanOpts.crossTypeCosine || DEFAULT_CROSS_TYPE_COSINE;
    const sameTypeOnly = !!scanOpts.sameTypeOnly;

    const skips = new Set();
    try {
        const skipStmt = dbEntry.main.prepare(`SELECT a_id, b_id FROM duplicate_skips`);
        while (skipStmt.step()) {
            const [a, b] = skipStmt.get();
            skips.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        }
        skipStmt.free();
    } catch (_) {}

    let target = null;
    const others = [];
    const stmt = dbEntry.main.prepare(`
        SELECT id, file_hash, media_type, width, height, duration, file_size,
               original_name, display_name, created_at, phash, embedding
        FROM media
        WHERE embedding IS NOT NULL AND embedding != ''
    `);
    while (stmt.step()) {
        const r = stmt.get();
        const emb = embeddingFromBase64(r[11]);
        if (!emb || !emb.length) continue;
        const row = {
            id: r[0], file_hash: r[1], media_type: r[2] || 'unknown',
            width: r[3], height: r[4], duration: r[5], file_size: r[6],
            original_name: r[7], display_name: r[8], created_at: r[9],
            phash: r[10], embedding: emb
        };
        if (row.id === mediaId) target = row;
        else others.push(row);
    }
    stmt.free();
    if (!target) return [];

    const typeA = target.media_type || 'unknown';
    const pairs = [];
    for (const b of others) {
        const typeB = b.media_type || 'unknown';
        if (sameTypeOnly && typeA !== typeB) continue;
        const lo = Math.min(target.id, b.id);
        const hi = Math.max(target.id, b.id);
        if (skips.has(`${lo}:${hi}`)) continue;
        const needed = typeA === typeB ? cosineTh : crossTh;
        const sim = cosineSimilarity(target.embedding, b.embedding);
        if (sim < needed) continue;
        pairs.push({
            a: target.id < b.id ? target : b,
            b: target.id < b.id ? b : target,
            distance: Math.round((1 - sim) * 1000) / 1000,
            reason: `CLIP ${typeA}↔${typeB} (sim=${sim.toFixed(3)})`,
            aTime: null,
            bTime: null,
            hitCount: 1,
            similarity: sim
        });
    }
    return pairs;
}

export function savePairsToDb(dbBid, pairs) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry || !dbEntry.main) return 0;
    ensurePhashSchema(dbEntry.main);
    const main = dbEntry.main;
    try { main.run(`BEGIN`); } catch (_) {}
    try {
        main.run(`DELETE FROM duplicate_pairs`);
        const now = Date.now();
        let n = 0;
        for (const p of pairs || []) {
            if (!p || !p.a || !p.b) continue;
            const lo = Math.min(p.a.id, p.b.id);
            const hi = Math.max(p.a.id, p.b.id);
            main.run(
                `INSERT OR REPLACE INTO duplicate_pairs
                 (a_id, b_id, similarity, distance, reason, a_time, b_time, hit_count, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    lo, hi,
                    p.similarity != null ? p.similarity : null,
                    p.distance != null ? p.distance : null,
                    p.reason || null, null, null,
                    p.hitCount || 1, now
                ]
            );
            n++;
        }
        try { main.run(`COMMIT`); } catch (_) {}
        saveUserDatabases(dbBid);
        return n;
    } catch (err) {
        try { main.run(`ROLLBACK`); } catch (_) {}
        throw err;
    }
}

export function loadPairsFromDb(dbBid, opts = {}) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry || !dbEntry.main) return [];
    ensurePhashSchema(dbEntry.main);
    const main = dbEntry.main;

    const minSim = opts.minSimilarity != null ? parseFloat(opts.minSimilarity) : null;
    const sameTypeOnly = !!opts.sameTypeOnly;

    const skips = new Set();
    try {
        const skipStmt = main.prepare(`SELECT a_id, b_id FROM duplicate_skips`);
        while (skipStmt.step()) {
            const [a, b] = skipStmt.get();
            skips.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        }
        skipStmt.free();
    } catch (_) {}

    const media = new Map();
    const mStmt = main.prepare(`
        SELECT id, file_hash, media_type, width, height, duration, file_size,
               original_name, display_name, created_at, phash
        FROM media
    `);
    while (mStmt.step()) {
        const r = mStmt.get();
        media.set(r[0], {
            id: r[0], file_hash: r[1], media_type: r[2], width: r[3], height: r[4],
            duration: r[5], file_size: r[6], original_name: r[7], display_name: r[8],
            created_at: r[9], phash: r[10]
        });
    }
    mStmt.free();

    const pairs = [];
    const pStmt = main.prepare(`
        SELECT a_id, b_id, similarity, distance, reason, a_time, b_time, hit_count
        FROM duplicate_pairs
        ORDER BY COALESCE(similarity, 0) DESC
    `);
    while (pStmt.step()) {
        const [aId, bId, sim, dist, reason, aTime, bTime, hitCount] = pStmt.get();
        const key = `${Math.min(aId, bId)}:${Math.max(aId, bId)}`;
        if (skips.has(key)) continue;
        const a = media.get(aId);
        const b = media.get(bId);
        if (!a || !b) continue;
        if (sameTypeOnly && (a.media_type || '') !== (b.media_type || '')) continue;
        if (minSim != null && Number.isFinite(minSim) && sim != null && sim + 1e-9 < minSim) continue;
        pairs.push({
            a, b,
            similarity: sim,
            distance: dist != null ? dist : (sim != null ? Math.round((1 - sim) * 1000) / 1000 : null),
            reason: reason || '',
            aTime, bTime,
            hitCount: hitCount || 1
        });
    }
    pStmt.free();
    return pairs;
}

export function removePairsForMedia(dbBid, mediaId) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry || !dbEntry.main) return;
    try {
        dbEntry.main.run(`DELETE FROM duplicate_pairs WHERE a_id = ? OR b_id = ?`, [mediaId, mediaId]);
    } catch (_) {}
}

export function updatePairsForMedia(dbBid, mediaId) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry || !dbEntry.main) return 0;
    ensurePhashSchema(dbEntry.main);
    removePairsForMedia(dbBid, mediaId);

    const related = findPairsForSingleMedia(dbBid, mediaId);
    const now = Date.now();
    let n = 0;
    for (const p of related) {
        const lo = Math.min(p.a.id, p.b.id);
        const hi = Math.max(p.a.id, p.b.id);
        dbEntry.main.run(
            `INSERT OR REPLACE INTO duplicate_pairs
             (a_id, b_id, similarity, distance, reason, a_time, b_time, hit_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                lo, hi,
                p.similarity != null ? p.similarity : null,
                p.distance != null ? p.distance : null,
                p.reason || null,
                null, null,
                p.hitCount || 1, now
            ]
        );
        n++;
    }
    if (n) saveUserDatabases(dbBid);
    return n;
}

export function startScan(dbBid, opts = {}) {
    if (scanJobs.has(dbBid) && scanJobs.get(dbBid).status === 'running') {
        return scanJobs.get(dbBid);
    }

    scanOpts = {
        threshold: Math.min(16, Math.max(1, parseInt(opts.threshold, 10) || DEFAULT_THRESHOLD)),
        concurrency: Math.min(8, Math.max(1, parseInt(opts.concurrency, 10) || DEFAULT_CONCURRENCY)),
        intervalSec: Math.min(30, Math.max(0.25, parseFloat(opts.intervalSec) || DEFAULT_FRAME_INTERVAL)),
        minVideoHits: Math.min(20, Math.max(1, parseInt(opts.minVideoHits, 10) || DEFAULT_MIN_VIDEO_HITS)),
        minImageVideoHits: Math.min(10, Math.max(1, parseInt(opts.minImageVideoHits, 10) || DEFAULT_MIN_IMAGE_VIDEO_HITS)),
        minGifHits: Math.min(10, Math.max(1, parseInt(opts.minGifHits, 10) || DEFAULT_MIN_GIF_HITS)),
        minGifVideoHits: Math.min(10, Math.max(1, parseInt(opts.minGifVideoHits, 10) || DEFAULT_MIN_GIF_VIDEO_HITS)),
        cosineThreshold: Math.min(0.999, Math.max(0.05,
            parseFloat(opts.cosineThreshold) || DEFAULT_COSINE_THRESHOLD
        )),
        crossTypeCosine: Math.min(0.999, Math.max(0.05,
            parseFloat(opts.crossTypeCosine) || DEFAULT_CROSS_TYPE_COSINE
        )),
        sameTypeOnly: opts.sameTypeOnly === true || opts.sameTypeOnly === 'true' || opts.sameTypeOnly === 1
    };

    const forceAll = opts.forceAll === true || opts.forceAll === 'true' || opts.forceAll === 1;

    preloadEmbedModel().catch((err) => {
        logger.error(`CLIP preload: ${err.message}`);
    });

    const job = {
        status: 'running',
        phase: 'hashing',
        progress: 0,
        message: 'hashing',
        pairs: [],
        pairIndex: 0,
        total: 0,
        processed: 0,
        startedAt: Date.now(),
        threshold: scanOpts.threshold
    };
    scanJobs.set(dbBid, job);

    (async () => {
        try {
            if (forceAll) {
                job.phase = 'clearing';
                job.message = 'clearing';
                clearPhashData(dbBid);
            }
            job.phase = 'hashing';
            job.message = 'hashing';
            job.progress = 2;
            job.processed = 0;
            job.total = 0;

            await backfillPhashes(dbBid, (done, total) => {
                job.processed = done;
                job.total = total;
                job.progress = total ? 2 + Math.round((done / total) * 78) : 80;
                job.message = 'hashing';
            }, forceAll);

            job.phase = 'matching';
            job.message = 'matching';
            job.progress = 90;
            const pairs = findDuplicatePairs(dbBid, scanOpts.threshold);
            const saved = savePairsToDb(dbBid, pairs);
            job.pairs = pairs;
            job.pairIndex = 0;
            job.progress = 100;
            job.phase = 'done';
            job.status = 'done';
            let dbCount = saved;
            try {
                const dbEntry = userDbs.get(dbBid);
                if (dbEntry && dbEntry.main) {
                    const s = dbEntry.main.prepare(`SELECT COUNT(*) FROM duplicate_pairs`);
                    if (s.step()) dbCount = s.get()[0] || 0;
                    s.free();
                }
            } catch (_) {}
            job.message = dbCount ? `found ${dbCount}` : 'none';
        } catch (err) {
            logger.error(`duplicate scan error: ${err.message}`);
            job.status = 'error';
            job.message = err.message;
        }
    })();

    return job;
}

export async function embedSingleMedia(dbBid, mediaId) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry || !dbEntry.main) return false;
    ensurePhashSchema(dbEntry.main);
    const stmt = dbEntry.main.prepare(`
        SELECT id, file_hash, container_name, media_type, file_size, media_offset,
               encryption_iv, original_name, duration, phash_status, embedding
        FROM media WHERE id = ?
    `);
    stmt.bind([mediaId]);
    if (!stmt.step()) {
        stmt.free();
        return false;
    }
    const r = stmt.get();
    stmt.free();
    const row = {
        id: r[0], file_hash: r[1], container_name: r[2], media_type: r[3],
        file_size: r[4], media_offset: r[5], encryption_iv: r[6],
        original_name: r[7], duration: r[8], phash_status: r[9]
    };
    const existingEmb = r[10];
    if (existingEmb && String(existingEmb).length > 16 && row.phash_status === 'done') {
        return true;
    }
    try {
        const result = await computeMediaPhash(dbEntry, row);
        await persistPhashResult(dbEntry, result);
        saveUserDatabases(dbBid);
        try {
            const n = updatePairsForMedia(dbBid, mediaId);
            if (n > 0) logger.info(`dup pairs +${n} for media ${mediaId}`);
        } catch (e) {
            logger.warn(`updatePairsForMedia ${mediaId}: ${e.message}`);
        }
        return true;
    } catch (err) {
        logger.warn(`embedSingleMedia ${mediaId}: ${err.message}`);
        return false;
    }
}

export function startReview(dbBid, opts = {}) {
    const existing = scanJobs.get(dbBid);
    if (existing && existing.status === 'running') {
        const age = Date.now() - (existing.startedAt || 0);
        if (age < 120000) {
            throw new Error('Scan still running');
        }
        existing.status = 'error';
        existing.message = 'Scan interrupted';
    }

    const parseCos = (v, fallback) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(0.999, Math.max(0.05, n));
    };

    scanOpts = {
        ...scanOpts,
        threshold: opts.threshold != null
            ? Math.min(16, Math.max(1, parseInt(opts.threshold, 10) || scanOpts.threshold))
            : scanOpts.threshold,
        minVideoHits: opts.minVideoHits != null
            ? Math.min(20, Math.max(1, parseInt(opts.minVideoHits, 10) || scanOpts.minVideoHits))
            : scanOpts.minVideoHits,
        minImageVideoHits: opts.minImageVideoHits != null
            ? Math.min(10, Math.max(1, parseInt(opts.minImageVideoHits, 10) || scanOpts.minImageVideoHits))
            : scanOpts.minImageVideoHits,
        minGifHits: opts.minGifHits != null
            ? Math.min(10, Math.max(1, parseInt(opts.minGifHits, 10) || scanOpts.minGifHits))
            : scanOpts.minGifHits,
        minGifVideoHits: opts.minGifVideoHits != null
            ? Math.min(10, Math.max(1, parseInt(opts.minGifVideoHits, 10) || scanOpts.minGifVideoHits))
            : scanOpts.minGifVideoHits,
        cosineThreshold: opts.cosineThreshold != null
            ? parseCos(opts.cosineThreshold, scanOpts.cosineThreshold)
            : scanOpts.cosineThreshold,
        crossTypeCosine: opts.crossTypeCosine != null
            ? parseCos(opts.crossTypeCosine, scanOpts.crossTypeCosine)
            : scanOpts.crossTypeCosine,
        sameTypeOnly: opts.sameTypeOnly != null
            ? (opts.sameTypeOnly === true || opts.sameTypeOnly === 'true' || opts.sameTypeOnly === 1)
            : scanOpts.sameTypeOnly
    };

    const forceRecompute = opts.forceRecompute === true || opts.forceRecompute === 'true' || opts.forceRecompute === 1;

    const job = {
        status: 'running',
        phase: forceRecompute ? 'matching' : 'loading',
        progress: 5,
        message: forceRecompute ? 'Matching…' : 'Loading pairs…',
        pairs: [],
        pairIndex: 0,
        total: 0,
        processed: 0,
        startedAt: Date.now(),
        threshold: scanOpts.threshold,
        cosineThreshold: scanOpts.cosineThreshold,
        crossTypeCosine: scanOpts.crossTypeCosine
    };
    scanJobs.set(dbBid, job);

    setImmediate(() => {
        try {
            let pairs;
            if (forceRecompute) {
                pairs = findDuplicatePairs(dbBid, scanOpts.threshold);
                savePairsToDb(dbBid, pairs);
            } else {
                pairs = loadPairsFromDb(dbBid, {
                    minSimilarity: scanOpts.cosineThreshold,
                    sameTypeOnly: scanOpts.sameTypeOnly
                });
            }
            job.pairs = pairs;
            job.pairIndex = 0;
            job.progress = 100;
            job.phase = 'review';
            job.status = pairs.length ? 'review' : 'done';
            job.message = pairs.length
                ? `Reviewing ${pairs.length} pair(s) · CLIP≥${scanOpts.cosineThreshold}`
                : `No pairs · CLIP≥${scanOpts.cosineThreshold}`;
        } catch (err) {
            job.status = 'error';
            job.phase = 'error';
            job.message = err.message || String(err);
        }
    });

    return job;
}

export function getScanStatus(dbBid) {
    const job = scanJobs.get(dbBid);
    if (!job) {
        let pairCount = 0;
        try {
            const dbEntry = userDbs.get(dbBid);
            if (dbEntry && dbEntry.main) {
                const s = dbEntry.main.prepare(`SELECT COUNT(*) FROM duplicate_pairs`);
                if (s.step()) pairCount = s.get()[0] || 0;
                s.free();
            }
        } catch (_) {}
        return { status: 'idle', progress: 0, message: '', pairCount };
    }
    return {
        status: job.status,
        phase: job.phase,
        progress: job.progress,
        message: job.message,
        pairCount: job.pairs.length,
        pairIndex: job.pairIndex,
        processed: job.processed,
        total: job.total
    };
}

export function getCurrentPair(dbBid) {
    const job = scanJobs.get(dbBid);
    if (!job || !job.pairs.length) return null;
    if (job.pairIndex >= job.pairs.length) return null;
    return job.pairs[job.pairIndex];
}

export function resolvePair(dbBid, action, deleteIds = [], pairRef = null) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) throw new Error('DB not loaded');

    let aId = pairRef && pairRef.aId != null ? parseInt(pairRef.aId, 10) : null;
    let bId = pairRef && pairRef.bId != null ? parseInt(pairRef.bId, 10) : null;

    const job = scanJobs.get(dbBid);
    if ((aId == null || bId == null) && job && job.pairs && job.pairs[job.pairIndex]) {
        const pair = job.pairs[job.pairIndex];
        aId = pair.a.id;
        bId = pair.b.id;
    }
    if (aId == null || bId == null) throw new Error('No current pair');

    const lo = Math.min(aId, bId);
    const hi = Math.max(aId, bId);

    if (action === 'skip') {
        dbEntry.main.run(
            `INSERT OR REPLACE INTO duplicate_skips (a_id, b_id, skipped_at) VALUES (?, ?, ?)`,
            [lo, hi, Date.now()]
        );
        try {
            dbEntry.main.run(`DELETE FROM duplicate_pairs WHERE a_id = ? AND b_id = ?`, [lo, hi]);
        } catch (_) {}
        saveUserDatabases(dbBid);
    }

    if (job && Array.isArray(job.pairs)) {
        const idx = job.pairs.findIndex(
            (p) => p && p.a && p.b && Math.min(p.a.id, p.b.id) === lo && Math.max(p.a.id, p.b.id) === hi
        );
        if (idx >= 0) job.pairs.splice(idx, 1);
        if (job.pairIndex >= job.pairs.length) job.pairIndex = Math.max(0, job.pairs.length - 1);
        if (!job.pairs.length) {
            job.status = 'done';
            job.message = 'Review finished';
            return { done: true, next: null };
        }
        return { done: false, next: job.pairs[Math.min(job.pairIndex, job.pairs.length - 1)] || null };
    }
    return { done: true, next: null };
}

export function deleteMediaById(dbBid, mediaId) {
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) throw new Error('DB not loaded');
    const { main, tags, previews, mediaDir } = dbEntry;

    const stmt = main.prepare(
        `SELECT file_hash, container_name FROM media WHERE id = ?`
    );
    stmt.bind([mediaId]);
    if (!stmt.step()) {
        stmt.free();
        throw new Error('Media not found');
    }
    const fileHash = stmt.get()[0];
    const containerName = stmt.get()[1];
    stmt.free();

    main.run(`DELETE FROM favorites WHERE media_id = ?`, [mediaId]);
    main.run(`DELETE FROM media_frames WHERE media_id = ?`, [mediaId]);
    main.run(`DELETE FROM media WHERE id = ?`, [mediaId]);
    tags.run(`DELETE FROM media_tags WHERE media_id = ?`, [mediaId]);
    previews.run(`DELETE FROM previews WHERE media_id = ?`, [mediaId]);
    main.run(`DELETE FROM duplicate_skips WHERE a_id = ? OR b_id = ?`, [mediaId, mediaId]);
    try { main.run(`DELETE FROM duplicate_pairs WHERE a_id = ? OR b_id = ?`, [mediaId, mediaId]); } catch (_) {}

    try {
        const p = path.join(mediaDir, containerName);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
        logger.warn(`Failed to unlink container ${containerName}: ${err.message}`);
    }

    saveUserDatabases(dbBid);
    return { fileHash };
}
