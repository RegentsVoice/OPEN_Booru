import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sizeOf from 'image-size';
import { logger, st, TEMP_DIR } from '../config.js';
import { userDbs, getUserMediaPath, saveUserDatabases, cleanupOrphanedTags } from '../db/index.js';

export const uploadData = new Map();

export function getImageSize(filePath) {
    try {
        const dims = sizeOf(filePath);
        return { width: dims.width || 0, height: dims.height || 0 };
    } catch { return { width: 0, height: 0 }; }
}

export function getGifSize(filePath) {
    try {
        const dims = sizeOf(filePath);
        return { width: dims.width || 0, height: dims.height || 0 };
    } catch { return { width: 0, height: 0 }; }
}

export function computeHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

export function detectMediaType(originalName) {
    const ext = path.extname(originalName).toLowerCase();
    if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext)) return 'video';
    if (ext === '.gif') return 'gif';
    return 'image';
}

export function getMimeType(originalName) {
    const ext = path.extname(originalName).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.gif': 'image/gif',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
    };
    return mimeMap[ext] || 'application/octet-stream';
}

export async function createContainerWithDir(mediaPath, hash, tags, displayName, description, originalName, mediaType, fileSize, width, height, duration, containerDir, masterKey, iv, onProgress) {
    return new Promise((resolve, reject) => {
        try {
            const containerPath = path.join(containerDir, `${hash}.bin`);
            const writeStream = fs.createWriteStream(containerPath);
            let offset = 0;

            const version = Buffer.alloc(4);
            version.writeUInt32LE(1, 0);
            writeStream.write(version);
            offset += 4;
            if (onProgress) onProgress(10);

            const nfo = {
                hash, original_name: originalName, display_name: displayName || originalName,
                description: description || '',
                media_type: mediaType, file_size: fileSize, created_at: Date.now(),
                tags: tags || [],
                width: width || 0, height: height || 0, duration: duration || 0
            };
            const nfoBuffer = Buffer.from(JSON.stringify(nfo), 'utf8');
            const nfoLen = Buffer.alloc(4);
            nfoLen.writeUInt32LE(nfoBuffer.length, 0);
            writeStream.write(nfoLen);
            offset += 4;
            writeStream.write(nfoBuffer);
            offset += nfoBuffer.length;
            if (onProgress) onProgress(30);

            const zero = Buffer.alloc(4);
            zero.writeUInt32LE(0, 0);
            writeStream.write(zero);
            offset += 4;

            const mediaOffset = offset;
            const cipher = crypto.createCipheriv('aes-256-ctr', masterKey, iv);
            const readStream = fs.createReadStream(mediaPath);
            readStream.pipe(cipher).pipe(writeStream, { end: true });
            readStream.on('end', () => {
                if (onProgress) onProgress(70);
                resolve({ containerPath, mediaOffset });
            });
            readStream.on('error', reject);
            writeStream.on('error', reject);
            cipher.on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
}

export const processingStatus = new Map();

export function updateStatus(hash, stage, progress, message) {
    processingStatus.set(hash, { stage, progress, message, updated: Date.now() });
}

setInterval(() => {
    const now = Date.now();
    for (const [hash, data] of uploadData.entries()) {
        if (now - data.created > 5 * 60 * 1000) {
            try { fs.unlinkSync(data.tempPath); } catch (e) {}
            uploadData.delete(hash);
            logger.info(st('staleUploadCleaned', { hash }));
        }
    }
}, 5 * 60 * 1000);

export async function processMedia(hash, data) {
    const {
        tempPath,
        originalName,
        fileSize,
        displayName,
        description,
        tags: tagsStr,
        mediaType: mediaTypeRaw,
        userId,
        dbBid,
        mediaBid,
        posterData,
        posterTime,
        width,
        height,
        duration
    } = data;

    logger.info(st('processingStartFull', { hash, dbBid }));
    try {
        updateStatus(hash, 'starting', 0, 'Starting');

        const dbEntry = userDbs.get(dbBid);
        if (!dbEntry) {
            throw new Error('User database not loaded');
        }
        const { main, tags, previews, masterKey } = dbEntry;
        const mediaDir = getUserMediaPath(mediaBid);

        const tagsList = tagsStr.trim() ? tagsStr.trim().split(/\s+/).filter(t => t) : [];
        let mediaType = mediaTypeRaw === 'auto' ? detectMediaType(originalName) : mediaTypeRaw;

        let posterBuffer = null;
        if (mediaType === 'video' || mediaType === 'gif') {
            if (posterData) {
                try {
                    const base64Data = String(posterData).replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
                    posterBuffer = Buffer.from(base64Data, 'base64');
                    if (!posterBuffer || posterBuffer.length < 100) {
                        throw new Error('Poster too short: ' + (posterBuffer ? posterBuffer.length : 0));
                    }
                    logger.info(st('posterDecoded', { size: posterBuffer.length }));
                } catch (err) {
                    throw new Error('Invalid poster data: ' + err.message);
                }
            } else {
                throw new Error('Poster data missing');
            }
        }

        let finalWidth = width || 0;
        let finalHeight = height || 0;
        let finalDuration = duration || 0;
        if ((!finalWidth || !finalHeight) && (mediaType === 'image' || mediaType === 'gif')) {
            try {
                const dims = mediaType === 'gif' ? getGifSize(tempPath) : getImageSize(tempPath);
                if (dims.width && dims.height) {
                    finalWidth = dims.width;
                    finalHeight = dims.height;
                }
            } catch (e) {
                logger.warn(`Size detect failed for ${hash}: ${e.message}`);
            }
        }

        const containerName = `${hash}.bin`;
        updateStatus(hash, 'container', 20, 'Creating container...');

        const iv = crypto.randomBytes(16);

        const { containerPath, mediaOffset } = await createContainerWithDir(
            tempPath, hash, tagsList, displayName, description,
            originalName, mediaType, fileSize, finalWidth, finalHeight, finalDuration,
            mediaDir, masterKey, iv,
            (progress) => {
                const pct = 20 + (progress * 0.5);
                updateStatus(hash, 'container', Math.round(pct), 'Creating container...');
            }
        );

        fs.unlinkSync(tempPath);

        updateStatus(hash, 'database', 95, 'Saving to database...');

        const insertStmt = main.prepare(`
            INSERT INTO media (file_hash, container_name, media_type, width, height, duration, file_size, created_at, original_name, display_name, description, media_offset, preview_offset, preview_size, poster_time, encryption_iv)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertStmt.run([hash, containerName, mediaType, finalWidth, finalHeight, finalDuration, fileSize, Date.now(), originalName, displayName, description, mediaOffset, 0, 0, posterTime || 0, iv]);
        insertStmt.free();

        const mediaId = main.exec(`SELECT last_insert_rowid()`)[0].values[0][0];

        for (const tagName of tagsList) {
            let tagId = null;
            const tagStmt = tags.prepare(`SELECT id FROM tags WHERE name = ?`);
            tagStmt.bind([tagName]);
            if (tagStmt.step()) tagId = tagStmt.get()[0];
            tagStmt.free();
            if (!tagId) {
                tags.run(`INSERT INTO tags (name) VALUES (?)`, [tagName]);
                tagId = tags.exec(`SELECT last_insert_rowid()`)[0].values[0][0];
            }
            tags.run(`INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)`, [mediaId, tagId]);
        }

        if (posterBuffer) {

            const posterUint8 = new Uint8Array(posterBuffer);
            previews.run(`INSERT INTO previews (media_id, poster) VALUES (?, ?)`, [mediaId, posterUint8]);
            logger.info(st('posterWritten', { size: posterBuffer.length }));
        } else if (mediaType === 'video' || mediaType === 'gif') {

            logger.warn(st('noPosterWarning', { id: mediaId, type: mediaType }));
        }

        cleanupOrphanedTags(tags);
        saveUserDatabases(dbBid);

        updateStatus(hash, 'done', 100, 'Done');
        uploadData.delete(hash);
        logger.info(st('processingComplete', { hash }));

        import('./duplicates.js').then(({ embedSingleMedia }) => {
            embedSingleMedia(dbBid, mediaId).catch((e) => {
                logger.warn(`auto-embed ${mediaId}: ${e.message}`);
            });
        }).catch(() => {});
    } catch (err) {
        logger.error(st('processingError', { hash, error: err.message }));
        updateStatus(hash, 'error', 0, err.message);
        try { fs.unlinkSync(tempPath); } catch (e) {}

        try {
            const mediaDir = getUserMediaPath(mediaBid);
            try { fs.unlinkSync(path.join(mediaDir, `${hash}.bin`)); } catch (e) {}
            try { fs.unlinkSync(path.join(mediaDir, `poster_${hash}.jpg`)); } catch (e) {}
        } catch (e) {}
        try {
            const dbEntry = userDbs.get(dbBid);
            if (dbEntry) {
                const { main, tags, previews } = dbEntry;
                const stmt = main.prepare(`SELECT id FROM media WHERE file_hash = ?`);
                stmt.bind([hash]);
                if (stmt.step()) {
                    const id = stmt.get()[0];
                    stmt.free();
                    main.run(`DELETE FROM favorites WHERE media_id = ?`, [id]);
                    main.run(`DELETE FROM media WHERE id = ?`, [id]);
                    tags.run(`DELETE FROM media_tags WHERE media_id = ?`, [id]);
                    previews.run(`DELETE FROM previews WHERE media_id = ?`, [id]);
                    cleanupOrphanedTags(tags);
                    try { main.exec('VACUUM'); } catch (e) {}
                    try { tags.exec('VACUUM'); } catch (e) {}
                    try { previews.exec('VACUUM'); } catch (e) {}
                    saveUserDatabases(dbBid);
                } else {
                    stmt.free();
                }
            }
        } catch (rollbackErr) {
            logger.error(`Rollback error for ${hash}: ${rollbackErr.message}`);
        }
    }
}
