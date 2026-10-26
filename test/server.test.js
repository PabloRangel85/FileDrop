const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');
const { createApp } = require('../server');

let dataDir;
let instance;
let server;
let baseUrl;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filedrop-test-'));
  instance = createApp({ dataDir, maxFileSize: 1024 });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  instance.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function uploadTransfer(fields = {}) {
  const form = new FormData();
  form.append('file', new Blob(['hello FileDrop']), 'hello.txt');
  for (const [key, value] of Object.entries({ expirationType: 'downloads', maxDownloads: '1', ...fields })) {
    form.append(key, value);
  }
  return fetch(`${baseUrl}/api/transfers`, { method: 'POST', body: form });
}

test('uploads a file and permits only the configured number of downloads', async () => {
  const upload = await uploadTransfer();
  assert.equal(upload.status, 201);
  const transfer = await upload.json();
  assert.equal(transfer.filename, 'hello.txt');
  assert.equal(transfer.sizeBytes, 14);

  const firstDownload = await fetch(`${baseUrl}/api/download/${transfer.downloadCode}`);
  assert.equal(firstDownload.status, 200);
  assert.equal(await firstDownload.text(), 'hello FileDrop');

  const nextDownload = await fetch(`${baseUrl}/api/download/${transfer.downloadCode}`);
  assert.equal(nextDownload.status, 410);
});

test('enforces a one-download limit when requests arrive concurrently', async () => {
  const upload = await uploadTransfer();
  const transfer = await upload.json();
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/download/${transfer.downloadCode}`),
    fetch(`${baseUrl}/api/download/${transfer.downloadCode}`)
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 410]);
  await Promise.all(responses.map((response) => response.arrayBuffer()));
});

test('returns 410 for transfers whose time-to-live has elapsed', async () => {
  const upload = await uploadTransfer({ expirationType: 'time', expiresInHours: '1' });
  const transfer = await upload.json();
  instance.database.prepare('UPDATE transfers SET expiresAt = ? WHERE downloadCode = ?')
    .run(new Date(Date.now() - 1000).toISOString(), transfer.downloadCode);

  const download = await fetch(`${baseUrl}/api/download/${transfer.downloadCode}`);
  assert.equal(download.status, 410);
});

test('rejects invalid expiration rules and removes the uploaded file', async () => {
  const response = await uploadTransfer({ maxDownloads: '0' });
  assert.equal(response.status, 400);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0);
});

test('returns 410 for an unknown download code', async () => {
  const response = await fetch(`${baseUrl}/api/download/not-a-real-code`);
  assert.equal(response.status, 410);
});

test('serves the download page for share links', async () => {
  const response = await fetch(`${baseUrl}/d/share-code`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
});

test('rejects uploads larger than the configured maximum', async () => {
  const form = new FormData();
  form.append('file', new Blob(['x'.repeat(2048)]), 'large.txt');
  form.append('expirationType', 'downloads');
  form.append('maxDownloads', '1');

  const response = await fetch(`${baseUrl}/api/transfers`, { method: 'POST', body: form });
  assert.equal(response.status, 413);
});