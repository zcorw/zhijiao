import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../vendor/encrypted-vault/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('SOURCE-MANIFEST.json',root),'utf8'));
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
if(pkg.name!==manifest.name||pkg.version!==manifest.version||manifest.algorithm!=='sha256')throw new Error('Vault vendor version mismatch');
for(const [path,expected] of Object.entries(manifest.files)){
  if(!/^(src\/(?:adapters\/)?[a-z-]+\.ts|scripts\/build\.mjs|docs\/[a-z-]+\.md|package\.json|tsconfig\.json|README\.md|NOTICE\.md)$/.test(path))throw new Error('Unexpected vault manifest path');
  const hash=createHash('sha256').update(await readFile(new URL(path,root))).digest('hex');
  if(hash!==expected)throw new Error(`Vault source checksum mismatch: ${path}`);
}
async function checkSources(folder){
  for(const entry of await readdir(new URL(folder,root),{withFileTypes:true})){
    const path=`${folder}${entry.name}`;
    if(entry.isDirectory())await checkSources(`${path}/`);
    else if(!manifest.files[path])throw new Error(`Untracked vault source: ${path}`);
  }
}
await checkSources('src/');
console.log(`Verified ${pkg.name}@${pkg.version} source snapshot at ${fileURLToPath(root)}`);
