// Run from any directory. Keep advisories visible and enforce exact direct pins.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const projects=['frontend','indexer','runtime/worker','runtime/server','runtime/relay'];
let failed=false;
for (const project of projects) {
  const cwd=root+project;
  const pkg=JSON.parse(readFileSync(cwd+'/package.json','utf8'));
  for (const field of ['dependencies','devDependencies','optionalDependencies','overrides']) {
    for (const [name,version] of Object.entries(pkg[field]??{})) {
      if (typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
        console.error(`${project}: ${field}.${name} must be pinned to an exact version`);failed=true;
      }
    }
  }
  for (const [name,version] of Object.entries(pkg.pnpm?.overrides??{})) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
      console.error(`${project}: override ${name} must be pinned to an exact version`);failed=true;
    }
  }
  const pnpm=existsSync(cwd+'/pnpm-lock.yaml');
  if (!pnpm&&!existsSync(cwd+'/package-lock.json')) {console.error(`${project}: lockfile missing`);failed=true;continue;}
  console.log(`\nAuditing ${project} (${pnpm?'pnpm':'npm'} lockfile)`);
  const result=spawnSync(pnpm?'pnpm':'npm',pnpm?['audit']:['audit','--package-lock-only'],{cwd,stdio:'inherit'});
  if (result.error||result.status!==0) failed=true;
}
process.exitCode=failed?1:0;
