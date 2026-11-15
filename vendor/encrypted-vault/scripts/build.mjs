import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(project,'dist');
if(relative(project,output)!=='dist')throw new Error('Unexpected build output path');
// Only remove this package's checked, generated output; moved modules cannot linger in tarballs.
await rm(output,{recursive:true,force:true});
const require=createRequire(import.meta.url);
const compiler=require.resolve('typescript/bin/tsc');
const result=spawnSync(process.execPath,[compiler,'-p',resolve(project,'tsconfig.json')],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
