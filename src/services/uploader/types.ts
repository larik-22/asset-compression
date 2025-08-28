export interface UploadResult {
  url: string;
  key: string;
}

export interface UploaderClient {
  upload(buffer: Buffer, fileName: string, contentType?: string): Promise<UploadResult>;
  delete(key: string): Promise<void>;
}


