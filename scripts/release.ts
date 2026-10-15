import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {productName,version} from '../server/version.js';
import type {ReleaseManifest} from '../server/release.js';

const root=resolve(import.meta.dirname,'../..');
async function walk(folder:string):Promise<string[]>{const entries=await readdir(join(root,folder),{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?walk(folder+'/'+e.name):[folder+'/'+e.name]))).flat();}
const files:Record<string,string>={};
for(const file of [...await walk('dist'),...await walk('plugins'),...await walk('server'),...await walk('scripts'),...await walk('test'),'index.server.ts','tsconfig.json','tsconfig.build.json','package.json','package-lock.json','paseo-plugin.json','README.md','CHANGELOG.md'].sort())files[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
const id=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const manifest:ReleaseManifest={product:productName,version,id,builtAt:new Date().toISOString(),files};
try{const commit=(await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();if(/^[a-f0-9]{40}$/.test(commit))manifest.commit=commit;}catch{}
await writeFile(join(root,'release.json'),JSON.stringify(manifest,null,2)+'\n');
const output=join(root,'.dev/releases');await mkdir(output,{recursive:true});
const list=join(output,'files.txt'),archive=join(output,`herdeo-${version}-${id.slice(0,12)}.tar.gz`);
await writeFile(list,[...Object.keys(files),'release.json'].join('\n')+'\n');
await promisify(execFile)('tar',['-czf',archive,'-T',list],{cwd:root});
const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',sha256+'  '+archive.split('/').at(-1)+'\n');
console.log(JSON.stringify({product:productName,version,id,archive,sha256}));
