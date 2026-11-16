import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {TrackerError,publicTrackerError,validateShortcutConnection} from '../src/shared/tracker-transport.mjs';
import {fetchShortcutClaude,probeShortcutClaude,shortcutQueries,STORIES_SCHEMA,WHOAMI_SCHEMA,SYSTEM_PROMPT} from '../src/mods/mission-control-shortcut/claude.mjs';

const NOW=1800000000000,SITE='https://app.shortcut.com';
const MCP='{"mcpServers":{"shortcut":{"type":"http","url":"https://mcp.shortcut.com/mcp"}}}';
const story=(id,group='todo',overrides={})=>({id,name:'Fix story '+id,app_url:SITE+'/acme/story/'+id,state:group==='todo'?'Ready':'In Development',updated_at:'2026-10-30T10:00:00Z',group,...overrides});
const result=(structured,overrides={})=>({type:'result',subtype:'success',is_error:false,num_turns:4,total_cost_usd:0.014,terminal_reason:'completed',structured_output:structured,...overrides});
const stories=(list,{started,unstarted}={})=>result({status:'ok',stories:list,started_total:started??list.filter(s=>s.group==='inProgress').length,unstarted_total:unstarted??list.filter(s=>s.group==='todo').length});

/** A fake child process: no real `claude` ever runs in this suite. */
function fakeSpawn(behave){
  const calls=[];
  const spawn=(command,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=[];child.kill=signal=>{child.killed.push(signal);return true;};
    calls.push({command,args,options,child});
    setImmediate(()=>behave(child,{command,args,options}));
    return child;
  };
  return {spawn,calls};
}
const reply=(value,code=0)=>child=>{child.stdout.end(typeof value==='string'?value:JSON.stringify(value));child.emit('close',code);};

async function fixture(t,behave){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-shortcut-claude-test-'))),bin=path.join(root,'bin'),work=path.join(root,'work'),claude=path.join(bin,'claude');
  await fs.mkdir(bin);await fs.mkdir(work);await fs.writeFile(claude,'#!/bin/sh\nexit 99\n',{mode:0o755});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const fake=fakeSpawn(behave);
  return {...fake,claude,work,options:{spawn:fake.spawn,workRoot:work,clock:()=>NOW,env:{HOME:'/home/fixture',PATH:bin,USER:'fixture',LANG:'C.UTF-8',SHORTCUT_TOKEN:'PRIVATE',ANTHROPIC_API_KEY:'PRIVATE'}}};
}
const connection=(execution={machine:null})=>({id:'sc-work',kind:'claude',site:SITE,execution});
const selection=(extra={})=>({connectionId:'sc-work',owner:'cparry',workspace:'acme',...extra});
const request=(extra={},c=connection())=>({v:1,operation:'issues',connection:c,binding:{machine:null,repoRoot:'/repos/client-portal',shortcut:selection(extra)}});
const probe=(c=connection())=>({v:1,operation:'probe',connection:c,binding:{machine:null,repoRoot:'/repos/client-portal'}});

test('every run uses the exact trimmed argv, an empty owned cwd, closed stdin and a minimal env',async t=>{
  let cwdEntries;const f=await fixture(t,async(child,{options})=>{cwdEntries=await fs.readdir(options.cwd);reply(stories([story(1)]))(child);});
  await fetchShortcutClaude(request(),f.options);
  const [call]=f.calls,args=call.args,prompt=args.at(-1);
  assert.equal(call.command,f.claude);
  assert.deepEqual(args.slice(0,-1),['-p','--model','haiku','--max-budget-usd','0.10','--no-session-persistence','--setting-sources','project','--strict-mcp-config','--mcp-config',MCP,'--disable-slash-commands','--system-prompt',SYSTEM_PROMPT,'--tools','mcp__shortcut__search_stories','--allowedTools','mcp__shortcut__search_stories','--output-format','json','--json-schema',JSON.stringify(STORIES_SCHEMA)]);
  assert.match(prompt,/^Call mcp__shortcut__search_stories with fields \["id","name","app_url","workflow_state","updated_at"\] and limit 100 for query "owner:cparry is:started" \(group inProgress\) and for query "owner:cparry is:unstarted" \(group todo\)/);
  assert.deepEqual(call.options.stdio,['ignore','pipe','pipe']);assert.equal(call.options.shell,false);
  assert.deepEqual(call.options.env,{HOME:'/home/fixture',PATH:path.dirname(f.claude),USER:'fixture',LANG:'C.UTF-8'});
  assert.ok(call.options.cwd.startsWith(f.work+path.sep));assert.deepEqual(cwdEntries,[]);
  assert.deepEqual(await fs.readdir(f.work),[],'the run directory is removed afterwards');
  const p=await fixture(t,reply(result({status:'ok',mention_name:'cparry',workspace_slug:'acme'})));await probeShortcutClaude(probe(),p.options);
  assert.deepEqual(p.calls[0].args.slice(14,18),['--tools','mcp__shortcut__get_whoami','--allowedTools','mcp__shortcut__get_whoami']);assert.equal(p.calls[0].args.at(-2),JSON.stringify(WHOAMI_SCHEMA));assert.match(p.calls[0].args.at(-1),/member\.mention_name.*workspace\.slug/);
});

