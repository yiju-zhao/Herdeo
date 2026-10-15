import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isDirectCliInvocation} from '../server/cli-invocation.js';
test('native CLI subcommands and explicit opt-outs bypass the connector unchanged',()=>{
 for(const [kind,args]of [['claude',['agents','--json']],['claude',['attach','existing']],['claude',['--bare']],['pi',['auth','login']],['pi',['--no-extensions']],['pi',['--mode=rpc']],['codex',['exec','task']]]as const)assert.equal(isDirectCliInvocation(kind,args),true);
});
test('a model value or prompt mentioning auth is not mistaken for a CLI subcommand',()=>{
 assert.equal(isDirectCliInvocation('claude',['--model','opus','auth']),false);
 assert.equal(isDirectCliInvocation('pi',['--model','provider/model','fix auth']),false);
 assert.equal(isDirectCliInvocation('claude',['--','--help']),false);
});
