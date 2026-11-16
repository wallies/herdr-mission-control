import {View,div} from 'gpui-kit';
import {v_flex,h_flex,InputState,Input} from 'gpui-base';
import * as herdr from 'herdr';
import {readConfig} from '../../shared/config.js';
import {validateIssue,validateRepoBinding,issueIdentityKey} from '../../shared/tracker-model.js';
import {resolveSpaceRepo,launchTarget} from '../../shared/space-repo.js';
import {createLaunchIO} from '../../shared/launch.js';
import {LaunchDialog,openLaunchDialog,quickStart} from '../../shared/launch-dialog.js';
import {IssueBoardState,renderIssueBoard} from '../../shared/issue-board.js';
import {ShortcutDataBridge,SNAPSHOT_STATE,shortcutConnection} from './data.js';
import {colors,label,icon,iconButton,textButton} from '../../shared/ui.js';

const MOD='mission-control-shortcut',STATE='mission-control-shortcut-ui-v1',CONFIG_EVENT='mission-control-shortcut-config-v1',DATA_EVENT='mission-control-shortcut-data-v1';
const COLUMNS=['todo','inProgress'],UI_STATES=['all',...COLUMNS];
const copy=value=>JSON.parse(JSON.stringify(value)),machineKey=machine=>JSON.stringify(machine);
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const sameRepo=(a,b)=>a?.machine===b?.machine&&a?.repoRoot===b?.repoRoot;
function uiState(){const s=herdr.shared(STATE);return {all:s?.v===1&&s.all===true,query:typeof s?.query==='string'&&s.query.length<=512?s.query:'',status:UI_STATES.includes(s?.status)?s.status:'all'};}
const snapshotStore={read:()=>herdr.shared(SNAPSHOT_STATE),write:value=>herdr.setShared(SNAPSHOT_STATE,value)};

export function shortcutLaunchSource(value){const issue=validateIssue(value);if(issue.identity.kind!=='shortcut')fail('INVALID_SCOPE','Select a Shortcut story.');return {kind:'shortcut',connectionId:issue.identity.connectionId,site:issue.identity.site,id:issue.identity.id,key:issue.key,title:issue.title,url:issue.url,body:issue.body};}

/** Snapshot space/pane identity before the first await; never consult later active-space state. */
async function captureRepository(binding,{all=false,resolved,originPane,isCurrent=()=>true,api=herdr}={}){
  const world=copy(api.spaces()),focus=api.focused(),panes=api.panes().map(p=>({...p,focused:p.focused||p.pane===focus?.pane}));
  const machine=api.machines().find(m=>m.name===binding.machine);if(!machine||machine.layout!=='ready')fail('HOST_UNAVAILABLE','The story’s execution machine is offline or still connecting.');
  const exec=async(...args)=>{if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');const result=await api.exec(...args);if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');return result;};
  const check=async(space,{singlePane}={})=>{
    const scoped=panes.filter(p=>(space.tabs||[]).some(t=>t.id===p.tab)),chosen=singlePane?scoped.filter(p=>p.pane===singlePane):scoped;
    let result=await resolveSpaceRepo(all?{...space,active:false}:space,chosen,exec);
    if(all&&result.state==='ambiguous'){const match=result.candidates.find(c=>c.repoRoot===binding.repoRoot);if(match)result=await resolveSpaceRepo({...space,active:false},scoped.filter(p=>p.pane===match.paneId),exec);}
    return result.state==='resolved'&&sameRepo(result,binding)?result:null;
  };
  let selected;
  if(!all){
    if(resolved?.state!=='resolved'||!sameRepo(resolved,binding))fail('INVALID_SCOPE','The clicked story is no longer bound to this repository. Reload the space.');
    const space=world.find(s=>s.id===resolved.spaceId&&s.machine===binding.machine);if(!space)fail('SPACE_UNAVAILABLE','The clicked story’s repository space is unavailable.');
    const liveFocus=panes.find(p=>p.terminal&&p.focused&&(space.tabs||[]).some(t=>t.id===p.tab));selected=await check(space,{singlePane:liveFocus?.pane||originPane||resolved.paneId});
  }else{
    for(const space of world.filter(s=>s.machine===binding.machine)){selected=await check(space);if(selected)break;}
  }
  if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');if(!selected)fail('REPO_UNAVAILABLE','Open or focus a terminal in this story’s repository before starting work.');
  return selected;
}
export async function captureShortcutTarget(value,options={}){
  const issue=validateIssue(value),selected=await captureRepository(issue.repoBinding,options),target=launchTarget(selected);if(options.all)target.checkoutRoot=issue.repoBinding.repoRoot;
  return {issue,source:shortcutLaunchSource(issue),target};
}

