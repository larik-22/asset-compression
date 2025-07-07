import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';

config();

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: any;
}

interface CompressionData {
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  sizeReduction: string;
}

interface UploadData {
  url: string;
  key: string;
}

interface ProcessingStats {
  totalItems: number;
  processedItems: number;
  skippedItems: number;
  successfulCompressions: number;
  failedCompressions: number;
  uploads: number;
  cmsUpdates: number;
  errors: number;
}

interface CompressionStats {
  totalOriginalSize: number;
  totalCompressedSize: number;
  averageCompressionRatio: number;
  bestCompressionRatio: number;
  worstCompressionRatio: number;
  totalSizeSaved: number;
  averageSizeReduction: number;
}

function parseLogFile(filePath: string): LogEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  const entries: LogEntry[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Match log entry format: [LEVEL] timestamp - message
    const logMatch = line.match(/^\[(\w+)\] ([\d-T:.Z]+) - (.+)$/);
    if (logMatch) {
      const [, level, timestamp, message] = logMatch;
      const entry: LogEntry = { timestamp, level, message };
      
      // Check if the next lines contain JSON data (starts with →)
      if (i + 1 < lines.length && lines[i + 1].trim().startsWith('→')) {
        let jsonString = '';
        let j = i + 1;
        
        // Collect all lines that are part of the JSON object
        while (j < lines.length && (lines[j].trim().startsWith('→') || lines[j].trim().startsWith('"') || lines[j].trim().startsWith('}') || lines[j].trim() === '')) {
          const jsonLine = lines[j].trim();
          
          if (jsonLine.startsWith('→')) {
            // Remove the arrow and any leading whitespace
            jsonString += jsonLine.substring(1).trim();
          } else if (jsonLine) {
            // Add other lines that are part of the JSON
            jsonString += jsonLine;
          }
          
          j++;
          
          // Stop when we find a complete JSON object (ends with })
          if (jsonLine.trim() === '}') {
            break;
          }
        }
        
        // Try to parse the collected JSON
        if (jsonString) {
          try {
            entry.data = JSON.parse(jsonString);
            i = j - 1; // Skip the lines we've processed
          } catch (error) {
            // If JSON parsing fails, continue without data
            console.log(`Failed to parse JSON: ${jsonString}`);
          }
        }
      }
      
      entries.push(entry);
    }
  }
  
  return entries;
}

function analyzeProcessing(entries: LogEntry[]): ProcessingStats {
  const stats: ProcessingStats = {
    totalItems: 0,
    processedItems: 0,
    skippedItems: 0,
    successfulCompressions: 0,
    failedCompressions: 0,
    uploads: 0,
    cmsUpdates: 0,
    errors: 0
  };

  for (const entry of entries) {
    if (entry.message.includes('Successfully fetched') && entry.message.includes('total items')) {
      const match = entry.message.match(/(\d+) total items/);
      if (match) {
        stats.totalItems = parseInt(match[1]);
      }
    } else if (entry.message.includes('Successfully processed item')) {
      stats.processedItems++;
    } else if (entry.message.includes('Skipping item') && entry.message.includes('no image field')) {
      stats.skippedItems++;
    } else if (entry.message.includes('Image compressed successfully')) {
      stats.successfulCompressions++;
    } else if (entry.message.includes('Failed to compress')) {
      stats.failedCompressions++;
    } else if (entry.message.includes('Uploaded to UploadThing') && entry.level === 'SUCCESS') {
      stats.uploads++;
    } else if (entry.message.includes('Updated CMS item') && entry.message.includes('compressed image')) {
      stats.cmsUpdates++;
    } else if (entry.level === 'ERROR') {
      stats.errors++;
    }
  }

  return stats;
}

