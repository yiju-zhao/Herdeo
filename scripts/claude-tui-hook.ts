/** Observe actual Claude hooks without changing text or permission decisions. */
import {createConnection} from 'node:net';
const chunks:Buffer[]=[];
for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const path=process.env.HERDR_BRIDGE_TUI_SOCKET;
if(path){
 try{
  const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  await new Promise<void>(resolve=>{
   const socket=createConnection(path);
   const timer=setTimeout(()=>{socket.destroy();resolve();},500);
   socket.once('connect',()=>socket.write(JSON.stringify({type:'hook.event',payload})+'\n'));
   socket.once('data',()=>socket.end());
   socket.once('error',()=>{});
   socket.once('close',()=>{clearTimeout(timer);resolve();});
  });
 }catch{ /* Failure must not alter the original terminal's behavior. */ }
}
