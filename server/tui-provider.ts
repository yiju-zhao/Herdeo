import {createConnection,type Socket} from 'node:net';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {negotiateProviderCapabilities,type ProviderRegistration,type ProviderEvent,type ProviderInput,type ProviderModel} from '@getpaseo/plugin/server/provider';
import type {BridgeConfig} from './config.js';
import {connectPaseo} from './paseo.js';
import {readJsonLines} from './jsonl.js';
import {loadTuiSession,listTuiSessions,launchTuiSession,assertTuiSession,validateTuiSession,loadTuiHistory,loadConversationTuiHistory,resolveLiveTuiSession,tuiRequest,type TuiSession,type TuiKind} from './tui-session.js';

export function createTuiProvider(cfg:BridgeConfig,kind:TuiKind):ProviderRegistration{
 const capabilities=['prompt.message','session.persistence','session.list','permission',...(kind==='pi'?['session.configure']:[])];
 return {id:kind+'-terminal',label:kind==='claude'?'Claude Code · 原生终端':'Pi · 原生终端',description:'Use the original interactive CLI and the same live session in Paseo.',
  async connect(request){
   const negotiated=negotiateProviderCapabilities(request.capabilities,capabilities),listeners=new Set<(event:ProviderEvent)=>void>();
   const views=new Map<string,{state:TuiSession;socket?:Socket;readOnly?:boolean}>();let closed=false;
   const emit=(event:any)=>{if(!closed)for(const listener of listeners)listener(event);};
   const catalog=async(cwd?:string)=>{
    const sessions=await listTuiSessions(cfg,kind);let models:ProviderModel[]=[];
    if(kind==='pi')models=sessions.flatMap(s=>s.models??[]).filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i);
    if(!models.length){const client=await connectPaseo(cfg);try{const native=(await client.providers.listModels(kind,{cwd})).models??[];models=native.map(m=>({id:m.id,label:m.label??m.id,...(m.description?{description:m.description}:{}),...(m.isDefault?{isDefault:true}:{})}));}finally{await client.close();}}
    if(kind==='claude'&&!models.some(m=>m.id==='native'))models.push({id:'native',label:'使用原生 Claude 当前模型',description:'Model selection stays in the original Claude terminal.'});
    return {models,modes:[],defaultModel:models.find(m=>m.isDefault)?.id??models[0]?.id};
   };
   const configState=async(model?:string,cwd?:string)=>({model:model??(kind==='claude'?'native':undefined),...await catalog(cwd),thinkingOptions:[],settings:[]});
   async function dispatch(input:ProviderInput){
    if(input.type==='catalog'){emit({type:'catalog',requestId:input.requestId,catalog:await catalog(input.cwd)});return;}
    if(input.type==='sessions'){const sessions=await listTuiSessions(cfg,kind);emit({type:'sessions',requestId:input.requestId,sessions:sessions.map(s=>({persistence:{version:1,data:{key:s.key}},cwd:s.cwd,title:kind==='claude'?'Claude Code':'Pi'}))});return;}
    if(input.type==='session.open'){
     const saved=input.persistence?.data as any;const key=saved?.key??input.config.providerOptions?.nativeKey;
     let state=typeof key==='string'?await loadTuiSession(cfg,key):await launchTuiSession(cfg,kind,input.config.cwd,{model:input.config.model,mode:input.config.mode,autoRegister:false});
     if(state.kind!==kind)throw Error('This native binding belongs to a different provider');
     validateTuiSession(cfg,state);
     try{if(input.config.env.HERDR_BRIDGE_TUI_HISTORY==='1')throw Error('Read-only history requested');state=await resolveLiveTuiSession(cfg,state);}catch{
      // Saved conversations remain readable after the terminal exits. No stale
      // permission or old PID is made actionable by opening this history view.
      const history=await loadTuiHistory(cfg,state);
      const items=input.history==='replay'?await loadConversationTuiHistory(cfg,state):[];
      views.set(input.sessionId,{state,readOnly:true});
      emit({type:'session.opened',requestId:input.requestId,sessionId:input.sessionId,capabilities:negotiated.filter(c=>c==='session.persistence'||c==='session.list'),restoration:'core',persistence:{version:1,data:{key:state.key}},cwd:state.cwd,title:input.config.title??(kind==='claude'?'Claude Code':'Pi')});
      emit({type:'session.config',sessionId:input.sessionId,config:{model:history.model,models:history.model?[{id:history.model,label:history.model}]:[],modes:[],thinkingOptions:[],settings:[]}});
      for(const item of items)emit({type:'timeline.item',sessionId:input.sessionId,item});
      emit({type:'session.ready',requestId:input.requestId,sessionId:input.sessionId});return;
     }
     const priorHistory=input.history==='replay'?await loadConversationTuiHistory(cfg,state):[];
     const socket=createConnection(state.socket);views.set(input.sessionId,{state,socket});let readyView=false;const buffered:any[]=[];
     await new Promise<void>((ready,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Native terminal subscription timed out')),10000);
      socket.once('error',reject);socket.once('connect',()=>socket.write(JSON.stringify({type:'tui.subscribe',key:state.key,expectedSessionId:state.nativeSessionId,paseoAgentId:input.config.env.HERDR_BRIDGE_PASEO_AGENT_ID})+'\n'));
      readJsonLines(socket,async frame=>{
       if(frame.error){reject(Error(frame.error));emit({type:'session.runtime_failed',sessionId:input.sessionId,error:{message:frame.error}});return;}
       if(frame.type==='tui.snapshot'){
        clearTimeout(timeout);
        Object.assign(state,frame.snapshot.state);
        emit({type:'session.opened',requestId:input.requestId,sessionId:input.sessionId,capabilities:negotiated,restoration:'core',persistence:{version:1,data:{key:state.key}},cwd:state.cwd,title:input.config.title??(kind==='claude'?'Claude Code':'Pi')});
        emit({type:'session.config',sessionId:input.sessionId,config:await configState(frame.snapshot.model??state.model,state.cwd)});
        if(input.history==='replay'){const history=new Map(priorHistory.map(item=>[item.id,item]));for(const item of frame.snapshot.items??[])history.set(item.id,item);for(const item of history.values())emit({type:'timeline.item',sessionId:input.sessionId,item});}
        for(const permission of frame.snapshot.permissions??[])emit({type:'session.permission',sessionId:input.sessionId,request:permission});
        emit({type:'session.ready',requestId:input.requestId,sessionId:input.sessionId});readyView=true;for(const event of buffered.splice(0))emit({...event,sessionId:input.sessionId});ready();
       }else if(frame.type==='tui.event'){if(readyView)emit({...frame.event,sessionId:input.sessionId});else buffered.push(frame.event);}
       else if(frame.type==='tui.exited')emit({type:'session.closed',sessionId:input.sessionId});
      },reject);
     });return;
    }
    if(!('sessionId'in input))throw Error('This native terminal operation is not supported');
    const view=views.get(input.sessionId);if(!view)throw Error('The native terminal view is not open');
    if(input.type==='session.close'){view.socket?.destroy();views.delete(input.sessionId);emit({type:'session.closed',sessionId:input.sessionId});emit({type:'request.completed',requestId:input.requestId});return;}
    if(view.readOnly)throw Error('This is saved history. Resume the original conversation in Herdr to continue.');
    await assertTuiSession(cfg,view.state);
    if(input.type==='session.prompt'){
     if(input.prompt.input.type!=='message'||input.prompt.input.content.some(c=>c.type!=='text')||input.prompt.delivery==='steer')throw Error('Use a text message to an idle native session');
     const text=input.prompt.input.content.map(c=>c.type==='text'?c.text:'').join('\n');
     if(text.trimStart().startsWith('/'))throw Error('Run native slash commands in the original terminal');
     const result=await tuiRequest(view.state,'prompt',{text,clientMessageId:input.prompt.clientMessageId});
     emit({type:'session.prompt_result',sessionId:input.sessionId,clientMessageId:input.prompt.clientMessageId,result:{type:'turn',turnId:result.turnId}});return;
    }
    if(input.type==='session.permission'){await tuiRequest(view.state,'permission',{id:input.permissionId,response:input.response});return;}
    if(input.type==='session.interrupt'){await tuiRequest(view.state,'interrupt');emit({type:'request.completed',requestId:input.requestId});return;}
    if(input.type==='session.configure'&&kind==='pi'){const result=await tuiRequest(view.state,'configure',input.changes);emit({type:'session.config',sessionId:input.sessionId,config:await configState(result.model,view.state.cwd)});emit({type:'request.completed',requestId:input.requestId});return;}
    throw Error('Use the native CLI for this control');
   }
   return {version:1,capabilities:negotiated,onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener);},async send(input){try{await dispatch(input);}catch(error){const detail={message:(error as Error).message};if(input.type==='session.prompt')emit({type:'session.prompt_result',sessionId:input.sessionId,clientMessageId:input.prompt.clientMessageId,result:{type:'failed',error:detail}});else if('requestId'in input)emit({type:'request.failed',requestId:input.requestId,error:detail});else if('sessionId'in input)emit({type:'session.runtime_failed',sessionId:input.sessionId,error:detail});}},async close(){closed=true;for(const view of views.values())view.socket?.destroy();views.clear();listeners.clear();}};
  }
 };
}
