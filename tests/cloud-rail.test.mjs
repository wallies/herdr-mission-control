import test from 'node:test';
import assert from 'node:assert/strict';
import Agents from '../src/mods/mission-control-agents/main.js';
import {newRecord,CLOUD_EVENT} from '../src/shared/cloud-sessions.js';
import {injectNative,context,trigger,findElement,Element,shared} from './support/native-recording.mjs';

const ID='session_01HJKLMNOPQRSTUVWXYZ',OTHER='session_OTHER0000000000',ROOT='/fixture/app',STORE=ROOT+'/mission-control/cloud-sessions.json',CONFIG=ROOT+'/mission-control/config.json';
const gh={id:'github-reviews',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',gh:{host:'github.com',account:'cparry'}};
const record=(over={})=>newRecord({ref:ID,repo:'acme/botanic',checkout:'/work/botanic',title:'sc-69416 Fix the export',source:{kind:'shortcut',key:'sc-69416'},createdAt:1000,...over});

/** Local agents as Herdr reports them, the cloud store as a file, and a recorded helper. No claude or gh runs. */
function fixture({props={},sessions=[record()],connection=true,helper=()=>({v:1,ok:true,operation:'message',session:ID}),origin='git@github.com:acme/botanic.git'}={}){
  const effects=[],timers=[],pending=[],files=new Map(),helperCalls=[],space={id:'A',name:'botanic',machine:null,folder:'/work/space',tabs:[{id:'A-tab',name:'1',named:false}]};let tabs=0;
  files.set(CONFIG,JSON.stringify({v:1,revision:0,connections:connection?{[gh.id]:gh}:{},bindings:{},preferences:connection?{reviews:{v:1,connectionId:gh.id,checkouts:[]}}:{},usageSources:{}}));
  if(sessions)files.set(STORE,JSON.stringify({v:1,revision:1,sessions}));
  const program={key:'codex',name:'Codex',icon:'icons/codex.png',tint:false},agents=[{address:'t1',space:'A',tab:'A-tab',title:'Fix login redirect',tab_name:'1',program,status:'working'}];
  const raws=agents.map(a=>({address:a.address,created_ms:100,foreground:{pid:1000},state:'live'}));
  injectNative({props,appHome:ROOT,home:'/fixture',agents,terminals:raws,machines:[{name:null,layout:'ready'}],
    spaces:()=>[space],panes:[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:'/work/botanic/src'}],focused:{space:'A',pane:'A-pane'},
    knownAgents:async()=>[],setAgentOrder:order=>effects.push(['order',order]),run:(...args)=>effects.push(['run',...args]),openOverlay:()=>'o',closeOverlay:()=>null,
    readTextFile:async path=>files.get(path)??null,writeTextFile:async(path,text,expected)=>{assert.equal(files.get(path)??null,expected);files.set(path,text);},
    exec:async(command,args)=>{
      effects.push(['exec',command,args]);
      if(command==='mkdir')return {code:0,stdout:''};
      if(command==='hc')return {code:0,stdout:JSON.stringify(args[0]==='ls'?{terminals:raws}:raws[0])};
      if(command==='herdr-app'&&args[0]==='do'&&args[1]==='tab.new'){const p=JSON.parse(args[2]);const tab='cloud-tab-'+(++tabs);space.tabs.push({id:tab,name:p.name,named:true});return {code:0,stdout:JSON.stringify({space:p.space,tab,pane:'mod-pane-'+tabs})};}
      if(command==='git'&&args.includes('--show-toplevel'))return {code:0,stdout:'/work/botanic\n'};
      if(command==='git'&&args.includes('get-url'))return {code:0,stdout:origin+'\n'};
      if(command==='node'){assert.equal(args[0],ROOT+'/mods/mission-control-agents/backend.mjs');const input=JSON.parse(args[1]);helperCalls.push(input);return {code:0,stdout:JSON.stringify(helper(input))};}
      throw Error('Unexpected effect '+command+' '+args.join(' '));
    }});
  const cx=context();cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancel(){this.cancelled=true;}};timers.push(timer);return timer;};
  cx.spawn=fn=>{const task={done:false,cancel(){},is_done(){return this.done;}};pending.push(Promise.resolve().then(()=>fn(cx)).finally(()=>task.done=true));return task;};
  const view=new Agents();view.init(props,cx);
  const flush=async()=>{for(let i=0;i<pending.length;i++)await pending[i];};
  const stored=()=>JSON.parse(files.get(STORE)).sessions;
  return {view,cx,space,effects,timers,files,helperCalls,flush,stored,render:()=>view.render(cx)};
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
  const opened=[],effects=f.effects.length;f.cx.open_url=url=>opened.push(url);
  trigger(tree,'cloud-'+ID,'on_click',{},f.cx);await f.flush();assert.deepEqual(opened,['https://claude.ai/code/'+ID]);assert.ok(!f.effects.slice(effects).some(e=>e[0]==='exec'),'no helper program is started to open a link');
  f.cx.open_url=()=>{throw Error('refused');};trigger(f.render(),'cloud-'+ID,'on_click',{},f.cx);await f.flush();assert.ok(texts(f.render()).includes('The browser could not open this session.'));
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

