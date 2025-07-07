import sharp from 'sharp';

export interface CompressionOptions {
  /** target quality (0-100). Default 50 gives visually lossless results for AVIF. */
  quality?: number;
  /** If true the original image will be returned when compression fails or results larger */
  fallbackToOriginal?: boolean;
}

/**
 * Compress an image buffer. If the input is already AVIF we re-encode it with the requested
 * quality; otherwise we convert to AVIF.
 */
export async function compressImage(buffer: Buffer, opts: CompressionOptions = {}): Promise<Buffer> {
  const { quality = 50, fallbackToOriginal = true } = opts;

  const pipeline = sharp(buffer);
  const metadata = await pipeline.metadata();

  // Always encode to AVIF for Webflow storage
  const compressed = await pipeline
    .avif({ quality, chromaSubsampling: '4:4:4', effort: 4 })
    .toBuffer();

  if (fallbackToOriginal && compressed.length >= buffer.length) {
    return buffer; // compressed is not smaller → keep original
  }

  return compressed;
} 