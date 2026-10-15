import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PromptDelivery} from '../server/prompt-delivery.js';

test('concurrent and post-completion retries reach the executor once and retain the original turn',async()=>{
 const delivery=new PromptDelivery();let sends=0,release!:()=>void;
 const gate=new Promise<void>(done=>{release=done;});
 const send=async(accept:(turn:string)=>void)=>{sends++;accept('original-turn');await gate;return {turnId:'original-turn'};};
 const first=delivery.deliver('phone-id','owner text',send),reconnected=delivery.deliver('phone-id','owner text',send);
 await Promise.resolve();assert.equal(sends,1);assert.equal(delivery.snapshot()[0]?.status,'accepted');
 release();assert.deepEqual(await first,await reconnected);
 assert.deepEqual(await delivery.deliver('phone-id','owner text',send),{turnId:'original-turn'});assert.equal(sends,1);
 await assert.rejects(delivery.deliver('phone-id','different text',send),/different text/);assert.equal(sends,1);
});

test('lost acknowledgement never resends accepted work, while a busy preflight can be retried',async()=>{
 const delivery=new PromptDelivery();let sends=0;
 await assert.rejects(delivery.deliver('busy','message',async()=>{throw Error('busy');}),/busy/);
 assert.deepEqual(await delivery.deliver('busy','message',async accept=>{accept('later-turn');return {turnId:'later-turn'};}),{turnId:'later-turn'});
 const lost=async(accept:(turn:string)=>void)=>{sends++;accept('uncertain-turn');throw Error('acknowledgement lost');};
 await assert.rejects(delivery.deliver('lost','message',lost),/acknowledgement lost/);
 await assert.rejects(delivery.deliver('lost','message',lost),/acknowledgement lost/);
 assert.equal(sends,1);assert.equal(delivery.snapshot().find(r=>r.id==='lost')?.status,'uncertain');
});
