import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeTuiState} from '../server/tui-state.js';

test('native Claude display batches preserve original text and deduplicate replayed batches',()=>{
 const state=new NativeTuiState('claude',()=>{});
 state.claudeHook({session_id:'original',hook_event_name:'SessionStart',model:'native-model'});
 const batch={session_id:'original',hook_event_name:'MessageDisplay',turn_id:'native-turn',message_id:'native-message',index:0,delta:'first\n',final:false};
 state.claudeHook(batch);state.claudeHook(batch);state.claudeHook({...batch,index:1,delta:'second',final:true});
 assert.deepEqual(state.snapshot().items,[{type:'assistant_message',id:'assistant:native-message',messageId:'native-message',text:'first\nsecond'}]);
 assert.equal(state.model,'native-model');assert.throws(()=>state.claudeHook({...batch,session_id:'replacement'}),/changed sessions/);
});
test('the actual Claude channel UserPromptSubmit echo reuses its correlated Paseo message',()=>{
 const state=new NativeTuiState('claude',()=>{});state.prompt('hello <owner>','owner-id');
 state.claudeHook({session_id:'s',hook_event_name:'UserPromptSubmit',prompt:'<channel source="paseo_native_bridge" paseo_message_id="owner-id">\nhello <owner>\n</channel>'});
 assert.equal(state.snapshot().items.filter(i=>i.type==='user_message').length,1);
 state.claudeHook({session_id:'s',hook_event_name:'UserPromptSubmit',prompt:'hello <owner>'});
 assert.equal(state.snapshot().items.filter(i=>i.type==='user_message').length,2);
});
test('actual native tool hooks produce typed cards and resolve the same permission after terminal approval',()=>{
 const events:any[]=[],state=new NativeTuiState('claude',e=>events.push(e));
 state.claudeHook({session_id:'s',hook_event_name:'PreToolUse',tool_use_id:'call1',tool_name:'Write',tool_input:{file_path:'owned.txt',content:'x'}});
 state.claudePermission({request_id:'abcde',tool_name:'Write',description:'Write owned file',input_preview:'...'});
 assert.equal(state.permissions.get('abcde')?.metadata?.fullInputVerified,true);
 assert.equal(state.permissions.get('abcde')?.metadata?.toolUseId,'call1');
 state.claudeHook({session_id:'s',hook_event_name:'PostToolUse',tool_use_id:'call1',tool_name:'Write',tool_input:{file_path:'owned.txt',content:'x'},tool_response:{success:true}});
 assert.equal(state.permissions.size,0);
 assert.ok(events.some(e=>e.type==='session.permission_resolved'&&e.permissionId==='abcde'));
 const tool=state.items.get('tool:call1') as any;assert.equal(tool.status,'completed');assert.equal(tool.detail.type,'write');
});
test('ambiguous native permission previews never claim to contain verified full arguments',()=>{
 const state=new NativeTuiState('claude',()=>{});
 for(const tool_use_id of ['one','two'])state.claudeHook({session_id:'s',hook_event_name:'PreToolUse',tool_use_id,tool_name:'Write',tool_input:{file_path:tool_use_id}});
 state.claudePermission({request_id:'abcde',tool_name:'Write',input_preview:'truncated'});
 assert.equal(state.permissions.get('abcde')?.metadata?.fullInputVerified,false);
});
test('a real native idle boundary cancels tools that never produced a completion hook',()=>{
 const state=new NativeTuiState('claude',()=>{});
 state.claudeHook({session_id:'s',hook_event_name:'PreToolUse',tool_use_id:'denied',tool_name:'Read',tool_input:{file_path:'declined.txt'}});
 state.finish();
 assert.equal((state.items.get('tool:denied') as any).status,'canceled');
});
test('Pi native echo reuses the actual accepted Paseo row and streams one assistant message',()=>{
 const state=new NativeTuiState('pi',()=>{});state.prompt('hello','owner-message');
 state.piEvent({type:'message_start',message:{role:'user',content:'hello'}});
 state.piEvent({type:'message_start',message:{role:'assistant'}});
 state.piEvent({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'native '}});
 state.piEvent({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'reply'}});
 assert.equal(state.snapshot().items.filter(i=>i.type==='user_message').length,1);
 assert.equal((state.snapshot().items.find(i=>i.type==='assistant_message') as any).text,'native reply');
});
