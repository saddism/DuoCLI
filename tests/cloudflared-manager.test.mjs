import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CloudflaredManager,
  CLOUDFLARED_USER_CONFIG_TEMPLATE,
  isCloudflaredConfigReady,
} from '../dist/main/cloudflared-manager.js';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-cf-'));
}

function withCleanCloudflaredEnv(fn) {
  const previous = process.env.DUOCLI_CLOUDFLARED_CONFIG;
  delete process.env.DUOCLI_CLOUDFLARED_CONFIG;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DUOCLI_CLOUDFLARED_CONFIG;
    else process.env.DUOCLI_CLOUDFLARED_CONFIG = previous;
  }
}

test('isCloudflaredConfigReady rejects official and example placeholders', () => {
  assert.equal(isCloudflaredConfigReady(''), false);
  assert.equal(isCloudflaredConfigReady(CLOUDFLARED_USER_CONFIG_TEMPLATE), false);
  assert.equal(isCloudflaredConfigReady('tunnel: your-tunnel-name\nhostname: your-domain.example.com\n'), false);
  assert.equal(isCloudflaredConfigReady([
    'tunnel: home-lab',
    'credentials-file: /Users/me/.cloudflared/abc.json',
    'ingress:',
    '  - hostname: cli.example.com',
    '    service: http://127.0.0.1:9800',
  ].join('\n')), true);
});

test('prepareUserConfig writes a local template without overwriting existing files', () => {
  withCleanCloudflaredEnv(() => {
    const root = makeTempRoot();
    const homeDir = path.join(root, 'home-config');
    const frpDir = path.join(root, 'frp');
    fs.mkdirSync(frpDir);
    const manager = new CloudflaredManager(root, {
      homeConfigPath: path.join(homeDir, 'config.yml'),
    });

    const created = manager.prepareUserConfig();
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(created.configReady, false);
    assert.equal(created.configPath, path.join(frpDir, 'cloudflared-config.local.yml'));
    assert.equal(fs.existsSync(created.configPath), true);
    assert.match(fs.readFileSync(created.configPath, 'utf-8'), /YOUR_TUNNEL_NAME/);

    fs.writeFileSync(created.configPath, 'tunnel: already-mine\ncredentials-file: /tmp/a.json\ningress:\n  - hostname: mine.example.com\n    service: http://127.0.0.1:9800\n');
    const again = manager.prepareUserConfig();
    assert.equal(again.ok, true);
    assert.equal(again.created, false);
    assert.equal(again.configReady, true);
    assert.match(fs.readFileSync(created.configPath, 'utf-8'), /already-mine/);

    const status = manager.getStatus();
    assert.equal(status.configExists, true);
    assert.equal(status.configReady, true);
    assert.equal(status.configPath, created.configPath);
  });
});

test('template-only repo config is ignored so GitHub users get a writable path', () => {
  withCleanCloudflaredEnv(() => {
    const root = makeTempRoot();
    const frpDir = path.join(root, 'frp');
    fs.mkdirSync(frpDir);
    fs.writeFileSync(path.join(frpDir, 'cloudflared-config.yml'), CLOUDFLARED_USER_CONFIG_TEMPLATE);
    const manager = new CloudflaredManager(root, {
      homeConfigPath: path.join(root, 'home', 'config.yml'),
    });

    const status = manager.getStatus();
    assert.equal(status.configExists, false);
    assert.equal(status.configReady, false);
    assert.equal(status.configPath, path.join(frpDir, 'cloudflared-config.local.yml'));
  });
});

test('prepareUserConfig falls back to home config when project frp is missing', () => {
  withCleanCloudflaredEnv(() => {
    const root = makeTempRoot();
    const homeConfigPath = path.join(root, 'home', 'config.yml');
    const manager = new CloudflaredManager(root, { homeConfigPath });

    const result = manager.prepareUserConfig();
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.configPath, homeConfigPath);
    assert.equal(manager.getStatus().configPath, homeConfigPath);
  });
});
