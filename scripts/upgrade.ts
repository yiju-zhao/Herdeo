import {readlink,symlink,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {readConfig} from '../server/config.js';
import {verifyRelease} from '../server/release.js';
import {version} from '../server/version.js';

// Existing deployments keep their passwords, daemon homes and provider IDs.
const cfg=readConfig(),root=resolve(import.meta.dirname,'../..'),base=dirname(cfg.paseoHome);
if(base!==join(homedir(),'.hb')||root!==resolve(cfg.packageRoot))throw Error('Run this upgrade only from this account’s existing Herdeo deployment');
const release=await verifyRelease(root);
if(release.status!=='verified'||release.version!==version)throw Error('The installed release did not pass integrity verification');
for(const [file,target] of [[join(base,'bin/herdeo'),'hb'],[join(homedir(),'.local/bin/herdeo'),join(base,'bin/herdeo')]]){
 await mkdir(dirname(file!),{recursive:true});
 try{await symlink(target!,file!);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await readlink(file!)!==target)throw Error('Refusing to replace an existing command at '+file);}
}
console.log(JSON.stringify({upgraded:true,product:'Herdeo',version,release:release.id,alias:'herdeo',compatibleAlias:'hb'}));
