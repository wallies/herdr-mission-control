import {div} from 'gpui-kit';
import {v_flex,h_flex,TextareaState,Textarea} from 'gpui-base';
import {createConfigIO} from '../../shared/config.js';
import {CLOUD_EVENT,CloudSessionError,STATUS_LABELS,STATUS_COLORS,cloudStatus,validMessage} from '../../shared/cloud-sessions.js';
import {colors,label,icon,textButton} from '../../shared/ui.js';
import {CloudSessions} from './cloud-data.js';
import {MOD,currentSpace,teleportInto} from './cloud-tabs.js';

const SEND_KEYS=['cmd-enter','ctrl-enter'];
const time=at=>new Date(at).toISOString().slice(0,16).replace('T',' ')+' UTC';

/**
 * One cloud session in its own tab: header, links, Teleport, a message box and what was sent from
 * here. Nothing on this machine can read the cloud conversation, so replies are not shown.
 */
export class CloudSessionView{
  constructor(herdr,props,{spawn,clock=()=>Date.now()}){
    Object.assign(this,{herdr,spawn,clock,id:typeof props.session==='string'?props.session:null,data:new CloudSessions(createConfigIO(herdr),{clock}),loaded:false,sending:false,note:null,seen:null});
    this.box=TextareaState.new({placeholder:'Message for the cloud session',rows:8});
  }
  init(cx){this.handle=cx.focus_handle();this.sync(cx);}
  record(){return this.data.records.find(r=>r.id===this.id)||null;}
  sync(cx){
    const revision=JSON.stringify(this.herdr.shared(CLOUD_EVENT)??null);if(revision===this.seen)return;this.seen=revision;
    return this.spawn(cx,async()=>{await this.data.load();this.loaded=true;});
  }
  changed(){this.herdr.setShared(CLOUD_EVENT,{v:1,at:this.clock(),nonce:Math.random().toString(36).slice(2)});this.seen=JSON.stringify(this.herdr.shared(CLOUD_EVENT));}
  open(url,cx){try{cx.open_url(url);}catch{this.note={error:true,text:'The browser could not open this link.'};cx.notify();}}
  teleport(record,cx){this.note=teleportInto(this.herdr,record,currentSpace(this.herdr));cx.notify();}
  /** Queues the message with Claude Code, then keeps it on the record as queued or failed. */
  send(cx){
    const record=this.record();if(!record||this.sending)return;
    let text;try{text=validMessage(this.box.value());}catch(error){this.note={error:true,text:error.message};cx.notify();return;}
    this.sending=true;this.note=null;cx.notify();
    return this.spawn(cx,async()=>{
      let entry;
      try{await this.data.message(record.id,text);entry={at:this.clock(),text,state:'queued',error:null};}
      catch(error){entry={at:this.clock(),text,state:'failed',error:(error instanceof CloudSessionError&&error.message?error.message:'The message could not be sent.').slice(0,512)};}
      try{await this.data.recordMessage(record.id,entry);this.changed();if(entry.state==='queued')this.box.set_value('');}
      catch(error){this.note={error:true,text:error.message||'The message could not be saved.'};}
      finally{this.sending=false;}
    });
  }
  onKey(event,cx){if(SEND_KEYS.includes(event.keystroke)){cx.stop_propagation();return this.send(cx);}}

  header(record){
    const t=colors(),status=cloudStatus(record);
    return v_flex().id('cloud-session-header').gap(6).pb(12).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().child(icon(MOD,'cloud',18).text_color(t.muted)).child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(record.title)))
      .child(h_flex().gap(8).items_center().text_size(11)
        .child(div().text_color(t.muted).child(record.repo))
        .child(h_flex().id('cloud-session-status').gap(5).items_center().child(div().size(6).rounded_full().bg(t[STATUS_COLORS[status]]||t.dim)).child(div().text_color(t.muted).child(STATUS_LABELS[status])))
        .when(Boolean(record.pr),row=>row.child(div().id('cloud-session-pr').text_color(t.accent).cursor_pointer().role('link').tooltip(record.pr.url).on_click((_e,cx)=>this.open(record.pr.url,cx)).child('#'+record.pr.number)))
        .child(div().flex_1())
        .child(textButton('cloud-session-browser','Open in browser',(_e,cx)=>this.open(record.url,cx)))
        .child(textButton('cloud-session-teleport','Teleport',(_e,cx)=>this.teleport(record,cx))));
  }
  sent(record){
    const t=colors(),messages=[...record.messages].reverse();
    return v_flex().id('cloud-session-sent').gap(6)
      .child(label('Sent from Mission Control',{muted:true,size:11}))
      .when(!messages.length,el=>el.child(div().id('cloud-session-none').text_size(11).text_color(t.dim).child('Nothing sent from here yet.')))
      .children(messages.map((m,i)=>v_flex().id('cloud-session-sent-'+i).gap(3).p(8).rounded(5).border(1).border_color(t.border)
        .child(h_flex().gap(8).text_size(10).child(div().text_color(t.dim).child(time(m.at))).child(div().text_color(m.state==='queued'?t.muted:t.blocked).child(m.state==='queued'?'Queued':'Failed')))
        .child(div().text_size(12).text_color(t.foreground).child(m.text))
        .when(m.state==='failed',el=>el.child(div().text_size(10).text_color(t.blocked).child(m.error)))));
  }
  render(){
    const t=colors(),record=this.record(),root=v_flex().id('cloud-session').size_full().min_h(0).p(18).gap(14).bg(t.surface).text_size(12);
    if(!record)return root.child(label(!this.loaded?'Loading…':this.data.error||'Mission Control no longer follows this cloud session.',{muted:true}));
    return root.child(this.header(record))
      .child(div().id('cloud-session-replies').text_size(11).text_color(t.muted).child('Replies are on claude.ai, or here after Teleport: nothing on this machine can read the cloud conversation. Messages you send are queued into the session.'))
      .child(v_flex().id('cloud-session-compose').gap(8).track_focus(this.handle).on_key_down((event,cx)=>this.onKey(event,cx))
        .child(Textarea.new(this.box).id('cloud-session-message').w_full().px(10).py(8).rounded(6).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground).text_size(13))
        .child(h_flex().gap(8).items_center().child(div().text_size(10).text_color(t.dim).child('Ctrl+Enter sends')).child(div().flex_1())
          .when(Boolean(this.note),row=>row.child(div().id('cloud-session-note').text_size(11).text_color(this.note.error?t.blocked:t.muted).child(this.note.text)))
          .child(textButton('cloud-session-send',this.sending?'Sending…':'Send',(_e,cx)=>this.send(cx),{primary:true,disabled:this.sending}))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(this.sent(record)));
  }
  close(){this.data.close();this.box.release();}
}
