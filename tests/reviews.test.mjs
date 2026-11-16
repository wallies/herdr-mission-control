import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fetchReviewQueue,QUERIES,PAGE_SIZE,MAX_PAGES} from '../src/mods/mission-control-reviews/reviews.mjs';
import {dispatchReviews} from '../src/mods/mission-control-reviews/backend.mjs';
import {reviewTask,reviewLaunchSource,remoteRepository,TASK_MAX} from '../src/mods/mission-control-reviews/model.js';
import {validateReply} from '../src/mods/mission-control-reviews/data.js';
import {resolveCheckout,verifyCheckout,saveCheckout} from '../src/mods/mission-control-reviews/checkout.js';
import {newConfig,bindingKey,readConfig} from '../src/shared/config.js';

const NOW=Date.parse('2026-11-16T00:00:00Z'),SITE='https://github.com',API='https://api.github.com';
const connection={id:'work',kind:'github',site:SITE,apiBase:API,credentialEnv:'GH_WORK'};
const iso=n=>new Date(NOW-n*3600000).toISOString();
/** A raw search item as GitHub returns it; `age` is hours since the last update. */
function item(n,{repo='acme/web',age=n,draft=false,login='alice',...extra}={}){
  return {number:n,node_id:'PR_'+repo+'_'+n,title:'PRIVATE title '+n,body:'PRIVATE body',state:'open',draft,html_url:SITE+'/'+repo+'/pull/'+n,repository_url:API+'/repos/'+repo,user:{login,html_url:SITE+'/'+login},updated_at:iso(age),created_at:iso(age+10),pull_request:{url:API+'/repos/'+repo+'/pulls/'+n,html_url:SITE+'/'+repo+'/pull/'+n},...extra};
}
/** The gh layer is mocked at the transport: credentials come from env, nothing reaches GitHub. */
function fakeGithub({all=[],direct=[],totals={},graph}={}){
  const calls=[];
  const request=async(url,options)=>{
    const u=new URL(url);calls.push({url:u,options});
    assert.equal(options.headers.authorization,'Bearer fixture-token');assert.equal(options.maxRedirects,0);
    if(u.pathname==='/graphql'){if(graph)return graph(options.body);return {data:{nodes:options.body.variables.ids.map(id=>({__typename:'PullRequest',id,reviewDecision:'REVIEW_REQUIRED',statusCheckRollup:{state:'FAILURE'}}))}};}
    if(u.pathname==='/user')return {login:'cparry'};
    assert.equal(u.pathname,'/search/issues');
    const q=u.searchParams.get('q'),rows=q===QUERIES.all?all:q===QUERIES.direct?direct:assert.fail('Unexpected query '+q),page=Number(u.searchParams.get('page')),size=Number(u.searchParams.get('per_page'));
    const items=typeof rows==='function'?rows(page):rows.slice((page-1)*size,page*size);
    return {total_count:totals[q===QUERIES.all?'all':'direct']??(typeof rows==='function'?1000:rows.length),incomplete_results:false,items};
  };
  return {request,calls,options:{request,env:{GH_WORK:'fixture-token'},clock:()=>NOW}};
}
const read=(fake,operation='reviews')=>fetchReviewQueue({v:1,operation,connection},fake.options);
const keys=list=>list.map(r=>r.identity.owner+'/'+r.identity.repo+'#'+r.identity.number);

test('the reader runs both documented searches, oldest update first, 100 a page',async()=>{
  const fake=fakeGithub({all:[item(1)],direct:[]});await read(fake);
  const searches=fake.calls.filter(c=>c.url.pathname==='/search/issues').map(c=>Object.fromEntries(c.url.searchParams));
  assert.deepEqual(searches.map(s=>s.q),['is:pr is:open archived:false review-requested:@me','is:pr is:open archived:false user-review-requested:@me']);
  for(const s of searches)assert.deepEqual([s.sort,s.order,s.per_page,s.page],['updated','asc','100','1']);
});

