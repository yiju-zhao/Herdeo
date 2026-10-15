import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyRelease} from '../server/release.js';

test('release verification detects a partial deployment and refuses paths outside the package',async()=>{
 const root=await mkdtemp((process.platform==='darwin'?'/private/tmp/':'/tmp/')+'herdeo-release-');
 try{
  await mkdir(join(root,'dist'));await writeFile(join(root,'dist/main.js'),'original');
  const files={'dist/main.js':createHash('sha256').update('original').digest('hex')};
  const manifest={product:'Herdeo',version:'0.2.0',id:createHash('sha256').update(JSON.stringify(files)).digest('hex'),builtAt:'now',files};
  await writeFile(join(root,'release.json'),JSON.stringify(manifest));assert.equal((await verifyRelease(root)).status,'verified');
  await writeFile(join(root,'dist/main.js'),'partial-upgrade');assert.equal((await verifyRelease(root)).status,'mismatch');
  manifest.files={'../outside':files['dist/main.js']} as any;await writeFile(join(root,'release.json'),JSON.stringify(manifest));
  const report=await verifyRelease(root);assert.equal(report.status,'mismatch');assert.ok(report.mismatches?.includes('../outside'));
 }finally{await rm(root,{recursive:true,force:true});}
});
