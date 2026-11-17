import {teleportArgs} from '../../shared/cloud-sessions.js';

export const MOD='mission-control-agents';
export const SESSION_VIEW='cloud-session';
/** Which tab shows each session's view, so a second Message click focuses it. Shared, bounded. */
export const SESSION_TABS='mission-control-cloud-tabs-v1';
const MAX_TABS=100;

export const shortTitle=title=>title.length>40?title.slice(0,39)+'…':title;
export const currentSpace=herdr=>herdr.spaces().find(s=>s.id===herdr.focused()?.space)||null;

/**
 * A terminal tab in `space` running `claude --teleport <id>`: in the record's checkout, else the
 * space's folder. Teleport checks the repository itself. Returns the line to show.
 */
export function teleportInto(herdr,record,space){
  if(!space||space.machine!==null)return {error:true,text:'Select a space on this computer to teleport into.'};
  const folder=record.checkout||space.folder;
  if(typeof folder!=='string'||!folder.startsWith('/'))return {error:true,text:'This space has no folder to teleport into.'};
  herdr.run('tab.new',{space:space.id,folder,argv:['claude',...teleportArgs(record.id)],name:('Teleport '+shortTitle(record.title)).slice(0,200)});
  return {error:false,text:'Teleporting in a new tab.'};
}

function knownTabs(herdr){
  const value=herdr.shared(SESSION_TABS),live=new Set(herdr.spaces().flatMap(s=>(s.tabs||[]).map(t=>s.id+'\n'+t.id)));
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([,t])=>typeof t?.space==='string'&&typeof t?.tab==='string'&&live.has(t.space+'\n'+t.tab)));
}

/**
 * Opens the session's view as a tab in `space` whose only pane is this mod, through
 * `herdr-app do tab.new {space, name, mod, props, focus}` so the reply names the tab. An open one is
 * focused instead.
 */
export async function openSessionTab(herdr,record,space){
  const tabs=knownTabs(herdr),open=tabs[record.id];
  if(open){herdr.run('space.select',{id:open.space});herdr.run('tab.select',{id:open.tab});return {error:false,text:null};}
  if(!space)return {error:true,text:'Select a space to open this session in.'};
  const args={space:space.id,name:shortTitle(record.title),mod:MOD,props:{view:SESSION_VIEW,session:record.id},focus:true};
  const result=await herdr.exec('herdr-app',['do','tab.new',JSON.stringify(args)]);
  let ack=null;try{ack=result.code===0?JSON.parse(result.stdout):null;}catch{ack=null;}
  if(typeof ack?.tab!=='string'||ack.space!==space.id)return {error:true,text:'Herdr did not open the session tab.'};
  const kept=Object.entries({...tabs,[record.id]:{space:ack.space,tab:ack.tab}}).slice(-MAX_TABS);
  herdr.setShared(SESSION_TABS,Object.fromEntries(kept));
  return {error:false,text:null};
}
