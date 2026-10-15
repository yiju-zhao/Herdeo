/** Public Pi extension APIs only; Pi itself continues rendering its real TUI. */
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {readJsonLines} from '../server/jsonl.js';

export default function nativePaseoExtension(pi:any){
 const path=process.env.HERDR_BRIDGE_TUI_SOCKET;if(!path)return;
 const socket=createConnection(path);let connected=false,disconnected=false,ctx:any;
 const queue:string[]=[],dialogs=new Map<string,{method:string;options?:string[];answer:(value:any)=>void}>(),wrapped=new WeakSet<object>();
 const send=(frame:any)=>{if(disconnected)return;const row=JSON.stringify(frame)+'\n';if(connected)socket.write(row);else if(queue.length<1000)queue.push(row);};
 async function state(override?:any){
  const model=override??ctx?.model,available=await Promise.resolve(ctx?.modelRegistry?.getAvailable?.()??[]);
  return {sessionId:ctx?.sessionManager.getSessionId(),sessionFile:ctx?.sessionManager.getSessionFile(),model:model?model.provider+'/'+model.id:undefined,models:available.map((m:any)=>({id:m.provider+'/'+m.id,label:m.name??m.id,...(m.contextWindow?{contextWindowMaxTokens:m.contextWindow}:{})})),thinkingOption:pi.getThinkingLevel?.()};
 }
 function wrapUi(ui:any){
  if(!ui||wrapped.has(ui))return;wrapped.add(ui);
  for(const method of ['select','confirm','input']){
   if(typeof ui[method]!=='function')continue;const original=ui[method].bind(ui);
   ui[method]=async(...args:any[])=>{
    const id=randomUUID(),controller=new AbortController();
    const opts=args[2]??{},signal=opts.signal?AbortSignal.any([opts.signal,controller.signal]):controller.signal;
    const local=original(args[0],args[1],{...opts,signal}).then((value:any)=>({source:'terminal',value}));
    const remote=new Promise<any>(answer=>dialogs.set(id,{method,options:method==='select'?args[1]:undefined,answer:value=>answer({source:'paseo',value})}));
    send({type:'native.question',request:{id,method,title:args[0],...(method==='select'?{options:args[1]}:method==='confirm'?{message:args[1]}:{placeholder:args[1]})}});
    try{const result=await Promise.race([local,remote]);if(result.source==='paseo')controller.abort();send({type:'native.question_resolved',id});return result.value;}
    finally{dialogs.delete(id);}
   };
  }
 }
 socket.once('connect',()=>{connected=true;for(const row of queue.splice(0))socket.write(row);});
 socket.on('error',()=>{});socket.once('close',()=>{connected=false;disconnected=true;queue.length=0;});
 readJsonLines(socket,async frame=>{
  if(frame.type!=='native.request')return;
  try{
   let result:any={};
   if(!ctx)throw Error('Pi session has not initialized');
   if(frame.method==='prompt'){if(!ctx.isIdle())throw Error('Pi is already working');pi.sendUserMessage(frame.params.text);result={accepted:true};}
   else if(frame.method==='abort')ctx.abort();
   else if(frame.method==='answer'){
    const dialog=dialogs.get(frame.params.request.id);if(!dialog)throw Error('The native Pi dialog has already closed');
    const response=frame.params.response;
    if(response.behavior==='deny')dialog.answer(dialog.method==='confirm'?false:undefined);
    else{
     const answers=response.updatedInput?.answers;const value=answers?Object.values(answers)[0]:undefined;
     if(typeof value!=='string')throw Error('An explicit answer is required');
     if(dialog.method==='confirm'){if(!/^(yes|no)$/i.test(value))throw Error('Choose Yes or No');dialog.answer(/^yes$/i.test(value));}
     else{if(dialog.method==='select'&&!dialog.options?.includes(value))throw Error('Choose one of the native Pi options');dialog.answer(value);}
    }
   }else if(frame.method==='configure'){
    const changes=frame.params;
    if(changes.model!==undefined){const models=await Promise.resolve(ctx.modelRegistry.getAvailable());const model=models.find((m:any)=>m.provider+'/'+m.id===changes.model);if(!model||!await pi.setModel(model))throw Error('The selected Pi model is unavailable');}
    if(changes.thinkingOption!==undefined){if(typeof changes.thinkingOption!=='string')throw Error('Choose an explicit native Pi thinking level');pi.setThinkingLevel(changes.thinkingOption);}
    result=await state();send({type:'native.state',state:result});
   }else throw Error('Unsupported native Pi control');
   send({type:'native.response',id:frame.id,result});
  }catch(error){send({type:'native.response',id:frame.id,error:(error as Error).message});}
 },()=>{});
 pi.on('session_start',async(_event:any,context:any)=>{ctx=context;wrapUi(ctx.ui);send({type:'native.ready',pid:process.pid,state:await state()});});
 pi.on('model_select',async(event:any,context:any)=>{ctx=context;send({type:'native.state',state:await state(event.model)});});
 for(const event of ['agent_start','turn_start','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end','turn_end'])pi.on(event,(payload:any,context:any)=>{ctx=context;wrapUi(ctx.ui);send({type:'native.event',event:payload});});
 pi.on('agent_end',(_event:any,context:any)=>{
  ctx=context;const check=()=>{if(ctx.isIdle())send({type:'native.idle'});else setTimeout(check,100).unref();};setTimeout(check,20).unref();
 });
 pi.on('session_shutdown',()=>socket.end());
}
