import { UTApi } from 'uploadthing/server';
import appConfig from '@/config.js';
import type { UploaderClient, UploadResult } from './types.js';

export class UploadThingClient implements UploaderClient {
  private readonly utapi: UTApi;

  constructor() {
    this.utapi = new UTApi({ token: appConfig.uploadthing.token });
  }

  async upload(buffer: Buffer, fileName: string, contentType = 'image/avif'): Promise<UploadResult> {
    const uint8 = Uint8Array.from(buffer);
    const file = new File([uint8], fileName, { type: contentType });
    const response = await this.utapi.uploadFiles(file);

    if (response.error) {
      throw new Error(`UploadThing upload failed: ${response.error.message}`);
    }
    if (!response.data) {
      throw new Error('UploadThing returned no data');
    }

    return { url: response.data.url, key: response.data.key };
  }
}


