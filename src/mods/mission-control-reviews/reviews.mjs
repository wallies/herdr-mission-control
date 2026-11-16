import {TrackerError,httpsUrl,requestJson} from '../../shared/tracker-transport.mjs';
import {validateGithubConnection,resolveGithubAuth} from '../../shared/github-auth.mjs';
import {validateReview,reviewKey,sortReviews} from './model.js';

/**
 * GitHub search (https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests):
 * review-requested matches you directly or through a team; user-review-requested only directly.
 * Team requests are the first set minus the second. Both skip archived repositories.
 */
export const QUERIES=Object.freeze({
  all:'is:pr is:open archived:false review-requested:@me',
  direct:'is:pr is:open archived:false user-review-requested:@me'
});
export const PAGE_SIZE=100,MAX_PAGES=3;
const DETAIL_QUERY=`query MissionControlReviewDetails($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ... on PullRequest { id reviewDecision statusCheckRollup { state } } }
}`;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const fail=code=>{throw new TrackerError(code);};
const REVIEW={APPROVED:'approved',CHANGES_REQUESTED:'changesRequested',REVIEW_REQUIRED:'reviewRequired'};
const CHECKS={SUCCESS:'success',FAILURE:'failure',ERROR:'failure',PENDING:'pending',EXPECTED:'pending'};

