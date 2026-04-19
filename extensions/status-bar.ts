/**
 * Status Bar Extension - Neovim Lualine Style
 * 
 * Layout: [git] 0.0%/197k (auto) | path | model • thinking
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";

const STATUS_BAR_ID = "status-bar";

type State = "sleeping" | "thinking" | "working" | "done" | "error";

let currentState: State = "sleeping";
let currentPath = "";
let gitBranch = "";
let stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000, cost: 0 };
let modelName = "";
let thinkingLevel = "";

function formatTokens(tokens: number): string {
	if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

function formatCost(cost: number): string {
	if (cost < 0.001) return "$0";
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

function shortenPath(fullPath: string): string {
	const home = homedir();
	if (fullPath.startsWith(home)) {
		return "~" + fullPath.slice(home.length);
	}
	// Shorten dirname
	const dir = dirname(fullPath);
	const base = basename(fullPath);
	if (dir.length > 20) {
		return ".../" + base;
	}
	return fullPath;
}

function buildStatusBar(screenWidth: number): string {
	const totalTokens = stats.inputTokens + stats.outputTokens;
	const usedPercent = stats.maxContext > 0 
		? ((totalTokens / stats.maxContext) * 100).toFixed(1)
		: "0.0";
	
	// Left: git branch + stats
	const left = gitBranch 
		? `${gitBranch} ${usedPercent}%/${formatTokens(stats.maxContext)} (auto)`
		: `${usedPercent}%/${formatTokens(stats.maxContext)} (auto)`;
	
	// Center: current path
	const center = currentPath ? ` ${shortenPath(currentPath)} ` : "";
	
	// Right: model • thinking
	const right = modelName 
		? `${modelName} • ${thinkingLevel || "medium"}`
		: "";
	
	// Calculate
	const leftLen = left.length;
	const rightLen = right.length;
	const centerLen = center.length;
	const minGap = 2;
	
	let result: string;
	
	if (screenWidth <= leftLen + rightLen + minGap) {
		// Minimal: left + truncated right
		result = left + " " + right.slice(0, Math.max(0, screenWidth - leftLen - 1));
	} else if (screenWidth <= leftLen + centerLen + rightLen + minGap * 2) {
		const availForCenter = screenWidth - leftLen - rightLen - minGap * 2;
		const truncatedCenter = centerLen > availForCenter
			? center.slice(0, Math.max(0, availForCenter))
			: center;
		result = left + " " + truncatedCenter + " ".repeat(minGap) + right;
	} else {
		const availForCenter = screenWidth - leftLen - rightLen - minGap * 2;
		const filler = " ".repeat(Math.max(0, availForCenter));
		result = left + " " + center + filler + " ".repeat(minGap) + right;
	}
	
	if (result.length > screenWidth) {
		result = result.slice(0, screenWidth);
	}
	
	return result;
}

function updateStatusBar(ctx: ExtensionContext) {
	ctx.ui.setWidget(STATUS_BAR_ID, (tui: TUI, theme: { fg: (color: string, text: string) => string }) => {
		return {
			render: (width?: number) => {
				const screenWidth = width ?? tui.width ?? 120;
				const statusText = buildStatusBar(screenWidth);
				
				let color = "accent";
				if (currentState === "error") color = "red";
				else if (currentState === "done") color = "green";
				else if (currentState === "working") color = "yellow";
				
				return [theme.fg(color, statusText)];
			},
			invalidate: () => {},
		};
	}, { placement: "belowEditor" });
}

function updateStats(ctx: ExtensionContext) {
	try {
		const sessionStats = ctx.sessionManager.getSessionStats();
		if (sessionStats) {
			stats = {
				inputTokens: sessionStats.promptTokens || 0,
				outputTokens: sessionStats.completionTokens || 0,
				maxContext: sessionStats.maxContext || 200000,
				cost: sessionStats.estimatedCost || 0,
			};
		}
	} catch {
		// Stats not available
	}
	
	// Get model info
	try {
		const state = ctx.sessionManager.getSessionState?.();
		if (state?.model) {
			modelName = state.model;
		}
		if (state?.thinkingLevel) {
			thinkingLevel = state.thinkingLevel;
		}
	} catch {
		// Model info not available
	}
}

export default function (pi: ExtensionAPI) {
	// ── Session start
	pi.on("session_start", async (_event, ctx) => {
		currentPath = "";
		gitBranch = "";
		modelName = "";
		thinkingLevel = "";
		stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000, cost: 0 };
		updateStats(ctx);
		updateStatusBar(ctx);
	});

	// ── Agent loop
	pi.on("agent_start", async (_event, ctx) => {
		currentState = "thinking";
		updateStats(ctx);
		updateStatusBar(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentState = "done";
		updateStatusBar(ctx);
		setTimeout(() => {
			currentState = "sleeping";
			updateStatusBar(ctx);
		}, 1500);
	});

	// ── Tool execution
	pi.on("tool_execution_start", async (_event, ctx) => {
		currentState = "working";
		updateStatusBar(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		currentState = "done";
		updateStatusBar(ctx);
	});

	// ── Update path from git commands
	pi.on("input", async (event, ctx) => {
		const text = event.text;
		
		// Track git branch
		if (text.includes("git") && text.includes("branch")) {
			const branchMatch = text.match(/current branch:?\s*(\S+)/i);
			if (branchMatch) {
				gitBranch = `(${branchMatch[1]})`;
			}
		}
		
		// Track file paths from commands
		const readMatch = text.match(/^\/read\s+(.+)/i);
		const editMatch = text.match(/^\/edit\s+(.+)/i);
		const writeMatch = text.match(/^\/write\s+(.+)/i);
		const bashMatch = text.match(/\s(\/[^\s]+)/);
		
		const match = readMatch || editMatch || writeMatch || bashMatch;
		if (match) {
			currentPath = match[1]!.split(/\s/)[0]!;
			updateStatusBar(ctx);
		}
	});

	// ── Update stats on turn end
	pi.on("turn_end", async (_event, ctx) => {
		updateStats(ctx);
		updateStatusBar(ctx);
	});

	// ── Cleanup
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(STATUS_BAR_ID, undefined);
	});

	// ── Commands
	pi.registerCommand("status", {
		description: "Show current status bar info",
		handler: async (_args, ctx) => {
			updateStats(ctx);
			const totalTokens = stats.inputTokens + stats.outputTokens;
			ctx.ui.notify(
				`Path: ${currentPath || "none"}\nBranch: ${gitBranch || "none"}\nTokens: ${formatTokens(totalTokens)}/${formatTokens(stats.maxContext)}\nCost: ${formatCost(stats.cost)}\nModel: ${modelName} • ${thinkingLevel}`,
				"info"
			);
		},
	});
}
