import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextRelease,type ReleaseCommit} from '../server/conventional-release.js';
const c=(subject:string,body=''):ReleaseCommit=>({sha:'a'.repeat(40),subject,body});
test('automatic versions honor fixes, features and breaking changes even before 1.0',()=>{
 assert.equal(nextRelease('0.2.1',[c('fix(route): preserve original thread')])?.version,'0.2.2');
 assert.equal(nextRelease('0.2.1',[c('fix: retry'),c('feat: new provider')])?.version,'0.3.0');
 assert.equal(nextRelease('0.2.1',[c('feat!: replace public API')])?.version,'1.0.0');
 assert.equal(nextRelease('2.3.4',[c('refactor: simplify routing','BREAKING CHANGE: new configuration')])?.version,'3.0.0');
});
test('documentation and release commits cannot recursively publish another version',()=>{
 assert.equal(nextRelease('0.2.1',[c('ci: build releases'),c('docs: installation'),c('chore(release): v0.2.1'),c('Initial release')]),undefined);
 assert.equal(nextRelease('0.2.1',[c('docs: mention BREAKING CHANGE: examples')]),undefined);
});
