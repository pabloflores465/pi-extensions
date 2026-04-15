/**
 * Clear Command Extension
 *
 * Adds a /clear command that clears the conversation history
 * and starts a fresh session, similar to Claude Code behavior.
 *
 * Usage:
 *   /clear - Clear history and start fresh immediately
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Handle :q to quit (vim-style)
	pi.on("input", async (event, ctx) => {
		if (event.text.trim() === ":q") {
			ctx.shutdown();
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.registerCommand("clear", {
		description: "Clear conversation history and start a fresh session",
		handler: async (_args, ctx) => {
			// Create new session immediately without confirmation
			const result = await ctx.newSession();

			if (result.cancelled) {
				ctx.ui.notify("Clear cancelled by extension", "info");
			} else {
				ctx.ui.notify("History cleared. Starting fresh session.", "success");
			}
		},
	});
}
