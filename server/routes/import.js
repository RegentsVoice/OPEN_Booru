import fs from 'fs';
import {
    logger
} from '../config.js';
import {
    systemDb, userDbs,
    getBooruCredentialsMap, listBooruCredentials, saveBooruCredential, deleteBooruCredential
} from '../db/index.js';
import {
    uploadData, processMedia, computeHash, getMimeType
} from '../services/media-process.js';
import {
    resolveBooruUrl, downloadImportToTemp, getImportTemp, removeImportTemp, releaseImportTemp,
    BOORU_SITES, verifyBooruCredentials
} from '../services/booru-import.js';

export function registerImportRoutes(app) {
app.get('/api/booru/sites', (req, res) => {
    res.json({
        success: true,
        sites: BOORU_SITES.map(s => ({
            id: s.id,
            name: s.name,
            needsAuth: s.needsAuth,
            fields: s.fields
        }))
    });
});

app.get('/api/booru/credentials', (req, res) => {
    const userId = req.session.userId;
    const saved = listBooruCredentials(userId);
    const bySite = {};
    for (const c of saved) bySite[c.site] = c;
    res.json({
        success: true,
        sites: BOORU_SITES.map(s => ({
            id: s.id,
            name: s.name,
            needsAuth: s.needsAuth,
            fields: s.fields,
            configured: !!bySite[s.id]?.has_api_key || !!(bySite[s.id]?.account_id),
            account_id: bySite[s.id]?.account_id || '',
            login: bySite[s.id]?.login || '',
            has_api_key: !!bySite[s.id]?.has_api_key,
            api_key_masked: bySite[s.id]?.api_key_masked || '',
            updated_at: bySite[s.id]?.updated_at || 0
        }))
    });
});

app.post('/api/booru/credentials', async (req, res) => {
    const userId = req.session.userId;
    const { site, account_id, api_key, login, skip_verify } = req.body || {};
    if (!site || !BOORU_SITES.some(s => s.id === site)) {
        return res.status(400).json({ success: false, error: 'Invalid site' });
    }
    const acc = account_id || login || '';
    const key = api_key || '';
    if (!acc || !key) {
        return res.status(400).json({ success: false, error: 'Credentials required' });
    }

    if (!skip_verify) {
        try {
            const result = await verifyBooruCredentials(site, {
                account_id: acc,
                login: login || acc,
                api_key: key
            });
            if (!result.ok) {
                return res.status(400).json({
                    success: false,
                    code: result.inconclusive ? 'verify_inconclusive' : 'verify_failed',
                    error: result.message || 'Verification failed',
                    inconclusive: !!result.inconclusive,
                    status: result.status || null
                });
            }
        } catch (err) {
            return res.status(400).json({
                success: false,
                code: 'verify_failed',
                error: err.message || 'Verification failed'
            });
        }
    }

    saveBooruCredential(userId, site, {
        account_id: acc,
        api_key: key,
        login: login || acc
    });
    res.json({ success: true, verified: !skip_verify });
});

app.post('/api/booru/credentials/verify', async (req, res) => {
    const { site, account_id, api_key, login } = req.body || {};
    if (!site || !BOORU_SITES.some(s => s.id === site)) {
        return res.status(400).json({ success: false, error: 'Invalid site' });
    }
    const result = await verifyBooruCredentials(site, {
        account_id: account_id || login || '',
        login: login || account_id || '',
        api_key: api_key || ''
    });
    if (!result.ok) {
        return res.status(400).json({ success: false, code: 'verify_failed', error: result.message || 'Verification failed' });
    }
    res.json({ success: true });
});

app.delete('/api/booru/credentials/:site', (req, res) => {
    const userId = req.session.userId;
    const site = req.params.site;
    if (!site) return res.status(400).json({ success: false, error: 'Invalid site' });
    deleteBooruCredential(userId, site);
    res.json({ success: true });
});

app.post('/api/import/fetch', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, code: 'url_required', error: 'URL required' });
    }
    const userId = req.session.userId;
    try {
        const creds = getBooruCredentialsMap(userId);
        const resolved = await resolveBooruUrl(url, creds);
        const result = await downloadImportToTemp(resolved, userId);
        res.json({
            success: true,
            tempId: result.tempId,
            originalName: result.originalName,
            fileSize: result.fileSize,
            tags: result.tags,
            mediaType: result.mediaType,
            mime: result.mime,
            width: result.width,
            height: result.height,
            source: result.source,
            previewUrl: `/api/import/preview/${result.tempId}`
        });
    } catch (err) {
        logger.error(`Import fetch error: ${err.message}`);
        if (err.code === 'credentials_required') {
            return res.status(401).json({
                success: false,
                code: 'credentials_required',
                site: err.site || null,
                error: err.message
            });
        }
        res.status(400).json({ success: false, error: err.message });
    }
});

