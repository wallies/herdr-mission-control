import {CloudSessionStore,CloudSessionError,CLOUD_EVENT,createArgs,findSessionLink,newRecord,repoFromRemote} from './cloud-sessions.js';

/**
 * Starts a Claude Code cloud session for a checkout and records it. `claude --cloud <task>` is
 * interactive (a live setup checklist) and has no documented machine-readable output when it
 * creates a session, so it runs in its own tab and this reads the tab's screen, a bounded number of
 * times, for the claude.ai/code session link it shows.
 */
const fail=(code,message)=>{throw new CloudSessionError(code,message);};
export const WATCH_INTERVAL_MS=3000;
export const WATCH_ATTEMPTS=60;

/** Words in the tab that end the wait early, mapped to a fixed message. */
export function screenFailure(screen){
  if(/claude auth login|claude\.ai sign-in|organization UUID/i.test(screen))return ['NOT_SIGNED_IN','Claude Code is not signed in with a claude.ai account. Run claude auth login in a terminal, then try again.'];
  if(/(?:command not found|not found): claude|claude: (?:command )?not found/i.test(screen))return ['CLAUDE_UNAVAILABLE','Claude Code (the claude command) was not found in this space’s shell.'];
  if(/session creation failed|disabled by your organization/i.test(screen))return ['CREATE_FAILED','Claude Code could not create the cloud session. Its tab shows why.'];
  return null;
}

/** The tab's acknowledgment from `herdr-app do tab.new`, checked before its terminal is read. */
function acknowledged(result,spaceId){
  if(result?.code!==0)fail('TAB_FAILED','Herdr did not open the cloud session tab.');
  let ack;try{ack=JSON.parse(result.stdout);}catch{fail('TAB_FAILED','Herdr returned an invalid tab acknowledgment.');}
  if(ack?.space!==spaceId||typeof ack.terminal!=='string'||!/^[A-Za-z0-9_.:/-]{1,128}$/.test(ack.terminal))fail('TAB_FAILED','Herdr returned an invalid tab acknowledgment.');
  return ack;
}

/** Reads the tab until the session link shows, the tab reports a failure, or the attempts run out. */
export async function watchForSession({herdr,terminal,sleep,attempts=WATCH_ATTEMPTS,isCurrent=()=>true}){
  for(let attempt=0;attempt<attempts;attempt++){
    await sleep(WATCH_INTERVAL_MS);if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');
    const read=await herdr.hc(['read',terminal,'--lines','200']);
    if(read?.code!==0)fail('TAB_CLOSED','The cloud session tab closed before it showed the session link.');
    const found=findSessionLink(read.stdout);if(found)return found;
    const failure=screenFailure(read.stdout);if(failure)fail(...failure);
  }
  fail('LINK_NOT_FOUND','The cloud session tab did not show a session link within three minutes. Copy the link from that tab into Follow a cloud session in the Agents rail.');
}

/**
 * `target` is a captured launch target ({spaceId, machine, checkoutRoot}); `task` is the exact text
 * sent to the session and `source` names what it ships ({kind, key}). Nothing else leaves this Mac.
 */
export async function startCloudSession({herdr,io,target,task,title,source,sleep,attempts,isCurrent=()=>true}){
  if(target.machine!==null)fail('LOCAL_ONLY','Cloud sessions start from a checkout on this computer.');
  const checkout=target.checkoutRoot,origin=await herdr.exec('git',['-C',checkout,'remote','get-url','origin']);
  const repo=origin.code===0?repoFromRemote(origin.stdout):null;
  if(!repo)fail('NOT_GITHUB','Cloud sessions need a checkout whose origin is on github.com.');
  if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');
  const args={space:target.spaceId,folder:checkout,argv:['claude',...createArgs(task)],name:('Cloud '+title).slice(0,200)};
  const ack=acknowledged(await herdr.exec('herdr-app',['do','tab.new',JSON.stringify(args)]),target.spaceId);
  const found=await watchForSession({herdr,terminal:ack.terminal,sleep,attempts,isCurrent});
  const record=newRecord({ref:found.id,repo,checkout,title,source,createdAt:Date.now()});
  await new CloudSessionStore(io).add(record);
  herdr.setShared(CLOUD_EVENT,{v:1,at:Date.now(),nonce:Math.random().toString(36).slice(2)});
  return record;
}
