import { getEnvCollectionItems, updateAndPublishItem } from './services/webflowClient.js';
import { compressImageSmart } from './utils/image.js';
import { uploadToUploadThing } from './utils/upload.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { logger } from './utils/logger.js';
import { withRateLimitRetry } from './utils/retry.js';

config();

async function processImageField(
  item: any,
  imageFieldName: string,
  collectionId: string,
  imageUrl: string,
): Promise<void> {
  logger.info(`Processing image for item ${item.id}`, { imageUrl, field: imageFieldName });

  try {
    // 1. Download the original image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    const originalBuffer = Buffer.from(await response.arrayBuffer());
    const originalSize = originalBuffer.length;

    // save original image
    fs.writeFile(`public/${item.id}-${imageFieldName}-original.jpg`, originalBuffer);

    // 2. Compress the image
    const compressedBuffer = await compressImageSmart(originalBuffer, {
      targetRatio: 0.5,
      quality: 95,
      minQuality: 80,
      minSSIM: 0.98,
      maxDimension: 1000,
    });

    const compressionRatio = originalSize / compressedBuffer.length;
    logger.info(`Image compressed`, {
      originalSize: Math.round(originalSize / 1024),
      compressedSize: Math.round(compressedBuffer.length / 1024),
      compressionRatio: Math.round(compressionRatio * 100) / 100,
    });

    fs.writeFile(`public/${item.id}-${imageFieldName}-compressed.avif`, compressedBuffer);

    // 3. Upload to UploadThing
    // const filename = `${item.id}-${imageFieldName}-compressed.avif`;
    // const uploadResult = await uploadToUploadThing(compressedBuffer, filename);
    // logger.success(`Uploaded to UploadThing`, { url: uploadResult.url });

    // // 4. Update CMS item with new URL
    // await withRateLimitRetry(() =>
    //   updateAndPublishItem(collectionId, item.id, {
    //     [imageFieldName]: uploadResult.url,
    //   }),
    // );

    logger.success(`Updated CMS item ${item.id} with compressed image`);
  } catch (error) {
    logger.error(`Failed to process image for item ${item.id}`, error);
  }
}

async function main(): Promise<void> {
  logger.info('Starting image compression flow test');

  try {
    const collectionId = process.env.WEBFLOW_COLLECTION_ID;
    if (!collectionId) {
      throw new Error('WEBFLOW_COLLECTION_ID environment variable is required');
    }

    // Use specific item IDs that we know have images
    const targetItemIds = [
      '685eab65aa5563bffb4f8fc9', // "Explore the top things to do in Testaccio, Rome"
      '685eab6548ab3a68015c1c9a', // "The best neighborhoods in Rome, from Trastevere to Testaccio"
      '685eab6403fcee3fd17e683f', // "Rome in fall: 8 best attractions and activities"
    ];

    logger.info(`Looking for ${targetItemIds.length} specific items with images`);

    // Fetch items in batches to find our target items
    const foundItems: any[] = [];
    let offset = 0;
    const limit = 100;
    
    while (foundItems.length < targetItemIds.length && offset < 300) {
      const response = await withRateLimitRetry(() => 
        getEnvCollectionItems({ limit, offset })
      );
      
      const items = response.items || [];
      
      // Find any target items in this batch
      for (const itemId of targetItemIds) {
        const item = items.find(i => i.id === itemId);
        if (item && !foundItems.find(f => f.id === itemId)) {
          foundItems.push(item);
          logger.info(`Found target item: ${itemId} - ${item.fieldData?.name}`);
        }
      }
      
      if (items.length < limit) break; // No more items
      offset += limit;
    }

    if (foundItems.length === 0) {
      logger.warn('No target items found with images');
      return;
    }

    logger.info(`Found ${foundItems.length} items to process`);

    for (const item of foundItems) {
      logger.step(foundItems.indexOf(item) + 1, foundItems.length, `Processing item ${item.id}`);
      
      try {
        // Log item structure for debugging
        logger.info('Item structure', {
          id: item.id,
          name: item.fieldData?.name,
          hasImage: !!item.fieldData?.image,
          imageUrl: item.fieldData?.image?.url || item.fieldData?.image,
        });

        // Process the 'image' field
        const imageField = item.fieldData?.image;
        const imageUrl = typeof imageField === 'string' ? imageField : imageField?.url;
        
        if (imageUrl) {
          await processImageField(item, 'image', collectionId, imageUrl);
        } else {
          logger.warn(`No image URL found for item ${item.id}`);
        }
      } catch (error) {
        logger.error(`Failed to process item ${item.id}`, error);
      }
    }

    logger.success('Image compression flow test completed');
  } catch (error) {
    logger.error('Test failed', error);
    throw error;
  }
}

main().catch((err) => {
  logger.error('Main process failed', err);
  process.exit(1);
}); 
  