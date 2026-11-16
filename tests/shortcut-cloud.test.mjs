import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Shortcut from '../src/mods/mission-control-shortcut/main.js';
import {SNAPSHOT_STATE} from '../src/mods/mission-control-shortcut/data.js';
import {newConfig,bindingKey} from '../src/shared/config.js';
import {trackerScope,trackerScopeKey} from '../src/shared/tracker-model.js';
import {issueCardId} from '../src/shared/issue-board.js';
import {CLOUD_EVENT} from '../src/shared/cloud-sessions.js';
import {watchForSession,screenFailure} from '../src/shared/cloud-launch.js';
import {injectNative,context,trigger,findElement,Element,shared} from './support/native-recording.mjs';

const run=promisify(execFile),SITE='https://app.shortcut.com',ID='session_01HJKLMNOPQRSTUVWXYZ';
async function command(cmd,args,options={}){try{const r=await run(cmd,args,{cwd:options.cwd});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
const connection={id:'shortcut',kind:'claude',site:SITE,execution:{machine:null}};
const BODY='PRIVATE story body that must stay out of the task';
const story=(binding,id)=>({identity:{kind:'shortcut',connectionId:'shortcut',site:SITE,id:String(id)},key:'sc-'+id,title:'Fix the export',url:SITE+'/acme/story/'+id,body:BODY,statusGroup:'todo',statusName:'Ready',repoBinding:binding});

/** A real git checkout with a GitHub origin; tabs and terminal screens are recorded fakes. No claude runs. */
async function fixture(t,{machines=[{name:null,layout:'ready'}],screens=['Cloning acme/botanic…','Session ready\nView: https://claude.ai/code/'+ID+'?from=cli'],origin='git@github.com:acme/botanic.git'}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-shortcut-cloud-'))),app=path.join(root,'app'),repo=path.join(root,'repo');await fs.mkdir(path.join(app,'mission-control'),{recursive:true});await fs.mkdir(repo);
  for(const args of [['init','-q','-b','main'],['remote','add','origin',origin]])assert.equal((await command('git',['-C',repo,...args])).code,0);
  const binding={machine:null,repoRoot:repo,shortcut:{connectionId:'shortcut',owner:'cparry',workspace:'acme'}},config=newConfig();
  config.connections.shortcut=connection;config.bindings[bindingKey(null,repo)]=binding;config.preferences.launch={v:1,pins:['claude'],hidden:[],worktree:false,tools:{}};
  await fs.writeFile(path.join(app,'mission-control/config.json'),JSON.stringify(config));
  const space={id:'A',name:'botanic',machine:null,active:true,tabs:[{id:'A-tab'}]},panes=[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:repo,focused:true}],tabs=[],reads=[];
  const tools=[{key:'claude',name:'Claude',icon:'icons/claude.svg',tint:false,installed:true,run:['qa-claude']}];
  const scope=trackerScope('shortcut',connection,binding),stored={v:1,entries:{[trackerScopeKey(scope)]:{data:[story(binding,69416)],fetchedAt:Date.now(),scope,truncated:false}}};
  injectNative({props:{},spaces:()=>[space],panes:()=>panes,focused:()=>({space:'A',pane:'A-pane'}),machines:()=>machines,window:{platform:'macos'},appHome:app,
    shared:{'mission-control-shortcut-ui-v1':{v:1,all:false,query:'',status:'all'},[SNAPSHOT_STATE]:stored},knownAgents:async()=>tools,
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let old=null;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(old,expected);await fs.writeFile(file,text);},
    run:()=>null,openOverlay:()=>'overlay',closeOverlay:()=>null,nextCommand:()=>new Promise(()=>{}),
    hc:async args=>{reads.push(args);const screen=screens[Math.min(reads.length-1,screens.length-1)];return screen===null?{code:1,stdout:''}:{code:0,stdout:screen};},
    exec:async(cmd,args,options={})=>{
      if(cmd==='git'||cmd==='mkdir')return command(cmd,args,options);
      if(cmd==='herdr-app'&&args[0]==='do'&&args[1]==='tab.new'){const p=JSON.parse(args[2]);tabs.push(p);return {code:0,stdout:JSON.stringify({space:p.space,tab:'cloud-tab',terminal:'t9'})};}
      throw Error('Unexpected fixture effect '+cmd+' '+args.join(' '));
    }});
  const cx=context({scheduleSleep:()=>Promise.resolve()});cx.timer.every=()=>({cancel(){}});const view=new Shortcut();view.init({},cx);
  const flush=async()=>{let previous=-1;for(let n=0;n<80;n++){const jobs=[...view.jobs];await Promise.all(jobs);if(jobs.length===view.jobs.length&&previous===jobs.length)return;previous=jobs.length;}assert.fail('The view did not settle.');};
  t.after(async()=>{view.close();await Promise.allSettled(view.jobs);await fs.rm(root,{recursive:true,force:true});});
  await flush();
  const storeFile=path.join(app,'mission-control/cloud-sessions.json'),sessions=async()=>{try{return JSON.parse(await fs.readFile(storeFile,'utf8')).sessions;}catch{return [];}};
  return {view,cx,repo,tabs,reads,flush,sessions,id:issueCardId('shortcut-board',view.data.view().data[0])};
}
function texts(root){const result=[];const walk=node=>{if(typeof node==='string')result.push(node);else if(node instanceof Element)node.nodes.forEach(walk);};walk(root);return result;}

