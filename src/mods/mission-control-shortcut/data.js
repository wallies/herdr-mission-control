import {bindingKey,readConfig,validateConfig} from '../../shared/config.js';
import {trackerScope,trackerScopeKey,trackerOrigin,selectTracker,allTrackerBindings,validateRepoBinding,validateSnapshot,aggregateIssues,ScopedTrackerCache,saveRepoIntegration,utf8Bytes} from '../../shared/tracker-model.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(v,required,optional=[])=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const text=(v,max=512)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
export const SHORTCUT_SITE='https://app.shortcut.com';
const messages={
  INVALID_REQUEST:'Check the Shortcut connection and repository fields.',
  INVALID_CONNECTION:'Check the claude command path. Leave it empty to use claude from PATH.',
  INVALID_SCOPE:'Reload this repository and its Shortcut connection.',
  INVALID_RESPONSE:'Claude Code returned stories that did not match Shortcut. Refresh to try again.',
  INVALID_CONFIG:'Mission Control settings could not be read. The original file was preserved.',
  UNSUPPORTED_INTEGRATION_HOST:'Shortcut reads run on this Mac. Bind a local repository.',
  CLAUDE_UNAVAILABLE:'Claude Code (the claude command) was not found. Install it, or enter the absolute path to claude in Set up, because the app may not search ~/.local/bin.',
  CLAUDE_FAILED:'The Claude Code run failed. Run claude in a terminal to check that it is signed in, then refresh.',
  BUDGET_EXHAUSTED:'The Claude Code run reached its $0.10 budget before the stories loaded. Narrow the saved query and refresh.',
  SHORTCUT_SIGN_IN_REQUIRED:'Claude Code is not signed in to Shortcut. Run /mcp in Claude Code, sign in to shortcut, then refresh.',
  REQUEST_TIMEOUT:'The Shortcut read took longer than two minutes and was stopped. Narrow the saved query and refresh.',
  REQUEST_CANCELLED:'This Shortcut read was cancelled.',
  RESPONSE_TOO_LARGE:'The Shortcut result exceeds its bounded size. Narrow the saved query.',
  INCOMPLETE_RESULTS:'Shortcut reported more stories than were loaded. Narrow the saved query and refresh.',
  HELPER_UNAVAILABLE:'The local Shortcut helper could not run. Check that Node.js 22 or later is installed.',
  CONNECTION_CONFLICT:'This profile is already used. Choose a new profile ID to change its connection.',
  REQUEST_FAILED:'Shortcut could not be read. Refresh to try again.',
};
export class ShortcutDataError extends Error{constructor(code){const safe=Object.hasOwn(messages,code)?code:'REQUEST_FAILED';super(messages[safe]);this.name='ShortcutDataError';this.code=safe;}}
const fail=code=>{throw new ShortcutDataError(code);};
/** A Claude Code run is capped at 120 s; the helper gets a little longer, and a load older than this was abandoned by the host. */
export const HELPER_TIMEOUT_MS=150000;
export const STALE_LOAD_MS=180000;
/** Persisted in Herdr's shared state so the last cards survive a reload; bounded to the newest scopes. */
export const SNAPSHOT_STATE='mission-control-shortcut-snapshots-v1';
const MAX_STORED=20;
const safeError=error=>error instanceof ShortcutDataError?error:new ShortcutDataError(Object.hasOwn(messages,error?.code)?error.code:error?.code==='INVALID_BINDING'?'INVALID_SCOPE':['INVALID_ISSUE','INVALID_SNAPSHOT'].includes(error?.code)?'INVALID_RESPONSE':['INVALID_JSON','UNSUPPORTED_VERSION','CONFIG_PATH','CONFIG_DIRECTORY'].includes(error?.code)?'INVALID_CONFIG':'REQUEST_FAILED');
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(object(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
const selectionKey=desired=>desired?.all?'all':stable([desired?.resolved?.state||'unbound',desired?.resolved?.machine??null,desired?.resolved?.repoRoot??null]);

/** The connection Set up saves: no secret, this Mac only, an optional absolute claude path. */
export function shortcutConnection(id,command=''){
  const value=command.trim();return {id,kind:'claude',site:SHORTCUT_SITE,execution:{machine:null,...(value?{command:value}:{})}};
}

/** Pure native bridge: all effects come from the calling mod's installed Herdr IO. Nothing loads unless asked. */
export class ShortcutDataBridge{
  constructor(io,{clock=()=>Date.now(),onChange=()=>{},store=null}={}){
    this.io=io;this.clock=clock;this.onChange=onChange;this.store=store;this.entries=new Map();this.visible=[];this.closed=false;this.generation=0;this.setupEpoch=0;this.phase='setup';this.all=false;this.schemaErrors=[];this.globalError=null;this.desired=null;this.publish();
  }
  publish(){
    if(this.closed)return;
    const bindings=this.visible.map(key=>{const entry=this.entries.get(key);return {binding:entry.selection.binding,scope:entry.selection.scope,snapshot:entry.cache.snapshot,loading:Boolean(entry.pending)};});
    const snapshots=bindings.map(b=>b.snapshot).filter(Boolean),aggregate=aggregateIssues(snapshots),errors=[...this.schemaErrors,...bindings.filter(b=>b.snapshot?.error).map(b=>({binding:b.binding,error:b.snapshot.error}))];if(this.globalError)errors.push({error:{code:this.globalError.code,message:this.globalError.message}});
    const loading=bindings.filter(b=>b.loading).length;
    const state=this.phase==='loading'&&!bindings.length?'loading':errors.length?(aggregate.data.length||bindings.some(b=>b.snapshot&&!b.snapshot.error)?'partial':'error'):loading&&!aggregate.data.length?'loading':this.phase==='ready'&&!snapshots.length?'idle':this.phase;
    this.value={state,all:this.all,data:aggregate.data,bindings,errors,loading,truncated:aggregate.truncated,limitReached:aggregate.data.length===1000&&aggregate.truncated};this.onChange(this.value);
  }
  view(){return this.value;}
  stored(){const value=this.store?.read();return object(value)&&value.v===1&&object(value.entries)?value.entries:{};}
  /** Adopts a newer stored snapshot (from another copy or Set up); a read in flight here wins. */
  restore(entry){
    if(entry.pending)return false;const raw=this.stored()[trackerScopeKey(entry.selection.scope)];if(!raw||entry.cache.snapshot&&!(raw.fetchedAt>entry.cache.snapshot.fetchedAt))return false;
    let snapshot;try{snapshot=validateSnapshot(raw,entry.selection.scope,{now:this.clock()});}catch{return false;}
    const ticket=entry.cache.begin(entry.selection.scope);return Boolean(ticket&&entry.cache.accept(ticket,snapshot));
  }
  restoreVisible(){if(this.closed)return;let changed=false;for(const key of this.visible){const entry=this.entries.get(key);if(entry&&this.restore(entry))changed=true;}if(changed)this.publish();}
  remember(scope,snapshot){
    if(!this.store||snapshot.error)return;const entries={...this.stored(),[trackerScopeKey(scope)]:snapshot};
    const kept=Object.entries(entries).filter(([,s])=>Number.isFinite(s?.fetchedAt)).sort((a,b)=>b[1].fetchedAt-a[1].fetchedAt).slice(0,MAX_STORED);
    this.store.write({v:1,entries:Object.fromEntries(kept)});
  }
  clearSelection({phase='loading'}={}){
    this.generation++;for(const key of this.visible){const e=this.entries.get(key);e.cache.clear();e.pending=null;}this.visible=[];this.schemaErrors=[];this.globalError=null;this.phase=phase;this.publish();
  }
  selectConfig(config,resolved,{all=false}={}){
    if(this.closed)return this.value;this.generation++;this.config=validateConfig(config);this.all=Boolean(all);this.desired={resolved:resolved?copy(resolved):null,all:this.all};this.schemaErrors=[];this.globalError=null;
    let selections=[];
    if(all){
      for(const binding of Object.values(this.config.bindings)){if(!binding.shortcut)continue;try{const selected=selectTracker(this.config,{state:'resolved',machine:binding.machine,repoRoot:binding.repoRoot},'shortcut');if(selected)selections.push(selected);}catch(error){const safe=safeError(error);this.schemaErrors.push({binding:{machine:binding.machine,repoRoot:binding.repoRoot},error:{code:safe.code,message:safe.message}});}}
    }else if(resolved?.state===undefined||resolved.state==='resolved'){try{if(resolved&&!Object.hasOwn(resolved,'machine'))fail('INVALID_SCOPE');const selected=selectTracker(this.config,resolved,'shortcut');if(selected)selections=[selected];}catch(error){this.globalError=safeError(error);}}
    const wanted=new Set(selections.map(s=>bindingKey(s.binding.machine,s.binding.repoRoot)));
    for(const old of this.visible)if(!wanted.has(old)){const e=this.entries.get(old);e.cache.clear();e.pending=null;}
    this.visible=[];
    for(const selection of selections){const key=bindingKey(selection.binding.machine,selection.binding.repoRoot);let entry=this.entries.get(key);
      if(!entry){entry={selection,cache:new ScopedTrackerCache({clock:this.clock}),pending:null};this.entries.set(key,entry);}
      if(entry.cache.scope&&trackerScopeKey(entry.cache.scope)!==trackerScopeKey(selection.scope)){entry.cache.clear();entry.pending=null;}
      entry.selection=selection;entry.cache.select(selection.scope);this.restore(entry);this.visible.push(key);
    }
    this.phase=this.visible.length?'ready':all||resolved?.state===undefined||resolved?.state==='resolved'?'setup':'unbound';this.publish();return this.value;
  }
  async synchronize(resolved,{all=false}={}){
    if(this.closed)return this.value;const next={resolved:resolved?copy(resolved):null,all:Boolean(all)};
    this.all=next.all;if(selectionKey(next)!==selectionKey(this.desired))this.clearSelection();this.desired=next;const generation=++this.generation;
    try{const config=await readConfig(this.io);if(this.closed||generation!==this.generation)return this.value;return this.selectConfig(config.value,next.resolved,{all:next.all});}
    catch(error){if(this.closed||generation!==this.generation)return this.value;this.clearSelection({phase:'error'});this.globalError=safeError(error);this.publish();return this.value;}
  }
  async request(input){
    if(this.closed)fail('REQUEST_CANCELLED');let serialized;try{serialized=JSON.stringify(input);}catch{fail('INVALID_REQUEST');}if(utf8Bytes(serialized)>65536)fail('INVALID_REQUEST');
    let result;try{const home=this.io.appHome();result=await this.io.exec('node',[home+'/mods/mission-control-shortcut/backend.mjs',serialized],{cwd:home,timeout:HELPER_TIMEOUT_MS});}catch{fail('HELPER_UNAVAILABLE');}
    if(this.closed)fail('REQUEST_CANCELLED');if(result?.code!==0)fail('HELPER_UNAVAILABLE');if(typeof result.stdout!=='string')fail('INVALID_RESPONSE');if(utf8Bytes(result.stdout)>8*1024*1024)fail('RESPONSE_TOO_LARGE');
    let response;try{response=JSON.parse(result.stdout);}catch{fail('INVALID_RESPONSE');}
    if(!object(response)||response.v!==1||typeof response.ok!=='boolean')fail('INVALID_RESPONSE');
    if(!response.ok){if(!exact(response,['v','ok','error'])||!exact(response.error,['code','message'],['status','retryAfterMs'])||!text(response.error.code,80)||!text(response.error.message,512))fail('INVALID_RESPONSE');throw new ShortcutDataError(response.error.code);}
    if(response.operation!==input.operation)fail('INVALID_RESPONSE');
    if(input.operation==='issues'){
      if(!exact(response,['v','ok','operation','snapshot']))fail('INVALID_RESPONSE');try{return validateSnapshot(response.snapshot,trackerScope('shortcut',input.connection,input.binding),{now:this.clock()});}catch{fail('INVALID_RESPONSE');}
    }
    if(!exact(response,['v','ok','operation','connection','probe'])||!exact(response.probe,['site','owner','workspace'])||response.probe.site!==SHORTCUT_SITE||stable(response.connection)!==stable(input.connection))fail('INVALID_RESPONSE');
    try{validateRepoBinding({machine:null,repoRoot:'/',shortcut:{connectionId:input.connection.id,owner:response.probe.owner,workspace:response.probe.workspace}});}catch{fail('INVALID_RESPONSE');}
    return copy(response.probe);
  }
  // A load the host ended mid-flight never settles; drop its ticket without starting another paid run.
  abandonedLoad(entry){return entry.pending?this.clock()-entry.pendingAt>=STALE_LOAD_MS:entry.cache.pending;}
  hasAbandonedLoad(){return !this.closed&&this.visible.some(key=>this.entries.has(key)&&this.abandonedLoad(this.entries.get(key)));}
  releaseAbandoned(){for(const key of this.visible){const entry=this.entries.get(key);if(entry&&this.abandonedLoad(entry)){entry.pending=null;entry.cache.abandon();}}this.publish();}
  refreshEntry(entry){
    if(entry.pending)return entry.pending;const selection=copy(entry.selection);
    const ticket=entry.cache.begin(selection.scope);if(!ticket)return Promise.resolve(entry.cache.snapshot);
    const run=async()=>{
      try{const snapshot=await this.request({v:1,operation:'issues',connection:selection.connection,binding:selection.binding});
        if(!this.closed&&entry.cache.current(ticket)){entry.cache.accept(ticket,snapshot);this.remember(selection.scope,entry.cache.snapshot);}
      }catch(error){if(!this.closed&&entry.cache.current(ticket)){const safe=safeError(error);entry.cache.fail(ticket,{code:safe.code,message:safe.message});}}
      finally{if(entry.pending===pending)entry.pending=null;if(!this.closed)this.publish();}
      return entry.cache.snapshot;
    };
    const pending=run();entry.pending=pending;entry.pendingAt=this.clock();this.publish();return pending;
  }
  /** Each read is a paid model call, so bindings load one after another and only when asked. */
  async refresh({binding}={}){
    if(this.closed)return this.value;const keys=(binding?[bindingKey(binding.machine,binding.repoRoot)]:this.visible).filter(key=>this.visible.includes(key));
    for(const key of keys){if(this.closed)break;const entry=this.entries.get(key);if(entry)await this.refreshEntry(entry);}
    return this.value;
  }
  cancelSetup(){this.setupEpoch++;}
  /** Probe the claude connection; Set up shows the result before anything is saved. */
  async probe(connection,target){
    const binding=validateRepoBinding({machine:target.machine,repoRoot:target.repoRoot});return this.request({v:1,operation:'probe',connection,binding});
  }
  async saveSetup({target,connection,probe,query=''},{isCurrent=()=>true}={}){
    const selection={owner:probe.owner,workspace:probe.workspace,...(query.trim()?{query:query.trim()}:{})};
    const binding=validateRepoBinding({machine:target.machine,repoRoot:target.repoRoot,shortcut:{...selection,connectionId:connection.id}}),profile={...copy(connection),site:trackerOrigin(connection.site)},epoch=++this.setupEpoch;
    validateConfig({v:1,connections:{[profile.id]:profile},bindings:{[bindingKey(binding.machine,binding.repoRoot)]:binding}});
    const current=()=>!this.closed&&epoch===this.setupEpoch&&isCurrent();if(!current())fail('REQUEST_CANCELLED');
    const io={...this.io,readTextFile:async(...args)=>{const value=await this.io.readTextFile(...args);if(!current())fail('REQUEST_CANCELLED');return value;},writeTextFile:(...args)=>{if(!current())fail('REQUEST_CANCELLED');return this.io.writeTextFile(...args);}};
    const config=await saveRepoIntegration(io,{machine:binding.machine,repoRoot:binding.repoRoot,source:'shortcut',connection:profile,selection:binding.shortcut});
    if(!current())fail('REQUEST_CANCELLED');if(this.desired)this.selectConfig(config,this.desired.resolved,{all:this.desired.all});else this.config=config;
    return {config,binding};
  }
  close(){if(this.closed)return;this.closed=true;this.generation++;this.setupEpoch++;for(const entry of this.entries.values()){entry.cache.clear();entry.pending=null;}this.visible=[];this.value={state:'closed',all:this.all,data:[],bindings:[],errors:[],loading:0,truncated:false,limitReached:false};}
}
