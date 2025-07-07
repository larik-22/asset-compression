import { UTApi } from 'uploadthing/server';
import { config } from 'dotenv';

config();

const utapi = new UTApi({
  token: process.env.UPLOADTHING_TOKEN,
});

/**
 * Upload a buffer to UploadThing using the official UTApi
 */
export async function uploadToUploadThing(
  buffer: Buffer,
  filename: string,
  contentType = 'image/avif',
): Promise<{ url: string; key: string }> {
  if (!process.env.UPLOADTHING_TOKEN) {
    throw new Error('UPLOADTHING_TOKEN environment variable is required');
  }

  // Convert buffer to File for UTApi
  const blob = new Blob([buffer], { type: contentType });
  const file = new File([blob], filename, { type: contentType });

  // Upload using UTApi
  const response = await utapi.uploadFiles(file);

  if (response.error) {
    throw new Error(`UploadThing upload failed: ${response.error.message}`);
  }

  if (!response.data) {
    throw new Error('UploadThing returned no data');
  }

  return {
    url: response.data.url,
    key: response.data.key,
  };
} 