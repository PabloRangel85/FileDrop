const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const multer = require('multer');

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
const EXPIRATION_HOURS = new Set([1, 24, 168]);

function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const databasePath = path.join(dataDir, 'filedrop.sqlite');
  const configuredMaxFileSize = Number(process.env.FILEDROP_MAX_FILE_SIZE_BYTES);
  const maxFileSize = options.maxFileSize ?? (
    Number.isSafeInteger(configuredMaxFileSize) && configuredMaxFileSize > 0
      ? configuredMaxFileSize
      : DEFAULT_MAX_FILE_SIZE
  );
  const activeDownloads = new Map();

  fs.mkdirSync(uploadDir, { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS transfers (
      downloadCode TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      storageName TEXT NOT NULL,
      sizeBytes INTEGER NOT NULL,
      maxDownloads INTEGER,
      downloadCount INTEGER NOT NULL DEFAULT 0,
      expiresAt TEXT,
      createdAt TEXT NOT NULL,
      CHECK (
        (expiresAt IS NOT NULL AND maxDownloads IS NULL) OR
        (expiresAt IS NULL AND maxDownloads IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS transfers_expires_at ON transfers(expiresAt);
  `);

  const app = express();
  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (_request, _file, callback) => callback(null, crypto.randomUUID())
  });
  const upload = multer({
    storage,
    limits: { fileSize: maxFileSize, files: 1 }
  });

  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set('X-Content-Type-Options', 'nosniff');
    response.set('X-Frame-Options', 'DENY');
    response.set('Referrer-Policy', 'no-referrer');
    next();
  });

  function removeFile(storageName) {
    try {
      fs.unlinkSync(path.join(uploadDir, storageName));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function removeTransfer(downloadCode, storageName) {
    removeFile(storageName);
    database.prepare('DELETE FROM transfers WHERE downloadCode = ?').run(downloadCode);
  }

  function cleanupExpired() {
    const expired = database.prepare(
      'SELECT downloadCode, storageName FROM transfers WHERE expiresAt IS NOT NULL AND expiresAt <= ?'
    ).all(new Date().toISOString());

    for (const transfer of expired) {
      if (!activeDownloads.has(transfer.storageName)) {
        removeTransfer(transfer.downloadCode, transfer.storageName);
      }
    }
  }

  const cleanupTimer = setInterval(cleanupExpired, 60_000);
  cleanupTimer.unref();
  cleanupExpired();

  app.use('/api', express.json({ limit: '16kb' }));

  app.post('/api/transfers', (request, response, next) => {
    upload.single('file')(request, response, (error) => {
      if (error) return next(error);

      const file = request.file;
      if (!file) {
        return response.status(400).json({ error: 'Selecione um arquivo para enviar.' });
      }

      const expirationType = request.body.expirationType;
      const now = new Date();
      let expiresAt = null;
      let maxDownloads = null;

      if (expirationType === 'time') {
        const hours = Number(request.body.expiresInHours);
        if (!EXPIRATION_HOURS.has(hours)) {
          removeFile(file.filename);
          return response.status(400).json({ error: 'Escolha uma expiracao valida.' });
        }
        expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
      } else if (expirationType === 'downloads') {
        maxDownloads = Number(request.body.maxDownloads);
        if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 100) {
          removeFile(file.filename);
          return response.status(400).json({ error: 'O limite deve ser de 1 a 100 downloads.' });
        }
      } else {
        removeFile(file.filename);
        return response.status(400).json({ error: 'Escolha uma regra de expiracao.' });
      }

      const downloadCode = crypto.randomBytes(9).toString('base64url');
      const filename = path.basename(file.originalname).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) || 'arquivo';

      try {
        database.prepare(`
          INSERT INTO transfers (downloadCode, filename, storageName, sizeBytes, maxDownloads, expiresAt, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(downloadCode, filename, file.filename, file.size, maxDownloads, expiresAt, now.toISOString());
      } catch (insertError) {
        removeFile(file.filename);
        return next(insertError);
      }

      const origin = `${request.protocol}://${request.get('host')}`;
      return response.status(201).json({
        downloadCode,
        filename,
        sizeBytes: file.size,
        maxDownloads,
        expiresAt,
        shareUrl: `${origin}/d/${downloadCode}`
      });
    });
  });

  app.get('/api/transfers/:code', (request, response) => {
    const transfer = database.prepare(
      'SELECT filename, sizeBytes, maxDownloads, downloadCount, expiresAt FROM transfers WHERE downloadCode = ?'
    ).get(request.params.code);

    if (!transfer || (transfer.expiresAt && transfer.expiresAt <= new Date().toISOString()) ||
      (transfer.maxDownloads !== null && transfer.downloadCount >= transfer.maxDownloads)) {
      return response.status(410).json({ error: 'Este link expirou ou atingiu o limite de downloads.' });
    }

    return response.json({
      ...transfer,
      remainingDownloads: transfer.maxDownloads === null ? null : transfer.maxDownloads - transfer.downloadCount
    });
  });

  app.get('/api/download/:code', (request, response) => {
    const transfer = database.prepare(`
      UPDATE transfers
      SET downloadCount = downloadCount + 1
      WHERE downloadCode = ?
        AND (expiresAt IS NULL OR expiresAt > ?)
        AND (maxDownloads IS NULL OR downloadCount < maxDownloads)
      RETURNING downloadCode, filename, storageName, maxDownloads, downloadCount
    `).get(request.params.code, new Date().toISOString());

    if (!transfer) {
      return response.status(410).json({ error: 'Este link expirou ou atingiu o limite de downloads.' });
    }

    const filePath = path.join(uploadDir, transfer.storageName);
    if (!fs.existsSync(filePath)) {
      database.prepare('DELETE FROM transfers WHERE downloadCode = ?').run(transfer.downloadCode);
      return response.status(410).json({ error: 'O arquivo nao esta mais disponivel.' });
    }

    activeDownloads.set(
      transfer.storageName,
      (activeDownloads.get(transfer.storageName) || 0) + 1
    );
    return response.download(filePath, transfer.filename, (error) => {
      const activeCount = activeDownloads.get(transfer.storageName) || 0;
      if (activeCount <= 1) activeDownloads.delete(transfer.storageName);
      else activeDownloads.set(transfer.storageName, activeCount - 1);
      if (transfer.maxDownloads !== null && transfer.downloadCount >= transfer.maxDownloads) {
        try {
          removeTransfer(transfer.downloadCode, transfer.storageName);
        } catch (cleanupError) {
          console.error('Falha ao remover arquivo expirado:', cleanupError);
        }
      }
      if (error && !response.headersSent) response.status(500).end();
    });
  });

  app.get('/d/:code', (_request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return response.status(413).json({ error: `O arquivo ultrapassa o limite de ${Math.floor(maxFileSize / (1024 * 1024))} MB.` });
    }
    console.error(error);
    return response.status(500).json({ error: 'Nao foi possivel concluir a operacao.' });
  });

  return {
    app,
    database,
    cleanupExpired,
    close() {
      clearInterval(cleanupTimer);
      database.close();
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { app } = createApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`FileDrop disponivel em http://localhost:${port}`);
  });
}

module.exports = { createApp };