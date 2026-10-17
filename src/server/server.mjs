import express from 'express';
import multer from 'multer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, AppError } from './store.mjs';
import { DEFAULT_QUOTAS, DEFAULT_SUBSCRIPTIONS } from './seed.mjs';
import { migrateFromDesktop, defaultLegacyRoots } from './migrate.mjs';

export function createApp(store, options = {}) {
  const app = express();
  const allowDevOrigins = options.allowDevOrigins !== false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.get('host') || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return res.status(403).json({ error: '本地服务仅接受回环地址访问。' });
    const origin = req.get('origin');
    if (origin) {
      const allowed = origin === 'http://' + host
        || (allowDevOrigins && /^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin));
      if (!allowed) return res.status(403).json({ error: '跨站请求已拒绝。' });
      if (origin !== 'http://' + host) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Folio-App, X-Daily-App');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      }
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    const appHeader = req.get('x-folio-app') || req.get('x-daily-app');
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && appHeader !== '1') return res.status(403).json({ error: '请求来源无效。' });
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && store.restoring) return res.status(503).json({ error: '正在恢复完整备份，请稍后重试。', code: 'RESTORE_IN_PROGRESS' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self';");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '6mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 20 } });
  const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 1 } });
  app.get('/api/health', (_req, res) => res.json({ app: 'folio', version: '1.0.0', pid: process.pid, root: store.root }));
  app.get('/api/state', (_req, res) => res.json(store.state()));
  app.post('/api/tasks', (req, res) => res.status(201).json(store.insertTask(req.body)));
  app.patch('/api/tasks/:id', (req, res) => res.json(store.updateTask(req.params.id, req.body)));
  app.post('/api/tasks/:id/steps', (req, res) => res.json(store.toggleTaskStep(req.params.id, req.body)));
  app.delete('/api/tasks/:id', (req, res) => { store.deleteEntity('task', req.params.id, req.body); res.status(204).end(); });
  app.post('/api/notes', (req, res) => res.status(201).json(store.insertNote(req.body)));
  app.patch('/api/notes/:id', (req, res) => res.json(store.updateNote(req.params.id, req.body)));
  app.delete('/api/notes/:id', (req, res) => { store.deleteEntity('note', req.params.id, req.body); res.status(204).end(); });
  app.post('/api/quotas', (req, res) => res.status(201).json(store.insertQuota(req.body)));
  app.patch('/api/quotas/:id', (req, res) => res.json(store.updateQuota(req.params.id, req.body)));
  app.delete('/api/quotas/:id', (req, res) => { store.deleteEntity('quota', req.params.id, req.body); res.status(204).end(); });
  app.post('/api/subscriptions', (req, res) => res.status(201).json(store.insertSubscription(req.body)));
  app.patch('/api/subscriptions/:id', (req, res) => res.json(store.updateSubscription(req.params.id, req.body)));
  app.delete('/api/subscriptions/:id', (req, res) => { store.deleteEntity('subscription', req.params.id, req.body); res.status(204).end(); });
  app.post('/api/attachments', upload.array('files', 20), (req, res) => {
    if (!req.files?.length) throw new AppError('未选择附件文件。');
    const files = req.files.map(file => store.insertFile(Buffer.from(file.originalname, 'latin1').toString('utf8'), file.buffer, req.body.ownerType, req.body.ownerId));
    res.status(201).json(files);
  });
  app.get('/api/attachments/:id/download', (req, res, next) => {
    const { file, absolute } = store.filePath(req.params.id);
    res.download(absolute, file.filename, error => { if (error) next(error); });
  });
  app.delete('/api/attachments/:id', (req, res) => { store.deleteEntity('attachment', req.params.id); res.status(204).end(); });
  app.post('/api/attachments/:id/links', (req, res) => { store.setLink(req.params.id, req.body); res.status(204).end(); });
  app.delete('/api/attachments/:id/links', (req, res) => { store.setLink(req.params.id, req.body, true); res.status(204).end(); });
  app.post('/api/trash/:type/:id/restore', (req, res) => { store.restoreEntity(req.params.type, req.params.id); res.status(204).end(); });
  app.get('/api/backups', (_req, res) => res.json(store.listBackups()));
  app.post('/api/backups', async (_req, res) => res.status(201).json(await store.createBackup()));
  app.get('/api/backups/:id/download', (req, res, next) => res.download(store.backupPath(req.params.id), 'Folio备份-' + req.params.id, error => { if (error) next(error); }));
  app.post('/api/backups/:id/restore', async (req, res) => res.json(await store.restoreBackup(new Uint8Array(fs.readFileSync(store.backupPath(req.params.id))))));
  app.post('/api/restore', restoreUpload.single('file'), async (req, res) => {
    if (!req.file) throw new AppError('未选择备份文件。');
    res.json(await store.restoreBackup(new Uint8Array(req.file.buffer)));
  });
  app.post('/api/export', (_req, res) => res.status(201).json(store.exportMarkdown()));
  app.get('/api/exports/:id/:filename', (req, res, next) => res.download(store.exportPath(req.params.id, decodeURIComponent(req.params.filename)), decodeURIComponent(req.params.filename), error => { if (error) next(error); }));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。', code: 'NOT_FOUND' }));
  if (options.webDir) {
    const webDir = options.webDir;
    app.use(express.static(webDir, { index: 'index.html' }));
    app.get('/{*route}', (_req, res, next) => {
      const index = path.join(webDir, 'index.html');
      if (!fs.existsSync(index)) return next(new AppError('网页构建文件缺失，请重新构建应用。', 503));
      res.sendFile(index);
    });
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = error instanceof AppError ? error.status : error instanceof multer.MulterError ? 400 : error.status === 413 ? 413 : 500;
    const message = error instanceof multer.MulterError ? '文件过大或一次选择的文件过多。' : error.message || '本地服务发生错误。';
    res.status(status).json({ error: message, code: error.code || 'SERVER_ERROR' });
  });
  return app;
}

