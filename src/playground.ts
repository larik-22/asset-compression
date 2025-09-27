import { runImageOptimizationPipeline } from '@/core/pipeline.js';
import { StatsTracker } from '@/core/stats.js';
import { logger } from '@utils/logger.js';
import { getCmsClient } from '@services/cms/index.js';
import { getUploaderClient } from '@services/uploader/index.js';
import appConfig from '@/config.js';
import { WebflowClient, Webflow } from 'webflow-api';

function validateEnvironmentVars() {
  return { imageFieldNames: appConfig.imageFieldNames };
}

async function main(): Promise<void> {
  try {
    const { imageFieldNames } = validateEnvironmentVars();
    logger.info('Environment validated successfully');
    const cms = new WebflowClient({accessToken: appConfig.webflow.token});
    const items = await cms.collections.get(appConfig.webflow.collectionId);
    console.log(items);
  } catch (err) {
    logger.error('Processing pipeline failed', err);
    throw err;
  }
}

main().catch((err) => {
  logger.error('Main process failed', err);
  process.exit(1);
}); 

