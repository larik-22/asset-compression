import { config as loadDotenv } from 'dotenv';
loadDotenv();

import appConfig from '@/config.js';
import { runImageOptimizationPipeline } from '@/core/pipeline.js';
import { StatsTracker } from '@/core/stats.js';
import { logger } from '@utils/logger.js';
import { getCmsClient } from '@services/cms/index.js';
import type { CmsClient, CmsItem } from '@services/cms/types.js';
import { getUploaderClient } from '@services/uploader/index.js';
import type { UploaderClient, UploadResult } from '@services/uploader/types.js';

// --- Playground configuration ---
// Limit how many CMS items to process (default 1)
const TEST_LIMIT = Number(process.env.TEST_LIMIT ?? '1');

// Simulate specific failure scenarios on the first items in order.
// Provide a comma-separated list from: download,compression,upload,cms,delete
// Example: SIMULATE=download,compression,upload
const SIMULATE: string[] = (process.env.SIMULATE ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type Scenario = 'download' | 'compression' | 'upload' | 'cms' | 'delete' | 'none';

function buildScenarioMap(items: CmsItem[]): Map<string, Scenario> {
  const map = new Map<string, Scenario>();
  items.forEach((item, idx) => {
    const scenario = (SIMULATE[idx] as Scenario) ?? 'none';
    map.set(item.id, scenario);
  });
  return map;
}

// Wrap global fetch to respond to simulate:// URLs
function installFetchSimulator(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.startsWith('simulate://')) {
      const kind = url.slice('simulate://'.length);
      if (kind === 'download-error') {
        throw new Error('Simulated download error');
      }
      if (kind === 'compression-error') {
        // Return a successful response with non-image content
        const text = 'this is not an image';
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

class PlaygroundCmsClient implements CmsClient {
  private readonly base: CmsClient;
  private readonly imageFieldNames: string[];
  private readonly scenarioByItemId: Map<string, Scenario> = new Map();

  constructor(base: CmsClient, imageFieldNames: string[]) {
    this.base = base;
    this.imageFieldNames = imageFieldNames;
  }

  async fetchAllItems(): Promise<CmsItem[]> {
    const all = await this.base.fetchAllItems();
    const limited = all.slice(0, Math.max(0, TEST_LIMIT));
    const mapped = limited.map((item) => ({ ...item, fieldData: { ...(item.fieldData ?? {}) } }));

    // Build deterministic scenario map for limited items
    const scenarioMap = buildScenarioMap(mapped);
    for (const it of mapped) {
      const scenario = scenarioMap.get(it.id) ?? 'none';
      this.scenarioByItemId.set(it.id, scenario);
      if (scenario === 'download') {
        for (const fieldName of this.imageFieldNames) {
          if ((it.fieldData as any)?.[fieldName]) {
            (it.fieldData as any)[fieldName] = 'simulate://download-error';
          }
        }
      }
      if (scenario === 'compression') {
        for (const fieldName of this.imageFieldNames) {
          if ((it.fieldData as any)?.[fieldName]) {
            (it.fieldData as any)[fieldName] = 'simulate://compression-error';
          }
        }
      }
    }
    logger.info('Playground: prepared items', {
      limit: TEST_LIMIT,
      scenarios: Array.from(this.scenarioByItemId.entries()),
    });
    return mapped;
  }

  async updateItemImage(itemId: string, fieldName: string, imageUrl: string): Promise<void> {
    const scenario = this.scenarioByItemId.get(itemId) ?? 'none';
    if (scenario === 'cms') {
      throw new Error('Simulated CMS update error');
    }
    return this.base.updateItemImage(itemId, fieldName, imageUrl);
  }
}

class PlaygroundUploaderClient implements UploaderClient {
  private readonly base: UploaderClient;
  private readonly scenarioByItemId: Map<string, Scenario>;
  private readonly keyToItemId: Map<string, string> = new Map();

  constructor(base: UploaderClient, scenarioByItemId: Map<string, Scenario>) {
    this.base = base;
    this.scenarioByItemId = scenarioByItemId;
  }

  async upload(buffer: Buffer, fileName: string, contentType?: string): Promise<UploadResult> {
    const itemId = String(fileName).split('-')[0] || '';
    const scenario = this.scenarioByItemId.get(itemId) ?? 'none';
    if (scenario === 'upload') {
      throw new Error('Simulated upload error');
    }
    const res = await this.base.upload(buffer, fileName, contentType);
    this.keyToItemId.set(res.key, itemId);
    return res;
  }

  async delete(key: string): Promise<void> {
    const itemId = this.keyToItemId.get(key) ?? '';
    const scenario = this.scenarioByItemId.get(itemId) ?? 'none';
    if (scenario === 'delete') {
      throw new Error('Simulated delete error');
    }
    return this.base.delete(key);
  }
}

async function main(): Promise<void> {
  logger.info('Playground test starting');

  const removeFetchSim = installFetchSimulator();
  try {
    const imageFieldNames = appConfig.imageFieldNames;

    const realCms = getCmsClient();
    const playgroundCms = new PlaygroundCmsClient(realCms, imageFieldNames);

    // Fetch once to derive scenario map for uploader wrapper
    const items = await playgroundCms.fetchAllItems();
    const scenarioByItemId = buildScenarioMap(items);

    const realUploader = getUploaderClient();
    const playgroundUploader = new PlaygroundUploaderClient(realUploader, scenarioByItemId);

    const stats = new StatsTracker();
    await runImageOptimizationPipeline(imageFieldNames, playgroundCms, playgroundUploader, stats);
  } catch (err) {
    logger.error('Playground test failed', err);
    throw err;
  } finally {
    removeFetchSim();
  }
}

main().catch((err) => {
  logger.error('Main process failed', err);
  process.exit(1);
});