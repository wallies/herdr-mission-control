import {div} from 'gpui-kit';
import {v_flex,h_flex,InputState,Input} from 'gpui-base';
import {createConfigIO} from '../../shared/config.js';
import {CLOUD_EVENT,STATUS_LABELS,STATUS_COLORS,cloudStatus,newRecord,parseSessionRef,githubRepo,repoFromRemote} from '../../shared/cloud-sessions.js';
import {colors,label,icon,iconButton,textButton} from '../../shared/ui.js';
import {CloudSessions} from './cloud-data.js';
import {MOD,currentSpace,openSessionTab,teleportInto} from './cloud-tabs.js';

const rowId=id=>'cloud-'+id;

/**
 * Cloud sessions in the Agents rail, beside the local agents and separate from them. Owns its input
 * state (created in init and event handlers, never in render) and its own error lines.
 */
export class CloudRail{
  constructor(herdr,{spawn,clock=()=>Date.now()}){
    Object.assign(this,{herdr,spawn,data:new CloudSessions(createConfigIO(herdr),{clock}),adding:false,addError:null,notes:new Map(),busy:new Set(),seen:null});
    this.ref=InputState.new({placeholder:'https://claude.ai/code/session_…'});this.repo=InputState.new({placeholder:'owner/name'});
  }
  records(){return this.data.records;}
  /** Reloads when another copy (or the Shortcut board) changed the list. */
  sync(cx){
    const revision=JSON.stringify(this.herdr.shared(CLOUD_EVENT)??null);if(revision===this.seen)return;this.seen=revision;
    return this.spawn(cx,async()=>{await this.data.load();if(this.data.due())await this.data.refreshPulls();});
  }
  changed(){this.herdr.setShared(CLOUD_EVENT,{v:1,at:Date.now(),nonce:Math.random().toString(36).slice(2)});this.seen=JSON.stringify(this.herdr.shared(CLOUD_EVENT));}
  /** Called by the rail's timer while it is expanded. */
  tick(cx){if(this.data.records.length&&this.data.connection&&this.data.due())return this.spawn(cx,async()=>{await this.data.refreshPulls();});}
  note(id,text,{error=false}={}){this.notes.set(id,{text,error});}

  /** Herdr hands the session link to the system browser; no helper program is started. */
  open(record,cx){
    try{cx.open_url(record.url);}catch{this.note(record.id,'The browser could not open this session.',{error:true});cx.notify();}
  }
  /** Message opens the session's own tab in the main area; one tab per session. */
  message(record,cx){
    return this.spawn(cx,async()=>{const r=await openSessionTab(this.herdr,record,currentSpace(this.herdr));if(r.text)this.note(record.id,r.text,{error:r.error});else this.notes.delete(record.id);});
  }
  teleport(record,cx){const r=teleportInto(this.herdr,record,currentSpace(this.herdr));this.note(record.id,r.text,{error:r.error});cx.notify();}
  remove(record,cx){
    return this.spawn(cx,async()=>{try{await this.data.remove(record.id);this.notes.delete(record.id);this.changed();}catch(error){this.note(record.id,error.message,{error:true});}});
  }
  toggleAdd(cx){this.adding=!this.adding;this.addError=null;cx.notify();}
  /** The focused local terminal's checkout when its origin is this repository, else null. */
  async checkoutFor(repo){
    const focus=this.herdr.focused(),pane=this.herdr.panes().find(p=>p.pane===focus?.pane),space=this.herdr.spaces().find(s=>s.id===focus?.space);
    if(!pane?.cwd||!space||space.machine!==null)return null;
    const top=await this.herdr.exec('git',['-C',pane.cwd,'rev-parse','--show-toplevel']);if(top.code!==0)return null;
    const root=top.stdout.trim(),origin=await this.herdr.exec('git',['-C',root,'remote','get-url','origin']);
    return origin.code===0&&repoFromRemote(origin.stdout)?.toLowerCase()===repo.toLowerCase()&&root.startsWith('/')?root:null;
  }
  add(cx){
    let ref,repo;try{ref=parseSessionRef(this.ref.value());repo=githubRepo(this.repo.value());}catch(error){this.addError=error.message;cx.notify();return;}
    if(this.busy.has('add'))return;this.busy.add('add');this.addError=null;cx.notify();
    return this.spawn(cx,async()=>{
      try{
        const checkout=await this.checkoutFor(repo);
        await this.data.add(newRecord({ref:ref.id,repo,checkout,title:repo+' cloud session',createdAt:Date.now()}));
        this.changed();this.ref.set_value('');this.repo.set_value('');this.adding=false;
      }catch(error){this.addError=error.message||'The session could not be added.';}
      finally{this.busy.delete('add');}
    });
  }

