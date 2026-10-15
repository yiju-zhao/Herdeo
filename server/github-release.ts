import {readFile,writeFile,mkdir,copyFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkReleaseVersion} from './release-version.js';
import {verifyRelease,type ReleaseManifest} from './release.js';

const execute=promisify(execFile);
export async function prepareGitHubRelease(root:string,tag:string){
 const version=await checkReleaseVersion(root,tag),verified=await verifyRelease(root);
 if(verified.status!=='verified'||verified.version!==version)throw Error('Build a verified release before preparing GitHub assets');
 const manifest:ReleaseManifest=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
 if(!manifest.commit||!/^[a-f0-9]{40}$/.test(manifest.commit))throw Error('GitHub releases require a source commit');
 const archive=join(root,'.dev/releases',`herdeo-${version}-${manifest.id.slice(0,12)}.tar.gz`);
 const bytes=await readFile(archive),hash=createHash('sha256').update(bytes).digest('hex');
 const expected=(await readFile(archive+'.sha256','utf8')).trim().split(/\s+/u)[0];
 if(hash!==expected)throw Error('Release archive SHA256 mismatch');
 const entries=(await execute('tar',['-tzf',archive])).stdout.trim().split('\n');
 const allowed=new Set([...Object.keys(manifest.files),'release.json']);
 if(entries.length!==allowed.size||new Set(entries).size!==allowed.size||entries.some(file=>!allowed.has(file)))throw Error('Release archive has unexpected or missing files');
 const unpacked=await mkdtemp(join(tmpdir(),'herdeo-package-'));
 try{
  await execute('tar',['-xzf',archive,'-C',unpacked]);
  const archived=await verifyRelease(unpacked);
  const saved:ReleaseManifest=JSON.parse(await readFile(join(unpacked,'release.json'),'utf8'));
  if(archived.status!=='verified'||archived.id!==manifest.id||saved.commit!==manifest.commit)throw Error('Extracted release does not match the verified source');
 }finally{await rm(unpacked,{recursive:true,force:true});}
 const output=join(root,'.dev/github-release');await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
 const name=`herdeo-${version}.tar.gz`;
 await copyFile(archive,join(output,name));
 await writeFile(join(output,name+'.sha256'),hash+'  '+name+'\n');
 await copyFile(join(root,'release.json'),join(output,'release.json'));
 const changelog=await readFile(join(root,'CHANGELOG.md'),'utf8');
 const sections=changelog.split(/(?=^## )/mu),notes=sections.find(section=>section.startsWith('## '+version+' ')||section.startsWith('## ['+version+']'));
 if(!notes)throw Error('The release has no changelog entry');
 await writeFile(join(output,'notes.md'),notes.trim()+'\n\nThe archive contains JavaScript, source and tests for macOS/Linux with Node.js 22+. Install dependencies separately; no accounts or machine configuration are included.\n');
 return {tag,version,commit:manifest.commit,id:manifest.id,output,assets:[name,name+'.sha256','release.json'],sha256:hash};
}
