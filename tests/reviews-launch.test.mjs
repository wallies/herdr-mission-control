import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Reviews from '../src/mods/mission-control-reviews/main.js';
import {newConfig} from '../src/shared/config.js';
import {injectNative,context,trigger,findElement} from './support/native-recording.mjs';

const run=promisify(execFile),SITE='https://github.com',NOW=Date.now();
async function command(cmd,args,options={}){try{const r=await run(cmd,args,{cwd:options.cwd,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
const connection={id:'work',kind:'github',site:SITE,apiBase:'https://api.github.com',gh:{host:'github.com',account:'cparry'}};
const review=(n,section,repo='web')=>({identity:{kind:'github-pr',connectionId:'work',site:SITE,owner:'acme',repo,number:n},key:'GH-PR-'+n,url:SITE+'/acme/'+repo+'/pull/'+n,title:'PRIVATE title '+n,author:{login:'alice',url:SITE+'/alice'},draft:n===8,section,waitingSince:NOW-3*3600000,review:'reviewRequired',checks:'success'});
const reply={v:1,ok:true,operation:'reviews',snapshot:{fetchedAt:NOW,direct:[review(7,'direct')],team:[review(8,'team'),review(9,'team','api')],truncated:false,incomplete:false,detailsUnavailable:false}};
const LEAD='Use the review-this skill on https://github.com/acme/web/pull/7.';

/** Real git checkouts and launch journal; the gh helper, agents, tabs and terminals are recorded fakes. */
async function fixture(t,{layout=null,workspace=true}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-reviews-launch-'))),app=path.join(root,'app'),home=path.join(root,'home'),repo=path.join(home,'workspace/acme/web');
  await fs.mkdir(path.join(app,'mission-control'),{recursive:true});await fs.mkdir(repo,{recursive:true});
  for(const args of [['init','-q','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['commit','--allow-empty','-qm','Create fixture'],...(workspace?[['remote','add','origin','git@github.com:acme/web.git']]:[])])assert.equal((await command('git',['-C',repo,...args])).code,0);
  const config=newConfig();config.connections.work=connection;config.preferences.reviews={v:1,connectionId:'work',checkouts:[]};
  config.preferences.launch={v:1,pins:['claude','codex'],hidden:[],worktree:false,tools:{}};
  await fs.writeFile(path.join(app,'mission-control/config.json'),JSON.stringify(config));
  const space={id:'A',name:'reviews',machine:null,active:true,tabs:[{id:'A-tab'}]},world={spaces:[space]},raws=new Map(),tabs=[],effects=[],reads=[];let created=0;
  const tools=['claude','codex'].map(key=>({key,name:key==='claude'?'Claude':'Codex',icon:'icons/'+key+'.svg',tint:false,installed:true,run:['qa-'+key]}));
  const api={props:{hideHeader:true},spaces:()=>world.spaces,panes:()=>[],focused:()=>({space:'A',pane:null}),machines:()=>[{name:null,layout:'ready'}],window:{platform:'linux'},appHome:app,home,layout:()=>layout,shared:{},knownAgents:async()=>tools,
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let old=null;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(old,expected);await fs.writeFile(file,text);},
    run:(name,args)=>{effects.push([name,args]);return null;},openOverlay:spec=>{effects.push(['overlay',spec]);return 'overlay';},closeOverlay:()=>null,nextCommand:()=>new Promise(()=>{}),
    exec:async(cmd,args,options={})=>{
      if(cmd==='git'||cmd==='python3'||cmd==='mkdir')return command(cmd,args,options);
      if(cmd==='node'){reads.push(JSON.parse(args[1]));return {code:0,stdout:JSON.stringify(reply)};}
      if(cmd.startsWith('qa-'))return {code:0,stdout:args.includes('--version')?'fixture 1':cmd==='qa-claude'?'Claude Code\nUsage: claude [options] [prompt]\n --model <model>':'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --model <MODEL>'};
      if(cmd==='herdr-app'&&args[0]==='do'&&args[1]==='tab.new'){
        const p=JSON.parse(args[2]);created++;tabs.push(p);const local='t'+(created+10),tab='new-'+created;space.tabs.push({id:tab,name:p.name,named:true,terminals:[{terminal:local}]});
        raws.set(local,{address:local,created_ms:Date.now(),foreground:{pid:5000+created},argv:p.argv,labels:{'herdr.space':space.id,'herdr.tab':tab}});return {code:0,stdout:JSON.stringify({space:p.space,tab,terminal:local})};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
      if(cmd==='hc'&&args[0]==='get')return {code:0,stdout:JSON.stringify(raws.get(args[1]))};
      throw Error('Unexpected fixture effect '+cmd+' '+args.join(' '));
    }};
  injectNative(api);const cx=context();cx.timer.every=()=>({cancel(){}});const view=new Reviews();view.init({},cx);
  const flush=async()=>{let previous=-1;for(let n=0;n<40;n++){const jobs=[...view.jobs];await Promise.all(jobs);if(jobs.length===view.jobs.length&&previous===jobs.length)return;previous=jobs.length;}assert.fail('The view did not settle.');};
  t.after(async()=>{view.close();await Promise.allSettled(view.jobs);await fs.rm(root,{recursive:true,force:true});});
  await flush();view.render(cx);await flush();
  return {view,cx,repo,tabs,effects,reads,flush,created:()=>created};
}
const button=(key,tool)=>'reviews-card-'+key+'-review-'+tool;
const click=async(f,id)=>{await trigger(f.view.render(f.cx),id,undefined,{},f.cx);await f.flush();};

test('cards sit in Asked of you, then Asked of your teams, and the start buttons say Review',async t=>{
  const f=await fixture(t),tree=f.view.render(f.cx);assert.equal(f.reads.length,1);assert.equal(f.reads[0].operation,'reviews');
  findElement(findElement(tree,'reviews-section-direct'),'reviews-card-acme-web-7');findElement(findElement(tree,'reviews-section-team'),'reviews-card-acme-api-9');
  for(const [tool,name] of [['claude','Claude'],['codex','Codex']]){
    const el=findElement(tree,button('acme-web-7',tool));
    assert.equal(el.calls.find(c=>c.method==='tooltip').args[0],'Review acme/web#7 with '+name);assert.equal(el.calls.find(c=>c.method==='accessibility_label').args[0],'Review acme/web#7 with '+name);
    assert.ok(el.nodes.some(n=>n.nodes?.includes('Review')),'the button reads Review');
  }
  findElement(tree,'reviews-card-acme-web-8-draft');findElement(tree,'reviews-card-acme-web-7-instructions');
  assert.match(findElement(tree,'reviews-card-acme-web-7-waiting').calls.find(c=>c.method==='tooltip').args[0],/last update/);
  assert.match(findElement(tree,'reviews-status').nodes[0],/1 asked of you · 2 asked of your teams/);
});

test('Review starts each tool in a new worktree of the PR’s repository with the exact task',async t=>{
  for(const tool of ['claude','codex']){
    const f=await fixture(t);await click(f,button('acme-web-7',tool));
    assert.equal(f.created(),1,f.view.error);const [tab]=f.tabs;
    assert.equal(tab.task,LEAD,tool);assert.equal(tab.space,'A','opens in the space the mod is shown in');
    assert.doesNotMatch(tab.task,/PRIVATE|^\//);assert.notEqual(tab.folder,f.repo);assert.equal(path.basename(tab.folder),'reviews-review-web-7-'+tool);
    assert.ok((await fs.stat(tab.folder)).isDirectory());assert.equal(f.view.info,'Review started.');
  }
});

test('multi-line instructions follow the first sentence; a tab character is refused before launch',async t=>{
  const f=await fixture(t);f.view.notes.get('acme/web#7').set_value('Focus on the migration.\nThen the API.');await click(f,button('acme-web-7','claude'));
  assert.equal(f.tabs[0].task,LEAD+' Focus on the migration.\nThen the API.');
  f.view.notes.get('acme/web#8').set_value('bad\tvalue');await click(f,button('acme-web-8','claude'));
  assert.equal(f.created(),1,'nothing is launched');findElement(f.view.render(f.cx),'reviews-card-acme-web-8-error');
});

test('a second click on a reviewed card focuses its agent and sends nothing',async t=>{
  const f=await fixture(t);await click(f,button('acme-web-7','claude'));assert.equal(f.created(),1,f.view.error);
  f.view.notes.get('acme/web#7').set_value('A different ask');const before=f.effects.length;await click(f,button('acme-web-7','claude'));
  assert.equal(f.created(),1,'no second tab or task');assert.equal(f.view.error,null);assert.ok(f.effects.slice(before).some(e=>e[0]==='tab.select'),JSON.stringify(f.effects.slice(before)));
  assert.equal(f.view.info,'Opened the existing review agent. No new task was sent.');
});

test('with no checkout found it asks for the folder once, in a dialog that carries the review',async t=>{
  const f=await fixture(t,{workspace:false});await click(f,button('acme-web-7','claude'));
  assert.equal(f.created(),0);const [,spec]=f.effects.find(e=>e[0]==='overlay');
  assert.equal(spec.props.view,'checkout');assert.deepEqual([spec.props.toolKey,spec.props.instructions,spec.props.spaceId,spec.props.machine,spec.props.review.url],['claude','','A',null,SITE+'/acme/web/pull/7']);
});

test('inside the Mission Control stack the queue reads only while it is the selected source',async t=>{
  const stack=active=>({id:'root',children:[{id:'mc-work-stack',type:'stack',active,children:[{id:'jira'},{id:'reviews'}]}]});
  const hidden=await fixture(t,{layout:stack('jira')});assert.equal(hidden.reads.length,0);
  const shown=await fixture(t,{layout:stack('reviews')});assert.equal(shown.reads.length,1);
});
