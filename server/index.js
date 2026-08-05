import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import session from 'express-session';

import {
    ROOT_DIR, PUBLIC_DIR, TEMP_DIR, SYSTEM_DB_PATH,
    logger, st, accessConfig, setAccessConfig, loadAccessConfig,
    isLocalAddress, getClientIp, getSessionSecret
} from './config.js';
import { systemDb, userDbs, initSystemDb, saveUserDatabases } from './db/index.js';
import { registerRoutes } from './routes/index.js';

const app = express();

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const basename = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
        cb(null, `${Date.now()}_${basename}${ext}`);
    }
});
const upload = multer({ storage });

app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
    const p = (req.path || '').toLowerCase();
    if (p === '/js/server.js' || p.endsWith('/server.js')) {
        return res.status(404).end();
    }
    next();
});
app.use(express.static(PUBLIC_DIR));
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    next(err);
});

app.use((req, res, next) => {
    if (!accessConfig.localhostOnly) return next();
    const ip = getClientIp(req);
    if (isLocalAddress(ip)) return next();
    logger.warn(st('blockedNonLocal', { ip }));
    return res.status(403).send('Access denied: only localhost is allowed');
});

const sessionSecret = process.env.SESSION_SECRET || getSessionSecret();
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 86400000 }
}));

app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth')) return next();
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const stmt = systemDb.prepare(`SELECT db_bid, media_bid FROM users WHERE id = ?`);
    stmt.bind([req.session.userId]);
    if (!stmt.step()) {
        stmt.free();
        return res.status(403).json({ error: 'User not found' });
    }
    const row = stmt.get();
    const dbBid = row[0];
    const mediaBid = row[1];
    stmt.free();
    const dbEntry = userDbs.get(dbBid);
    if (!dbEntry) {
        return res.status(403).json({ error: 'User database not loaded' });
    }
    req.db = dbEntry;
    next();
});

registerRoutes(app, upload);

initSystemDb().then(() => {
    setAccessConfig(loadAccessConfig());
    if (process.env.PORT) {
        const envPort = parseInt(process.env.PORT, 10);
        if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
            accessConfig.port = envPort;
        }
    }
    const host = accessConfig.localhostOnly ? '127.0.0.1' : '0.0.0.0';
    app.listen(accessConfig.port, host, () => {
        logger.info(st('serverRunning', { port: `${host}:${accessConfig.port}` }));
    });
}).catch(err => {
    logger.error(st('databaseInitFailed', { error: err.message }));
    process.exit(1);
});

function shutdown() {
    for (const [dbBid] of userDbs) {
        saveUserDatabases(dbBid);
    }
    if (systemDb) {
        const sysData = systemDb.export();
        fs.writeFileSync(SYSTEM_DB_PATH, Buffer.from(sysData));
    }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
