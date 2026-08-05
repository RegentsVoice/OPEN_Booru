import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import {
    SYSTEM_DB_PATH, LOGS_DIR, logger, st, accessConfig, setAccessConfig,
    loadAccessConfig, saveAccessConfig
} from '../config.js';
import { encryptMasterKey } from '../lib/crypto.js';
import {
    systemDb, userDbs, requireAdmin
} from '../db/index.js';
import { translations, DEFAULT_LANG } from '../../shared/server-locales.js';

export function registerSettingsRoutes(app) {
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

}
