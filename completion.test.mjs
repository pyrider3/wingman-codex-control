import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompletionTracker} from './completion.mjs';
const bot='11111111-1111-4111-8111-111111111111',session={id:'second::thread-1'},before={turns:[{id:'old',status:'completed',items:[]}]};
const turn=(id,status,text='expected request')=>({id,status,items:[{type:'userMessage',content:[{type:'text',text}]},{type:'agentMessage',text:'任务结果'}]});
function harness(){
 const dir=mkdtempSync(join(tmpdir(),'wingman-completion-'));const state={turns:[],sent:[],offline:false,failure:null,now:1000,scope:'scope-A',roster:null,reads:0};
 const options={file:join(dir,'jobs.sqlite'),now:()=>state.now,bridge:{read:async()=>{state.reads++;return {turns:state.turns};}},verifyBot:async id=>({id,name:'Origin Bot',accountScope:state.scope}),request:async req=>{if(req.method==='status'){if(state.offline)throw Error('offline');return state.roster||{ok:true,complete:true,accountScope:state.scope,agents:[{id:bot},{id:'other'}],rosterEvidence:{complete:true,accountScope:state.scope,knownBotIds:[bot,'other']}};}state.sent.push(req);if(state.failure)throw state.failure;return {ok:true,nonce:'sent-once'};}};
 const tracker=new CompletionTracker(options);return {dir,state,options,tracker,clean:()=>{tracker.close();rmSync(dir,{recursive:true,force:true});}};
}
test('completion routes to the originating bot once, even if a newer turn already exists',async()=>{
 const h=harness();try{const j=await h.tracker.prepare(session,bot,'expected request',before);h.tracker.bind(j,'owned');h.state.turns=[turn('newer','completed','unrelated'),turn('owned','completed')];await h.tracker.tick();await h.tracker.tick();assert.equal(h.state.sent.length,1);assert.equal(h.state.sent[0].agentId,bot);assert.match(h.state.sent[0].text,/任务结果/);assert.equal(h.tracker.rows()[0].state,'delivered');}finally{h.clean();}
});
test('unrelated new turns cannot bind a pending submission',async()=>{
 const h=harness();try{await h.tracker.prepare(session,bot,'expected request',before);h.state.turns=[turn('new','completed','another request')];await h.tracker.tick();assert.equal(h.state.sent.length,0);assert.equal(h.tracker.rows()[0].state,'pending');h.state.turns=[turn('owned','completed')];await h.tracker.tick();assert.equal(h.state.sent.length,1);}finally{h.clean();}
});
test('offline notification is durable and delivered after service restart; delivered work is not replayed',async()=>{
 const h=harness();let second;try{const j=await h.tracker.prepare(session,bot,'expected request',before);h.tracker.bind(j,'owned');h.state.turns=[turn('owned','completed')];h.state.offline=true;await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'delivery_pending');h.tracker.close();second=new CompletionTracker(h.options);h.state.offline=false;await second.tick();await second.tick();assert.equal(h.state.sent.length,1);assert.equal(second.rows()[0].state,'delivered');}finally{second?.close();rmSync(h.dir,{recursive:true,force:true});}
});
test('ambiguous send result is never automatically resent',async()=>{
 const h=harness();try{const j=await h.tracker.prepare(session,bot,'expected request',before);h.tracker.bind(j,'owned');h.state.turns=[turn('owned','completed')];h.state.failure=Object.assign(Error('connection lost after submission'),{delivery:'uncertain'});await h.tracker.tick();h.state.failure=null;await h.tracker.tick();assert.equal(h.state.sent.length,1);assert.equal(h.tracker.rows()[0].state,'uncertain');}finally{h.clean();}
});
test('repeated instructions in the same owned turn coalesce into one completion report',async()=>{
 const h=harness();try{const initial={turns:[turn('owned','inProgress')]};const a=await h.tracker.prepare(session,bot,'one',initial);h.tracker.bind(a,'owned');const b=await h.tracker.prepare(session,bot,'two',initial);assert.equal(a.id,b.id);h.state.turns=[turn('owned','interrupted')];await h.tracker.tick();assert.equal(h.state.sent.length,1);assert.match(h.state.sent[0].text,/已停止/);}finally{h.clean();}
});

test('desktop delegated messages bind using their function output, not a guessed latest turn',async()=>{
 const h=harness();try{await h.tracker.prepare(session,bot,'expected request',before);h.state.turns=[{id:'delegated',status:'completed',items:[{type:'functionCallOutput',name:'send_message_to_thread',namespace:'codex_app',output:{text:'<input>expected request</input>'}},{type:'agentMessage',text:'callback OK'}]}];await h.tracker.tick();assert.equal(h.state.sent.length,1);assert.equal(h.tracker.rows()[0].turnId,'delegated');}finally{h.clean();}
});
test('a pending steer cannot report an old turn before the new instruction was admitted',async()=>{
 const h=harness();try{const original=turn('owned','inProgress','old work');await h.tracker.prepare(session,bot,'expected request',{turns:[original]});h.state.turns=[turn('owned','completed','old work')];await h.tracker.tick();assert.equal(h.state.sent.length,0);h.state.turns=[turn('owned','completed','old work\nexpected request')];await h.tracker.tick();assert.equal(h.state.sent.length,1);}finally{h.clean();}
});

