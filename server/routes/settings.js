import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import {
    SYSTEM_DB_PATH, LOGS_DIR, logger, st, accessConfig, setAccessConfig,
    loadAccessConfig, saveAccessConfig, CLIP_PRESETS, normalizeClipModel,
    getClipModelId, getClipQuantized, clampClipSearchMin, clampClipSimilarMin
} from '../config.js';
import { encryptMasterKey } from '../lib/crypto.js';
import {
    systemDb, userDbs, requireAdmin,
    saveUserDatabases, unloadUserDatabases, loadUserDatabases,
    getUserDbPath, getUserMediaPath
} from '../db/index.js';
import { createArchiveFromDir, extractArchive, stageUserExport } from '../lib/zip-util.js';
import os from 'os';
import multer from 'multer';
import { translations, DEFAULT_LANG } from '../../shared/server-locales.js';
import { unloadClipModel, getLoadedClipInfo } from '../lib/embed.js';
import { invalidateClipEmbeddingsForLoadedUsers } from '../services/duplicates.js';
import { listClipModels, installClipModel, deleteClipModel, getInstallJob, cancelInstallJob } from '../lib/clip-models.js';

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
        clipModel: normalizeClipModel(accessConfig.clipModel),
        clipQuantized: accessConfig.clipQuantized !== false,
        clipModelId: getClipModelId(),
        clipSearchMin: clampClipSearchMin(accessConfig.clipSearchMin),
        clipSimilarMin: clampClipSimilarMin(accessConfig.clipSimilarMin),
        clipPresets: CLIP_PRESETS,
        clipLoaded: getLoadedClipInfo(),
        restartRequired: false
    });
});

