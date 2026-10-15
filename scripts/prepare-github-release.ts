import {resolve} from 'node:path';
import {prepareGitHubRelease} from '../server/github-release.js';
if(process.argv.length!==3)throw Error('Usage: prepare-github-release vX.Y.Z');
console.log(JSON.stringify(await prepareGitHubRelease(resolve(import.meta.dirname,'../..'),process.argv[2]!)));
