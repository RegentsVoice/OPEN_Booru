import fs from 'fs';
import { createSqlJs } from '../lib/sqljs.js';
import {
    SYSTEM_DB_PATH, logger, st
} from '../config.js';

export let systemDb = null;

export async function initSystemDb() {
    const SQL = await createSqlJs();
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
        CREATE TABLE IF NOT EXISTS booru_credentials (
            user_id INTEGER NOT NULL,
            site TEXT NOT NULL,
            account_id TEXT,
            api_key TEXT,
            extra TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, site)
        );
    `);
    
    try { systemDb.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch (e) {}
    try { systemDb.exec(`ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0`); } catch (e) {}
    try {
        systemDb.exec(`
            CREATE TABLE IF NOT EXISTS booru_credentials (
                user_id INTEGER NOT NULL,
                site TEXT NOT NULL,
                account_id TEXT,
                api_key TEXT,
                extra TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, site)
            );
        `);
    } catch (e) {}
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

export function getBooruCredentialsMap(userId) {
    const map = {};
    if (!userId || !systemDb) return map;
    try {
        const stmt = systemDb.prepare(`SELECT site, account_id, api_key, extra FROM booru_credentials WHERE user_id = ?`);
        stmt.bind([userId]);
        while (stmt.step()) {
            const row = stmt.get();
            const site = row[0];
            let extra = {};
            try { extra = row[3] ? JSON.parse(row[3]) : {}; } catch (e) { extra = {}; }
            map[site] = {
                user_id: row[1] || '',
                account_id: row[1] || '',
                login: extra.login || row[1] || '',
                api_key: row[2] || '',
                ...extra
            };
        }
        stmt.free();
    } catch (e) {
        logger.error(`getBooruCredentialsMap: ${e.message}`);
    }
    return map;
}

export function listBooruCredentials(userId) {
    const list = [];
    if (!userId || !systemDb) return list;
    try {
        const stmt = systemDb.prepare(`SELECT site, account_id, api_key, extra, updated_at FROM booru_credentials WHERE user_id = ?`);
        stmt.bind([userId]);
        while (stmt.step()) {
            const row = stmt.get();
            let extra = {};
            try { extra = row[3] ? JSON.parse(row[3]) : {}; } catch (e) { extra = {}; }
            list.push({
                site: row[0],
                account_id: row[1] || '',
                login: extra.login || '',
                has_api_key: !!(row[2] && String(row[2]).length),
                api_key_masked: row[2] ? (String(row[2]).slice(0, 4) + '…') : '',
                updated_at: row[4] || 0
            });
        }
        stmt.free();
    } catch (e) {
        logger.error(`listBooruCredentials: ${e.message}`);
    }
    return list;
}

export function saveBooruCredential(userId, site, { account_id, api_key, login }) {
    if (!userId || !systemDb || !site) return false;
    const extra = JSON.stringify({ login: login || account_id || '' });
    const acc = account_id || login || '';
    const key = api_key || '';
    systemDb.run(
        `INSERT OR REPLACE INTO booru_credentials (user_id, site, account_id, api_key, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, site, acc, key, extra, Date.now()]
    );
    const data = systemDb.export();
    fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(data));
    return true;
}

export function deleteBooruCredential(userId, site) {
    if (!userId || !systemDb || !site) return false;
    systemDb.run(`DELETE FROM booru_credentials WHERE user_id = ? AND site = ?`, [userId, site]);
    const data = systemDb.export();
    fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(data));
    return true;
}
