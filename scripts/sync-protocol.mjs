import fs from 'node:fs';
const pairs = [['indexer/src/protocol.ts','frontend/src/lib/protocol.ts'], ['indexer/src/schema.ts','frontend/src/schema.ts']];
for (const [src,dst] of pairs) {
  const data = fs.readFileSync(src, 'utf8');
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(dst,'utf8') !== data) throw new Error(`${dst} differs from ${src}`);
  } else fs.writeFileSync(dst,data);
}
