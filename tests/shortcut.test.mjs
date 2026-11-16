import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Shortcut,{shortcutLaunchSource} from '../src/mods/mission-control-shortcut/main.js';
import {ShortcutDataBridge,SNAPSHOT_STATE,STALE_LOAD_MS} from '../src/mods/mission-control-shortcut/data.js';
import {newConfig,bindingKey} from '../src/shared/config.js';
import {trackerScope,trackerScopeKey} from '../src/shared/tracker-model.js';
import {validateShortcutConnection,validateTrackerRequest,publicTrackerError,TrackerError} from '../src/shared/tracker-transport.mjs';
import {issueCardId} from '../src/shared/issue-board.js';
import {injectNative,context,trigger,findElement,Element,shared as liveShared} from './support/native-recording.mjs';

const exec=promisify(execFile),SITE='https://app.shortcut.com',MINUTE=60000;
async function command(cmd,args,options={}){try{const r=await exec(cmd,args,{cwd:options.cwd,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
function strings(root){const out=[];const walk=v=>{if(!(v instanceof Element))return;for(const child of v.nodes)if(typeof child==='string')out.push(child);else walk(child);};walk(root);return out;}
const has=(root,id)=>{try{findElement(root,id);return true;}catch{return false;}};
const connection={id:'shortcut',kind:'claude',site:SITE,execution:{machine:null}};
const story=(binding,id,group,title='Story '+id)=>({identity:{kind:'shortcut',connectionId:'shortcut',site:SITE,id:String(id)},key:'sc-'+id,title,url:SITE+'/acme/story/'+id,body:'',statusGroup:group,statusName:group==='todo'?'Ready':'In Development',repoBinding:binding,updatedAt:Date.now()-MINUTE});
const snapshot=(binding,rows,fetchedAt=Date.now(),c=connection)=>({data:rows,fetchedAt,scope:trackerScope('shortcut',c,binding),truncated:false});

/** The node helper is answered in-process: no `claude` and no network ever run here. */
async function fixture(t,{props={},bound=true,stored=null}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-shortcut-view-'))),app=path.join(root,'app'),repo=path.join(root,'repo');await fs.mkdir(path.join(app,'mission-control'),{recursive:true});await fs.mkdir(repo);
  for(const args of [['init','-q','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['commit','--allow-empty','-qm','Create fixture']])assert.equal((await command('git',['-C',repo,...args])).code,0);
  const binding={machine:null,repoRoot:repo,shortcut:{connectionId:'shortcut',owner:'cparry',workspace:'acme'}},config=newConfig();
  if(bound){config.connections.shortcut=connection;config.bindings[bindingKey(null,repo)]=binding;}
  const configFile=path.join(app,'mission-control/config.json');await fs.writeFile(configFile,JSON.stringify(config));
  const space={id:'A',name:'client-portal',machine:null,active:true,tabs:[{id:'A-tab'}]},panes=[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:repo,focused:true}];
  const backend={calls:[],gate:null,reply:r=>({v:1,ok:true,operation:'issues',snapshot:snapshot(r.binding,[story(r.binding,2,'todo'),story(r.binding,3,'inProgress')],Date.now(),r.connection)})},effects=[];
  const shared={'mission-control-shortcut-ui-v1':{v:1,all:false,query:'',status:'all'},...(stored?{[SNAPSHOT_STATE]:stored(binding)}:{})};
  const api={props,spaces:()=>[space],panes:()=>panes,focused:()=>({space:'A',pane:'A-pane'}),machines:()=>[{name:null,layout:'ready'}],window:{platform:'macos'},appHome:app,shared,knownAgents:async()=>[],
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let old=null;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(old,expected);await fs.writeFile(file,text);},
    run:()=>null,openOverlay:spec=>{effects.push(['overlay',spec]);return 'overlay';},closeOverlay:id=>{effects.push(['close',id]);return null;},nextCommand:()=>new Promise(()=>{}),
    exec:async(cmd,args,options={})=>{
      if(cmd==='git'||cmd==='python3'||cmd==='mkdir')return command(cmd,args,options);
      if(cmd!=='node')throw Error('Unexpected fixture effect '+cmd);
      const r=validateTrackerRequest(JSON.parse(args[1]),{connectionValidator:validateShortcutConnection,source:'shortcut'});backend.calls.push({operation:r.operation,options,request:r});
      if(backend.gate)await backend.gate;
      try{if(backend.error)throw new TrackerError(backend.error);
        if(r.operation==='probe')return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'probe',connection:r.connection,probe:{site:SITE,owner:'cam.parry',workspace:'acme'}})};
        return {code:0,stdout:JSON.stringify(backend.reply(r))};
      }catch(e){return {code:0,stdout:JSON.stringify({v:1,ok:false,error:publicTrackerError(e)})};}
    }};
  injectNative(api);const cx=context(),timers=[];cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancel(){}};timers.push(timer);return timer;};
  const view=new Shortcut();view.init({},cx);
  const flush=async()=>{let previous=-1;for(let n=0;n<30;n++){const jobs=[...view.jobs];await Promise.all(jobs);if(jobs.length===view.jobs.length&&previous===jobs.length)return;previous=jobs.length;}assert.fail('The view did not settle.');};
  t.after(async()=>{view.close();await Promise.allSettled(view.jobs);await fs.rm(root,{recursive:true,force:true});});
  const hold=()=>{let release;backend.gate=new Promise(r=>release=r);return ()=>{backend.gate=null;release();};};
  return {view,cx,api,repo,binding,backend,effects,configFile,timers,flush,hold,edit:(state,value)=>{state.set_value(value);for(const l of state.listeners.filter(l=>l.event==='change'))l.fn({},cx);}};
}
const issues=f=>f.backend.calls.filter(c=>c.operation==='issues');

