/**
 * Large Message Handler Extension
 *
 * Automatically handles oversized user messages by:
 * 1. Saving long messages to a temp file in the agent's session directory
 * 2. Replacing the message with a /read command
 * 3. The model then reads the file normally
 *
 * This prevents context overflow when sending large content like HTML pages.
 * 
 * Files are saved to the session directory so the model can access them.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_MAX_TOKENS = 100000; // Max tokens before splitting (leave room for context)
const TEMP_FILE_PREFIX = "pi-large-msg-";
const TEMP_FILE_DIR = "large-messages";

interface LargeMessageSettings {
	maxTokens?: number;  // Max tokens before saving to file
	enabled?: boolean;
}

const DEFAULT_SETTINGS: Required<LargeMessageSettings> = {
	maxTokens: 100000,  // Keep well under 200k context to leave room for session
	enabled: true,
};

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

function getMessagesDir(pi: ExtensionAPI): string {
	// Use the session directory if available, otherwise use cwd
	return pi.sessionDir || process.cwd();
}

async function saveToTempFile(content: string, pi: ExtensionAPI): Promise<string> {
	// Create messages directory in the session directory
	const messagesDir = join(getMessagesDir(pi), TEMP_FILE_DIR);
	await mkdir(messagesDir, { recursive: true });

	// Generate unique filename
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	const filename = `${TEMP_FILE_PREFIX}${timestamp}-${random}.txt`;
	const filepath = join(messagesDir, filename);

	// Save content
	await writeFile(filepath, content, "utf-8");

	console.log(`[large-msg] Saved ${content.length} chars to ${filepath}`);

	return filepath;
}

export default function (pi: ExtensionAPI) {
	console.log("[large-msg] Extension loaded!");

	pi.on("input", async (event) => {
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

		const text = extractTextFromContent(event.text);
		const tokens = estimateTokens(text);
		const currentModel = pi.model;
		const contextWindow = currentModel?.contextWindow || 200000;
		// Calculate how much room we need to leave for session context
		const roomForContext = Math.floor(contextWindow * 0.5); // Leave 50% for session
		const effectiveMaxTokens = Math.min(settings.maxTokens, roomForContext);

		console.log(`[large-msg] Input: ${text.length} chars, ~${tokens} tokens`);
		console.log(`[large-msg] Model context: ${contextWindow}, room for input: ${effectiveMaxTokens}`);

		if (tokens <= effectiveMaxTokens) {
			console.log(`[large-msg] Fits in context, passing through`);
			return;
		}

		console.log(`[large-msg] Content too large, saving to session directory...`);

		try {
			const filepath = await saveToTempFile(text, pi);
			const relativePath = filepath.replace(process.cwd() + "/", "");

			console.log(`[large-msg] Replacing input with /read command for ${relativePath}`);

			return {
				action: "transform",
				text: `/read ${relativePath}\n\n[Large message (${text.length} chars, ~${tokens} tokens) saved to file for context efficiency. The file will be read automatically.]`,
			};
		} catch (error) {
			console.error(`[large-msg] Error handling large message: ${error}`);
		}
	});
}