test('columns use the saved query or the captured owner and never ask for Done',()=>{
  assert.deepEqual(shortcutQueries(selection()),{todo:'owner:cparry is:unstarted',inProgress:'owner:cparry is:started'});
  assert.deepEqual(shortcutQueries(selection({query:'team:web label:api'})),{todo:'team:web label:api is:unstarted',inProgress:'team:web label:api is:started'});
});

test('a saved query reaches the prompt and stories become canonical sc- rows',async t=>{
  const f=await fixture(t,reply(stories([story(69416,'inProgress'),story(7,'todo',{updated_at:null})])));
  const snapshot=await fetchShortcutClaude(request({query:'  team:web '}),f.options);
  assert.match(f.calls[0].args.at(-1),/query "team:web is:started" \(group inProgress\) and for query "team:web is:unstarted" \(group todo\)/);
  assert.equal(snapshot.truncated,false);assert.equal(snapshot.error,undefined);assert.equal(snapshot.fetchedAt,NOW);
  const [first,second]=snapshot.data;
  assert.deepEqual(first.identity,{kind:'shortcut',connectionId:'sc-work',site:SITE,id:'69416'});
  assert.deepEqual([first.key,first.title,first.url,first.statusGroup,first.statusName,first.updatedAt,first.body],['sc-69416','Fix story 69416',SITE+'/acme/story/69416','inProgress','In Development',Date.parse('2026-10-30T10:00:00Z'),'']);
  assert.deepEqual([second.key,second.statusGroup,second.statusName,second.updatedAt],['sc-7','todo','Ready',undefined]);
});

test('counts that differ from Shortcut totals or exceed 1000 are marked incomplete',async t=>{
  for(const [list,totals] of [[[story(1)],{unstarted:2}],[[story(1,'inProgress')],{started:2}],[Array.from({length:1001},(_,i)=>story(i+1)),{}]]){
    const f=await fixture(t,reply(stories(list,totals))),snapshot=await fetchShortcutClaude(request(),f.options);
    assert.equal(snapshot.truncated,true);assert.equal(snapshot.error.code,'INCOMPLETE_RESULTS');assert.ok(snapshot.data.length<=1000);
  }
});

test('invalid model output is rejected and never repaired',async t=>{
  const ok={status:'ok',stories:[story(1)],started_total:0,unstarted_total:1};
  const cases=[
    stories([story(1,'todo',{app_url:SITE+'/acme/story/1/fix-story-1'})]),stories([story(1,'todo',{app_url:SITE+'/other/story/1'})]),stories([story(1,'todo',{app_url:'https://evil.example.com/acme/story/1'})]),
    stories([story(1),story(1)]),stories([story(1),story(1,'inProgress')]),stories([story(1,'done')]),stories([{...story(1),extra:true}]),stories([{...story(1),id:'1'}]),stories([{...story(1),id:1.5}]),stories([{...story(1),id:0}]),
    stories([{...story(1),name:''}]),stories([{...story(1),name:'x'.repeat(513)}]),stories([{...story(1),name:'bad\x1b[2J'}]),stories([{...story(1),state:''}]),stories([{...story(1),updated_at:'yesterday'}]),
    result({...ok,extra:1}),result({...ok,started_total:-1}),result({...ok,stories:{}}),result({status:'ok',stories:[]}),result(null),result({...ok,status:'maybe'}),'not json',
  ];
  for(const value of cases){const f=await fixture(t,reply(value));await assert.rejects(fetchShortcutClaude(request(),f.options),e=>e.code==='INVALID_RESPONSE',JSON.stringify(value).slice(0,160));}
  for(const value of [result({status:'ok',mention_name:'cparry',workspace_slug:'../evil'}),result({status:'ok',mention_name:'c parry',workspace_slug:'acme'}),result({status:'ok',mention_name:'cparry',workspace_slug:'acme',extra:1})]){
    const f=await fixture(t,reply(value));await assert.rejects(probeShortcutClaude(probe(),f.options),e=>e.code==='INVALID_RESPONSE');
  }
});

test('the probe captures the signed-in mention name and workspace slug',async t=>{
  const f=await fixture(t,reply(result({status:'ok',mention_name:'cparry',workspace_slug:'kapiche'})));
  assert.deepEqual(await probeShortcutClaude(probe(),f.options),{site:SITE,owner:'cparry',workspace:'kapiche'});
});

