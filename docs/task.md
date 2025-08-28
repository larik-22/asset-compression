### **Step 1: Centralize Configuration**

* **Goal:** Consolidate all environment variables and hardcoded settings into a single, typed configuration file.
* **Actions:**
    1.  Create a new file: `src/config.ts`.
    2.  Move all `dotenv.config()` calls, `process.env` access, and hardcoded configurations (like `COMPRESSION_OPTIONS`, `CONCURRENCY` from `index.ts`) into this file.
    3.  Export a single, immutable `config` object with a clear type definition.
    4.  Refactor all files (`index.ts`, `webflowClient.ts`, `upload.ts`, etc.) to import settings from `src/config.ts` instead of accessing `process.env` directly.
* **Expected Outcome:** A single source of truth for configuration. Easier management of settings without searching through the codebase.
* **Validation:** The application runs as before. All environment variables and settings are correctly loaded from the new `config` object.

---

### **Step 2: Abstract the CMS Client**

* **Goal:** Decouple the core logic from Webflow to allow for different CMS providers in the future.
* **Actions:**
    1.  Create a new directory: `src/services/cms`.
    2.  Define a generic `CmsClient` interface in `src/services/cms/types.ts`. This interface should include methods like `fetchAllItems(): Promise<CmsItem[]>` and `updateItemImage(itemId: string, fieldName: string, imageUrl: string): Promise<void>`. Also define a generic `CmsItem` type.
    3.  Move `src/services/webflowClient.ts` to `src/services/cms/webflow.ts` and make it implement the `CmsClient` interface.
    4.  Create a factory function in `src/services/cms/index.ts` that returns the appropriate CMS client based on a new `CMS_PROVIDER` environment variable (e.g., `CMS_PROVIDER=webflow`).
* **Expected Outcome:** The main pipeline logic in `index.ts` interacts with the generic `CmsClient` interface, not the specific Webflow implementation.
* **Validation:** The script continues to work correctly for Webflow when `CMS_PROVIDER` is set to `'webflow'`.

---

### **Step 3: Abstract the Uploader Client**

* **Goal:** Decouple the logic from UploadThing to support other file hosting services.
* **Actions:**
    1.  Create a new directory: `src/services/uploader`.
    2.  Define a generic `UploaderClient` interface in `src/services/uploader/types.ts` with a method like `upload(buffer: Buffer, fileName: string): Promise<{ url: string; key: string }>`.
    3.  Move `src/utils/upload.ts` to `src/services/uploader/uploadthing.ts` and make it implement the `UploaderClient` interface.
    4.  Create a factory in `src/services/uploader/index.ts` that returns an uploader client based on an `UPLOADER_PROVIDER` environment variable.
* **Expected Outcome:** The core logic uses the generic `UploaderClient` interface, making it storage-agnostic.
* **Validation:** The script correctly uploads images using UploadThing when `UPLOADER_PROVIDER` is set to `'uploadthing'`.

---

### **Step 4: Refactor the Core Pipeline**

* **Goal:** Break down the monolithic `index.ts` into more focused, manageable modules and remove global state.
* **Actions:**
    1.  Create a `StatsTracker` class in a new `src/core/stats.ts` file to encapsulate all statistics logic, replacing the global `stats` object.
    2.  Create a `src/core/pipeline.ts` file. Move the main orchestration logic (`runImageOptimizationPipeline`, `processItems`, `processItem`, `processImageField`) into it. These functions should accept a `StatsTracker` instance as an argument.
    3.  Simplify `index.ts` to be the main entry point: it should initialize the config, clients, and `StatsTracker`, then invoke the pipeline from `pipeline.ts`.
* **Expected Outcome:** A lean `index.ts`, improved code organization, and removal of the mutable global `stats` object.
* **Validation:** The script performs the same functions and produces the same statistics as before.

---

### **Step 5: Generalize CMS Item Data Handling & Support Multiple Image Fields**

