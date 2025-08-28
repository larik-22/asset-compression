import { config as loadDotenv } from 'dotenv';
import type { SmartCompressionOptions } from '@utils/image.js';

// Load environment variables once, centrally
loadDotenv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function deepFreeze<T>(obj: T): Readonly<T> {
  Object.freeze(obj as unknown as object);
  Object.getOwnPropertyNames(obj as unknown as object).forEach((prop) => {
    const value = (obj as unknown as Record<string, unknown>)[prop];
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value as Record<string, unknown>);
    }
  });
  return obj as Readonly<T>;
}

export interface AppConfig {
  webflow: {
    token: string;
    collectionId: string;
  };
  uploadthing: {
    token: string;
  };
  cmsProvider: 'webflow';
  uploaderProvider: 'uploadthing';
  imageFieldNames: string[];
  itemNameFieldPath: string;
  imageObjectFieldPath: string;
  concurrency: number;
  compression: SmartCompressionOptions;
}

const appConfigObj: AppConfig = {
  webflow: {
    token: requireEnv('WEBFLOW_TOKEN'),
    collectionId: requireEnv('WEBFLOW_COLLECTION_ID'),
  },
  uploadthing: {
    token: requireEnv('UPLOADTHING_TOKEN'),
  },
  cmsProvider: (process.env.CMS_PROVIDER?.trim() || 'webflow') as 'webflow',
  uploaderProvider: (process.env.UPLOADER_PROVIDER?.trim() || 'uploadthing') as 'uploadthing',
  imageFieldNames: (process.env.IMAGE_FIELD_NAMES || process.env.IMAGE_FIELD_NAME || 'image')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  itemNameFieldPath: process.env.ITEM_NAME_FIELD_PATH?.trim() || 'fieldData.name',
  imageObjectFieldPath: process.env.IMAGE_OBJECT_FIELD_PATH?.trim() || 'fieldData.image',
  concurrency: parseNumber(process.env.CONCURRENCY, 6),
  compression: {
    targetRatio: parseFloatNumber(process.env.COMPRESSION_TARGET_RATIO, 0.5),
    quality: parseNumber(process.env.COMPRESSION_QUALITY, 95),
    minQuality: parseNumber(process.env.COMPRESSION_MIN_QUALITY, 80),
    minSSIM: parseFloatNumber(process.env.COMPRESSION_MIN_SSIM, 0.98),
    maxDimension: parseNumber(process.env.COMPRESSION_MAX_DIMENSION, 1000),
  },
};

export const appConfig: Readonly<AppConfig> = deepFreeze(appConfigObj);

export default appConfig;


