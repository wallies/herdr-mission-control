import {View,div} from 'gpui-kit';
import {v_flex,h_flex,InputState,Input,TextareaState,Textarea} from 'gpui-base';
import * as herdr from 'herdr';
import {readConfig} from '../../shared/config.js';
import {trackerOrigin} from '../../shared/tracker-model.js';
import {createLaunchIO} from '../../shared/launch.js';
import {quickStart} from '../../shared/launch-dialog.js';
import {toolChoices} from '../../shared/launch-preferences.js';
import {colors,label,icon,iconButton,textButton,toolIcon} from '../../shared/ui.js';
import {githubApiBase} from '../../shared/github-site.js';
import {SECTIONS,CONNECTION_ID,reviewKey,reviewLabel,reviewLaunchSource,reviewWorktreeName,waitingText,readReviewPreferences,validateReview} from './model.js';
import {resolveCheckout,verifyCheckout,saveCheckout,saveReviewsConnection} from './checkout.js';
import {ReviewsData,REFRESH_MS} from './data.js';

const MOD='mission-control-reviews',SOURCE_ID='reviews',CONFIG_EVENT='mission-control-reviews-config-v1';
const machineKey=machine=>JSON.stringify(machine);
/** The Mission Control layout nodes this source sits in (see mission-control-tabs/navigation.js). */
const STACK='mc-work-stack',PANEL='mc-work-panel';
function findNode(tree,id){const stack=[tree];for(let seen=0;stack.length&&seen<2000;seen++){const node=stack.pop();if(!node||typeof node!=='object')continue;if(node.id===id)return node;if(Array.isArray(node.children))stack.push(...node.children);}return null;}
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const repoOf=review=>review.identity.owner.toLowerCase()+'/'+review.identity.repo.toLowerCase();

/** The board's quick start, always in a new worktree of the PR's repository, opened in the given space. */
export function launchReview(io,{spaceId,machine,path,review,toolKey,instructions}){
  const source=reviewLaunchSource(review,instructions);
  return quickStart({target:{spaceId,machine,repoRoot:path,checkoutRoot:path},source,toolKey,worktree:true,worktreeName:reviewWorktreeName(review,toolKey)},io);
}
const resultText=result=>result.reused?'Opened the existing review agent. No new task was sent.':'Review started.';
async function machineHome(machine){
  if(machine===null)return herdr.home();
  const result=await herdr.exec('printenv',['HOME'],{on:machine});return result.code===0?result.stdout.trim():null;
}
function connectionFrom(config){
  const id=readReviewPreferences(config).connectionId,c=id?config.connections[id]:null;
  return c?.kind==='github'&&c.gh?c:null;
}

