import { compressImageSmart } from './utils/image.js';
import { promises as fs } from 'node:fs';
import { logger } from './utils/logger.js';
import { getCmsClient } from './services/cms/index.js';

async function processImageField(
  item: any,
  imageFieldName: string,
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
    await fs.writeFile(`public/${item.id}-${imageFieldName}-original.jpg`, originalBuffer);

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

    await fs.writeFile(`public/${item.id}-${imageFieldName}-compressed.avif`, compressedBuffer);

    logger.success(`Compressed image written for item ${item.id}`);
  } catch (error) {
    logger.error(`Failed to process image for item ${item.id}`, error);
  }
}

async function main(): Promise<void> {
  logger.info('Starting image compression flow test');

  try {
    const cms = getCmsClient();

    // Use specific item IDs that we know have images
    const targetItemIds = [
      '685eab65aa5563bffb4f8fc9', // "Explore the top things to do in Testaccio, Rome"
      '685eab6548ab3a68015c1c9a', // "The best neighborhoods in Rome, from Trastevere to Testaccio"
      '685eab6403fcee3fd17e683f', // "Rome in fall: 8 best attractions and activities"
    ];

    logger.info(`Looking for ${targetItemIds.length} specific items with images`);

    // Fetch all items and find our targets
    const allItems: any[] = await cms.fetchAllItems();
    const foundItems: any[] = targetItemIds
      .map((id) => allItems.find((i) => i.id === id))
      .filter(Boolean);

    if (foundItems.length === 0) {
      logger.warn('No target items found with images');
      return;
    }

    logger.info(`Found ${foundItems.length} items to process`);

    for (const [index, item] of foundItems.entries()) {
      logger.step(index + 1, foundItems.length, `Processing item ${item.id}`);

      try {
        // Log item structure for debugging
        logger.info('Item structure', {
          id: item.id,
          name: item.fieldData?.name,
          hasImage: !!item.fieldData?.image,
          imageUrl: (item.fieldData?.image as any)?.url || item.fieldData?.image,
          imageObject: item
        });

        // Process the 'image' field
        const imageField = item.fieldData?.image as any;
        const imageUrl = typeof imageField === 'string' ? imageField : imageField?.url;

        if (imageUrl) {
          await processImageField(item, 'image', imageUrl);
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
