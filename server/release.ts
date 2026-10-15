import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export interface ReleaseManifest{product:string;version:string;id:string;builtAt:string;files:Record<string,string>;commit?:string}
export const releaseFileAllowed=(file:string)=>!file.split('/').some(p=>!p||p==='.'||p==='..')&&(['dist/','plugins/','server/','scripts/','test/'].some(prefix=>file.startsWith(prefix))||['package.json','package-lock.json','paseo-plugin.json','README.md','CHANGELOG.md','index.server.ts','tsconfig.json','tsconfig.build.json'].includes(file));
export async function verifyRelease(root:string){
 let manifest:ReleaseManifest;
 try{manifest=JSON.parse(await readFile(join(root,'release.json'),'utf8'));}
 catch(error){return {status:(error as NodeJS.ErrnoException).code==='ENOENT'?'missing' as const:'invalid' as const};}
 if(manifest.product!=='Herdeo'||typeof manifest.version!=='string'||!manifest.files||typeof manifest.files!=='object'||!Object.keys(manifest.files).length)return {status:'invalid' as const};
 const mismatches:string[]=[];
 for(const [file,expected] of Object.entries(manifest.files)){
  if(!releaseFileAllowed(file)||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)){mismatches.push(file);continue;}
  try{if(createHash('sha256').update(await readFile(join(root,file))).digest('hex')!==expected)mismatches.push(file);}catch{mismatches.push(file);}
 }
 const id=createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
 if(manifest.id!==id)mismatches.push('release.json');
 return {status:mismatches.length?'mismatch' as const:'verified' as const,version:manifest.version,id:manifest.id,mismatches};
}
