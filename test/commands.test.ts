import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('help and version need no deployment, and an unknown command fails without attaching another Herdr',()=>{
 const command=resolve(import.meta.dirname,'../scripts/open.ts'),env={...process.env,HERDR_BRIDGE_CONFIG:'/nonexistent/herdeo-config.json'};
 for(const args of [['--help'],['version']]){
  const child=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),command,...args],{env,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/Herdeo 0\.2\.1/);
 }
 const unknown=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),command,'typo'],{env,encoding:'utf8'});
 assert.equal(unknown.status,2);assert.match(unknown.stderr,/未知命令/);assert.ok(!unknown.stderr.includes('ENOENT'));
});
