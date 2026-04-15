/**
 * Batch Summarization Extension
 *
 * Handles very large contexts (>200k tokens) by batching the summarization.
 * Works around context window limits by splitting large messages.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface BatchSummarizerSettings {
	summarizationModel?: string;
	threshold?: number;
	batchSizeTokens?: number;
	maxSummaryTokens?: number;
}

const DEFAULT_SETTINGS: Required<BatchSummarizerSettings> = {
	summarizationModel: "google/gemini-3.1-flash-lite-preview",  // 1M context on OpenRouter!
	threshold: 0.8,
	batchSizeTokens: 15000,
	maxSummaryTokens: 65500,  // 65.5k tokens (matches model's max output)
	batchThreshold: 750000,  // Only batch if content exceeds 750k tokens
};

// Context window overrides - use OpenRouter's actual values (not pi registry)
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
	// Gemini 3.1 Flash Lite: OpenRouter says 1,048,576 (1M)
	"google/gemini-3.1-flash-lite-preview": 1000000,
	// Qwen 3.6: Also 1M context
	"qwen/qwen3.6-plus-preview": 900000,
	"qwen/qwen3.6-plus-preview:free": 900000,
};

const SUMMARIZATION_PROMPT = `Summarize the conversation above. Be detailed but concise.

**Goal**: [main objective]
**Progress**: [completed/in-progress tasks]
**Decisions**: [key choices made]
**Context**: [data needed to continue]
**Next**: [what to do next]`;

const UPDATE_SUMMARIZATION_PROMPT = `Update this summary with new information. Keep it concise.

Add new progress/decisions. Condense old info if needed.`;

// ============================================================================
// Helper Functions
// ============================================================================

function getMessageText(msg: unknown): string {
	const msgAny = msg as { content?: unknown };
	
	if (typeof msgAny.content === "string") {
		return msgAny.content;
	}
	
	if (Array.isArray(msgAny.content)) {
		let text = "";
		for (const block of msgAny.content) {
			if (block && typeof block === "object") {
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && b.text) {
					text += b.text + "\n\n";
				}
			}
		}
		return text.trim();
	}
	
	return "";
}

function splitLargeMessage(msg: unknown, maxChars: number): unknown[] {
	const text = getMessageText(msg);
	
	if (text.length <= maxChars) {
		return [msg];
	}
	
	const numParts = Math.ceil(text.length / maxChars);
	const parts: unknown[] = [];
	
	for (let i = 0; i < numParts; i++) {
		const start = i * maxChars;
		const end = Math.min(start + maxChars, text.length);
		const partText = text.slice(start, end);
		const prefix = i === 0 ? "" : "\n\n[... continued ...]\n\n";
		const suffix = i === numParts - 1 ? "" : "\n\n[... continues ...]";
		
		parts.push({
			...msg,
			content: [{ type: "text", text: prefix + partText + suffix }]
		});
	}
	
	return parts;
}

function createBatches(messages: unknown[], maxTokens: number, overheadTokens: number): unknown[][] {
	const batches: unknown[][] = [];
	let currentBatch: unknown[] = [];
	
	const maxChars = maxTokens * 3;
	const overhead = overheadTokens * 3;
	let currentChars = overhead;

	for (const msg of messages) {
		const text = getMessageText(msg);
		const chars = Math.ceil(text.length * 1.4);

		if (text.length > maxChars / 1.4) {
			if (currentBatch.length > 0) {
				batches.push([...currentBatch]);
				currentBatch = [];
				currentChars = overhead;
			}
			
			const available = Math.floor((maxChars - overhead) / 1.4);
			const parts = splitLargeMessage(msg, available);
			
			for (const part of parts) {
				const partText = getMessageText(part);
				const partChars = Math.ceil(partText.length * 1.4);
				
				if (currentChars + partChars > maxChars && currentBatch.length > 0) {
					batches.push([...currentBatch]);
					currentBatch = [];
					currentChars = overhead;
				}
				currentBatch.push(part);
				currentChars += partChars;
			}
			continue;
		}

		if (currentChars + chars > maxChars && currentBatch.length > 0) {
			batches.push([...currentBatch]);
			currentBatch = [];
			currentChars = overhead;
		}
		currentBatch.push(msg);
		currentChars += chars;
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

async function getModel(
	ctx: ExtensionContext,
	modelId: string
): Promise<{ model: NonNullable<ReturnType<typeof ctx.modelRegistry.find>>; apiKey?: string; headers?: Record<string, string> } | null> {
	// Try exact match first
	let model = ctx.modelRegistry?.find("openrouter", modelId);
	
	// Try with :free suffix if not found
	if (!model) {
		model = ctx.modelRegistry?.find("openrouter", modelId + ":free");
	}
	
	if (!model) {
		console.log("[batch] Model not found: openrouter/" + modelId);
		return null;
	}
	
	console.log("[batch] Found model: " + model.id + ", contextWindow=" + model.contextWindow);
	
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;
	
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

async function summarizeBatch(
	messages: unknown[],
	model: { id: string; contextWindow?: number },
	apiKey: string,
	headers: Record<string, string> | undefined,
	isUpdate: boolean,
	previousSummary: string | null,
	batchNum: number,
	totalBatches: number,
	isLast: boolean,
	maxSummaryTokens: number,
	contextCW?: number
): Promise<string> {
	const text = serializeConversation(convertToLlm(messages));
	const contentTokens = Math.ceil(text.length / 4);

	let prompt = "<conversation>\n" + text + "\n</conversation>\n\n";

	if (previousSummary) {
		prompt += "<previous-summary>\n" + previousSummary + "\n</previous-summary>\n\n";
		prompt += UPDATE_SUMMARIZATION_PROMPT;
	} else {
		prompt += SUMMARIZATION_PROMPT;
	}

	if (!isLast) {
		prompt += "\n\n**Note:** Batch " + batchNum + "/" + totalBatches + ".";
	}

	const cw = contextCW || 180000;
	const promptTokens = Math.ceil(prompt.length / 4) + (previousSummary ? 15000 : 5000);
	const totalInput = contentTokens + promptTokens;
	const maxTokens = Math.max(2048, Math.min(Math.floor(cw * 0.7) - totalInput, maxSummaryTokens));

	console.log("[batch] Batch " + batchNum + "/" + totalBatches + ": in=" + totalInput + ", out=" + maxTokens);

	if (totalInput > cw * 0.85) {
		throw new Error("Too large: " + totalInput);
	}

	try {
		const response = await complete(
			model,
			{ messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }] },
			{ apiKey, headers, maxTokens }
		);

		if (response.stopReason === "error") {
			throw new Error(response.errorMessage);
		}

		if (response.stopReason === "aborted") {
			throw new Error("Aborted");
		}

		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	} catch (e) {
		console.error("[batch] Error: " + (e instanceof Error ? e.message : String(e)));
		throw e;
	}
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	console.log("[batch-summarizer] Loaded");

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId } = preparation;

		const extSettings = pi.settings?.["batch-summarizer"] as BatchSummarizerSettings | undefined;
		const settings: Required<BatchSummarizerSettings> = {
			summarizationModel: extSettings?.summarizationModel || DEFAULT_SETTINGS.summarizationModel,
			threshold: extSettings?.threshold || DEFAULT_SETTINGS.threshold,
			batchSizeTokens: extSettings?.batchSizeTokens || DEFAULT_SETTINGS.batchSizeTokens,
			maxSummaryTokens: extSettings?.maxSummaryTokens || DEFAULT_SETTINGS.maxSummaryTokens,
			batchThreshold: extSettings?.batchThreshold || DEFAULT_SETTINGS.batchThreshold,
		};

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		console.log("[batch] Tokens: " + tokensBefore + ", Messages: " + allMessages.length);

		if (allMessages.length === 0) return;

		const modelInfo = await getModel(ctx, settings.summarizationModel);
		if (!modelInfo) {
			console.log("[batch] No model");
			return;
		}

		const { model, apiKey, headers } = modelInfo;
		// Check for override (handle both regular and :free variants)
		const cw = CONTEXT_WINDOW_OVERRIDES[model.id] || 
			CONTEXT_WINDOW_OVERRIDES[model.id.replace(":free", "")] || 
			model.contextWindow || 
			180000;

		// Only batch if content exceeds batchThreshold (default 750k tokens)
		if (tokensBefore < settings.batchThreshold) {
			console.log("[batch] Content below batch threshold (" + settings.batchThreshold + "), letting default handle");
			return;
		}

		console.log("[batch] Large context, batching with CW=" + cw);

		// Use 90% of context window for content, 10% for prompt/output overhead
		const batches = createBatches(allMessages, Math.floor(cw * 0.9), 10000);
		console.log("[batch] Created " + batches.length + " batches, batchSize=" + Math.floor(cw * 0.9));

		let summary: string | null = null;

		try {
			for (let i = 0; i < batches.length; i++) {
				console.log("[batch] Batch " + (i + 1) + "/" + batches.length);
				summary = await summarizeBatch(
					batches[i], model, apiKey, headers,
					i > 0, summary, i + 1, batches.length, i === batches.length - 1,
					settings.maxSummaryTokens, cw
				);
			}
		} catch (e) {
			console.error("[batch] Failed: " + (e instanceof Error ? e.message : String(e)));
			ctx.ui?.notify("[batch] Batch failed: " + (e instanceof Error ? e.message : "error"), "error");
			return;
		}

		if (!summary?.trim()) {
			ctx.ui?.notify("[batch] Empty summary", "warning");
			return;
		}

		// Truncate if needed (use maxSummaryTokens as limit)
		const finalTokens = Math.ceil(summary.length / 4);
		const maxAllowed = Math.min(settings.maxSummaryTokens, Math.floor((pi.model?.contextWindow || 200000) * 0.3));

		if (finalTokens > maxAllowed) {
			console.log("[batch] Truncating from " + finalTokens + " to " + maxAllowed + " tokens");
			summary = summary.substring(0, maxAllowed * 4 - 500) + "\n\n[... summary truncated]";
		}

		ctx.ui?.notify("[batch] Done: " + Math.ceil(summary.length / 4) + " tokens", "success");

		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore,
			},
		};
	});
}