app.post('/api/settings/access', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { port, localhostOnly, registrationDisabled, language, clipModel, clipQuantized } = req.body || {};
        const newCfg = { ...accessConfig };

        let restartRequired = false;
        let clipChanged = false;

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

        if (clipModel !== undefined && clipModel !== null && clipModel !== '') {
            const key = normalizeClipModel(clipModel);
            if (!CLIP_PRESETS[key]) {
                return res.status(400).json({ success: false, error: 'Invalid CLIP model' });
            }
            if (key !== normalizeClipModel(accessConfig.clipModel)) {
                newCfg.clipModel = key;
                clipChanged = true;
            }
        }

        if (clipQuantized !== undefined) {
            const q = !!clipQuantized;
            if (q !== (accessConfig.clipQuantized !== false)) {
                newCfg.clipQuantized = q;
                clipChanged = true;
            }
        }

        saveAccessConfig(newCfg);
        setAccessConfig(newCfg);

        if (clipChanged) {
            unloadClipModel();
            invalidateClipEmbeddingsForLoadedUsers();
            logger.info(`CLIP model set to ${getClipModelId()} quantized=${getClipQuantized()}`);
        }

        logger.info(st('accessSettingsUpdated', { port: newCfg.port, localhostOnly: newCfg.localhostOnly, registrationDisabled: newCfg.registrationDisabled }));
        res.json({
            success: true,
            port: newCfg.port,
            localhostOnly: newCfg.localhostOnly,
            registrationDisabled: newCfg.registrationDisabled,
            language: newCfg.language,
            clipModel: normalizeClipModel(newCfg.clipModel),
            clipQuantized: newCfg.clipQuantized !== false,
            clipModelId: getClipModelId(),
            clipChanged,
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


app.get('/api/settings/clip/embedding-status', (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const stmtU = systemDb.prepare(`SELECT db_bid FROM users WHERE id = ?`);
        stmtU.bind([req.session.userId]);
        if (!stmtU.step()) {
            stmtU.free();
            return res.status(403).json({ success: false, error: 'User not found' });
        }
        const dbBid = stmtU.get()[0];
        stmtU.free();
        const entry = userDbs.get(dbBid);
        if (!entry || !entry.main) {
            return res.json({ success: true, total: 0, withEmbedding: 0, needsRebuild: false, missing: 0 });
        }
        let total = 0;
        let withEmbedding = 0;
        const stmt = entry.main.prepare(`SELECT embedding FROM media`);
        while (stmt.step()) {
            total++;
            const emb = stmt.get()[0];
            if (emb && String(emb).length > 16) withEmbedding++;
        }
        stmt.free();
        res.json({
            success: true,
            total,
            withEmbedding,
            needsRebuild: total > 0 && withEmbedding < total,
            missing: Math.max(0, total - withEmbedding)
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


app.get('/api/settings/clip/search-settings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({
        success: true,
        clipSearchMin: clampClipSearchMin(accessConfig.clipSearchMin),
        clipSimilarMin: clampClipSimilarMin(accessConfig.clipSimilarMin)
    });
});

app.post('/api/settings/clip/search-settings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const newCfg = { ...accessConfig };
        if (req.body?.clipSearchMin !== undefined) {
            newCfg.clipSearchMin = clampClipSearchMin(req.body.clipSearchMin);
        }
        if (req.body?.clipSimilarMin !== undefined) {
            newCfg.clipSimilarMin = clampClipSimilarMin(req.body.clipSimilarMin);
        }
        setAccessConfig(newCfg);
        saveAccessConfig(newCfg);
        res.json({
            success: true,
            clipSearchMin: newCfg.clipSearchMin,
            clipSimilarMin: newCfg.clipSimilarMin
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/settings/clip/models', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const data = listClipModels();
        const active = normalizeClipModel(accessConfig.clipModel);
        const activeQuantized = getClipQuantized();
        res.json({
            success: true,
            active,
            activeQuantized,
            activeModelId: getClipModelId(),
            loaded: getLoadedClipInfo(),
            ...data
        });
    } catch (err) {
        logger.error(`clip models list: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings/clip/install', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const key = normalizeClipModel(req.body?.key || req.body?.clipModel);
        if (!CLIP_PRESETS[key]) {
            return res.status(400).json({ success: false, error: 'Invalid CLIP model' });
        }
        const quantized = req.body?.quantized !== undefined
            ? !!req.body.quantized
            : true;
        const existing = getInstallJob(key, quantized);
        if (existing && existing.status === 'running') {
            return res.json({ success: true, job: existing });
        }
        res.json({
            success: true,
            job: {
                key,
                quantized,
                status: 'running',
                progress: 0,
                message: 'Starting…'
            }
        });
        installClipModel(key, { quantized }).catch((err) => {
            logger.error(`clip install: ${err.message}`);
        });
    } catch (err) {
        logger.error(`clip install: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/settings/clip/install/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const key = normalizeClipModel(req.query.key || '');
        const quantized = req.query.quantized === '1' || req.query.quantized === 'true';
        const job = getInstallJob(key, quantized);
        if (!job) {
            return res.json({ success: true, job: null });
        }
        res.json({ success: true, job });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings/clip/install/cancel', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const key = normalizeClipModel(req.body?.key || '');
        const quantized = req.body?.quantized !== undefined ? !!req.body.quantized : true;
        const result = cancelInstallJob(key, quantized);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings/clip/activate', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const key = normalizeClipModel(req.body?.key || req.body?.clipModel);
        if (!CLIP_PRESETS[key]) {
            return res.status(400).json({ success: false, error: 'Invalid CLIP model' });
        }
        const quantized = req.body?.quantized !== undefined ? !!req.body.quantized : true;
        const prevKey = normalizeClipModel(accessConfig.clipModel);
        const prevQ = accessConfig.clipQuantized !== false;
        const changed = prevKey !== key || prevQ !== quantized;

        const newCfg = {
            ...accessConfig,
            clipModel: key,
            clipQuantized: quantized
        };
        saveAccessConfig(newCfg);
        setAccessConfig(newCfg);

        if (changed) {
            unloadClipModel();
            invalidateClipEmbeddingsForLoadedUsers();
            logger.info(`CLIP active set to ${getClipModelId()} quantized=${getClipQuantized()}`);
        }

        res.json({
            success: true,
            clipModel: key,
            clipQuantized: quantized,
            clipModelId: getClipModelId(),
            clipChanged: changed
        });
    } catch (err) {
        logger.error(`clip activate: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/settings/clip/models/:key', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const key = normalizeClipModel(req.params.key);
        if (!CLIP_PRESETS[key]) {
            return res.status(400).json({ success: false, error: 'Invalid CLIP model' });
        }
        const quantized = req.query.quantized !== undefined
            ? (req.query.quantized === '1' || req.query.quantized === 'true')
            : true;

        const activeKey = normalizeClipModel(accessConfig.clipModel);
        const activeQ = getClipQuantized();
        if (key === activeKey && quantized === activeQ) {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete the active model variant'
            });
        }

        if (key === activeKey) {
            unloadClipModel();
        }
        const result = deleteClipModel(key, { quantized });
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`clip delete: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});


const userImportDir = path.join(os.tmpdir(), 'ob-import');
try { fs.mkdirSync(userImportDir, { recursive: true }); } catch (_) {}
const userImportUpload = multer({
    dest: userImportDir,
    limits: { fileSize: 1024 * 1024 * 1024 * 8 }
});

app.get('/api/user/export', (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    let staging = null;
    let archivePath = null;
    try {
        const stmt = systemDb.prepare(`SELECT username, db_bid, media_bid FROM users WHERE id = ?`);
        stmt.bind([req.session.userId]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(403).json({ success: false, error: 'User not found' });
        }
        const [username, dbBid, mediaBid] = stmt.get();
        stmt.free();

        if (userDbs.has(dbBid)) {
            saveUserDatabases(dbBid);
        }

        staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-export-'));
        stageUserExport({
            dbSrc: getUserDbPath(dbBid),
            mediaSrc: getUserMediaPath(mediaBid),
            staging,
            meta: {
                version: 1,
                app: 'open-booru',
                username,
                exportedAt: Date.now()
            }
        });

        archivePath = path.join(os.tmpdir(), `ob-export-${dbBid}-${Date.now()}.tar`);
        createArchiveFromDir(staging, archivePath);
        try {
            fs.rmSync(staging, { recursive: true, force: true });
            staging = null;
        } catch (_) {}

        res.download(archivePath, `open-booru-${username || 'user'}-export.tar`, (err) => {
            try { if (archivePath) fs.unlinkSync(archivePath); } catch (_) {}
            if (err && !res.headersSent) {
                res.status(500).json({ success: false, error: err.message });
            }
        });
    } catch (err) {
        logger.error(`user export: ${err.message}`);
        try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
        try { if (archivePath) fs.unlinkSync(archivePath); } catch (_) {}
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/user/import', userImportUpload.single('file'), async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const password = (req.body && req.body.password) || '';
    if (!password) {
        return res.status(400).json({ success: false, error: 'Password required' });
    }
    if (!req.file || !req.file.path) {
        return res.status(400).json({ success: false, error: 'File required' });
    }

    const zipPath = req.file.path;
    let staging = null;
    try {
        const stmt = systemDb.prepare(`SELECT db_bid, media_bid FROM users WHERE id = ?`);
        stmt.bind([req.session.userId]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(403).json({ success: false, error: 'User not found' });
        }
        const [dbBid, mediaBid] = stmt.get();
        stmt.free();

        staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-import-'));
        extractArchive(zipPath, staging);

        const metaPath = path.join(staging, 'meta.json');
        if (!fs.existsSync(metaPath)) {
            throw new Error('Invalid archive: meta.json missing');
        }
        const dbSrc = path.join(staging, 'db');
        const mediaSrc = path.join(staging, 'media');
        if (!fs.existsSync(path.join(dbSrc, 'main.db')) || !fs.existsSync(path.join(dbSrc, 'master.key.enc'))) {
            throw new Error('Invalid archive: database files missing');
        }

        if (userDbs.has(dbBid)) {
            try { saveUserDatabases(dbBid); } catch (_) {}
            try { unloadUserDatabases(dbBid); } catch (_) {}
        }

        const dbDest = getUserDbPath(dbBid);
        const mediaDest = getUserMediaPath(mediaBid);
        fs.mkdirSync(dbDest, { recursive: true });
        fs.mkdirSync(mediaDest, { recursive: true });

        for (const f of ['main.db', 'tags.db', 'previews.db', 'master.key.enc']) {
            const p = path.join(dbSrc, f);
            if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dbDest, f));
        }

        for (const name of fs.readdirSync(mediaDest)) {
            try { fs.unlinkSync(path.join(mediaDest, name)); } catch (_) {}
        }
        if (fs.existsSync(mediaSrc)) {
            for (const name of fs.readdirSync(mediaSrc)) {
                const full = path.join(mediaSrc, name);
                if (fs.statSync(full).isFile()) {
                    fs.copyFileSync(full, path.join(mediaDest, name));
                }
            }
        }

        await loadUserDatabases(dbBid, mediaBid, password);
        res.json({ success: true });
    } catch (err) {
        logger.error(`user import: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    } finally {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        if (staging) {
            try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
        }
    }
});


}
