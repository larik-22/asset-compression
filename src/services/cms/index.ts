import appConfig from '@/config.js';
import { CmsClient } from './types.js';
import { WebflowCmsClient } from './webflow.js';

export function getCmsClient(): CmsClient {
  const provider = appConfig.cmsProvider;
  switch (provider) {
    case 'webflow':
      return new WebflowCmsClient(appConfig.webflow.collectionId);
    default:
      throw new Error(`Unsupported CMS_PROVIDER: ${provider}`);
  }
}