  addForm(){
    const t=colors(),field=(id,state)=>Input.new(state).id(id).h(28).px(7).bg(t.surface).border(1).border_color(t.border).rounded(5).text_size(11).text_color(t.foreground);
    return v_flex().id('cloud-add').mx(4).p(8).gap(6).rounded(5).border(1).border_color(t.border)
      .child(label('Follow a cloud session',{muted:true,size:10})).child(field('cloud-add-ref',this.ref)).child(field('cloud-add-repo',this.repo))
      .when(Boolean(this.addError),e=>e.child(div().id('cloud-add-error').text_size(10).text_color(t.blocked).child(this.addError)))
      .child(h_flex().gap(6).child(div().flex_1()).child(textButton('cloud-add-cancel','Cancel',(_e,cx)=>this.toggleAdd(cx))).child(textButton('cloud-add-save',this.busy.has('add')?'Adding…':'Add',(_e,cx)=>this.add(cx),{primary:true,disabled:this.busy.has('add')})));
  }
  row(record){
    const t=colors(),id=rowId(record.id),status=cloudStatus(record),note=this.notes.get(record.id),checked=record.checkedAt?' · checked '+new Date(record.checkedAt).toISOString().slice(0,16).replace('T',' ')+' UTC':'';
    const tip=record.title+' · '+record.repo+' · '+STATUS_LABELS[status]+(record.pr?' · '+record.pr.url:'')+checked;
    const actions=h_flex().gap(1).items_center()
      .child(iconButton(MOD,id+'-message','message','Open this session to message it',(_e,cx)=>this.message(record,cx),{size:22}))
      .child(iconButton(MOD,id+'-teleport','teleport','Teleport into '+(record.checkout||'this space’s folder'),(_e,cx)=>this.teleport(record,cx),{size:22}))
      .child(iconButton(MOD,id+'-remove','close','Stop following (the cloud session is untouched)',(_e,cx)=>this.remove(record,cx),{size:22}));
    return v_flex().id(id).px(7).py(6).gap(3).rounded(5).tooltip(tip).role('button').accessibility_label(record.title).cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,cx)=>this.open(record,cx))
      .child(h_flex().h(17).gap(7).items_center().child(icon(MOD,'cloud',15).text_color(t.muted)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(record.title)).child(div().size(5).rounded_full().flex_none().bg(t[STATUS_COLORS[status]]||t.dim)))
      .child(h_flex().h(20).gap(7).items_center().child(div().w(15)).child(div().flex_1().min_w(0).text_size(9).text_color(t.dim).truncate().child(record.repo+' · '+STATUS_LABELS[status])).child(actions))
      .when(Boolean(note),e=>e.child(div().id(id+'-note').text_size(10).text_color(note.error?t.blocked:t.muted).child(note.text)));
  }
  /** The Cloud group: one row per followed session, plus the add form when open. */
  render(){
    const t=colors(),records=this.data.records;if(!records.length&&!this.adding&&!this.data.error)return null;
    const hint=records.length&&!this.data.connection?'Set up the Reviews gh connection to follow pull requests.':this.data.pullsError;
    return v_flex().id('cloud-sessions').gap(1)
      .child(h_flex().h(23).px(4).gap(6).items_center().child(label('Cloud',{muted:true,size:10})).child(label(String(records.length),{muted:true,size:9})))
      .when(Boolean(this.data.error),e=>e.child(div().id('cloud-error').px(4).text_size(10).text_color(t.blocked).child(this.data.error)))
      .when(Boolean(hint),e=>e.child(div().id('cloud-hint').px(4).text_size(9).text_color(t.dim).child(hint)))
      .when(this.adding,e=>e.child(this.addForm()))
      .children(records.map(record=>this.row(record)));
  }
  close(){this.data.close();this.ref.release();this.repo.release();}
}
