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

/**
 * Fetches all live items from the Webflow CMS collection using pagination.
 * @returns {Promise<any[]>} Array of all CMS items.
 */
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

/**
 * Processes a single image field for a CMS item: downloads, compresses, uploads, and updates the CMS item.
 * @param item - The CMS item object.
 * @param imageFieldName - The name of the image field to process.
 * @param collectionId - The Webflow collection ID.
 * @param imageUrl - The URL of the image to process.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
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

/**
 * Filters items that have a non-empty, non-null image field.
 * @param items - Array of CMS items.
 * @param imageFieldName - The name of the image field to check.
 * @returns {any[]} Filtered array of items with images.
 */
function filterItemsWithImages(items: any[], imageFieldName: string): any[] {
  return items.filter(item => {
    const field = item.fieldData?.[imageFieldName];
    return field !== undefined && field !== '' && field !== null;
  });
}

/**
 * Extracts the image URL from a field value, supporting both string and object with url property.
 * @param field - The image field value (string or object).
 * @returns {string | null} The image URL, or null if not found.
 */
function getImageUrlFromField(field: any): string | null {
  if (typeof field === 'string') {
    return field;
  } else if (typeof field === 'object' && field?.url) {
    return field.url;
  }
  return null;
}

/**
 * Processes a single CMS item: checks for the image field, validates, and processes the image if present.
 * @param item - The CMS item object.
 * @param collectionId - The Webflow collection ID.
 * @param imageFieldName - The name of the image field to process.
 */
async function processItem(item: any, collectionId: string, imageFieldName: string): Promise<void> {
  const itemId = item.id;
  const itemName = item.fieldData?.name || 'Unnamed Item';
  
  logger.info(`Processing item: ${itemId}`, { 
    name: itemName,
    slug: item.fieldData?.slug 
  });

  try {
    // Check for image field
    const imageField = item.fieldData?.[imageFieldName];
    
    if (!imageField) {
      logger.info(`Skipping item ${itemId} - no image field found`);
      stats.skippedItems++;
      return;
    }

    // Extract image URL
    const imageUrl = getImageUrlFromField(imageField);

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
    const success = await processImageField(item, imageFieldName, collectionId, imageUrl);
    
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

/**
 * Processes all CMS items in parallel using a worker pool.
 * @param items - Array of CMS items to process.
 * @param collectionId - The Webflow collection ID.
 * @param imageFieldName - The name of the image field to process.
 */
async function processItems(items: any[], collectionId: string, imageFieldName: string) {
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
        await withRateLimitRetry(() => processItem(item, collectionId, imageFieldName));
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

/**
 * Logs final statistics about the image processing pipeline.
 */
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

/**
 * Runs the image optimization pipeline for a given collection and image field.
 * @param collectionId - The Webflow collection ID.
 * @param imageFieldName - The name of the image field to process.
 */
async function runImageOptimizationPipeline(collectionId: string, imageFieldName: string) {
  logger.info('Starting Webflow CMS image compression pipeline');

  const items = await fetchAllLiveItems();

  if (items.length === 0) {
    logger.warn('Collection is empty - nothing to process');
    return;
  }

  logger.success(`Ready to process ${items.length} items with image compression`);

  // Use helper for filtering
  const itemsWithPotentialImages = filterItemsWithImages(items, imageFieldName);

  logger.info(`Found ${itemsWithPotentialImages.length} items with potential images to process`);

  await processItems(items, collectionId, imageFieldName);

  logFinalStats();
  logger.success('Image compression pipeline completed successfully!');
}

/**
 * Validates required environment variables and returns config values.
 * @returns {{ collectionId: string, imageFieldName: string }}
 * @throws Error if any required environment variable is missing.
 */
function validateEnvironmentVars() {
  const collectionId = process.env.WEBFLOW_COLLECTION_ID;
  if (!collectionId) {
    throw new Error('WEBFLOW_COLLECTION_ID environment variable is required');
  }
  if (!process.env.UPLOADTHING_TOKEN) {
    throw new Error('UPLOADTHING_TOKEN environment variable is required');
  }
  if (!process.env.WEBFLOW_TOKEN) {
    throw new Error('WEBFLOW_TOKEN environment variable is required');
  }
  const imageFieldName = process.env.IMAGE_FIELD_NAME || 'image';
  return { collectionId, imageFieldName };
}

/**
 * Main entry point. Validates environment and runs the image optimization pipeline.
 */
async function main(): Promise<void> {
  try {
    const { collectionId, imageFieldName } = validateEnvironmentVars();
    logger.info('Environment validated successfully');
    await runImageOptimizationPipeline(collectionId, imageFieldName);
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

