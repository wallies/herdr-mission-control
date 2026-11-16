import {readConfig} from '../../shared/config.js';
import {CloudSessionStore,CloudSessionError,validatePull,parseSessionRef,validMessage,cloudStatus} from '../../shared/cloud-sessions.js';

/** Pull request lookups are free gh reads: every few minutes while the rail shows cloud sessions. */
export const PULLS_REFRESH_MS=5*60000;
/** One GraphQL call covers at most this many sessions; the rest wait for the next round. */
export const PULLS_BATCH=20;
const STALE_MS=90000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>{throw new CloudSessionError(code,message);};

/** The Reviews mod's gh connection, which the cloud rail reuses for its pull request lookups. */
export function reviewsConnection(config){
  const id=config?.preferences?.reviews?.connectionId,c=typeof id==='string'?config.connections?.[id]:null;
  return c?.kind==='github'&&c.gh?c:null;
}

/** Checks the helper's reply field by field; anything that does not check out is rejected. */
export function validateCloudReply(value,input){
  if(!object(value)||value.v!==1||typeof value.ok!=='boolean')fail('INVALID_RESPONSE','The cloud helper returned an invalid reply.');
  if(!value.ok){
    const e=value.error;if(!object(e)||typeof e.code!=='string'||typeof e.message!=='string'||e.message.length>512)fail('INVALID_RESPONSE','The cloud helper returned an invalid reply.');
    fail(e.code,e.message);
  }
  if(value.operation!==input.operation)fail('INVALID_RESPONSE','The cloud helper answered another request.');
  if(input.operation==='message'){if(value.session!==input.session)fail('INVALID_RESPONSE','The cloud helper answered for another session.');return {session:value.session};}
  if(!Number.isSafeInteger(value.checkedAt)||!object(value.found))fail('INVALID_RESPONSE','The cloud helper returned an invalid lookup.');
  const asked=new Set(input.sessions.map(s=>s.id)),found={};
  for(const [id,pr] of Object.entries(value.found)){
    if(!asked.has(id))fail('INVALID_RESPONSE','The cloud helper returned a session it was not asked about.');
    if(pr!==null){try{validatePull(pr);}catch{fail('INVALID_RESPONSE','The cloud helper returned an invalid pull request.');}}
    found[id]=pr;
  }
  return {checkedAt:value.checkedAt,found};
}

/** The rail's cloud sessions: the store, follow-up messages, and pull request refreshes. */
export class CloudSessions{
  constructor(io,{clock=()=>Date.now()}={}){Object.assign(this,{io,clock,store:new CloudSessionStore(io),records:[],error:null,pullsError:null,connection:null,pending:null,pendingAt:0,closed:false});}
  async load(){
    try{this.records=await this.store.list();this.error=null;}catch(error){this.error=error.message||'The cloud session list could not be read.';}
    try{this.connection=reviewsConnection((await readConfig(this.io)).value);}catch{this.connection=null;}
    return this.records;
  }
  async request(input){
    let result;
    try{const home=this.io.appHome();result=await this.io.exec('node',[home+'/mods/mission-control-agents/backend.mjs',JSON.stringify(input)],{cwd:home,timeout:90000});}
    catch{fail('HELPER_UNAVAILABLE','The local cloud helper could not run. Check that Node.js 22 or later is installed.');}
    if(this.closed)fail('REQUEST_CANCELLED','This request was cancelled.');
    if(result?.code!==0||typeof result.stdout!=='string')fail('HELPER_UNAVAILABLE','The local cloud helper could not run. Check that Node.js 22 or later is installed.');
    let reply;try{reply=JSON.parse(result.stdout);}catch{fail('INVALID_RESPONSE','The cloud helper returned an invalid reply.');}
    return validateCloudReply(reply,input);
  }
  /** Queues one message into the session; Claude Code does not wait for the reply. */
  message(id,text){
    const session=parseSessionRef(id).id,message=validMessage(text);
    return this.request({v:1,operation:'message',session,message});
  }
  /** True when no lookup is running and the last one started at least `ageMs` ago. */
  due(ageMs=PULLS_REFRESH_MS){
    if(this.pending&&this.clock()-this.pendingAt<STALE_MS)return false;
    return this.pendingAt===0||this.clock()-this.pendingAt>=ageMs;
  }
  /** Merged sessions are final; the rest are checked least recently checked first, a batch at a time. */
  candidates(){
    return this.records.filter(r=>cloudStatus(r)!=='merged').sort((a,b)=>(a.checkedAt??-1)-(b.checkedAt??-1)).slice(0,PULLS_BATCH);
  }
  refreshPulls(){
    if(this.closed)return Promise.resolve(this.records);
    if(this.pending&&this.clock()-this.pendingAt<STALE_MS)return this.pending;
    const pending=(async()=>{
      try{
        const wanted=this.candidates();if(!this.connection||!wanted.length)return this.records;
        const reply=await this.request({v:1,operation:'pulls',connection:this.connection,sessions:wanted.map(r=>({id:r.id,repo:r.repo,number:r.pr?.number??null}))});
        if(this.closed)return this.records;
        this.records=await this.store.recordPulls(reply.found,reply.checkedAt);this.pullsError=null;
      }catch(error){if(!this.closed)this.pullsError=error.message||'Pull requests could not be checked.';}
      finally{if(this.pending===pending)this.pending=null;}
      return this.records;
    })();
    this.pending=pending;this.pendingAt=this.clock();return pending;
  }
  async remove(id){this.records=await this.store.remove(id);return this.records;}
  async add(record){this.records=await this.store.add(record);return this.records;}
  close(){this.closed=true;this.pending=null;}
}
