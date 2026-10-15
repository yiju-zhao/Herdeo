export interface ReleaseCommit{sha:string;subject:string;body:string}
export function nextRelease(version:string,commits:ReleaseCommit[]){
 if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error('Invalid release version');
 let level=0;
 const releasable=commits.filter(commit=>{
  const match=commit.subject.match(/^([a-z]+)(?:\([^\r\n()]+\))?(!)?:\s+\S/u);
  if(!match)return false;
  const breaking=!!match[2]||/^BREAKING[ -]CHANGE:\s+\S/mu.test(commit.body);
  const change=breaking?3:match[1]==='feat'?2:match[1]==='fix'||match[1]==='perf'?1:0;
  level=Math.max(level,change);return change>0;
 });
 if(!level)return undefined;
 const [major,minor,patch]=version.split('.').map(Number);
 if([major,minor,patch].some(v=>v===undefined||!Number.isInteger(v)||v<0))throw Error('Invalid release version');
 return {version:level===3?`${major!+1}.0.0`:level===2?`${major}.${minor!+1}.0`:`${major}.${minor}.${patch!+1}`,commits:releasable};
}
