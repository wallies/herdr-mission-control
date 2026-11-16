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


/**
 * GitHub search does not find a cloud session's pull request by the session link in its body
 * (checked on a real PR: every in:body form returned nothing). So the lookup reads each
 * repository's most recently updated pull requests and matches the link in their bodies; once a
 * session's pull request is known, later lookups read that pull request directly.
 */
export const SCAN_FIRST=20,SCANS_PER_CALL=3;
const PULL_FIELDS='number url state isDraft updatedAt reviewDecision statusCheckRollup { state } repository { nameWithOwner }';
/** `scans` are repositories (owner/name) to scan; `reads` are {repo, number} pull requests to read. */
export function pullsDocument(scans,reads){
  const vars=[...scans.flatMap((_,i)=>[`$o${i}: String!`,`$n${i}: String!`]),...reads.flatMap((_,i)=>[`$po${i}: String!`,`$pn${i}: String!`,`$pk${i}: Int!`])].join(', ');
  const fields=[...scans.map((_,i)=>`r${i}: repository(owner: $o${i}, name: $n${i}) { pullRequests(first: ${SCAN_FIRST}, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PULL_FIELDS} body } } }`),
    ...reads.map((_,i)=>`p${i}: repository(owner: $po${i}, name: $pn${i}) { pullRequest(number: $pk${i}) { ${PULL_FIELDS} } }`)].join('\n  ');
  return `query MissionControlCloudPulls(${vars}) {\n  ${fields}\n}`;
}
export function pullsVariables(scans,reads){
  const variables={};
  scans.forEach((repo,i)=>{const [o,n]=repo.split('/');variables['o'+i]=o;variables['n'+i]=n;});
  reads.forEach((r,i)=>{const [o,n]=r.repo.split('/');variables['po'+i]=o;variables['pn'+i]=n;variables['pk'+i]=r.number;});
  return variables;
}
/** True when a pull request body carries this session's claude.ai/code link, in either id form. */
export function bodyLinks(body,id){
  const tail=id.slice('session_'.length),re=new RegExp('claude\\.ai/code/(?:session|cse)_'+tail+'(?![A-Za-z0-9])');
  return typeof body==='string'&&re.test(body);
}
const REVIEW={APPROVED:'approved',CHANGES_REQUESTED:'changesRequested',REVIEW_REQUIRED:'reviewRequired'};
const CHECKS={SUCCESS:'success',FAILURE:'failure',ERROR:'failure',PENDING:'pending',EXPECTED:'pending'};

/** One pull request node, checked against the repository it was read from. The body is never kept. */
export function parsePull(node,repo){
  if(!object(node)||!Number.isSafeInteger(node.number)||node.number<1||typeof node.url!=='string'||!object(node.repository)||typeof node.repository.nameWithOwner!=='string')fail('INVALID_RESPONSE');
  if(node.repository.nameWithOwner.toLowerCase()!==repo.toLowerCase())return null;
  if(node.url.toLowerCase()!==('https://github.com/'+repo+'/pull/'+node.number).toLowerCase())fail('INVALID_RESPONSE');
  const state=node.state==='MERGED'?'merged':node.state==='CLOSED'?'closed':node.state==='OPEN'?'open':fail('INVALID_RESPONSE');
  return {pr:{number:node.number,url:'https://github.com/'+node.repository.nameWithOwner+'/pull/'+node.number,state,draft:node.isDraft===true,checks:CHECKS[node.statusCheckRollup?.state]??null,review:REVIEW[node.reviewDecision]??null},updated:Date.parse(node.updatedAt)||0};
}
/** Among pull requests whose body links the session: an open one wins over closed ones; then the one updated last. */
export function choosePull(nodes,repo,id){
  const found=nodes.filter(node=>object(node)&&bodyLinks(node.body,id)).map(node=>parsePull(node,repo)).filter(Boolean);
  found.sort((a,b)=>(b.pr.state==='open')-(a.pr.state==='open')||b.updated-a.updated);
  return found[0]?.pr??null;
}

function lookupSessions(input){
  if(!Array.isArray(input.sessions)||!input.sessions.length||input.sessions.length>MAX_LOOKUPS)fail('INVALID_REQUEST');
  try{
    return input.sessions.map(s=>{
      if(!object(s)||Object.keys(s).length!==3||!Object.hasOwn(s,'number'))throw Error('shape');
      const {id}=parseSessionRef(s.id);if(id!==s.id||githubRepo(s.repo)!==s.repo)throw Error('identity');
      if(s.number!==null&&(!Number.isSafeInteger(s.number)||s.number<1))throw Error('number');
      return {id,repo:s.repo,number:s.number};
    });
  }catch{fail('INVALID_REQUEST');}
}
function checkData(data){if(!object(data)||data.errors!==undefined&&(!Array.isArray(data.errors)||data.errors.length)||!object(data.data))fail('INVALID_RESPONSE');return data.data;}

/** Known pull requests are read directly; the rest scan their repository once per repository, three repositories per call. */
export async function findPulls(input,{request=requestJson,env=process.env,ghCommand,clock=()=>Date.now(),timeoutMs=25000}={}){
  const sessions=lookupSessions(input);
  let connection;try{connection=validateGithubConnection(input.connection);}catch{fail('INVALID_REQUEST');}
  if(connection.site!=='https://github.com')fail('NOT_GITHUB_COM');
  const auth=await resolveGithubAuth(connection,{env,ghCommand,timeoutMs:Math.min(8000,timeoutMs)});
  const call=async(scans,reads)=>checkData(await request(auth.graphqlUrl,{allowedOrigin:auth.allowedOrigin,headers:auth.headers,method:'POST',body:{query:pullsDocument(scans,reads),variables:pullsVariables(scans,reads)},maxRedirects:0,timeoutMs,maxBytes:1048576}));
  const reads=sessions.filter(s=>s.number!==null),scanning=sessions.filter(s=>s.number===null);
  const byRepo=new Map();for(const s of scanning)if(!byRepo.has(s.repo.toLowerCase()))byRepo.set(s.repo.toLowerCase(),s.repo);const repos=[...byRepo.values()],found={};
  for(let start=0;start<Math.max(repos.length,reads.length?1:0);start+=SCANS_PER_CALL){
    const scans=repos.slice(start,start+SCANS_PER_CALL),direct=start===0?reads:[],data=await call(scans,direct);
    direct.forEach((s,i)=>{const node=data['p'+i]?.pullRequest;if(node===undefined)fail('INVALID_RESPONSE');found[s.id]=node===null?null:parsePull(node,s.repo)?.pr??null;});
    scans.forEach((repo,i)=>{
      const nodes=data['r'+i]===null?[]:data['r'+i]?.pullRequests?.nodes;if(!Array.isArray(nodes))fail('INVALID_RESPONSE');
      for(const s of scanning.filter(s=>s.repo.toLowerCase()===repo.toLowerCase()))found[s.id]=choosePull(nodes,s.repo,s.id);
    });
  }
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
