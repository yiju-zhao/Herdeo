import {test} from 'node:test';
import assert from 'node:assert/strict';
import {includeKnownAgents} from '../server/paseo.js';

test('an archived agent hidden by a removed workspace is fetched by its saved ID without unarchiving it',async()=>{
 const fetched:string[]=[];const archived={id:'original',archivedAt:'2026-10-15',provider:'claude-terminal'};
 const client={agents:{ref:(id:string)=>({refresh:async()=>{fetched.push(id);return id==='original'?{agent:archived}:undefined;}})}} as any;
 const agents=await includeKnownAgents(client,[],['original','original','deleted',undefined]);
 assert.deepEqual(fetched,['original','deleted']);assert.deepEqual(agents,[archived]);assert.ok(agents[0]!.archivedAt);
 await assert.rejects(includeKnownAgents({agents:{ref:()=>({refresh:async()=>{throw Error('connection lost');}})}} as any,[],['original']),/connection lost/);
});
