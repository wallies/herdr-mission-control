import test from 'node:test';
import assert from 'node:assert/strict';
import Agents from '../src/mods/mission-control-agents/main.js';
import {newRecord,CLOUD_EVENT} from '../src/shared/cloud-sessions.js';
import {injectNative,context,trigger,findElement,Element,shared} from './support/native-recording.mjs';

const ID='session_01HJKLMNOPQRSTUVWXYZ',OTHER='session_OTHER0000000000',ROOT='/fixture/app',STORE=ROOT+'/mission-control/cloud-sessions.json',CONFIG=ROOT+'/mission-control/config.json';
const gh={id:'github-reviews',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',gh:{host:'github.com',account:'cparry'}};
const record=(over={})=>newRecord({ref:ID,repo:'acme/botanic',checkout:'/work/botanic',title:'sc-69416 Fix the export',source:{kind:'shortcut',key:'sc-69416'},createdAt:1000,...over});

/** Local agents as Herdr reports them, the cloud store as a file, and a recorded helper. No claude or gh runs. */
function fixture({sessions=[record()],connection=true,helper=()=>({v:1,ok:true,operation:'message',session:ID}),origin='git@github.com:acme/botanic.git'}={}){
  const effects=[],timers=[],pending=[],files=new Map(),helperCalls=[];
  files.set(CONFIG,JSON.stringify({v:1,revision:0,connections:connection?{[gh.id]:gh}:{},bindings:{},preferences:connection?{reviews:{v:1,connectionId:gh.id,checkouts:[]}}:{},usageSources:{}}));
  if(sessions)files.set(STORE,JSON.stringify({v:1,revision:1,sessions}));
  const program={key:'codex',name:'Codex',icon:'icons/codex.png',tint:false},agents=[{address:'t1',space:'A',tab:'A-tab',title:'Fix login redirect',tab_name:'1',program,status:'working'}];
  const raws=agents.map(a=>({address:a.address,created_ms:100,foreground:{pid:1000},state:'live'}));
  injectNative({props:{},appHome:ROOT,home:'/fixture',agents,terminals:raws,machines:[{name:null,layout:'ready'}],
    spaces:[{id:'A',name:'botanic',machine:null,tabs:[{id:'A-tab',name:'1',named:false}]}],panes:[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:'/work/botanic/src'}],focused:{space:'A',pane:'A-pane'},
    knownAgents:async()=>[],setAgentOrder:order=>effects.push(['order',order]),run:(...args)=>effects.push(['run',...args]),openOverlay:()=>'o',closeOverlay:()=>null,
    readTextFile:async path=>files.get(path)??null,writeTextFile:async(path,text,expected)=>{assert.equal(files.get(path)??null,expected);files.set(path,text);},
    exec:async(command,args)=>{
      effects.push(['exec',command,args]);
      if(command==='mkdir')return {code:0,stdout:''};
      if(command==='hc')return {code:0,stdout:JSON.stringify(args[0]==='ls'?{terminals:raws}:raws[0])};
      if(command==='open')return {code:0,stdout:''};
      if(command==='git'&&args.includes('--show-toplevel'))return {code:0,stdout:'/work/botanic\n'};
      if(command==='git'&&args.includes('get-url'))return {code:0,stdout:origin+'\n'};
      if(command==='node'){assert.equal(args[0],ROOT+'/mods/mission-control-agents/backend.mjs');const input=JSON.parse(args[1]);helperCalls.push(input);return {code:0,stdout:JSON.stringify(helper(input))};}
      throw Error('Unexpected effect '+command+' '+args.join(' '));
    }});
  const cx=context();cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancel(){this.cancelled=true;}};timers.push(timer);return timer;};
  cx.spawn=fn=>{const task={done:false,cancel(){},is_done(){return this.done;}};pending.push(Promise.resolve().then(()=>fn(cx)).finally(()=>task.done=true));return task;};
  const view=new Agents();view.init({},cx);
  const flush=async()=>{for(let i=0;i<pending.length;i++)await pending[i];};
  const stored=()=>JSON.parse(files.get(STORE)).sessions;
  return {view,cx,effects,timers,files,helperCalls,flush,stored,render:()=>view.render(cx)};
}
function texts(root){const result=[];const walk=node=>{if(typeof node==='string')result.push(node);else if(node instanceof Element)node.nodes.forEach(walk);};walk(root);return result;}