export default class MissionControlShortcut extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view||'panel';this.closed=false;this.jobs=[];this.timers=[];this.inputs=[];this.originPanes=new Map();this.tools=new Map();this.toolTimes=new Map();this.toolPending=new Set();this.launching=new Set();this.contextEpoch=0;this.formEpoch=0;this.seq=0;this.error=null;this.instance=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);this.io=createLaunchIO(herdr);
    if(['launch','settings','menu'].includes(this.role)){this.dialog=new LaunchDialog(MOD,this.props,herdr);this.dialog.init(cx);return;}
    this.data=new ShortcutDataBridge(this.io,{store:snapshotStore,onChange:()=>{if(!this.closed)herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});}});
    if(this.role==='setup'){
      this.setupLoading=true;this.capturedWorld=this.world();this.spawn(cx,async()=>{try{this.config=(await readConfig(this.io)).value;if(this.closed)return;if(this.props.target)this.setupTarget=validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot});else await this.resolveSetup(this.capturedWorld.space,this.capturedWorld.panes);if(!this.closed&&this.setupTarget)this.initializeForm();}finally{this.setupLoading=false;}});return;
    }
    const saved=uiState();this.all=this.props.scope==='all'||this.props.scope!=='space'&&saved.all;
    this.board=new IssueBoardState({query:saved.query,status:saved.status,onChange:()=>this.saveUI()});this.lastConfig=JSON.stringify(herdr.shared(CONFIG_EVENT)||null);this.lastStore=herdr.shared(SNAPSHOT_STATE);this.contextKey=null;
    this.syncFromWorld(cx,{force:true});
    // A read the host ended mid-flight is released here; it is never retried on its own because each read is a paid model call.
    this.timers.push(cx.timer.every(5000,()=>{if(!this.closed&&this.data.hasAbandonedLoad())this.data.releaseAbandoned();}));
    this.commandTask=cx.spawn(async(eventCx)=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;if(command==='refresh')this.refresh(eventCx);else if(command==='setup')this.openSetup(undefined,eventCx);else if(command==='all-spaces')this.setScope(true,eventCx);else if(command==='this-space')this.setScope(false,eventCx);eventCx.notify();}});
  }
  spawn(cx,work){
    this.jobs=this.jobs.filter(job=>!job?.is_done?.());const job=cx.spawn(async(eventCx)=>{try{await work(eventCx);}catch(error){if(!this.closed&&error?.code!=='REQUEST_CANCELLED')this.error=error?.code?error.message:'Shortcut could not complete this action. Check the connection and retry.';}if(!this.closed)eventCx.notify();});this.jobs.push(job);return job;
  }
  world(){
    const spaces=herdr.spaces(),focused=herdr.focused(),panes=herdr.panes().map(p=>({...p,focused:p.focused||p.pane===focused?.pane}));
    for(const space of spaces){const pane=panes.find(p=>p.terminal&&p.focused&&space.tabs.some(t=>t.id===p.tab));if(pane)this.originPanes.set(space.id,pane.pane);}
    const wanted=this.props.target?.spaceId||this.props.spaceId||focused?.space,expected=this.props.target&&Object.hasOwn(this.props.target,'machine')?this.props.target.machine:Object.hasOwn(this.props,'machine')?this.props.machine:undefined,space=spaces.find(s=>s.id===wanted&&(expected===undefined||s.machine===expected));
    return {spaces:copy(spaces),space:space?copy(space):null,panes};
  }
  saveUI(){if(this.board)herdr.setShared(STATE,{v:1,all:this.all,...this.board.filters()});}
  setScope(all,cx){if(this.all===all)return;this.all=all;this.saveUI();this.contextKey=null;this.syncFromWorld(cx,{force:true});}
  discover(machine,cx){
    const key=machineKey(machine),host=herdr.machines().find(m=>m.name===machine);if(host?.layout!=='ready'||this.toolPending.has(key)||Date.now()-(this.toolTimes.get(key)||0)<60000)return;
    this.toolPending.add(key);return this.spawn(cx,async()=>{try{const tools=await herdr.knownAgents({on:machine});if(!this.closed){this.tools.set(key,tools);this.toolTimes.set(key,Date.now());}}catch{this.tools.delete(key);}finally{this.toolPending.delete(key);}});
  }
  /** Resolves the repository and shows cached cards. It never starts a read: only Refresh does. */
  syncFromWorld(cx,{force=false}={}){
    if(this.closed||this.role!=='panel')return;const captured=this.world(),revision=JSON.stringify(herdr.shared(CONFIG_EVENT)||null),space=captured.space,origin=space?this.originPanes.get(space.id):null;
    const eligible=captured.panes.filter(p=>space?.tabs.some(t=>t.id===p.tab)),bound=this.props.target?.repoRoot&&!this.props.target.spaceId,key=this.all?'all':bound?JSON.stringify(['bound',this.props.target.machine,this.props.target.repoRoot]):JSON.stringify([space?.id??null,space?.machine??null,origin??null,eligible.map(p=>[p.pane,p.terminal,p.cwd])]);
    const changed=key!==this.contextKey||revision!==this.lastConfig;if(!force&&!changed)return;
    this.contextKey=key;this.lastConfig=revision;const epoch=++this.contextEpoch;if(changed){this.resolved=null;this.data.clearSelection();}this.error=null;
    return this.spawn(cx,async(eventCx)=>{
      let resolved=null;
      if(!this.all&&this.props.target?.repoRoot&&!this.props.target.spaceId){
        const binding=validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot});
        try{resolved=await captureRepository(binding,{all:true,isCurrent:()=>!this.closed&&epoch===this.contextEpoch});}catch(error){if(error.code==='REQUEST_CANCELLED')throw error;resolved={machine:binding.machine,repoRoot:binding.repoRoot};}
      }else if(!this.all&&space){
        const chosen=origin?eligible.filter(p=>p.pane===origin):eligible;
        resolved=await resolveSpaceRepo(space,chosen,async(...args)=>{if(this.closed||epoch!==this.contextEpoch)fail('REQUEST_CANCELLED','Repository selection changed.');const result=await herdr.exec(...args);if(this.closed||epoch!==this.contextEpoch)fail('REQUEST_CANCELLED','Repository selection changed.');return result;});
      }
      if(this.closed||epoch!==this.contextEpoch)return;this.resolved=resolved;this.scopeSpace=bound?captured.spaces.find(s=>s.id===resolved?.spaceId)||null:space;
      await this.data.synchronize(resolved,{all:this.all});if(this.closed||epoch!==this.contextEpoch)return;this.config=this.data.config;
      for(const machine of new Set(this.data.view().bindings.map(b=>b.binding.machine)))this.discover(machine,eventCx);
    });
  }
  refresh(cx){if(!this.closed&&this.role==='panel'){this.error=null;return this.spawn(cx,()=>this.data.refresh());}}
  launchReason(issue){
    if(this.launching.has(issueIdentityKey(issue)))return 'Starting this story…';if(!this.all&&this.props.target?.repoRoot&&this.resolved?.state!=='resolved')return 'Open this repository in a space to start work.';const host=herdr.machines().find(m=>m.name===issue.repoBinding.machine);return host?.layout==='ready'?'':'The execution machine is offline or still connecting.';
  }
  startIssue(value,toolKey,cx,{options=false}={}){
    let issue;try{issue=validateIssue(value);shortcutLaunchSource(issue);}catch{this.error='This story is unavailable. Refresh Shortcut.';cx.notify();return;}
    const key=issueIdentityKey(issue);if(this.launching.has(key))return;this.launching.add(key);this.error=null;const all=this.all,resolved=this.resolved?copy(this.resolved):null,originPane=resolved?this.originPanes.get(resolved.spaceId):null;cx.notify();
    return this.spawn(cx,async()=>{
      try{const captured=await captureShortcutTarget(issue,{all,resolved,originPane,isCurrent:()=>!this.closed});if(this.closed)return;
        if(options)openLaunchDialog(MOD,herdr,{view:'launch',target:captured.target,...captured.target,source:captured.source,...(toolKey?{toolKey}:{})});
        else{const result=await quickStart({target:captured.target,source:captured.source,toolKey},this.io);if(!result.ok)this.error=result.message;}
      }finally{this.launching.delete(key);}
    });
  }
  openIssue(value,cx){let issue;try{issue=validateIssue(value);shortcutLaunchSource(issue);}catch{this.error='This story link is unavailable. Refresh Shortcut.';cx.notify();return;}
    return this.spawn(cx,async()=>{const platform=herdr.window().platform,command=platform==='macos'?'open':platform==='windows'?'explorer.exe':'xdg-open',result=await herdr.exec(command,[issue.url]);if(result.code!==0)fail('OPEN_FAILED','The browser could not open this story.');});
  }
  openSetup(binding,cx){
    if(binding||this.props.target?.repoRoot||!this.all&&this.resolved?.state==='resolved'){
      const target=binding||this.props.target||this.resolved;return herdr.openOverlay({mod:MOD,kind:'dialog',width:620,height:620,props:{view:'setup',target:{machine:target.machine,repoRoot:target.repoRoot}}});
    }
    const captured=this.world();return herdr.openOverlay({mod:MOD,kind:'dialog',width:620,height:620,props:{view:'setup',...(captured.space?{spaceId:captured.space.id,machine:captured.space.machine}:{})}});
  }
  openShortcuts(cx){
    const captured=this.world();return this.spawn(cx,async()=>{if(!captured.space)fail('SPACE_UNAVAILABLE','Select a repository space first.');const origin=this.originPanes.get(captured.space.id),panes=origin?captured.panes.filter(p=>p.pane===origin):captured.panes,resolved=await resolveSpaceRepo(captured.space,panes,herdr.exec);if(resolved.state!=='resolved')fail('REPO_UNAVAILABLE',resolved.reason);const target=launchTarget(resolved);if(!this.closed)openLaunchDialog(MOD,herdr,{view:'settings',target,...target});});
  }
  async resolveSetup(space,panes){
    this.setupSpace=space;if(!space){this.setupError='Choose a repository space.';return;}
    const origin=this.originPanes.get(space.id),chosen=origin?panes.filter(p=>p.pane===origin):panes,result=await resolveSpaceRepo(space,chosen,herdr.exec);if(this.closed)return;
    if(result.state==='resolved'){this.setupTarget={machine:result.machine,repoRoot:result.repoRoot};this.setupError=null;this.setupCandidates=[];}
    else{this.setupTarget=null;this.setupError=result.reason;this.setupCandidates=result.state==='ambiguous'?result.candidates.filter(c=>c.repoRoot):[];}
  }
  chooseSetup(space,cx,paneId){if(this.setupLoading)return;this.setupLoading=true;this.error=null;const panes=herdr.panes().map(p=>({...p}));return this.spawn(cx,async()=>{try{await this.resolveSetup(space,paneId?panes.filter(p=>p.pane===paneId):panes);if(!this.closed&&this.setupTarget)this.initializeForm();}finally{this.setupLoading=false;}});}
  input(value,placeholder){const state=InputState.new({value,placeholder});state.on('change',(_e,cx)=>{if(!this.initializingForm)this.resetCheck();cx.notify();});this.inputs.push(state);return state;}
  resetCheck(){this.formEpoch++;this.data.cancelSetup();this.probe=null;this.saved=false;this.error=null;}
  initializeForm(){
    for(const input of this.inputs)input.release();this.inputs=[];this.initializingForm=true;
    const bound=this.config.bindings[Object.keys(this.config.bindings).find(k=>sameRepo(this.config.bindings[k],this.setupTarget))]?.shortcut,existing=bound&&this.config.connections[bound.connectionId]?.kind==='claude'?this.config.connections[bound.connectionId]:null;
    let id='shortcut',n=2;while(!existing&&this.config.connections[id])id='shortcut-'+n++;
    this.profileId=existing?existing.id:id;this.command=this.input(existing?.execution.command||'','claude');this.query=this.input(bound?.query||'','Shortcut search; leave empty for your own stories');
    this.initializingForm=false;this.resetCheck();
  }
  connection(){return shortcutConnection(this.profileId,this.command.value());}
  checkSetup(cx){
    if(this.checking||!this.setupTarget)return;const epoch=this.formEpoch,target=copy(this.setupTarget),connection=this.connection();this.checking=true;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{const probe=await this.data.probe(connection,target);if(!this.closed&&epoch===this.formEpoch)this.probe=probe;}catch(error){if(!this.closed&&epoch===this.formEpoch)this.error=error?.code?error.message:'Claude Code could not check Shortcut.';}finally{this.checking=false;}});
  }
  /** Saves the probed binding, then loads its stories once so the board has cards. */
  saveSetup(cx){
    if(this.saving||!this.setupTarget||!this.probe)return;const epoch=this.formEpoch,target=copy(this.setupTarget),connection=this.connection(),probe=copy(this.probe),query=this.query.value();this.saving=true;this.error=null;cx.notify();
    return this.spawn(cx,async(eventCx)=>{
      try{const saved=await this.data.saveSetup({target,connection,probe,query},{isCurrent:()=>!this.closed&&epoch===this.formEpoch});if(this.closed||epoch!==this.formEpoch)return;
        this.config=saved.config;herdr.setShared(CONFIG_EVENT,{v:1,owner:this.instance,revision:++this.seq});this.saved=true;this.loadingStories=true;eventCx.notify();
        this.data.selectConfig(saved.config,{state:'resolved',...target});await this.data.refresh();if(this.closed)return;
        const failed=this.data.view().errors[0]?.error;if(failed)this.error=failed.message;else this.closeOverlay();
      }catch(error){if(!this.closed&&epoch===this.formEpoch)this.error=error?.code?error.message:'The connection could not be saved. Existing settings were preserved.';}
      finally{this.saving=false;this.loadingStories=false;}
    });
  }
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  header(title){const t=colors(),caption=this.all?String(Object.values(this.config?.bindings||{}).filter(b=>b.shortcut).length)+' spaces':this.scopeSpace?.name||(this.resolved?.repoRoot||this.props.target?.repoRoot||'').split('/').filter(Boolean).at(-1);return h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD,'shortcut',16)).child(div().font_semibold().text_size(12).text_color(t.foreground).child(title))
    .when(this.role==='panel'&&Boolean(caption),row=>row.child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(caption))).child(div().flex_1())
    .when(this.role==='panel',row=>row.child(iconButton(MOD,'shortcut-shortcuts','pin','Agent shortcuts',(_e,cx)=>this.openShortcuts(cx))))
    .when(Boolean(this.props.overlay),row=>row.child(iconButton(MOD,'shortcut-close','close','Close',()=>this.closeOverlay())));}
  field(id,title,state){const t=colors();return v_flex().gap(5).child(label(title,{muted:true,size:11})).child(Input.new(state).id(id).h(32).px(8).rounded(5).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground).text_size(12));}
  setupView(){
    const t=colors(),root=v_flex().id('shortcut-setup').size_full().min_h(0).bg(t.surface).text_size(12).child(this.header('Shortcut connection'));
    if(this.setupLoading)return root.child(div().p(18).text_color(t.muted).child('Loading repository settings…'));
    if(!this.config)return root.child(div().p(18).text_color(t.blocked).child(this.error||'Repository settings are unavailable. The original file was preserved.'));
    if(!this.setupTarget)return root.child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8).child(label(this.setupError||'Choose a repository space.',{muted:true})).children((this.setupCandidates?.length?this.setupCandidates.map(c=>({space:this.setupSpace,pane:c.paneId,label:c.repoRoot})):herdr.spaces().map(space=>({space,label:space.name+' · '+(space.machine||'This Mac')}))).map(choice=>textButton('shortcut-choose-'+(choice.pane||choice.space.id),choice.label,(_e,eventCx)=>this.chooseSetup(choice.space,eventCx,choice.pane)))));
    const body=v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(13).child(label((this.setupTarget.machine||'This Mac')+' · '+this.setupTarget.repoRoot,{muted:true,size:11}))
      .child(div().text_size(11).text_color(t.muted).child('Stories load through Claude Code’s own Shortcut sign-in. No token is stored. Each load is one small model run (about 1 cent and 30 seconds).'))
      .child(this.field('shortcut-command','Claude Code command (optional)',this.command))
      .child(div().text_size(10).text_color(t.dim).child('Leave empty to use claude from PATH. If the app cannot find it, enter its full path, such as /Users/you/.local/bin/claude.'))
      .child(this.field('shortcut-query','Search (optional)',this.query))
      .child(div().text_size(10).text_color(t.dim).child('To do adds is:unstarted and In progress adds is:started to this search.'));
    const found=this.probe?v_flex().id('shortcut-found').gap(4).p(10).rounded(5).border(1).border_color(t.border).child(label('Signed in as @'+this.probe.owner)).child(label('Workspace '+this.probe.workspace,{muted:true,size:11})):null;
    const action=this.probe?textButton('shortcut-save-setup',this.loadingStories?'Loading stories…':this.saving?'Saving…':this.saved?'Saved':'Save connection',(_e,eventCx)=>this.saveSetup(eventCx),{primary:true,disabled:this.saving}):textButton('shortcut-check-setup',this.checking?'Checking…':'Check connection',(_e,eventCx)=>this.checkSetup(eventCx),{primary:true,disabled:this.checking});
    return root.child(body.when(Boolean(found),el=>el.child(found))).when(Boolean(this.error),el=>el.child(div().id('shortcut-setup-error').px(16).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .child(h_flex().p(12).gap(8).items_center().border_t(1).border_color(t.border).child(textButton('shortcut-cancel-setup','Cancel',()=>this.closeOverlay())).child(div().flex_1()).child(action));
  }
  render(cx){
    if(this.dialog)return this.dialog.render(cx);if(this.role==='setup')return this.setupView(cx);this.syncFromWorld(cx);
    const store=herdr.shared(SNAPSHOT_STATE);if(store!==this.lastStore){this.lastStore=store;this.spawn(cx,async()=>this.data.restoreVisible());}
    const t=colors(),root=v_flex().id('shortcut-panel').size_full().min_h(0).bg(t.surface);
    if(!this.props.hideHeader)root.child(this.header('Shortcut'));
    if(this.error)root.child(div().id('shortcut-action-error').px(12).py(7).text_size(11).text_color(t.blocked).child(this.error));
    return root.child(renderIssueBoard({id:'shortcut-board',mod:MOD,state:this.board,view:this.data.view(),columns:COLUMNS,manualRefresh:true,preferences:this.config?.preferences.launch||{},toolsForMachine:machine=>this.tools.get(machineKey(machine))||[],launchReason:issue=>this.launchReason(issue),onOpenIssue:(issue,eventCx)=>this.openIssue(issue,eventCx),onLaunch:(issue,key,eventCx)=>this.startIssue(issue,key,eventCx),onOptions:(issue,eventCx)=>this.startIssue(issue,undefined,eventCx,{options:true}),onRefresh:(_value,eventCx)=>this.refresh(eventCx),onSetup:(binding,eventCx)=>this.openSetup(binding,eventCx),onScopeChange:(all,eventCx)=>this.setScope(all,eventCx),onInvalid:(message,eventCx)=>{this.error=message;eventCx.notify();}},cx));
  }
  close(){if(this.closed)return;this.closed=true;this.contextEpoch++;this.data?.close();this.board?.close();this.dialog?.close();for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();for(const input of this.inputs)input.release();}
}
