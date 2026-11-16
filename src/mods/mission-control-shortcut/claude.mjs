import {spawn as nodeSpawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TrackerError,SHORTCUT_SITE,validateShortcutConnection,validateTrackerRequest} from '../../shared/tracker-transport.mjs';
import {trackerScope,validateIssue,validateSnapshot} from '../../shared/tracker-model.js';

/** The server must be named `shortcut` at this URL so Claude Code reuses its stored Shortcut login. */
export const MCP_CONFIG=JSON.stringify({mcpServers:{shortcut:{type:'http',url:'https://mcp.shortcut.com/mcp'}}});
export const SYSTEM_PROMPT='You fetch Shortcut stories with the tools given and return them in the required JSON. Copy field values exactly from tool results.';
export const SEARCH_TOOL='mcp__shortcut__search_stories';
export const WHOAMI_TOOL='mcp__shortcut__get_whoami';
const MAX_TIMEOUT_MS=120000,MAX_STORIES=1000,MAX_STDOUT=4194304,MAX_STDERR=65536;
const ENV_KEYS=['HOME','PATH','USER','LANG'];
const OWNER=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,WORKSPACE=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STORY_FIELDS=['id','name','app_url','state','updated_at','group'];
const GROUPS=['todo','inProgress'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const count=v=>Number.isSafeInteger(v)&&v>=0;
const fail=code=>{throw new TrackerError(code);};
const SIGN_IN='If the Shortcut tool is unavailable or asks you to sign in, return status "sign_in_required" and nothing else from Shortcut; otherwise return status "ok".';

const storySchema={type:'object',additionalProperties:false,required:STORY_FIELDS,properties:{id:{type:'integer'},name:{type:'string'},app_url:{type:'string'},state:{type:'string'},updated_at:{type:['string','null']},group:{type:'string',enum:GROUPS}}};
export const STORIES_SCHEMA={type:'object',additionalProperties:false,required:['status','stories','started_total','unstarted_total'],properties:{status:{type:'string',enum:['ok','sign_in_required']},stories:{type:'array',items:storySchema},started_total:{type:'integer',minimum:0},unstarted_total:{type:'integer',minimum:0}}};
export const WHOAMI_SCHEMA={type:'object',additionalProperties:false,required:['status','mention_name','workspace_slug'],properties:{status:{type:'string',enum:['ok','sign_in_required']},mention_name:{type:'string'},workspace_slug:{type:'string'}}};

/** To do and In progress columns; there is deliberately no Done query. */
export function shortcutQueries(selection){
  const base=selection.query??'owner:'+selection.owner;
  return {todo:base+' is:unstarted',inProgress:base+' is:started'};
}
export function storiesPrompt(queries){
  return 'Call '+SEARCH_TOOL+' with fields ["id","name","app_url","workflow_state","updated_at"] and limit 100 for query '+JSON.stringify(queries.inProgress)+' (group inProgress) and for query '+JSON.stringify(queries.todo)+' (group todo), following next pages with the cursor. Return every story; state is workflow_state.name. Set started_total and unstarted_total to total_items from the first page of each query. '+SIGN_IN;
}
export const WHOAMI_PROMPT='Call '+WHOAMI_TOOL+'. Set mention_name to member.mention_name and workspace_slug to workspace.slug. '+SIGN_IN;

/** Every flag keeps one run small: no project settings, no other MCP servers, one allowed tool. */
export function claudeArgs({tool,schema,prompt}){
  return ['-p','--model','haiku','--max-budget-usd','0.10','--no-session-persistence','--setting-sources','project','--strict-mcp-config','--mcp-config',MCP_CONFIG,'--disable-slash-commands','--system-prompt',SYSTEM_PROMPT,'--tools',tool,'--allowedTools',tool,'--output-format','json','--json-schema',JSON.stringify(schema),prompt];
}

/** A bare `claude` is looked up on PATH; Set up may store an absolute path instead. */
export async function resolveClaude(connection,env=process.env){
  const command=connection.execution.command??'claude';
  const candidates=path.isAbsolute(command)?[command]:(env.PATH||'').split(path.delimiter).filter(p=>path.isAbsolute(p)).map(p=>path.join(p,command));
  for(const file of candidates){try{await fs.access(file,constants.X_OK);if((await fs.stat(file)).isFile())return file;}catch{}}
  fail('CLAUDE_UNAVAILABLE');
}

function execute(command,args,{spawn,cwd,env,timeoutMs,signal}){
  if(signal?.aborted)return Promise.reject(new TrackerError('REQUEST_CANCELLED'));
  return new Promise((resolve,reject)=>{
    let child,done=false,size=0,stderrBytes=0;const stdout=[];
    const kill=()=>{if(!child)return;if(child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');return;}catch{}}try{child.kill('SIGKILL');}catch{}};
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(error)kill();child?.stdout?.destroy();child?.stderr?.destroy();error?reject(error):resolve(value);};
    const cancel=()=>finish(new TrackerError('REQUEST_CANCELLED'));
    const timer=setTimeout(()=>finish(new TrackerError('REQUEST_TIMEOUT')),timeoutMs);signal?.addEventListener('abort',cancel,{once:true});
    try{child=spawn(command,args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});}catch(error){finish(new TrackerError(error?.code==='ENOENT'?'CLAUDE_UNAVAILABLE':'CLAUDE_FAILED'));return;}
    child.on('error',error=>finish(new TrackerError(error?.code==='ENOENT'?'CLAUDE_UNAVAILABLE':'CLAUDE_FAILED')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>MAX_STDOUT)finish(new TrackerError('RESPONSE_TOO_LARGE'));else stdout.push(chunk);});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>MAX_STDERR)finish(new TrackerError('RESPONSE_TOO_LARGE'));});
    child.on('close',code=>{
      if(done)return;let value;
      try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)));}catch{finish(new TrackerError(code===0?'INVALID_RESPONSE':'CLAUDE_FAILED'));return;}
      finish(null,value);
    });
  });
}

