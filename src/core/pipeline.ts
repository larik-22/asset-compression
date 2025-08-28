import { compressImageSmart } from '@utils/image.js';
import { logger } from '@utils/logger.js';
import { withRateLimitRetry } from '@utils/retry.js';
import appConfig from '@/config.js';
import type { CmsClient } from '@services/cms/types.js';
import type { UploaderClient } from '@services/uploader/types.js';
import { StatsTracker } from './stats.js';
import { getPropertyByPath } from '@utils/object.js';

const CONCURRENCY = appConfig.concurrency;
const COMPRESSION_OPTIONS = appConfig.compression;

export async function fetchAllItems(cms: CmsClient) {
  logger.info('Starting to fetch all CMS items from collection');
  const items = await cms.fetchAllItems();
  logger.success(`Successfully fetched ${items.length} total items from collection`);
  return items as any[];
}

export function filterItemsWithImages(items: any[], imageFieldNames: string[]): any[] {
  return items.filter((item) => {
    return imageFieldNames.some((fieldName) => {
      const field = getPropertyByPath(item, `fieldData.${fieldName}`);
      return field !== undefined && field !== '' && field !== null;
    });
  });
}

export function getImageUrlFromField(field: any): string | null {
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field?.url) return field.url;
  return null;
}

export async function processImageField(
  item: any,
  imageFieldName: string,
  imageUrl: string,
  cms: CmsClient,
  uploader: UploaderClient,
  stats: StatsTracker,
): Promise<boolean> {
  logger.info(`Processing image for item ${item.id}`, {
    imageUrl,
    field: imageFieldName,
    itemName: item.fieldData?.name,
  });

  let originalBuffer: Buffer;
  let compressedBuffer: Buffer;
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    originalBuffer = Buffer.from(await response.arrayBuffer());
    if (originalBuffer.length === 0) throw new Error('Downloaded image has zero bytes');
    logger.info(`Downloaded image: ${Math.round(originalBuffer.length / 1024)} KB`);
  } catch (error) {
    logger.error(`Download failed for item ${item.id}`, error);
    stats.incrementDownloadFailure();
    return false;
  }

  try {
    compressedBuffer = await compressImageSmart(originalBuffer, COMPRESSION_OPTIONS);
    const originalSize = originalBuffer.length;
    const compressedSize = compressedBuffer.length;
    const compressionRatio = originalSize / compressedSize;
    stats.recordSizes(originalSize, compressedSize);
    logger.info(`Image compressed successfully`, {
      originalSize: Math.round(originalSize / 1024),
      compressedSize: Math.round(compressedSize / 1024),
      compressionRatio: Math.round(compressionRatio * 100) / 100,
      sizeReduction: `${Math.round(((originalSize - compressedSize) / originalSize) * 100)}%`,
    });
  } catch (error) {
    logger.error(`Compression failed for item ${item.id}`, error);
    stats.incrementCompressionFailure();
    return false;
  }

  try {
    const filename = `${item.id}-${imageFieldName}-optimized.avif`;
    const uploadResult = await uploader.upload(compressedBuffer, filename, 'image/avif');
    logger.success(`Uploaded image`, { url: uploadResult.url, key: uploadResult.key });
    await cms.updateItemImage(item.id, imageFieldName, uploadResult.url);
    logger.success(`Updated CMS item ${item.id} with compressed image`);
    stats.incrementSuccess();
    return true;
  } catch (error) {
    logger.error(`Upload or CMS update failed for item ${item.id}`, error);
    stats.incrementUploadFailure();
    return false;
  }
}

export async function processItem(
  item: any,
  imageFieldNames: string[],
  cms: CmsClient,
  uploader: UploaderClient,
  stats: StatsTracker,
): Promise<void> {
  const itemId = item.id;
  const itemName = (getPropertyByPath<string>(item, appConfig.itemNameFieldPath) || 'Unnamed Item');

  logger.info(`Processing item: ${itemId}`, {
    name: itemName,
    slug: item.fieldData?.slug,
  });

  try {
    let anyProcessed = false;
    for (const imageFieldName of imageFieldNames) {
      const imageField = getPropertyByPath(item, `fieldData.${imageFieldName}`);
      if (!imageField) {
        continue;
      }
      const imageUrl = getImageUrlFromField(imageField);
      if (!imageUrl || imageUrl.trim() === '') {
        continue;
      }
      try {
        new URL(imageUrl);
      } catch {
        logger.warn(`Skipping field ${imageFieldName} for item ${itemId} - invalid URL: ${imageUrl}`);
        continue;
      }
      const success = await processImageField(item, imageFieldName, imageUrl, cms, uploader, stats);
      anyProcessed = anyProcessed || success;
    }
    if (!anyProcessed) {
      logger.info(`No valid image fields found for item ${itemId}`);
      stats.incrementSkipped();
    } else {
      logger.success(`Finished processing applicable image fields for item ${itemId}`);
    }
  } catch (error) {
    logger.error(`Unexpected error processing item ${itemId}`, error);
    stats.incrementFailure();
  } finally {
    stats.incrementProcessed();
  }
}

export async function processItems(
  items: any[],
  imageFieldNames: string[],
  cms: CmsClient,
  uploader: UploaderClient,
  stats: StatsTracker,
) {
  let index = 0;
  const total = items.length;
  stats.setTotalItems(total);

  logger.info(`Starting parallel processing with ${CONCURRENCY} workers`);

  async function worker(workerId: number) {
    let processed = 0;
    while (true) {
      const current = index++;
      if (current >= total) {
        logger.info(`Worker ${workerId} finished after processing ${processed} items`);
        return;
      }

      const item = items[current];
      const progress = `${current + 1}/${total}`;
      logger.step(current + 1, total, `Worker ${workerId} processing item ${item.id}`);
      try {
        await withRateLimitRetry(() => processItem(item, imageFieldNames, cms, uploader, stats));
        processed += 1;
      } catch (error) {
        logger.error(`Worker ${workerId} failed on item ${item.id}`, error);
      }
      if ((current + 1) % 10 === 0) {
        logger.info(`Progress: ${progress} completed`);
      }
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map((_, i) => worker(i + 1)));
}

export async function runImageOptimizationPipeline(
  imageFieldNames: string[],
  cms: CmsClient,
  uploader: UploaderClient,
  stats: StatsTracker,
) {
  logger.info('Starting Webflow CMS image compression pipeline');
  const items = await fetchAllItems(cms);
  if (items.length === 0) {
    logger.warn('Collection is empty - nothing to process');
    return;
  }
  logger.success(`Ready to process ${items.length} items with image compression`);
  const itemsWithPotentialImages = filterItemsWithImages(items, imageFieldNames);
  logger.info(`Found ${itemsWithPotentialImages.length} items with potential images to process`);
  await processItems(items, imageFieldNames, cms, uploader, stats);
  stats.logFinal();
  logger.success('Image compression pipeline completed successfully!');
}


