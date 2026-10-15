import {randomUUID} from 'node:crypto';
import type {ProviderTimelineItem,ProviderPermissionRequest,ProviderEvent,ProviderToolCallDetail} from '@getpaseo/plugin/server/provider';

export function nativeToolDetail(name:string,input:Record<string,any>,result?:any):ProviderToolCallDetail{
 if(name==='Read'||name==='read')return {type:'read',filePath:input.file_path??input.path??'',...(typeof result?.file?.content==='string'?{content:result.file.content}:typeof result?.content==='string'?{content:result.content}:{}),...(input.offset!==undefined?{offset:input.offset}:{}),...(input.limit!==undefined?{limit:input.limit}:{})};
 if(name==='Write'||name==='write')return {type:'write',filePath:input.file_path??input.path??'',content:input.content};
 if(name==='Edit'||name==='edit')return {type:'edit',filePath:input.file_path??input.path??'',oldString:input.old_string??input.oldText,newString:input.new_string??input.newText};
 if(name==='Bash'||name==='bash')return {type:'shell',command:input.command??'',...(typeof result?.stdout==='string'?{output:result.stdout}:{}),...(typeof result?.exitCode==='number'?{exitCode:result.exitCode}:{})};
 if(name==='Grep'||name==='Glob'||name==='grep'||name==='find')return {type:'search',query:input.pattern??input.query??'',toolName:name.toLowerCase()==='glob'?'glob':'grep'};
 return {type:'unknown',input:input as any,output:result??null};
}
export type NativeTuiEvent=Exclude<ProviderEvent,{type:'catalog'}|{type:'sessions'}>;
export class NativeTuiState{
 nativeSessionId?:string;model?:string;mode?:string;turnId?:string;
 items=new Map<string,ProviderTimelineItem>();permissions=new Map<string,ProviderPermissionRequest>();
 tools=new Map<string,{name:string;input:Record<string,any>}>();
 private batches=new Set<string>();private nativeMessage?:string;
 constructor(public readonly kind:'claude'|'pi',private emit:(event:any)=>void){}
 snapshot(){return {nativeSessionId:this.nativeSessionId,model:this.model,mode:this.mode,turnId:this.turnId,items:[...this.items.values()],permissions:[...this.permissions.values()]};}
 private item(item:ProviderTimelineItem){this.items.set(item.id,item);this.emit({type:'timeline.item',item,timestamp:new Date().toISOString()});}
 start(){if(!this.turnId){this.turnId=randomUUID();this.emit({type:'session.turn',turnId:this.turnId,state:'started'});}return this.turnId;}
 prompt(text:string,clientMessageId:string){this.start();this.item({type:'user_message',id:'user:'+clientMessageId,messageId:clientMessageId,clientMessageId,text});}
 finish(state:'completed'|'failed'|'canceled'='completed',message?:string){
  for(const item of this.items.values())if(item.type==='tool_call'&&item.status==='running')this.item({...item,status:'canceled',error:null});
  for(const permission of this.permissions.values())this.emit({type:'session.permission_resolved',permissionId:permission.id});this.permissions.clear();
  if(this.turnId)this.emit({type:'session.turn',turnId:this.turnId,state,...(message?{error:{message}}:{})});this.turnId=undefined;
 }
 resolvePermission(id:string){if(this.permissions.delete(id))this.emit({type:'session.permission_resolved',permissionId:id});}
 claudeHook(p:any){
  if(this.nativeSessionId&&p.session_id!==this.nativeSessionId)throw Error('The native CLI changed sessions; this view will not follow a replacement');
  if(p.session_id)this.nativeSessionId=p.session_id;
  if(p.model)this.model=p.model;if(p.permission_mode)this.mode=p.permission_mode;
  if(p.hook_event_name==='UserPromptSubmit'){
   this.start();
   const channel=typeof p.prompt==='string'?p.prompt.match(/^<channel source="paseo_native_bridge" paseo_message_id="([a-zA-Z0-9_-]+)">\n([\s\S]*)\n<\/channel>$/):undefined;
   const accepted=channel?this.items.get('user:'+channel[1]):undefined;
   // Claude reports its real channel envelope through this hook as well. Only
   // suppress an echo whose original owner ID AND exact text were accepted here.
   if(!(accepted?.type==='user_message'&&accepted.clientMessageId===channel?.[1]&&accepted.text===channel?.[2]))this.item({type:'user_message',id:'user:'+randomUUID(),text:p.prompt});
  }
  if(p.hook_event_name==='MessageDisplay'){
   const batch=p.message_id+':'+p.index;if(this.batches.has(batch))return;this.batches.add(batch);this.start();
   const id='assistant:'+p.message_id;const before=this.items.get(id);const text=(before?.type==='assistant_message'?before.text:'')+(p.delta??'');
   this.item({type:'assistant_message',id,messageId:p.message_id,text});
  }
  if(p.hook_event_name==='PreToolUse'){
   this.start();this.tools.set(p.tool_use_id,{name:p.tool_name,input:p.tool_input??{}});
   this.item({type:'tool_call',id:'tool:'+p.tool_use_id,callId:p.tool_use_id,name:p.tool_name,detail:nativeToolDetail(p.tool_name,p.tool_input??{}),status:'running',error:null});
  }
  if(['PostToolUse','PostToolUseFailure','PermissionDenied'].includes(p.hook_event_name)){
   const tool=this.tools.get(p.tool_use_id)??{name:p.tool_name,input:p.tool_input??{}};
   const failed=p.hook_event_name!=='PostToolUse';
   if(p.tool_use_id)this.item({type:'tool_call',id:'tool:'+p.tool_use_id,callId:p.tool_use_id,name:tool.name,detail:nativeToolDetail(tool.name,tool.input,p.tool_response),...(failed?{status:'failed',error:p.error??p.reason??'Native tool did not complete'}:{status:'completed',error:null})});
   for(const permission of this.permissions.values())if(permission.metadata?.toolUseId===p.tool_use_id)this.resolvePermission(permission.id);
  }
  if(p.hook_event_name==='Stop'&&!this.items.size&&p.last_assistant_message)this.item({type:'assistant_message',id:'assistant:'+randomUUID(),text:p.last_assistant_message});
 }
 claudePermission(p:any){
  const candidates=[...this.tools.entries()].filter(([id,t])=>t.name===p.tool_name&&(this.items.get('tool:'+id) as any)?.status==='running');
  const tool=candidates.length===1?candidates[0]:undefined;
  const input=tool?.[1].input??{input_preview:p.input_preview??'',description:p.description??''};
  const request:ProviderPermissionRequest={id:p.request_id,name:p.tool_name,kind:'tool',title:p.description??p.tool_name,input,detail:nativeToolDetail(p.tool_name,input),metadata:{...(tool?{toolUseId:tool[0]}:{}),fullInputVerified:!!tool}};
  this.permissions.set(request.id,request);this.emit({type:'session.permission',request});
 }
 piEvent(e:any){
  if(e.type==='agent_start')this.start();
  if(e.type==='message_start'){
   const m=e.message;
   if(m.role==='assistant')this.nativeMessage=randomUUID();
   if(m.role==='user'){
    const text=typeof m.content==='string'?m.content:(m.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
    // A remote submission already has its correlated row; terminal messages do not.
    const latest=[...this.items.values()].at(-1);if(latest?.type!=='user_message'||latest.text!==text)this.item({type:'user_message',id:'user:'+randomUUID(),text});
   }
  }
  if(e.type==='message_update'&&e.assistantMessageEvent?.type==='text_delta'){
   const id='assistant:'+(this.nativeMessage??=randomUUID()),old=this.items.get(id);
   this.item({type:'assistant_message',id,text:(old?.type==='assistant_message'?old.text:'')+(e.assistantMessageEvent.delta??'')});
  }
  if(e.type==='tool_execution_start'){
   this.tools.set(e.toolCallId,{name:e.toolName,input:e.args??{}});
   this.item({type:'tool_call',id:'tool:'+e.toolCallId,callId:e.toolCallId,name:e.toolName,detail:nativeToolDetail(e.toolName,e.args??{}),status:'running',error:null});
  }
  if(e.type==='tool_execution_end'){
   const t=this.tools.get(e.toolCallId)??{name:e.toolName,input:{}};
   this.item({type:'tool_call',id:'tool:'+e.toolCallId,callId:e.toolCallId,name:e.toolName,detail:nativeToolDetail(e.toolName,t.input,e.result),...(e.isError?{status:'failed',error:e.result??'Native tool failed'}:{status:'completed',error:null})});
  }
  if(e.type==='agent_settled')this.finish();
 }
 piQuestion(p:any){
  const question={id:p.id,question:p.title??p.method,options:p.method==='confirm'?['Yes','No']:p.options??[],multiSelect:false};
  const request:ProviderPermissionRequest={id:p.id,name:'Pi '+p.method,kind:'question',title:p.title??p.method,input:{questions:[question]},metadata:{method:p.method}};
  this.permissions.set(p.id,request);this.emit({type:'session.permission',request});
 }
}
