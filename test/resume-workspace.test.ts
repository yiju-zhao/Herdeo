import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resumeWorkspace} from '../server/resume-workspace.js';

test('an active workspace needs no recovery operations when its native agent resumes',async()=>{
 const client={workspaces:{ref:()=>({refresh:async()=>({id:'original'})})}} as any;
 const driver={inspectWorkspaceRecovery:async()=>{assert.fail('active workspace must not be inspected for recovery');},restoreWorkspace:async()=>{assert.fail('active workspace must not be restored');}} as any;
 assert.equal(await resumeWorkspace(client,driver,'original'),true);
});

test('an archived workspace is restored and verified before its original agent card can be reused',async()=>{
 let restored=false;const operations:string[]=[];
 const client={workspaces:{ref:()=>({refresh:async()=>{operations.push('read');return restored?{id:'original'}:null;}})}} as any;
 const driver={inspectWorkspaceRecovery:async()=>{operations.push('inspect');return {kind:'recoverable',workspaceId:'original'};},restoreWorkspace:async(id:string)=>{assert.equal(id,'original');operations.push('restore');restored=true;}} as any;
 assert.equal(await resumeWorkspace(client,driver,'original'),true);assert.deepEqual(operations,['read','inspect','restore','read']);
});

test('a removed project requires a new view, while other recovery failures cannot silently fork a card',async()=>{
 const client={workspaces:{ref:()=>({refresh:async()=>null})}} as any;
 let reason='project_not_found';const driver={inspectWorkspaceRecovery:async()=>({kind:'unavailable',reason,message:'official recovery unavailable'}),restoreWorkspace:async()=>{assert.fail('unavailable workspace must not be restored');}} as any;
 assert.equal(await resumeWorkspace(client,driver,'original'),false);
 reason='directory_missing';await assert.rejects(resumeWorkspace(client,driver,'original'),/cannot be restored/);
});