export default class MissionControlReviews extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view||'panel';Object.assign(this,{closed:false,jobs:[],timers:[],inputs:[],notes:new Map(),cardErrors:new Map(),launching:new Set(),tools:new Map(),toolTimes:new Map(),toolPending:new Set(),error:null,info:null,seq:0,instance:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)});
    this.io=createLaunchIO(herdr);this.data=new ReviewsData(this.io);
    if(this.role==='setup')return this.initSetup(cx);
    if(this.role==='checkout')return this.initCheckout();
    this.lastConfig=JSON.stringify(herdr.shared(CONFIG_EVENT)??null);this.loadConfig(cx,{refresh:true});
    // Reading is free, so the queue refreshes on its own while it is shown.
    this.timers.push(cx.timer.every(30000,eventCx=>{if(!this.closed&&this.shown()&&this.data.due())this.refresh(eventCx);}));
    this.commandTask=cx.spawn(async eventCx=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;if(command==='refresh')this.refresh(eventCx);else if(command==='setup')this.openSetup();eventCx.notify();}});
  }
  spawn(cx,work){
    this.jobs=this.jobs.filter(job=>!job?.is_done?.());
    const job=cx.spawn(async eventCx=>{try{await work(eventCx);}catch(error){if(!this.closed&&error?.code!=='REQUEST_CANCELLED')this.error=error?.message||'This action could not complete.';}if(!this.closed)eventCx.notify();});
    this.jobs.push(job);return job;
  }
  /** Inside the Mission Control stack, only while it is the selected source and its panel is open. */
  shown(){
    if(!this.props.hideHeader)return true;
    let tree;try{tree=herdr.layout();}catch{return true;}
    const stack=findNode(tree,STACK),panel=findNode(tree,PANEL);
    if(panel?.hidden===true)return false;if(!Array.isArray(stack?.children))return true;
    const ids=stack.children.map(c=>c?.id);return (ids.includes(stack.active)?stack.active:ids[0])===SOURCE_ID;
  }
  currentSpace(){const focus=herdr.focused(),spaces=herdr.spaces();return spaces.find(s=>s.id===(this.props.spaceId||focus?.space))||spaces.find(s=>s.active)||null;}
  loadConfig(cx,{refresh=false}={}){
    return this.spawn(cx,async eventCx=>{
      const config=(await readConfig(this.io)).value;if(this.closed)return;
      this.config=config;this.connection=connectionFrom(config);
      const space=this.currentSpace();if(space)this.discover(space.machine,eventCx);
      if(refresh&&this.connection&&this.shown())await this.load(eventCx);
    });
  }
  async load(taskCx){
    await this.data.refresh(this.connection);if(this.closed)return;
    this.syncNotes();taskCx.notify();
  }
  refresh(cx){if(this.closed||!this.connection)return;this.error=null;return this.spawn(cx,eventCx=>this.load(eventCx));}
  /** One instructions box per card, kept while the card is listed and never saved. Created in a task, never in render. */
  syncNotes(){
    const s=this.data.snapshot;if(!s)return;const wanted=new Set([...s.direct,...s.team].map(reviewKey));
    for(const [key,state]of this.notes)if(!wanted.has(key)){state.release();this.notes.delete(key);this.cardErrors.delete(key);}
    for(const key of wanted)if(!this.notes.has(key)){const state=TextareaState.new({placeholder:'Instructions for the reviewer (optional)',rows:2});state.set_auto_grow(2,8);this.notes.set(key,state);}
  }
  discover(machine,cx){
    const key=machineKey(machine);if(this.toolPending.has(key)||Date.now()-(this.toolTimes.get(key)||0)<60000)return;
    this.toolPending.add(key);
    return this.spawn(cx,async()=>{try{const tools=await herdr.knownAgents({on:machine});if(!this.closed){this.tools.set(key,tools);this.toolTimes.set(key,Date.now());}}catch{this.tools.delete(key);}finally{this.toolPending.delete(key);}});
  }
  launchReason(review,space){
    if(this.launching.has(reviewKey(review)))return 'Starting this review…';
    if(!space)return 'Select a space to review in.';
    return herdr.machines().find(m=>m.name===space.machine)?.layout==='ready'?'':'This space’s machine is offline or still connecting.';
  }
  startReview(value,toolKey,cx){
    let review;try{review=validateReview(value);}catch{this.error='This pull request changed. Refresh the queue.';cx.notify();return;}
    const key=reviewKey(review),instructions=this.notes.get(key)?.value()??'',space=this.currentSpace();if(this.launching.has(key)||!space)return;
    // Check the task before anything else, so a bad box never reaches the launcher.
    try{reviewLaunchSource(review,instructions);}catch(error){this.cardErrors.set(key,error.message);cx.notify();return;}
    this.cardErrors.delete(key);this.launching.add(key);this.error=null;this.info=null;cx.notify();
    const spaceId=space.id,machine=space.machine;
    return this.spawn(cx,async()=>{
      try{
        const config=(await readConfig(this.io)).value,home=await machineHome(machine);
        const found=await resolveCheckout({config,review,machine,exec:herdr.exec,home});if(this.closed)return;
        if(found.state==='ask'){herdr.openOverlay({mod:MOD,kind:'dialog',width:560,height:380,props:{view:'checkout',review,toolKey,instructions,spaceId,machine,reason:found.reason}});return;}
        const result=await launchReview(this.io,{spaceId,machine,path:found.path,review,toolKey,instructions});
        if(result.ok)this.info=resultText(result);else this.error=result.message;
      }finally{this.launching.delete(key);}
    });
  }
  openLink(url,cx){
    return this.spawn(cx,async()=>{const platform=herdr.window().platform,command=platform==='macos'?'open':platform==='windows'?'explorer.exe':'xdg-open',result=await herdr.exec(command,[url]);if(result.code!==0)fail('OPEN_FAILED','The browser could not open this link.');});
  }
  openSetup(){return herdr.openOverlay({mod:MOD,kind:'dialog',width:560,height:520,props:{view:'setup'}});}
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  input(value,placeholder){const state=InputState.new({value,placeholder});state.on('change',(_e,cx)=>{this.probe=null;this.saved=false;this.error=null;cx.notify();});this.inputs.push(state);return state;}

  initSetup(cx){
    this.setupLoading=true;this.site=this.input('https://github.com','https://github.com');this.account=this.input('','gh account (login)');this.profileId=this.input('github-reviews','Profile ID');
    this.spawn(cx,async()=>{try{this.config=(await readConfig(this.io)).value;const c=connectionFrom(this.config);if(c)this.fill(c);}finally{this.setupLoading=false;}});
  }
  fill(c){this.site.set_value(c.site);this.account.set_value(c.gh.account);this.profileId.set_value(c.id);this.probe=null;this.error=null;}
  setupConnection(){
    const site=trackerOrigin(this.site.value().trim()),id=this.profileId.value().trim(),account=this.account.value().trim();
    if(!CONNECTION_ID.test(id))fail('INVALID_CONNECTION','The profile ID uses lower-case letters, digits and dashes, starting with a letter.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(account))fail('INVALID_CONNECTION','Enter the gh account’s login, as gh auth status shows it.');
    return {id,kind:'github',site,apiBase:githubApiBase(site),gh:{host:site.slice(8),account}};
  }
  checkSetup(cx){
    if(this.checking)return;let connection;try{connection=this.setupConnection();}catch(error){this.error=error.message;cx.notify();return;}
    this.checking=true;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{this.probe={...await this.data.probe(connection),connection};}finally{this.checking=false;}});
  }
  saveSetup(cx){
    if(this.saving||!this.probe)return;this.saving=true;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{await saveReviewsConnection(this.io,this.probe.connection);this.saved=true;herdr.setShared(CONFIG_EVENT,{v:1,owner:this.instance,revision:++this.seq});this.closeOverlay();}finally{this.saving=false;}});
  }
  initCheckout(){
    const p=this.props;this.review=validateReview(p.review);this.folder=this.input('','/path/to/'+p.review.identity.repo);this.error=p.reason||null;
  }
  browse(cx){return this.spawn(cx,async()=>{const folder=await herdr.pickFolder({prompt:'Use this folder'});if(folder&&!this.closed)this.folder.set_value(folder);});}
  saveCheckout(cx){
    if(this.saving)return;this.saving=true;this.error=null;cx.notify();const p=this.props,review=this.review,host=new URL(review.identity.site).host.toLowerCase();
    return this.spawn(cx,async()=>{
      try{
        const path=await verifyCheckout(this.folder.value(),{repo:repoOf(review),host,machine:p.machine,exec:herdr.exec});
        await saveCheckout(this.io,{machine:p.machine,repo:repoOf(review),path});
        const result=await launchReview(this.io,{spaceId:p.spaceId,machine:p.machine,path,review,toolKey:p.toolKey,instructions:p.instructions});
        if(result.ok)this.closeOverlay();else this.error='The folder was saved, but the review could not start: '+result.message;
      }finally{this.saving=false;}
    });
  }

  header(title){
    const t=colors();
    return h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD,'review',16)).child(div().font_semibold().text_size(12).text_color(t.foreground).child(title)).child(div().flex_1())
      .when(Boolean(this.props.overlay),row=>row.child(iconButton(MOD,'reviews-close','close','Close',()=>this.closeOverlay())));
  }
  field(id,title,state){const t=colors();return v_flex().gap(5).child(label(title,{muted:true,size:11})).child(Input.new(state).id(id).h(32).px(8).rounded(5).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground).text_size(12));}
  footer(primary){const t=colors();return h_flex().p(12).gap(8).items_center().border_t(1).border_color(t.border).child(textButton('reviews-cancel','Cancel',()=>this.closeOverlay())).child(div().flex_1()).child(primary);}
  errorLine(id){const t=colors();return div().id(id).px(16).py(6).text_size(11).text_color(t.blocked).child(this.error);}
  setupView(){
    const t=colors(),root=v_flex().id('reviews-setup').size_full().min_h(0).bg(t.surface).text_size(12).child(this.header('Review queue connection'));
    if(this.setupLoading)return root.child(div().p(18).text_color(t.muted).child('Loading settings…'));
    const profiles=Object.values(this.config?.connections||{}).filter(c=>c.kind==='github'&&c.gh);
    const body=v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(12)
      .child(div().text_size(11).text_color(t.muted).child('The queue lists open pull requests, in every repository this gh account can see, that ask for your review. The token stays with gh.'))
      .when(profiles.length>0,el=>el.child(v_flex().gap(4).child(label('Existing gh profiles',{muted:true,size:11})).children(profiles.map(c=>textButton('reviews-profile-'+c.id,c.id+' · '+c.gh.account+' · '+c.site,(_e,eventCx)=>{this.fill(c);eventCx.notify();})))))
      .child(this.field('reviews-site','GitHub site',this.site)).child(this.field('reviews-account','gh account',this.account)).child(this.field('reviews-profile','Profile ID',this.profileId))
      .when(Boolean(this.probe),el=>el.child(v_flex().id('reviews-found').p(10).rounded(5).border(1).border_color(t.border).child(label('Signed in as @'+this.probe?.login))));
    const action=this.probe?textButton('reviews-save-setup',this.saving?'Saving…':this.saved?'Saved':'Save connection',(_e,eventCx)=>this.saveSetup(eventCx),{primary:true,disabled:this.saving}):textButton('reviews-check-setup',this.checking?'Checking…':'Check connection',(_e,eventCx)=>this.checkSetup(eventCx),{primary:true,disabled:this.checking});
    return root.child(body).when(Boolean(this.error),el=>el.child(this.errorLine('reviews-setup-error'))).child(this.footer(action));
  }
  checkoutView(){
    const t=colors(),p=this.props,where=p.machine||'this Mac',root=v_flex().id('reviews-checkout').size_full().min_h(0).bg(t.surface).text_size(12).child(this.header('Where is '+reviewLabel(this.review).split('#')[0]+'?'));
    const body=v_flex().flex_1().min_h(0).p(16).gap(12)
      .child(div().text_size(11).text_color(t.muted).child(`Mission Control has no checkout of ${repoOf(this.review)} on ${where}. Enter its folder. The review runs in a new worktree of it; nothing is cloned.`))
      .child(h_flex().gap(8).items_end().child(this.field('reviews-folder','Repository folder',this.folder).flex_1()).when(p.machine===null,row=>row.child(textButton('reviews-browse','Choose…',(_e,eventCx)=>this.browse(eventCx)))));
    return root.child(body).when(Boolean(this.error),el=>el.child(this.errorLine('reviews-checkout-error'))).child(this.footer(textButton('reviews-save-checkout',this.saving?'Starting…':'Save and review',(_e,eventCx)=>this.saveCheckout(eventCx),{primary:true,disabled:this.saving})));
  }

  card(review,tools,space,now){
    const t=colors(),key=reviewKey(review),id='reviews-card-'+key.replace(/[^a-z0-9_-]/g,'-'),reason=this.launchReason(review,space),notes=this.notes.get(key),cardError=this.cardErrors.get(key),name=reviewLabel(review);
    const since=new Date(review.waitingSince).toISOString().replace('T',' ').slice(0,16)+' UTC';
    const link=(suffix,text,url,{main=false}={})=>div().id(id+'-'+suffix).min_w(0).text_size(main?12:10).text_color(main?t.foreground:t.accent).tooltip(url).accessibility_label('Open '+text).role('link').cursor_pointer().hover(s=>s.text_color(t.accent)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();return this.openLink(url,cx);}).truncate().child(text);
    const state=[review.review&&{approved:'Approved',changesRequested:'Changes requested',reviewRequired:'Review required'}[review.review],review.checks&&{success:'Checks passed',failure:'Checks failed',pending:'Checks pending'}[review.checks]].filter(Boolean);
    const buttons=tools.map(tool=>{
      const hint=reason||'Review '+name+' with '+(tool.name||tool.key);
      let el=h_flex().id(id+'-review-'+tool.key).h(26).px(7).gap(5).items_center().rounded(4).border(1).border_color(t.border).opacity(reason?0.45:1).tooltip(hint).accessibility_label(hint).role('button');
      if(!reason)el=el.cursor_pointer().hover(s=>s.bg(t.selected)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();return this.startReview(review,tool.key,cx);});
      return el.child(toolIcon(MOD,tool,14)).child(div().text_size(11).text_color(t.foreground).child('Review'));
    });
    return v_flex().id(id).w_full().min_w(0).p(11).gap(7).rounded(6).bg(t.chrome).border(1).border_color(t.border)
      .child(h_flex().gap(6).items_center().child(icon(MOD,'pull-request',13).text_color(t.muted)).child(link('key',name,review.url)).child(div().flex_1())
        .when(review.draft,row=>row.child(div().id(id+'-draft').px(5).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.dim).child('Draft')))
        .child(div().id(id+'-waiting').text_size(10).text_color(t.dim).tooltip('Waiting since '+since+'. GitHub search does not report when your review was requested, so this is the pull request’s last update.').child(waitingText(review.waitingSince,now))))
      .child(link('title',review.title,review.url,{main:true}))
      .child(h_flex().gap(8).items_center().when(Boolean(review.author.login),row=>row.child(link('author','@'+review.author.login,review.author.url))).when(!review.author.login,row=>row.child(label('Deleted account',{muted:true,size:10}))).child(div().flex_1()).children(state.map((s,i)=>div().id(id+'-state-'+i).text_size(10).text_color(t.muted).child(s))))
      .when(Boolean(notes),el=>el.child(Textarea.new(notes).id(id+'-instructions').w_full().px(8).py(6).rounded(5).border(1).border_color(t.border).bg(t.surface).text_color(t.foreground).text_size(11)))
      .when(Boolean(cardError),el=>el.child(div().id(id+'-error').text_size(10).text_color(t.blocked).child(cardError)))
      .child(h_flex().gap(4).items_center().child(div().flex_1()).children(buttons).when(!buttons.length,row=>row.child(label('Pin an agent in Agent shortcuts to review from here.',{muted:true,size:10}))));
  }
  status(view,now){
    const s=view.snapshot,parts=[];if(view.loading)parts.push('Refreshing');
    if(s){parts.push(s.direct.length+' asked of you',s.team.length+' asked of your teams','Updated '+waitingText(s.fetchedAt,now)+' ago');if(s.truncated)parts.push('Only the oldest 300 of each search are shown');if(s.incomplete)parts.push('GitHub reported incomplete results');if(s.detailsUnavailable)parts.push('Checks and review state unavailable');}
    else if(!view.loading)parts.push('Not loaded yet');
    return parts.join(' · ');
  }
  panelView(cx){
    const t=colors(),view=this.data.view(),now=Date.now(),space=this.currentSpace(),root=v_flex().id('reviews-panel').size_full().min_h(0).bg(t.surface);
    if(!this.props.hideHeader)root.child(this.header('Reviews'));
    const toolbar=h_flex().px(14).pt(12).gap(6).items_center().child(div().id('reviews-status').flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.status(view,now)))
      .child(iconButton(MOD,'reviews-refresh','refresh','Refresh reviews',(_e,eventCx)=>this.refresh(eventCx),{disabled:!this.connection||view.loading}))
      .child(iconButton(MOD,'reviews-settings','settings','Review queue connection',()=>this.openSetup()));
    root.child(toolbar);
    const problem=this.error||view.error?.message;if(problem)root.child(div().id('reviews-error').px(14).text_size(11).text_color(t.blocked).child(problem));
    if(this.info)root.child(div().id('reviews-info').px(14).text_size(11).text_color(t.muted).child(this.info));
    if(this.config&&!this.connection)return root.child(v_flex().p(14).gap(8).child(label('Choose the gh account whose review requests to list.',{muted:true,size:11})).child(textButton('reviews-connect','Set up',()=>this.openSetup())));
    if(space)this.discover(space.machine,cx);
    const tools=space?toolChoices(this.tools.get(machineKey(space.machine))||[],this.config?.preferences.launch||{}).quick:[];
    const body=v_flex().id('reviews-sections').flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(14);
    for(const [section,title] of SECTIONS){
      const rows=view.snapshot?.[section]||[];
      body.child(v_flex().id('reviews-section-'+section).gap(8).child(h_flex().gap(6).items_center().child(div().text_size(11).font_semibold().text_color(t.muted).child(title)).child(label(String(rows.length),{muted:true,size:10})))
        .children(rows.map(review=>this.card(review,tools,space,now)))
        .when(!rows.length,el=>el.child(div().id('reviews-empty-'+section).p(12).rounded(5).border(1).border_color(t.border).text_size(11).text_color(t.dim).child(view.snapshot?'Nothing here.':view.loading?'Loading…':'Not loaded yet.'))));
    }
    return root.child(body);
  }
  render(cx){
    if(this.role==='setup')return this.setupView();if(this.role==='checkout')return this.checkoutView();
    const revision=JSON.stringify(herdr.shared(CONFIG_EVENT)??null);if(revision!==this.lastConfig){this.lastConfig=revision;this.loadConfig(cx,{refresh:true});}
    else if(this.connection&&this.shown()&&this.data.due())this.refresh(cx);
    return this.panelView(cx);
  }
  close(){if(this.closed)return;this.closed=true;this.data.close();for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();for(const state of [...this.inputs,...this.notes.values()])state.release();}
}
