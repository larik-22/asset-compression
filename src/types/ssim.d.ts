declare module 'ssim.js' {
  export interface ImageDataLike {
    data: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
  }

  export interface SSIMOptions {
    bitDepth?: number;
  }

  export interface SSIMResult {
    ssim: number;
  }

  export function ssim(img1: ImageDataLike, img2: ImageDataLike, options?: SSIMOptions): SSIMResult;
} 