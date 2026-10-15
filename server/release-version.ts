import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function checkReleaseVersion(root:string,tag?:string){
 const readJson=async(file:string)=>JSON.parse(await readFile(join(root,file),'utf8'));
 const [pkg,lock,source,readme]=await Promise.all([readJson('package.json'),readJson('package-lock.json'),readFile(join(root,'server/version.ts'),'utf8'),readFile(join(root,'README.md'),'utf8')]);
 const version=pkg.version;
 if(typeof version!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error('A stable semantic version is required');
 const copies=[lock.version,lock.packages?.['']?.version,source.match(/export const version=['"]([^'"]+)['"]/u)?.[1],readme.split('\n').find(line=>line.includes('x-herdeo-version'))?.match(/\b\d+\.\d+\.\d+\b/u)?.[0]];
 if(copies.some(copy=>copy!==version))throw Error('Package, lockfile, CLI and README versions must agree');
 if(tag!==undefined&&tag!=='v'+version)throw Error('Release tag must match v'+version);
 return version;
}
