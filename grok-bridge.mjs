import net from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {enrichRosterStatus} from './roster-evidence.mjs';
export function grokRequest(request){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(join(homedir(),'.local/state/noctalia-grok-bridge/bridge.sock'));
  let text='',written=false,done=false;
  const fail=message=>{if(done)return;done=true;socket.destroy();const e=Error(message);e.delivery=written?'uncertain':'not_sent';reject(e);};
  socket.setEncoding('utf8');socket.setTimeout(26000,()=>fail('Grok Bot bridge timeout'));
  socket.on('connect',()=>{written=true;socket.end(JSON.stringify(request)+'\n');});
  socket.on('data',chunk=>{text+=chunk;if(text.length>1000000)fail('Grok Bot bridge reply too large');});
  socket.on('end',()=>{if(done)return;try{const value=JSON.parse(text);done=true;resolve(request.method==='status'?enrichRosterStatus(value):value);}catch{fail('Invalid Grok Bot bridge reply');}});
  socket.on('error',e=>fail(e.message));
 });
}
export async function resolveBot(value){
 const status=await grokRequest({method:'status'});
 if(!status.ok||!status.complete)throw Error('Grok Bot roster is not ready; origin bot cannot be verified.');
 const matches=status.agents.filter(a=>a.id===value||a.name===value);
 if(matches.length!==1)throw Error('Specify the exact origin bot ID (or a unique bot name).');
 return {...matches[0],accountScope:status.accountScope||null};
}
