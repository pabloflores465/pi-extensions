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

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_MAX_TOKENS = 100000;
const TEMP_FILE_PREFIX = "pi-large-msg-";
const TEMP_FILE_DIR = "large-messages";

interface LargeMessageSettings {
	maxTokens?: number;
	enabled?: boolean;
}

const DEFAULT_SETTINGS: Required<LargeMessageSettings> = {
	maxTokens: 100000,
	enabled: true,
};

function estimateTokens(text: string): number {
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
	return pi.sessionDir || process.cwd();
}

async function saveToTempFile(content: string, pi: ExtensionAPI): Promise<string> {
	const messagesDir = join(getMessagesDir(pi), TEMP_FILE_DIR);
	await mkdir(messagesDir, { recursive: true });

	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	const filename = `${TEMP_FILE_PREFIX}${timestamp}-${random}.txt`;
	const filepath = join(messagesDir, filename);

	await writeFile(filepath, content, "utf-8");

	console.log(`[large-msg] Saved ${content.length} chars to ${filepath}`);

	return filepath;
}

export default function (pi: ExtensionAPI) {
	console.log("[large-msg] Extension loaded!");

	pi.on("input", async (event) => {
		const extSettings = pi.settings?.["large-message-handler"] as LargeMessageSettings | undefined;
		const settings: Required<LargeMessageSettings> = {
			maxTokens: extSettings?.maxTokens || DEFAULT_SETTINGS.maxTokens,
			enabled: extSettings?.enabled !== false,
		};

		if (!settings.enabled || !event.text) {
			return;
		}

		const text = extractTextFromContent(event.text);
		const tokens = estimateTokens(text);
		const currentModel = pi.model;
		const contextWindow = currentModel?.contextWindow || 200000;
		const roomForContext = Math.floor(contextWindow * 0.5);
		const effectiveMaxTokens = Math.min(settings.maxTokens, roomForContext);

		if (tokens <= effectiveMaxTokens) {
			return;
		}

		try {
			const filepath = await saveToTempFile(text, pi);
			const relativePath = filepath.replace(process.cwd() + "/", "");
            const fileContent = await readFile(filepath, "utf-8");
            const lines = fileContent.split("\n").length;

			return {
				action: "transform",
				text: `/read ${relativePath}\n\n[LARGE MESSAGE DETECTED: ~${tokens} tokens, ${lines} lines]\nThis file is too large for the immediate context. Please interact with it using surgical tools:\n1. Use 'read_file' with 'start_line' and 'end_line' to examine specific sections.\n2. Use 'grep_search' to find relevant symbols or patterns.\n3. Do not attempt to read the entire file at once to avoid context overflow.`,
			};
		} catch (error) {
			console.error(`[large-msg] Error handling large message: ${error}`);
		}
	});
}
