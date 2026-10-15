import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotWriter} from '../server/snapshot-writer.js';

test('a burst of deltas during slow storage writes only the latest full snapshot and flush retains the final boundary',async()=>{
 let value=0,release!:()=>void;const written:string[]=[];
 const gate=new Promise<void>(done=>{release=done;});
 const writer=new SnapshotWriter('/unused/snapshot.json',()=>({value}),async(_file,data)=>{written.push(data);if(written.length===1)await gate;},async()=>{});
 writer.schedule();const final=writer.flush();
 for(let i=1;i<=1000;i++){value=i;writer.schedule();}
 release();await final;
 assert.equal(written.length,2);assert.deepEqual(JSON.parse(written.at(-1)!),{value:1000});
});

test('a failed atomic write can be retried without losing the latest state',async()=>{
 let failed=true,value='before',durable='';
 const writer=new SnapshotWriter('/unused/snapshot.json',()=>({value}),async(_file,data)=>{if(failed){failed=false;throw Error('disk unavailable');}durable=data;},async()=>{});
 await assert.rejects(writer.flush(),/disk unavailable/);value='final';await writer.flush();
 assert.deepEqual(JSON.parse(durable),{value:'final'});
});
