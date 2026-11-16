import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {sendMessage,findPulls,dispatchCloud,pullsDocument,pullsVariables,choosePull,bodyLinks,SCAN_FIRST} from '../src/mods/mission-control-agents/cloud.mjs';

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

const LINK='Opened from https://claude.ai/code/'+ID+' by Claude.';
const node=(over={})=>({number:12,url:'https://github.com/acme/botanic/pull/12',state:'OPEN',isDraft:false,updatedAt:'2026-11-10T00:00:00Z',reviewDecision:null,statusCheckRollup:null,repository:{nameWithOwner:'acme/botanic'},body:LINK,...over});
const pull=(n,over={})=>node({number:n,url:'https://github.com/acme/botanic/pull/'+n,...over});
function ghFixture(reply){
  const calls=[];
  const request=async(url,options)=>{calls.push({url,options});return typeof reply==='function'?reply(options.body,calls.length):reply;};
  return {calls,request};
}
async function fakeGh(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mc-cloud-gh-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const gh=path.join(dir,'gh');
  await fs.writeFile(gh,'#!/bin/sh\nif [ "$3" = "--help" ]; then printf "  -h, --hostname string\\n  -u, --user string\\n"; else printf "gho_fixturetoken\\n"; fi\n',{mode:0o755});return gh;
}
const OTHER='session_OTHER0000000000';