/** The run result is trusted only for its status fields; the model's object is validated by callers. */
export function claudeOutput(value){
  if(!object(value))fail('INVALID_RESPONSE');
  if(value.terminal_reason==='budget_exhausted'||value.subtype==='error_max_budget_usd')fail('BUDGET_EXHAUSTED');
  if(value.is_error!==false||value.subtype!=='success')fail('CLAUDE_FAILED');
  const out=value.structured_output;if(!object(out))fail('INVALID_RESPONSE');
  if(out.status==='sign_in_required')fail('SHORTCUT_SIGN_IN_REQUIRED');
  if(out.status!=='ok')fail('INVALID_RESPONSE');
  return out;
}

async function runClaude(connection,run,options){
  const {env=process.env,spawn=nodeSpawn,signal,timeoutMs=MAX_TIMEOUT_MS,workRoot=os.tmpdir()}=options;
  if(typeof spawn!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_TIMEOUT_MS||!path.isAbsolute(workRoot))fail('INVALID_REQUEST');
  const command=await resolveClaude(connection,env),childEnv=Object.fromEntries(ENV_KEYS.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));
  const cwd=await fs.mkdtemp(path.join(workRoot,'mc-shortcut-claude-'));
  try{return claudeOutput(await execute(command,claudeArgs(run),{spawn,cwd,env:childEnv,timeoutMs,signal}));}
  finally{await fs.rm(cwd,{recursive:true,force:true});}
}
function request(input,operation){
  const r=validateTrackerRequest(input,{connectionValidator:validateShortcutConnection,source:'shortcut'});
  if(r.operation!==operation||r.cursor!==undefined&&r.cursor!==null)fail('INVALID_REQUEST');return r;
}

/** Setup captures the signed-in member and workspace once; it never changes saved configuration. */
export async function probeShortcutClaude(input,options={}){
  const r=request(input,'probe'),out=await runClaude(r.connection,{tool:WHOAMI_TOOL,schema:WHOAMI_SCHEMA,prompt:WHOAMI_PROMPT},options);
  if(!exact(out,['status','mention_name','workspace_slug'])||!OWNER.test(out.mention_name)||!WORKSPACE.test(out.workspace_slug))fail('INVALID_RESPONSE');
  return {site:SHORTCUT_SITE,owner:out.mention_name,workspace:out.workspace_slug};
}

function storyRow(story,{connection,binding,scope,workspace}){
  if(!exact(story,STORY_FIELDS)||!Number.isSafeInteger(story.id)||story.id<1||!text(story.name,512)||!text(story.state,200)||!GROUPS.includes(story.group)||story.app_url!==SHORTCUT_SITE+'/'+workspace+'/story/'+story.id||story.updated_at!==null&&typeof story.updated_at!=='string')fail('INVALID_RESPONSE');
  const id=String(story.id),row={identity:{kind:'shortcut',connectionId:connection.id,site:SHORTCUT_SITE,id},key:'sc-'+id,title:story.name,url:story.app_url,body:'',statusGroup:story.group,statusName:story.state,repoBinding:binding};
  if(story.updated_at!==null){const time=Date.parse(story.updated_at);if(!Number.isFinite(time)||time<0)fail('INVALID_RESPONSE');row.updatedAt=time;}
  try{return validateIssue(row,{scope});}catch{fail('INVALID_RESPONSE');}
}

/** One run reads both columns; counts that disagree with Shortcut's totals are reported as incomplete. */
export async function fetchShortcutClaude(input,options={}){
  const r=request(input,'issues'),clock=options.clock??(()=>Date.now());if(typeof clock!=='function')fail('INVALID_REQUEST');
  const scope=trackerScope('shortcut',r.connection,r.binding),selection=scope.selection;
  const out=await runClaude(r.connection,{tool:SEARCH_TOOL,schema:STORIES_SCHEMA,prompt:storiesPrompt(shortcutQueries(selection))},options);
  if(!exact(out,['status','stories','started_total','unstarted_total'])||!Array.isArray(out.stories)||!count(out.started_total)||!count(out.unstarted_total))fail('INVALID_RESPONSE');
  const context={connection:r.connection,binding:r.binding,scope,workspace:selection.workspace},ids=new Set(),counts={todo:0,inProgress:0},rows=[];
  for(const story of out.stories){const row=storyRow(story,context);if(ids.has(row.identity.id))fail('INVALID_RESPONSE');ids.add(row.identity.id);counts[row.statusGroup]++;rows.push(row);}
  const incomplete=counts.inProgress!==out.started_total||counts.todo!==out.unstarted_total||rows.length>MAX_STORIES;
  const error=incomplete?{code:'INCOMPLETE_RESULTS',message:new TrackerError('INCOMPLETE_RESULTS').message}:undefined;
  return validateSnapshot({data:rows.slice(0,MAX_STORIES),fetchedAt:clock(),scope,truncated:incomplete,...(error?{error}:{})},scope,{now:clock()});
}