app.get('/api/import/preview/:tempId', (req, res) => {
    const tempId = req.params.tempId;
    const entry = getImportTemp(tempId);
    if (!entry) return res.status(404).send('Not found');
    if (entry.userId !== req.session.userId) return res.status(403).send('Forbidden');
    if (!fs.existsSync(entry.tempPath)) return res.status(404).send('File gone');
    const mime = getMimeType(entry.originalName);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', entry.fileSize);
    fs.createReadStream(entry.tempPath).pipe(res);
});

app.post('/api/import/commit', async (req, res) => {
    const {
        tempId, displayName, description, tags, posterData, posterTime, width, height, duration
    } = req.body || {};
    if (!tempId) return res.status(400).json({ success: false, error: 'Missing tempId' });
    const entry = getImportTemp(tempId);
    if (!entry) return res.status(404).json({ success: false, error: 'Import data not found or expired' });
    if (entry.userId !== req.session.userId) return res.status(403).json({ success: false, error: 'Forbidden' });

    const userId = req.session.userId;
    try {
        const stmt = systemDb.prepare(`SELECT db_bid, media_bid FROM users WHERE id = ?`);
        stmt.bind([userId]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(403).json({ success: false, error: 'User not found' });
        }
        const dbBid = stmt.get()[0];
        const mediaBid = stmt.get()[1];
        stmt.free();

        const dbEntry = userDbs.get(dbBid);
        if (!dbEntry) return res.status(403).json({ success: false, error: 'User database not loaded' });

        const fileHash = await computeHash(entry.tempPath);
        const dupStmt = dbEntry.main.prepare(`SELECT id FROM media WHERE file_hash = ?`);
        dupStmt.bind([fileHash]);
        if (dupStmt.step()) {
            dupStmt.free();
            removeImportTemp(tempId);
            return res.status(409).json({ success: false, error: 'Duplicate file already exists', hash: fileHash });
        }
        dupStmt.free();

        const isVideoOrGif = entry.mediaType === 'video' || entry.mediaType === 'gif';
        if (isVideoOrGif && !posterData) {
            return res.status(400).json({ success: false, code: 'poster_required', error: 'Poster data required for video/gif' });
        }

        const tagsStr = typeof tags === 'string'
            ? tags
            : (Array.isArray(tags) ? tags.join(' ') : (entry.tags || []).join(' '));

        const data = {
            tempPath: entry.tempPath,
            originalName: entry.originalName,
            fileSize: entry.fileSize,
            displayName: displayName || entry.originalName,
            description: description || '',
            tags: tagsStr,
            mediaType: entry.mediaType,
            created: Date.now(),
            userId,
            dbBid,
            mediaBid,
            posterData: posterData || null,
            posterTime: parseFloat(posterTime) || 0,
            width: parseInt(width, 10) || entry.width || 0,
            height: parseInt(height, 10) || entry.height || 0,
            duration: parseFloat(duration) || 0
        };
        releaseImportTemp(tempId);
        uploadData.set(fileHash, data);
        processMedia(fileHash, data);
        res.json({ success: true, hash: fileHash });
    } catch (err) {
        logger.error(`Import commit error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/import/:tempId', (req, res) => {
    const tempId = req.params.tempId;
    const entry = getImportTemp(tempId);
    if (entry && entry.userId === req.session.userId) {
        removeImportTemp(tempId);
    }
    res.json({ success: true });
});

}
