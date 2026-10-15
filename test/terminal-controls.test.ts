import {test} from 'node:test';
import assert from 'node:assert/strict';
import {terminalControl} from '../server/terminal-controls.js';
import {configSchema,bridgeRuntime,codexSocketDirectory} from '../server/config.js';

test('Herdr permission input requires an unambiguous request and never guesses an answer',()=>{
 const requests=[{type:'extension_ui_request',method:'confirm',id:'first'},{type:'extension_ui_request',method:'confirm',id:'second'}];
 assert.throws(()=>terminalControl('pi','/allow',requests),/exact request ID/);
 assert.deepEqual(terminalControl('pi','/deny first',requests),{type:'extension_ui_response',id:'first',cancelled:true});
 assert.deepEqual(terminalControl('pi','/answer second no',requests),{type:'extension_ui_response',id:'second',confirmed:false});
 assert.equal(terminalControl('pi','ordinary user message',requests),undefined);
});
test('Herdr selection forwards only an explicit valid option',()=>{
 const pending=[{method:'select',id:'q',options:['First','Second']}];
 assert.throws(()=>terminalControl('pi','/allow',pending),/requested value/);
 assert.throws(()=>terminalControl('pi','/answer q invented',pending),/exact values/);
 assert.deepEqual(terminalControl('pi','/answer q Second',pending),{type:'extension_ui_response',id:'q',value:'Second'});
});
test('Claude terminal approvals preserve original tool input and deny explicitly',()=>{
 const request={request_id:'tool',request:{subtype:'can_use_tool',tool_name:'Read',input:{file_path:'README.md'}}};
 const allowed=terminalControl('claude','/allow',[request]) as any;
 assert.deepEqual(allowed.response.response,{behavior:'allow',updatedInput:request.request.input});
 const denied=terminalControl('claude','/deny',[request]) as any;
 assert.equal(denied.response.request_id,'tool');assert.equal(denied.response.response.behavior,'deny');
 assert.throws(()=>terminalControl('claude','/allow',[{...request,request:{...request.request,tool_name:'AskUserQuestion'}}]),/answers JSON/);
});
test('persistent deployment sockets use the configured short runtime without changing legacy routes',()=>{
 const config=configSchema.parse({herdr:[{name:'own',socket:'/home/user/.config/herdr/herdr.sock'}],transcriptRoots:{codex:'/home/user/.codex',claude:'/home/user/.claude'},paseoHome:'/home/user/.hb/paseo',packageRoot:'/home/user/.hb/app',paseoUrl:'ws://127.0.0.1:6795/ws',runtimeDirectory:'/home/user/.hb/run'});
 assert.equal(bridgeRuntime(config),'/home/user/.hb/run');assert.equal(codexSocketDirectory(config),'/home/user/.hb/run/codex');
 assert.equal(codexSocketDirectory({...config,runtimeDirectory:undefined}),'/home/user/.hb/paseo/herdr-bridge/codex-terminals');
});
