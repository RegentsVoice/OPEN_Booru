import fs from 'fs';
import path from 'path';
import { logger } from '../config.js';
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
const DEFAULT_FRAME_INTERVAL = 3;
const MAX_FRAMES = 400;

const DEFAULT_MIN_VIDEO_HITS = 4;

const DEFAULT_MIN_IMAGE_VIDEO_HITS = 2;
const DEFAULT_MIN_GIF_HITS = 2;
const DEFAULT_MIN_GIF_VIDEO_HITS = 2;

const DEFAULT_COSINE_THRESHOLD = 0.93;

const DEFAULT_CROSS_TYPE_COSINE = 0.90;

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
    `);
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
        : `WHERE phash_status IS NULL OR phash_status != 'done' OR phash IS NULL`;
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
    const minVideoHits = scanOpts.minVideoHits || DEFAULT_MIN_VIDEO_HITS;
    const minImageVideoHits = scanOpts.minImageVideoHits || DEFAULT_MIN_IMAGE_VIDEO_HITS;
    const minGifHits = scanOpts.minGifHits || DEFAULT_MIN_GIF_HITS;
    const minGifVideoHits = scanOpts.minGifVideoHits || DEFAULT_MIN_GIF_VIDEO_HITS;
    const frameHamming = Math.min(10, Math.max(4, (threshold || DEFAULT_THRESHOLD) + 3));

    const media = new Map();
    const stmt = dbEntry.main.prepare(`
        SELECT id, file_hash, media_type, width, height, duration, file_size,
               original_name, display_name, created_at, phash, embedding
        FROM media
    `);
    while (stmt.step()) {
        const r = stmt.get();
        const emb = embeddingFromBase64(r[11]);
        media.set(r[0], {
            id: r[0], file_hash: r[1], media_type: r[2], width: r[3], height: r[4],
            duration: r[5], file_size: r[6], original_name: r[7], display_name: r[8],
            created_at: r[9], phash: r[10], embedding: emb,
            frames: []
        });
    }
    stmt.free();

    const frameStmt = dbEntry.main.prepare(
        `SELECT media_id, t, phash FROM media_frames ORDER BY media_id, t`
    );
    while (frameStmt.step()) {
        const [mid, t, hash] = frameStmt.get();
        const m = media.get(mid);
        if (m) m.frames.push({ t, hash });
    }
    frameStmt.free();

    const skips = new Set();
    const skipStmt = dbEntry.main.prepare(`SELECT a_id, b_id FROM duplicate_skips`);
    while (skipStmt.step()) {
        const [a, b] = skipStmt.get();
        skips.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
    }
    skipStmt.free();

    const items = [...media.values()];
    const pairs = [];

    const normalizeType = (t) => t || 'unknown';
    const isMotion = (t) => t === 'video' || t === 'gif';

    const withEmb = items.filter((m) => m.embedding && m.embedding.length);
    for (let i = 0; i < withEmb.length; i++) {
        for (let j = i + 1; j < withEmb.length; j++) {
            const a = withEmb[i];
            const b = withEmb[j];
            const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
            if (skips.has(key)) continue;

            const typeA = normalizeType(a.media_type);
            const typeB = normalizeType(b.media_type);
            const sameType = typeA === typeB;

            if (sameTypeOnly && !sameType) continue;

            const bothMotion = isMotion(typeA) && isMotion(typeB);
            const mixedMotion = bothMotion && typeA !== typeB;
            const hasGif = typeA === 'gif' || typeB === 'gif';

            if (bothMotion) {
                const dA = a.duration || 0;
                const dB = b.duration || 0;
                if (dA > 0.5 && dB > 0.5) {
                    const ratio = Math.max(dA, dB) / Math.min(dA, dB);
                    const maxRatio = hasGif ? 12 : 3;
                    if (ratio > maxRatio) continue;
                }
            }

            let needed;
            if (sameType) {
                needed = cosineTh;
            } else if (mixedMotion) {
                needed = Math.min(cosineTh, 0.90);
            } else {
                needed = Math.max(cosineTh, crossTh);
            }

            const sim = cosineSimilarity(a.embedding, b.embedding);

            let hitCount = 1;
            let aTime = null;
            let bTime = null;
            let reasonExtra = '';
            let accepted = false;

            const motionPair = isMotion(typeA) || isMotion(typeB);
            if (motionPair) {
                const { hits, bestDist, aTime: at, bTime: bt } = countFrameHits(
                    a.frames, b.frames, frameHamming
                );
                hitCount = hits;
                aTime = at;
                bTime = bt;

                let minHits;
                if (typeA === 'gif' && typeB === 'gif') {
                    minHits = minGifHits;
                } else if (mixedMotion) {
                    minHits = minGifVideoHits;
                } else if (bothMotion) {
                    minHits = minVideoHits;
                } else {
                    minHits = minImageVideoHits;
                }

                const strongClip = sim >= Math.min(0.97, needed + 0.05);
                const strongHits = hits >= Math.max(minHits + 1, 3);
                const required = strongClip ? Math.max(1, Math.ceil(minHits / 2)) : minHits;

                if (sim >= needed && hits >= required) {
                    accepted = true;
                    reasonExtra = `, hits=${hits}/${required}, d=${bestDist}`;
                }
                else if (strongHits && sim >= Math.max(0.82, cosineTh - 0.08)) {
                    accepted = true;
                    reasonExtra = `, hits=${hits} (frame-led), d=${bestDist}`;
                }
                else if (mixedMotion && hits >= Math.max(minHits, 3) && sim >= 0.80) {
                    accepted = true;
                    reasonExtra = `, hits=${hits} (gif↔video frames), d=${bestDist}`;
                }

                if (!accepted) continue;
            } else {
                if (sim < needed) continue;
            }

            const distance = Math.round((1 - sim) * 1000) / 1000;
            pairs.push({
                a, b,
                distance,
                reason: `CLIP ${typeA}↔${typeB} (sim=${sim.toFixed(3)}${sameType ? '' : ', cross'}${reasonExtra})`,
                aTime,
                bTime,
                hitCount,
                similarity: sim
            });
        }
    }

    const noEmb = items.filter((m) => !m.embedding || !m.embedding.length);
    if (noEmb.length >= 2) {
        const imgStrict = Math.min(8, Math.max(threshold + 1, 5));
        for (let i = 0; i < noEmb.length; i++) {
            for (let j = i + 1; j < noEmb.length; j++) {
                const a = noEmb[i];
                const b = noEmb[j];
                if (sameTypeOnly && normalizeType(a.media_type) !== normalizeType(b.media_type)) continue;
                const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
                if (skips.has(key)) continue;

                const typeA = normalizeType(a.media_type);
                const typeB = normalizeType(b.media_type);
                const motionPair = isMotion(typeA) || isMotion(typeB);

                if (motionPair && a.frames.length && b.frames.length) {
                    const { hits, bestDist, aTime, bTime } = countFrameHits(
                        a.frames, b.frames, frameHamming
                    );
                    const bothMot = isMotion(typeA) && isMotion(typeB);
                    const mixed = bothMot && typeA !== typeB;
                    let minHits;
                    if (typeA === 'gif' && typeB === 'gif') {
                        minHits = minGifHits;
                    } else if (mixed) {
                        minHits = minGifVideoHits;
                    } else if (bothMot) {
                        minHits = minVideoHits;
                    } else {
                        minHits = minImageVideoHits;
                    }
                    if (hits < minHits) continue;
                    pairs.push({
                        a, b,
                        distance: bestDist,
                        reason: `dHash frames ${typeA}↔${typeB} (hits=${hits}, d=${bestDist})`,
                        aTime,
                        bTime,
                        hitCount: hits
                    });
                } else {
                    if (!a.phash || !b.phash) continue;
                    if (isLowInfoHash(a.phash) || isLowInfoHash(b.phash)) continue;
                    const dist = hammingDistance(a.phash, b.phash);
                    if (dist > imgStrict) continue;
                    pairs.push({
                        a, b,
                        distance: dist,
                        reason: `dHash fallback (d=${dist})`,
                        aTime: null,
                        bTime: null,
                        hitCount: 1
                    });
                }
            }
        }
    }

    pairs.sort((x, y) => {
        const sx = x.similarity != null ? x.similarity : (1 - x.distance / 64);
        const sy = y.similarity != null ? y.similarity : (1 - y.distance / 64);
        return sy - sx;
    });
    return pairs;
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
        cosineThreshold: Math.min(0.999, Math.max(0.7,
            parseFloat(opts.cosineThreshold) || DEFAULT_COSINE_THRESHOLD
        )),
        crossTypeCosine: Math.min(0.999, Math.max(0.7,
            parseFloat(opts.crossTypeCosine) || DEFAULT_CROSS_TYPE_COSINE
        )),
        sameTypeOnly: opts.sameTypeOnly === true || opts.sameTypeOnly === 'true' || opts.sameTypeOnly === 1
    };

    preloadEmbedModel().catch((err) => {
        logger.error(`CLIP preload: ${err.message}`);
    });

    const job = {
        status: 'running',
        phase: 'clearing',
        progress: 0,
        message: 'Clearing previous hash data…',
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
            clearPhashData(dbBid);
            job.phase = 'hashing';
            job.message = 'Computing perceptual hashes…';
            job.progress = 2;

            await backfillPhashes(dbBid, (done, total) => {
                job.processed = done;
                job.total = total;
                job.progress = total ? 2 + Math.round((done / total) * 78) : 80;
                job.message = `Hashing ${done}/${total}`;
            }, true);

            job.phase = 'matching';
            job.message = 'Matching near-duplicates…';
            job.progress = 90;
            const pairs = findDuplicatePairs(dbBid, scanOpts.threshold);
            job.pairs = pairs;
            job.pairIndex = 0;
            job.progress = 100;
            job.phase = 'done';
            job.status = 'done';
            job.message = pairs.length
                ? `Found ${pairs.length} candidate pair(s). Click “Review duplicates”.`
                : 'No near-duplicates found';
        } catch (err) {
            logger.error(`duplicate scan error: ${err.message}`);
            job.status = 'error';
            job.message = err.message;
        }
    })();

    return job;
}

export function startReview(dbBid, opts = {}) {
    const existing = scanJobs.get(dbBid);
    if (existing && existing.status === 'running') {
        throw new Error('Scan still running');
    }

    if (opts.threshold != null || opts.minVideoHits != null || opts.minImageVideoHits != null
        || opts.minGifHits != null || opts.minGifVideoHits != null
        || opts.cosineThreshold != null || opts.crossTypeCosine != null || opts.sameTypeOnly != null) {
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
                ? Math.min(0.999, Math.max(0.7, parseFloat(opts.cosineThreshold) || scanOpts.cosineThreshold))
                : scanOpts.cosineThreshold,
            crossTypeCosine: opts.crossTypeCosine != null
                ? Math.min(0.999, Math.max(0.7, parseFloat(opts.crossTypeCosine) || scanOpts.crossTypeCosine))
                : scanOpts.crossTypeCosine,
            sameTypeOnly: opts.sameTypeOnly != null
                ? (opts.sameTypeOnly === true || opts.sameTypeOnly === 'true' || opts.sameTypeOnly === 1)
                : scanOpts.sameTypeOnly
        };
    }

    if (existing && existing.pairs && existing.pairs.length && existing.status === 'done') {
        existing.pairIndex = 0;
        existing.status = 'review';
        existing.phase = 'review';
        existing.message = `Reviewing ${existing.pairs.length} pair(s)`;
        return existing;
    }

    const pairs = findDuplicatePairs(dbBid, scanOpts.threshold);
    const job = {
        status: pairs.length ? 'review' : 'done',
        phase: 'review',
        progress: 100,
        message: pairs.length ? `Reviewing ${pairs.length} pair(s)` : 'No near-duplicates found',
        pairs,
        pairIndex: 0,
        total: 0,
        processed: 0,
        startedAt: Date.now(),
        threshold: scanOpts.threshold
    };
    scanJobs.set(dbBid, job);
    return job;
}

export function getScanStatus(dbBid) {
    const job = scanJobs.get(dbBid);
    if (!job) return { status: 'idle', progress: 0, message: '', pairCount: 0 };
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

export function resolvePair(dbBid, action, deleteIds = []) {
    const job = scanJobs.get(dbBid);
    if (!job) throw new Error('No active scan');
    const pair = job.pairs[job.pairIndex];
    if (!pair) throw new Error('No current pair');

    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) throw new Error('DB not loaded');

    if (action === 'skip') {
        const lo = Math.min(pair.a.id, pair.b.id);
        const hi = Math.max(pair.a.id, pair.b.id);
        dbEntry.main.run(
            `INSERT OR REPLACE INTO duplicate_skips (a_id, b_id, skipped_at) VALUES (?, ?, ?)`,
            [lo, hi, Date.now()]
        );
        saveUserDatabases(dbBid);
    } else if (action === 'delete') {
    }

    job.pairIndex += 1;
    if (job.pairIndex >= job.pairs.length) {
        job.status = 'done';
        job.message = 'Review finished';
        return { done: true, next: null };
    }
    return { done: false, next: job.pairs[job.pairIndex] };
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

    try {
        const p = path.join(mediaDir, containerName);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
        logger.warn(`Failed to unlink container ${containerName}: ${err.message}`);
    }

    saveUserDatabases(dbBid);
    return { fileHash };
}