test('cloud rows show beside local agents with a cloud marker, title, repo and status, and open their link',async()=>{
  const f=fixture({helper:()=>({v:1,ok:true,operation:'pulls',checkedAt:5,found:{[ID]:null}})});await f.flush();const tree=f.render();
  assert.ok(findElement(tree,'agent-t1'),'local agents are unchanged');
  const order=[];const collect=node=>{if(node instanceof Element){if(node.semanticId)order.push(node.semanticId);node.nodes.forEach(collect);}};collect(tree);
  assert.ok(order.indexOf('cloud-sessions')>=0&&order.indexOf('cloud-sessions')<order.indexOf('agent-t1'),'the Cloud group sits above the local agents, so its form is in view');
  const row=findElement(tree,'cloud-'+ID),values=texts(row);
  assert.ok(values.includes('sc-69416 Fix the export'));assert.ok(values.includes('acme/botanic · Started'));
  assert.ok(findElement(row,'cloud-'+ID+'-message'));assert.ok(findElement(row,'cloud-'+ID+'-teleport'));assert.ok(findElement(row,'cloud-'+ID+'-remove'));
  const walk=(n,out=[])=>{if(n instanceof Element){if(n.kind==='svg')out.push(n.value);n.nodes.forEach(c=>walk(c,out));}return out;};assert.ok(walk(row).includes('mods/mission-control-agents/assets/cloud.svg'));
  assert.deepEqual(f.effects.findLast(e=>e[0]==='order')[1],['t1'],'cloud rows never join agent navigation');
  trigger(tree,'cloud-'+ID,'on_click',{},f.cx);await f.flush();assert.deepEqual(f.effects.at(-1),['exec','open',['https://claude.ai/code/'+ID]]);
  f.view.close();
});

test('pull request state is looked up through the helper and shown; merged sessions are not looked up again',async()=>{
  const pr={number:12,url:'https://github.com/acme/botanic/pull/12',state:'open',draft:false,checks:'failure',review:null};
  const f=fixture({sessions:[record(),record({ref:OTHER,title:'Done one'})],helper:input=>({v:1,ok:true,operation:'pulls',checkedAt:9000,found:{[ID]:pr,[OTHER]:{...pr,number:13,url:'https://github.com/acme/botanic/pull/13',state:'merged'}}})});
  await f.flush();
  assert.deepEqual(f.helperCalls[0],{v:1,operation:'pulls',connection:gh,sessions:[{id:ID,repo:'acme/botanic',number:null},{id:OTHER,repo:'acme/botanic',number:null}]});
  assert.ok(texts(f.render()).includes('acme/botanic · Checks failing'));assert.ok(texts(f.render()).includes('acme/botanic · Merged'));
  assert.equal(f.stored()[0].checkedAt,9000);
  f.view.cloud.data.pendingAt=0;f.timers.at(-1).fn(f.cx);await f.flush();
  assert.deepEqual(f.helperCalls[1].sessions,[{id:ID,repo:'acme/botanic',number:12}],'merged is final; a found pull request is read by its number');
  f.view.close();
});

test('without the Reviews gh connection the rail says so and runs no lookup',async()=>{
  const f=fixture({connection:false});await f.flush();
  assert.equal(f.helperCalls.length,0);assert.ok(texts(f.render()).includes('Set up the Reviews gh connection to follow pull requests.'));f.view.close();
});

test('Message sends the typed text through the helper and reports the result on the row',async()=>{
  const f=fixture({connection:false});await f.flush();const id='cloud-'+ID;
  trigger(f.render(),id+'-message','on_click',{},f.cx);const box=f.view.cloud.boxes.get(ID);assert.ok(findElement(f.render(),id+'-message-input'));
  trigger(f.render(),id+'-send','on_click',{},f.cx);await f.flush();assert.equal(f.helperCalls.length,0,'an empty box sends nothing');assert.ok(texts(f.render()).includes('Type a message first.'));
  box.set_value('Rebase on main, then push');trigger(f.render(),id+'-send','on_click',{},f.cx);await f.flush();
  assert.deepEqual(f.helperCalls,[{v:1,operation:'message',session:ID,message:'Rebase on main, then push'}]);assert.ok(texts(f.render()).includes('Message sent.'));assert.equal(box.value(),'');
  f.view.close();
  const failing=fixture({connection:false,helper:()=>({v:1,ok:false,error:{code:'NOT_SIGNED_IN',message:'Claude Code is not signed in with a claude.ai account.'}})});await failing.flush();
  trigger(failing.render(),id+'-message','on_click',{},failing.cx);failing.view.cloud.boxes.get(ID).set_value('hi');trigger(failing.render(),id+'-send','on_click',{},failing.cx);await failing.flush();
  assert.ok(texts(failing.render()).includes('Claude Code is not signed in with a claude.ai account.'));failing.view.close();
});