test('a session without a known pull request scans its repository’s recent pull requests for the session link',async t=>{
  const gh=await fakeGh(t),f=ghFixture(()=>({data:{r0:{pullRequests:{nodes:[pull(7,{body:'nothing here'}),pull(12,{statusCheckRollup:{state:'FAILURE'},reviewDecision:'APPROVED'})]}}}}));
  const result=await findPulls({connection,sessions:[{id:ID,repo:'acme/botanic',number:null}]},{request:f.request,ghCommand:gh,env:{PATH:process.env.PATH},clock:()=>777});
  assert.equal(f.calls.length,1);const [call]=f.calls;
  assert.equal(call.url,'https://api.github.com/graphql');assert.equal(call.options.method,'POST');assert.equal(call.options.headers.authorization,'Bearer gho_fixturetoken');assert.equal(call.options.maxBytes,1048576);
  assert.deepEqual(call.options.body.variables,{o0:'acme',n0:'botanic'});
  assert.match(call.options.body.query,new RegExp('r0: repository\\(owner: \\$o0, name: \\$n0\\) \\{ pullRequests\\(first: '+SCAN_FIRST+', states: \\[OPEN, CLOSED, MERGED\\], orderBy: \\{field: UPDATED_AT, direction: DESC\\}\\) \\{ nodes \\{ [^\\n]*body'));
  assert.doesNotMatch(call.options.body.query,/search\(/);
  assert.deepEqual(result,{checkedAt:777,found:{[ID]:{number:12,url:'https://github.com/acme/botanic/pull/12',state:'open',draft:false,checks:'failure',review:'approved'}}});
  assert.doesNotMatch(JSON.stringify(result),/Opened from|body/,'no body is kept or returned');
});

test('body matching: the link in either id form, never another session, a bare id or a missing body',()=>{
  const tail=ID.slice(8);
  assert.equal(bodyLinks(LINK,ID),true);assert.equal(bodyLinks('see claude.ai/code/cse_'+tail+'?from=cli',ID),true);assert.equal(bodyLinks('[session](https://claude.ai/code/'+ID+')',ID),true);
  for(const body of [null,undefined,'','no link',ID,'https://claude.ai/code/'+OTHER,'https://claude.ai/code/'+ID+'X'])assert.equal(bodyLinks(body,ID),false,String(body));
  const nodes=[pull(3,{body:null}),pull(4,{body:'https://claude.ai/code/'+OTHER}),pull(5,{body:'unrelated'})];
  assert.equal(choosePull(nodes,'acme/botanic',ID),null);
});

test('the first match: open over closed, then the one updated last; other repositories and bad links are rejected',()=>{
  const map=over=>choosePull([node(over)],'acme/botanic',ID);
  assert.equal(map({state:'MERGED'}).state,'merged');assert.equal(map({state:'CLOSED'}).state,'closed');assert.equal(map({isDraft:true}).draft,true);
  assert.equal(map({statusCheckRollup:{state:'PENDING'}}).checks,'pending');assert.equal(map({statusCheckRollup:{state:'ERROR'}}).checks,'failure');assert.equal(map({statusCheckRollup:{state:'SUCCESS'}}).checks,'success');
  assert.equal(map({reviewDecision:'CHANGES_REQUESTED'}).review,'changesRequested');assert.equal(map({reviewDecision:'REVIEW_REQUIRED'}).review,'reviewRequired');
  const nodes=[pull(3,{state:'CLOSED',updatedAt:'2026-11-12T00:00:00Z'}),pull(4,{updatedAt:'2026-11-01T00:00:00Z'}),pull(5,{updatedAt:'2026-11-05T00:00:00Z'}),pull(6,{body:'no link',updatedAt:'2026-11-15T00:00:00Z'}),node({repository:{nameWithOwner:'evil/botanic'},url:'https://github.com/evil/botanic/pull/9',number:9})];
  assert.equal(choosePull(nodes,'acme/botanic',ID).number,5);assert.equal(choosePull([],'acme/botanic',ID),null);
  assert.throws(()=>choosePull([node({url:'https://evil.example/acme/botanic/pull/12'})],'acme/botanic',ID),{code:'INVALID_RESPONSE'});
});

test('a known pull request is read directly by number, and sessions in one repository share one scan',async t=>{
  const gh=await fakeGh(t),third='session_THIRD0000000000',fourth='session_FOURTH000000000';
  const f=ghFixture(()=>({data:{p0:{pullRequest:pull(12,{state:'MERGED'})},r0:{pullRequests:{nodes:[pull(20,{body:'https://claude.ai/code/'+OTHER}),pull(21,{body:'https://claude.ai/code/'+third})]}},r1:null}}));
  const sessions=[{id:ID,repo:'acme/botanic',number:12},{id:OTHER,repo:'acme/botanic',number:null},{id:third,repo:'Acme/Botanic',number:null},{id:fourth,repo:'acme/gone',number:null}];
  const {found}=await findPulls({connection,sessions},{request:f.request,ghCommand:gh,env:{PATH:process.env.PATH}});
  assert.equal(f.calls.length,1);const {query,variables}=f.calls[0].options.body;
  assert.deepEqual(variables,{o0:'acme',n0:'botanic',o1:'acme',n1:'gone',po0:'acme',pn0:'botanic',pk0:12});
  assert.match(query,/p0: repository\(owner: \$po0, name: \$pn0\) \{ pullRequest\(number: \$pk0\)/);assert.doesNotMatch(query,/r2:/,'two sessions in one repository cost one scan');
  assert.equal(found[ID].state,'merged');assert.equal(found[OTHER].number,20);assert.equal(found[third].number,21);assert.equal(found[fourth],null,'a missing repository finds nothing');
  assert.deepEqual(pullsVariables(['a/b'],[{repo:'c/d',number:4}]),{o0:'a',n0:'b',po0:'c',pn0:'d',pk0:4});assert.match(pullsDocument([],[{repo:'c/d',number:4}]),/\$pk0: Int!/);
});

test('scans are split three repositories per call to stay under the response cap',async t=>{
  const gh=await fakeGh(t),f=ghFixture(body=>({data:Object.fromEntries(Object.keys(body.variables).filter(k=>/^o\d+$/.test(k)).map(k=>['r'+k.slice(1),{pullRequests:{nodes:[]}}]))}));
  const sessions=Array.from({length:7},(_,i)=>({id:'session_'+String(i).padStart(10,'A'),repo:'acme/r'+i,number:null}));
  const {found}=await findPulls({connection,sessions},{request:f.request,ghCommand:gh,env:{PATH:process.env.PATH}});
  assert.deepEqual(f.calls.map(c=>Object.keys(c.options.body.variables).length),[6,6,2]);assert.equal(Object.keys(found).length,7);
});

test('lookups refuse unbounded or malformed input and GraphQL errors',async t=>{
  const gh=await fakeGh(t),f=ghFixture({errors:[{message:'boom'}]});
  const ask=(input)=>dispatchCloud({v:1,operation:'pulls',connection,...input},{request:f.request,ghCommand:gh,env:{PATH:process.env.PATH}});
  assert.equal((await ask({sessions:[]})).error.code,'INVALID_REQUEST');
  assert.equal((await ask({sessions:Array.from({length:21},(_,i)=>({id:'session_'+String(i).padStart(10,'A'),repo:'acme/x',number:null}))})).error.code,'INVALID_REQUEST');
  for(const s of [{id:ID,repo:'acme/botanic repo:evil/x',number:null},{id:ID,repo:'acme/botanic'},{id:ID,repo:'acme/botanic',number:0},{id:ID,repo:'acme/botanic',number:'5'}])assert.equal((await ask({sessions:[s]})).error.code,'INVALID_REQUEST',JSON.stringify(s));
  assert.equal(f.calls.length,0);
  assert.equal((await ask({sessions:[{id:ID,repo:'acme/botanic',number:null}]})).error.code,'INVALID_RESPONSE');
  const ghe=await dispatchCloud({v:1,operation:'pulls',connection:{...connection,site:'https://acme.ghe.com',apiBase:'https://api.acme.ghe.com',gh:{host:'acme.ghe.com',account:'cparry'}},sessions:[{id:ID,repo:'acme/botanic',number:null}]},{request:f.request,ghCommand:gh});
  assert.equal(ghe.error.code,'NOT_GITHUB_COM');assert.equal(f.calls.length,1);
});
