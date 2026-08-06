import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { logger } from '../config.js';

const MODEL_ID = process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32';

const QUANTIZED = process.env.CLIP_QUANTIZED !== '0';

let visionModel = null;
let processor = null;
let loadPromise = null;

export function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
}

export function embeddingToBase64(f32) {
    if (!f32 || !f32.length) return null;
    const buf = Buffer.from(new Float32Array(f32).buffer);
    return buf.toString('base64');
}

export function embeddingFromBase64(b64) {
    if (!b64) return null;
    try {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 16 || buf.length % 4 !== 0) return null;
        return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    } catch {
        return null;
    }
}

export function l2Normalize(vec) {
    let n = 0;
    for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
    n = Math.sqrt(n);
    if (n < 1e-12) return vec;
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
    return out;
}

export function averageEmbeddings(list) {
    const usable = (list || []).filter((v) => v && v.length);
    if (!usable.length) return null;
    const dim = usable[0].length;
    const acc = new Float32Array(dim);
    for (const v of usable) {
        if (v.length !== dim) continue;
        for (let i = 0; i < dim; i++) acc[i] += v[i];
    }
    for (let i = 0; i < dim; i++) acc[i] /= usable.length;
    return l2Normalize(acc);
}

async function ensureModel() {
    if (visionModel && processor) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        logger.info(`Loading CLIP model ${MODEL_ID} (quantized=${QUANTIZED})…`);
        const {
            AutoProcessor,
            CLIPVisionModelWithProjection,
            env
        } = await import('@xenova/transformers');

        env.allowLocalModels = true;
        env.useBrowserCache = false;

        processor = await AutoProcessor.from_pretrained(MODEL_ID);
        visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
            quantized: QUANTIZED
        });
        logger.info('CLIP model ready');
    })();
    try {
        await loadPromise;
    } catch (err) {
        loadPromise = null;
        throw err;
    }
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
                reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
                return;
            }
            resolve(Buffer.concat(chunks));
        });
        if (stdinBuf && proc.stdin) {
            proc.stdin.on('error', () => {});
            proc.stdin.end(stdinBuf);
        }
    });
}

async function bufferToTempJpeg(mediaBuf, label = 'img') {
    const tmp = path.join(os.tmpdir(), `clip-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-frames:v', '1',
        '-q:v', '2',
        '-y', tmp
    ];
    await runFfmpeg(args, mediaBuf, 60000);
    return tmp;
}

async function videoBufferToTempJpegs(mediaBuf, count = 6, duration = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-vid-'));
    const pattern = path.join(dir, 'f_%03d.jpg');

    let fps = 1;
    if (duration > 0 && duration < 30) {
        fps = Math.min(4, Math.max(0.5, count / Math.max(duration, 0.5)));
    } else if (duration > 0) {
        fps = count / duration;
    }
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vf', `fps=${fps},scale='min(512,iw)':-2`,
        '-frames:v', String(count),
        '-q:v', '3',
        '-y', pattern
    ];
    try {
        await runFfmpeg(args, mediaBuf, 300000);
    } catch (err) {
        logger.warn(`video frame extract failed: ${err.message}`);

        try {
            const one = path.join(dir, 'f_001.jpg');
            await runFfmpeg([
                '-hide_banner', '-loglevel', 'error',
                '-i', 'pipe:0',
                '-frames:v', '1',
                '-q:v', '3',
                '-y', one
            ], mediaBuf, 60000);
        } catch (_) {}
    }
    const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jpg'))
        .map((f) => path.join(dir, f))
        .sort();
    return { dir, files };
}

async function embedJpegPath(jpegPath) {
    await ensureModel();
    const { RawImage } = await import('@xenova/transformers');
    const image = await RawImage.read(jpegPath);
    const inputs = await processor(image);
    const { image_embeds } = await visionModel(inputs);

    const data = image_embeds.data;
    const dim = image_embeds.dims ? image_embeds.dims[image_embeds.dims.length - 1] : 512;
    const src = data instanceof Float32Array ? data : new Float32Array(data);
    const vec = src.length === dim ? src : src.slice(0, dim);
    return l2Normalize(vec);
}

export async function embedImageBuffer(mediaBuf) {
    let tmp = null;
    try {
        tmp = await bufferToTempJpeg(mediaBuf, 'still');
        return await embedJpegPath(tmp);
    } catch (err) {
        logger.warn(`embedImageBuffer: ${err.message}`);
        return null;
    } finally {
        if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

export async function embedVideoBuffer(mediaBuf, opts = {}) {
    const frameCount = opts.frameCount || 6;
    const duration = opts.duration || 0;
    let dir = null;
    try {
        const extracted = await videoBufferToTempJpegs(mediaBuf, frameCount, duration);
        dir = extracted.dir;
        if (!extracted.files.length) {

            return embedImageBuffer(mediaBuf);
        }
        const vectors = [];
        for (const f of extracted.files) {
            try {
                const v = await embedJpegPath(f);
                if (v) vectors.push(v);
            } catch (err) {
                logger.warn(`embed frame ${f}: ${err.message}`);
            }
        }
        return averageEmbeddings(vectors);
    } catch (err) {
        logger.warn(`embedVideoBuffer: ${err.message}`);
        return null;
    } finally {
        if (dir) {
            try {
                for (const f of fs.readdirSync(dir)) {
                    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
                }
                fs.rmdirSync(dir);
            } catch (_) {}
        }
    }
}

export async function preloadEmbedModel() {
    try {
        await ensureModel();
        return true;
    } catch (err) {
        logger.error(`CLIP preload failed: ${err.message}`);
        return false;
    }
}
