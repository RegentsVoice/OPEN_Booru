import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import { logger } from '../config.js';

const DHASH_W = 9;
const DHASH_H = 8;
const RAW_SIZE = DHASH_W * DHASH_H;

export function hammingDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let dist = 0;
    for (let i = 0; i < a.length; i += 2) {
        let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
        x = x - ((x >>> 1) & 0x55);
        x = (x & 0x33) + ((x >>> 2) & 0x33);
        dist += (((x + (x >>> 4)) & 0x0f) * 0x01) & 0xff;
    }
    return dist;
}

export function isLowInfoHash(hex) {
    if (!hex || hex.length < 16) return true;
    let ones = 0;
    for (let i = 0; i < hex.length; i++) {
        const n = parseInt(hex[i], 16);
        if (!Number.isFinite(n)) return true;
        ones += ((n >> 0) & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1);
    }
    if (ones < 8 || ones > 56) return true;
    if (hex.slice(0, 4) === hex.slice(4, 8) && hex.slice(0, 4) === hex.slice(8, 12)) return true;
    return false;
}

export function isLowVarianceGray(grayBuf) {
    if (!grayBuf || grayBuf.length < RAW_SIZE) return true;
    let min = 255, max = 0;
    for (let i = 0; i < RAW_SIZE; i++) {
        const v = grayBuf[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return max - min < 12;
}

export function bufferToDHash(grayBuf) {
    if (!grayBuf || grayBuf.length < RAW_SIZE) {
        throw new Error(`Expected ${RAW_SIZE} gray bytes, got ${grayBuf ? grayBuf.length : 0}`);
    }
    if (isLowVarianceGray(grayBuf)) return null;
    let bits = '';
    for (let y = 0; y < DHASH_H; y++) {
        for (let x = 0; x < DHASH_W - 1; x++) {
            const left = grayBuf[y * DHASH_W + x];
            const right = grayBuf[y * DHASH_W + x + 1];
            bits += left < right ? '1' : '0';
        }
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    if (isLowInfoHash(hex)) return null;
    return hex;
}

function runFfmpeg(args, stdinBuf = null, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const stdio = stdinBuf ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
        const proc = spawn('ffmpeg', args, { stdio });
        const chunks = [];
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            if (!settled) {
                settled = true;
                reject(new Error('ffmpeg timeout'));
            }
        }, timeoutMs);

        proc.stdout.on('data', (c) => chunks.push(c));
        proc.stderr.on('data', (c) => { stderr += c.toString(); });
        proc.on('error', (err) => {
            clearTimeout(timer);
            if (!settled) { settled = true; reject(err); }
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            if (code !== 0) {
                reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
                return;
            }
            resolve(Buffer.concat(chunks));
        });

        if (stdinBuf && proc.stdin) {
            proc.stdin.on('error', () => {  });
            proc.stdin.end(stdinBuf);
        }
    });
}

