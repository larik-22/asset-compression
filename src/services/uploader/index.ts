import appConfig from '@/config.js';
import type { UploaderClient } from './types.js';
import { UploadThingClient } from './uploadthing.js';

export function getUploaderClient(): UploaderClient {
  const provider = appConfig.uploaderProvider;
  switch (provider) {
    case 'uploadthing':
      return new UploadThingClient();
    default:
      throw new Error(`Unsupported UPLOADER_PROVIDER: ${provider}`);
  }
}