test('direct requests are asked of you; the rest of review-requested are asked of your teams, each sorted oldest first',async()=>{
  const fake=fakeGithub({all:[item(4,{age:5}),item(2,{age:50}),item(3,{repo:'acme/api',age:30}),item(9,{age:2})],direct:[item(4,{age:5}),item(9,{age:2}),item(7,{repo:'other/lib',age:80})]});
  const queue=await read(fake);
  assert.deepEqual(keys(queue.direct),['other/lib#7','acme/web#4','acme/web#9']);
  assert.deepEqual(keys(queue.team),['acme/web#2','acme/api#3']);
  assert.ok(queue.direct.every(r=>r.section==='direct')&&queue.team.every(r=>r.section==='team'));
  assert.equal(queue.direct[1].waitingSince,Date.parse(iso(5)),'the PR update stands in for the request time');
  assert.deepEqual([queue.team[0].review,queue.team[0].checks],['reviewRequired','failure']);
  assert.equal(queue.truncated,false);assert.equal(queue.detailsUnavailable,false);
});

test('pagination stops at three pages per search and says the queue was cut',async()=>{
  const many=page=>Array.from({length:PAGE_SIZE},(_,i)=>item((page-1)*PAGE_SIZE+i+1,{age:10000-(page-1)*PAGE_SIZE-i}));
  const fake=fakeGithub({all:many,direct:many}),queue=await read(fake);
  assert.equal(fake.calls.filter(c=>c.url.pathname==='/search/issues').length,2*MAX_PAGES);
  assert.equal(queue.direct.length,MAX_PAGES*PAGE_SIZE);assert.equal(queue.team.length,0);assert.equal(queue.truncated,true);
  const short=fakeGithub({all:[item(1),item(2)],direct:[]});const small=await read(short);
  assert.equal(short.calls.filter(c=>c.url.pathname==='/search/issues').length,2,'a short page ends the search');assert.equal(small.truncated,false);
});

test('a failed detail read leaves checks and review state out and says so',async()=>{
  const fake=fakeGithub({all:[item(1)],direct:[],graph:()=>({errors:[{type:'FORBIDDEN'}],data:null})}),queue=await read(fake);
  assert.equal(queue.detailsUnavailable,true);assert.deepEqual([queue.team[0].review,queue.team[0].checks],[null,null]);
});

test('malformed search responses are rejected, never repaired',async()=>{
  const cases={
    'missing pull_request':item(1,{pull_request:undefined}),
    'issue url':item(1,{html_url:SITE+'/acme/web/issues/1'}),
    'other API origin':item(1,{repository_url:'https://evil.example/repos/acme/web'}),
    'control characters in title':item(1,{title:'bad\u0007title'}),
    'author url elsewhere':item(1,{user:{login:'alice',html_url:'https://evil.example/alice'}}),
    'updated time':item(1,{updated_at:'yesterday'}),
    'draft type':item(1,{draft:'yes'})
  };
  for(const [name,raw] of Object.entries(cases)){const reply=await dispatchReviews({v:1,operation:'reviews',connection},fakeGithub({all:[raw]}).options);assert.equal(reply.ok,false,name);assert.equal(reply.error.code,'INVALID_RESPONSE',name);assert.doesNotMatch(JSON.stringify(reply),/PRIVATE|fixture-token/,name);}
  const bad=fakeGithub();bad.options.request=async()=>({total_count:'1',incomplete_results:false,items:[]});
  assert.equal((await dispatchReviews({v:1,operation:'reviews',connection},bad.options)).error.code,'INVALID_RESPONSE');
  const big=fakeGithub();big.options.request=async()=>({total_count:101,incomplete_results:false,items:Array.from({length:101},(_,i)=>item(i+1))});
  assert.equal((await dispatchReviews({v:1,operation:'reviews',connection},big.options)).error.code,'INVALID_RESPONSE');
  assert.equal((await dispatchReviews({v:1,operation:'reviews',connection:{...connection,apiBase:'https://api.github.com/x'}},fakeGithub().options)).error.code,'INVALID_CONNECTION');
});

