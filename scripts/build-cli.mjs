// 把 src/cli/folio.ts 打包成单个 CommonJS 文件，安装版用 Folio.exe（ELECTRON_RUN_AS_NODE）运行它。
import { build } from 'esbuild';
import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/cli/folio.ts'],
  outfile: 'out/cli/folio.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: { __FOLIO_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
