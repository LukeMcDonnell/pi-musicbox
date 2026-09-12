/**
 * Bundle the backend to ONE file: ../../backend/server.js
 *
 * Single-file output is the whole deployment story — the Pi gets a node binary
 * and this file, with no node_modules, no npm and no package-lock to drift.
 * That is only possible because nothing here needs a native module: MPD is
 * plain TCP, and BlueZ (later) is dbus-next, which is pure JS.
 *
 * Target is node20, matching Debian Trixie on the device, even though this
 * machine builds with a newer Node.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, '../../backend/server.js');
mkdirSync(dirname(outfile), { recursive: true });

// A human-readable build stamp, surfaced at /api/health so a deploy can be
// confirmed from the outside rather than assumed.
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

await build({
    entryPoints: [resolve(here, 'src/server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    minify: false, // readable stack traces matter more than bytes on a LAN appliance
    banner: {
        // Fastify's dependency tree still contains CommonJS that calls require();
        // ESM output has no require, so provide one built from this module's URL.
        js: [
            "import { createRequire as __mbCreateRequire } from 'node:module';",
            'const require = __mbCreateRequire(import.meta.url);',
        ].join('\n'),
    },
    define: {
        __MUSICBOX_BUILD__: JSON.stringify(stamp),
    },
    logLevel: 'info',
});

console.log(`built ${outfile}  (build ${stamp})`);
