import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import initSqlJs from 'sql.js';
import {
    PUBLIC_DIR, SYSTEM_DB_PATH, LOGS_DIR, logger, st, accessConfig, setAccessConfig,
    loadAccessConfig, saveAccessConfig, defaultAccessConfig
} from './config.js';
import {
    encryptMasterKey, decryptMasterKey, encryptDbBuffer,
    createDecryptStreamWithOffset, createSkipStream
} from './crypto.js';
import {
    systemDb, userDbs, generateBid, getUserDbPath, getUserMediaPath,
    loadUserDatabases, unloadUserDatabases, saveUserDatabases, cleanupOrphanedTags,
    getUserIsAdmin, getUserIsOwner, requireAdmin, requireOwner
} from './db.js';
import {
    uploadData, processingStatus, updateStatus, processMedia,
    computeHash, detectMediaType, getMimeType, getImageSize, getGifSize
} from './media.js';
import { translations, DEFAULT_LANG } from '../shared/server-locales.js';

export function registerRoutes(app, upload) {
app.post('/api/auth/register', async (req, res) => {
    if (accessConfig.registrationDisabled) {
        return res.status(403).json({ success: false, code: 'registration_disabled' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, code: 'username_required' });
    }
    const stmt = systemDb.prepare(`SELECT id FROM users WHERE username = ?`);
    stmt.bind([username]);
    if (stmt.step()) {
        stmt.free();
        return res.status(400).json({ success: false, code: 'username_exists' });
    }
    stmt.free();

    let dbBid;
    let attempts = 0;
    do {
        dbBid = generateBid();
        const check = systemDb.prepare(`SELECT id FROM users WHERE db_bid = ?`);
        check.bind([dbBid]);
        const exists = check.step();
        check.free();
        if (!exists) break;
        attempts++;
        if (attempts > 100) {
            return res.status(500).json({ success: false, code: 'internal_error' });
        }
    } while (true);

    let mediaBid;
    attempts = 0;
    do {
        mediaBid = generateBid();
        const check = systemDb.prepare(`SELECT id FROM users WHERE media_bid = ?`);
        check.bind([mediaBid]);
        const exists = check.step();
        check.free();
        if (!exists) break;
        attempts++;
        if (attempts > 100) {
            return res.status(500).json({ success: false, code: 'internal_error' });
        }
    } while (true);

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    let isFirstUser = false;
    try {
        const cnt = systemDb.exec(`SELECT COUNT(*) FROM users`);
        isFirstUser = !(cnt.length && cnt[0].values[0][0] > 0);
    } catch (e) {}
    const isAdminFlag = isFirstUser ? 1 : 0;
    const isOwnerFlag = isFirstUser ? 1 : 0;
    systemDb.run(`INSERT INTO users (username, password_hash, salt, db_bid, media_bid, created_at, is_admin, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, passwordHash, salt, dbBid, mediaBid, Date.now(), isAdminFlag, isOwnerFlag]);
    const userId = systemDb.exec(`SELECT last_insert_rowid()`)[0].values[0][0];
    const sysData = systemDb.export();
    fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(sysData));

    const dbDir = getUserDbPath(dbBid);
    fs.mkdirSync(dbDir, { recursive: true });
    const mediaDir = getUserMediaPath(mediaBid);
    fs.mkdirSync(mediaDir, { recursive: true });

    const masterKey = crypto.randomBytes(32);
    const encryptedMasterKey = encryptMasterKey(masterKey, password);
    fs.writeFileSync(path.join(dbDir, 'master.key.enc'), encryptedMasterKey);

    const SQL = await initSqlJs();
    const dbNames = ['main', 'tags', 'previews'];
    for (const name of dbNames) {
        const db = new SQL.Database();
        try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}
        if (name === 'main') {
            db.exec(`
                CREATE TABLE media (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_hash TEXT UNIQUE NOT NULL,
                    container_name TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    width INTEGER DEFAULT 0,
                    height INTEGER DEFAULT 0,
                    duration REAL DEFAULT 0,
                    file_size INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    original_name TEXT,
                    display_name TEXT,
                    description TEXT,
                    media_offset INTEGER DEFAULT 0,
                    preview_offset INTEGER DEFAULT 0,
                    preview_size INTEGER DEFAULT 0,
                    poster_time REAL DEFAULT 0,
                    encryption_iv BLOB
                );
                CREATE TABLE favorites (
                    media_id INTEGER PRIMARY KEY,
                    added_at INTEGER NOT NULL,
                    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
                );
                CREATE TABLE search_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    query TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    results_count INTEGER
                );
                CREATE INDEX idx_media_hash ON media(file_hash);
                CREATE INDEX idx_search_history_timestamp ON search_history(timestamp DESC);
            `);
        } else if (name === 'tags') {
            db.exec(`
                CREATE TABLE tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL
                );
                CREATE TABLE media_tags (
                    media_id INTEGER,
                    tag_id INTEGER,
                    PRIMARY KEY (media_id, tag_id)
                );
                CREATE INDEX idx_media_tags_media ON media_tags(media_id);
                CREATE INDEX idx_media_tags_tag ON media_tags(tag_id);
            `);
        } else if (name === 'previews') {
            db.exec(`
                CREATE TABLE previews (
                    media_id INTEGER PRIMARY KEY,
                    poster BLOB
                );
            `);
        }
        const data = db.export();
        const encrypted = encryptDbBuffer(Buffer.from(data), masterKey);
        fs.writeFileSync(path.join(dbDir, `${name}.db`), encrypted);
    }

    await loadUserDatabases(dbBid, mediaBid, password);
    req.session.userId = userId;
    const isAdmin = getUserIsAdmin(userId);
    const isOwner = getUserIsOwner(userId);
    res.json({ success: true, isAdmin, isOwner });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, code: 'username_required' });
    }
    const stmt = systemDb.prepare(`SELECT id, password_hash, db_bid, media_bid FROM users WHERE username = ?`);
    stmt.bind([username]);
    if (!stmt.step()) {
        stmt.free();
        return res.status(401).json({ success: false, code: 'invalid_credentials' });
    }
    const row = stmt.get();
    const userId = row[0];
    const storedHash = row[1];
    const dbBid = row[2];
    const mediaBid = row[3];
    stmt.free();

    const match = await bcrypt.compare(password, storedHash);
    if (!match) {
        return res.status(401).json({ success: false, code: 'invalid_credentials' });
    }

    try {
        await loadUserDatabases(dbBid, mediaBid, password);
    } catch (err) {
        logger.error(`Failed to load user databases: ${err.message}`);
        return res.status(500).json({ success: false, code: 'unlock_failed' });
    }

    req.session.userId = userId;
    const isAdmin = getUserIsAdmin(userId);
    const isOwner = getUserIsOwner(userId);
    res.json({ success: true, isAdmin, isOwner });
});

app.get('/api/auth/public-config', (req, res) => {
    res.json({
        registrationDisabled: !!accessConfig.registrationDisabled
    });
});

app.get('/api/auth/me', (req, res) => {
    if (req.session && req.session.userId) {
        const stmt = systemDb.prepare(`SELECT username, is_admin, is_owner FROM users WHERE id = ?`);
        stmt.bind([req.session.userId]);
        if (stmt.step()) {
            const row = stmt.get();
            const username = row[0];
            const isAdmin = !!row[1];
            const isOwner = !!row[2];
            stmt.free();
            return res.json({ authenticated: true, username, isAdmin, isOwner });
        }
        stmt.free();
    }
    res.json({ authenticated: false, isAdmin: false, isOwner: false });
});

app.post('/api/auth/logout', (req, res) => {
    if (req.session && req.session.userId) {
        const stmt = systemDb.prepare(`SELECT db_bid FROM users WHERE id = ?`);
        stmt.bind([req.session.userId]);
        if (stmt.step()) {
            const dbBid = stmt.get()[0];
            stmt.free();
            saveUserDatabases(dbBid);
            unloadUserDatabases(dbBid);
        } else {
            stmt.free();
        }
        req.session.destroy(err => {
            if (err) logger.error('Logout error:', err);
            res.json({ success: true });
        });
    } else {
        res.json({ success: true });
    }
});

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

app.get('/api/media', (req, res) => {
    try {
        const db = req.db;
        const page = parseInt(req.query.page) || 0;
        const limit = parseInt(req.query.limit) || 27;
        const tagsFilter = req.query.tags || '';
        const favoriteOnly = req.query.favorite === 'true';
        const type = req.query.type || 'all';

        let whereClauses = [];
        let params = [];
        if (favoriteOnly) {
            whereClauses.push(`m.id IN (SELECT media_id FROM favorites)`);
        }
        if (type !== 'all') {
            whereClauses.push(`m.media_type = ?`);
            params.push(type);
        }

        let mediaIdsWithTags = null;
        if (tagsFilter.trim()) {
            const tagList = tagsFilter.trim().split(/\s+/).filter(t => t);
            let subQuery = `SELECT media_id FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE t.name IN (${tagList.map(() => '?').join(',')}) GROUP BY media_id HAVING COUNT(DISTINCT t.id) = ?`;
            const stmt = db.tags.prepare(subQuery);
            const args = [...tagList, tagList.length];
            stmt.bind(args);
            const ids = [];
            while (stmt.step()) {
                ids.push(stmt.get()[0]);
            }
            stmt.free();
            if (ids.length === 0) {
                return res.json({
                    success: true,
                    posts: [],
                    totalCount: 0,
                    totalPages: 0,
                    currentPage: page
                });
            }
            mediaIdsWithTags = ids;
        }

        if (mediaIdsWithTags) {
            whereClauses.push(`m.id IN (${mediaIdsWithTags.map(() => '?').join(',')})`);
            params.push(...mediaIdsWithTags);
        }

        const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const orderSql = `ORDER BY m.created_at DESC`;

        const countSql = `SELECT COUNT(*) as total FROM media m ${whereSql}`;
        const countStmt = db.main.prepare(countSql);
        if (params.length > 0) countStmt.bind(params);
        let totalCount = 0;
        if (countStmt.step()) totalCount = countStmt.get()[0];
        countStmt.free();

        const dataSql = `SELECT m.* FROM media m ${whereSql} ${orderSql} LIMIT ? OFFSET ?`;
        const dataStmt = db.main.prepare(dataSql);
        const allParams = [...params, limit, page * limit];
        if (allParams.length > 0) dataStmt.bind(allParams);

        const posts = [];
        while (dataStmt.step()) {
            const row = dataStmt.get();
            const columns = dataStmt.getColumnNames();
            const post = {};
            for (let i = 0; i < columns.length; i++) post[columns[i]] = row[i];
            
            delete post.encryption_iv;

            const tagStmt = db.tags.prepare(`SELECT t.name FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.media_id = ?`);
            tagStmt.bind([post.id]);
            const tags = [];
            while (tagStmt.step()) tags.push(tagStmt.get()[0]);
            tagStmt.free();
            post.tags = tags;

            post.file_url = `/media/${post.file_hash}`;

            const posterStmt = db.previews.prepare(`SELECT 1 FROM previews WHERE media_id = ?`);
            posterStmt.bind([post.id]);
            const hasPoster = posterStmt.step();
            posterStmt.free();
            post.poster_url = hasPoster ? `/poster/${post.file_hash}?t=${post.created_at || Date.now()}` : null;

            const favStmt = db.main.prepare(`SELECT 1 FROM favorites WHERE media_id = ?`);
            favStmt.bind([post.id]);
            post.is_favorite = favStmt.step();
            favStmt.free();

            posts.push(post);
        }
        dataStmt.free();

        res.json({
            success: true,
            posts,
            totalCount,
            totalPages: Math.ceil(totalCount / limit),
            currentPage: page
        });
    } catch (err) {
        logger.error(`Media list error: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message,
            posts: [],
            totalCount: 0,
            totalPages: 0,
            currentPage: 0
        });
    }
});