test('Message opens the session in its own tab in the main area, and focuses that tab on a second click',async()=>{
  const f=fixture({connection:false});await f.flush();const id='cloud-'+ID;
  assert.throws(()=>findElement(f.render(),id+'-message-input'),/found 0/,'no message box in the rail');
  trigger(f.render(),id+'-message','on_click',{},f.cx);await f.flush();
  const opens=f.effects.filter(e=>e[0]==='exec'&&e[1]==='herdr-app');assert.equal(opens.length,1);
  assert.deepEqual(opens[0][2].slice(0,2),['do','tab.new']);
  assert.deepEqual(JSON.parse(opens[0][2][2]),{space:'A',name:'sc-69416 Fix the export',mod:'mission-control-agents',props:{view:'cloud-session',session:ID},focus:true});
  assert.deepEqual(shared('mission-control-cloud-tabs-v1'),{[ID]:{space:'A',tab:'cloud-tab-1'}});
  trigger(f.render(),id+'-message','on_click',{},f.cx);await f.flush();
  assert.equal(f.effects.filter(e=>e[0]==='exec'&&e[1]==='herdr-app').length,1,'one tab per session');
  assert.deepEqual(f.effects.slice(-3).filter(e=>e[0]==='run'),[['run','space.select',{id:'A'}],['run','tab.select',{id:'cloud-tab-1'}]]);
  f.space.tabs=f.space.tabs.filter(t=>t.id!=='cloud-tab-1');trigger(f.render(),id+'-message','on_click',{},f.cx);await f.flush();
  assert.equal(f.effects.filter(e=>e[0]==='exec'&&e[1]==='herdr-app').length,2,'a closed tab is opened again');
  f.view.close();
});

