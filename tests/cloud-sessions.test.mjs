import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseSessionRef,githubRepo,repoFromRemote,validateStore,validateRecord,newRecord,CloudSessionStore,cloudStatus,STATUS_LABELS,createArgs,messageArgs,teleportArgs,validMessage,findSessionLink,MAX_SESSIONS} from '../src/shared/cloud-sessions.js';

const ID='session_01HJKLMNOPQRSTUVWXYZ';
const record=(over={})=>newRecord({ref:ID,repo:'acme/botanic',checkout:'/work/botanic',title:'sc-69416 Fix the export',source:{kind:'shortcut',key:'sc-69416'},createdAt:1000,...over});
const pr=(over={})=>({number:12,url:'https://github.com/acme/botanic/pull/12',state:'open',draft:false,checks:null,review:null,...over});

async function storeFixture(t){
  const app=await fs.mkdtemp(path.join(os.tmpdir(),'mc-cloud-store-'));t.after(()=>fs.rm(app,{recursive:true,force:true}));
  const writes=[];
  const io={appHome:()=>app,ensureDirectory:dir=>fs.mkdir(dir,{recursive:true}),
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    // Herdr's compare-and-set: write only if the file still holds `expected`, replacing it whole.
    writeTextFile:async(file,text,expected)=>{let old=null;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(old!==expected)throw Object.assign(Error('stale snapshot'),{code:'STALE'});writes.push(text);await fs.writeFile(file+'.tmp',text);await fs.rename(file+'.tmp',file);}};
  return {app,io,writes,file:path.join(app,'mission-control/cloud-sessions.json')};
}

test('session references accept a bare id, the cse_ form and claude.ai/code links with or without scheme and query',()=>{
  const want={id:ID,url:'https://claude.ai/code/'+ID};
  for(const value of [ID,' '+ID+' ','cse_01HJKLMNOPQRSTUVWXYZ','https://claude.ai/code/'+ID,'claude.ai/code/'+ID,'https://claude.ai/code/'+ID+'?from=cli&m=0','https://claude.ai/code/'+ID+'/'])assert.deepEqual(parseSessionRef(value),want,value);
  for(const value of ['','session_short','sess_01HJKLMNOPQRSTUVWXYZ','https://evil.example/code/'+ID,'http://claude.ai/code/'+ID,ID+'; rm x','https://claude.ai/code/'+ID+' extra',null,42])assert.throws(()=>parseSessionRef(value),/cloud session URL/,String(value));
});

test('repositories are owner/name and GitHub remotes resolve to them',()=>{
  assert.equal(githubRepo(' acme/botanic '),'acme/botanic');
  for(const bad of ['acme','acme/botanic/x','../x','acme/..','acme/bo tanic',''])assert.throws(()=>githubRepo(bad),/owner\/name/,bad);
  for(const url of ['git@github.com:acme/botanic.git','https://github.com/acme/botanic','https://x-token@github.com/acme/botanic.git','ssh://git@github.com/acme/botanic.git'])assert.equal(repoFromRemote(url),'acme/botanic',url);
  for(const url of ['git@gitlab.com:acme/botanic.git','https://github.com.evil/acme/botanic','https://github.com/acme','nope'])assert.equal(repoFromRemote(url),null,url);
});

test('records are validated strictly: exact fields, matching link, absolute checkout, known PR states',()=>{
  const good=record();assert.equal(good.url,'https://claude.ai/code/'+ID);assert.equal(good.pr,null);assert.equal(good.checkedAt,null);
  assert.deepEqual(validateRecord(good),good);
  const bad=[{...good,token:'x'},{...good,url:'https://claude.ai/code/session_other123456'},{...good,checkout:'relative/path'},{...good,checkout:'/a/../b'},{...good,title:''},{...good,source:{kind:'jira',key:'X-1'}},{...good,createdAt:-1},{...good,pr:pr({state:'reopened'})},{...good,pr:pr({url:'https://evil.example/acme/botanic/pull/12'})},{...good,pr:pr({checks:'red'})},{...good,pr:{...pr(),extra:1}}];
  for(const value of bad)assert.throws(()=>validateRecord(value),/cloud session/i,JSON.stringify(value));
  const {checkout:_omit,...missing}=good;assert.throws(()=>validateRecord(missing),/missing or unknown/);
  assert.equal(newRecord({ref:ID,repo:'acme/botanic',createdAt:1}).title,'Cloud session 01HJKLMN');
});

test('the store file is validated as a whole and bounded',()=>{
  assert.throws(()=>validateStore({v:2,revision:0,sessions:[]}),/invalid/);
  assert.throws(()=>validateStore({v:1,revision:0,sessions:[record(),record()]}),/repeats/);
  const many=Array.from({length:MAX_SESSIONS+1},(_,i)=>record({ref:'session_'+String(i).padStart(10,'A')}));
  assert.throws(()=>validateStore({v:1,revision:0,sessions:many}),/at most 100/);
});

