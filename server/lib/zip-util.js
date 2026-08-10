import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) {
            c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
    }
    return (~c) >>> 0;
}

function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n, 0);
    return b;
}
function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

export function createZipFromDir(rootDir, zipPath, prefix = '') {
    const files = [];
    function walk(dir, rel) {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const r = rel ? `${rel}/${name}` : name;
            const st = fs.statSync(full);
            if (st.isDirectory()) walk(full, r);
            else files.push({ full, name: r.replace(/\\/g, '/') });
        }
    }
    walk(rootDir, prefix);
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const f of files) {
        const data = fs.readFileSync(f.full);
        const nameBuf = Buffer.from(f.name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.concat([
            u32(0x04034b50),
            u16(20),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBuf.length),
            u16(0),
            nameBuf,
            data
        ]);
        const central = Buffer.concat([
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBuf.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(offset),
            nameBuf
        ]);
        localParts.push(local);
        centralParts.push(central);
        offset += local.length;
    }
    const centralBuf = Buffer.concat(centralParts);
    const end = Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(centralBuf.length),
        u32(offset),
        u16(0)
    ]);
    fs.writeFileSync(zipPath, Buffer.concat([...localParts, centralBuf, end]));
    return files.length;
}

export function extractZip(zipPath, destDir) {
    const buf = fs.readFileSync(zipPath);
    let o = 0;
    let count = 0;
    while (o + 30 <= buf.length) {
        const sig = buf.readUInt32LE(o);
        if (sig !== 0x04034b50) break;
        const method = buf.readUInt16LE(o + 8);
        const compSize = buf.readUInt32LE(o + 18);
        const uncompSize = buf.readUInt32LE(o + 22);
        const nameLen = buf.readUInt16LE(o + 26);
        const extraLen = buf.readUInt16LE(o + 28);
        const name = buf.slice(o + 30, o + 30 + nameLen).toString('utf8');
        const dataStart = o + 30 + nameLen + extraLen;
        let data = buf.slice(dataStart, dataStart + compSize);
        if (method === 8) {
            data = zlib.inflateRawSync(data);
        } else if (method !== 0) {
            throw new Error(`Unsupported zip method ${method} for ${name}`);
        }
        const out = path.join(destDir, name);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (!name.endsWith('/')) {
            fs.writeFileSync(out, data);
            count++;
        }
        o = dataStart + compSize;
    }
    return count;
}
