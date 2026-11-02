import {existsSync} from 'node:fs';
// process.execPath is the resolved binary, so a Homebrew node reports <prefix>/Cellar/<formula>/<version>/bin/node.
// `brew upgrade` deletes that version directory, breaking every script, plist or MCP config that recorded it.
// <prefix>/opt/<formula> is Homebrew's link to the current version and survives upgrades.
export function stableNodePath(execPath:string=process.execPath,exists:(path:string)=>boolean=existsSync):string{
 const match=/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
 if(!match)return execPath;
 const stable=match[1]+'/opt/'+match[2]+'/bin/node';
 return exists(stable)?stable:execPath;
}
// Use this instead of process.execPath wherever a node path is spawned or written to disk.
export const nodeExecutable=stableNodePath();
