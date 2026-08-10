import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { logger, getClipModelId, getClipQuantized } from '../config.js';

let visionModel = null;
let textModel = null;
let tokenizer = null;
let processor = null;
let loadPromise = null;
let loadedModelId = null;
let loadedQuantized = null;

export function getLoadedClipInfo() {
    return {
        modelId: loadedModelId || getClipModelId(),
        quantized: loadedQuantized === null ? getClipQuantized() : loadedQuantized,
        ready: !!(visionModel && processor)
    };
}

export function unloadClipModel() {
    visionModel = null;
    textModel = null;
    tokenizer = null;
    processor = null;
    loadPromise = null;
    loadedModelId = null;
    loadedQuantized = null;
}

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
    const modelId = getClipModelId();
    const quantized = getClipQuantized();
    if (visionModel && processor && loadedModelId === modelId && loadedQuantized === quantized) return;
    if (loadPromise) return loadPromise;
    if (visionModel || processor) unloadClipModel();
    loadPromise = (async () => {
        logger.info(`Loading CLIP model ${modelId} (quantized=${quantized})…`);
        const {
            AutoProcessor,
            AutoTokenizer,
            CLIPVisionModelWithProjection,
            CLIPTextModelWithProjection,
            env
        } = await import('@xenova/transformers');

        env.allowLocalModels = true;
        env.useBrowserCache = false;
        const { CLIP_CACHE_DIR } = await import('../config.js');
        env.cacheDir = process.env.TRANSFORMERS_CACHE || CLIP_CACHE_DIR;

        processor = await AutoProcessor.from_pretrained(modelId);
        tokenizer = await AutoTokenizer.from_pretrained(modelId);
        visionModel = await CLIPVisionModelWithProjection.from_pretrained(modelId, {
            quantized
        });
        textModel = await CLIPTextModelWithProjection.from_pretrained(modelId, {
            quantized
        });
        loadedModelId = modelId;
        loadedQuantized = quantized;
        logger.info('CLIP model ready');
    })();
    try {
        await loadPromise;
    } catch (err) {
        loadPromise = null;
        loadedModelId = null;
        loadedQuantized = null;
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

function writeTempInput(mediaBuf, ext = 'bin') {
    const p = path.join(os.tmpdir(), `clip-in-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(p, mediaBuf);
    return p;
}

async function bufferToTempJpeg(mediaBuf, label = 'img') {
    const tmp = path.join(os.tmpdir(), `clip-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    const src = writeTempInput(mediaBuf);
    try {
        try {
            await runFfmpeg([
                '-hide_banner', '-loglevel', 'error',
                '-y',
                '-i', src,
                '-an',
                '-frames:v', '1',
                '-vf', 'scale=512:-2',
                '-q:v', '2',
                tmp
            ], null, 60000);
        } catch (_) {
            await runFfmpeg([
                '-hide_banner', '-loglevel', 'error',
                '-y',
                '-i', src,
                '-an',
                '-frames:v', '1',
                '-q:v', '2',
                tmp
            ], null, 60000);
        }
        return tmp;
    } finally {
        try { fs.unlinkSync(src); } catch (_) {}
    }
}

async function videoBufferToTempJpegs(mediaBuf, count = 6, duration = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-vid-'));
    const src = writeTempInput(mediaBuf);
    const n = Math.max(1, Math.min(count || 6, 12));
    const files = [];

    try {
        const times = [];
        if (duration > 0.5) {
            for (let i = 0; i < n; i++) {
                const t = ((i + 0.5) / n) * duration;
                times.push(Math.max(0, Math.min(duration - 0.05, t)));
            }
        } else {
            times.push(0);
        }

        for (let i = 0; i < times.length; i++) {
            const out = path.join(dir, `frame-${i + 1}.jpg`);
            const t = times[i];
            const args = [
                '-hide_banner', '-loglevel', 'error',
                '-y',
                '-ss', String(Math.max(0, t)),
                '-i', src,
                '-an',
                '-frames:v', '1',
                '-vf', 'scale=512:-2',
                '-q:v', '3',
                out
            ];
            try {
                await runFfmpeg(args, null, 90000);
                if (fs.existsSync(out) && fs.statSync(out).size > 32) {
                    files.push(out);
                }
            } catch (err) {
                if (i === 0) {
                    try {
                        await runFfmpeg([
                            '-hide_banner', '-loglevel', 'error',
                            '-y',
                            '-i', src,
                            '-an',
                            '-frames:v', '1',
                            '-q:v', '3',
                            out
                        ], null, 90000);
                        if (fs.existsSync(out) && fs.statSync(out).size > 32) {
                            files.push(out);
                        }
                    } catch (err2) {
                        logger.warn(`video frame extract failed: ${err2.message}`);
                    }
                }
            }
        }
    } finally {
        try { fs.unlinkSync(src); } catch (_) {}
    }
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

export async function embedText(text) {
    const q = String(text || '').trim();
    if (!q) return null;
    try {
        await ensureModel();
        const inputs = tokenizer([q], { padding: true, truncation: true });
        const { text_embeds } = await textModel(inputs);
        const data = text_embeds.data;
        const dim = text_embeds.dims ? text_embeds.dims[text_embeds.dims.length - 1] : 512;
        const src = data instanceof Float32Array ? data : new Float32Array(data);
        const vec = src.length === dim ? src : src.slice(0, dim);
        return l2Normalize(vec);
    } catch (err) {
        logger.warn(`embedText: ${err.message}`);
        return null;
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
