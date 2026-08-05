import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Initialize sql.js with an explicit path to the .wasm file.
 * Avoids: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 00 00 00 00
 * (empty/corrupt wasm — often a bad npm install on Windows).
 */
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
