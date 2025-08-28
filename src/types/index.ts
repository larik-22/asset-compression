export interface ProcessingStats {
  totalItems: number;
  processedItems: number;
  skippedItems: number;
  successfulCompressions: number;
  failedCompressions: number;
  downloadFailures?: number;
  compressionFailures?: number;
  uploadFailures?: number;
  totalSizeReduction: number;
  totalOriginalSize: number;
  totalCompressedSize: number;
}

export interface CompressionOptions {
  /** target quality (0-100). Default 50 gives visually lossless results for AVIF. */
  quality?: number;
  /** If true the original image will be returned when compression fails or results larger */
  fallbackToOriginal?: boolean;
}

export interface AdaptiveCompressionOptions extends CompressionOptions {
  /** desired max percentage of original size (e.g. 0.7 → 30% smaller). Default 0.7 */
  targetRatio?: number;
  /** minimum quality we're willing to go down to. Default 25 */
  minQuality?: number;
}
