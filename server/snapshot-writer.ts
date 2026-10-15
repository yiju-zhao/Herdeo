import {writeFile,rename} from 'node:fs/promises';

/** Bound disk work to the latest snapshot, even when a model emits fast deltas. */
export class SnapshotWriter {
 private dirty=false;
 private timer?:ReturnType<typeof setTimeout>;
 private pending?:Promise<void>;
 constructor(private file:string,private snapshot:()=>unknown,private write=(file:string,value:string)=>writeFile(file,value,{mode:0o600}),private replace=rename){}
 schedule(){
  this.dirty=true;
  if(!this.timer&&!this.pending)this.timer=setTimeout(()=>{this.timer=undefined;void this.drain().catch(()=>{});},40);
 }
 async flush(){
  this.dirty=true;
  if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
  await this.drain();
 }
 private drain():Promise<void>{
  if(this.pending)return this.pending;
  const pending=(async()=>{
   while(this.dirty){
    this.dirty=false;
    try{await this.write(this.file+'.tmp',JSON.stringify(this.snapshot()));await this.replace(this.file+'.tmp',this.file);}
    catch(error){this.dirty=true;throw error;}
   }
  })();
  this.pending=pending;
  void pending.finally(()=>{this.pending=undefined;}).catch(()=>{});
  return pending;
 }
}
