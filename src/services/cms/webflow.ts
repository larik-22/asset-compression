import { WebflowClient, Webflow } from 'webflow-api';
import appConfig from '@/config.js';
import { CmsClient, CmsItem } from './types.js';
import { withRateLimitRetry } from '@utils/retry.js';

const webflow = new WebflowClient({ accessToken: appConfig.webflow.token });

async function listCollectionItems(
  collectionId: string,
  options: Webflow.collections.ItemsListItemsRequest = {},
): Promise<Webflow.CollectionItemList> {
  return webflow.collections.items.listItems(collectionId, options);
}

async function updateItemsLive(
  collectionId: string,
  items: Webflow.collections.ItemsUpdateItemsLiveRequest['items'],
) {
  return webflow.collections.items.updateItemsLive(collectionId, { items });
}

export class WebflowCmsClient implements CmsClient {
  private readonly collectionId: string;

  constructor(collectionId: string) {
    this.collectionId = collectionId;
  }

  async fetchAllItems(): Promise<CmsItem[]> {
    const all: CmsItem[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const resp = await withRateLimitRetry(
        () => listCollectionItems(this.collectionId, { limit, offset }),
        { isRateLimitError: (e) => e instanceof Webflow.TooManyRequestsError || (e as any)?.status === 429 },
      );
      const items = (resp.items ?? []) as unknown as CmsItem[];
      all.push(...items);
      if (items.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async updateItemImage(itemId: string, fieldName: string, imageUrl: string): Promise<void> {
    await withRateLimitRetry(
      () =>
        updateItemsLive(this.collectionId, [
          {
            id: itemId,
            fieldData: { [fieldName]: imageUrl },
            isDraft: false,
            isArchived: false,
          },
        ]),
      { isRateLimitError: (e) => e instanceof Webflow.TooManyRequestsError || (e as any)?.status === 429 },
    );
  }
}


