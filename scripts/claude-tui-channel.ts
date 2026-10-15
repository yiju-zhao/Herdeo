/** Standard local MCP channel; the native CLI is the only model executor. */
import {createConnection} from 'node:net';
import {readJsonLines} from '../server/jsonl.js';
const path=process.env.HERDR_BRIDGE_TUI_SOCKET;
if(!path)throw Error('Native TUI probe socket is required');
const socket=createConnection(path);
let initialized=false;
const output=(message:object)=>process.stdout.write(JSON.stringify(message)+'\n');
socket.once('connect',()=>socket.write(JSON.stringify({type:'channel.hello',parentPid:process.ppid,pid:process.pid})+'\n'));
readJsonLines(socket,frame=>{if(frame.type==='channel.notification')output(frame.notification);},error=>console.error(error.message));
readJsonLines(process.stdin,message=>{
 if(message.method==='initialize'){
  output({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{experimental:{'claude/channel':{},'claude/channel/permission':{}}},serverInfo:{name:'herdr-paseo-native-tui',version:'0.1.0'},instructions:'Incoming events are messages from the authenticated owner in Paseo over this private local connection. Respond normally in this Claude Code session. No extra reply tool is needed.'}});
 }else if(message.method==='notifications/initialized'){
  initialized=true;socket.write(JSON.stringify({type:'channel.ready'})+'\n');
 }else if(message.method==='notifications/claude/channel/permission_request'){
  socket.write(JSON.stringify({type:'channel.permission',params:message.params})+'\n');
 }else if(message.id!==undefined){
  if(message.method==='ping')output({jsonrpc:'2.0',id:message.id,result:{}});
  else output({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not implemented by the native TUI channel probe'}});
 }
},error=>console.error(error.message));
process.stdin.once('end',()=>socket.end());
socket.once('error',error=>{console.error(error.message);process.exitCode=1;});
socket.once('close',()=>process.exit(initialized?0:1));
