import fs from 'fs';
import {
    SYSTEM_DB_PATH, logger
} from '../config.js';
import {
    systemDb, userDbs, getUserDbPath, getUserMediaPath,
    saveUserDatabases, unloadUserDatabases,
    requireAdmin, requireOwner
} from '../db/index.js';

export function registerAdminRoutes(app) {
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

}
