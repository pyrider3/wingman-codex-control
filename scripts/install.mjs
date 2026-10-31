#!/usr/bin/env node
import {homedir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,existsSync,writeFileSync,chmodSync,cpSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
if(process.platform!=='linux')throw Error('This installer currently supports Linux with user systemd.');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js 24 or newer is required.');
const repo=fileURLToPath(new URL('../',import.meta.url)),home=homedir();
const app=join(home,'.local/share/wingman-control/app'),state=join(home,'.local/state/wingman-control'),units=join(home,'.config/systemd/user'),bin=join(home,'.local/bin');
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({app,state,unit:join(units,'wingman.service'),commands:[join(bin,'wingman-codex'),join(bin,'wingman-grok-bridge')],desktopAutostartChanges:false},null,2));process.exit(0);}
if(!existsSync(join(repo,'dist/mcp/server.js'))||!existsSync(join(repo,'node_modules')))throw Error('Run npm ci --ignore-scripts && npm run build first.');
const managed=(()=>{try{return execFileSync('systemctl',['--user','is-active','wingman.service'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()==='active';}catch{return false;}})();
for(const p of [app,state,units,bin])mkdirSync(p,{recursive:true,mode:0o700});
if(managed)execFileSync('systemctl',['--user','stop','wingman.service'],{stdio:'inherit'});
try{
 if(resolve(repo)!==resolve(app))cpSync(repo,app,{recursive:true,filter:p=>p===repo||!relative(repo,p).split('/').some(v=>['.git','work','outputs'].includes(v))});
 const config=join(state,'config.json');if(!existsSync(config))writeFileSync(config,JSON.stringify({token:randomBytes(32).toString('base64url')},null,2)+'\n',{mode:0o600});chmodSync(config,0o600);chmodSync(state,0o700);
 const quoted=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
 const unit=`[Unit]\nDescription=Wingman multi-account Codex control and completion notifications\nAfter=network.target\nStartLimitIntervalSec=60\nStartLimitBurst=10\n\n[Service]\nType=simple\nWorkingDirectory=${quoted(app)}\nExecStart=${quoted(process.execPath)} ${quoted(join(app,'start-local.mjs'))}\nExecStartPost=${quoted(process.execPath)} ${quoted(join(app,'wait-ready.mjs'))}\nEnvironment=${quoted('WINGMAN_STATE_DIR='+state)}\nEnvironment=${quoted('WINGMAN_CONFIG_PATH='+config)}\nRestart=always\nRestartSec=3\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
 writeFileSync(join(units,'wingman.service'),unit);
 const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 for(const [name,file,extra] of [['wingman-codex','control.mjs',''],['wingman-grok-bridge','integrations/grok-bot-bridge.mjs','ensure ']]){
  const path=join(bin,name);writeFileSync(path,'#!/bin/sh\nexec '+shellQuote(process.execPath)+' '+shellQuote(join(app,file))+' '+extra+'"$@"\n',{mode:0o755});chmodSync(path,0o755);
 }
 execFileSync('systemctl',['--user','daemon-reload'],{stdio:'inherit'});
 execFileSync('systemctl',['--user','enable','--now','wingman.service'],{stdio:'inherit'});
 console.log('Installed and enabled Wingman. Codex and Grok Bot desktop startup settings were not changed.');
 console.log('Start those desktop apps manually. Use wingman-codex accounts, list, select, send, stop, resume, and jobs.');
}catch(e){if(managed)try{execFileSync('systemctl',['--user','start','wingman.service'],{stdio:'inherit'});}catch{}throw e;}
