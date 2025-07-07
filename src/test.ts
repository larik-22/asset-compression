import { getEnvCollectionItems } from './services/webflowClient.js';
import { compressImage } from './utils/image.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { logger } from './utils/logger.js';
import { withRateLimitRetry } from './utils/retry.js';

async function main(): Promise<void> {
    // compress image from public/test_prod.avif 
    const image = await fs.readFile(path.join(process.cwd(), 'public', 'test_prod.avif'));
    const compressedImage = await compressImage(image);
    await fs.writeFile(path.join(process.cwd(), 'public', 'test_prod_compressed.avif'), compressedImage);

    // compare the size of the compressed image to the original image in KB
    const originalSize = image.length / 1024;
    const compressedSize = compressedImage.length / 1024;
    console.log(`Original size: ${originalSize} KB`);
    console.log(`Compressed size: ${compressedSize} KB`);
    console.log(`Compression ratio: ${originalSize / compressedSize}`);
}
  
  main().catch((err) => {
    logger.error('Main process failed', err);
    process.exit(1);
  }); 
  