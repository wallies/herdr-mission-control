import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {TrackerError,publicTrackerError,validateShortcutConnection,validateTrackerRequest} from '../../shared/tracker-transport.mjs';
import {TrackerModelError,trackerScope,validateRepoBinding,validateSnapshot} from '../../shared/tracker-model.js';
import {fetchShortcutClaude,probeShortcutClaude} from './claude.mjs';

const fail=code=>{throw new TrackerError(code);};

/** The executable helper's only public operations are one bounded read and the setup probe. */
export async function dispatchShortcut(input,options={}){
  try{
    const request=validateTrackerRequest(input,{connectionValidator:validateShortcutConnection,source:'shortcut'});request.binding=validateRepoBinding(request.binding);
    const clock=options.clock||(()=>Date.now());if(typeof clock!=='function')fail('INVALID_REQUEST');
    const adapterOptions={...(options.claude||{}),clock,...(options.env?{env:options.env}:{})};
    if(request.operation==='probe')return {v:1,ok:true,operation:'probe',connection:request.connection,probe:await probeShortcutClaude(request,adapterOptions)};
    const scope=trackerScope('shortcut',request.connection,request.binding);
    return {v:1,ok:true,operation:'issues',snapshot:validateSnapshot(await fetchShortcutClaude(request,adapterOptions),scope,{now:clock()})};
  }catch(error){const mapped=error instanceof TrackerModelError?new TrackerError(['INVALID_SNAPSHOT','INVALID_ISSUE'].includes(error.code)?'INVALID_RESPONSE':error.code==='INVALID_BINDING'?'INVALID_SCOPE':error.code):error;return {v:1,ok:false,error:publicTrackerError(mapped)};}
}

export async function main(argv=process.argv.slice(2)){
  let result;
  try{if(argv.length!==1||Buffer.byteLength(argv[0],'utf8')>65536)fail('INVALID_REQUEST');result=await dispatchShortcut(JSON.parse(argv[0]));}
  catch{result={v:1,ok:false,error:publicTrackerError(new TrackerError('INVALID_REQUEST'))};}
  const serialized=JSON.stringify(result);
  if(Buffer.byteLength(serialized,'utf8')>8*1024*1024){process.stdout.write(JSON.stringify({v:1,ok:false,error:publicTrackerError(new TrackerError('RESPONSE_TOO_LARGE'))})+'\n');return;}
  process.stdout.write(serialized+'\n');
}
let executable=false;try{executable=Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}catch{}
if(executable)await main();
