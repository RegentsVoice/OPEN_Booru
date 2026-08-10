import fs from 'fs';
import path from 'path';
import { logger, CLIP_PRESETS, CLIP_CACHE_DIR } from '../config.js';

const installJobs = new Map();

export function getHubCacheDir() {
    if (process.env.TRANSFORMERS_CACHE) {
        return process.env.TRANSFORMERS_CACHE;
    }
    if (process.env.HF_HOME) {
        return path.join(process.env.HF_HOME, 'hub');
    }
    return CLIP_CACHE_DIR;
}

function modelDirName(modelId) {
    return 'models--' + String(modelId).replace(/\//g, '--');
}

function possibleModelDirs(hub, modelId) {
    const dirs = [];
    dirs.push(path.join(hub, modelDirName(modelId)));
    dirs.push(path.join(hub, modelId));
    dirs.push(path.join(hub, ...String(modelId).split('/')));
    const seen = new Set();
    return dirs.filter((d) => {
        const r = path.resolve(d);
        if (seen.has(r)) return false;
        seen.add(r);
        return true;
    });
}

function walkFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return out; }
    for (const name of entries) {
        const p = path.join(dir, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walkFiles(p, out);
        else if (st.isFile()) out.push(p);
    }
    return out;
}

function collectModelFiles(hub, modelId) {
    const files = [];
    for (const dir of possibleModelDirs(hub, modelId)) {
        if (fs.existsSync(dir)) walkFiles(dir, files);
    }
    return files;
}

function isOnnx(filePath) {
    return /\.onnx$/i.test(filePath);
}

function isQuantizedFile(filePath) {
    const base = path.basename(filePath);
    return /quantized/i.test(base);
}

function variantFiles(hub, modelId, quantized) {
    const all = collectModelFiles(hub, modelId).filter(isOnnx);
    if (!all.length) return [];
    if (quantized) {
        const q = all.filter(isQuantizedFile);
        if (q.length) return q;
        return [];
    }
    const full = all.filter((f) => !isQuantizedFile(f));
    return full;
}

function hasAnyModelFiles(hub, modelId) {
    const files = collectModelFiles(hub, modelId);
    return files.some((f) => isOnnx(f) || /config\.json$/i.test(f) || /preprocessor/i.test(path.basename(f)));
}

function sumSizes(files) {
    let total = 0;
    for (const f of files) {
        try { total += fs.statSync(f).size; } catch { /* */ }
    }
    return total;
}

