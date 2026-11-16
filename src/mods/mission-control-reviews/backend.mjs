import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {TrackerError,publicTrackerError} from '../../shared/tracker-transport.mjs';
import {fetchReviewQueue} from './reviews.mjs';

/** One read per run: the request is argv[1], the reply is one JSON line. No upstream text is reflected. */
export async function dispatchReviews(input,options={}){
  try{
    const result=await fetchReviewQueue(input,options);
    return input.operation==='probe'?{v:1,ok:true,operation:'probe',login:result.login}:{v:1,ok:true,operation:'reviews',snapshot:result};
  }catch(error){
    const code=error instanceof TrackerError?error.code:['INVALID_REVIEW'].includes(error?.code)?'INVALID_RESPONSE':'REQUEST_FAILED';
    return {v:1,ok:false,error:publicTrackerError(error instanceof TrackerError?error:new TrackerError(code))};
  }
}
export async function main(argv=process.argv.slice(2)){
  let reply;
  try{if(argv.length!==1||Buffer.byteLength(argv[0])>65536)throw new TrackerError('INVALID_REQUEST');reply=await dispatchReviews(JSON.parse(argv[0]));}
  catch{reply={v:1,ok:false,error:publicTrackerError(new TrackerError('INVALID_REQUEST'))};}
  let output=JSON.stringify(reply);if(Buffer.byteLength(output)>8*1024*1024)output=JSON.stringify({v:1,ok:false,error:publicTrackerError(new TrackerError('RESPONSE_TOO_LARGE'))});
  process.stdout.write(output+'\n');
}
let executable=false;try{executable=Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}catch{/* Imported as a module, not run. */}
if(executable)await main();
