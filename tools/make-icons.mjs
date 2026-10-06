#!/usr/bin/env node
// Regenerates the PWA icons and favicon in src/frontend/public/. Dev machine
// only: rasterises with headless Chrome, so it needs google-chrome on PATH.
//
//   node tools/make-icons.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'frontend', 'public');
const CHROME = process.env.CHROME ?? 'google-chrome';

// The glyph sits inside the maskable safe zone (a centred circle, 80% across).
const NOTES = `
  <g fill="#1a1413">
    <ellipse cx="190" cy="344" rx="48" ry="35" transform="rotate(-22 190 344)"/>
    <ellipse cx="342" cy="312" rx="48" ry="35" transform="rotate(-22 342 312)"/>
    <rect x="216" y="160" width="20" height="176"/>
    <rect x="368" y="128" width="20" height="176"/>
    <polygon points="216,150 388,118 388,164 216,196"/>
  </g>`;

function svg({ rounded }) {
    const radius = rounded ? 112 : 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f29a70"/>
      <stop offset="1" stop-color="#cf6340"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${radius}" fill="url(#g)"/>
  <g transform="translate(-14 6)">${NOTES}
  </g>
</svg>
`;
}

const work = mkdtempSync(join(tmpdir(), 'musicbox-icons-'));

function render(source, size) {
    const page = join(work, 'page.html');
    const png = join(work, `${size}.png`);
    writeFileSync(
        page,
        `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
    );
    execFileSync(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--default-background-color=00000000', `--window-size=${size},${size}`,
        `--screenshot=${png}`, `file://${page}`,
    ], { stdio: 'ignore' });
    return readFileSync(png);
}

// An ICO may hold PNGs verbatim: a 6-byte header, 16 bytes per entry, then the images.
function ico(images) {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, i) => {
        const at = 6 + 16 * i;
        header.writeUInt8(size, at);
        header.writeUInt8(size, at + 1);
        header.writeUInt16LE(1, at + 4);
        header.writeUInt16LE(32, at + 6);
        header.writeUInt32LE(png.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...images.map((i) => i.png)]);
}

try {
    const rounded = svg({ rounded: true });
    const bleed = svg({ rounded: false });

    writeFileSync(join(OUT, 'icon.svg'), rounded);
    writeFileSync(join(OUT, 'icon-192.png'), render(rounded, 192));
    writeFileSync(join(OUT, 'icon-512.png'), render(rounded, 512));
    writeFileSync(join(OUT, 'icon-maskable-512.png'), render(bleed, 512));
    writeFileSync(join(OUT, 'apple-touch-icon.png'), render(bleed, 180));
    writeFileSync(join(OUT, 'favicon.ico'), ico([16, 32, 48].map((size) => ({ size, png: render(rounded, size) }))));
    console.log(`icons written to ${OUT}`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
