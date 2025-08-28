export interface CmsItem {
  id: string;
  fieldData?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CmsClient {
  fetchAllItems(): Promise<CmsItem[]>;
  updateItemImage(itemId: string, fieldName: string, imageUrl: string): Promise<void>;
}


