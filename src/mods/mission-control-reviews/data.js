import {validateReview,reviewKey} from './model.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const messages={
  HELPER_UNAVAILABLE:'The local GitHub helper could not run. Check that Node.js 22 or later is installed.',
  INVALID_RESPONSE:'GitHub returned a review queue that did not check out. Refresh to try again.',
  RESPONSE_TOO_LARGE:'The review queue is larger than this view can hold.',
  REQUEST_CANCELLED:'This read was cancelled.',
  AUTH_REQUIRED:'The gh account is not signed in on this Mac. Run gh auth login, then refresh.',
  ACCOUNT_SELECTION_UNSUPPORTED:'The installed gh cannot select this account safely. Update gh, then refresh.',
  CLI_UNAVAILABLE:'gh is not installed or not on the app’s PATH.',
  RATE_LIMITED:'GitHub search reached its rate limit. The queue refreshes again later.',
  REQUEST_TIMEOUT:'GitHub took too long to answer. Refresh to try again.'
};
export class ReviewsDataError extends Error{constructor(code,message){super(message||messages[code]||'GitHub could not be read. Refresh to try again.');this.name='ReviewsDataError';this.code=code;}}
const fail=code=>{throw new ReviewsDataError(code);};
/** The helper's deadline is 25 s; a load older than this was abandoned by the host. */
export const STALE_LOAD_MS=90000;
export const REFRESH_MS=5*60000;

/** Checks every field of a helper reply; a reply that does not check out is rejected, never repaired. */
export function validateReply(value,operation){
  if(!object(value)||value.v!==1||typeof value.ok!=='boolean')fail('INVALID_RESPONSE');
  if(!value.ok){if(!exact(value,['v','ok','error'])||!exact(value.error,['code','message'],['status','retryAfterMs'])||!text(value.error.code,80)||!text(value.error.message,512))fail('INVALID_RESPONSE');throw new ReviewsDataError(value.error.code,messages[value.error.code]||value.error.message);}
  if(value.operation!==operation)fail('INVALID_RESPONSE');
  if(operation==='probe'){if(!exact(value,['v','ok','operation','login'])||typeof value.login!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(value.login))fail('INVALID_RESPONSE');return {login:value.login};}
  const s=value.snapshot;
  if(!exact(value,['v','ok','operation','snapshot'])||!exact(s,['fetchedAt','direct','team','truncated','incomplete','detailsUnavailable'])||!Number.isSafeInteger(s.fetchedAt)||!Array.isArray(s.direct)||!Array.isArray(s.team)||s.direct.length+s.team.length>600||['truncated','incomplete','detailsUnavailable'].some(k=>typeof s[k]!=='boolean'))fail('INVALID_RESPONSE');
  const seen=new Set(),snapshot={...s,direct:[],team:[]};
  for(const section of ['direct','team'])for(const raw of s[section]){let review;try{review=validateReview(raw);}catch{fail('INVALID_RESPONSE');}if(review.section!==section||seen.has(reviewKey(review)))fail('INVALID_RESPONSE');seen.add(reviewKey(review));snapshot[section].push(review);}
  return snapshot;
}

/** Runs the Node helper through Herdr's exec and keeps the last good queue across failed reads. */
export class ReviewsData{
  constructor(io,{clock=()=>Date.now(),onChange=()=>{}}={}){Object.assign(this,{io,clock,onChange,snapshot:null,error:null,pending:null,pendingAt:0,closed:false});}
  async request(input){
    const serialized=JSON.stringify(input);let result;
    try{const home=this.io.appHome();result=await this.io.exec('node',[home+'/mods/mission-control-reviews/backend.mjs',serialized],{cwd:home,timeout:60000});}catch{fail('HELPER_UNAVAILABLE');}
    if(this.closed)fail('REQUEST_CANCELLED');if(result?.code!==0||typeof result.stdout!=='string')fail('HELPER_UNAVAILABLE');
    let reply;try{reply=JSON.parse(result.stdout);}catch{fail('INVALID_RESPONSE');}
    return validateReply(reply,input.operation);
  }
  probe(connection){return this.request({v:1,operation:'probe',connection});}
  view(){return {snapshot:this.snapshot,error:this.error,loading:Boolean(this.pending)};}
  /** True when no read is running and the last read, good or failed, started at least `ageMs` ago. */
  due(ageMs=REFRESH_MS){if(this.pending&&this.clock()-this.pendingAt<STALE_LOAD_MS)return false;return this.pendingAt===0||this.clock()-this.pendingAt>=ageMs;}
  refresh(connection){
    if(this.closed)return Promise.resolve(this.view());
    if(this.pending&&this.clock()-this.pendingAt<STALE_LOAD_MS)return this.pending;
    const pending=(async()=>{
      try{const snapshot=await this.request({v:1,operation:'reviews',connection});if(this.pending===pending){this.snapshot=snapshot;this.error=null;}}
      catch(error){if(this.pending===pending&&!this.closed)this.error=error instanceof ReviewsDataError?error:new ReviewsDataError('REQUEST_FAILED');}
      finally{if(this.pending===pending)this.pending=null;if(!this.closed)this.onChange(this.view());}
      return this.view();
    })();
    this.pending=pending;this.pendingAt=this.clock();this.onChange(this.view());return pending;
  }
  close(){this.closed=true;this.pending=null;}
}
