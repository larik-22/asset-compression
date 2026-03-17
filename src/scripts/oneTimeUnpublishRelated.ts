import { config as loadDotenv } from "dotenv";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WebflowClient, Webflow } from "webflow-api";

loadDotenv();

const WORK_TYPES_COLLECTION_ID = "653256fa152d62d873f99b17";
const SERVICES_COLLECTION_ID = "653254992cb29c000a795885";

const TARGETS: ReadonlyArray<{ collectionId: string; itemId: string }> = [
	{ collectionId: WORK_TYPES_COLLECTION_ID, itemId: "653258ccabbc6ae3b759f47b" },
	{ collectionId: SERVICES_COLLECTION_ID, itemId: "65673af8067534c789f2c85d" },
	{ collectionId: SERVICES_COLLECTION_ID, itemId: "653258fd419fd1e27b8ea354" },
];

const TARGET_OUTBOUND_FIELDS_TO_CLEAR: Record<string, string[]> = {
	"653258ccabbc6ae3b759f47b": ["works-2"],
};

interface CachedItem {
	id: string;
	collectionId: string;
	collectionName: string;
	isDraft: boolean;
	isArchived: boolean;
	fieldData: Record<string, unknown>;
}

interface TargetReference {
	itemId: string;
	collectionId: string;
	collectionName: string;
	itemName: string;
	fieldSlug: string;
	targetId: string;
}

interface PendingMutation {
	itemId: string;
	collectionId: string;
	collectionName: string;
	itemName: string;
	reason: "reference" | "target";
	referencedTargetIds: string[];
}

interface WebflowLikeError {
	statusCode?: number;
	body?: {
		message?: string;
	};
}