test('adds, records pull requests and removes through compare-and-set writes, and never loses a concurrent edit',async t=>{
  const f=await storeFixture(t),store=new CloudSessionStore(f.io);
  assert.deepEqual(await store.list(),[]);
  await store.add(record());assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).revision,1);
  await assert.rejects(store.add(record()),/already follows/);
  // Another copy writes between this copy's read and write: the edit is rerun on the fresh file.
  const other=record({ref:'session_OTHER0000000000'});let raced=false;const write=f.io.writeTextFile;
  f.io.writeTextFile=async(file,text,expected)=>{if(!raced){raced=true;await new CloudSessionStore({...f.io,writeTextFile:write}).add(other);}return write(file,text,expected);};
  const after=await store.recordPulls({[ID]:pr()},5000);f.io.writeTextFile=write;
  assert.deepEqual(after.map(r=>r.id),[ID,other.id]);assert.deepEqual(after[0].pr,pr());assert.equal(after[0].checkedAt,5000);assert.equal(after[1].pr,null);
  // A lookup that finds nothing keeps the last known pull request and only moves the check time.
  const kept=await store.recordPulls({[ID]:null},6000);assert.deepEqual(kept[0].pr,pr());assert.equal(kept[0].checkedAt,6000);
  assert.deepEqual((await store.remove(ID)).map(r=>r.id),[other.id]);
  assert.doesNotMatch(await fs.readFile(f.file,'utf8'),/token|secret/i);
});

test('a full list refuses a new session and keeps the file as it was',async t=>{
  const f=await storeFixture(t),store=new CloudSessionStore(f.io),many=Array.from({length:MAX_SESSIONS},(_,i)=>record({ref:'session_'+String(i).padStart(10,'A')}));
  await fs.mkdir(path.dirname(f.file),{recursive:true});const body=JSON.stringify({v:1,revision:3,sessions:many});await fs.writeFile(f.file,body);
  await assert.rejects(store.add(record()),{code:'STORE_FULL'});assert.equal(await fs.readFile(f.file,'utf8'),body);
});

test('a corrupt or oversized store is reported and left untouched',async t=>{
  const f=await storeFixture(t),store=new CloudSessionStore(f.io);await fs.mkdir(path.dirname(f.file),{recursive:true});
  await fs.writeFile(f.file,'{not json');await assert.rejects(store.list(),/not valid JSON/);await assert.rejects(store.add(record()),/not valid JSON/);
  assert.equal(await fs.readFile(f.file,'utf8'),'{not json');assert.equal(f.writes.length,0);
  await fs.writeFile(f.file,JSON.stringify({v:1,revision:0,sessions:[{...record(),pr:'x'}]}));await assert.rejects(store.list(),/pull request is invalid/);
});

test('status is started until a pull request is found, then that pull request’s state',()=>{
  const cases=[[null,'started'],[pr({state:'merged'}),'merged'],[pr({state:'closed'}),'closed'],[pr({draft:true,checks:'failure'}),'draft'],[pr({checks:'failure',review:'approved'}),'checksFailing'],[pr({checks:'pending'}),'checksRunning'],[pr({checks:'success',review:'changesRequested'}),'changesRequested'],[pr({checks:'success',review:'approved'}),'approved'],[pr({review:'reviewRequired'}),'reviewRequested'],[pr(),'reviewRequested']];
  for(const [value,want] of cases){assert.equal(cloudStatus({...record(),pr:value}),want,JSON.stringify(value));assert.ok(STATUS_LABELS[want]);}
});

test('the exact Claude Code arguments for create, message and teleport',()=>{
  assert.deepEqual(createArgs('Use the ship-tickets skill to ship sc-69416.'),['--cloud','Use the ship-tickets skill to ship sc-69416.']);
  assert.deepEqual(messageArgs(ID,'Rebase on main'),['-p','Rebase on main','--cloud',ID,'--output-format','json']);
  assert.deepEqual(teleportArgs(ID),['--teleport',ID]);
  assert.equal(validMessage('  line one\nline two '),'line one\nline two');
  for(const bad of ['','   ','tab\there','x'.repeat(4001)])assert.throws(()=>validMessage(bad),/message|Messages/i);
});

test('the session link is found in a tab’s screen text',()=>{
  assert.deepEqual(findSessionLink('Cloning…\nView: https://claude.ai/code/'+ID+'?from=cli\n'),{id:ID,url:'https://claude.ai/code/'+ID});
  assert.equal(findSessionLink('Cloning the repository…'),null);assert.equal(findSessionLink(null),null);
});
