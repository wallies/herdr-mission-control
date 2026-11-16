import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {sendMessage,findPulls,dispatchCloud,pullQuery,pullsDocument,choosePull} from '../src/mods/mission-control-agents/cloud.mjs';

const ID='session_01HJKLMNOPQRSTUVWXYZ';
const connection={id:'github-reviews',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',gh:{host:'github.com',account:'cparry'}};

/** A fake `claude` on PATH (never run) and a spawn that records argv and answers like Claude Code. */
async function claudeFixture(t,answer){
  const bin=await fs.mkdtemp(path.join(os.tmpdir(),'mc-cloud-bin-'));t.after(()=>fs.rm(bin,{recursive:true,force:true}));
  await fs.writeFile(path.join(bin,'claude'),'#!/bin/sh\nexit 99\n',{mode:0o755});
  const calls=[];
  const spawn=(command,args,options)=>{
    calls.push({command,args,options});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{child.killed=true;};
    queueMicrotask(()=>{const a=answer(args);if(a.hang)return;if(a.error){child.emit('error',a.error);return;}if(a.stdout)child.stdout.emit('data',Buffer.from(a.stdout));if(a.stderr)child.stderr.emit('data',Buffer.from(a.stderr));child.emit('close',a.code??0);});
    return child;
  };
  return {env:{PATH:bin,HOME:'/nowhere',SECRET_TOKEN:'x'},spawn,calls,bin};
}

test('a message runs claude -p <text> --cloud <id> --output-format json with argv, no shell and stdin closed',async t=>{
  const f=await claudeFixture(t,()=>({stdout:JSON.stringify({ok:true,session_id:ID,url:'https://claude.ai/code/'+ID+'?from=cli&m=0'})+'\n'}));
  assert.deepEqual(await sendMessage({session:ID,message:'Rebase on main\nthen push'},{spawn:f.spawn,env:f.env}),{session:ID});
  const [call]=f.calls;assert.equal(call.command,path.join(f.bin,'claude'));
  assert.deepEqual(call.args,['-p','Rebase on main\nthen push','--cloud',ID,'--output-format','json']);
  assert.equal(call.options.shell,false);assert.deepEqual(call.options.stdio,['ignore','pipe','pipe']);
  assert.equal(call.options.env.SECRET_TOKEN,undefined,'only the listed environment reaches claude');
});

test('message failures map to clear errors without passing Claude Code’s text on',async t=>{
  const cases=[
    [{code:1,stderr:'Error: Cloud sessions need a claude.ai sign-in. Run `claude auth login` (or /login in a local session), then try again.'},'NOT_SIGNED_IN'],
    [{code:1,stderr:'Error: Cloud sessions are disabled by your organization\'s policy.'},'CLOUD_DISABLED'],
    [{code:1,stdout:JSON.stringify({ok:false,session_id:ID,error:'cloud session '+ID+' is archived and cannot accept new messages'})},'SESSION_ARCHIVED'],
    [{code:1,stdout:JSON.stringify({ok:false,session_id:ID,error:'Session not found: '+ID})},'SESSION_NOT_FOUND'],
    [{code:1,stderr:'something else'},'SEND_FAILED'],
    [{code:0,stdout:JSON.stringify({ok:true,session_id:'session_OTHER0000000000',url:'https://claude.ai/code/session_OTHER0000000000'})},'INVALID_RESPONSE'],
    [{error:Object.assign(Error('spawn claude ENOENT'),{code:'ENOENT'})},'CLAUDE_UNAVAILABLE']];
  for(const [answer,code] of cases){
    const f=await claudeFixture(t,()=>answer),reply=await dispatchCloud({v:1,operation:'message',session:ID,message:'hi'},{spawn:f.spawn,env:f.env});
    assert.equal(reply.ok,false);assert.equal(reply.error.code,code,JSON.stringify(answer));assert.doesNotMatch(reply.error.message,/something else|cannot accept new messages|Session not found:/);
  }
  const slow=await claudeFixture(t,()=>({hang:true}));await assert.rejects(sendMessage({session:ID,message:'hi'},{spawn:slow.spawn,env:slow.env,timeoutMs:20}),{code:'REQUEST_TIMEOUT'});
  const missing=await dispatchCloud({v:1,operation:'message',session:ID,message:'hi'},{env:{PATH:'/nowhere',HOME:'/nowhere'}});assert.equal(missing.error.code,'CLAUDE_UNAVAILABLE');
  for(const input of [{v:1,operation:'message',session:'bad',message:'hi'},{v:1,operation:'message',session:ID,message:''},{v:1,operation:'message',session:'cse_01HJKLMNOPQRSTUVWXYZ',message:'hi'},{v:1,operation:'create',task:'x'},{v:2}]){
    const f=await claudeFixture(t,()=>assert.fail('claude must not run'));assert.equal((await dispatchCloud(input,{spawn:f.spawn,env:f.env})).error.code,'INVALID_REQUEST',JSON.stringify(input));
  }
});

const node=(over={})=>({number:12,url:'https://github.com/acme/botanic/pull/12',state:'OPEN',isDraft:false,updatedAt:'2026-11-10T00:00:00Z',reviewDecision:null,statusCheckRollup:null,repository:{nameWithOwner:'acme/botanic'},...over});
function ghFixture(reply){
  const calls=[];
  const request=async(url,options)=>{calls.push({url,options});return typeof reply==='function'?reply(options.body):reply;};
  const ghCommand=path.join(os.tmpdir(),'mc-fake-gh');
  return {calls,request,ghCommand};
}
async function fakeGh(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mc-cloud-gh-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const gh=path.join(dir,'gh');
  await fs.writeFile(gh,'#!/bin/sh\nif [ "$3" = "--help" ]; then printf "  -h, --hostname string\\n  -u, --user string\\n"; else printf "gho_fixturetoken\\n"; fi\n',{mode:0o755});return gh;
}

test('pull requests are found by the session id in their body, through the Reviews gh connection, in one GraphQL call',async t=>{
  const gh=await fakeGh(t),f=ghFixture(body=>({data:{s0:{nodes:[node({checks:undefined,statusCheckRollup:{state:'FAILURE'},reviewDecision:'APPROVED'})]},s1:{nodes:[]}}}));
  const sessions=[{id:ID,repo:'acme/botanic'},{id:'session_OTHER0000000000',repo:'acme/seed'}];
  const result=await findPulls({connection,sessions},{request:f.request,ghCommand:gh,env:{PATH:process.env.PATH},clock:()=>777});
  assert.equal(f.calls.length,1);const [call]=f.calls;
  assert.equal(call.url,'https://api.github.com/graphql');assert.equal(call.options.method,'POST');assert.equal(call.options.headers.authorization,'Bearer gho_fixturetoken');
  assert.deepEqual(call.options.body.variables,{q0:'is:pr in:body '+ID+' repo:acme/botanic',q1:'is:pr in:body session_OTHER0000000000 repo:acme/seed'});
  assert.equal(pullQuery(ID,'acme/botanic'),'is:pr in:body '+ID+' repo:acme/botanic');assert.match(pullsDocument(2),/s1: search\(query: \$q1, type: ISSUE/);
  assert.deepEqual(result,{checkedAt:777,found:{[ID]:{number:12,url:'https://github.com/acme/botanic/pull/12',state:'open',draft:false,checks:'failure',review:'approved'},session_OTHER0000000000:null}});
});

test('state mapping and choice: open over closed, latest first, other repositories ignored, bad links rejected',()=>{
  const map=over=>choosePull([node(over)],'acme/botanic');
  assert.equal(map({state:'MERGED'}).state,'merged');assert.equal(map({state:'CLOSED'}).state,'closed');assert.equal(map({isDraft:true}).draft,true);
  assert.equal(map({statusCheckRollup:{state:'PENDING'}}).checks,'pending');assert.equal(map({statusCheckRollup:{state:'ERROR'}}).checks,'failure');assert.equal(map({statusCheckRollup:{state:'SUCCESS'}}).checks,'success');
  assert.equal(map({reviewDecision:'CHANGES_REQUESTED'}).review,'changesRequested');assert.equal(map({reviewDecision:'REVIEW_REQUIRED'}).review,'reviewRequired');
  const nodes=[node({number:3,url:'https://github.com/acme/botanic/pull/3',state:'CLOSED',updatedAt:'2026-11-12T00:00:00Z'}),node({number:4,url:'https://github.com/acme/botanic/pull/4',updatedAt:'2026-11-01T00:00:00Z'}),node({number:5,url:'https://github.com/acme/botanic/pull/5',updatedAt:'2026-11-05T00:00:00Z'}),{},node({repository:{nameWithOwner:'evil/botanic'},url:'https://github.com/evil/botanic/pull/9',number:9})];
  assert.equal(choosePull(nodes,'acme/botanic').number,5);assert.equal(choosePull([],'acme/botanic'),null);
  assert.throws(()=>choosePull([node({url:'https://evil.example/acme/botanic/pull/12'})],'acme/botanic'),{code:'INVALID_RESPONSE'});
});

test('lookups refuse unbounded or malformed input and GraphQL errors',async t=>{
  const gh=await fakeGh(t),f=ghFixture({errors:[{message:'boom'}]});
  const ask=(input)=>dispatchCloud({v:1,operation:'pulls',connection,...input},{request:f.request,ghCommand:gh,env:{PATH:process.env.PATH}});
  assert.equal((await ask({sessions:[]})).error.code,'INVALID_REQUEST');
  assert.equal((await ask({sessions:Array.from({length:21},(_,i)=>({id:'session_'+String(i).padStart(10,'A'),repo:'acme/x'}))})).error.code,'INVALID_REQUEST');
  assert.equal((await ask({sessions:[{id:ID,repo:'acme/botanic repo:evil/x'}]})).error.code,'INVALID_REQUEST');
  assert.equal((await ask({sessions:[{id:ID,repo:'acme/botanic'}]})).error.code,'INVALID_RESPONSE');
  const ghe=await dispatchCloud({v:1,operation:'pulls',connection:{...connection,site:'https://acme.ghe.com',apiBase:'https://api.acme.ghe.com',gh:{host:'acme.ghe.com',account:'cparry'}},sessions:[{id:ID,repo:'acme/botanic'}]},{request:f.request,ghCommand:gh});
  assert.equal(ghe.error.code,'NOT_GITHUB_COM');assert.equal(f.calls.length,1);
});
