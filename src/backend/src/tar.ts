/**
 * A ustar writer and reader for regular files — enough for a backup, and
 * readable by tar(1). Anything that is not a plain file or directory is refused.
 */

export interface TarEntry {
    name: string;
    data: Buffer;
}

const BLOCK = 512;

export class TarError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TarError';
    }
}

function octal(value: number, width: number): string {
    return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** Split a name into ustar's prefix and name fields, or throw if it cannot fit. */
function splitName(name: string): [prefix: string, name: string] {
    if (Buffer.byteLength(name) <= 100) return ['', name];
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
        const prefix = name.slice(0, i);
        const rest = name.slice(i + 1);
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return [prefix, rest];
    }
    throw new TarError(`name too long for ustar: ${name}`);
}

function header(entry: TarEntry, mtime: number): Buffer {
    const block = Buffer.alloc(BLOCK);
    const [prefix, name] = splitName(entry.name);
    block.write(name, 0, 100);
    block.write(octal(0o644, 8), 100);
    block.write(octal(0, 8), 108);
    block.write(octal(0, 8), 116);
    block.write(octal(entry.data.length, 12), 124);
    block.write(octal(mtime, 12), 136);
    block.write('        ', 148);
    block.write('0', 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    block.write(prefix, 345, 155);
    block.write(octal(checksum(block), 7) + ' ', 148);
    return block;
}

function checksum(block: Buffer): number {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
    return sum;
}

export function packTar(entries: readonly TarEntry[], mtime: number = Math.floor(Date.now() / 1000)): Buffer {
    const parts: Buffer[] = [];
    for (const entry of entries) {
        parts.push(header(entry, mtime), entry.data);
        const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
        if (pad) parts.push(Buffer.alloc(pad));
    }
    parts.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(parts);
}

function field(block: Buffer, start: number, length: number): string {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function readOctal(block: Buffer, start: number, length: number): number {
    const text = field(block, start, length).trim();
    if (!/^[0-7]+$/.test(text)) throw new TarError('malformed numeric field');
    return Number.parseInt(text, 8);
}

/** A relative path with no `..`, or throw. Leading `./` is tolerated, as tar(1) writes it. */
function cleanName(raw: string): string {
    const name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (name === '' || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '')) {
        throw new TarError(`unsafe member name: ${raw}`);
    }
    return name;
}

/** Every regular file in the archive. Directory entries are skipped; anything else throws. */
export function unpackTar(archive: Buffer): TarEntry[] {
    const entries: TarEntry[] = [];
    let offset = 0;
    while (offset + BLOCK <= archive.length) {
        const block = archive.subarray(offset, offset + BLOCK);
        if (block.every((byte) => byte === 0)) return entries;

        const magic = field(block, 257, 6).trim();
        if (magic !== 'ustar') throw new TarError('not a ustar archive');
        if (readOctal(block, 148, 8) !== checksum(block)) throw new TarError('header checksum mismatch');

        const size = readOctal(block, 124, 12);
        const type = String.fromCharCode(block[156]!);
        offset += BLOCK;
        // Nothing is created from a directory entry, so its name is never used.
        if (type === '5') {
            offset += Math.ceil(size / BLOCK) * BLOCK;
            continue;
        }

        const prefix = field(block, 345, 155);
        const name = cleanName(prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
        if (type !== '0' && type !== '\0') throw new TarError(`not a regular file: ${name}`);
        if (offset + size > archive.length) throw new TarError(`truncated member: ${name}`);

        entries.push({ name, data: Buffer.from(archive.subarray(offset, offset + size)) });
        offset += Math.ceil(size / BLOCK) * BLOCK;
    }
    throw new TarError('archive ends without an end-of-archive marker');
}