app.put('/api/media/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const { tags, displayName, description } = req.body;
    const db = req.db;
    try {
        if (displayName !== undefined) db.main.run(`UPDATE media SET display_name = ? WHERE id = ?`, [displayName, id]);
        if (description !== undefined) db.main.run(`UPDATE media SET description = ? WHERE id = ?`, [description, id]);
        if (tags !== undefined) {
            db.tags.run(`DELETE FROM media_tags WHERE media_id = ?`, [id]);
            const tagsList = tags.trim() ? tags.trim().split(/\s+/).filter(t => t) : [];
            for (const tagName of tagsList) {
                let tagId = null;
                const tagStmt = db.tags.prepare(`SELECT id FROM tags WHERE name = ?`);
                tagStmt.bind([tagName]);
                if (tagStmt.step()) tagId = tagStmt.get()[0];
                tagStmt.free();
                if (!tagId) {
                    db.tags.run(`INSERT INTO tags (name) VALUES (?)`, [tagName]);
                    tagId = db.tags.exec(`SELECT last_insert_rowid()`)[0].values[0][0];
                }
                db.tags.run(`INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)`, [id, tagId]);
            }
            cleanupOrphanedTags(db.tags);
        }
        saveUserDatabases(db.dbBid);
        res.json({ success: true });
    } catch (err) {
        logger.error(`Update media ${id} error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/media/:id/favorite', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const db = req.db;
    try {
        const stmt = db.main.prepare(`SELECT 1 FROM favorites WHERE media_id = ?`);
        stmt.bind([id]);
        const exists = stmt.step();
        stmt.free();
        if (exists) {
            db.main.run(`DELETE FROM favorites WHERE media_id = ?`, [id]);
            saveUserDatabases(db.dbBid);
            res.json({ success: true, is_favorite: false });
        } else {
            db.main.run(`INSERT INTO favorites (media_id, added_at) VALUES (?, ?)`, [id, Date.now()]);
            saveUserDatabases(db.dbBid);
            res.json({ success: true, is_favorite: true });
        }
    } catch (err) {
        logger.error(`Favorite toggle error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/media/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const db = req.db;
    try {
        
        const stmt = db.main.prepare(`SELECT container_name, file_hash FROM media WHERE id = ?`);
        stmt.bind([id]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        const row = stmt.get();
        stmt.free();
        const containerName = row[0];
        const fileHash = row[1];

        
        const containerPath = path.join(db.mediaDir, containerName);
        try { fs.unlinkSync(containerPath); } catch (e) {}
        if (fileHash) {
            const posterPath = path.join(db.mediaDir, `poster_${fileHash}.jpg`);
            try { fs.unlinkSync(posterPath); } catch (e) {}
        }

        
        
        db.main.run(`DELETE FROM favorites WHERE media_id = ?`, [id]);
        db.main.run(`DELETE FROM media WHERE id = ?`, [id]);
        db.tags.run(`DELETE FROM media_tags WHERE media_id = ?`, [id]);
        db.previews.run(`DELETE FROM previews WHERE media_id = ?`, [id]);
        cleanupOrphanedTags(db.tags);

        
        try { db.main.exec('VACUUM'); } catch (e) { logger.warn(`VACUUM main: ${e.message}`); }
        try { db.tags.exec('VACUUM'); } catch (e) { logger.warn(`VACUUM tags: ${e.message}`); }
        try { db.previews.exec('VACUUM'); } catch (e) { logger.warn(`VACUUM previews: ${e.message}`); }

        saveUserDatabases(db.dbBid);
        logger.info(st('mediaDeleted', { id }));
        res.json({ success: true });
    } catch (err) {
        logger.error(st('deleteError', { id, error: err.message }));
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/tags/autocomplete', (req, res) => {
    const query = req.query.query || '';
    if (!query) return res.json({ tags: [] });
    const db = req.db;
    try {
        const stmt = db.tags.prepare(`
            SELECT t.name, COUNT(mt.media_id) as count
            FROM tags t
            LEFT JOIN media_tags mt ON mt.tag_id = t.id
            WHERE t.name LIKE ?
            GROUP BY t.id
            ORDER BY t.name
            LIMIT 10
        `);
        stmt.bind([`${query}%`]);
        const tags = [];
        while (stmt.step()) {
            const row = stmt.get();
            tags.push({ name: row[0], count: row[1] });
        }
        stmt.free();
        res.json({ tags });
    } catch (err) {
        logger.error(st('autocompleteError', { error: err.message }));
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/search/history', (req, res) => {
    const { query, results_count } = req.body;
    if (!query) return res.status(400).json({ success: false });
    const db = req.db;
    try {
        db.main.run(`INSERT INTO search_history (query, timestamp, results_count) VALUES (?, ?, ?)`, [query, Date.now(), results_count || 0]);
        res.json({ success: true });
    } catch (err) {
        logger.error(`Search history error: ${err.message}`);
        res.status(500).json({ success: false });
    }
});

app.get('/api/search/history', (req, res) => {
    const db = req.db;
    try {
        const stmt = db.main.prepare(`SELECT query, timestamp, results_count FROM search_history ORDER BY timestamp DESC LIMIT 20`);
        const history = [];
        while (stmt.step()) {
            const row = stmt.get();
            history.push({ query: row[0], timestamp: row[1], results_count: row[2] });
        }
        stmt.free();
        res.json({ history });
    } catch (err) {
        logger.error(`Search history fetch error: ${err.message}`);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/stats', (req, res) => {
    const db = req.db;
    try {
        const mediaCount = db.main.exec(`SELECT COUNT(*) FROM media`)[0].values[0][0];
        const tagCount = db.tags.exec(`SELECT COUNT(*) FROM tags`)[0].values[0][0];
        const favCount = db.main.exec(`SELECT COUNT(*) FROM favorites`)[0].values[0][0];
        const searchCount = db.main.exec(`SELECT COUNT(*) FROM search_history`)[0].values[0][0];
        res.json({ mediaCount, tagCount, favCount, searchCount });
    } catch (err) {
        logger.error(`Stats error: ${err.message}`);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/logs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const logFile = path.join(LOGS_DIR, 'combined.log');
    if (!fs.existsSync(logFile)) return res.json({ logs: [] });
    try {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
        const last100 = lines.slice(-100);
        const formatted = last100.map((line) => {
            try {
                const obj = JSON.parse(line);
                const ts = obj.timestamp || obj.time || '';
                const level = (obj.level || 'info').toUpperCase();
                const msg = obj.message || obj.msg || line;
                const timeStr = ts ? String(ts).replace('T', ' ').replace(/Z$/, '').slice(0, 19) : '';
                return timeStr ? `[${timeStr}] ${level}: ${msg}` : `${level}: ${msg}`;
            } catch {
                return line;
            }
        });
        res.json({ logs: formatted });
    } catch (err) {
        logger.error(st('logsFetchError', { error: err.message }));
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/change-password', async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const userId = req.session.userId;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Old and new password required' });
    try {
        const userStmt = systemDb.prepare(`SELECT password_hash, db_bid FROM users WHERE id = ?`);
        userStmt.bind([userId]);
        userStmt.step();
        const storedHash = userStmt.get()[0];
        const dbBid = userStmt.get()[1];
        userStmt.free();
        const match = await bcrypt.compare(oldPassword, storedHash);
        if (!match) return res.status(401).json({ error: 'Invalid old password' });
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);
        systemDb.run(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`, [newHash, salt, userId]);
        const dbEntry = userDbs.get(dbBid);
        if (dbEntry) {
            const masterKey = dbEntry.masterKey;
            const encryptedMasterKey = encryptMasterKey(masterKey, newPassword);
            fs.writeFileSync(path.join(dbEntry.userDir, 'master.key.enc'), encryptedMasterKey);
        }
        const sysData = systemDb.export();
        fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(sysData));
        logger.info(st('passwordChangedLog', { userId }));
        res.json({ success: true });
    } catch (err) {
        logger.error(st('passwordChangeError', { error: err.message }));
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/change-username', (req, res) => {
    const { newUsername } = req.body;
    const userId = req.session.userId;
    if (!newUsername) return res.status(400).json({ error: 'Username required' });
    try {
        const checkStmt = systemDb.prepare(`SELECT id FROM users WHERE username = ? AND id != ?`);
        checkStmt.bind([newUsername, userId]);
        if (checkStmt.step()) {
            checkStmt.free();
            return res.status(400).json({ error: 'Username already taken' });
        }
        checkStmt.free();
        systemDb.run(`UPDATE users SET username = ? WHERE id = ?`, [newUsername, userId]);
        const sysData = systemDb.export();
        fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(sysData));
        logger.info(st('usernameChangedLog', { userId }));
        res.json({ success: true });
    } catch (err) {
        logger.error(st('usernameChangeError', { error: err.message }));
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/settings/access', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({
        success: true,
        port: accessConfig.port,
        currentPort: accessConfig.port,
        localhostOnly: !!accessConfig.localhostOnly,
        registrationDisabled: !!accessConfig.registrationDisabled,
        language: accessConfig.language || DEFAULT_LANG || 'en',
        restartRequired: false
    });
});

app.post('/api/settings/access', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { port, localhostOnly, registrationDisabled, language } = req.body || {};
        const newCfg = { ...accessConfig };

        let restartRequired = false;

        if (port !== undefined && port !== null && port !== '') {
            const p = parseInt(port, 10);
            if (!Number.isInteger(p) || p < 1 || p > 65535) {
                return res.status(400).json({ success: false, error: 'Invalid port' });
            }
            if (p !== accessConfig.port) {
                newCfg.port = p;
                restartRequired = true;
            }
        }

        if (localhostOnly !== undefined) {
            const val = !!localhostOnly;
            if (val !== accessConfig.localhostOnly) {
                newCfg.localhostOnly = val;
                
                restartRequired = true;
            }
        }

        if (registrationDisabled !== undefined) {
            newCfg.registrationDisabled = !!registrationDisabled;
        }

        if (language !== undefined && language !== null && language !== '') {
            if (!translations[language]) {
                return res.status(400).json({ success: false, error: 'Invalid language' });
            }
            newCfg.language = language;
        }

        saveAccessConfig(newCfg);
        setAccessConfig(newCfg);

        logger.info(st('accessSettingsUpdated', { port: newCfg.port, localhostOnly: newCfg.localhostOnly, registrationDisabled: newCfg.registrationDisabled }));
        res.json({
            success: true,
            port: newCfg.port,
            localhostOnly: newCfg.localhostOnly,
            registrationDisabled: newCfg.registrationDisabled,
            language: newCfg.language,
            restartRequired
        });
    } catch (err) {
        logger.error(`Access settings error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.post('/api/settings/language', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { language } = req.body || {};
        if (!language || !translations[language]) {
            return res.status(400).json({ success: false, error: 'Invalid language' });
        }
        setAccessConfig({ ...accessConfig, language });
        saveAccessConfig(accessConfig);
        logger.info(st('languageSaved'));
        res.json({ success: true, language });
    } catch (err) {
        logger.error(`Language settings error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.get('/api/admin/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const stmt = systemDb.prepare(`SELECT id, username, created_at, is_admin, is_owner FROM users ORDER BY id ASC`);
        const users = [];
        while (stmt.step()) {
            const row = stmt.get();
            users.push({
                id: row[0],
                username: row[1],
                created_at: row[2],
                is_admin: !!row[3],
                is_owner: !!row[4]
            });
        }
        stmt.free();
        res.json({ success: true, users });
    } catch (err) {
        logger.error(`Admin users list error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.delete('/api/admin/users/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) {
        return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    if (targetId === req.session.userId) {
        return res.status(400).json({ success: false, code: 'cannot_delete_self' });
    }
    try {
        const stmt = systemDb.prepare(`SELECT username, db_bid, media_bid, is_admin, is_owner FROM users WHERE id = ?`);
        stmt.bind([targetId]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        const row = stmt.get();
        stmt.free();
        const username = row[0];
        const dbBid = row[1];
        const mediaBid = row[2];
        const wasAdmin = !!row[3];
        const wasOwner = !!row[4];

        if (wasOwner) {
            return res.status(400).json({ success: false, code: 'cannot_delete_owner' });
        }

        if (wasAdmin) {
            const adminCnt = systemDb.exec(`SELECT COUNT(*) FROM users WHERE is_admin = 1`);
            const n = adminCnt.length ? adminCnt[0].values[0][0] : 0;
            if (n <= 1) {
                return res.status(400).json({ success: false, code: 'cannot_delete_last_admin' });
            }
        }

        try {
            if (userDbs.has(dbBid)) {
                saveUserDatabases(dbBid);
                unloadUserDatabases(dbBid);
            }
        } catch (e) {}

        systemDb.run(`DELETE FROM users WHERE id = ?`, [targetId]);
        const sysData = systemDb.export();
        fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(sysData));

        try {
            const userDir = getUserDbPath(dbBid);
            if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
        } catch (e) {
            logger.warn(`Failed to remove user dir ${dbBid}: ${e.message}`);
        }
        try {
            const mediaDir = getUserMediaPath(mediaBid);
            if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });
        } catch (e) {
            logger.warn(`Failed to remove media dir ${mediaBid}: ${e.message}`);
        }

        logger.info(`Admin deleted user ${username} (id=${targetId})`);
        res.json({ success: true });
    } catch (err) {
        logger.error(`Admin delete user error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.post('/api/admin/users/:id/set-admin', (req, res) => {
    if (!requireOwner(req, res)) return;
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) {
        return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const makeAdmin = !!(req.body && req.body.is_admin);
    try {
        const stmt = systemDb.prepare(`SELECT username, is_admin, is_owner FROM users WHERE id = ?`);
        stmt.bind([targetId]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        const row = stmt.get();
        stmt.free();
        const username = row[0];
        const isOwner = !!row[2];

        if (isOwner) {
            return res.status(400).json({ success: false, code: 'cannot_demote_owner' });
        }
        if (targetId === req.session.userId) {
            return res.status(400).json({ success: false, code: 'cannot_change_self' });
        }

        systemDb.run(`UPDATE users SET is_admin = ? WHERE id = ?`, [makeAdmin ? 1 : 0, targetId]);
        const sysData = systemDb.export();
        fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(sysData));
        logger.info(`Owner set is_admin=${makeAdmin ? 1 : 0} for user ${username} (id=${targetId})`);
        res.json({ success: true, is_admin: makeAdmin });
    } catch (err) {
        logger.error(`Set admin error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.post('/api/admin/users/:id/transfer-ownership', (req, res) => {
    if (!requireOwner(req, res)) return;
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) {
        return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    if (targetId === req.session.userId) {
        return res.status(400).json({ success: false, code: 'cannot_transfer_to_self' });
    }
    try {
        const stmt = systemDb.prepare(`SELECT username FROM users WHERE id = ?`);
        stmt.bind([targetId]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        const username = stmt.get()[0];
        stmt.free();

        
        systemDb.run(`UPDATE users SET is_owner = 0`);
        systemDb.run(`UPDATE users SET is_owner = 1, is_admin = 1 WHERE id = ?`, [targetId]);
        const sysData = systemDb.export();
        fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(sysData));
        logger.info(`Ownership transferred to ${username} (id=${targetId}) by user ${req.session.userId}`);
        res.json({ success: true });
    } catch (err) {
        logger.error(`Transfer ownership error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

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
