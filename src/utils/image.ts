import sharp from 'sharp';
// eslint-disable-next-line import/no-extraneous-dependencies
import { ssim as ssimCalc } from 'ssim.js';

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

/**
 * Attempt multiple quality settings until we reach the target ratio or hit minQuality.
 * Returns the smallest buffer that satisfies the target or the best effort.
 */
export async function compressImageAdaptive(
  buffer: Buffer,
  opts: AdaptiveCompressionOptions = {},
): Promise<Buffer> {
  const {
    targetRatio = 0.7,
    minQuality = 25,
    quality = 50,
    fallbackToOriginal = true,
  } = opts;

  let currentQuality = quality;
  let best = buffer;

  while (currentQuality >= minQuality) {
    const attempt = await compressImage(buffer, {
      quality: currentQuality,
      fallbackToOriginal: false,
    });

    if (attempt.length < best.length) best = attempt;

    if (attempt.length / buffer.length <= targetRatio) {
      break; // achieved goal
    }
    // step down quality by 5
    currentQuality -= 5;
  }

  if (fallbackToOriginal && best.length >= buffer.length) {
    return buffer;
  }
  return best;
}

async function bufferToImageData(buffer: Buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
  } as const;
}

export interface SmartCompressionOptions extends AdaptiveCompressionOptions {
  /** Minimum acceptable SSIM (0-1). Typical visually lossless ≥ 0.97 */
  minSSIM?: number;
  /** Maximum iterations for binary search */
  maxIterations?: number;
  /** Maximum dimension for resizing before compression */
  maxDimension?: number;
}

/**
 * Binary-search AVIF quality to achieve smallest size while keeping SSIM above threshold.
 */
export async function compressImageSmart(
  buffer: Buffer,
  opts: SmartCompressionOptions = {},
): Promise<Buffer> {
  const {
    minSSIM = 0.97,
    quality = 60,
    minQuality = 25,
    targetRatio = 0.5,
    maxIterations = 5,
    maxDimension,
  } = opts;

  let low = minQuality;
  let high = quality;
  let best: { buf: Buffer; quality: number } | null = null;

  // Optionally resize before quality search to cut bytes early
  let workingBuffer = buffer;
  if (maxDimension) {
    const meta = await sharp(buffer).metadata();
    if (meta.width && meta.height && (meta.width > maxDimension || meta.height > maxDimension)) {
      workingBuffer = await sharp(buffer)
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: 'inside',
        })
        .toBuffer();
    }
  }

  const originalImage = await bufferToImageData(workingBuffer);

  for (let i = 0; i < maxIterations && low <= high; i += 1) {
    const mid = Math.round((low + high) / 2);
    const comp = await compressImage(workingBuffer, { quality: mid, fallbackToOriginal: false });

    const compImage = await bufferToImageData(comp);
    const { ssim } = ssimCalc(originalImage, compImage);

    // keep best if size smaller and quality acceptable
    if (ssim >= minSSIM && (best === null || comp.length < best.buf.length)) {
      best = { buf: comp, quality: mid };
    }

    // decide which half to search
    if (ssim < minSSIM) {
      // quality too low, increase quality
      low = mid + 1;
    } else {
      // quality high enough, try lower quality for more savings
      high = mid - 1;
    }
  }

  if (best) {
    // Ensure target ratio achieved; else return adaptive best
    if (best.buf.length / workingBuffer.length <= targetRatio) {
      return best.buf;
    }
  }

  // Fallback to adaptive method if SSIM target not achievable
  return compressImageAdaptive(workingBuffer, opts);
} 