test('Teleport opens a tab in the current space, in the recorded checkout, running claude --teleport <id>',async()=>{
  const f=fixture({connection:false,sessions:[record(),record({ref:OTHER,checkout:null,title:'Elsewhere'})]});await f.flush();
  trigger(f.render(),'cloud-'+ID+'-teleport','on_click',{},f.cx);
  assert.deepEqual(f.effects.at(-1),['run','tab.new',{space:'A',folder:'/work/botanic',argv:['claude','--teleport',ID],name:'Teleport sc-69416 Fix the export'}]);
  const tree=f.render(),before=f.effects.length;assert.throws(()=>trigger(tree,'cloud-'+OTHER+'-teleport','on_click',{},f.cx),/Missing on_click/,'disabled without a checkout');assert.equal(f.effects.length,before);
  f.view.close();
});

test('Remove forgets the record only and tells other copies',async()=>{
  const f=fixture({connection:false,sessions:[record(),record({ref:OTHER,title:'Keep'})]});await f.flush();
  trigger(f.render(),'cloud-'+ID+'-remove','on_click',{},f.cx);await f.flush();
  assert.deepEqual(f.stored().map(r=>r.id),[OTHER]);assert.ok(shared(CLOUD_EVENT));assert.ok(!f.effects.some(e=>e[0]==='exec'&&e[1]==='node'),'nothing is sent to the session');
  assert.throws(()=>findElement(f.render(),'cloud-'+ID),/found 0/);f.view.close();
});

test('Add follows a session by URL or by id, with its repo; the focused checkout is recorded when its origin matches',async()=>{
  const f=fixture({sessions:null,connection:false});await f.flush();
  assert.throws(()=>findElement(f.render(),'cloud-sessions'),/found 0/,'no Cloud group until there is something to show');
  trigger(f.render(),'agents-cloud-add','on_click',{},f.cx);const rail=f.view.cloud;
  rail.ref.set_value('https://claude.ai/code/'+ID+'?from=cli');rail.repo.set_value('acme/botanic');trigger(f.render(),'cloud-add-save','on_click',{},f.cx);await f.flush();
  let [added]=f.stored();assert.equal(added.id,ID);assert.equal(added.url,'https://claude.ai/code/'+ID);assert.equal(added.repo,'acme/botanic');assert.equal(added.checkout,'/work/botanic');assert.equal(added.source,null);assert.equal(rail.adding,false);
  trigger(f.render(),'agents-cloud-add','on_click',{},f.cx);rail.ref.set_value(OTHER);rail.repo.set_value('acme/seed');trigger(f.render(),'cloud-add-save','on_click',{},f.cx);await f.flush();
  added=f.stored()[1];assert.equal(added.id,OTHER);assert.equal(added.checkout,null,'the focused checkout is another repository');
  f.view.close();
});

test('Add rejects bad input before anything is written',async()=>{
  const f=fixture({sessions:null,connection:false});await f.flush();trigger(f.render(),'agents-cloud-add','on_click',{},f.cx);const rail=f.view.cloud;
  for(const [ref,repo,message] of [['not a session','acme/botanic',/cloud session URL/],['https://evil.example/code/'+ID,'acme/botanic',/cloud session URL/],[ID,'botanic',/owner\/name/],[ID,'acme/botanic repo:x',/owner\/name/]]){
    rail.ref.set_value(ref);rail.repo.set_value(repo);trigger(f.render(),'cloud-add-save','on_click',{},f.cx);await f.flush();
    assert.match(rail.addError,message);assert.ok(texts(findElement(f.render(),'cloud-add-error')).length);assert.equal(f.files.get(STORE),undefined);
  }
  rail.ref.set_value(ID);rail.repo.set_value('acme/botanic');trigger(f.render(),'cloud-add-save','on_click',{},f.cx);await f.flush();
  trigger(f.render(),'agents-cloud-add','on_click',{},f.cx);rail.ref.set_value('cse_01HJKLMNOPQRSTUVWXYZ');rail.repo.set_value('acme/botanic');trigger(f.render(),'cloud-add-save','on_click',{},f.cx);await f.flush();
  assert.match(rail.addError,/already follows/);assert.equal(f.stored().length,1);f.view.close();
});
