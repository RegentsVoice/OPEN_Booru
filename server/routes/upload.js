import fs from 'fs';
import {
    logger, st
} from '../config.js';
import {
    systemDb, userDbs
} from '../db/index.js';
import {
    uploadData, processingStatus, processMedia,
    computeHash, detectMediaType
} from '../services/media-process.js';

export function registerUploadRoutes(app, upload) {
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        logger.warn(st('noFileUpload'));
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const tempPath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;

    const mediaType = req.body.mediaType || 'auto';
    const detectedType = detectMediaType(originalName);
    const isVideoOrGif = mediaType === 'video' || mediaType === 'gif' ||
        (mediaType === 'auto' && (detectedType === 'video' || detectedType === 'gif'));

    const posterData = req.body.posterData || null;
    const posterTime = parseFloat(req.body.posterTime) || 0;

    const width = parseInt(req.body.width) || 0;
    const height = parseInt(req.body.height) || 0;
    const duration = parseFloat(req.body.duration) || 0;

    if (isVideoOrGif && !posterData) {
        fs.unlinkSync(tempPath);
        return res.status(400).json({ success: false, code: 'poster_required', error: 'Poster data required for video/gif' });
    }

    const userId = req.session.userId;

    try {
        const fileHash = await computeHash(tempPath);
        const stmt = systemDb.prepare(`SELECT db_bid, media_bid FROM users WHERE id = ?`);
        stmt.bind([userId]);
        if (!stmt.step()) {
            stmt.free();
            fs.unlinkSync(tempPath);
            return res.status(403).json({ success: false, error: 'User not found' });
        }
        const dbBid = stmt.get()[0];
        const mediaBid = stmt.get()[1];
        stmt.free();

        const dbEntry = userDbs.get(dbBid);
        if (!dbEntry) {
            fs.unlinkSync(tempPath);
            return res.status(403).json({ success: false, error: 'User database not loaded' });
        }
        const dupStmt = dbEntry.main.prepare(`SELECT id FROM media WHERE file_hash = ?`);
        dupStmt.bind([fileHash]);
        if (dupStmt.step()) {
            dupStmt.free();
            fs.unlinkSync(tempPath);
            logger.warn(st('duplicateUpload', { hash: fileHash }));
            return res.status(409).json({ success: false, error: 'Duplicate file already exists', hash: fileHash });
        }
        dupStmt.free();

        const data = {
            tempPath,
            originalName,
            fileSize,
            displayName: req.body.displayName || originalName,
            description: req.body.description || '',
            tags: req.body.tags || '',
            mediaType: mediaType,
            created: Date.now(),
            userId: userId,
            dbBid: dbBid,
            mediaBid: mediaBid,
            posterData: posterData,
            posterTime: posterTime,
            width: width,
            height: height,
            duration: duration
        };
        uploadData.set(fileHash, data);
        logger.info(st('uploadStored', { hash: fileHash }));
        res.json({ success: true, hash: fileHash });
    } catch (err) {
        logger.error(`Upload error: ${err.message}`);
        try { fs.unlinkSync(tempPath); } catch(e) {}
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/process', async (req, res) => {
    const { hash } = req.body;
    if (!hash) {
        logger.warn('Process request without hash');
        return res.status(400).json({ success: false, error: 'Missing hash' });
    }
    const data = uploadData.get(hash);
    if (!data) {
        logger.warn(`Process request for unknown hash: ${hash}`);
        return res.status(404).json({ success: false, error: 'Upload data not found' });
    }
    processMedia(hash, data);
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    const hash = req.query.hash;
    if (!hash) return res.status(400).json({ error: 'Missing hash' });
    const status = processingStatus.get(hash);
    if (!status) return res.json({ stage: 'not_found', progress: 0, message: '' });
    res.json(status);
});

}
