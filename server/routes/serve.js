import fs from 'fs';
import path from 'path';
import {
    PUBLIC_DIR, logger, st
} from '../config.js';
import {
    createDecryptStreamWithOffset, createSkipStream
} from '../lib/crypto.js';
import {
    systemDb, userDbs, getUserMediaPath
} from '../db/index.js';
import { getMimeType } from '../services/media-process.js';

export function registerServeRoutes(app) {
app.get('/media/:hash', async (req, res) => {
    const hash = req.params.hash;
    if (!req.session || !req.session.userId) {
        return res.status(401).send('Unauthorized');
    }
    const userId = req.session.userId;
    const stmt = systemDb.prepare(`SELECT db_bid, media_bid FROM users WHERE id = ?`);
    stmt.bind([userId]);
    if (!stmt.step()) {
        stmt.free();
        return res.status(403).send('User not found');
    }
    const dbBid = stmt.get()[0];
    const mediaBid = stmt.get()[1];
    stmt.free();

    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) {
        return res.status(403).send('User database not loaded');
    }
    const { main, masterKey } = dbEntry;
    const mediaDir = getUserMediaPath(mediaBid);

    try {
        const stmt2 = main.prepare(`SELECT container_name, file_hash, media_type, file_size, media_offset, original_name, encryption_iv FROM media WHERE file_hash = ?`);
        stmt2.bind([hash]);
        if (!stmt2.step()) {
            stmt2.free();
            return res.status(404).send('Not found');
        }
        const row = stmt2.get();
        stmt2.free();
        const containerName = row[0];
        const fileHash = row[1];
        const mediaType = row[2];
        const fileSize = row[3];
        const mediaOffset = row[4] || 0;
        const originalName = row[5] || 'file';
        let iv = row[6];

        
        if (!iv) {
            logger.error(`Missing encryption_iv for ${hash}`);
            return res.status(500).send('Invalid media: missing encryption IV');
        }
        
        let ivBuf;
        if (Buffer.isBuffer(iv)) {
            ivBuf = iv;
        } else if (iv instanceof Uint8Array) {
            ivBuf = Buffer.from(iv);
        } else {
            ivBuf = Buffer.from(iv || []);
        }
        if (ivBuf.length !== 16) {
            logger.error(`Invalid IV length for ${hash}: ${ivBuf.length}`);
            return res.status(500).send('Invalid media: incorrect IV length');
        }

        const containerPath = path.join(mediaDir, containerName);
        if (!fs.existsSync(containerPath)) return res.status(404).send('File not found');

        const mime = getMimeType(originalName);
        const stats = fs.statSync(containerPath);
        const containerSize = stats.size;

        if (mediaOffset + fileSize > containerSize) {
            logger.warn(st('mediaRangeExceeds', { hash }));
            return res.status(500).send('Invalid media data');
        }

        const rangeHeader = req.headers.range;
        let startByte = 0;
        let endByte = fileSize - 1;
        if (rangeHeader) {
            const parts = rangeHeader.replace(/bytes=/, '').split('-');
            startByte = parseInt(parts[0], 10);
            endByte = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            if (startByte >= fileSize || endByte >= fileSize || startByte > endByte) {
                return res.status(416).send('Range not satisfiable');
            }
        }

        const startContainer = mediaOffset + startByte;
        const endContainer = mediaOffset + endByte;
        const chunkSize = (endContainer - startContainer) + 1;

        
        let decryptStream;
        try {
            const { decipher, skipBytes } = createDecryptStreamWithOffset(masterKey, ivBuf, startByte);
            const skipStream = createSkipStream(skipBytes);
            const readStream = fs.createReadStream(containerPath, { start: startContainer, end: endContainer });
            decryptStream = readStream.pipe(decipher).pipe(skipStream);
        } catch (err) {
            logger.error(`Decryption setup error for ${hash}: ${err.message}`);
            return res.status(500).send('Decryption error');
        }

        if (rangeHeader) {
            res.writeHead(206, {
                'Content-Range': `bytes ${startByte}-${endByte}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': mime,
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
        } else {
            res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': fileSize,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
        }

        decryptStream.pipe(res);
        decryptStream.on('error', (err) => {
            logger.error(`Stream error for ${hash}: ${err.message}`);
            if (!res.headersSent) res.status(500).end();
            else res.end();
        });
        req.on('close', () => {
            if (decryptStream && !decryptStream.destroyed) {
                decryptStream.destroy();
            }
        });

    } catch (err) {
        logger.error(st('mediaServingError', { error: err.message }));
        if (!res.headersSent) res.status(500).send('Error');
        else res.end();
    }
});

app.get('/poster/:hash', async (req, res) => {
    const hash = req.params.hash;
    if (!req.session || !req.session.userId) {
        return res.status(401).send('Unauthorized');
    }
    const userId = req.session.userId;
    const stmt = systemDb.prepare(`SELECT db_bid, media_bid FROM users WHERE id = ?`);
    stmt.bind([userId]);
    if (!stmt.step()) {
        stmt.free();
        return res.status(403).send('User not found');
    }
    const dbBid = stmt.get()[0];
    stmt.free();

    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) {
        return res.status(403).send('User database not loaded');
    }
    const { main, previews } = dbEntry;
    try {
        const mediaStmt = main.prepare(`SELECT id FROM media WHERE file_hash = ?`);
        mediaStmt.bind([hash]);
        if (!mediaStmt.step()) {
            mediaStmt.free();
            return res.status(404).send('Media not found');
        }
        const mediaId = mediaStmt.get()[0];
        mediaStmt.free();

        const posterStmt = previews.prepare(`SELECT poster FROM previews WHERE media_id = ?`);
        posterStmt.bind([mediaId]);
        if (!posterStmt.step()) {
            posterStmt.free();
            return res.status(404).send('Poster not found');
        }
        let posterRaw = posterStmt.get()[0];
        posterStmt.free();
        if (!posterRaw) return res.status(404).send('Poster not found');

        let posterBuf;
        if (Buffer.isBuffer(posterRaw)) posterBuf = posterRaw;
        else if (posterRaw instanceof Uint8Array) posterBuf = Buffer.from(posterRaw);
        else posterBuf = Buffer.from(posterRaw);

        if (!posterBuf || posterBuf.length === 0) return res.status(404).send('Poster not found');

        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Length': posterBuf.length
        });
        res.end(posterBuf);
    } catch (err) {
        logger.error(`Poster serving error: ${err.message}`);
        res.status(500).send('Error');
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

}
