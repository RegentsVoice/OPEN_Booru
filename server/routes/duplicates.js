import {
    systemDb, userDbs
} from '../db/index.js';
import {
    startScan,
    startReview,
    getScanStatus,
    getCurrentPair,
    resolvePair,
    deleteMediaById,
    ensurePhashSchema
} from '../services/duplicates.js';
import { logger } from '../config.js';

function getDbBid(req, res) {
    if (!req.session || !req.session.userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return null;
    }
    const stmt = systemDb.prepare(`SELECT db_bid FROM users WHERE id = ?`);
    stmt.bind([req.session.userId]);
    if (!stmt.step()) {
        stmt.free();
        res.status(403).json({ success: false, error: 'User not found' });
        return null;
    }
    const dbBid = stmt.get()[0];
    stmt.free();
    if (!userDbs.get(dbBid)) {
        res.status(403).json({ success: false, error: 'User database not loaded' });
        return null;
    }
    return dbBid;
}

function serializePair(pair) {
    if (!pair) return null;
    const slim = (m) => ({
        id: m.id,
        file_hash: m.file_hash,
        media_type: m.media_type,
        width: m.width,
        height: m.height,
        duration: m.duration,
        file_size: m.file_size,
        original_name: m.original_name,
        display_name: m.display_name,
        created_at: m.created_at,
        phash: m.phash
    });
    return {
        a: slim(pair.a),
        b: slim(pair.b),
        distance: pair.distance,
        reason: pair.reason,
        aTime: pair.aTime,
        bTime: pair.bTime,
        hitCount: pair.hitCount || 1
    };
}

export function registerDuplicateRoutes(app) {
    app.post('/api/duplicates/scan', (req, res) => {
        const dbBid = getDbBid(req, res);
        if (!dbBid) return;
        try {
            ensurePhashSchema(userDbs.get(dbBid).main);
            const body = req.body || {};
            const job = startScan(dbBid, {
                threshold: body.threshold,
                concurrency: body.concurrency,
                intervalSec: body.intervalSec,
                minVideoHits: body.minVideoHits,
                minImageVideoHits: body.minImageVideoHits,
                minGifHits: body.minGifHits,
                minGifVideoHits: body.minGifVideoHits,
                cosineThreshold: body.cosineThreshold,
                crossTypeCosine: body.crossTypeCosine,
                sameTypeOnly: body.sameTypeOnly
            });
            res.json({
                success: true,
                status: job.status,
                progress: job.progress,
                message: job.message
            });
        } catch (err) {
            logger.error(`duplicates scan: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/duplicates/review', (req, res) => {
        const dbBid = getDbBid(req, res);
        if (!dbBid) return;
        try {
            ensurePhashSchema(userDbs.get(dbBid).main);
            const body = req.body || {};
            const job = startReview(dbBid, {
                threshold: body.threshold,
                minVideoHits: body.minVideoHits,
                minImageVideoHits: body.minImageVideoHits,
                minGifHits: body.minGifHits,
                minGifVideoHits: body.minGifVideoHits,
                cosineThreshold: body.cosineThreshold,
                crossTypeCosine: body.crossTypeCosine,
                sameTypeOnly: body.sameTypeOnly
            });
            const pair = getCurrentPair(dbBid);
            res.json({
                success: true,
                ...getScanStatus(dbBid),
                pair: serializePair(pair)
            });
        } catch (err) {
            logger.error(`duplicates review: ${err.message}`);
            res.status(400).json({ success: false, error: err.message });
        }
    });

    app.get('/api/duplicates/status', (req, res) => {
        const dbBid = getDbBid(req, res);
        if (!dbBid) return;
        res.json({ success: true, ...getScanStatus(dbBid) });
    });

    app.get('/api/duplicates/current', (req, res) => {
        const dbBid = getDbBid(req, res);
        if (!dbBid) return;
        const pair = getCurrentPair(dbBid);
        const status = getScanStatus(dbBid);
        res.json({
            success: true,
            pair: serializePair(pair),
            ...status
        });
    });

    app.post('/api/duplicates/resolve', (req, res) => {
        const dbBid = getDbBid(req, res);
        if (!dbBid) return;
        try {
            const { action, deleteId } = req.body || {};
            if (action === 'delete' && deleteId) {
                deleteMediaById(dbBid, parseInt(deleteId, 10));
            }
            const result = resolvePair(dbBid, action === 'skip' ? 'skip' : 'delete');
            res.json({
                success: true,
                done: result.done,
                next: serializePair(result.next),
                ...getScanStatus(dbBid)
            });
        } catch (err) {
            logger.error(`duplicates resolve: ${err.message}`);
            res.status(400).json({ success: false, error: err.message });
        }
    });
}
