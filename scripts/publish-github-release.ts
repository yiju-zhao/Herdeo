import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareGitHubRelease} from '../server/github-release.js';

const root=resolve(import.meta.dirname,'../..'),execute=promisify(execFile),tag=process.argv[2];
if(process.argv.length!==3||!tag)throw Error('Usage: publish-github-release vX.Y.Z');
const prepared=await prepareGitHubRelease(root,tag);
const head=(await execute('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
const tagged=(await execute('git',['rev-parse','--verify',`refs/tags/${tag}^{commit}`],{cwd:root})).stdout.trim();
if(head!==prepared.commit||tagged!==head||(await execute('git',['status','--porcelain'],{cwd:root})).stdout.trim())throw Error('Publish only a clean checkout of the exact release tag and source commit');
const gh=async(args:string[])=>execute('gh',args,{cwd:root,timeout:60000});
let release:any;
// Listing distinguishes an absent release from authentication/network errors.
const releases=JSON.parse((await gh(['api','--paginate','--slurp','repos/{owner}/{repo}/releases?per_page=100'])).stdout).flat();
release=releases.find((entry:any)=>entry.tag_name===tag);
if(release&&!release.draft){
 if(!prepared.assets.every(name=>release.assets.some((asset:any)=>asset.name===name)))throw Error('Published release assets are incomplete; refusing to replace a published release');
 const folder=await mkdtemp(join(tmpdir(),'herdeo-published-'));
 try{
  await gh(['release','download',tag,'--pattern','release.json','--dir',folder]);
  const published=JSON.parse(await readFile(join(folder,'release.json'),'utf8'));
  if(published.id!==prepared.id||published.commit!==head)throw Error('Published release belongs to different content; refusing to overwrite it');
 }finally{await rm(folder,{recursive:true,force:true});}
 console.log('Release already published with matching content: '+release.html_url);
}else{
 if(!release)await gh(['release','create',tag,'--verify-tag','--draft','--title','Herdeo '+tag,'--notes-file',join(prepared.output,'notes.md')]);
 await gh(['release','upload',tag,...prepared.assets.map(name=>join(prepared.output,name)),'--clobber']);
 const ready=JSON.parse((await gh(['release','view',tag,'--json','assets'])).stdout);
 if(!prepared.assets.every(name=>ready.assets.some((asset:any)=>asset.name===name)))throw Error('Draft assets are incomplete; release remains unpublished');
 await gh(['release','edit',tag,'--draft=false','--latest']);
 console.log((await gh(['release','view',tag,'--json','url','--jq','.url'])).stdout.trim());
}
