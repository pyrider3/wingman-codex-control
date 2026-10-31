import './desktop-provider.mjs';
import {localConfig as cfg} from './local-runtime.mjs';
import {completionTracker} from './completion.mjs';
import {startMcpServer} from './dist/mcp/server.js';

await startMcpServer({host:'127.0.0.1',port:3847,token:cfg.token,quiet:true});

completionTracker().start();
