import type {BridgeConfig} from './config.js';
import {connectPaseo} from './paseo.js';
import {setTimeout as delay} from 'node:timers/promises';

/** Resolve through the native provider when available, so both frontends see
 * the same resolution. With the daemon offline, the owner can answer directly. */
export async function respondFromTerminal(config:BridgeConfig,agentId:string|undefined,kind:'pi'|'claude',decision:Record<string,any>,nativeRequests:Array<Record<string,any>>):Promise<boolean>{
 if(!agentId)return false;
 let client:Awaited<ReturnType<typeof connectPaseo>>;
 try{client=await connectPaseo(config);}catch{return false;}
 try{
  const agent=client.agents.ref(agentId);
  const native=kind==='claude'?nativeRequests.find(r=>r.request_id===decision.response?.request_id):nativeRequests.find(r=>r.id===decision.id);
  if(!native)throw Error('This native question was already resolved');
  let request:any;
  for(let i=0;i<20;i++){
   const state=await agent.refresh();
   request=state?.agent.pendingPermissions?.find(p=>kind==='pi'?p.id===native.id:typeof native.request?.tool_use_id==='string'&&p.metadata?.toolUseId===native.request.tool_use_id);
   if(request)break;
   await delay(100);
  }
  if(!request)throw Error('No matching native Paseo permission is pending. Refresh /pending or answer in Paseo.');
  let response:any;
  if(kind==='claude')response=decision.response.response;
  else if(decision.cancelled)response={behavior:'deny',message:'Dismissed by the user in Herdr'};
  else{
   const questions=request.input?.questions;
   const key=Array.isArray(questions)?questions[0]?.id??request.id:request.id;
   const value=typeof decision.confirmed==='boolean'?(decision.confirmed?'Yes':'No'):decision.value;
   response={behavior:'allow',updatedInput:{answers:{[key]:value}}};
  }
  await agent.respondToPermission({requestId:request.id,response});
  return true;
 }finally{await client.close();}
}