test('opening the board never loads; it shows that nothing is loaded and only To do and In progress',async t=>{
  const f=await fixture(t);await f.flush();
  assert.equal(issues(f).length,0);assert.equal(f.view.data.view().state,'idle');
  const tree=f.view.render(f.cx),text=strings(tree);await f.flush();
  assert.ok(text.includes('Not loaded yet'));assert.ok(has(tree,'shortcut-board-column-todo'));assert.ok(has(tree,'shortcut-board-column-inProgress'));assert.equal(has(tree,'shortcut-board-column-done'),false);assert.equal(has(tree,'shortcut-board-filter-done'),false);
  assert.equal(f.timers.length,1);f.timers[0].fn(f.cx);await f.flush();assert.equal(issues(f).length,0,'the timer never starts a paid read');
});

test('the last stored snapshot shows at once with its age and no read',async t=>{
  const f=await fixture(t,{stored:b=>({v:1,entries:{[trackerScopeKey(trackerScope('shortcut',connection,b))]:snapshot(b,[story(b,7,'todo','Cached story')],Date.now()-5*MINUTE)}})});await f.flush();
  const text=strings(f.view.render(f.cx));assert.equal(issues(f).length,0);
  assert.ok(text.includes('Cached story'));assert.ok(text.some(s=>/1 loaded · Updated 5m ago/.test(s)),text.join('|'));
});

test('Refresh reads once, keeps the old cards while it runs and groups the new stories',async t=>{
  const f=await fixture(t,{stored:b=>({v:1,entries:{[trackerScopeKey(trackerScope('shortcut',connection,b))]:snapshot(b,[story(b,7,'todo','Cached story')],Date.now()-5*MINUTE)}})});await f.flush();
  const release=f.hold();trigger(f.view.render(f.cx),'shortcut-board-refresh',undefined,{},f.cx);await new Promise(r=>setImmediate(r));
  let tree=f.view.render(f.cx);assert.ok(strings(tree).includes('Cached story'));assert.ok(strings(tree).some(s=>s.startsWith('Refreshing · ')));
  f.view.refresh(f.cx);f.view.refresh(f.cx);await new Promise(r=>setImmediate(r));assert.equal(issues(f).length,1,'a running read is not started again');
  assert.equal(issues(f)[0].options.timeout,150000);release();await f.flush();
  const view=f.view.data.view();assert.deepEqual(view.data.map(v=>[v.key,v.statusGroup]),[['sc-2','todo'],['sc-3','inProgress']]);
  tree=f.view.render(f.cx);assert.ok(has(tree,issueCardId('shortcut-board',view.data[0])+'-key'));assert.equal(strings(tree).includes('Cached story'),false);
  const stored=Object.values(liveShared(SNAPSHOT_STATE).entries);assert.deepEqual(stored.map(s=>s.data.map(v=>v.key)),[['sc-2','sc-3']],'the new snapshot replaces the stored one');
});

