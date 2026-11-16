import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {dispatchShortcut} from '../src/mods/mission-control-shortcut/backend.mjs';
import {newConfig,bindingKey,validateConfig} from '../src/shared/config.js';
import {TrackerModelError,trackerScope,validateIssue,validateRepoBinding,selectTracker} from '../src/shared/tracker-model.js';
import {validateLaunchRequest} from '../src/shared/launch.js';
import {ensureWorktree} from '../src/shared/worktrees.js';

const NOW=1800000000000,SITE='https://app.shortcut.com';
const connection=(execution={machine:null})=>({id:'sc-work',kind:'claude',site:SITE,execution});
const binding=(selection={})=>({machine:null,repoRoot:'/repos/client-portal',shortcut:{connectionId:'sc-work',owner:'cparry',workspace:'acme',...selection}});
const request=(extra={})=>({v:1,operation:'issues',connection:connection(),binding:binding(),...extra});
const issue=(overrides={})=>({identity:{kind:'shortcut',connectionId:'sc-work',site:SITE,id:'4821'},key:'sc-4821',title:'Fix it',url:SITE+'/acme/story/4821',body:'',statusGroup:'todo',statusName:'Ready',repoBinding:binding(),...overrides});
const result=structured=>({type:'result',subtype:'success',is_error:false,num_turns:3,terminal_reason:'completed',structured_output:structured});

/** Fake child process at the spawn boundary; replies with one canned Claude Code result. */
async function fixture(t,structured){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-shortcut-backend-'))),bin=path.join(root,'bin');
  await fs.mkdir(bin);await fs.writeFile(path.join(bin,'claude'),'#!/bin/sh\nexit 99\n',{mode:0o755});t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const calls=[],spawn=(command,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;calls.push(args);setImmediate(()=>{child.stdout.end(JSON.stringify(result(structured)));child.emit('close',0);});return child;};
  return {calls,options:{claude:{spawn,workRoot:root},env:{PATH:bin,HOME:root},clock:()=>NOW}};
}

test('dispatch returns one snapshot for the bound columns and rejects cursors',async t=>{
  const f=await fixture(t,{status:'ok',stories:[{id:4821,name:'Fix it',app_url:SITE+'/acme/story/4821',state:'Ready',updated_at:null,group:'todo'}],started_total:0,unstarted_total:1});
  const read=await dispatchShortcut(request(),f.options);
  assert.equal(read.ok,true);assert.deepEqual(read.snapshot.data.map(v=>[v.key,v.url]),[['sc-4821',SITE+'/acme/story/4821']]);assert.equal(read.snapshot.truncated,false);assert.equal(read.snapshot.scope.source,'shortcut');
  const cursor=await dispatchShortcut(request({cursor:'abc'}),f.options);assert.equal(cursor.ok,false);assert.equal(cursor.error.code,'INVALID_REQUEST');assert.equal(f.calls.length,1);
});

test('probe and invalid requests return public errors only',async t=>{
  const f=await fixture(t,{status:'ok',mention_name:'cparry',workspace_slug:'acme'});
  const probe=await dispatchShortcut(request({operation:'probe',binding:{machine:null,repoRoot:'/repos/client-portal'}}),f.options);
  assert.equal(probe.ok,true);assert.deepEqual(probe.probe,{site:SITE,owner:'cparry',workspace:'acme'});
  for(const input of [request({operation:'pulls'}),request({binding:binding({query:''})}),request({binding:{...binding(),shortcut:{connectionId:'sc-work',query:'x'}}}),{...request(),connection:{...connection(),site:'https://evil.example.com'}}]){
    const r=await dispatchShortcut(input,f.options);assert.equal(r.ok,false);assert.ok(['INVALID_REQUEST','INVALID_SCOPE','INVALID_CONNECTION'].includes(r.error.code),r.error.code);
  }
  assert.equal(f.calls.length,1);
  const missing=await dispatchShortcut(request(),{...f.options,env:{PATH:'/nonexistent'}});assert.equal(missing.error.code,'CLAUDE_UNAVAILABLE');
});

test('shared model accepts Shortcut bindings, scopes and canonical story links only',()=>{
  assert.deepEqual(validateRepoBinding(binding({query:' owner:cam '})).shortcut,{connectionId:'sc-work',owner:'cparry',workspace:'acme',query:'owner:cam'});
  for(const bad of [{connectionId:'sc-work',owner:'cparry'},{connectionId:'sc-work',workspace:'acme'},{connectionId:'sc-work',owner:'c parry',workspace:'acme'},{connectionId:'sc-work',owner:'cparry',workspace:'../x'},{connectionId:'sc-work',owner:'cparry',workspace:'acme',query:''},{connectionId:'sc-work',owner:'cparry',workspace:'acme',project:'WEB'}])
    assert.throws(()=>validateRepoBinding({...binding(),shortcut:bad}),TrackerModelError,JSON.stringify(bad));
  const scope=trackerScope('shortcut',connection(),binding());assert.equal(scope.site,SITE);assert.equal(validateIssue(issue(),{scope}).key,'sc-4821');
  for(const c of [{...connection(),site:'https://other.example.com'},{...connection(),kind:'api'}])assert.throws(()=>trackerScope('shortcut',c,binding()),TrackerModelError);
  assert.throws(()=>trackerScope('shortcut',connection({machine:'server'}),binding()),e=>e.code==='UNSUPPORTED_INTEGRATION_HOST');
  for(const change of [{key:'SC-4821'},{key:'sc-1'},{url:SITE+'/acme/story/4821/fix-it'},{url:SITE+'/other/story/4821'},{url:SITE+'/acme/story/1'},{url:'https://evil.example.com/acme/story/4821'},{identity:{...issue().identity,id:'0'}},{identity:{...issue().identity,site:'https://other.example.com'}}])
    assert.throws(()=>validateIssue(issue(change)),TrackerModelError,JSON.stringify(change));
  const c=newConfig();c.connections['sc-work']=connection();c.bindings[bindingKey(null,'/repos/client-portal')]=binding();
  assert.equal(selectTracker(validateConfig(c),{state:'resolved',machine:null,repoRoot:'/repos/client-portal'},'shortcut').connection.id,'sc-work');
  c.bindings[bindingKey(null,'/repos/client-portal')].shortcut={connectionId:'sc-work'};assert.throws(()=>validateConfig(c),/owner and workspace/);
  c.bindings[bindingKey(null,'/repos/client-portal')].shortcut=binding({connectionId:'missing'}).shortcut;assert.throws(()=>validateConfig(c),/existing connection/);
});

test('launch requests and worktree identities accept a Shortcut source',async()=>{
  const raw={requestId:'r',idempotencyKey:'i',originId:'o',spaceId:'s',machine:null,repoRoot:'/fixture/repo',checkoutRoot:'/fixture/repo',toolKey:'claude',worktree:true,source:{kind:'shortcut',connectionId:'sc-work',site:SITE,id:'4821',key:'sc-4821',title:'Fix it',url:SITE+'/acme/story/4821'}};
  assert.equal(validateLaunchRequest(raw).source.kind,'shortcut');
  const exec=async()=>assert.fail('no command for a mismatched capture');
  await assert.rejects(ensureWorktree(raw,{},{exec}),e=>e.code==='RETRY_CHANGED');await assert.rejects(ensureWorktree({...raw,source:{...raw.source,kind:'invented'}},{},{exec}),e=>e.code==='INVALID_WORKTREE');
});