test('helper replies are checked field by field on the native side',async()=>{
  const reply=await dispatchReviews({v:1,operation:'reviews',connection},fakeGithub({all:[item(1),item(2)],direct:[item(2)]}).options);
  const snapshot=validateReply(reply,'reviews');assert.equal(snapshot.direct.length,1);assert.equal(snapshot.team.length,1);
  const moved=structuredClone(reply);moved.snapshot.team.push(moved.snapshot.direct[0]);assert.throws(()=>validateReply(moved,'reviews'),/did not check out/);
  const twice=structuredClone(reply);twice.snapshot.team.push({...twice.snapshot.direct[0],section:'team'});assert.throws(()=>validateReply(twice,'reviews'),/did not check out/,'one PR is listed once');
  const wrong=structuredClone(reply);wrong.snapshot.direct[0].section='team';assert.throws(()=>validateReply(wrong,'reviews'),/did not check out/);
  const extra=structuredClone(reply);extra.snapshot.direct[0].body='PRIVATE';assert.throws(()=>validateReply(extra,'reviews'),/did not check out/);
  assert.equal(validateReply(await dispatchReviews({v:1,operation:'probe',connection},fakeGithub().options),'probe').login,'cparry');
});

const review=(extra={})=>({identity:{kind:'github-pr',connectionId:'work',site:SITE,owner:'acme',repo:'web',number:7},key:'GH-PR-7',url:SITE+'/acme/web/pull/7',title:'PRIVATE title',author:{login:'alice',url:SITE+'/alice'},draft:false,section:'direct',waitingSince:NOW,review:null,checks:null,...extra});
const LEAD='Use the review-this skill on https://github.com/acme/web/pull/7.';

