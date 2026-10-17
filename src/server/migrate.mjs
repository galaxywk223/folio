import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

export function defaultLegacyRoots() {
  const desktop = path.join(os.homedir(), 'Desktop');
  return {
    affairs: path.join(desktop, '日常事务'),
    services: path.join(desktop, '网站与服务'),
  };
}

/** One-time copy of SQLite + attachments from Desktop「日常事务」 into Folio data root. */
export function migrateFromDesktop(root, legacyAffairsDir) {
  const marker = path.join(root, 'app', 'data', 'desktop-import.json');
  if (fs.existsSync(marker)) return { skipped: true, reason: 'already-imported' };
  if (!legacyAffairsDir || !fs.existsSync(legacyAffairsDir)) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ importedAt: new Date().toISOString(), skipped: true, reason: 'source-missing' }, null, 2));
    return { skipped: true, reason: 'source-missing' };
  }

  const dataDir = path.join(root, 'app', 'data');
  const attachmentDir = path.join(root, '附件');
  fs.mkdirSync(dataDir, { recursive: true });

  const folioDb = path.join(dataDir, 'folio.sqlite');
  const sourceDbCandidates = [
    path.join(legacyAffairsDir, 'app', 'data', 'daily-affairs.sqlite'),
    path.join(legacyAffairsDir, 'app', 'data', 'folio.sqlite'),
  ];
  const sourceDb = sourceDbCandidates.find(candidate => fs.existsSync(candidate));
  if (sourceDb && !fs.existsSync(folioDb)) fs.copyFileSync(sourceDb, folioDb);

  const sourceAttachments = path.join(legacyAffairsDir, '附件');
  if (fs.existsSync(sourceAttachments)) {
    const hasFiles = fs.existsSync(attachmentDir) && fs.readdirSync(attachmentDir).length > 0;
    if (!hasFiles) copyDir(sourceAttachments, attachmentDir);
  }

  const result = {
    importedAt: new Date().toISOString(),
    source: legacyAffairsDir,
    database: !!sourceDb,
    attachments: fs.existsSync(sourceAttachments),
  };
  fs.writeFileSync(marker, JSON.stringify(result, null, 2));
  return result;
}
