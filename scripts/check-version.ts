import {resolve} from 'node:path';
import {checkReleaseVersion} from '../server/release-version.js';
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--tag'||!args[1]))throw Error('Usage: check-version [--tag vX.Y.Z]');
// Works both from source via tsx and the compiled dist/scripts directory.
const root=resolve(import.meta.dirname,import.meta.filename.endsWith('.ts')?'..':'../..');
console.log('Release version: '+await checkReleaseVersion(root,args[1]));
