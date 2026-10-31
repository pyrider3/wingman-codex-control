import {CodexProvider} from './dist/providers/codex.js';
import {DesktopBridge} from './desktop-native.mjs';
import {resolveSession} from './catalog.mjs';
import {completionTracker} from './completion.mjs';
const bridge=new DesktopBridge();
const summary=s=>({id:s.id,threadId:s.threadId,accountId:s.accountId,accountLabel:s.accountLabel,provider:'codex',name:s.title||s.name,cwd:s.cwd,status:!s.desktopOnline?'offline':s.activeTurnId||s.status?.type==='active'?'running':s.status?.type||'notLoaded',createdAt:s.createdAt,updatedAt:s.updatedAt,archived:s.archived,sessionKind:s.sessionKind,hostId:s.accountId,hostName:s.accountLabel,desktopOnline:s.desktopOnline,activeTurnId:s.activeTurnId,ownerClientId:s.ownerClientId,ownerUnavailable:s.ownerUnavailable,lastTurnStatus:s.lastTurnStatus});
CodexProvider.prototype.listSessions=async function(){return (await bridge.list()).sessions;};
CodexProvider.prototype.getSession=async function(id){return summary(await bridge.status(id));};
CodexProvider.prototype.readTranscript=async function(id,limit=50){
 const {session}=resolveSession(id);const items=[];let cursor;
 do{
  const r=await bridge.read(session.id,{turnLimit:10,...cursor?{cursor}:{}});
  const batch=[];
  for(const turn of [...r.turns||[]].reverse())for(const item of turn.items||[]){
   const role=item.type==='agentMessage'?'assistant':item.type==='userMessage'||item.type==='steeringUserMessage'?'user':null;
   if(!role)continue;
   const text=item.text||item.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');
   if(text)batch.push({role,text,turnId:turn.id,itemId:item.id,type:item.type});
  }
  items.unshift(...batch);cursor=r.page?.nextCursor;
 }while(cursor&&items.length<limit);
 return {sessionId:session.id,threadId:session.threadId,accountId:session.accountId,provider:'codex',items:items.slice(-limit),transport:'desktop-account-router'};
};
const submissionLocks=new Map();
async function serialized(id,fn){
 const prior=submissionLocks.get(id)||Promise.resolve();
 const next=prior.catch(()=>{}).then(fn);submissionLocks.set(id,next);
 try{return await next;}finally{if(submissionLocks.get(id)===next)submissionLocks.delete(id);}
}
CodexProvider.prototype.sendMessage=async function(id,text,opts={}){
 const {session}=resolveSession(id);
 return serialized(session.id,async()=>{
  if(!text.trim())throw Error('Message must not be empty');
  const s=await bridge.status(session.id);let job;
  if(opts.originBotId)job=await completionTracker().prepare(session,opts.originBotId,text,await bridge.read(session.id,{includeOutputs:true}));
  try{
   let result;
   if(s.activeTurnId){const r=await bridge.steer(s.id,text);result={sessionId:s.id,threadId:s.threadId,accountId:s.accountId,turnId:r.result?.turnId,status:'inProgress',transport:'desktop-owner-ipc'};}
   else{await bridge.appTool('send_message_to_thread',{threadId:s.id,prompt:text});result={sessionId:s.id,threadId:s.threadId,accountId:s.accountId,status:'inProgress',transport:'desktop-app-tools'};}
   if(job){completionTracker().bind(job,result.turnId);result.completionNotification={jobId:job.id,botId:opts.originBotId,enabled:true};}
   return result;
  }catch(e){completionTracker().submissionError(job,e);throw e;}
 });
};
CodexProvider.prototype.steer=async function(id,text,opts={}){
 const {session}=resolveSession(id);return serialized(session.id,async()=>{
  let job;if(opts.originBotId)job=await completionTracker().prepare(session,opts.originBotId,text,await bridge.read(session.id,{includeOutputs:true}));
  try{const r=await bridge.steer(session.id,text);if(job)completionTracker().bind(job,r.result?.turnId);return {sessionId:session.id,accountId:session.accountId,turnId:r.result?.turnId,accepted:true,transport:'desktop-owner-ipc',...job?{completionNotification:{jobId:job.id,botId:opts.originBotId,enabled:true}}:{}};}
  catch(e){completionTracker().submissionError(job,e);throw e;}
 });
};
CodexProvider.prototype.interrupt=async function(id){const s=await bridge.status(id);if(!s.activeTurnId)return {sessionId:s.id,status:'no_active_turn'};const r=await bridge.interrupt(s.id,s.activeTurnId);return {sessionId:s.id,accountId:s.accountId,turnId:r.interruptedTurnId,status:'interrupted',transport:'desktop-owner-ipc'};};
CodexProvider.prototype.waitTurn=async function(id,opts={}){
 const {session}=resolveSession(id);const deadline=Date.now()+Math.min(opts.timeoutMs||45000,45000);
 do{const s=await bridge.status(session.id);if(!s.activeTurnId)return {sessionId:session.id,status:s.lastTurnStatus||'idle'};await new Promise(r=>setTimeout(r,1000));}while(Date.now()<deadline);
 return {sessionId:session.id,status:'timeout'};
};
CodexProvider.prototype.createSession=async function(){throw Error('This integration controls existing sessions; creating new threads is disabled.');};
CodexProvider.prototype.listApprovals=async function(){throw Error('Approval forwarding has not been implemented in desktop mode.');};
CodexProvider.prototype.resolveApproval=CodexProvider.prototype.listApprovals;
