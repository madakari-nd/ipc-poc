// Fails if any built JS chunk of the two apps exceeds 250 KB gzip (Constitution VIII).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const LIMIT = 250 * 1024;
let failed = false;
for (const app of ['apps/field/dist/assets', 'apps/officer/dist/assets']) {
  if (!existsSync(app)) continue;
  for (const f of readdirSync(app).filter((x) => x.endsWith('.js'))) {
    const size = gzipSync(readFileSync(join(app, f))).length;
    if (size > LIMIT) {
      console.error(`over budget: ${app}/${f} ${(size / 1024).toFixed(1)} KB gzip`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
