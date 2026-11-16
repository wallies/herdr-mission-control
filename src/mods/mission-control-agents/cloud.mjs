import {spawn as nodeSpawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {TrackerError,requestJson,publicTrackerError} from '../../shared/tracker-transport.mjs';
import {validateGithubConnection,resolveGithubAuth} from '../../shared/github-auth.mjs';
import {parseSessionRef,githubRepo,messageArgs,validMessage} from '../../shared/cloud-sessions.js';

/**
 * The Agents rail's Node helper for cloud sessions: one follow-up message through Claude Code, or
 * one pull request lookup through the Reviews gh connection. Never creates a cloud session.
 */
export class CloudError extends Error{constructor(code){super(MESSAGES[code]||MESSAGES.REQUEST_FAILED);this.name='CloudError';this.code=Object.hasOwn(MESSAGES,code)?code:'REQUEST_FAILED';}}
export const MESSAGES=Object.freeze({
  INVALID_REQUEST:'The cloud session request was invalid.',
  CLAUDE_UNAVAILABLE:'Claude Code (the claude command) was not found on PATH or in ~/.local/bin.',
  NOT_SIGNED_IN:'Claude Code is not signed in with a claude.ai account. Run claude auth login in a terminal, then try again.',
  CLOUD_DISABLED:'Cloud sessions are disabled for this Claude account or organization.',
  SESSION_NOT_FOUND:'Claude Code could not find this cloud session. Check its link.',
  SESSION_ARCHIVED:'This cloud session is archived and cannot take new messages.',
  SEND_FAILED:'Claude Code could not send the message. Run the same command in a terminal to see why.',
  REQUEST_TIMEOUT:'Claude Code took longer than a minute and was stopped.',
  RESPONSE_TOO_LARGE:'The reply was larger than expected.',
  INVALID_RESPONSE:'The reply did not check out. Try again.',
  NOT_GITHUB_COM:'Cloud session pull requests are looked up on github.com; the Reviews connection points elsewhere.',
  REQUEST_FAILED:'The cloud session request failed. Try again.'
});
const fail=code=>{throw new CloudError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const MAX_OUTPUT=65536,MESSAGE_TIMEOUT_MS=60000,MAX_LOOKUPS=20;
const ENV_KEYS=['HOME','PATH','USER','LANG','CLAUDE_CONFIG_DIR'];

/** `claude` on PATH, then ~/.local/bin where the installer puts it (the app's PATH may lack it). */
export async function resolveClaude(env=process.env){
  const dirs=(env.PATH||'').split(path.delimiter).filter(dir=>path.isAbsolute(dir));
  if(typeof env.HOME==='string'&&path.isAbsolute(env.HOME))dirs.push(path.join(env.HOME,'.local/bin'));
  for(const dir of dirs){const file=path.join(dir,'claude');try{await fs.access(file,constants.X_OK);if((await fs.stat(file)).isFile())return file;}catch{/* Not here; try the next folder. */}}
  fail('CLAUDE_UNAVAILABLE');
}

/** argv only (no shell), stdin closed, bounded output and a hard deadline. */
export function execute(command,args,{spawn=nodeSpawn,env,timeoutMs}){
  return new Promise((resolve,reject)=>{
    let child,done=false,bytes=0;const out=[],err=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){try{child?.kill('SIGKILL');}catch{/* Already gone. */}reject(error);}else resolve(value);};
    const timer=setTimeout(()=>finish(new CloudError('REQUEST_TIMEOUT')),timeoutMs);
    try{child=spawn(command,args,{env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){finish(new CloudError(error?.code==='ENOENT'?'CLAUDE_UNAVAILABLE':'SEND_FAILED'));return;}
    child.on('error',error=>finish(new CloudError(error?.code==='ENOENT'?'CLAUDE_UNAVAILABLE':'SEND_FAILED')));
    const collect=(chunks,chunk)=>{bytes+=chunk.length;if(bytes>MAX_OUTPUT)finish(new CloudError('RESPONSE_TOO_LARGE'));else chunks.push(chunk);};
    child.stdout.on('data',chunk=>collect(out,chunk));child.stderr.on('data',chunk=>collect(err,chunk));
    child.on('close',code=>finish(null,{code,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8')}));
  });
}

/** Claude Code's own words, mapped to a fixed message; its text is never passed on. */
export function sendFailure(text){
  if(/claude auth login|claude\.ai sign-in|organization UUID|\/login/i.test(text))return 'NOT_SIGNED_IN';
  if(/disabled by your organization|aren't available|not enabled for your account/i.test(text))return 'CLOUD_DISABLED';
  if(/archived/i.test(text))return 'SESSION_ARCHIVED';
  if(/session not found/i.test(text))return 'SESSION_NOT_FOUND';
  return 'SEND_FAILED';
}

/** `claude -p <message> --cloud <id> --output-format json` queues one message and exits. */
export async function sendMessage(input,{spawn,env=process.env,timeoutMs=MESSAGE_TIMEOUT_MS}={}){
  let id,message;try{({id}=parseSessionRef(input.session));message=validMessage(input.message);}catch{fail('INVALID_REQUEST');}
  if(input.session!==id)fail('INVALID_REQUEST');
  const command=await resolveClaude(env),childEnv=Object.fromEntries(ENV_KEYS.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));
  const result=await execute(command,messageArgs(id,message),{spawn,env:childEnv,timeoutMs});
  let reply=null;try{reply=JSON.parse(result.stdout.trim());}catch{/* Configuration errors print to stderr without JSON. */}
  if(object(reply)&&reply.ok===true&&result.code===0){
    if(reply.session_id!==id||typeof reply.url!=='string'||!reply.url.startsWith('https://claude.ai/code/'+id))fail('INVALID_RESPONSE');
    return {session:id};
  }
  fail(sendFailure((object(reply)&&typeof reply.error==='string'?reply.error:'')+'\n'+result.stderr));
}

/** GitHub search: a cloud session's pull request carries the session link in its description. */
export const pullQuery=(id,repo)=>`is:pr in:body ${id} repo:${repo}`;
const PULL_FIELDS='... on PullRequest { number url state isDraft updatedAt reviewDecision statusCheckRollup { state } repository { nameWithOwner } }';
export function pullsDocument(count){
  const vars=Array.from({length:count},(_,i)=>`$q${i}: String!`).join(', ');
  const fields=Array.from({length:count},(_,i)=>`s${i}: search(query: $q${i}, type: ISSUE, first: 10) { nodes { ${PULL_FIELDS} } }`).join('\n  ');
  return `query MissionControlCloudPulls(${vars}) {\n  ${fields}\n}`;
}
const REVIEW={APPROVED:'approved',CHANGES_REQUESTED:'changesRequested',REVIEW_REQUIRED:'reviewRequired'};
const CHECKS={SUCCESS:'success',FAILURE:'failure',ERROR:'failure',PENDING:'pending',EXPECTED:'pending'};

/** One search hit, checked against the repository it was asked about. */
export function parsePull(node,repo){
  if(!object(node)||!Number.isSafeInteger(node.number)||node.number<1||typeof node.url!=='string'||!object(node.repository)||typeof node.repository.nameWithOwner!=='string')fail('INVALID_RESPONSE');
  if(node.repository.nameWithOwner.toLowerCase()!==repo.toLowerCase())return null;
  if(node.url.toLowerCase()!==('https://github.com/'+repo+'/pull/'+node.number).toLowerCase())fail('INVALID_RESPONSE');
  const state=node.state==='MERGED'?'merged':node.state==='CLOSED'?'closed':node.state==='OPEN'?'open':fail('INVALID_RESPONSE');
  return {pr:{number:node.number,url:'https://github.com/'+node.repository.nameWithOwner+'/pull/'+node.number,state,draft:node.isDraft===true,checks:CHECKS[node.statusCheckRollup?.state]??null,review:REVIEW[node.reviewDecision]??null},updated:Date.parse(node.updatedAt)||0};
}
/** An open pull request wins over closed ones; among equals, the one updated last. */
export function choosePull(nodes,repo){
  const found=nodes.filter(node=>object(node)&&Object.keys(node).length).map(node=>parsePull(node,repo)).filter(Boolean);
  found.sort((a,b)=>(b.pr.state==='open')-(a.pr.state==='open')||b.updated-a.updated);
  return found[0]?.pr??null;
}

export async function findPulls(input,{request=requestJson,env=process.env,ghCommand,clock=()=>Date.now(),timeoutMs=25000}={}){
  if(!Array.isArray(input.sessions)||!input.sessions.length||input.sessions.length>MAX_LOOKUPS)fail('INVALID_REQUEST');
  let sessions;try{sessions=input.sessions.map(s=>{if(!object(s)||Object.keys(s).length!==2)throw Error();const {id}=parseSessionRef(s.id);if(id!==s.id||githubRepo(s.repo)!==s.repo)throw Error();return {id,repo:s.repo};});}catch{fail('INVALID_REQUEST');}
  let connection;try{connection=validateGithubConnection(input.connection);}catch{fail('INVALID_REQUEST');}
  if(connection.site!=='https://github.com')fail('NOT_GITHUB_COM');
  const auth=await resolveGithubAuth(connection,{env,ghCommand,timeoutMs:Math.min(8000,timeoutMs)});
  const variables=Object.fromEntries(sessions.map((s,i)=>['q'+i,pullQuery(s.id,s.repo)]));
  const data=await request(auth.graphqlUrl,{allowedOrigin:auth.allowedOrigin,headers:auth.headers,method:'POST',body:{query:pullsDocument(sessions.length),variables},maxRedirects:0,timeoutMs,maxBytes:1048576});
  if(!object(data)||data.errors!==undefined&&(!Array.isArray(data.errors)||data.errors.length)||!object(data.data))fail('INVALID_RESPONSE');
  const found={};
  sessions.forEach((s,i)=>{const nodes=data.data['s'+i]?.nodes;if(!Array.isArray(nodes))fail('INVALID_RESPONSE');found[s.id]=choosePull(nodes,s.repo);});
  return {checkedAt:clock(),found};
}

/** One operation per run; the reply never carries Claude Code's or GitHub's own text. */
export async function dispatchCloud(input,options={}){
  try{
    if(!object(input)||input.v!==1)fail('INVALID_REQUEST');
    if(input.operation==='message')return {v:1,ok:true,operation:'message',...await sendMessage(input,options)};
    if(input.operation==='pulls')return {v:1,ok:true,operation:'pulls',...await findPulls(input,options)};
    fail('INVALID_REQUEST');
  }catch(error){
    if(error instanceof CloudError)return {v:1,ok:false,error:{code:error.code,message:error.message}};
    const pub=publicTrackerError(error instanceof TrackerError?error:new TrackerError('REQUEST_FAILED'));
    return {v:1,ok:false,error:{code:pub.code,message:pub.message}};
  }
}
