import { WebflowClient, Webflow } from 'webflow-api';
import { config } from 'dotenv';

config();

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;

if (!WEBFLOW_TOKEN) {
  throw new Error('WEBFLOW_TOKEN must be defined in environment variables');
}

export const webflow = new WebflowClient({ accessToken: WEBFLOW_TOKEN });

export async function listCollectionItems(
  collectionId: string,
  options: Webflow.collections.ItemsListItemsRequest = {},
): Promise<Webflow.CollectionItemList> {
  return webflow.collections.items.listItems(collectionId, options);
}

export async function updateCollectionItem(
  collectionId: string,
  itemId: string,
  payload: Webflow.CollectionItemPatchSingle,
) {
  return webflow.collections.items.updateItem(collectionId, itemId, payload);
}

/**
 * Helper that reads the collection id from the environment and returns all items.
 */
export async function getEnvCollectionItems(
  options: Webflow.collections.ItemsListItemsRequest = {},
): Promise<Webflow.CollectionItemList> {
  const collectionId = process.env.WEBFLOW_COLLECTION_ID;
  if (!collectionId) {
    throw new Error('WEBFLOW_COLLECTION_ID must be defined in environment variables');
  }
  return listCollectionItems(collectionId, options);
}

/**
 * Update a single item and publish it immediately (live).
 * Only provide the fields you want to change in `fieldData`.
 */
export async function updateAndPublishItem(
  collectionId: string,
  itemId: string,
  fieldData: Record<string, unknown>,
) {
  return webflow.collections.items.updateItemsLive(collectionId, {
    items: [
      {
        id: itemId,
        fieldData,
        isDraft: false,
        isArchived: false,
      },
    ],
  });
} 