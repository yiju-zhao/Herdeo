import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {checkReleaseVersion} from '../server/release-version.js';
import {prepareGitHubRelease} from '../server/github-release.js';

const execute=promisify(execFile),hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'herdeo-gh-release-')),version='2.3.4';
 const values:Record<string,string>={
  'package.json':JSON.stringify({version}),
  'package-lock.json':JSON.stringify({version,packages:{'':{version}}}),
  'server/version.ts':`export const version='${version}'; // x-herdeo-version`,
  'README.md':`Current version: ${version} <!-- x-herdeo-version -->`,
  'CHANGELOG.md':`# Changelog\n\n## ${version} (2026-10-15)\n\nReal release notes.\n\n## 2.3.3 (2026-10-01)\n\nOld notes.`,
  'dist/main.js':'console.log("original runtime");',
 };
 const files:Record<string,string>={};
 for(const [file,text]of Object.entries(values)){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),text);files[file]=hash(text);}
 const id=hash(JSON.stringify(files));
 await writeFile(join(root,'release.json'),JSON.stringify({product:'Herdeo',version,id,builtAt:'now',commit:'1'.repeat(40),files}));
 const folder=join(root,'.dev/releases');await mkdir(folder,{recursive:true});const archive=join(folder,`herdeo-${version}-${id.slice(0,12)}.tar.gz`);
 await execute('tar',['-czf',archive,'-C',root,...Object.keys(files),'release.json']);
 await writeFile(archive+'.sha256',hash(await readFile(archive))+'  archive.tar.gz\n');
 return {root,version,archive,files};
}

test('version and tag drift fail before a GitHub release can be prepared',async()=>{
 const f=await fixture();try{
  assert.equal(await checkReleaseVersion(f.root,'v2.3.4'),'2.3.4');
  await assert.rejects(checkReleaseVersion(f.root,'v2.3.5'),/tag must match/);
  await writeFile(join(f.root,'server/version.ts'),"export const version='2.3.3';");
  await assert.rejects(checkReleaseVersion(f.root),/versions must agree/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('GitHub assets have stable names and valid checksums, and notes contain only the selected release',async()=>{
 const f=await fixture();try{
  const prepared=await prepareGitHubRelease(f.root,'v2.3.4');
  assert.deepEqual(prepared.assets,['herdeo-2.3.4.tar.gz','herdeo-2.3.4.tar.gz.sha256','release.json']);
  assert.equal(hash(await readFile(join(prepared.output,prepared.assets[0]!))),prepared.sha256);
  assert.equal((await readFile(join(prepared.output,prepared.assets[1]!),'utf8')).trim(),prepared.sha256+'  herdeo-2.3.4.tar.gz');
  const notes=await readFile(join(prepared.output,'notes.md'),'utf8');assert.ok(notes.includes('Real release notes.'));assert.ok(!notes.includes('Old notes.'));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('a checksum-valid archive with altered runtime contents cannot be published',async()=>{
 const f=await fixture(),tampered=await mkdtemp(join(tmpdir(),'herdeo-tamper-'));try{
  await execute('tar',['-xzf',f.archive,'-C',tampered]);await writeFile(join(tampered,'dist/main.js'),'altered runtime');
  await execute('tar',['-czf',f.archive,'-C',tampered,...Object.keys(f.files),'release.json']);
  await writeFile(f.archive+'.sha256',hash(await readFile(f.archive))+'  archive.tar.gz\n');
  await assert.rejects(prepareGitHubRelease(f.root,'v2.3.4'),/does not match/);
 }finally{await rm(f.root,{recursive:true,force:true});await rm(tampered,{recursive:true,force:true});}
});