test('the review task names the skill in plain words, adds the instructions and carries no PR text',()=>{
  assert.equal(reviewTask(SITE+'/acme/web/pull/7'),LEAD);assert.equal(reviewTask(SITE+'/acme/web/pull/7','   \n '),LEAD,'an empty box sends just the first sentence');
  assert.equal(reviewTask(SITE+'/acme/web/pull/7','Focus on the migration.\nThen the API.'),LEAD+' Focus on the migration.\nThen the API.');
  assert.equal(reviewTask(SITE+'/acme/web/pull/7','one\r\ntwo'),LEAD+' one\ntwo','Windows line ends become new lines');
  const source=reviewLaunchSource(review(),'Look at tests');
  assert.equal(source.task,LEAD+' Look at tests');assert.doesNotMatch(source.task,/PRIVATE|^\//);assert.equal(source.body,undefined);
  assert.deepEqual([source.kind,source.id,source.key,source.url],['github-pr','acme/web#7','GH-PR-7',SITE+'/acme/web/pull/7']);
});

test('instructions reject every control character but new lines, and the task is capped',()=>{
  for(const bad of ['tab\there','bell\u0007','esc\u001b[2J','nul\u0000','del\u007f'])assert.throws(()=>reviewTask(SITE+'/acme/web/pull/7',bad),e=>e.code==='INVALID_INSTRUCTIONS',JSON.stringify(bad));
  const room=TASK_MAX-LEAD.length-1;assert.equal(reviewTask(SITE+'/acme/web/pull/7','x'.repeat(room)).length,TASK_MAX);
  assert.throws(()=>reviewTask(SITE+'/acme/web/pull/7','x'.repeat(room+1)),e=>e.code==='INSTRUCTIONS_TOO_LONG');
});

test('git remotes are matched to the repository on the same host only',()=>{
  for(const url of ['git@github.com:Acme/web.git','https://github.com/acme/web','https://github.com/acme/web.git','ssh://git@github.com/acme/web.git'])assert.equal(remoteRepository(url,'github.com'),'acme/web',url);
  for(const url of ['git@gitlab.com:acme/web.git','https://github.com.evil.example/acme/web','https://github.com/acme/web/extra'])assert.notEqual(remoteRepository(url,'github.com'),'acme/web',url);
});

const run=promisify(execFile);
async function command(cmd,args,options={}){try{const r=await run(cmd,args,{cwd:options.cwd,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
async function checkout(dir,origin){await fs.mkdir(dir,{recursive:true});for(const args of [['init','-q','-b','main'],...(origin?[['remote','add','origin',origin]]:[])])assert.equal((await command('git',['-C',dir,...args])).code,0);return fs.realpath(dir);}
async function home(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-reviews-home-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const exec=(cmd,args,options)=>command(cmd,args,options);

test('a Mission Control repo binding for the repository is used first',async()=>{
  const config=newConfig();config.connections.work={id:'work',kind:'github',site:SITE,apiBase:API,credentialEnv:'GH_WORK'};
  config.bindings[bindingKey(null,'/srv/web')]={machine:null,repoRoot:'/srv/web',github:{connectionId:'work',owner:'Acme',repo:'Web'}};
  const found=await resolveCheckout({config,review:review(),machine:null,exec:()=>assert.fail('a binding needs no git check'),home:'/nowhere'});
  assert.deepEqual(found,{state:'found',path:'/srv/web',via:'binding'});
  assert.equal((await resolveCheckout({config,review:review(),machine:'other',exec:async()=>({code:1,stdout:''}),home:'/nowhere'})).state,'ask','a binding on another machine does not count');
});

test('~/workspace/<owner>/<repo> is used only when its origin is that repository',async t=>{
  const root=await home(t);const repo=await checkout(path.join(root,'workspace/acme/web'),'git@github.com:Acme/web.git');
  assert.deepEqual(await resolveCheckout({config:newConfig(),review:review({identity:{...review().identity,owner:'Acme'},url:SITE+'/Acme/web/pull/7'}),machine:null,exec,home:root}),{state:'found',path:repo,via:'workspace'});
  assert.equal((await command('git',['-C',repo,'remote','set-url','origin','git@github.com:someone/web.git'])).code,0);
  const refused=await resolveCheckout({config:newConfig(),review:review(),machine:null,exec,home:root});
  assert.equal(refused.state,'ask');assert.match(refused.reason,/someone\/web/);
  await assert.rejects(verifyCheckout(path.join(repo,'sub'),{repo:'acme/web',host:'github.com',exec}),e=>['NOT_A_CHECKOUT','NOT_CHECKOUT_TOP'].includes(e.code));
  assert.equal((await resolveCheckout({config:newConfig(),review:review(),machine:null,exec,home:path.join(root,'empty')})).state,'ask','no checkout means ask');
});

test('a folder given once is saved in Mission Control settings and used next time',async t=>{
  const root=await home(t),repo=await checkout(path.join(root,'code/web'),'https://github.com/acme/web.git'),app=path.join(root,'app');await fs.mkdir(path.join(app,'mission-control'),{recursive:true});
  const io={appHome:()=>app,readTextFile:async f=>{try{return await fs.readFile(f,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},writeTextFile:async(f,text)=>fs.writeFile(f,text),ensureDirectory:async d=>fs.mkdir(d,{recursive:true})};
  const path1=await verifyCheckout(repo,{repo:'acme/web',host:'github.com',exec});await saveCheckout(io,{machine:null,repo:'acme/web',path:path1});
  const config=(await readConfig(io)).value;assert.deepEqual(config.preferences.reviews.checkouts,[{machine:null,repo:'acme/web',path:repo}]);
  assert.deepEqual(await resolveCheckout({config,review:review(),machine:null,exec,home:path.join(root,'nohome')}),{state:'found',path:repo,via:'saved'});
  assert.equal((await command('git',['-C',repo,'remote','set-url','origin','https://github.com/acme/other.git'])).code,0);
  const stale=await resolveCheckout({config,review:review(),machine:null,exec,home:path.join(root,'nohome')});assert.equal(stale.state,'ask');assert.match(stale.reason,/saved folder/);
  await assert.rejects(verifyCheckout(repo,{repo:'acme/web',host:'github.com',exec}),e=>e.code==='ORIGIN_MISMATCH');
});
