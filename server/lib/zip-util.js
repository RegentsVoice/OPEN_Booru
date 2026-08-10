import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function walkFiles(rootDir, prefix = '') {
    const files = [];
    function walk(dir, rel) {
        let names;
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            const full = path.join(dir, name);
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            const r = rel ? `${rel}/${name}` : name;
            if (st.isDirectory()) walk(full, r);
            else files.push({ full, name: r.replace(/\\/g, '/'), size: st.size });
        }
    }
    walk(rootDir, prefix);
    return files;
}

function linkOrCopy(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch (_) {}
    try {
        fs.linkSync(src, dest);
        return;
    } catch (_) {}
    fs.copyFileSync(src, dest);
}

export function stageUserExport({ dbSrc, mediaSrc, meta, staging }) {
    const dbDest = path.join(staging, 'db');
    const mediaDest = path.join(staging, 'media');
    fs.mkdirSync(dbDest, { recursive: true });
    fs.mkdirSync(mediaDest, { recursive: true });
    for (const f of ['main.db', 'tags.db', 'previews.db', 'master.key.enc']) {
        const p = path.join(dbSrc, f);
        if (fs.existsSync(p)) linkOrCopy(p, path.join(dbDest, f));
    }
    if (mediaSrc && fs.existsSync(mediaSrc)) {
        for (const name of fs.readdirSync(mediaSrc)) {
            const full = path.join(mediaSrc, name);
            try {
                if (fs.statSync(full).isFile()) linkOrCopy(full, path.join(mediaDest, name));
            } catch (_) {}
        }
    }
    fs.writeFileSync(path.join(staging, 'meta.json'), JSON.stringify(meta, null, 2));
}

export function createArchiveFromDir(rootDir, outPath) {
    const args = ['-cf', outPath, '-C', rootDir, '.'];
    const r = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error) throw new Error(`tar not available: ${r.error.message}`);
    if (r.status !== 0) {
        const err = (r.stderr || r.stdout || 'tar failed').toString().trim();
        throw new Error(err || `tar exit ${r.status}`);
    }
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size <= 0) {
        throw new Error('tar produced empty archive');
    }
    return walkFiles(rootDir).length;
}

export function extractArchive(archivePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const lower = archivePath.toLowerCase();
    if (lower.endsWith('.zip')) {
        return extractZipStreaming(archivePath, destDir);
    }
    const r = spawnSync('tar', ['-xf', archivePath, '-C', destDir], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024
    });
    if (r.error) throw new Error(`tar not available: ${r.error.message}`);
    if (r.status !== 0) {
        const err = (r.stderr || r.stdout || 'tar extract failed').toString().trim();
        throw new Error(err || `tar exit ${r.status}`);
    }
    return walkFiles(destDir).length;
}

function crc32Update(c, buf) {
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) {
            c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
    }
    return c;
}

function crc32File(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    let c = ~0;
    try {
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
            c = crc32Update(c, buf.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
    return (~c) >>> 0;
}

function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n >>> 0, 0);
    return b;
}
function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

export function createZipFromDir(rootDir, zipPath, prefix = '') {
    const files = walkFiles(rootDir, prefix);
    const out = fs.openSync(zipPath, 'w');
    const central = [];
    let offset = 0;
    try {
        for (const f of files) {
            if (f.size > 0xFFFFFFFF) {
                throw new Error(`File too large for ZIP without ZIP64: ${f.name}`);
            }
            const nameBuf = Buffer.from(f.name, 'utf8');
            const crc = crc32File(f.full);
            const size = f.size >>> 0;
            const localHeader = Buffer.concat([
                u32(0x04034b50),
                u16(20),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32(crc),
                u32(size),
                u32(size),
                u16(nameBuf.length),
                u16(0),
                nameBuf
            ]);
            fs.writeSync(out, localHeader);
            const fd = fs.openSync(f.full, 'r');
            try {
                const buf = Buffer.alloc(1024 * 1024);
                let n;
                while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
                    fs.writeSync(out, buf, 0, n);
                }
            } finally {
                fs.closeSync(fd);
            }
            central.push(Buffer.concat([
                u32(0x02014b50),
                u16(20),
                u16(20),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32(crc),
                u32(size),
                u32(size),
                u16(nameBuf.length),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32(0),
                u32(offset >>> 0),
                nameBuf
            ]));
            offset += localHeader.length + f.size;
            if (offset > 0xFFFFFFFF) {
                throw new Error('Archive too large for standard ZIP; use tar export');
            }
        }
        const centralStart = offset;
        for (const part of central) fs.writeSync(out, part);
        const centralSize = offset - centralStart + central.reduce((s, b) => s + b.length, 0) - (offset - centralStart);
        let centralLen = 0;
        for (const part of central) centralLen += part.length;
        const end = Buffer.concat([
            u32(0x06054b50),
            u16(0),
            u16(0),
            u16(files.length),
            u16(files.length),
            u32(centralLen),
            u32(centralStart >>> 0),
            u16(0)
        ]);
        fs.writeSync(out, end);
    } finally {
        fs.closeSync(out);
    }
    return files.length;
}

function extractZipStreaming(zipPath, destDir) {
    const fd = fs.openSync(zipPath, 'r');
    let count = 0;
    try {
        const header = Buffer.alloc(30);
        let pos = 0;
        const size = fs.fstatSync(fd).size;
        while (pos + 30 <= size) {
            fs.readSync(fd, header, 0, 30, pos);
            const sig = header.readUInt32LE(0);
            if (sig !== 0x04034b50) break;
            const method = header.readUInt16LE(8);
            const compSize = header.readUInt32LE(18);
            const nameLen = header.readUInt16LE(26);
            const extraLen = header.readUInt16LE(28);
            const nameBuf = Buffer.alloc(nameLen);
            fs.readSync(fd, nameBuf, 0, nameLen, pos + 30);
            const name = nameBuf.toString('utf8');
            const dataStart = pos + 30 + nameLen + extraLen;
            if (method !== 0) {
                throw new Error(`Unsupported zip method ${method} for ${name}`);
            }
            const out = path.join(destDir, name);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            if (!name.endsWith('/')) {
                const outFd = fs.openSync(out, 'w');
                try {
                    let left = compSize;
                    const buf = Buffer.alloc(1024 * 1024);
                    let readPos = dataStart;
                    while (left > 0) {
                        const chunk = Math.min(left, buf.length);
                        const n = fs.readSync(fd, buf, 0, chunk, readPos);
                        if (n <= 0) break;
                        fs.writeSync(outFd, buf, 0, n);
                        readPos += n;
                        left -= n;
                    }
                } finally {
                    fs.closeSync(outFd);
                }
                count++;
            }
            pos = dataStart + compSize;
        }
    } finally {
        fs.closeSync(fd);
    }
    return count;
}

export function extractZip(zipPath, destDir) {
    return extractZipStreaming(zipPath, destDir);
}
