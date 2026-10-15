import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

async function fixture(){
 const base=await mkdtemp(join(tmpdir(),'herdeo-version-git-')),root=join(base,'work'),remote=join(base,'remote.git');await mkdir(root);
 const git=async(args:string[])=>(await execute('git',args,{cwd:root})).stdout.trim();
 await git(['init','--bare',remote]);await git(['init','-b','main']);await git(['config','user.name','Release Test']);await git(['config','user.email','release-test@example.invalid']);await git(['remote','add','origin',remote]);
 const source=resolve(import.meta.dirname,'..');
 for(const folder of ['server','scripts'])await mkdir(join(root,folder));
 for(const file of ['scripts/auto-version.ts','server/release-version.ts','server/conventional-release.ts'])await copyFile(join(source,file),join(root,file));
 await writeFile(join(root,'package.json'),JSON.stringify({name:'release-fixture',type:'module',version:'0.2.1'}));
 await writeFile(join(root,'package-lock.json'),JSON.stringify({version:'0.2.1',packages:{'':{version:'0.2.1'}}}));
 await writeFile(join(root,'server/version.ts'),"export const version='0.2.1'; // x-herdeo-version\n");
 await writeFile(join(root,'README.md'),'Version 0.2.1 <!-- x-herdeo-version -->\n');await writeFile(join(root,'CHANGELOG.md'),'# Changelog\n\n## 0.2.1 (2026-10-15)\n');
 await git(['add','.']);await git(['commit','-m','chore: bootstrap']);await git(['tag','v0.2.1']);await git(['push','origin','main','v0.2.1']);
 await writeFile(join(root,'change.txt'),'real fixture change');await git(['add','change.txt']);await git(['commit','-m','fix(delivery): retain native message identity']);
 const run=()=>execute(process.execPath,['--import',import.meta.resolve('tsx'),join(root,'scripts/auto-version.ts')],{cwd:root,env:{...process.env,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_OUTPUT:join(base,'outputs'),GH_TOKEN:''},timeout:20000});
 return {base,root,remote,git,run};
}

test('the actual auto-version command commits synchronized versions and atomically publishes the tag without looping',async()=>{
 const f=await fixture();try{
  const checked=await f.git(['rev-parse','HEAD']);await f.run();
  const pkg=JSON.parse(await readFile(join(f.root,'package.json'),'utf8'));assert.equal(pkg.version,'0.2.2');
  assert.equal(await f.git(['rev-parse','HEAD^']),checked);
  const refs=(await execute('git',['--git-dir',f.remote,'show-ref'])).stdout;
  const head=await f.git(['rev-parse','HEAD']);assert.ok(refs.includes(head+' refs/heads/main'));assert.ok(refs.includes('refs/tags/v0.2.2'));
  assert.ok((await readFile(join(f.base,'outputs'),'utf8')).includes('created=true'));
  await f.run();assert.equal(await f.git(['rev-parse','HEAD']),head);
  assert.ok((await readFile(join(f.base,'outputs'),'utf8')).endsWith('created=false\n'));
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('a concurrent main update rejects both the generated version commit and its tag',async()=>{
 const f=await fixture();try{
  const concurrent=join(f.base,'concurrent');await execute('git',['clone','--branch','main',f.remote,concurrent]);
  const git=async(args:string[])=>execute('git',args,{cwd:concurrent});
  await git(['config','user.name','Concurrent Test']);await git(['config','user.email','concurrent@example.invalid']);
  await writeFile(join(concurrent,'concurrent.txt'),'new main commit');await git(['add','.']);await git(['commit','-m','docs: concurrent change']);await git(['push','origin','main']);
  const before=(await git(['rev-parse','HEAD'])).stdout.trim();await assert.rejects(f.run());
  const refs=(await execute('git',['--git-dir',f.remote,'show-ref'])).stdout;assert.ok(refs.includes(before+' refs/heads/main'));assert.ok(!refs.includes('refs/tags/v0.2.2'));
 }finally{await rm(f.base,{recursive:true,force:true});}
});
