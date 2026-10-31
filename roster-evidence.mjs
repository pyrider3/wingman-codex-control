import {readFileSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const alphabet='abcdefghijklmnopqrstuvwxyz234567';
function decodeKey(filename){
 if(!/^[a-z2-7]+\.blob$/.test(filename))return null;
 let bits=0,value=0;const bytes=[];
 for(const ch of filename.slice(0,-5)){value=value*32+alphabet.indexOf(ch);bits+=5;if(bits>=8){bits-=8;bytes.push(Math.floor(value/2**bits)%256);value%=2**bits;}}
 try{return decodeURIComponent(Buffer.from(bytes).toString('utf8'));}catch{return null;}
}
// A filtered sidebar is not evidence that a bot was deleted. Cross-check the
// current account's persisted full roster against the complete live snapshot.
export function enrichRosterStatus(status,{settingsFile=join(homedir(),'.grokbot/settings.json'),directory=join(homedir(),'.config/Grok Bot/sand-client-persistence')}={}){
 if(status?.ok!==true||status.complete!==true||!Array.isArray(status.agents))return status;
 try{
  const scope=JSON.parse(readFileSync(settingsFile,'utf8')).activeAccountScope;
  if(typeof scope!=='string'||!/^[0-9a-f]{64}$/.test(scope))return status;
  const live=status.agents.map(a=>a.id);if(live.some(id=>typeof id!=='string')||new Set(live).size!==live.length)return status;
  const sortedLive=[...live].sort().join('\n');const candidates=[];
  for(const filename of readdirSync(directory)){
   const key=decodeKey(filename),prefix='sand.client.slice.account.',suffix='.roster.last-roster';
   if(!key?.startsWith(prefix)||!key.endsWith(suffix))continue;
   const keyScope=key.slice(prefix.length,-suffix.length);
   if(createHash('sha256').update(keyScope).digest('hex')!==scope)continue;
   const file=join(directory,filename);if(statSync(file).size>4*1024*1024)continue;
   const snapshot=JSON.parse(readFileSync(file,'utf8'));
   if(snapshot.schemaVersion!==4||!Array.isArray(snapshot.value?.rows))continue;
   const rows=snapshot.value.rows,ids=rows.map(r=>r.id);
   if(ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)continue;
   const visible=rows.filter(r=>!r.isHiddenFromSidebar&&!r.isRemovedFromSidebar).map(r=>r.id).sort().join('\n');
   if(visible!==sortedLive)continue;
   candidates.push(ids);
  }
  if(candidates.length!==1)return status;
  return {...status,accountScope:scope,rosterEvidence:{complete:true,accountScope:scope,knownBotIds:candidates[0]}};
 }catch{return status;}
}
