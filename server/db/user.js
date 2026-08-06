import fs from 'fs';
import path from 'path';
import { createSqlJs } from '../lib/sqljs.js';
import {
    USERS_DIR, MEDIA_BASE, logger, st
} from '../config.js';
import {
    decryptMasterKey, encryptDbBuffer, decryptDbBuffer
} from '../lib/crypto.js';

export const userDbs = new Map();

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

    const SQL = await createSqlJs();
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
            try { db.exec(`ALTER TABLE media ADD COLUMN phash TEXT`); } catch (e) {}
            try { db.exec(`ALTER TABLE media ADD COLUMN phash_status TEXT DEFAULT 'pending'`); } catch (e) {}
            try {
                db.exec(`
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
