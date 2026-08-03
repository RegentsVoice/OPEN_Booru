import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import {
    SYSTEM_DB_PATH, USERS_DIR, MEDIA_BASE, logger, st, logInfo
} from './config.js';
import {
    decryptMasterKey, encryptDbBuffer, decryptDbBuffer
} from './crypto.js';

export let systemDb = null;
export const userDbs = new Map();

export async function initSystemDb() {
    const SQL = await initSqlJs();
    let fileBuffer = null;
    if (fs.existsSync(SYSTEM_DB_PATH)) {
        fileBuffer = fs.readFileSync(SYSTEM_DB_PATH);
    }
    systemDb = new SQL.Database(fileBuffer);
    systemDb.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            db_bid TEXT UNIQUE NOT NULL,
            media_bid TEXT UNIQUE NOT NULL,
            created_at INTEGER NOT NULL,
            is_admin INTEGER DEFAULT 0,
            is_owner INTEGER DEFAULT 0
        );
    `);
    
    try { systemDb.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch (e) {}
    try { systemDb.exec(`ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0`); } catch (e) {}
    try {
        
        const ownerCount = systemDb.exec(`SELECT COUNT(*) FROM users WHERE is_owner = 1`);
        const hasOwner = ownerCount.length && ownerCount[0].values[0][0] > 0;
        if (!hasOwner) {
            const first = systemDb.exec(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
            if (first.length && first[0].values.length) {
                const firstId = first[0].values[0][0];
                systemDb.run(`UPDATE users SET is_owner = 1, is_admin = 1 WHERE id = ?`, [firstId]);
                logger.info(`Migrated first user (id=${firstId}) to owner+admin`);
            }
        } else {
            
            systemDb.run(`UPDATE users SET is_admin = 1 WHERE is_owner = 1`);
        }
        
        const adminCount = systemDb.exec(`SELECT COUNT(*) FROM users WHERE is_admin = 1`);
        const hasAdmin = adminCount.length && adminCount[0].values[0][0] > 0;
        if (!hasAdmin) {
            const first = systemDb.exec(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
            if (first.length && first[0].values.length) {
                const firstId = first[0].values[0][0];
                systemDb.run(`UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?`, [firstId]);
                logger.info(`Migrated first user (id=${firstId}) to owner+admin`);
            }
        }
    } catch (e) {
        logger.error(`Admin/owner migration error: ${e.message}`);
    }
    const data = systemDb.export();
    fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(data));
    logger.info(st('databasesInitialized'));
}

export function generateBid() {
    return String(Math.floor(10000000 + Math.random() * 90000000));
}

export function getUserDbPath(dbBid) {
    return path.join(USERS_DIR, dbBid);
}

export function getUserMediaPath(mediaBid) {
    return path.join(MEDIA_BASE, mediaBid);
}

export async function loadUserDatabases(dbBid, mediaBid, password) {
    const userDir = getUserDbPath(dbBid);
    const masterKeyEncPath = path.join(userDir, 'master.key.enc');
    if (!fs.existsSync(masterKeyEncPath)) {
        throw new Error('Master key file not found');
    }
    const encryptedMasterKey = fs.readFileSync(masterKeyEncPath);
    let masterKey;
    try {
        masterKey = decryptMasterKey(encryptedMasterKey, password);
    } catch (err) {
        throw new Error('Invalid password or corrupted master key');
    }

    const SQL = await initSqlJs();
    const dbFiles = ['main.db', 'tags.db', 'previews.db'];
    const dbInstances = {};
    for (const file of dbFiles) {
        const filePath = path.join(userDir, file);
        let dbBuffer = null;
        if (fs.existsSync(filePath)) {
            const encryptedData = fs.readFileSync(filePath);
            try {
                dbBuffer = decryptDbBuffer(encryptedData, masterKey);
            } catch (err) {
                
                throw new Error(`Failed to decrypt ${file}: ${err.message}`);
            }
        }
        const db = new SQL.Database(dbBuffer);
        try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}
        if (file === 'main.db') {
            db.exec(`
                CREATE TABLE IF NOT EXISTS media (
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
                CREATE TABLE IF NOT EXISTS favorites (
                    media_id INTEGER,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (media_id),
                    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS search_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    query TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    results_count INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_media_hash ON media(file_hash);
                CREATE INDEX IF NOT EXISTS idx_search_history_timestamp ON search_history(timestamp DESC);
            `);
            try {
                db.exec(`ALTER TABLE media ADD COLUMN encryption_iv BLOB`);
                logger.info(st('columnAdded', { column: 'encryption_iv' }));
            } catch (e) {}
        } else if (file === 'tags.db') {
            db.exec(`
                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL
                );
                CREATE TABLE IF NOT EXISTS media_tags (
                    media_id INTEGER,
                    tag_id INTEGER,
                    PRIMARY KEY (media_id, tag_id)
                );
                CREATE INDEX IF NOT EXISTS idx_media_tags_media ON media_tags(media_id);
                CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags(tag_id);
            `);
        } else if (file === 'previews.db') {
            db.exec(`
                CREATE TABLE IF NOT EXISTS previews (
                    media_id INTEGER PRIMARY KEY,
                    poster BLOB
                );
            `);
        }
        dbInstances[file.replace('.db', '')] = db;
    }
    const entry = {
        main: dbInstances.main,
        tags: dbInstances.tags,
        previews: dbInstances.previews,
        masterKey: masterKey,
        dbBid: dbBid,
        mediaBid: mediaBid,
        userDir: userDir,
        mediaDir: getUserMediaPath(mediaBid)
    };
    userDbs.set(dbBid, entry);
    return entry;
}

export function unloadUserDatabases(dbBid) {
    const entry = userDbs.get(dbBid);
    if (entry) {
        userDbs.delete(dbBid);
        logger.info(st('unloadedDatabases', { dbBid }));
    }
}

export function saveUserDatabases(dbBid) {
    const entry = userDbs.get(dbBid);
    if (!entry) return;
    const { main, tags, previews, masterKey, userDir } = entry;
    const dbMap = { main, tags, previews };
    for (const [name, db] of Object.entries(dbMap)) {
        const data = db.export();
        const encrypted = encryptDbBuffer(Buffer.from(data), masterKey);
        const filePath = path.join(userDir, `${name}.db`);
        fs.writeFileSync(filePath, encrypted);
    }
    logger.info(st('savedDatabases', { dbBid }));
}

export function cleanupOrphanedTags(tagsDb) {
    if (!tagsDb) return;
    try {
        tagsDb.run(`
            DELETE FROM tags 
            WHERE id NOT IN (SELECT DISTINCT tag_id FROM media_tags)
        `);
        logger.info(st('orphanedTagsCleaned'));
    } catch (err) {
        logger.error(`Cleanup orphaned tags error: ${err.message}`);
    }
}
export function getUserIsAdmin(userId) {
    if (!userId || !systemDb) return false;
    try {
        const stmt = systemDb.prepare(`SELECT is_admin FROM users WHERE id = ?`);
        stmt.bind([userId]);
        if (!stmt.step()) { stmt.free(); return false; }
        const v = stmt.get()[0];
        stmt.free();
        return !!v;
    } catch {
        return false;
    }
}

export function getUserIsOwner(userId) {
    if (!userId || !systemDb) return false;
    try {
        const stmt = systemDb.prepare(`SELECT is_owner FROM users WHERE id = ?`);
        stmt.bind([userId]);
        if (!stmt.step()) { stmt.free(); return false; }
        const v = stmt.get()[0];
        stmt.free();
        return !!v;
    } catch {
        return false;
    }
}

export function requireAdmin(req, res) {
    if (!req.session || !req.session.userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return false;
    }
    if (!getUserIsAdmin(req.session.userId)) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return false;
    }
    return true;
}

export function requireOwner(req, res) {
    if (!req.session || !req.session.userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return false;
    }
    if (!getUserIsOwner(req.session.userId)) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return false;
    }
    return true;
}