test('Teleport opens a tab in the current space, in the recorded checkout, running claude --teleport <id>',async()=>{
  const f=fixture({connection:false,sessions:[record(),record({ref:OTHER,checkout:null,title:'Elsewhere'})]});await f.flush();
  trigger(f.render(),'cloud-'+ID+'-teleport','on_click',{},f.cx);
  assert.deepEqual(f.effects.at(-1),['run','tab.new',{space:'A',folder:'/work/botanic',argv:['claude','--teleport',ID],name:'Teleport sc-69416 Fix the export'}]);
  trigger(f.render(),'cloud-'+OTHER+'-teleport','on_click',{},f.cx);
  assert.deepEqual(f.effects.at(-1),['run','tab.new',{space:'A',folder:'/work/space',argv:['claude','--teleport',OTHER],name:'Teleport Elsewhere'}],'without a checkout it uses the space folder');
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

const sessionView=over=>fixture({connection:false,props:{view:'cloud-session',session:ID},...over});
const PR={number:12,url:'https://github.com/acme/botanic/pull/12',state:'open',draft:true,checks:'success',review:'reviewRequired'};

test('the session tab shows title, repo, status and PR, opens links with open_url and teleports from the record’s checkout',async()=>{
  const f=sessionView({sessions:[{...record(),pr:PR}]});await f.flush();const tree=f.render(),values=texts(tree);
  assert.ok(values.includes('sc-69416 Fix the export'));assert.ok(values.includes('acme/botanic'));assert.ok(values.includes('Draft'));assert.ok(values.includes('#12'));
  assert.ok(texts(findElement(tree,'cloud-session-replies'))[0].startsWith('Replies are on claude.ai, or here after Teleport'));
  assert.ok(values.includes('Nothing sent from here yet.'));
  const opened=[];f.cx.open_url=url=>opened.push(url);
  trigger(tree,'cloud-session-pr','on_click',{},f.cx);trigger(tree,'cloud-session-browser','on_click',{},f.cx);
  assert.deepEqual(opened,[PR.url,'https://claude.ai/code/'+ID]);
  trigger(tree,'cloud-session-teleport','on_click',{},f.cx);
  assert.deepEqual(f.effects.at(-1),['run','tab.new',{space:'A',folder:'/work/botanic',argv:['claude','--teleport',ID],name:'Teleport sc-69416 Fix the export'}]);
  f.view.close();
});

test('Send queues the message and lists it newest first; a failure is listed with its fixed message and keeps the text',async()=>{
  const f=sessionView();await f.flush();const box=f.view.session.box;
  trigger(f.render(),'cloud-session-send','on_click',{},f.cx);await f.flush();
  assert.equal(f.helperCalls.length,0,'an empty box sends nothing');assert.ok(texts(f.render()).includes('Type a message first.'));
  box.set_value('Rebase on main');trigger(f.render(),'cloud-session-send','on_click',{},f.cx);await f.flush();
  box.set_value('Then push');trigger(f.render(),'cloud-session-send','on_click',{},f.cx);await f.flush();
  assert.deepEqual(f.helperCalls,[{v:1,operation:'message',session:ID,message:'Rebase on main'},{v:1,operation:'message',session:ID,message:'Then push'}]);
  const sent=f.stored()[0].messages;assert.deepEqual(sent.map(m=>[m.text,m.state,m.error]),[['Rebase on main','queued',null],['Then push','queued',null]]);assert.equal(box.value(),'');
  const list=texts(findElement(f.render(),'cloud-session-sent'));assert.ok(list.indexOf('Then push')<list.indexOf('Rebase on main'),'newest first');assert.equal(list.filter(v=>v==='Queued').length,2);
  assert.ok(shared(CLOUD_EVENT),'the rail is told the record changed');
  f.view.close();
  const failing=sessionView({helper:()=>({v:1,ok:false,error:{code:'SESSION_ARCHIVED',message:'This cloud session is archived and cannot take new messages.'}})});await failing.flush();
  failing.view.session.box.set_value('hello');trigger(failing.render(),'cloud-session-send','on_click',{},failing.cx);await failing.flush();
  assert.deepEqual(failing.stored()[0].messages.map(m=>[m.text,m.state,m.error]),[['hello','failed','This cloud session is archived and cannot take new messages.']]);
  const shown=texts(findElement(failing.render(),'cloud-session-sent'));assert.ok(shown.includes('Failed'));assert.ok(shown.includes('This cloud session is archived and cannot take new messages.'));
  assert.equal(failing.view.session.box.value(),'hello');failing.view.close();
});

test('Ctrl+Enter (or Cmd+Enter) sends; Enter alone does not',async()=>{
  const f=sessionView();await f.flush();f.view.session.box.set_value('Go');
  trigger(f.render(),'cloud-session-compose','on_key_down',{keystroke:'enter',key:'enter'},f.cx);await f.flush();assert.equal(f.helperCalls.length,0);
  trigger(f.render(),'cloud-session-compose','on_key_down',{keystroke:'ctrl-enter',key:'enter'},f.cx);await f.flush();assert.equal(f.helperCalls.length,1);
  f.view.session.box.set_value('Again');trigger(f.render(),'cloud-session-compose','on_key_down',{keystroke:'cmd-enter',key:'enter'},f.cx);await f.flush();assert.equal(f.helperCalls.length,2);
  f.view.close();
});

test('a session tab for a session no longer followed says so',async()=>{
  const f=sessionView({sessions:[]});await f.flush();assert.ok(texts(f.render()).includes('Mission Control no longer follows this cloud session.'));f.view.close();
});
