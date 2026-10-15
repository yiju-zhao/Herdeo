import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkReleaseVersion} from '../server/release-version.js';
import {nextRelease,type ReleaseCommit} from '../server/conventional-release.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('Automatic versioning runs only in the main-branch GitHub workflow');
const root=resolve(import.meta.dirname,import.meta.filename.endsWith('.ts')?'..':'../..'),execute=promisify(execFile);
const git=async(args:string[])=>(await execute('git',args,{cwd:root})).stdout.trim();
const output=async(values:Record<string,string>)=>{if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,Object.entries(values).map(([key,value])=>key+'='+value+'\n').join(''));};
const current=await checkReleaseVersion(root);
if(await git(['status','--porcelain']))throw Error('Automatic versioning requires a clean checkout');
const tags=(await git(['tag','--merged','HEAD','--sort=-version:refname'])).split('\n').filter(tag=>/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag));
const previous=tags[0];
if(!previous){console.log('Bootstrap the current version tag before automatic versioning.');await output({created:'false'});}
else{
 if(previous!=='v'+current)throw Error('The source version must match the latest reachable release tag');
 const raw=(await execute('git',['log','--format=%H%x00%s%x00%b%x00',previous+'..HEAD'],{cwd:root})).stdout.split('\0');
 const commits:ReleaseCommit[]=[];for(let i=0;i+2<raw.length;i+=3)commits.push({sha:raw[i]!.trim(),subject:raw[i+1]!,body:raw[i+2]!});
 const next=nextRelease(current,commits);
 if(!next){console.log('No releasable changes since '+previous);await output({created:'false'});}
 else{
  for(const name of ['package.json','package-lock.json']){const file=join(root,name),value=JSON.parse(await readFile(file,'utf8'));value.version=next.version;if(name==='package-lock.json')value.packages[''].version=next.version;await writeFile(file,JSON.stringify(value,null,2)+'\n');}
  for(const name of ['server/version.ts','README.md']){
   const file=join(root,name),lines=(await readFile(file,'utf8')).split('\n');let updated=0;
   await writeFile(file,lines.map(line=>{if(!line.includes('x-herdeo-version'))return line;updated++;return line.replace(/\b\d+\.\d+\.\d+\b/u,next.version);}).join('\n'));
   if(updated!==1)throw Error('Exactly one version annotation is required in '+name);
  }
  const tag='v'+next.version,notes=`## [${next.version}](https://github.com/yiju-zhao/Herdeo/compare/${previous}...${tag}) (${new Date().toISOString().slice(0,10)})\n\n`+next.commits.map(commit=>'- '+commit.subject+' (['+commit.sha.slice(0,7)+'](https://github.com/yiju-zhao/Herdeo/commit/'+commit.sha+'))').join('\n');
  const changelog=join(root,'CHANGELOG.md'),old=await readFile(changelog,'utf8');
  await writeFile(changelog,'# Changelog\n\n'+notes+'\n\n'+old.replace(/^# Changelog\s*/u,''));
  await checkReleaseVersion(root,tag);
  await git(['config','user.name','github-actions[bot]']);await git(['config','user.email','41898282+github-actions[bot]@users.noreply.github.com']);
  await git(['add','package.json','package-lock.json','server/version.ts','README.md','CHANGELOG.md']);
  await git(['commit','-m','chore(release): '+tag]);await git(['tag','-a',tag,'-m','Herdeo '+tag]);
  // A concurrent main update rejects both refs rather than tagging unmerged code.
  await git(['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push','--atomic','origin','HEAD:refs/heads/main','refs/tags/'+tag]);
  await output({created:'true',tag,sha:await git(['rev-parse','HEAD'])});console.log('Prepared '+tag);
 }
}
