import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
export const stateDir=process.env.WINGMAN_STATE_DIR||join(homedir(),'.local/state/wingman-control');
export const configPath=process.env.WINGMAN_CONFIG_PATH||join(stateDir,'config.json');
export const localConfig=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
export const selectionPath=join(stateDir,'wingman-selection.json');
export function ensureStateDir(){mkdirSync(stateDir,{recursive:true,mode:0o700});}
