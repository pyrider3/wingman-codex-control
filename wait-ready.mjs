import {localConfig} from './local-runtime.mjs';
const deadline=Date.now()+15000;
while(Date.now()<deadline){
 try{const r=await fetch('http://127.0.0.1:3847/healthz',{headers:{Authorization:`Bearer ${localConfig.token}`},signal:AbortSignal.timeout(1000)});if(r.ok)process.exit(0);}catch{}
 await new Promise(r=>setTimeout(r,100));
}
console.error('Wingman did not become ready within 15 seconds');process.exit(1);