function writeTempMedia(buf) {
    const p = path.join(os.tmpdir(), `phash-in-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(p, buf);
    return p;
}

function probeDurationFromBuffer(buf) {
    return new Promise((resolve) => {
        const src = writeTempMedia(buf);
        const proc = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            '-i', src
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', (c) => { out += c.toString(); });
        const cleanup = () => { try { fs.unlinkSync(src); } catch (_) {} };
        proc.on('close', () => {
            cleanup();
            const d = parseFloat(out.trim());
            resolve(Number.isFinite(d) ? d : 0);
        });
        proc.on('error', () => {
            cleanup();
            resolve(0);
        });
    });
}

export async function dhashBuffer(mediaBuf, vfExtra = null) {
    const scale = `scale=${DHASH_W}:${DHASH_H}:flags=bilinear,format=gray`;
    const vf = vfExtra ? `${vfExtra},${scale}` : scale;
    const src = writeTempMedia(mediaBuf);
    try {
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-y',
            '-i', src,
            '-an',
            '-vf', vf,
            '-frames:v', '1',
            '-f', 'rawvideo',
            'pipe:1'
        ];
        const buf = await runFfmpeg(args, null);
        return bufferToDHash(buf);
    } finally {
        try { fs.unlinkSync(src); } catch (_) {}
    }
}

async function dhashBufferPermissive(mediaBuf, vfExtra = null) {
    const scale = `scale=${DHASH_W}:${DHASH_H}:flags=bilinear,format=gray`;
    const vf = vfExtra ? `${vfExtra},${scale}` : scale;
    const src = writeTempMedia(mediaBuf);
    try {
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-y',
            '-i', src,
            '-an',
            '-vf', vf,
            '-frames:v', '1',
            '-f', 'rawvideo',
            'pipe:1'
        ];
        const buf = await runFfmpeg(args, null);
        if (!buf || buf.length < RAW_SIZE) return null;

        let min = 255, max = 0;
        for (let i = 0; i < RAW_SIZE; i++) {
            const v = buf[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (max - min < 4) return null;

        let bits = '';
        for (let y = 0; y < DHASH_H; y++) {
            for (let x = 0; x < DHASH_W - 1; x++) {
                bits += buf[y * DHASH_W + x] < buf[y * DHASH_W + x + 1] ? '1' : '0';
            }
        }
        let hex = '';
        for (let i = 0; i < 64; i += 4) {
            hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
        }
        return hex;
    } finally {
        try { fs.unlinkSync(src); } catch (_) {}
    }
}

export async function dhashImageVariants(mediaBuf) {
    const variants = [];
    const tryOne = async (label, vf) => {
        try {
            const h = await dhashBufferPermissive(mediaBuf, vf);
            if (h) variants.push({ label, hash: h });
        } catch (err) {
            logger.warn(`image variant ${label}: ${err.message}`);
        }
    };

    await tryOne('full', null);

    for (const p of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
        const pct = Math.round(p * 100);
        await tryOne(
            `crop${pct}`,
            `crop=iw*${p}:ih*${p}:(iw-ow)/2:(ih-oh)/2`
        );
    }

    await tryOne('blur', 'gblur=sigma=1.5');

    await tryOne('norm', 'normalize');

    const seen = new Set();
    const unique = [];
    for (const v of variants) {
        if (seen.has(v.hash)) continue;
        seen.add(v.hash);
        unique.push(v);
    }
    return unique;
}

export async function dhashFile(filePath) {
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', filePath,
        '-vf', `scale=${DHASH_W}:${DHASH_H}:flags=bilinear,format=gray`,
        '-frames:v', '1',
        '-f', 'rawvideo',
        'pipe:1'
    ];
    const buf = await runFfmpeg(args);
    return bufferToDHash(buf) || '0000000000000000';
}

export async function mapPool(items, concurrency, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) break;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

export async function dhashVideoFramesBuffer(mediaBuf, opts = {}) {
    const intervalSec = opts.intervalSec ?? 3;
    const maxFrames = opts.maxFrames ?? 400;
    let duration = opts.duration || 0;

    if (!duration || duration <= 0) {
        duration = await probeDurationFromBuffer(mediaBuf);
    }

    const fps = 1 / Math.max(0.5, intervalSec);
    const src = writeTempMedia(mediaBuf);
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-y',
        '-i', src,
        '-an',
        '-vf', `fps=${fps},scale=${DHASH_W}:${DHASH_H}:flags=bilinear,format=gray`,
        '-frames:v', String(maxFrames),
        '-f', 'rawvideo',
        'pipe:1'
    ];

    let raw;
    try {
        raw = await runFfmpeg(args, null, 600000);
    } catch (err) {
        logger.warn(`dhash video pass failed: ${err.message}`);
        try {
            const h = await dhashBuffer(mediaBuf);
            return h && h !== '0000000000000000' ? [{ t: 0, hash: h }] : [];
        } catch {
            return [];
        }
    } finally {
        try { fs.unlinkSync(src); } catch (_) {}
    }

    const results = [];
    const frameCount = Math.floor(raw.length / RAW_SIZE);
    for (let i = 0; i < frameCount; i++) {
        const slice = raw.subarray(i * RAW_SIZE, (i + 1) * RAW_SIZE);
        const hash = bufferToDHash(slice);
        if (!hash) continue;
        const t = duration > 0
            ? Math.round(Math.min(i * intervalSec, duration) * 1000) / 1000
            : Math.round(i * intervalSec * 1000) / 1000;
        results.push({ t, hash });
    }
    return results;
}

export async function decryptToBuffer(containerPath, mediaOffset, fileSize, masterKey, iv) {
    const { createDecryptStreamWithOffset, createSkipStream } = await import('./crypto.js');

    return new Promise((resolve, reject) => {
        let ivBuf = Buffer.isBuffer(iv) ? iv : Buffer.from(iv || []);
        if (ivBuf.length !== 16) {
            reject(new Error('Invalid IV'));
            return;
        }
        const { decipher, skipBytes } = createDecryptStreamWithOffset(masterKey, ivBuf, 0);
        const skipStream = createSkipStream(skipBytes);
        const readStream = fs.createReadStream(containerPath, {
            start: mediaOffset,
            end: mediaOffset + fileSize - 1
        });
        const chunks = [];
        const pipeline = readStream.pipe(decipher).pipe(skipStream);
        pipeline.on('data', (c) => chunks.push(c));
        pipeline.on('end', () => resolve(Buffer.concat(chunks)));
        pipeline.on('error', reject);
        readStream.on('error', reject);
        decipher.on('error', reject);
    });
}

export async function decryptToTemp() {
    throw new Error('decryptToTemp removed — use decryptToBuffer (in-memory)');
}

export function bucketKey(hash, prefixLen = 4) {
    return (hash || '').slice(0, prefixLen);
}

export function medianDHash(hexList) {
    const usable = (hexList || []).filter((h) => h && h.length >= 16 && !isLowInfoHash(h));
    if (!usable.length) return null;
    if (usable.length === 1) return usable[0];

    const bitCounts = new Array(64).fill(0);
    for (const hex of usable) {
        for (let i = 0; i < 16; i++) {
            const n = parseInt(hex[i], 16);
            if (!Number.isFinite(n)) continue;
            for (let b = 0; b < 4; b++) {
                if (n & (8 >> b)) bitCounts[i * 4 + b]++;
            }
        }
    }
    const half = usable.length / 2;
    let bits = '';
    for (let i = 0; i < 64; i++) {
        bits += bitCounts[i] >= half ? '1' : '0';
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    if (isLowInfoHash(hex)) return usable[Math.floor(usable.length / 2)];
    return hex;
}

export function sampleEvenly(arr, limit) {
    if (!arr || !arr.length) return [];
    if (arr.length <= limit) return arr.slice();
    const out = [];
    for (let i = 0; i < limit; i++) {
        const idx = Math.round((i * (arr.length - 1)) / (limit - 1));
        out.push(arr[idx]);
    }
    return out;
}
