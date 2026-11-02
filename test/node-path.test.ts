import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stableNodePath} from '../server/node-path.js';
test('a Homebrew Cellar node is replaced by the opt link that survives brew upgrade',()=>{
 const exists=(p:string)=>p==='/opt/homebrew/opt/node/bin/node'||p==='/usr/local/opt/node@22/bin/node';
 assert.equal(stableNodePath('/opt/homebrew/Cellar/node/25.8.0/bin/node',exists),'/opt/homebrew/opt/node/bin/node');
 assert.equal(stableNodePath('/usr/local/Cellar/node@22/22.11.0/bin/node',exists),'/usr/local/opt/node@22/bin/node');
});
test('the resolved path is kept when there is no opt link or no Cellar layout',()=>{
 assert.equal(stableNodePath('/opt/homebrew/Cellar/node/25.8.0/bin/node',()=>false),'/opt/homebrew/Cellar/node/25.8.0/bin/node');
 for(const path of ['/usr/bin/node','/home/u/.nvm/versions/node/v22.1.0/bin/node','/opt/homebrew/Cellar/node/25.8.0/libexec/node'])assert.equal(stableNodePath(path,()=>true),path);
});
