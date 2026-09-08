// Record exactly which reference source files the audit used, without copying user code.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(process.argv[2] || 'C:/Users/zk-ht/Downloads/islands/islands');
const hashes = {};
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else hashes[relative(root, path).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
}
await walk(join(root, 'src'));
for (const name of ['package.json', 'package-lock.json', 'next.config.ts']) {
  hashes[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
}
await writeFile('docs/reference_source_manifest.json', JSON.stringify({ captured_at: new Date().toISOString(),
  root, command: 'npx next dev --webpack', rendering_verified: false, files: hashes }, null, 2) + '\n');
console.log(`Recorded ${Object.keys(hashes).length} reference file hashes.`);