const roster=(ids,scope='scope-A',known=ids)=>({ok:true,complete:true,accountScope:scope,agents:ids.map(id=>({id})),rosterEvidence:{complete:true,accountScope:scope,knownBotIds:known}});
test('deleted recipient cancels all unsent subscriptions, clears payloads, and never touches the live Codex turn',async()=>{
 const h=harness();try{
  const done=await h.tracker.prepare(session,bot,'done',before);h.tracker.bind(done,'done');h.state.turns=[turn('done','completed')];await h.tracker.tick();
  const queued=await h.tracker.prepare(session,bot,'queued',before);h.tracker.bind(queued,'queued');h.state.turns=[turn('queued','completed')];await h.tracker.observe();
  const watching=await h.tracker.prepare(session,bot,'watching',before);h.tracker.bind(watching,'live');
  const pending=await h.tracker.prepare(session,bot,'not-yet-bound',before);
  h.state.turns=[turn('live','inProgress','watching')];const live=structuredClone(h.state.turns),reads=h.state.reads;
  h.state.roster=roster(['other']);await h.tracker.tick();await h.tracker.tick();
  for(const job of [queued,watching,pending]){const row=h.tracker.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);assert.equal(row.state,'recipient_deleted');assert.equal(row.prompt,'');assert.equal(row.summary,null);assert.ok(row.cancelled_at);}
  assert.equal(h.tracker.rows().find(r=>r.id===done.id).state,'delivered');assert.equal(h.state.sent.length,1);assert.equal(h.state.reads,reads);assert.deepEqual(h.state.turns,live);
 }finally{h.clean();}
});
test('offline, incomplete and inconsistent rosters do not cancel pending notifications',async()=>{
 const h=harness();try{
  const job=await h.tracker.prepare(session,bot,'request',before);h.tracker.bind(job,'live');h.state.turns=[turn('live','inProgress')];
  h.state.offline=true;await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'watching');h.state.offline=false;
  h.state.roster={...roster(['other']),complete:false};await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'watching');
  h.state.roster=roster([bot],'scope-A',[]);await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'watching');
  h.state.roster={ok:true,complete:true,agents:[]};await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'watching');
 }finally{h.clean();}
});
test('hidden bots and another logged-in account cannot be mistaken for deletion',async()=>{
 const h=harness();try{
  const job=await h.tracker.prepare(session,bot,'request',before);h.tracker.bind(job,'live');h.state.turns=[turn('live','inProgress')];
  h.state.roster=roster(['other'],'scope-A',[bot,'other']);await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'watching');
  h.state.roster=roster(['other'],'scope-B');await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'watching');
 }finally{h.clean();}
});
test('deletion cancellation survives restart and does not cancel a different bot subscription',async()=>{
 const h=harness();let second;try{
  const removed=await h.tracker.prepare(session,bot,'request',before);h.tracker.bind(removed,'live');
  const kept=await h.tracker.prepare(session,'other','request',before);h.tracker.bind(kept,'live');h.state.turns=[turn('live','inProgress')];
  h.state.roster=roster(['other']);await h.tracker.tick();h.tracker.close();second=new CompletionTracker(h.options);h.state.turns=[turn('live','completed')];await second.tick();
  assert.equal(second.rows().find(r=>r.id===removed.id).state,'recipient_deleted');assert.equal(second.rows().find(r=>r.id===kept.id).state,'delivered');assert.deepEqual(h.state.sent.map(r=>r.agentId),['other']);
 }finally{second?.close();rmSync(h.dir,{recursive:true,force:true});}
});
test('legacy unscoped records are only enrolled after their bot is present, never guessed deleted',async()=>{
 const h=harness();try{
  const j=await h.tracker.prepare(session,bot,'request',before);h.tracker.db.prepare('UPDATE jobs SET roster_scope=NULL WHERE id=?').run(j.id);
  h.state.roster=roster(['other']);await h.tracker.cleanupDeletedRecipients();assert.equal(h.tracker.rows()[0].state,'pending');
  h.state.roster=roster([bot,'other']);await h.tracker.cleanupDeletedRecipients();assert.equal(h.tracker.db.prepare('SELECT roster_scope FROM jobs WHERE id=?').get(j.id).roster_scope,'scope-A');
  h.state.roster=roster(['other']);await h.tracker.tick();assert.equal(h.tracker.rows()[0].state,'recipient_deleted');
 }finally{h.clean();}
});
