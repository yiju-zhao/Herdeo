import type {PaseoClient} from '@getpaseo/client';
import type {DaemonClient} from '@getpaseo/client/internal/daemon-client';

/** Decide whether the original card can become visible before unarchiving it.
 * A deliberately removed project needs a new view, never a storage-file edit. */
export async function resumeWorkspace(client:Pick<PaseoClient,'workspaces'>,driver:Pick<DaemonClient,'inspectWorkspaceRecovery'|'restoreWorkspace'>,workspaceId?:string){
 if(!workspaceId)return false;
 if(await client.workspaces.ref(workspaceId).refresh())return true;
 const recovery=await driver.inspectWorkspaceRecovery(workspaceId);
 if(recovery.kind==='unavailable'){
  if(recovery.reason==='project_not_found')return false;
  throw Error('The original workspace cannot be restored: '+recovery.message);
 }
 await driver.restoreWorkspace(workspaceId);
 if(!await client.workspaces.ref(workspaceId).refresh())throw Error('The restored workspace is not visible yet; retry native registration');
 return true;
}
