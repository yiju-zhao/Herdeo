import {resolve} from 'node:path';
import type {BridgeConfig} from './config.js';
import {connectPaseo,connectPaseoDriver,includeKnownAgents} from './paseo.js';
import {loadTuiSession,listTuiSessions,assertTuiSession,sameTuiConversation,saveTuiSession,resolveLiveTuiSession,loadConversationTuiHistory,type TuiSession} from './tui-session.js';
import {resumeWorkspace} from './resume-workspace.js';

function persistenceKey(value?:string){try{if(value?.startsWith('plugin:'))return JSON.parse(value.slice(7)).data?.key;}catch{}return undefined;}

/** A new terminal explicitly resumes a vendor session; archive alone never reopens it. */
export async function registerTuiSession(cfg:BridgeConfig,state:TuiSession){
 await assertTuiSession(cfg,state);
 if(!state.ready||!state.nativeSessionId)throw Error('Native terminal is not ready');
 const model=state.model??(state.kind==='claude'?'native':undefined);
 if(!model||model==='unknown/unknown')throw Error('The native model account is not configured');
 const client=await connectPaseo(cfg);let driver:Awaited<ReturnType<typeof connectPaseoDriver>>|undefined;
 try{
  if(state.kind==='claude'&&!((await client.providers.listModels('claude-terminal',{cwd:state.cwd})).models??[]).some(m=>m.id==='native'))throw Error('The Paseo provider has not loaded the native resume update yet');
  const listed=[];let cursor:string|undefined;
  do{const page=await client.agents.list({filter:{includeArchived:true},page:{limit:100,cursor}});listed.push(...page.entries.map(e=>e.agent));cursor=page.pageInfo.nextCursor??undefined;}while(cursor);
  const previous=(await listTuiSessions(cfg,state.kind)).filter(old=>sameTuiConversation(old,state));
  const candidates=(await includeKnownAgents(client,listed,previous.map(old=>old.paseoAgentId))).filter(agent=>agent.provider===state.kind+'-terminal'&&resolve(agent.cwd)===resolve(state.cwd)&&(!agent.labels?.['herdr.native-session-id']||agent.labels['herdr.native-session-id']===state.nativeSessionId));
  let priorTitle:string|undefined;
  for(const agent of candidates.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))){
   const key=persistenceKey(agent.persistence?.sessionId)??agent.labels?.['herdr.native-tui'];if(typeof key!=='string')continue;
   let old;try{old=await loadTuiSession(cfg,key);}catch{continue;}
   if(!sameTuiConversation(old,state))continue;
   if(key===state.key){state.paseoAgentId=agent.id;delete state.registrationError;await saveTuiSession(cfg,state);return agent.id;}
   if(agent.status==='running'||agent.pendingPermissions?.length)throw Error('The previous Paseo view still has an active turn or permission');
   let oldLive=false;try{await assertTuiSession(cfg,old);oldLive=true;}catch{}
   if(oldLive)throw Error('The previous native terminal is still live; close it before resuming this conversation elsewhere');
   if((await resolveLiveTuiSession(cfg,old)).key!==state.key)throw Error('This conversation resolved to another live terminal');
   await loadConversationTuiHistory(cfg,state);
   driver??=await connectPaseoDriver(cfg);
   if(!await resumeWorkspace(client,driver,agent.workspaceId)){priorTitle??=agent.title??undefined;continue;}
   // The official refresh operation unarchives the stored ID and asks this
   // provider to reattach by native identity. It does not submit a prompt.
   try{await driver.refreshAgent(agent.id);}catch(error){
    // A failed restore must not turn an archived record into a broken visible
    // card. Do not roll back a successful rebind or a concurrent user turn.
    if(agent.archivedAt){const current=(await client.agents.ref(agent.id).refresh())?.agent;if(current&&!current.archivedAt&&current.status!=='running'&&!current.pendingPermissions?.length&&persistenceKey(current.persistence?.sessionId)===key)await client.agents.ref(agent.id).archive();}
    throw error;
   }
   await driver.updateAgent(agent.id,{labels:{...agent.labels,'herdr.native-tui':state.key,'herdr.native-session-id':state.nativeSessionId}});
   state.paseoAgentId=agent.id;delete state.registrationError;await saveTuiSession(cfg,state);return agent.id;
  }
  if(state.kind==='pi'&&state.models?.length)await client.providers.refresh({providers:['pi-terminal'],cwd:state.cwd});
  const agent=await client.agents.create({idempotencyKey:'native-tui:'+state.key,cwd:state.cwd,config:{provider:state.kind+'-terminal/'+model,options:{nativeKey:state.key}},title:priorTitle??(state.kind==='claude'?'Claude Code':'Pi'),labels:{'herdr.native-tui':state.key,'herdr.native-session-id':state.nativeSessionId}});
  state.paseoAgentId=agent.id;delete state.registrationError;await saveTuiSession(cfg,state);return agent.id;
 }finally{await driver?.close();await client.close();}
}
