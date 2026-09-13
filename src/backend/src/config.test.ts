/**
 * Config precedence: environment > conf file > defaults.
 *
 * The env override is what lets a backend running on the dev machine point at
 * the Pi's MPD without editing anything, so it is worth pinning down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, parseConf } from './config.ts';

function confFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'musicbox-conf-'));
    const path = join(dir, 'server.conf');
    writeFileSync(path, contents);
    return path;
}

test('parses shell-style assignments and ignores the rest', () => {
    const parsed = parseConf(
        [
            '# a comment',
            '',
            'MUSICBOX_PORT=8080',
            'MUSICBOX_MPD_HOST="192.168.1.91"',
            "MUSICBOX_LOG_LEVEL='debug'",
            'not an assignment',
            '=novalue',
            '1BAD=x',
        ].join('\n'),
    );
    assert.equal(parsed.MUSICBOX_PORT, '8080');
    assert.equal(parsed.MUSICBOX_MPD_HOST, '192.168.1.91');
    assert.equal(parsed.MUSICBOX_LOG_LEVEL, 'debug');
    assert.equal(parsed['1BAD'], undefined);
});

test('does not expand or execute anything', () => {
    const parsed = parseConf('MUSICBOX_WEB_ROOT="$(rm -rf /)"');
    assert.equal(parsed.MUSICBOX_WEB_ROOT, '$(rm -rf /)');
});

test('a missing conf file falls back to defaults rather than throwing', () => {
    const config = loadConfig('/nonexistent/musicbox/server.conf', {});
    assert.deepEqual(config, DEFAULTS);
});

test('conf file overrides defaults', () => {
    const path = confFile('MUSICBOX_PORT=8080\nMUSICBOX_MPD_HOST=nas.local\n');
    const config = loadConfig(path, {});
    assert.equal(config.port, 8080);
    assert.equal(config.mpdHost, 'nas.local');
    assert.equal(config.mpdPort, DEFAULTS.mpdPort);
});

test('environment beats the conf file — this is what the dev loop relies on', () => {
    const path = confFile('MUSICBOX_MPD_HOST=127.0.0.1\nMUSICBOX_PORT=80\n');
    const config = loadConfig(path, {
        MUSICBOX_MPD_HOST: '192.168.1.91',
        MUSICBOX_PORT: '8080',
    });
    assert.equal(config.mpdHost, '192.168.1.91');
    assert.equal(config.port, 8080);
});

test('nonsense numbers fall back rather than producing NaN', () => {
    const config = loadConfig('/nonexistent', { MUSICBOX_PORT: 'eighty' });
    assert.equal(config.port, DEFAULTS.port);
});

test('the default port is 80 so the URL needs no suffix', () => {
    assert.equal(DEFAULTS.port, 80);
});

test('the bluetooth state path is configurable and defaults under /run', () => {
    /*
     * /run is a tmpfs, which is the point: the arbiter's view of which phone is
     * connected is true only for this boot, and a stale file surviving a reboot
     * would have the UI announcing a device that is not there.
     *
     * Overridable so a dev backend can be pointed at a fixture without root.
     */
    assert.equal(DEFAULTS.bluetoothState, '/run/musicbox/bluetooth.json');
    const config = loadConfig('/nonexistent', { MUSICBOX_BLUETOOTH_STATE: '/tmp/fake-bt.json' });
    assert.equal(config.bluetoothState, '/tmp/fake-bt.json');
});
