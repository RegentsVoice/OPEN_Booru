import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fs from 'fs';
import winston from 'winston';
import { translations, DEFAULT_LANG } from '../shared/server-locales.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export const LOGS_DIR = path.join(ROOT_DIR, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: path.join(LOGS_DIR, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(LOGS_DIR, 'combined.log') })
    ]
});
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

export const DB_BASE = path.join(ROOT_DIR, 'database');
export const SYSTEM_DB_PATH = path.join(DB_BASE, 'system.db');
export const USERS_DIR = path.join(DB_BASE, 'users');
export const MEDIA_BASE = path.join(ROOT_DIR, 'media');
export const TEMP_DIR = path.join(ROOT_DIR, 'temp');
export const CLIP_CACHE_DIR = path.join(ROOT_DIR, 'models', 'clip');

[DB_BASE, USERS_DIR, MEDIA_BASE, TEMP_DIR, CLIP_CACHE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

export const CONFIG_PATH = path.join(DB_BASE, 'config.json');

export const CLIP_PRESETS = {
    small: 'Xenova/clip-vit-base-patch32',
    base16: 'Xenova/clip-vit-base-patch16',
    large: 'Xenova/clip-vit-large-patch14'
};

export const defaultAccessConfig = {
    port: parseInt(process.env.PORT, 10) || 3001,
    localhostOnly: false,
    registrationDisabled: false,
    language: DEFAULT_LANG || 'en',
    clipModel: 'small',
    clipQuantized: true,
    clipSearchMin: 0.23,
    clipSimilarMin: 0.70
};

export function clampClipSearchMin(v) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return defaultAccessConfig.clipSearchMin;
    return Math.min(0.6, Math.max(0.1, n));
}

export function clampClipSimilarMin(v) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return defaultAccessConfig.clipSimilarMin;
    return Math.min(0.99, Math.max(0.5, n));
}

export function normalizeClipModel(key) {
    if (key && CLIP_PRESETS[key]) return key;
    return 'small';
}

export function getClipModelId(cfg = accessConfig) {
    if (process.env.CLIP_MODEL) return process.env.CLIP_MODEL;
    const key = normalizeClipModel(cfg && cfg.clipModel);
    return CLIP_PRESETS[key] || CLIP_PRESETS.small;
}

export function getClipQuantized(cfg = accessConfig) {
    if (process.env.CLIP_QUANTIZED === '0') return false;
    if (process.env.CLIP_QUANTIZED === '1') return true;
    if (cfg && cfg.clipQuantized === false) return false;
    return true;
}

export function loadAccessConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const lang = typeof raw.language === 'string' && translations[raw.language] ? raw.language : defaultAccessConfig.language;
            return {
                port: Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : defaultAccessConfig.port,
                localhostOnly: !!raw.localhostOnly,
                registrationDisabled: !!raw.registrationDisabled,
                language: lang,
                clipModel: normalizeClipModel(raw.clipModel),
                clipQuantized: raw.clipQuantized === false ? false : true,
                clipSearchMin: clampClipSearchMin(raw.clipSearchMin),
                clipSimilarMin: clampClipSimilarMin(raw.clipSimilarMin)
            };
        }
    } catch (err) {
        logger.error(`Failed to load config: ${err.message}`);
    }
    return { ...defaultAccessConfig };
}

export function saveAccessConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

export let accessConfig = loadAccessConfig();

export function setAccessConfig(cfg) {
    accessConfig = cfg;
}

export function st(key, params = {}) {
    const lang = (accessConfig && accessConfig.language) || DEFAULT_LANG || 'en';
    const langData = translations[lang] || translations[DEFAULT_LANG] || translations.en || {};
    let message = langData[key] || (translations.en && translations.en[key]) || key;
    for (const [k, v] of Object.entries(params || {})) {
        message = message.replace(new RegExp(`\{${k}\}`, 'g'), String(v));
    }
    return message;
}

export function logInfo(keyOrMsg, params) {
    if (params !== undefined || (typeof keyOrMsg === 'string' && translations.en && translations.en[keyOrMsg])) {
        logger.info(st(keyOrMsg, params || {}));
    } else {
        logger.info(keyOrMsg);
    }
}

export function logError(keyOrMsg, params) {
    if (params !== undefined || (typeof keyOrMsg === 'string' && translations.en && translations.en[keyOrMsg])) {
        logger.error(st(keyOrMsg, params || {}));
    } else {
        logger.error(keyOrMsg);
    }
}

export function logWarn(keyOrMsg, params) {
    if (params !== undefined || (typeof keyOrMsg === 'string' && translations.en && translations.en[keyOrMsg])) {
        logger.warn(st(keyOrMsg, params || {}));
    } else {
        logger.warn(keyOrMsg);
    }
}

export function isLocalAddress(ip) {
    if (!ip) return false;
    const cleaned = String(ip).replace(/^::ffff:/i, '').toLowerCase();
    return cleaned === '127.0.0.1' || cleaned === '::1' || cleaned === 'localhost' || cleaned === '::ffff:127.0.0.1';
}

export function getClientIp(req) {
    return req.socket?.remoteAddress || req.ip || '';
}

export function getSessionSecret() {
    const secretsPath = path.join(DB_BASE, 'session.secret');
    try {
        if (fs.existsSync(secretsPath)) {
            const existing = fs.readFileSync(secretsPath, 'utf8').trim();
            if (existing.length >= 32) return existing;
        }
    } catch (e) {
        logger.warn(`Failed to read session secret: ${e.message}`);
    }
    const secret = crypto.randomBytes(48).toString('hex');
    try {
        fs.writeFileSync(secretsPath, secret, { encoding: 'utf8', mode: 0o600 });
        logger.info('Generated new session secret (database/session.secret)');
    } catch (e) {
        logger.error(`Failed to write session secret: ${e.message}`);
    }
    return secret;
}
