import { getEnvCollectionItems, updateAndPublishItem } from './services/webflowClient.js';
import { compressImageSmart } from './utils/image.js';
import { uploadToUploadThing } from './utils/upload.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { logger } from './utils/logger.js';
import { withRateLimitRetry } from './utils/retry.js';

config();

const CONCURRENCY = 6; // Reduced for stability
const COMPRESSION_OPTIONS = {
  targetRatio: 0.5,
  quality: 95,
  minQuality: 80,
  minSSIM: 0.98,
  maxDimension: 1000,
};

interface ProcessingStats {
  totalItems: number;
  processedItems: number;
  skippedItems: number;
  successfulCompressions: number;
  failedCompressions: number;
  totalSizeReduction: number;
  totalOriginalSize: number;
  totalCompressedSize: number;
}

const stats: ProcessingStats = {
  totalItems: 0,
  processedItems: 0,
  skippedItems: 0,
  successfulCompressions: 0,
  failedCompressions: 0,
  totalSizeReduction: 0,
  totalOriginalSize: 0,
  totalCompressedSize: 0,
};

async function fetchAllLiveItems() {
  const all: any[] = [];
  let offset = 0;
  const limit = 100;
  
  logger.info('Starting to fetch all CMS items from collection');
  
  while (true) {
    try {
      const resp = await withRateLimitRetry(() => getEnvCollectionItems({ limit, offset }));
      const items = resp.items ?? [];
      all.push(...items);
      logger.info(`Fetched batch: offset=${offset}, count=${items.length}, total=${all.length}`);
      
      if (items.length < limit) break; // no more items
      offset += limit;
    } catch (error) {
      logger.error(`Failed to fetch batch at offset ${offset}`, error);
      throw error;
    }
  }
  
  logger.success(`Successfully fetched ${all.length} total items from collection`);
  return all;
}

async function processImageField(
  item: any,
  imageFieldName: string,
  collectionId: string,
  imageUrl: string,
): Promise<boolean> {
  logger.info(`Processing image for item ${item.id}`, { 
    imageUrl, 
    field: imageFieldName,
    itemName: item.fieldData?.name 
  });

  try {
    // 1. Download the original image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    
    const originalBuffer = Buffer.from(await response.arrayBuffer());
    const originalSize = originalBuffer.length;
    
    if (originalSize === 0) {
      throw new Error('Downloaded image has zero bytes');
    }

    logger.info(`Downloaded image: ${Math.round(originalSize / 1024)} KB`);

    // 2. Compress the image
    const compressedBuffer = await compressImageSmart(originalBuffer, COMPRESSION_OPTIONS);
    const compressedSize = compressedBuffer.length;
    const compressionRatio = originalSize / compressedSize;

    // Update stats
    stats.totalOriginalSize += originalSize;
    stats.totalCompressedSize += compressedSize;
    stats.totalSizeReduction += (originalSize - compressedSize);

    logger.info(`Image compressed successfully`, {
      originalSize: Math.round(originalSize / 1024),
      compressedSize: Math.round(compressedSize / 1024),
      compressionRatio: Math.round(compressionRatio * 100) / 100,
      sizeReduction: `${Math.round(((originalSize - compressedSize) / originalSize) * 100)}%`
    });

    // 3. Upload to UploadThing
    const filename = `${item.id}-${imageFieldName}-optimized.avif`;
    const uploadResult = await uploadToUploadThing(compressedBuffer, filename);
    logger.success(`Uploaded to UploadThing`, { url: uploadResult.url, key: uploadResult.key });

    // 4. Update CMS item with new URL
    await withRateLimitRetry(() =>
      updateAndPublishItem(collectionId, item.id, {
        [imageFieldName]: uploadResult.url,
      }),
    );

    logger.success(`Updated CMS item ${item.id} with compressed image`);
    stats.successfulCompressions++;
    return true;

  } catch (error) {
    logger.error(`Failed to process image for item ${item.id}`, error);
    stats.failedCompressions++;
    return false;
  }
}

