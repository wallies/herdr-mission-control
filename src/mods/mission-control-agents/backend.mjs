import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {dispatchCloud,MESSAGES} from './cloud.mjs';

/** One cloud session operation per run: the request is argv[1], the reply is one JSON line. */
export async function main(argv=process.argv.slice(2)){
  let reply;
  try{if(argv.length!==1||Buffer.byteLength(argv[0])>65536)throw Error('bad request');reply=await dispatchCloud(JSON.parse(argv[0]));}
  catch{reply={v:1,ok:false,error:{code:'INVALID_REQUEST',message:MESSAGES.INVALID_REQUEST}};}
  process.stdout.write(JSON.stringify(reply)+'\n');
}
let executable=false;try{executable=Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}catch{/* Imported as a module, not run. */}
if(executable)await main();
