import {trackerOrigin} from './tracker-model.js';

/** The REST API base for a GitHub site: github.com, Enterprise Cloud (*.ghe.com) or Enterprise Server. */
export function githubApiBase(site){
  const origin=trackerOrigin(site),host=origin.slice(8);if(host==='github.com')return 'https://api.github.com';if(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(host))return 'https://api.'+host;return origin+'/api/v3';
}