test('a failed refresh shows the backend message and keeps the cached cards',async t=>{
  for(const [code,pattern] of [['SHORTCUT_SIGN_IN_REQUIRED',/run \/mcp in Claude Code/i],['BUDGET_EXHAUSTED',/\$0\.10 budget/],['CLAUDE_UNAVAILABLE',/full path|absolute path/],['CLAUDE_FAILED',/Run claude in a terminal/],['REQUEST_TIMEOUT',/two minutes/]]){
    const f=await fixture(t,{stored:b=>({v:1,entries:{[trackerScopeKey(trackerScope('shortcut',connection,b))]:snapshot(b,[story(b,7,'todo','Cached story')],Date.now()-5*MINUTE)}})});await f.flush();
    f.backend.error=code;trigger(f.view.render(f.cx),'shortcut-board-refresh',undefined,{},f.cx);await f.flush();
    const tree=f.view.render(f.cx),text=strings(tree);assert.ok(has(tree,'shortcut-board-error'),code);assert.ok(text.some(s=>pattern.test(s)),code+': '+text.join('|'));assert.ok(text.includes('Cached story'),code);
  }
});

test('Set up checks Claude Code, shows the signed-in member, saves the binding and loads once',async t=>{
  const f=await fixture(t,{bound:false,props:{view:'setup',target:{machine:null,repoRoot:'/explicit/repo'},overlay:'setup'}});await f.flush();
  let tree=f.view.render(f.cx);assert.equal(has(tree,'shortcut-save-setup'),false);
  f.edit(f.view.command,'/opt/claude/bin/claude');f.edit(f.view.query,' team:web ');
  await trigger(f.view.render(f.cx),'shortcut-check-setup',undefined,{},f.cx);await f.flush();
  const probe=f.backend.calls.find(c=>c.operation==='probe');assert.deepEqual(probe.request.connection,{id:'shortcut',kind:'claude',site:SITE,execution:{machine:null,command:'/opt/claude/bin/claude'}});
  tree=f.view.render(f.cx);assert.ok(strings(tree).includes('Signed in as @cam.parry'));assert.ok(strings(tree).includes('Workspace acme'));assert.equal(issues(f).length,0);
  await trigger(tree,'shortcut-save-setup',undefined,{},f.cx);await f.flush();
  const saved=JSON.parse(await fs.readFile(f.configFile,'utf8'));
  assert.deepEqual(saved.bindings[bindingKey(null,'/explicit/repo')].shortcut,{connectionId:'shortcut',owner:'cam.parry',workspace:'acme',query:'team:web'});
  assert.deepEqual(saved.connections.shortcut,probe.request.connection);
  assert.equal(issues(f).length,1,'one read right after saving');assert.ok(f.effects.some(e=>e[0]==='close'&&e[1]==='setup'),String(f.view.error)+JSON.stringify(f.view.data.view().errors));
});

test('editing a checked form needs a new check before saving',async t=>{
  const f=await fixture(t,{bound:false,props:{view:'setup',target:{machine:null,repoRoot:'/explicit/repo'}}});await f.flush();
  await trigger(f.view.render(f.cx),'shortcut-check-setup',undefined,{},f.cx);await f.flush();assert.ok(has(f.view.render(f.cx),'shortcut-save-setup'));
  f.edit(f.view.command,'/other/claude');assert.equal(has(f.view.render(f.cx),'shortcut-save-setup'),false);
  f.backend.error='SHORTCUT_SIGN_IN_REQUIRED';await trigger(f.view.render(f.cx),'shortcut-check-setup',undefined,{},f.cx);await f.flush();
  assert.match(f.view.error,/\/mcp/);assert.equal(has(f.view.render(f.cx),'shortcut-save-setup'),false);
});

