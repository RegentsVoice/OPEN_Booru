import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export async function createSqlJs() {
    const initSqlJs = (await import('sql.js')).default;
    const resolved = require.resolve('sql.js');
    const pkgRoot = resolved.includes(`${path.sep}dist${path.sep}`)
        ? path.dirname(path.dirname(resolved))
        : path.dirname(resolved);
    const distDir = path.join(pkgRoot, 'dist');
    const wasmPath = path.join(distDir, 'sql-wasm.wasm');

    if (!fs.existsSync(wasmPath)) {
        throw new Error(
            `sql.js wasm not found at ${wasmPath}. Run: npm install sql.js --force`
        );
    }
    const st = fs.statSync(wasmPath);
    if (st.size < 1000) {
        throw new Error(
            `sql.js wasm is empty/corrupt (${st.size} bytes) at ${wasmPath}. ` +
            `Delete node_modules and run: npm install`
        );
    }

    return initSqlJs({
        locateFile: (file) => path.join(distDir, file)
    });
}
