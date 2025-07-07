import { getEnvCollectionItems } from './services/webflowClient.js';
import { compressImage } from './utils/image.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { logger } from './utils/logger.js';
import { withRateLimitRetry } from './utils/retry.js';

config();

const CONCURRENCY = 8;

async function fetchAllLiveItems() {
  const all: any[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const resp = await withRateLimitRetry(() => getEnvCollectionItems({ limit, offset }));
    const items = resp.items ?? [];
    all.push(...items);
    logger.info(`Fetched batch: offset=${offset}, count=${items.length}`);
    if (items.length < limit) break; // no more items
    offset += limit;
  }
  return all;
}

async function processItem(item: any) {
  logger.info('Processing item', { id: item.id, slug: item.fieldData?.slug });
  // Placeholder for real processing logic; compression example:
  // const imageUrl = item.fieldData?.heroImage;
  // if (imageUrl) {
  //   const res = await fetch(imageUrl);
  //   const buffer = Buffer.from(await res.arrayBuffer());
  //   const minified = await compressImage(buffer);
  //   await fs.writeFile(`output/${item.id}.jpg`, minified);
  // }
}

async function processItems(items: any[]) {
  let index = 0;
  const total = items.length;

  async function worker(workerId: number) {
    while (true) {
      const current = index++;
      if (current >= total) return;
      const item = items[current];
      logger.step(current + 1, total, `Worker ${workerId}`);
      await withRateLimitRetry(() => processItem(item));
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map((_, i) => worker(i + 1)));
}

async function main(): Promise<void> {
  logger.info('Starting Webflow CMS processing');
  try {
    const items = await fetchAllLiveItems();
    if (items.length === 0) {
      logger.warn('Collection is empty');
      return;
    }
    logger.success(`Total items to process: ${items.length}`);

    await processItems(items);

    logger.success('Processing finished');
  } catch (err) {
    logger.error('Processing failed', err);
    throw err;
  }
}

main().catch((err) => {
  logger.error('Main process failed', err);
  process.exit(1);
}); 