test('Ship (cloud) asks first; one click starts nothing',async t=>{
  const f=await fixture(t),button=findElement(f.view.render(f.cx),f.id+'-cloud');
  assert.equal(button.calls.find(c=>c.method==='tooltip').args[0],'Ship sc-69416 in a cloud session');
  await trigger(f.view.render(f.cx),f.id+'-cloud','on_click',{},f.cx);await f.flush();
  assert.equal(f.tabs.length,0);assert.ok(findElement(f.view.render(f.cx),f.id+'-cloud-confirm'));
  await trigger(f.view.render(f.cx),f.id+'-cloud-cancel','on_click',{},f.cx);
  assert.throws(()=>findElement(f.view.render(f.cx),f.id+'-cloud-confirm'),/found 0/);assert.equal(f.tabs.length,0);
});

test('Start does nothing when the card can no longer start, such as its machine going offline after the ask',async t=>{
  const machines=[{name:null,layout:'ready'}],f=await fixture(t,{machines});
  await trigger(f.view.render(f.cx),f.id+'-cloud','on_click',{},f.cx);const tree=f.view.render(f.cx);
  machines[0].layout='unavailable';await trigger(tree,f.id+'-cloud-start','on_click',{},f.cx);await f.flush();
  assert.equal(f.tabs.length,0);assert.deepEqual(await f.sessions(),[]);
});

test('Start runs claude --cloud with the plain-word ship task in the card’s checkout, then records the session',async t=>{
  const f=await fixture(t);
  await trigger(f.view.render(f.cx),f.id+'-cloud','on_click',{},f.cx);await trigger(f.view.render(f.cx),f.id+'-cloud-start','on_click',{},f.cx);await f.flush();
  assert.equal(f.tabs.length,1,f.view.error);const [tab]=f.tabs;
  assert.deepEqual(tab.argv,['claude','--cloud','Use the ship-tickets skill to ship sc-69416.']);assert.equal(tab.folder,f.repo);assert.equal(tab.space,'A');assert.equal(tab.task,undefined);
  assert.doesNotMatch(JSON.stringify(tab),/PRIVATE|\/ship/,'no story body, no slash command');
  assert.deepEqual(f.reads[0],['read','t9','--lines','200']);assert.equal(f.reads.length,2,'stops reading once the link shows');
  const [session]=await f.sessions();
  assert.deepEqual({...session},{id:ID,url:'https://claude.ai/code/'+ID,repo:'acme/botanic',checkout:f.repo,title:'sc-69416 Fix the export',source:{kind:'shortcut',key:'sc-69416'},createdAt:session.createdAt,pr:null,checkedAt:null});
  assert.ok(shared(CLOUD_EVENT),'the Agents rail is told to reload');
  assert.ok(texts(f.view.render(f.cx)).includes('Cloud session started. Follow it in the Agents rail.'));
});

test('a checkout without a GitHub origin, a closed tab or a missing link is reported on the card and records nothing',async t=>{
  const gitlab=await fixture(t,{origin:'git@gitlab.com:acme/botanic.git'});
  await trigger(gitlab.view.render(gitlab.cx),gitlab.id+'-cloud','on_click',{},gitlab.cx);await trigger(gitlab.view.render(gitlab.cx),gitlab.id+'-cloud-start','on_click',{},gitlab.cx);await gitlab.flush();
  assert.equal(gitlab.tabs.length,0);assert.ok(texts(gitlab.view.render(gitlab.cx)).includes('Cloud sessions need a checkout whose origin is on github.com.'));
  const closed=await fixture(t,{screens:['Cloning…',null]});
  await trigger(closed.view.render(closed.cx),closed.id+'-cloud','on_click',{},closed.cx);await trigger(closed.view.render(closed.cx),closed.id+'-cloud-start','on_click',{},closed.cx);await closed.flush();
  assert.equal(closed.tabs.length,1);assert.deepEqual(await closed.sessions(),[]);assert.ok(texts(closed.view.render(closed.cx)).includes('The cloud session tab closed before it showed the session link.'));
});

test('the tab watch is bounded and stops early on sign-in errors',async()=>{
  let reads=0;const herdr={hc:async()=>{reads++;return {code:0,stdout:'Provisioning…'};}};
  await assert.rejects(watchForSession({herdr,terminal:'t9',sleep:async()=>{},attempts:3}),{code:'LINK_NOT_FOUND'});assert.equal(reads,3);
  const signedOut={hc:async()=>({code:0,stdout:"Cloud sessions need a claude.ai sign-in. Run `claude auth login`"})};
  await assert.rejects(watchForSession({herdr:signedOut,terminal:'t9',sleep:async()=>{},attempts:3}),{code:'NOT_SIGNED_IN'});
  assert.equal(screenFailure('zsh: command not found: claude')[0],'CLAUDE_UNAVAILABLE');assert.equal(screenFailure('Cloning…'),null);
});
