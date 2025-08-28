import type { ProcessingStats } from '@/types';
import { logger as defaultLogger } from '@utils/logger.js';

export class StatsTracker {
  private stats: ProcessingStats = {
    totalItems: 0,
    processedItems: 0,
    skippedItems: 0,
    successfulCompressions: 0,
    failedCompressions: 0,
    downloadFailures: 0,
    compressionFailures: 0,
    uploadFailures: 0,
    totalSizeReduction: 0,
    totalOriginalSize: 0,
    totalCompressedSize: 0,
  };

  setTotalItems(total: number): void {
    this.stats.totalItems = total;
  }

  incrementProcessed(): void {
    this.stats.processedItems += 1;
  }

  incrementSkipped(): void {
    this.stats.skippedItems += 1;
  }

  incrementSuccess(): void {
    this.stats.successfulCompressions += 1;
  }

  incrementFailure(): void {
    this.stats.failedCompressions += 1;
  }

  incrementDownloadFailure(): void {
    this.stats.downloadFailures = (this.stats.downloadFailures || 0) + 1;
    this.incrementFailure();
  }

  incrementCompressionFailure(): void {
    this.stats.compressionFailures = (this.stats.compressionFailures || 0) + 1;
    this.incrementFailure();
  }

  incrementUploadFailure(): void {
    this.stats.uploadFailures = (this.stats.uploadFailures || 0) + 1;
    this.incrementFailure();
  }

  recordSizes(originalBytes: number, compressedBytes: number): void {
    this.stats.totalOriginalSize += originalBytes;
    this.stats.totalCompressedSize += compressedBytes;
    this.stats.totalSizeReduction += originalBytes - compressedBytes;
  }

  get(): ProcessingStats {
    return { ...this.stats };
  }

  logFinal(l = defaultLogger): void {
    const { totalOriginalSize, totalCompressedSize, totalSizeReduction } = this.stats;
    const avgCompressionRatio = totalOriginalSize > 0 ? totalOriginalSize / totalCompressedSize : 0;
    const totalSizeReductionMB = totalSizeReduction / (1024 * 1024);
    const totalOriginalSizeMB = totalOriginalSize / (1024 * 1024);
    const totalCompressedSizeMB = totalCompressedSize / (1024 * 1024);

    l.success('=== FINAL PROCESSING STATISTICS ===');
    l.info('Item Processing:', {
      totalItems: this.stats.totalItems,
      processedItems: this.stats.processedItems,
      skippedItems: this.stats.skippedItems,
      successfulCompressions: this.stats.successfulCompressions,
      failedCompressions: this.stats.failedCompressions,
      successRate: `${Math.round((this.stats.successfulCompressions / Math.max(this.stats.processedItems - this.stats.skippedItems, 1)) * 100)}%`,
    });

    l.info('Size Reduction:', {
      originalSize: `${Math.round(totalOriginalSizeMB * 100) / 100} MB`,
      compressedSize: `${Math.round(totalCompressedSizeMB * 100) / 100} MB`,
      totalSaved: `${Math.round(totalSizeReductionMB * 100) / 100} MB`,
      avgCompressionRatio: `${Math.round(avgCompressionRatio * 100) / 100}×`,
      overallReduction: `${Math.round((totalSizeReduction / Math.max(totalOriginalSize, 1)) * 100)}%`,
    });
  }
}