function context(options){
  const {request=requestJson,env=process.env,ca,signal,timeoutMs=25000,clock=()=>Date.now(),ghCommand}=options;
  if(typeof request!=='function'||typeof clock!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('INVALID_REQUEST');
  const deadline=Date.now()+timeoutMs,controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const remaining=()=>{const left=deadline-Date.now();if(left<=0)fail('REQUEST_TIMEOUT');return Math.min(left,30000);};
  return {clock,cancel:()=>controller.abort(),
    auth:connection=>resolveGithubAuth(connection,{env,ghCommand,signal:combined,timeoutMs:Math.min(8000,remaining())}),
    async call(auth,url,body){
      if(httpsUrl(url).origin!==auth.allowedOrigin)fail('UNTRUSTED_ORIGIN');
      try{return await request(url,{allowedOrigin:auth.allowedOrigin,headers:auth.headers,method:body?'POST':'GET',...(body?{body}:{}),maxRedirects:0,timeoutMs:remaining(),maxBytes:4194304,ca,signal:combined});}
      catch(error){if(error instanceof TrackerError&&error.status===403&&error.retryAfterMs!==undefined)throw new TrackerError('RATE_LIMITED',{status:403,retryAfterMs:error.retryAfterMs});throw error;}
    }};
}

/** One search result, checked against the connection's own API and web origins. */
export function parseSearchItem(raw,connection,section){
  if(!object(raw)||!object(raw.pull_request)||!Number.isSafeInteger(raw.number)||raw.number<1||!text(raw.title,512)||!text(raw.node_id,200)||typeof raw.repository_url!=='string')fail('INVALID_RESPONSE');
  const prefix=connection.apiBase+'/repos/';if(!raw.repository_url.startsWith(prefix))fail('INVALID_RESPONSE');
  const parts=raw.repository_url.slice(prefix.length).split('/');if(parts.length!==2)fail('INVALID_RESPONSE');
  const [owner,repo]=parts,url=connection.site+'/'+owner+'/'+repo+'/pull/'+raw.number;
  if(raw.html_url!==url||raw.draft!==undefined&&typeof raw.draft!=='boolean')fail('INVALID_RESPONSE');
  const updated=typeof raw.updated_at==='string'?Date.parse(raw.updated_at):NaN;if(!Number.isFinite(updated))fail('INVALID_RESPONSE');
  let author;if(raw.user===null)author={login:null,url:null};else{if(!object(raw.user))fail('INVALID_RESPONSE');author={login:raw.user.login,url:raw.user.html_url};}
  try{return {nodeId:raw.node_id,review:validateReview({identity:{kind:'github-pr',connectionId:connection.id,site:connection.site,owner,repo,number:raw.number},key:'GH-PR-'+raw.number,url,title:raw.title,author,draft:raw.draft===true,section,waitingSince:updated,review:null,checks:null})};}
  catch{fail('INVALID_RESPONSE');}
}

/** Pages of one search, oldest update first, bounded to MAX_PAGES. */
async function search(auth,query,section,ctx){
  const rows=new Map();let truncated=false,incomplete=false,total=null;
  for(let page=1;page<=MAX_PAGES;page++){
    const url=new URL(auth.connection.apiBase+'/search/issues');for(const [key,value] of Object.entries({q:query,sort:'updated',order:'asc',per_page:PAGE_SIZE,page}))url.searchParams.set(key,String(value));
    const data=await ctx.call(auth,url.href);
    if(!object(data)||!Number.isSafeInteger(data.total_count)||data.total_count<0||typeof data.incomplete_results!=='boolean'||!Array.isArray(data.items)||data.items.length>PAGE_SIZE)fail('INVALID_RESPONSE');
    incomplete||=data.incomplete_results;total=data.total_count;
    for(const raw of data.items){const parsed=parseSearchItem(raw,auth.connection,section),key=reviewKey(parsed.review);const old=rows.get(key);if(old&&old.nodeId!==parsed.nodeId)fail('INVALID_RESPONSE');rows.set(key,parsed);}
    if(data.items.length<PAGE_SIZE||rows.size>=total)break;
    if(page===MAX_PAGES)truncated=true;
  }
  return {rows,truncated,incomplete};
}

/** Review decision and check rollup in one GraphQL call per 100 PRs. Optional: a failure leaves them out and says so. */
async function details(auth,rows,ctx){
  const byNode=new Map(rows.map(row=>[row.nodeId,row])),ids=[...byNode.keys()];
  for(let start=0;start<ids.length;start+=100){
    const data=await ctx.call(auth,auth.graphqlUrl,{query:DETAIL_QUERY,variables:{ids:ids.slice(start,start+100)}});
    if(!object(data)||data.errors!==undefined&&(!Array.isArray(data.errors)||data.errors.length)||!Array.isArray(data.data?.nodes))fail('INCOMPLETE_RESULTS');
    for(const node of data.data.nodes){
      if(node===null)continue;const row=object(node)&&node.__typename==='PullRequest'?byNode.get(node.id):null;if(!row)fail('INVALID_RESPONSE');
      row.review.review=REVIEW[node.reviewDecision]??null;row.review.checks=CHECKS[node.statusCheckRollup?.state]??null;
    }
  }
}

/** Reads the whole queue: both searches, the split and the sort. Nothing is written to GitHub. */
export async function fetchReviewQueue(input,options={}){
  if(!object(input)||input.v!==1||!['reviews','probe'].includes(input.operation))fail('INVALID_REQUEST');
  const connection=validateGithubConnection(input.connection);if(!connection.gh&&!connection.credentialEnv)fail('INVALID_CONNECTION');
  const ctx=context(options);
  try{
    const auth=await ctx.auth(connection);
    if(input.operation==='probe'){const user=await ctx.call(auth,connection.apiBase+'/user');if(!object(user)||typeof user.login!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(user.login))fail('INVALID_RESPONSE');return {login:user.login};}
    const all=await search(auth,QUERIES.all,'team',ctx),direct=await search(auth,QUERIES.direct,'direct',ctx);
    for(const [key,row]of direct.rows)all.rows.set(key,row);
    const rows=[...all.rows.values()];let detailsUnavailable=false;
    try{await details(auth,rows,ctx);}catch(error){if(['REQUEST_CANCELLED','REQUEST_TIMEOUT'].includes(error?.code))throw error;detailsUnavailable=true;for(const row of rows){row.review.review=null;row.review.checks=null;}}
    const reviews=rows.map(row=>row.review);
    return {fetchedAt:ctx.clock(),direct:sortReviews(reviews.filter(r=>r.section==='direct')),team:sortReviews(reviews.filter(r=>r.section==='team')),truncated:all.truncated||direct.truncated,incomplete:all.incomplete||direct.incomplete,detailsUnavailable};
  }finally{ctx.cancel();}
}
