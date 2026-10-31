import net from 'node:net';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {catalog,resolveSession} from './catalog.mjs';
import {localConfig as cfg} from './local-runtime.mjs';
export const boundThreadId=cfg.threadId; // Backward-compatible default, no longer a restriction.
function pluginPath(account){
 for(const root of [account.codexHome,join(homedir(),'.codex')]){
  const dir=join(root,'plugins/cache/openai-bundled/codex-app-tools');
  try{for(const version of readdirSync(dir).sort().reverse()){const file=join(dir,version,'server.mjs');if(existsSync(file))return file;}}catch{}
 }
 throw Error('Codex desktop app tools plugin is unavailable.');
}
export class DesktopBridge {
 async callAccountTool(account,name,args){
  if(!account.desktopOnline||!account.toolsSocket)throw Error(`账号 ${account.accountId} 的桌面未运行；可列出和读取本地历史，发消息前请启动该账号的 Codex 桌面。`);
  const c=new Client({name:'wingman-multi-account',version:'2.0.0'});
  try{
   await c.connect(new StdioClientTransport({command:process.execPath,args:[pluginPath(account)],env:{...process.env,CODEX_HOME:account.codexHome,CODEX_APP_TOOLS_PIPE_PATH:account.toolsSocket}}));
   await c.listTools();
   const r=await c.callTool({name,arguments:args,_meta:{'openai/threadId':account.anchorThreadId}});
   if(r.isError)throw Error(r.content?.map(x=>x.text||'').join('\n'));
   const text=r.content?.find(x=>x.type==='text')?.text;
   return text?JSON.parse(text):r;
  }finally{await c.close()}
 }
 async appTool(name,args){
  const {account,session}=resolveSession(args.threadId||boundThreadId);
  // Choose an account from its own catalog, never by probing mutations on sockets.
  return this.callAccountTool(account,name,{...args,threadId:session.threadId});
 }
 async list(){
  const data=catalog();
  await Promise.all(data.accounts.map(async account=>{
   if(!account.desktopOnline)return;
   try{
    for(const archived of [false,true]){
     let cursor;const seen=new Set();
     do{
      const page=await this.callAccountTool(account,'list_threads',{mode:'history',source:'codex',archived,limit:50,...cursor?{cursor}:{}});
      for(const live of page.threads||[]){const stored=data.sessions.find(s=>s.accountId===account.accountId&&s.threadId===live.id);if(stored){stored.name=live.title||stored.name;stored.status=live.status==='active'?'running':live.status||stored.status;stored.desktopListed=true;}}
      cursor=page.nextCursor;
      if(cursor){if(seen.has(cursor))throw Error('Repeated desktop history cursor');seen.add(cursor);}
     }while(cursor);
    }
   }catch(e){account.liveStatusError=e.message;}
  }));
  return data;
 }
 async readStored(account,session){
  const child=spawn(process.env.CODEX_BIN||(existsSync('/usr/lib/chatgpt/resources/codex')?'/usr/lib/chatgpt/resources/codex':'codex'),['--no-daemon','app-server'],{env:{...process.env,CODEX_HOME:account.codexHome},stdio:['pipe','pipe','ignore']});
  const pending=new Map();let id=0;
  const rejectAll=e=>{for(const p of pending.values())p.reject(e);pending.clear();};
  child.on('error',rejectAll);child.on('exit',()=>rejectAll(Error('Read-only Codex reader exited')));
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}catch{}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});
  const timeout=setTimeout(()=>{rejectAll(Error('Stored history read timed out'));child.kill();},15000);
  try{
   await request('initialize',{clientInfo:{name:'wingman-history-reader',version:'2.0.0'}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
   const result=await request('thread/read',{threadId:session.threadId,includeTurns:true});
   return {thread:{...result.thread,id:session.threadId,title:session.name,status:{type:'notLoaded'}},turns:[...(result.thread?.turns||[])].reverse(),historySource:'stored'};
  }finally{clearTimeout(timeout);lines.close();child.stdin.end();child.kill();}
 }
 async read(input=boundThreadId,options={}){
  const {account,session}=resolveSession(input);
  let result;
  if(account.desktopOnline){result=await this.callAccountTool(account,'read_thread',{threadId:session.threadId,turnLimit:options.turnLimit||3,includeOutputs:options.includeOutputs===true,...options.includeOutputs?{maxOutputCharsPerItem:20000}:{},...options.cursor?{cursor:options.cursor}:{}});}
  else result=await this.readStored(account,session);
  if(result.thread?.id!==session.threadId)throw Error('Desktop thread mismatch');
  return {...result,accountId:account.accountId,sessionId:session.id,desktopOnline:account.desktopOnline};
 }
 async ipc(action,params,owner,accountId){
  const {account}=resolveSession(`${accountId}::${params.conversationId}`);
  if(!account.desktopOnline)throw Error('Account desktop is offline');
  const sock=net.createConnection(account.ipcSocket);
  const pending=new Map();let buffer=Buffer.alloc(0),clientId='initializing-client';
  const fail=e=>{for(const p of pending.values())p.reject(e);pending.clear();};
  const write=m=>{const b=Buffer.from(JSON.stringify(m));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);sock.write(Buffer.concat([h,b]));};
  sock.on('error',fail);sock.on('close',()=>fail(Error('Desktop IPC disconnected; do not retry mutations automatically')));
  sock.on('data',b=>{try{buffer=Buffer.concat([buffer,b]);while(buffer.length>=4){const n=buffer.readUInt32LE();if(!n||n>16*1024*1024)throw Error('Invalid desktop IPC frame');if(buffer.length<4+n)break;const m=JSON.parse(buffer.subarray(4,4+n));buffer=buffer.subarray(4+n);if(m.type==='response'){pending.get(m.requestId)?.resolve(m);pending.delete(m.requestId)}else if(m.type==='client-discovery-request')write({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:false}});}}catch(e){fail(e);sock.destroy();}});
  await new Promise((resolve,reject)=>{sock.once('connect',resolve);sock.once('error',reject)});
  const request=(method,p,version,targetClientId)=>new Promise((resolve,reject)=>{const requestId=randomUUID();const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Desktop IPC timeout; do not retry mutations automatically'))},12000);pending.set(requestId,{resolve:m=>{clearTimeout(timer);m.resultType==='success'?resolve(m):reject(Error(m.error))},reject:e=>{clearTimeout(timer);reject(e)}});write({type:'request',requestId,sourceClientId:clientId,method,params:p,version,targetClientId,timeoutMs:10000});});
  try{
   const hello=await request('initialize',{clientType:'wingman'},0);clientId=hello.result.clientId;
   const found=await request('thread-owner-discovery',{hostId:'local',conversationId:params.conversationId},1);
   if(action==='owner')return {ownerClientId:found.handledByClientId,...found.result};
   if(owner&&owner!==found.handledByClientId)throw Error('Desktop owner changed');
   const version=action==='thread-follower-interrupt-turn'?4:1;
   const r=await request(action,params,version,found.handledByClientId);return {ownerClientId:found.handledByClientId,...r.result};
  }finally{sock.destroy()}
 }
 async status(input=boundThreadId){
  const {account,session}=resolveSession(input);const r=await this.read(session.id);
  const turn=r.turns?.find(t=>t.status==='inProgress');let owner={};
  if(turn&&account.desktopOnline){try{owner=await this.ipc('owner',{conversationId:session.threadId},undefined,account.accountId);}catch(e){owner={ownerUnavailable:e.message};}}
  return {...r.thread,id:session.id,threadId:session.threadId,accountId:account.accountId,accountLabel:account.label,archived:session.archived,sessionKind:session.sessionKind,desktopOnline:account.desktopOnline,...owner,activeTurnId:turn?.id,lastTurnStatus:r.turns?.[0]?.status};
 }
 async steer(input,text){
  if(!text.trim())throw Error('Message must not be empty');
  const s=await this.status(input);if(!s.activeTurnId)throw Error('No active desktop turn');if(!s.ownerClientId)throw Error('Active turn has no reachable desktop owner');
  return this.ipc('thread-follower-steer-turn',{conversationId:s.threadId,input:[{type:'text',text,text_elements:[]}],clientUserMessageId:randomUUID(),restoreMessage:{cwd:s.cwd,prompt:text,input:[{type:'text',text,text_elements:[]}],context:{}}},s.ownerClientId,s.accountId);
 }
 async interrupt(input,expectedTurnId){
  const {account,session}=resolveSession(input);if(!expectedTurnId)throw Error('expectedTurnId required');
  return this.ipc('thread-follower-interrupt-turn',{conversationId:session.threadId,mode:'user-stop',expectedTurnId},undefined,account.accountId);
 }
}
if(process.argv[1]?.endsWith('/desktop-native.mjs')){
 const b=new DesktopBridge();const [cmd='status',id=boundThreadId,...args]=process.argv.slice(2);
 try{console.log(JSON.stringify(cmd==='list'?await b.list():cmd==='status'?await b.status(id):cmd==='read'?await b.read(id):cmd==='steer'?await b.steer(id,args.join(' ')):cmd==='send'?await b.appTool('send_message_to_thread',{threadId:id,prompt:args.join(' ')}):{error:'Unknown command'},null,2))}catch(e){console.error(e.message);process.exitCode=1}
}
