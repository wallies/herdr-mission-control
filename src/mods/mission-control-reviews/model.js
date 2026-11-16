/**
 * Review queue model, shared by the Node reader and the native view. Pure: no Node, DOM or GPUI.
 * A review is an open pull request whose review was asked of you (`direct`) or of one of your
 * teams (`team`), anywhere the selected gh account can see.
 */
export class ReviewModelError extends Error {
  constructor(code,message='The review queue returned an invalid pull request. Refresh to try again.'){super(message);this.name='ReviewModelError';this.code=code;}
}
const fail=(code,message)=>{throw new ReviewModelError(code,message);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const name=value=>text(value,100)&&/^[A-Za-z0-9_.-]+$/.test(value)&&!['.','..'].includes(value);
const lower=value=>value.toLowerCase();
const copy=value=>JSON.parse(JSON.stringify(value));

export const SECTIONS=Object.freeze([['direct','Asked of you'],['team','Asked of your teams']]);
const REVIEW_STATES=['approved','changesRequested','reviewRequired'],CHECK_STATES=['success','failure','pending'];
export const CONNECTION_ID=/^[a-z][a-z0-9-]{0,95}$/;
/** The launcher's cap on a source task; the review task is checked against it before it is sent. */
export const TASK_MAX=4000;

export function validateReview(value){
  if(!exact(value,['identity','key','url','title','author','draft','section','waitingSince','review','checks']))fail('INVALID_REVIEW');
  const i=value.identity;
  if(!exact(i,['kind','connectionId','site','owner','repo','number'])||i.kind!=='github-pr'||typeof i.connectionId!=='string'||!CONNECTION_ID.test(i.connectionId)||typeof i.site!=='string'||!/^https:\/\/[^\s/@?#]+$/.test(i.site)||!name(i.owner)||!name(i.repo)||!Number.isSafeInteger(i.number)||i.number<1)fail('INVALID_REVIEW');
  if(value.key!=='GH-PR-'+i.number||value.url!==i.site+'/'+i.owner+'/'+i.repo+'/pull/'+i.number||!text(value.title,512)||typeof value.draft!=='boolean')fail('INVALID_REVIEW');
  const a=value.author;
  if(!exact(a,['login','url'])||(a.login===null?a.url!==null:!name(a.login)||a.url!==i.site+'/'+a.login))fail('INVALID_REVIEW');
  if(!SECTIONS.some(([key])=>key===value.section)||!Number.isSafeInteger(value.waitingSince)||value.waitingSince<0)fail('INVALID_REVIEW');
  if(value.review!==null&&!REVIEW_STATES.includes(value.review)||value.checks!==null&&!CHECK_STATES.includes(value.checks))fail('INVALID_REVIEW');
  return copy(value);
}
/** `owner/repo#n` in lower case: one pull request, whichever section lists it. */
export function reviewKey(value){const i=value.identity;return lower(i.owner)+'/'+lower(i.repo)+'#'+i.number;}
export const reviewLabel=value=>value.identity.owner+'/'+value.identity.repo+'#'+value.identity.number;
/** Oldest first. The search reports no request time, so the PR's last update stands in for it. */
export function sortReviews(list){return [...list].sort((a,b)=>a.waitingSince-b.waitingSince||(reviewKey(a)<reviewKey(b)?-1:reviewKey(a)>reviewKey(b)?1:0));}

/**
 * The exact task: the skill by name in plain words, never a slash command. The skill reads the
 * pull request itself, so its title and body never enter the task. Instructions may span lines.
 */
export function reviewTask(url,instructions=''){
  if(typeof url!=='string'||!/^https:\/\/[^\s@]+$/.test(url))fail('INVALID_REVIEW');
  if(typeof instructions!=='string')fail('INVALID_INSTRUCTIONS','Instructions must be text.');
  const lead=`Use the review-this skill on ${url}.`,extra=instructions.replace(/\r\n?/g,'\n').trim();
  if(!extra)return lead;
  if(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(extra))fail('INVALID_INSTRUCTIONS','Instructions can use new lines, but no tabs or other control characters.');
  const task=lead+' '+extra;
  if(task.length>TASK_MAX)fail('INSTRUCTIONS_TOO_LONG',`Instructions are too long: the whole task is capped at ${TASK_MAX} characters (${task.length} now).`);
  return task;
}
/** The shared launcher's GitHub pull request source, with the exact task. Same identity as the PR board's. */
export function reviewLaunchSource(value,instructions=''){
  const review=validateReview(value),i=review.identity;
  return {kind:'github-pr',connectionId:i.connectionId,site:i.site,id:reviewKey(review),key:review.key,title:('Review pull request: '+review.title).slice(0,512),url:review.url,task:reviewTask(review.url,instructions)};
}
/** The new worktree's name: one per repository, pull request and tool, so two repositories never share a folder. */
export const reviewWorktreeName=(value,toolKey)=>'review-'+value.identity.repo+'-'+value.identity.number+'-'+toolKey;

export function waitingText(since,now){
  const minutes=Math.max(0,Math.floor((now-since)/60000));
  if(minutes<60)return minutes+'m';const hours=Math.floor(minutes/60);if(hours<48)return hours+'h';return Math.floor(hours/24)+'d';
}

/** `owner/repo` (lower case) when a Git remote URL points at that host, else null. */
export function remoteRepository(url,host){
  if(typeof url!=='string'||typeof host!=='string')return null;const h=host.toLowerCase().replace(/[.$^*+?()[\]{}|\\/]/g,'\\$&');
  const patterns=[new RegExp('^https://(?:[^@/]+@)?'+h+'/([^/]+)/([^/]+?)(?:\\.git)?/?$','i'),new RegExp('^ssh://(?:[^@/]+@)?'+h+'(?::\\d+)?/([^/]+)/([^/]+?)(?:\\.git)?/?$','i'),new RegExp('^(?:[^@/:]+@)?'+h+':([^/]+)/([^/]+?)(?:\\.git)?/?$','i')];
  for(const pattern of patterns){const match=url.trim().match(pattern);if(match&&name(match[1])&&name(match[2]))return lower(match[1]+'/'+match[2]);}
  return null;
}

/** preferences.reviews: the chosen connection and the folders people gave for repositories. */
export function readReviewPreferences(config){
  const raw=config?.preferences?.reviews;if(!object(raw)||raw.v!==1)return {v:1,connectionId:null,checkouts:[]};
  const connectionId=typeof raw.connectionId==='string'&&CONNECTION_ID.test(raw.connectionId)?raw.connectionId:null;
  const checkouts=Array.isArray(raw.checkouts)?raw.checkouts.filter(c=>exact(c,['machine','repo','path'])&&(c.machine===null||text(c.machine,128))&&typeof c.repo==='string'&&/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(c.repo)&&text(c.path,4096)&&c.path.startsWith('/')).slice(0,200):[];
  return {v:1,connectionId,checkouts:copy(checkouts)};
}
