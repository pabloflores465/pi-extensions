/**
 * Large Message Handler Extension
 *
 * Automatically handles oversized user messages by:
 * 1. Saving long messages to a temp file
 * 2. Replacing the message with a /read command
 * 3. The model then reads the file normally
 *
 * This prevents context overflow when sending large content like HTML pages.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_MAX_TOKENS = 100000; // Max tokens before splitting (leave room for context)
const TEMP_FILE_PREFIX = "pi-large-msg-";
const TEMP_FILE_DIR = "pi-large-messages";

interface LargeMessageSettings {
	maxTokens?: number;  // Max tokens before saving to file
	enabled?: boolean;
}

const DEFAULT_SETTINGS: Required<LargeMessageSettings> = {
	maxTokens: 80000,  // Keep well under 200k context to leave room for session
	enabled: true,
};

function getTempDir(): string {
	return join(tmpdir(), TEMP_FILE_DIR);
}

function estimateTokens(text: string): number {
	// Rough estimate: 1 token ≈ 4 characters
	return Math.ceil(text.length / 4);
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		let text = "";
		for (const block of content) {
			if (block && typeof block === "object") {
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && b.text) {
					text += b.text + "\n\n";
				}
			}
		}
		return text.trim();
	}

	return String(content);
}

async function saveToTempFile(content: string): Promise<string> {
	// Create temp directory if it doesn't exist
	const tempDir = getTempDir();
	await mkdir(tempDir, { recursive: true });

	// Generate unique filename
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	const filename = `${TEMP_FILE_PREFIX}${timestamp}-${random}.txt`;
	const filepath = join(tempDir, filename);

	// Save content
	await writeFile(filepath, content, "utf-8");

	console.log(`[large-msg] Saved ${content.length} chars to ${filename}`);

	return filename;
}

async function handleLargeMessage(
	content: unknown,
	maxTokens: number,
	readCommand: string
): Promise<unknown> {
	const text = extractTextFromContent(content);
	const tokens = estimateTokens(text);

	console.log(`[large-msg] Content: ${text.length} chars, ~${tokens} tokens, limit: ${maxTokens}`);

	if (tokens <= maxTokens) {
		console.log(`[large-msg] Content fits, no action needed`);
		return null; // No changes needed
	}

	// Save to temp file
	const filename = await saveToTempFile(text);

	// Return a modified message that reads the file
	return {
		content: [
			{
				type: "text" as const,
				text: `${readCommand} ${filename}\n\n[Note: Large message saved to file, reading it now...]`,
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	console.log("[large-msg] Extension loaded!");

	pi.on("input", async (event, ctx) => {
		// Get settings
		const extSettings = pi.settings?.["large-message-handler"] as LargeMessageSettings | undefined;
		const settings: Required<LargeMessageSettings> = {
			maxTokens: extSettings?.maxTokens || DEFAULT_SETTINGS.maxTokens,
			enabled: extSettings?.enabled !== false,
		};

		if (!settings.enabled) {
			return;
		}

		// Only handle text messages (not with images etc)
		if (!event.text) {
			return;
		}

		const tokens = estimateTokens(event.text);
		const currentModel = pi.model;
		const contextWindow = currentModel?.contextWindow || 200000;
		// Calculate how much room we need to leave for session context
		const roomForContext = Math.floor(contextWindow * 0.5); // Leave 50% for session
		const effectiveMaxTokens = Math.min(settings.maxTokens, roomForContext);

		console.log(`[large-msg] Input: ${event.text.length} chars, ~${tokens} tokens`);
		console.log(`[large-msg] Model context: ${contextWindow}, room for input: ${effectiveMaxTokens}`);

		if (tokens <= effectiveMaxTokens) {
			console.log(`[large-msg] Fits in context, passing through`);
			return;
		}

		console.log(`[large-msg] Content too large, saving to temp file...`);

		try {
			const newContent = await handleLargeMessage(
				event.text,
				effectiveMaxTokens,
				"/read"
			);

			if (newContent) {
				// We need to modify the input to use the file instead
				// Since we can't directly modify the event, we'll use a different approach:
				// Transform the input to a /read command
				const filename = await saveToTempFile(event.text);

				console.log(`[large-msg] Replacing input with /read command`);

				return {
					action: "transform",
					text: "/read " + join(getTempDir(), filename) + "\n\n[Large message saved to file for context efficiency]",
				};
			}
		} catch (error) {
			console.error(`[large-msg] Error handling large message: ${error}`);
		}
	});
}