* **Goal:** Remove hardcoded assumptions about the structure of CMS item data (e.g., `item.fieldData.image.url`) and enable processing of multiple image fields per item.
* **Actions:**
    1.  **Update Configuration:** 
        - Change the `.env` variable from `IMAGE_FIELD_NAME` to `IMAGE_FIELD_NAMES`, which will accept a comma-separated list of field names (e.g., `IMAGE_FIELD_NAMES=main-image,thumbnail,social-sharing-card`). 
        - In `config.ts`, parse this into a string array.
        - Add new configuration variables for specifying the paths to key fields, e.g., `ITEM_NAME_FIELD_PATH: 'fieldData.name'`, `IMAGE_OBJECT_FIELD_PATH: 'fieldData.image'`.
    2.  Create a utility function `getPropertyByPath(obj: any, path: string): any` to safely access nested properties.
    3.  **Refactor Pipeline Logic:**
        - Update `processItem` function to iterate through the array of field names from your config. For each field name, it will perform the existing logic: check if the field exists on the item and, if so, call `processImageField` for it.
        - Refactor `getImageUrlFromField` and other pipeline functions to use the `getPropertyByPath` utility and the configured field paths instead of direct property access.
* **Expected Outcome:** The script can process items from different collections or even CMSs with varying data structures and handle multiple image fields per item, making it far more versatile and useful for complex collections without needing to run it multiple times with different configurations.
* **Validation:** The script correctly extracts item names and image URLs using the new configuration-driven approach and successfully processes all configured image fields for each item.

---

### **Step 6: Enhance Robustness and Error Handling**

* **Goal:** Make the retry logic generic and improve error classification for more insightful statistics.
* **Actions:**
    1.  Modify `withRateLimitRetry` in `src/utils/retry.ts` to accept a predicate function, `isRateLimitError(error: any): boolean`, making it independent of Webflow's specific error type. The Webflow client will provide its specific implementation of this predicate.
    2.  In `processImageField`, implement distinct error handling for different stages (download, compression, upload).
    3.  Update the `StatsTracker` class to track these different failure types (e.g., `downloadFailures`, `compressionFailures`, `uploadFailures`) instead of a single `failedCompressions` counter.
* **Expected Outcome:** More resilient and provider-agnostic rate-limit handling. More granular and actionable error statistics.
* **Validation:** Rate-limiting retries still work as expected. Manually inducing failures at different stages (e.g., providing a dead URL) results in the correct, specific error being tracked in the final stats.

Of course. Beyond the structural refactoring, we can make several algorithmic improvements to create a more robust, feature-rich, and efficient script.

Here are the key enhancements I suggest.

---


### **Step 7: Automate Asset Cleanup**
**Overview:** The plan is to use UploadThing as a short-term host for the compressed image. Webflow will fetch the image from the temporary UploadThing URL to create its own permanently stored asset. Once Webflow has successfully copied the image, the temporary file on UploadThing is no longer needed and should be deleted immediately.

* **Why:** Automated cleanup keeps your storage optimized and reduces costs by ensuring you only store the assets that are actively in use.
1. Once image is uploaded to UploadThing, if successful, we receive `UploadFileData` object with `key` property 
2. After uploading to Webflow, we can delete the image from UploadThing using the `key` property. (or multiple keys if multiple images are uploaded)
---

### **Step 8: 🏃‍♂️ Implement a "Dry Run" Mode**

Running a script that modifies hundreds or thousands of live CMS items is risky. A "dry run" mode would simulate the entire process without making any actual changes.

* **Why:** A dry run allows you to safely preview the script's actions, verify the compression savings, and catch potential issues (like incorrect field names) before modifying any live data.
* **How to Implement:**
    1.  **Add `DRY_RUN` Flag:** Introduce a `DRY_RUN=true` option in your `.env` file and `config.ts`.
    2.  **Add Conditional Logic:** In `src/index.ts`, modify the `processImageField` function. Add checks before the upload and update steps:
        * Just before calling `uploadToUploadThing`, check `if (config.isDryRun)`. If true, log the compression results and skip the upload.
        * Similarly, skip the `updateAndPublishItem` call.
    3.  **Enhance Logging:** In dry run mode, your logs should clearly state what *would have happened*. For example: `[DRY RUN] Would upload image with size 85 KB.`, `[DRY RUN] Would update CMS item 12345.`.
---