function analyzeCompression(entries: LogEntry[]): CompressionStats {
  const compressions: CompressionData[] = [];
  
  for (const entry of entries) {
    if (entry.message.includes('Image compressed successfully') && entry.data) {
      const data = entry.data as CompressionData;
      if (data.originalSize && data.compressedSize && data.compressionRatio) {
        compressions.push(data);
      }
    }
  }

  if (compressions.length === 0) {
    return {
      totalOriginalSize: 0,
      totalCompressedSize: 0,
      averageCompressionRatio: 0,
      bestCompressionRatio: 0,
      worstCompressionRatio: 0,
      totalSizeSaved: 0,
      averageSizeReduction: 0
    };
  }

  const totalOriginalSize = compressions.reduce((sum, c) => sum + c.originalSize, 0);
  const totalCompressedSize = compressions.reduce((sum, c) => sum + c.compressedSize, 0);
  const totalSizeSaved = totalOriginalSize - totalCompressedSize;
  
  const ratios = compressions.map(c => c.compressionRatio);
  const averageCompressionRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  const bestCompressionRatio = Math.max(...ratios);
  const worstCompressionRatio = Math.min(...ratios);
  
  const sizeReductions = compressions.map(c => parseFloat(c.sizeReduction.replace('%', '')));
  const averageSizeReduction = sizeReductions.reduce((sum, r) => sum + r, 0) / sizeReductions.length;

  return {
    totalOriginalSize,
    totalCompressedSize,
    averageCompressionRatio,
    bestCompressionRatio,
    worstCompressionRatio,
    totalSizeSaved,
    averageSizeReduction
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function generateReport(filePath: string): void {
  console.log('🔍 Analyzing log file:', filePath);
  console.log('');

  const entries = parseLogFile(filePath);
  console.log(`📄 Parsed ${entries.length} log entries`);
  console.log('');

  // Processing Statistics
  const processingStats = analyzeProcessing(entries);
  console.log('📊 PROCESSING OVERVIEW');
  console.log('====================');
  console.log(`Total Items in Collection: ${processingStats.totalItems}`);
  console.log(`Items Processed: ${processingStats.processedItems}`);
  console.log(`Items Skipped (no image): ${processingStats.skippedItems}`);
  console.log(`Success Rate: ${processingStats.totalItems > 0 ? 
    ((processingStats.processedItems / processingStats.totalItems) * 100).toFixed(1) : 0}%`);
  console.log(`Errors: ${processingStats.errors}`);
  console.log('');

  // Compression Statistics
  const compressionStats = analyzeCompression(entries);
  console.log('🗜️  COMPRESSION ANALYSIS');
  console.log('======================');
  console.log(`Successful Compressions: ${processingStats.successfulCompressions}`);
  console.log(`Failed Compressions: ${processingStats.failedCompressions}`);
  console.log(`Total Original Size: ${formatBytes(compressionStats.totalOriginalSize * 1024)}`);
  console.log(`Total Compressed Size: ${formatBytes(compressionStats.totalCompressedSize * 1024)}`);
  console.log(`Total Size Saved: ${formatBytes(compressionStats.totalSizeSaved * 1024)}`);
  console.log(`Average Compression Ratio: ${compressionStats.averageCompressionRatio.toFixed(2)}x`);
  console.log(`Best Compression Ratio: ${compressionStats.bestCompressionRatio.toFixed(2)}x`);
  console.log(`Worst Compression Ratio: ${compressionStats.worstCompressionRatio.toFixed(2)}x`);
  console.log(`Average Size Reduction: ${compressionStats.averageSizeReduction.toFixed(1)}%`);
  console.log('');

  // Upload and Update Statistics
  console.log('☁️  UPLOAD & UPDATE STATUS');
  console.log('=========================');
  console.log(`Successful Uploads: ${processingStats.uploads}`);
  console.log(`CMS Updates: ${processingStats.cmsUpdates}`);
  console.log(`Upload Success Rate: ${processingStats.successfulCompressions > 0 ? 
    ((processingStats.uploads / processingStats.successfulCompressions) * 100).toFixed(1) : 0}%`);
  console.log(`CMS Update Success Rate: ${processingStats.uploads > 0 ? 
    ((processingStats.cmsUpdates / processingStats.uploads) * 100).toFixed(1) : 0}%`);
  console.log('');

  // Performance Analysis
  const startTime = entries.find(e => e.message.includes('Starting Webflow CMS'))?.timestamp;
  const endTime = entries[entries.length - 1]?.timestamp;
  
  if (startTime && endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const durationMs = end.getTime() - start.getTime();
    const durationMinutes = durationMs / (1000 * 60);
    const itemsPerMinute = processingStats.processedItems / durationMinutes;
    
    console.log('⚡ PERFORMANCE METRICS');
    console.log('=====================');
    console.log(`Total Duration: ${durationMinutes.toFixed(1)} minutes`);
    console.log(`Processing Speed: ${itemsPerMinute.toFixed(1)} items/minute`);
    console.log('');
  }

  // Recommendations
  console.log('💡 RECOMMENDATIONS');
  console.log('==================');
  
  if (compressionStats.averageCompressionRatio > 10) {
    console.log('✅ Excellent compression ratios achieved!');
  } else if (compressionStats.averageCompressionRatio > 5) {
    console.log('✅ Good compression ratios achieved.');
  } else {
    console.log('⚠️  Consider adjusting compression settings for better ratios.');
  }
  
  if (processingStats.errors > 0) {
    console.log(`⚠️  Found ${processingStats.errors} errors - review error logs.`);
  }
  
  if (processingStats.skippedItems > processingStats.processedItems) {
    console.log('ℹ️  Many items skipped due to missing images - consider data cleanup.');
  }
  
  console.log('');

  // Save detailed analysis
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const analysisFile = `logs/analysis-${timestamp}.json`;
  
  const detailedAnalysis = {
    metadata: {
      logFile: filePath,
      analyzedAt: new Date().toISOString(),
      totalLogEntries: entries.length
    },
    processing: processingStats,
    compression: compressionStats,
    performance: startTime && endTime ? {
      startTime,
      endTime,
      durationMinutes: (new Date(endTime).getTime() - new Date(startTime).getTime()) / (1000 * 60)
    } : null
  };
  
  fs.writeFileSync(analysisFile, JSON.stringify(detailedAnalysis, null, 2));
  console.log(`📁 Detailed analysis saved to: ${analysisFile}`);
}

function main(): void {
  const logFilePath = process.argv[2];
  
  if (!logFilePath) {
    console.error('Usage: npm run analyze-log <log-file-path>');
    console.error('Example: npm run analyze-log logs/2025-07-07T16-44-54-387Z.log');
    process.exit(1);
  }
  
  if (!fs.existsSync(logFilePath)) {
    console.error(`Error: Log file not found: ${logFilePath}`);
    process.exit(1);
  }
  
  try {
    generateReport(logFilePath);
  } catch (error) {
    console.error('Error analyzing log file:', error);
    process.exit(1);
  }
}

main(); 