async function processItem(item: any, collectionId: string): Promise<void> {
  const itemId = item.id;
  const itemName = item.fieldData?.name || 'Unnamed Item';
  
  logger.info(`Processing item: ${itemId}`, { 
    name: itemName,
    slug: item.fieldData?.slug 
  });

  try {
    // Check for image field
    const imageField = item.fieldData?.image;
    
    if (!imageField) {
      logger.info(`Skipping item ${itemId} - no image field found`);
      stats.skippedItems++;
      return;
    }

    // Handle different image field formats
    let imageUrl: string | null = null;
    
    if (typeof imageField === 'string') {
      imageUrl = imageField;
    } else if (typeof imageField === 'object' && imageField?.url) {
      imageUrl = imageField.url;
    }

    if (!imageUrl || imageUrl.trim() === '') {
      logger.info(`Skipping item ${itemId} - image field is empty`);
      stats.skippedItems++;
      return;
    }

    // Validate URL format
    try {
      new URL(imageUrl);
    } catch {
      logger.warn(`Skipping item ${itemId} - invalid image URL: ${imageUrl}`);
      stats.skippedItems++;
      return;
    }

    // Process the image
    const success = await processImageField(item, 'image', collectionId, imageUrl);
    
    if (success) {
      logger.success(`Successfully processed item ${itemId}`);
    } else {
      logger.error(`Failed to process item ${itemId}`);
    }

  } catch (error) {
    logger.error(`Unexpected error processing item ${itemId}`, error);
    stats.failedCompressions++;
  } finally {
    stats.processedItems++;
  }
}

async function processItems(items: any[], collectionId: string) {
  let index = 0;
  const total = items.length;
  stats.totalItems = total;

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
        await withRateLimitRetry(() => processItem(item, collectionId));
        processed++;
      } catch (error) {
        logger.error(`Worker ${workerId} failed on item ${item.id}`, error);
      }

      // Log progress every 10 items
      if ((current + 1) % 10 === 0) {
        logger.info(`Progress: ${progress} completed`);
      }
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map((_, i) => worker(i + 1)));
}

function logFinalStats(): void {
  const avgCompressionRatio = stats.totalOriginalSize > 0 
    ? stats.totalOriginalSize / stats.totalCompressedSize 
    : 0;
    
  const totalSizeReductionMB = stats.totalSizeReduction / (1024 * 1024);
  const totalOriginalSizeMB = stats.totalOriginalSize / (1024 * 1024);
  const totalCompressedSizeMB = stats.totalCompressedSize / (1024 * 1024);

  logger.success('=== FINAL PROCESSING STATISTICS ===');
  logger.info('Item Processing:', {
    totalItems: stats.totalItems,
    processedItems: stats.processedItems,
    skippedItems: stats.skippedItems,
    successfulCompressions: stats.successfulCompressions,
    failedCompressions: stats.failedCompressions,
    successRate: `${Math.round((stats.successfulCompressions / Math.max(stats.processedItems - stats.skippedItems, 1)) * 100)}%`
  });
  
  logger.info('Size Reduction:', {
    originalSize: `${Math.round(totalOriginalSizeMB * 100) / 100} MB`,
    compressedSize: `${Math.round(totalCompressedSizeMB * 100) / 100} MB`,
    totalSaved: `${Math.round(totalSizeReductionMB * 100) / 100} MB`,
    avgCompressionRatio: `${Math.round(avgCompressionRatio * 100) / 100}×`,
    overallReduction: `${Math.round((stats.totalSizeReduction / Math.max(stats.totalOriginalSize, 1)) * 100)}%`
  });
}

async function main(): Promise<void> {
  logger.info('Starting Webflow CMS image compression pipeline');
  
  try {
    const collectionId = process.env.WEBFLOW_COLLECTION_ID;
    if (!collectionId) {
      throw new Error('WEBFLOW_COLLECTION_ID environment variable is required');
    }

    // Validate required environment variables
    if (!process.env.UPLOADTHING_TOKEN) {
      throw new Error('UPLOADTHING_TOKEN environment variable is required');
    }

    if (!process.env.WEBFLOW_TOKEN) {
      throw new Error('WEBFLOW_TOKEN environment variable is required');
    }

    logger.info('Environment validated successfully');

    const items = await fetchAllLiveItems();
    
    if (items.length === 0) {
      logger.warn('Collection is empty - nothing to process');
      return;
    }

    logger.success(`Ready to process ${items.length} items with image compression`);
    
    // Filter items that likely have images for better progress estimates
    const itemsWithPotentialImages = items.filter(item => 
      item.fieldData?.image && 
      item.fieldData.image !== '' && 
      item.fieldData.image !== null
    );
    
    logger.info(`Found ${itemsWithPotentialImages.length} items with potential images to process`);

    await processItems(items, collectionId);

    logFinalStats();
    logger.success('Image compression pipeline completed successfully! 🎉');

  } catch (err) {
    logger.error('Processing pipeline failed', err);
    logFinalStats(); // Log stats even on failure
    throw err;
  }
}

main().catch((err) => {
  logger.error('Main process failed', err);
  process.exit(1);
}); 