test('budget, sign-in, run failures, a missing command and timeouts give actionable public errors',async t=>{
  const check=async(behave,code,pattern,{run=r=>fetchShortcutClaude(request(),r),options={}}={})=>{
    const f=await fixture(t,behave);let child;
    await assert.rejects(run({...f.options,...options}),e=>{assert.equal(e.code,code);const safe=publicTrackerError(e);assert.match(safe.message,pattern);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);return true;});
    child=f.calls[0]?.child;return {f,child};
  };
  await check(reply(result(undefined,{subtype:'error_max_budget_usd',is_error:true,terminal_reason:'budget_exhausted'}),1),'BUDGET_EXHAUSTED',/\$0\.10 budget/);
  await check(reply(result({status:'ok',stories:[],started_total:0,unstarted_total:0},{terminal_reason:'budget_exhausted'})),'BUDGET_EXHAUSTED',/budget/);
  await check(reply(result({status:'sign_in_required',stories:[],started_total:0,unstarted_total:0})),'SHORTCUT_SIGN_IN_REQUIRED',/run \/mcp and sign in to shortcut/);
  await check(reply(result({status:'sign_in_required',mention_name:'',workspace_slug:''})),'SHORTCUT_SIGN_IN_REQUIRED',/\/mcp/,{run:r=>probeShortcutClaude(probe(),r)});
  await check(reply(result(undefined,{subtype:'error_during_execution',is_error:true,result:'PRIVATE upstream'}),1),'CLAUDE_FAILED',/Claude Code run failed/);
  await check(child=>{child.stderr.end('PRIVATE');child.emit('close',1);},'CLAUDE_FAILED',/Run claude in a terminal/);
  await check(child=>child.emit('error',Object.assign(new Error('spawn claude ENOENT'),{code:'ENOENT'})),'CLAUDE_UNAVAILABLE',/absolute path to claude in Set up/);
  const missing=await check(()=>assert.fail('no spawn'),'CLAUDE_UNAVAILABLE',/claude command/,{options:{env:{PATH:'/nonexistent'}}});assert.equal(missing.f.calls.length,0);
  const absolute=await check(()=>assert.fail('no spawn'),'CLAUDE_UNAVAILABLE',/Set up/,{run:r=>fetchShortcutClaude(request({},connection({machine:null,command:'/nonexistent/bin/claude'})),r)});assert.equal(absolute.f.calls.length,0);
  const slow=await check(()=>{},'REQUEST_TIMEOUT',/timed out/,{options:{timeoutMs:30}});assert.deepEqual(slow.child.killed,['SIGKILL']);
  const controller=new AbortController();const cancelled=await check(()=>controller.abort(),'REQUEST_CANCELLED',/cancelled/,{options:{signal:controller.signal}});assert.deepEqual(cancelled.child.killed,['SIGKILL']);
  const huge=await check(child=>child.stdout.write(Buffer.alloc(4194305,32)),'RESPONSE_TOO_LARGE',/bounded/);assert.deepEqual(huge.child.killed,['SIGKILL']);
});

test('connections hold no secret, stay local and only name a claude command',async t=>{
  const f=await fixture(t,()=>assert.fail('no spawn'));
  for(const c of [{...connection(),kind:'api'},{...connection(),site:'https://evil.example.com'},connection({machine:'server'}),connection({machine:null,command:'sh'}),connection({machine:null,command:'bin/claude'}),connection({machine:null,command:'/usr/bin/../bin/claude'}),connection({machine:null,command:'/usr/bin/claude-wrapper'}),connection({machine:null,args:['-c']}),{...connection(),auth:{kind:'token',tokenEnv:'SHORTCUT_TOKEN'}}])
    await assert.rejects(fetchShortcutClaude(request({},c),f.options),e=>['INVALID_CONNECTION','UNSUPPORTED_INTEGRATION_HOST','INVALID_REQUEST'].includes(e.code),JSON.stringify(c));
  assert.throws(()=>validateShortcutConnection(connection({machine:'server'})),e=>e instanceof TrackerError&&e.code==='UNSUPPORTED_INTEGRATION_HOST');
  assert.equal(validateShortcutConnection(connection({machine:null,command:'/home/me/.local/bin/claude'})).execution.command,'/home/me/.local/bin/claude');
  await assert.rejects(fetchShortcutClaude({...request(),cursor:'abc'},f.options),e=>e.code==='INVALID_REQUEST');
  for(const options of [{timeoutMs:120001},{workRoot:'relative'}])await assert.rejects(fetchShortcutClaude(request(),{...f.options,...options}),e=>e.code==='INVALID_REQUEST');
});
