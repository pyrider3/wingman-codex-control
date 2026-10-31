import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync,existsSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {createHash} from 'node:crypto';
export function discoverAccounts(){
 const home=homedir(),roots=new Map();
 const add=(root,info={})=>{try{root=realpathSync(root);if(!existsSync(join(root,'state_5.sqlite')))return;roots.set(root,{...roots.get(root),...info});}catch{}};
 add(join(home,'.codex'));
 if(process.env.CODEX_HOME)add(process.env.CODEX_HOME);
 for(const parent of [join(home,'.local/share'),join(home,'.config')]){
  try{for(const entry of readdirSync(parent,{withFileTypes:true})){if(!entry.isDirectory()||!/codex|chatgpt/i.test(entry.name))continue;const dir=join(parent,entry.name);add(dir);add(join(dir,'codex-home'));}}catch{}
 }
 try{for(const pid of readdirSync('/proc')){
  if(!/^\d+$/.test(pid))continue;
  try{
   if(basename(realpathSync(`/proc/${pid}/exe`))!=='codex')continue;
   const args=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');if(!args.includes('app-server'))continue;
   const env=Object.fromEntries(readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(s=>s.includes('=')).map(s=>{const n=s.indexOf('=');return [s.slice(0,n),s.slice(n+1)];}));
   const root=env.CODEX_HOME||join(home,'.codex');const pipe=env.CODEX_APP_TOOLS_PIPE_PATH;
   add(root,pipe&&existsSync(pipe)?{toolsSocket:pipe,appServerPid:Number(pid)}:{});
  }catch{}
 }}catch{}
 return [...roots].map(([codexHome,info])=>{
  const primary=codexHome===join(home,'.codex');
  const accountId=primary?'default':basename(codexHome)==='codex-home'?basename(dirname(codexHome)):basename(codexHome).replace(/^\./,'')+'-'+createHash('sha256').update(codexHome).digest('hex').slice(0,6);
  return {accountId,label:primary?'默认账号':accountId,codexHome,ipcSocket:join(codexHome,'ipc/ipc.sock'),desktopOnline:!!info.toolsSocket,...info};
 }).sort((a,b)=>a.accountId==='default'?-1:b.accountId==='default'?1:a.accountId.localeCompare(b.accountId));
}
export function catalog(){
 const accounts=discoverAccounts();const sessions=[];
 for(const account of accounts){
  let db;
  try{
   db=new DatabaseSync(join(account.codexHome,'state_5.sqlite'),{readOnly:true});
   const rows=db.prepare('SELECT id,name,title,cwd,created_at,updated_at,archived,source,thread_source,agent_nickname,rollout_path FROM threads ORDER BY updated_at DESC,id').all();
   account.anchorThreadId=rows.find(x=>!x.archived&&x.thread_source==='user')?.id||rows[0]?.id;
   account.sessionCount=rows.length;
   for(const row of rows)sessions.push({
    id:`${account.accountId}::${row.id}`,threadId:row.id,accountId:account.accountId,accountLabel:account.label,
    provider:'codex',name:(row.name||row.title||row.id).split('\n')[0].slice(0,180),cwd:row.cwd,createdAt:row.created_at,updatedAt:row.updated_at,
    archived:!!row.archived,sessionKind:row.thread_source||'unknown',source:row.source,status:account.desktopOnline?'notLoaded':'offline',
    desktopOnline:account.desktopOnline,hostId:account.accountId,hostName:account.label,
   });
  }catch(e){account.error=e.message;account.sessionCount=0;}finally{db?.close()}
 }
 return {accounts,sessions:sessions.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id))};
}
export function resolveSession(input,data=catalog()){
 if(typeof input!=='string'||!input.trim())throw Error('Select an account-qualified session ID first.');
 let matches=data.sessions.filter(s=>s.id===input);
 if(!matches.length)matches=data.sessions.filter(s=>s.threadId===input);
 if(!matches.length)throw Error('Unknown session ID; run list again.');
 if(matches.length>1)throw Error('Session ID exists in multiple accounts; use account::threadId: '+matches.map(s=>s.id).join(', '));
 const session=matches[0],account=data.accounts.find(a=>a.accountId===session.accountId);
 return {account,session};
}