export async function startServer(root, requestedPort, options = {}) {
  const dataDir = path.join(path.resolve(root), 'app', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const legacy = defaultLegacyRoots();
  migrateFromDesktop(root, options.legacyAffairsDir || legacy.affairs);

  const lockPath = path.join(dataDir, 'service.lock');
  const metadataPath = path.join(dataDir, 'service.json');
  const lockId = crypto.randomUUID();
  try {
    const lockFd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, lockId, root: path.resolve(root) }));
    fs.closeSync(lockFd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
    let active = false;
    if (Number.isInteger(previous?.pid) && previous.pid > 0) {
      try { process.kill(previous.pid, 0); active = true; } catch {}
    }
    if (active) throw new Error('同一目录的本地服务已在运行。');
    fs.unlinkSync(lockPath);
    return startServer(root, requestedPort, options);
  }
  let store;
  let server;
  function cleanLock() {
    try {
      if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).lockId === lockId) {
        fs.unlinkSync(lockPath);
        if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
      }
    } catch {}
  }
  try {
    store = new Store(root);
    if (!store.db.prepare("SELECT value FROM settings WHERE key='services_seeded'").get()) {
      store.seedServices(DEFAULT_QUOTAS, DEFAULT_SUBSCRIPTIONS);
    }
    const app = createApp(store, options);
    const candidates = requestedPort === undefined ? Array.from({ length: 20 }, (_, i) => 47841 + i) : [requestedPort];
    let selectedPort;
    for (const port of candidates) {
      server = http.createServer(app);
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        selectedPort = server.address().port;
        break;
      } catch (error) {
        server.close();
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    if (selectedPort === undefined) throw new Error('本地服务端口 47841–47860 均被占用。');
    const metadata = { app: 'folio', version: '1.0.0', pid: process.pid, root: store.root, port: selectedPort, lockId, startedAt: new Date().toISOString() };
    fs.writeFileSync(metadataPath + '.tmp', JSON.stringify(metadata));
    fs.renameSync(metadataPath + '.tmp', metadataPath);
    const close = () => { server.close(); store.close(); cleanLock(); };
    return { server, store, port: selectedPort, close };
  } catch (error) {
    try { store?.close(); } catch {}
    cleanLock();
    throw error;
  }
}
