import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Shortcut,{shortcutLaunchSource,shipTask} from '../src/mods/mission-control-shortcut/main.js';
import {SNAPSHOT_STATE} from '../src/mods/mission-control-shortcut/data.js';
import {newConfig,bindingKey} from '../src/shared/config.js';
import {trackerScope,trackerScopeKey} from '../src/shared/tracker-model.js';
import {issueCardId} from '../src/shared/issue-board.js';
import {injectNative,context,trigger,findElement} from './support/native-recording.mjs';

const run=promisify(execFile),SITE='https://app.shortcut.com';
async function command(cmd,args,options={}){try{const r=await run(cmd,args,{cwd:options.cwd,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
const connection={id:'shortcut',kind:'claude',site:SITE,execution:{machine:null}};
const BODY='PRIVATE story body that must stay out of the task';
const story=(binding,id)=>({identity:{kind:'shortcut',connectionId:'shortcut',site:SITE,id:String(id)},key:'sc-'+id,title:'Fix the export',url:SITE+'/acme/story/'+id,body:BODY,statusGroup:'todo',statusName:'Ready',repoBinding:binding});

/** Real git repo and launch journal; agents, tabs and terminals are recorded fakes. No `claude` runs. */
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-shortcut-ship-'))),app=path.join(root,'app'),repo=path.join(root,'repo');await fs.mkdir(path.join(app,'mission-control'),{recursive:true});await fs.mkdir(repo);
  for(const args of [['init','-q','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['commit','--allow-empty','-qm','Create fixture']])assert.equal((await command('git',['-C',repo,...args])).code,0);
  const binding={machine:null,repoRoot:repo,shortcut:{connectionId:'shortcut',owner:'cparry',workspace:'acme'}},config=newConfig();
  config.connections.shortcut=connection;config.bindings[bindingKey(null,repo)]=binding;
  // The saved default is the current checkout; a Shortcut ship still gets its own worktree.
  config.preferences.launch={v:1,pins:['claude','codex'],hidden:[],worktree:false,tools:{}};
  await fs.writeFile(path.join(app,'mission-control/config.json'),JSON.stringify(config));
  const space={id:'A',name:'botanic',machine:null,active:true,tabs:[{id:'A-tab'}]},world={spaces:[space]},panes=[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:repo,focused:true}],raws=new Map(),tabs=[],effects=[];let created=0;
  const tools=['claude','codex'].map(key=>({key,name:key==='claude'?'Claude':'Codex',icon:'icons/'+key+'.svg',tint:false,installed:true,run:['qa-'+key]}));
  const scope=trackerScope('shortcut',connection,binding),stored={v:1,entries:{[trackerScopeKey(scope)]:{data:[story(binding,69416)],fetchedAt:Date.now(),scope,truncated:false}}};
  const api={props:{},spaces:()=>world.spaces,panes:()=>panes,focused:()=>({space:'A',pane:'A-pane'}),machines:()=>[{name:null,layout:'ready'}],window:{platform:'macos'},appHome:app,
    shared:{'mission-control-shortcut-ui-v1':{v:1,all:false,query:'',status:'all'},[SNAPSHOT_STATE]:stored},knownAgents:async()=>tools,
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let old=null;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(old,expected);await fs.writeFile(file,text);},
    run:(name,args)=>{effects.push([name,args]);return null;},openOverlay:spec=>{effects.push(['overlay',spec]);return 'overlay';},closeOverlay:()=>null,nextCommand:()=>new Promise(()=>{}),
    exec:async(cmd,args,options={})=>{
      if(cmd==='git'||cmd==='python3'||cmd==='mkdir')return command(cmd,args,options);
      if(cmd==='node')throw Error('A ship never reads Shortcut');
      if(cmd.startsWith('qa-'))return {code:0,stdout:args.includes('--version')?'fixture 1':cmd==='qa-claude'?'Claude Code\nUsage: claude [options] [prompt]\n --model <model>':'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --model <MODEL>\n --no-daemon'};
      if(cmd==='herdr-app'&&args[0]==='do'&&args[1]==='tab.new'){
        const p=JSON.parse(args[2]);created++;tabs.push(p);const local='t'+(created+10),tab='new-'+created;space.tabs.push({id:tab,name:p.name,named:true,terminals:[{terminal:local}]});
        raws.set(local,{address:local,created_ms:Date.now(),foreground:{pid:5000+created},argv:p.argv,labels:{'herdr.space':space.id,'herdr.tab':tab}});return {code:0,stdout:JSON.stringify({space:p.space,tab,terminal:local})};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
      if(cmd==='hc'&&args[0]==='get')return {code:0,stdout:JSON.stringify(raws.get(args[1]))};
      throw Error('Unexpected fixture effect '+cmd+' '+args.join(' '));
    }};
  injectNative(api);const cx=context();cx.timer.every=()=>({cancel(){}});const view=new Shortcut();view.init({},cx);
  const flush=async()=>{let previous=-1;for(let n=0;n<40;n++){const jobs=[...view.jobs];await Promise.all(jobs);if(jobs.length===view.jobs.length&&previous===jobs.length)return;previous=jobs.length;}assert.fail('The view did not settle.');};
  t.after(async()=>{view.close();await Promise.allSettled(view.jobs);await fs.rm(root,{recursive:true,force:true});});
  await flush();
  return {view,cx,repo,tabs,effects,flush,created:()=>created};
}
const card=f=>f.view.data.view().data[0];

test('the ship task names the skill in plain words, is the same for every tool and carries no story body',()=>{
  const b={machine:null,repoRoot:'/repo',shortcut:{connectionId:'shortcut',owner:'cparry',workspace:'acme'}},source=shortcutLaunchSource(story(b,69416));
  assert.equal(source.task,'Use the ship-tickets skill to ship sc-69416.');assert.equal(shipTask('sc-7'),'Use the ship-tickets skill to ship sc-7.');
  assert.equal(source.body,undefined);assert.doesNotMatch(JSON.stringify(source),/PRIVATE/);assert.doesNotMatch(source.task,/^\//);
});

test('card start buttons say Ship and start each tool with the exact task in a new worktree',async t=>{
  for(const tool of ['claude','codex']){
    const f=await fixture(t),row=card(f),id=issueCardId('shortcut-board',row)+'-start-'+tool,button=findElement(f.view.render(f.cx),id),name=tool==='claude'?'Claude':'Codex';
    const tooltip=button.calls.find(c=>c.method==='tooltip').args[0],label=button.calls.find(c=>c.method==='accessibility_label').args[0];
    assert.equal(tooltip,'Ship sc-69416 with '+name);assert.equal(label,'Ship sc-69416 with '+name);
    await trigger(f.view.render(f.cx),id,undefined,{},f.cx);await f.flush();
    assert.equal(f.created(),1,f.view.error);const [tab]=f.tabs;
    assert.equal(tab.task,'Use the ship-tickets skill to ship sc-69416.',tool+': '+JSON.stringify(tab));
    assert.doesNotMatch(JSON.stringify(tab),/PRIVATE|Work on/,tool+' sends no body or wrapper');
    assert.equal(path.basename(tab.folder),'botanic-sc-69416',tool+' runs in its own worktree');assert.notEqual(tab.folder,f.repo);assert.ok((await fs.stat(tab.folder)).isDirectory());
  }
});

test('a second click on a shipped card focuses its agent and sends no new task',async t=>{
  const f=await fixture(t),id=issueCardId('shortcut-board',card(f))+'-start-claude';
  await trigger(f.view.render(f.cx),id,undefined,{},f.cx);await f.flush();assert.equal(f.created(),1,f.view.error);
  const before=f.effects.length;await trigger(f.view.render(f.cx),id,undefined,{},f.cx);await f.flush();
  assert.equal(f.created(),1,'no second tab or task');assert.equal(f.view.error,null);assert.ok(f.effects.slice(before).some(e=>e[0]==='tab.select'),JSON.stringify(f.effects.slice(before)));
});