function formatBytes(n) {
    if (!n || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function primaryModelDir(hub, modelId) {
    for (const dir of possibleModelDirs(hub, modelId)) {
        if (fs.existsSync(dir)) return dir;
    }
    return path.join(hub, modelDirName(modelId));
}

export function listClipModels() {
    const hub = getHubCacheDir();
    if (!fs.existsSync(hub)) {
        try { fs.mkdirSync(hub, { recursive: true }); } catch { /* */ }
    }
    const out = [];
    for (const key of Object.keys(CLIP_PRESETS)) {
        const modelId = CLIP_PRESETS[key];
        for (const quantized of [true, false]) {
            let files = variantFiles(hub, modelId, quantized);
            let installed = files.length > 0;
            if (!installed && quantized) {
                const allOnnx = collectModelFiles(hub, modelId).filter(isOnnx);
                if (allOnnx.length && !allOnnx.some(isQuantizedFile)) {
                    installed = false;
                } else if (allOnnx.length && allOnnx.every(isQuantizedFile)) {
                    files = allOnnx;
                    installed = true;
                }
            }
            if (!installed && !quantized) {
                const allOnnx = collectModelFiles(hub, modelId).filter(isOnnx);
                if (allOnnx.length && !allOnnx.some(isQuantizedFile)) {
                    files = allOnnx;
                    installed = true;
                }
            }
            if (!installed) {
                const any = hasAnyModelFiles(hub, modelId);
                if (any) {
                    const allOnnx = collectModelFiles(hub, modelId).filter(isOnnx);
                    if (allOnnx.length) {
                        const qFiles = allOnnx.filter(isQuantizedFile);
                        const fFiles = allOnnx.filter((f) => !isQuantizedFile(f));
                        if (quantized && qFiles.length) {
                            files = qFiles;
                            installed = true;
                        } else if (!quantized && fFiles.length) {
                            files = fFiles;
                            installed = true;
                        } else if (quantized && !fFiles.length && allOnnx.length) {
                            files = allOnnx;
                            installed = true;
                        }
                    }
                }
            }
            const size = installed ? sumSizes(files) : 0;
            out.push({
                key,
                quantized,
                id: `${key}:${quantized ? 'q' : 'fp32'}`,
                modelId,
                installed,
                sizeBytes: size,
                sizeLabel: formatBytes(size),
                path: installed ? primaryModelDir(hub, modelId) : null,
                repoUrl: `https://huggingface.co/${modelId}`,
                filesUrl: `https://huggingface.co/${modelId}/tree/main`
            });
        }
    }
    return { hubCacheDir: hub, models: out };
}

function jobKey(key, quantized) {
    return `${key}:${quantized ? 'q' : 'fp32'}`;
}

export function getInstallJob(key, quantized) {
    return installJobs.get(jobKey(key, quantized)) || null;
}

export function cancelInstallJob(key, quantized) {
    const jk = jobKey(key, quantized);
    const job = installJobs.get(jk);
    if (!job || job.status !== 'running') {
        return { cancelled: false, job: job || null };
    }
    job.cancelRequested = true;
    job.status = 'cancelled';
    job.message = 'Cancelled';
    job.error = 'Cancelled';
    return { cancelled: true, job };
}

export function listInstallJobs() {
    return [...installJobs.values()];
}

export async function installClipModel(key, { quantized = true } = {}) {
    const modelId = CLIP_PRESETS[key];
    if (!modelId) throw new Error('Unknown CLIP preset');

    const jk = jobKey(key, quantized);
    const existing = installJobs.get(jk);
    if (existing && existing.status === 'running') {
        return existing;
    }

    const cacheDir = getHubCacheDir();
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const job = {
        key,
        quantized: !!quantized,
        modelId,
        status: 'running',
        progress: 0,
        file: '',
        message: 'Starting…',
        error: null,
        startedAt: Date.now()
    };
    installJobs.set(jk, job);

    logger.info(`Installing CLIP model ${modelId} (quantized=${quantized}) → ${cacheDir}`);

    try {
        const {
            AutoProcessor,
            CLIPVisionModelWithProjection,
            env
        } = await import('@xenova/transformers');

        env.allowLocalModels = true;
        env.useBrowserCache = false;
        env.cacheDir = cacheDir;

        const onProgress = (p) => {
            try {
                if (job.cancelRequested) throw new Error('Cancelled');
                if (!p || typeof p !== 'object') return;
                if (p.status === 'progress' || p.status === 'download') {
                    const loaded = p.loaded ?? p.progress ?? 0;
                    const total = p.total || 0;
                    let pct = 0;
                    if (typeof p.progress === 'number' && p.progress <= 1) {
                        pct = Math.round(p.progress * 100);
                    } else if (total > 0) {
                        pct = Math.round((loaded / total) * 100);
                    } else if (typeof p.progress === 'number') {
                        pct = Math.min(99, Math.round(p.progress));
                    }
                    job.progress = Math.max(job.progress, Math.min(99, pct));
                    job.file = p.file || p.name || job.file || '';
                    job.message = job.file
                        ? `${job.file} ${job.progress}%`
                        : `Downloading… ${job.progress}%`;
                } else if (p.status === 'done' || p.status === 'ready') {
                    job.message = p.file ? `Done: ${p.file}` : 'Processing…';
                } else if (p.status === 'initiate') {
                    job.file = p.file || p.name || '';
                    job.message = job.file ? `Starting ${job.file}` : 'Starting…';
                }
            } catch { /* */ }
        };

        if (job.cancelRequested) throw new Error('Cancelled');
        job.message = 'Loading processor…';
        await AutoProcessor.from_pretrained(modelId, { progress_callback: onProgress });
        if (job.cancelRequested) throw new Error('Cancelled');
        job.message = 'Loading vision model…';
        await CLIPVisionModelWithProjection.from_pretrained(modelId, {
            quantized: !!quantized,
            progress_callback: onProgress
        });
        if (job.cancelRequested) throw new Error('Cancelled');

        job.progress = 100;
        job.status = 'done';
        job.message = 'Installed';
        const info = listClipModels().models.find(
            (m) => m.key === key && m.quantized === !!quantized
        );
        logger.info(`CLIP model installed: ${modelId} q=${quantized} (${info?.sizeLabel || '?'})`);
        job.model = info;
        return job;
    } catch (err) {
        const msg = err.message || String(err);
        if (job.cancelRequested || /cancel/i.test(msg)) {
            job.status = 'cancelled';
            job.error = 'Cancelled';
            job.message = 'Cancelled';
            logger.info(`CLIP install cancelled: ${modelId} q=${quantized}`);
            return job;
        }
        job.status = 'error';
        job.error = msg;
        job.message = job.error;
        logger.error(`CLIP install failed: ${job.error}`);
        throw err;
    }
}

export function deleteClipModel(key, { quantized = true } = {}) {
    const modelId = CLIP_PRESETS[key];
    if (!modelId) throw new Error('Unknown CLIP preset');
    const hub = getHubCacheDir();

    const targets = variantFiles(hub, modelId, !!quantized);
    if (!targets.length) {
        const allOnnx = collectModelFiles(hub, modelId).filter(isOnnx);
        if (!!quantized && allOnnx.length && allOnnx.every(isQuantizedFile)) {
            for (const f of allOnnx) {
                try { fs.unlinkSync(f); } catch { /* */ }
            }
        } else if (!quantized && allOnnx.length && !allOnnx.some(isQuantizedFile)) {
            for (const f of allOnnx) {
                try { fs.unlinkSync(f); } catch { /* */ }
            }
        } else {
            return { deleted: false, modelId, quantized: !!quantized, message: 'Variant not installed' };
        }
    } else {
        for (const f of targets) {
            try { fs.unlinkSync(f); } catch (err) {
                logger.warn(`Failed to delete ${f}: ${err.message}`);
            }
        }
    }

    for (const dir of possibleModelDirs(hub, modelId)) {
        if (!fs.existsSync(dir)) continue;
        const remainingOnnx = walkFiles(dir).filter(isOnnx);
        if (!remainingOnnx.length) {
            const resolved = path.resolve(dir);
            const hubResolved = path.resolve(hub);
            if (resolved.startsWith(hubResolved + path.sep) || resolved === hubResolved) {
                try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* */ }
            }
        }
    }

    logger.info(`Deleted CLIP variant: ${modelId} q=${!!quantized}`);
    return { deleted: true, modelId, quantized: !!quantized };
}