interface UnlinkPlan {
	itemId: string;
	collectionId: string;
	collectionName: string;
	itemName: string;
	originalFieldData: Record<string, unknown>;
	updatedFieldData: Record<string, unknown>;
	removedByField: Record<string, string[]>;
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} environment variable is required`);
	}
	return value;
}

function parseArgs(): { dryRun: boolean } {
	const args = new Set(process.argv.slice(2));
	const dryRun = !args.has("--execute");
	return { dryRun };
}

async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	const maxAttempts = 6;
	let attempt = 0;

	while (true) {
		try {
			return await fn();
		} catch (error) {
			const statusCode = (error as { statusCode?: number })?.statusCode;
			const status = (error as { status?: number })?.status;
			const rateLimited =
				error instanceof Webflow.TooManyRequestsError ||
				statusCode === 429 ||
				status === 429;

			attempt += 1;
			if (!rateLimited || attempt >= maxAttempts) {
				throw error;
			}

			const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
			console.warn(
				`[WARN] Rate limited during ${label} (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms`,
			);
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
		}
	}
}

async function listAllItems(
	client: WebflowClient,
	collectionId: string,
	collectionName: string,
): Promise<CachedItem[]> {
	const all: CachedItem[] = [];
	let offset = 0;
	const limit = 100;

	while (true) {
		const page = await withRateLimitRetry(
			() => client.collections.items.listItems(collectionId, { limit, offset }),
			`listItems ${collectionName}`,
		);
		const items = page.items ?? [];
		for (const item of items) {
			if (!item.id) {
				continue;
			}
			all.push({
				id: item.id,
				collectionId,
				collectionName,
				isDraft: Boolean(item.isDraft),
				isArchived: Boolean(item.isArchived),
				fieldData: (item.fieldData ?? {}) as Record<string, unknown>,
			});
		}

		if (items.length < limit) break;
		offset += limit;
	}

	return all;
}

function getItemName(fieldData: Record<string, unknown>): string {
	const maybeName = fieldData.name;
	return typeof maybeName === "string" && maybeName.trim()
		? maybeName
		: "(unnamed item)";
}

function findReferences(items: CachedItem[], targetIds: Set<string>): TargetReference[] {
	const refs: TargetReference[] = [];

	for (const item of items) {
		for (const [fieldSlug, rawValue] of Object.entries(item.fieldData)) {
			if (Array.isArray(rawValue)) {
				const matchedTargets = rawValue.filter(
					(value): value is string =>
						typeof value === "string" && targetIds.has(value),
				);
				for (const targetId of matchedTargets) {
					refs.push({
						itemId: item.id,
						collectionId: item.collectionId,
						collectionName: item.collectionName,
						itemName: getItemName(item.fieldData),
						fieldSlug,
						targetId,
					});
				}
			} else if (typeof rawValue === "string" && targetIds.has(rawValue)) {
				refs.push({
					itemId: item.id,
					collectionId: item.collectionId,
					collectionName: item.collectionName,
					itemName: getItemName(item.fieldData),
					fieldSlug,
					targetId: rawValue,
				});
			}
		}
	}

	return refs;
}

function buildMutations(
	references: TargetReference[],
	targets: ReadonlyArray<{ collectionId: string; itemId: string }>,
	itemById: Map<string, CachedItem>,
): PendingMutation[] {
	const byItemId = new Map<string, PendingMutation>();

	for (const ref of references) {
		const existing = byItemId.get(ref.itemId);
		if (!existing) {
			byItemId.set(ref.itemId, {
				itemId: ref.itemId,
				collectionId: ref.collectionId,
				collectionName: ref.collectionName,
				itemName: ref.itemName,
				reason: "reference",
				referencedTargetIds: [ref.targetId],
			});
			continue;
		}
		if (!existing.referencedTargetIds.includes(ref.targetId)) {
			existing.referencedTargetIds.push(ref.targetId);
		}
	}

	const referenceMutations = [...byItemId.values()].sort((a, b) => {
		if (a.collectionName !== b.collectionName) {
			return a.collectionName.localeCompare(b.collectionName);
		}
		return a.itemName.localeCompare(b.itemName);
	});

	const targetMutations: PendingMutation[] = [];
	for (const target of targets) {
		const targetItem = itemById.get(target.itemId);
		if (!targetItem) {
			console.warn(
				`[WARN] Target item ${target.itemId} was not found while preparing mutations`,
			);
			continue;
		}
		targetMutations.push({
			itemId: targetItem.id,
			collectionId: targetItem.collectionId,
			collectionName: targetItem.collectionName,
			itemName: getItemName(targetItem.fieldData),
			reason: "target",
			referencedTargetIds: [],
		});
	}

	return [...referenceMutations, ...targetMutations];
}

async function updateItemToDraft(
	client: WebflowClient,
	item: PendingMutation,
	source: CachedItem,
): Promise<boolean> {
	const payload = {
		items: [
			{
				id: item.itemId,
				fieldData: source.fieldData,
				isDraft: true,
				isArchived: false,
			},
		],
	};

	try {
		await withRateLimitRetry(
			() => client.collections.items.updateItemsLive(item.collectionId, payload),
			`updateItemsLive ${item.collectionName}/${item.itemId}`,
		);
		return true;
	} catch (error) {
		const maybeError = error as WebflowLikeError;
		const message = maybeError.body?.message ?? "";
		const shouldFallbackToStagedUpdate =
			maybeError.statusCode === 409 &&
			message.includes("Live PATCH updates can't be applied to items that have never been published");

		if (!shouldFallbackToStagedUpdate) {
			throw error;
		}

		console.warn(
			`[WARN] Falling back to staged update for never-published item ${item.itemId}`,
		);
		await withRateLimitRetry(
			() => client.collections.items.updateItems(item.collectionId, payload),
			`updateItems ${item.collectionName}/${item.itemId}`,
		);
		return true;
	}
}

async function hasLiveItem(
	client: WebflowClient,
	collectionId: string,
	itemId: string,
): Promise<boolean> {
	try {
		await withRateLimitRetry(
			() => client.collections.items.getItemLive(collectionId, itemId),
			`getItemLive ${collectionId}/${itemId}`,
		);
		return true;
	} catch (error) {
		const maybeError = error as WebflowLikeError;
		if (maybeError.statusCode === 404) {
			return false;
		}
		throw error;
	}
}

async function unpublishLiveItem(
	client: WebflowClient,
	mutation: PendingMutation,
): Promise<boolean> {
	const isLive = await hasLiveItem(client, mutation.collectionId, mutation.itemId);
	if (!isLive) {
		return false;
	}

	await withRateLimitRetry(
		() =>
			client.collections.items.deleteItemsLive(mutation.collectionId, {
				items: [{ id: mutation.itemId }],
			}),
		`deleteItemsLive ${mutation.collectionName}/${mutation.itemId}`,
	);
	return true;
}

function buildUnlinkPlans(
	references: TargetReference[],
	itemById: Map<string, CachedItem>,
): UnlinkPlan[] {
	const grouped = new Map<string, Map<string, Set<string>>>();
	for (const ref of references) {
		if (!grouped.has(ref.itemId)) grouped.set(ref.itemId, new Map());
		const byField = grouped.get(ref.itemId)!;
		if (!byField.has(ref.fieldSlug)) byField.set(ref.fieldSlug, new Set());
		byField.get(ref.fieldSlug)!.add(ref.targetId);
	}

	const plans: UnlinkPlan[] = [];
	for (const [itemId, byField] of grouped.entries()) {
		const item = itemById.get(itemId);
		if (!item) continue;
		const updatedFieldData: Record<string, unknown> = { ...item.fieldData };
		const removedByField: Record<string, string[]> = {};
		let changed = false;

		for (const [fieldSlug, removeSet] of byField.entries()) {
			const currentValue = updatedFieldData[fieldSlug];
			if (Array.isArray(currentValue)) {
				const before = [...currentValue];
				const after = before.filter(
					(value) => !(typeof value === "string" && removeSet.has(value)),
				);
				if (after.length !== before.length) {
					updatedFieldData[fieldSlug] = after;
					removedByField[fieldSlug] = before.filter(
						(value): value is string =>
							typeof value === "string" && removeSet.has(value),
					);
					changed = true;
				}
			} else if (
				typeof currentValue === "string" &&
				removeSet.has(currentValue)
			) {
				updatedFieldData[fieldSlug] = null;
				removedByField[fieldSlug] = [currentValue];
				changed = true;
			}
		}

		if (!changed) continue;
		plans.push({
			itemId: item.id,
			collectionId: item.collectionId,
			collectionName: item.collectionName,
			itemName: getItemName(item.fieldData),
			originalFieldData: item.fieldData,
			updatedFieldData,
			removedByField,
		});
	}

	return plans;
}

async function saveUnlinkBackup(plans: UnlinkPlan[]): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = path.resolve(process.cwd(), "logs");
	await fs.mkdir(backupDir, { recursive: true });
	const backupPath = path.join(
		backupDir,
		`one-time-unpublish-unlink-backup-${timestamp}.json`,
	);
	await fs.writeFile(backupPath, JSON.stringify(plans, null, 2), "utf8");
	return backupPath;
}

async function updateItemFieldData(
	client: WebflowClient,
	item: CachedItem,
	updatedFieldData: Record<string, unknown>,
): Promise<void> {
	const payload = {
		items: [
			{
				id: item.id,
				fieldData: updatedFieldData,
				isDraft: item.isDraft,
				isArchived: item.isArchived,
			},
		],
	};

	await withRateLimitRetry(
		() => client.collections.items.updateItems(item.collectionId, payload),
		`updateItems unlink ${item.collectionName}/${item.id}`,
	);

	const isLive = await hasLiveItem(client, item.collectionId, item.id);
	if (!isLive) return;

	try {
		await withRateLimitRetry(
			() => client.collections.items.updateItemsLive(item.collectionId, payload),
			`updateItemsLive unlink ${item.collectionName}/${item.id}`,
		);
	} catch (error) {
		const maybeError = error as WebflowLikeError;
		const message = maybeError.body?.message ?? "";
		const neverPublishedConflict =
			maybeError.statusCode === 409 &&
			message.includes("Live PATCH updates can't be applied to items that have never been published");
		if (!neverPublishedConflict) {
			throw error;
		}
	}
}

async function main(): Promise<void> {
	const token = requireEnv("WEBFLOW_TOKEN");
	const { dryRun } = parseArgs();
	const targetIds = new Set(TARGETS.map((t) => t.itemId));
	const client = new WebflowClient({ accessToken: token });

	console.log("[INFO] Starting one-time unpublish script");
	console.log(`[INFO] Mode: ${dryRun ? "dry-run" : "execute"}`);
	console.log(
		`[INFO] Targets: ${TARGETS.map((t) => `${t.collectionId}/${t.itemId}`).join(", ")}`,
	);
	if (dryRun) {
		console.log(
			"[INFO] Dry-run mode is enabled. No changes will be written. Pass --execute to apply.",
		);
	}

	const sites = await withRateLimitRetry(() => client.sites.list(), "sites.list");
	if (!sites.sites || sites.sites.length === 0) {
		throw new Error("No accessible Webflow sites found for this token");
	}

	const preferredSiteId = process.env.WEBFLOW_SITE_ID?.trim();
	const selectedSite =
		sites.sites.find((site) => site.id === preferredSiteId) ?? sites.sites[0];

	if (!selectedSite?.id) {
		throw new Error("Could not determine site ID to scan collections");
	}

	console.log(
		`[INFO] Scanning site: ${selectedSite.displayName} (${selectedSite.id})`,
	);
	if (preferredSiteId && preferredSiteId !== selectedSite.id) {
		console.warn(
			`[WARN] WEBFLOW_SITE_ID=${preferredSiteId} not found, falling back to ${selectedSite.id}`,
		);
	}

	const collectionsResp = await withRateLimitRetry(
		() => client.collections.list(selectedSite.id),
		"collections.list",
	);
	const collections = collectionsResp.collections ?? [];
	console.log(`[INFO] Found ${collections.length} collections`);

	const allItems: CachedItem[] = [];
	for (const collection of collections) {
		const collectionName = collection.displayName || collection.slug || collection.id;
		const items = await listAllItems(client, collection.id, collectionName);
		console.log(
			`[INFO] Indexed ${items.length} items from ${collectionName} (${collection.id})`,
		);
		allItems.push(...items);
	}

	const itemById = new Map(allItems.map((item) => [item.id, item]));
	for (const target of TARGETS) {
		if (!itemById.has(target.itemId)) {
			throw new Error(
				`Target item ${target.itemId} was not found in scanned collections`,
			);
		}
	}

	const references = findReferences(allItems, targetIds).filter(
		(ref) => !targetIds.has(ref.itemId),
	);
	const referencesByTarget = new Map<string, number>();
	for (const ref of references) {
		referencesByTarget.set(
			ref.targetId,
			(referencesByTarget.get(ref.targetId) ?? 0) + 1,
		);
	}

	console.log(`[INFO] Found ${references.length} referencing links`);
	for (const targetId of targetIds) {
		console.log(
			`[INFO] References to ${targetId}: ${referencesByTarget.get(targetId) ?? 0}`,
		);
	}

	const unlinkPlans = buildUnlinkPlans(references, itemById);
	for (const [targetId, fields] of Object.entries(TARGET_OUTBOUND_FIELDS_TO_CLEAR)) {
		const item = itemById.get(targetId);
		if (!item) continue;
		const updatedFieldData: Record<string, unknown> = { ...item.fieldData };
		const removedByField: Record<string, string[]> = {};
		let changed = false;
		for (const fieldSlug of fields) {
			const value = updatedFieldData[fieldSlug];
			if (Array.isArray(value) && value.length > 0) {
				removedByField[fieldSlug] = value.filter(
					(v): v is string => typeof v === "string",
				);
				updatedFieldData[fieldSlug] = [];
				changed = true;
			} else if (typeof value === "string" && value) {
				removedByField[fieldSlug] = [value];
				updatedFieldData[fieldSlug] = null;
				changed = true;
			}
		}
		if (!changed) continue;
		unlinkPlans.push({
			itemId: item.id,
			collectionId: item.collectionId,
			collectionName: item.collectionName,
			itemName: getItemName(item.fieldData),
			originalFieldData: item.fieldData,
			updatedFieldData,
			removedByField,
		});
	}
	const backupPath = await saveUnlinkBackup(unlinkPlans);
	console.log(`[INFO] Unlink plans count: ${unlinkPlans.length}`);
	console.log(`[INFO] Unlink backup saved to: ${backupPath}`);

	const targetMutations = buildMutations([], TARGETS, itemById);
	const worksCollectionIds = new Set(
		collections
			.filter(
				(col) => (col.displayName || col.slug || "").toLowerCase() === "works",
			)
			.map((col) => col.id),
	);
	const relatedWorksMutations: PendingMutation[] = unlinkPlans
		.filter((plan) => worksCollectionIds.has(plan.collectionId))
		.map((plan) => ({
			itemId: plan.itemId,
			collectionId: plan.collectionId,
			collectionName: plan.collectionName,
			itemName: plan.itemName,
			reason: "reference",
			referencedTargetIds: Object.values(plan.removedByField).flat(),
		}));

	let unlinked = 0;
	let changed = 0;
	let unpublished = 0;
	let alreadyDraft = 0;
	let failed = 0;
	const failedIds: string[] = [];

	// Phase 1: unlink references first.
	for (const plan of unlinkPlans) {
		console.log(
			`[PLAN] Unlink ${plan.collectionName} :: ${plan.itemName} (${plan.itemId})`,
			plan.removedByField,
		);
		if (dryRun) continue;
		const item = itemById.get(plan.itemId);
		if (!item) continue;
		try {
			await updateItemFieldData(client, item, plan.updatedFieldData);
			item.fieldData = plan.updatedFieldData;
			unlinked += 1;
		} catch (error) {
			console.error(
				`[ERROR] Failed to unlink ${plan.collectionName} :: ${plan.itemName} (${plan.itemId})`,
				error,
			);
			failed += 1;
			failedIds.push(plan.itemId);
		}
	}

	// Phase 2: unpublish target items.
	for (const mutation of targetMutations) {
		const cached = itemById.get(mutation.itemId);
		if (!cached) continue;
		const reasonDetail =
			mutation.reason === "reference"
				? `references ${mutation.referencedTargetIds.join(", ")}`
				: "target item";
		console.log(
			`[PLAN] Draft ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId}) [${reasonDetail}]`,
		);

		if (dryRun) {
			if (cached.isDraft) alreadyDraft += 1;
			continue;
		}

		try {
			if (cached.isDraft) {
				alreadyDraft += 1;
				console.log(
					`[SKIP] Already draft: ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
				);
			} else {
				await updateItemToDraft(client, mutation, cached);
				cached.isDraft = true;
				changed += 1;
			}

			const didUnpublish = await unpublishLiveItem(client, mutation);
			if (didUnpublish) {
				unpublished += 1;
				console.log(
					`[DONE] Unpublished target live item: ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
				);
			} else {
				console.log(
					`[SKIP] Target live item already unpublished: ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
				);
			}
		} catch (error) {
			console.error(
				`[ERROR] Failed to draft/unpublish target ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
				error,
			);
			failed += 1;
			failedIds.push(mutation.itemId);
		}
	}

	// Phase 3: unpublish related works afterwards.
	for (const mutation of relatedWorksMutations) {
		const cached = itemById.get(mutation.itemId);
		if (!cached) continue;

		if (dryRun) {
			console.log(
				`[PLAN] Unpublish live ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
			);
			continue;
		}

		try {
			const didUnpublish = await unpublishLiveItem(client, mutation);
			if (didUnpublish) {
				unpublished += 1;
				console.log(
					`[DONE] Unpublished live item: ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
				);
			} else {
				console.log(
					`[SKIP] Live item already unpublished: ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
				);
			}
		} catch (error) {
			console.error(
				`[ERROR] Failed to unpublish related work ${mutation.collectionName} :: ${mutation.itemName} (${mutation.itemId})`,
				error,
			);
			failed += 1;
			failedIds.push(mutation.itemId);
		}
	}

	console.log("[INFO] ----- SUMMARY -----");
	console.log(`[INFO] Mode: ${dryRun ? "dry-run" : "execute"}`);
	console.log(`[INFO] Total referencing links found: ${references.length}`);
	console.log(`[INFO] Unlinked items: ${unlinked}`);
	console.log(`[INFO] Target items planned: ${targetMutations.length}`);
	console.log(
		`[INFO] Related works planned for unpublish: ${relatedWorksMutations.length}`,
	);
	console.log(`[INFO] Items changed: ${changed}`);
	console.log(`[INFO] Live items unpublished: ${unpublished}`);
	console.log(`[INFO] Items already draft: ${alreadyDraft}`);
	console.log(`[INFO] Failures: ${failed}`);
	if (failedIds.length > 0) {
		console.log(`[INFO] Failed item IDs: ${failedIds.join(", ")}`);
	}

	if (!dryRun && failed > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error("[ERROR] One-time unpublish script failed", error);
	process.exit(1);
});
