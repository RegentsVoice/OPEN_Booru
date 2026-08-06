import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { createSqlJs } from '../lib/sqljs.js';
import {
    SYSTEM_DB_PATH, logger, st, accessConfig
} from '../config.js';
import { encryptMasterKey, encryptDbBuffer } from '../lib/crypto.js';
import {
    systemDb, generateBid, getUserDbPath, getUserMediaPath,
    loadUserDatabases, unloadUserDatabases, saveUserDatabases,
    getUserIsAdmin, getUserIsOwner
} from '../db/index.js';

export function registerAuthRoutes(app) {
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

    const SQL = await createSqlJs();
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

}
