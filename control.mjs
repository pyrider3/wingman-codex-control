#!/usr/bin/env node
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {localConfig as cfg,selectionPath as selectionFile,stateDir} from './local-runtime.mjs';
import {resolveBot,grokRequest} from './grok-bridge.mjs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const [command='read',...argv]=process.argv.slice(2);
const options={},positional=[];
for(let i=0;i<argv.length;i++){if(['--account','--search','--limit','--archived','--bot'].includes(argv[i])){if(argv[i+1]===undefined)throw Error('Missing value for '+argv[i]);options[argv[i].slice(2)]=argv[++i];}else positional.push(argv[i]);}
const client=new Client({name:'wingman-local-control',version:'2.0.0'});
const invoke=async(name,args)=>{
 const result=await client.callTool({name,arguments:args});
 const text=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n');
 if(result.isError)throw Error(text||'Wingman MCP error');
 return JSON.parse(text);
};
const list=async()=>{const r=await invoke('list_sessions',{provider:'codex'});return r.sessions;};
const resolve=(input,sessions)=>{
 let candidates=sessions.filter(s=>s.id===input||s.threadId===input);
 if(options.account)candidates=candidates.filter(s=>s.accountId===options.account);
 if(candidates.length!==1)throw Error(candidates.length?'Ambiguous session; use account::threadId.':'Unknown session ID. Run list first.');
 return candidates[0];
};
try{
 if(!cfg.token)throw Error('Wingman is not configured. Run node scripts/install.mjs first.');
 if(command==='bots'){const r=await grokRequest({method:'status'});if(!r.ok)throw Error(r.error);console.log(JSON.stringify({bots:r.agents.map(a=>({id:a.id,name:a.name}))},null,2));process.exit(0);}
 if(command==='jobs'){const db=new DatabaseSync(join(stateDir,'completions.sqlite'),{readOnly:true});console.log(JSON.stringify({jobs:db.prepare('SELECT id,session_id AS sessionId,bot_id AS botId,bot_name AS botName,turn_id AS turnId,state,terminal_status AS terminalStatus,delivered_at AS deliveredAt,cancelled_at AS cancelledAt,error FROM jobs ORDER BY created_at DESC LIMIT 50').all()},null,2));db.close();process.exit(0);}
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3847/mcp'),{requestInit:{headers:{Authorization:`Bearer ${cfg.token}`}}}));
 if(['list','accounts','select','selected'].includes(command)){
  const sessions=await list();const accounts=[...new Set(sessions.map(s=>s.accountId))].map(id=>({accountId:id,accountLabel:sessions.find(s=>s.accountId===id).accountLabel,total:sessions.filter(s=>s.accountId===id).length,archived:sessions.filter(s=>s.accountId===id&&s.archived).length,desktopOnline:sessions.find(s=>s.accountId===id).desktopOnline}));
  if(command==='accounts'){console.log(JSON.stringify({accounts,total:sessions.length},null,2));}
  else if(command==='select'){
   if(!positional[0])throw Error('Usage: select account::threadId');
   const chosen=resolve(positional[0],sessions);const tmp=selectionFile+'.tmp';
   writeFileSync(tmp,JSON.stringify({sessionId:chosen.id,selectedAt:new Date().toISOString()}),{mode:0o600});renameSync(tmp,selectionFile);
   console.log(JSON.stringify({selected:chosen},null,2));
  }else if(command==='selected'){
   let saved;try{saved=JSON.parse(readFileSync(selectionFile,'utf8')).sessionId;}catch{saved=cfg.threadId;}
   console.log(JSON.stringify({selected:resolve(saved,sessions)},null,2));
  }else{
   let filtered=sessions;
   if(options.account)filtered=filtered.filter(s=>s.accountId===options.account);
   if(options.search){const query=options.search.toLowerCase();filtered=filtered.filter(s=>[s.name,s.cwd,s.id].some(v=>v?.toLowerCase().includes(query)));}
   if(options.archived&&options.archived!=='all'){if(!['true','false'].includes(options.archived))throw Error('--archived must be all|true|false');filtered=filtered.filter(s=>s.archived===(options.archived==='true'));}
   const limit=options.limit===undefined?filtered.length:Number(options.limit);if(!Number.isInteger(limit)||limit<0)throw Error('--limit must be a nonnegative integer');
   console.log(JSON.stringify({accounts,total:sessions.length,matched:filtered.length,returned:Math.min(limit,filtered.length),sessions:filtered.slice(0,limit)},null,2));
  }
 }else{
  let selected;try{selected=JSON.parse(readFileSync(selectionFile,'utf8')).sessionId;}catch{selected=cfg.threadId;}
  let id=selected;
  if(positional[0]?.includes('::')||/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(positional[0]||''))id=positional.shift();
  const tool={read:'read_transcript',status:'get_session',send:'send_message',resume:'send_message',continue:'send_message',steer:'steer',wait:'wait_turn',interrupt:'interrupt',stop:'interrupt'}[command];
  if(!tool)throw Error('Usage: accounts|list|select|selected|read|status|send|resume|steer|wait|stop [account::threadId] [message]');
  const args={provider:'codex',session_id:id};
  if(['send','resume','continue','steer'].includes(command)){args.text=positional.join(' ');if(!args.text.trim())throw Error('Message is required.');}
  if(options.bot&&['send','resume','continue','steer'].includes(command))args.origin_bot_id=(await resolveBot(options.bot)).id;
  if(command==='read')args.limit=Number(options.limit||12);
  if(command==='wait')args.timeout_ms=45000;
  console.log(JSON.stringify(await invoke(tool,args),null,2));
 }
}catch(e){console.error(e.message);process.exitCode=1;}finally{await client.close()}