test('the bridge stores fresh snapshots, adopts newer ones and releases an abandoned read without retrying',async()=>{
  let now=1800000000000,store;const calls=[],binding={machine:null,repoRoot:'/repo',shortcut:{connectionId:'shortcut',owner:'cparry',workspace:'acme'}},config=newConfig();
  config.connections.shortcut=connection;config.bindings[bindingKey(null,'/repo')]=binding;
  let hang=false;const io={appHome:()=>'/app',exec:async(cmd,args,options)=>{calls.push(options);if(hang)return new Promise(()=>{});const r=JSON.parse(args[1]);return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'issues',snapshot:snapshot(r.binding,[story(r.binding,9,'inProgress')],now)})};}};
  const bridge=new ShortcutDataBridge(io,{clock:()=>now,store:{read:()=>store,write:v=>{store=v;}}});
  bridge.selectConfig(config,{state:'resolved',machine:null,repoRoot:'/repo'});assert.equal(bridge.view().state,'idle');
  await bridge.refresh();assert.equal(calls.length,1);const key=trackerScopeKey(trackerScope('shortcut',connection,binding));assert.deepEqual(store.entries[key].data.map(v=>v.key),['sc-9']);
  store={v:1,entries:{[key]:snapshot(binding,[story(binding,10,'todo')],now+1000)}};now+=2000;bridge.restoreVisible();assert.deepEqual(bridge.view().data.map(v=>v.key),['sc-10']);
  store={v:1,entries:{[key]:snapshot(binding,[story(binding,11,'todo')],now-60000)}};bridge.restoreVisible();assert.deepEqual(bridge.view().data.map(v=>v.key),['sc-10'],'an older stored snapshot is ignored');
  hang=true;bridge.refresh();await new Promise(r=>setImmediate(r));assert.equal(bridge.hasAbandonedLoad(),false);now+=STALE_LOAD_MS;assert.equal(bridge.hasAbandonedLoad(),true);
  bridge.releaseAbandoned();assert.equal(bridge.view().loading,0);assert.equal(calls.length,2);assert.deepEqual(bridge.view().data.map(v=>v.key),['sc-10']);
});

test('cards launch as Shortcut sources',()=>{
  const b={machine:null,repoRoot:'/repo',shortcut:{connectionId:'shortcut',owner:'cparry',workspace:'acme'}};
  assert.deepEqual(shortcutLaunchSource(story(b,4,'todo')),{kind:'shortcut',connectionId:'shortcut',site:SITE,id:'4',key:'sc-4',title:'Story 4',url:SITE+'/acme/story/4',task:'Use the ship-tickets skill to ship sc-4.'});
});

test('a second refresh during a read waits for that same read instead of returning early',async()=>{
  const binding={machine:null,repoRoot:'/repo',shortcut:{connectionId:'shortcut',owner:'cparry',workspace:'acme'}},config=newConfig();config.connections.shortcut=connection;config.bindings[bindingKey(null,'/repo')]=binding;
  let release,calls=0;const gate=new Promise(r=>release=r);
  const io={appHome:()=>'/app',exec:async(_cmd,args)=>{calls++;await gate;const r=JSON.parse(args[1]);return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'issues',snapshot:snapshot(r.binding,[story(r.binding,5,'todo')])})};}};
  const bridge=new ShortcutDataBridge(io);bridge.selectConfig(config,{state:'resolved',machine:null,repoRoot:'/repo'});
  const first=bridge.refresh(),second=bridge.refresh();release();const [,view]=await Promise.all([first,second]);
  assert.equal(calls,1);assert.deepEqual(view.data.map(v=>v.key),['sc-5'],'the second caller sees the loaded stories');
});
