import {canonicalRepoPath,updateConfig} from '../../shared/config.js';
import {readReviewPreferences,remoteRepository} from './model.js';

/**
 * Where a pull request's repository is checked out on the reviewing machine. Never clones:
 * a Mission Control repo binding, then ~/workspace/<owner>/<repo> when its origin is that
 * repository, then the folder the person gave before, else ask.
 */
export class CheckoutError extends Error {constructor(code,message){super(message);this.name='CheckoutError';this.code=code;}}
const fail=(code,message)=>{throw new CheckoutError(code,message);};
const lower=value=>value.toLowerCase();
const repoName=review=>lower(review.identity.owner)+'/'+lower(review.identity.repo);
const hostOf=site=>{try{return new URL(site).host.toLowerCase();}catch{return null;}};

/** The folder is the top of a Git checkout whose origin is `repo` on `host`. Returns its canonical path. */
export async function verifyCheckout(folder,{repo,host,machine=null,exec}){
  let path;try{path=canonicalRepoPath(typeof folder==='string'?folder.trim():folder);}catch{fail('INVALID_PATH','Enter the absolute path of the repository folder.');}
  const git=async args=>{try{return await exec('git',['-C',path,...args],{on:machine});}catch{return {code:1,stdout:''};}};
  const top=await git(['rev-parse','--path-format=absolute','--show-toplevel']);
  if(top.code!==0)fail('NOT_A_CHECKOUT',`${path} is not a Git checkout.`);
  let root;try{root=canonicalRepoPath(top.stdout.trim());}catch{fail('NOT_A_CHECKOUT',`${path} is not a Git checkout.`);}
  if(root!==path)fail('NOT_CHECKOUT_TOP',`Choose the top folder of the checkout (${root}), not a folder inside it.`);
  const origin=await git(['remote','get-url','origin']);
  if(origin.code!==0)fail('NO_ORIGIN',`${path} has no origin remote.`);
  const found=remoteRepository(origin.stdout.trim(),host);
  if(found!==repo)fail('ORIGIN_MISMATCH',`The origin of ${path} is ${found?found+' on '+host:'another repository'}, not ${repo}.`);
  return path;
}

function boundCheckout(config,review,machine,host){
  for(const binding of Object.values(config.bindings||{})){
    const github=binding.github;if(binding.machine!==machine||!github)continue;
    if(lower(github.owner)+'/'+lower(github.repo)!==repoName(review))continue;
    if(hostOf(config.connections?.[github.connectionId]?.site)===host)return binding.repoRoot;
  }
  return null;
}

/** {state:'found', path, via} or {state:'ask', reason}. `home` is the reviewing machine's home folder. */
export async function resolveCheckout({config,review,machine=null,exec,home}){
  const repo=repoName(review),host=hostOf(review.identity.site),bound=boundCheckout(config,review,machine,host);
  if(bound)return {state:'found',path:bound,via:'binding'};
  const reasons=[];
  if(typeof home==='string'&&home.startsWith('/')){
    const folder=home.replace(/\/+$/,'')+'/workspace/'+lower(review.identity.owner)+'/'+review.identity.repo;
    try{return {state:'found',path:await verifyCheckout(folder,{repo,host,machine,exec}),via:'workspace'};}
    catch(error){if(error.code!=='NOT_A_CHECKOUT')reasons.push(error.message);}
  }
  const saved=readReviewPreferences(config).checkouts.find(c=>c.machine===machine&&c.repo===repo);
  if(saved){
    try{return {state:'found',path:await verifyCheckout(saved.path,{repo,host,machine,exec}),via:'saved'};}
    catch(error){reasons.push('The saved folder no longer fits: '+error.message);}
  }
  return {state:'ask',reason:reasons.join(' ')};
}

export async function saveCheckout(io,{machine=null,repo,path}){
  return updateConfig(io,draft=>{
    const prefs=readReviewPreferences(draft);
    prefs.checkouts=[...prefs.checkouts.filter(c=>!(c.machine===machine&&c.repo===repo)),{machine,repo,path}].slice(-200);
    draft.preferences.reviews=prefs;
  });
}

/** Saves the gh connection (an existing profile must be identical) and chooses it for the queue. */
export async function saveReviewsConnection(io,connection){
  return updateConfig(io,draft=>{
    const existing=draft.connections[connection.id];
    if(existing&&JSON.stringify(existing)!==JSON.stringify(connection))fail('CONNECTION_CONFLICT','This profile ID is already used by another connection. Choose another profile ID.');
    draft.connections[connection.id]=connection;
    draft.preferences.reviews={...readReviewPreferences(draft),connectionId:connection.id};
  });
}
