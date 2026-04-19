/**
 * Status Bar Extension - Neovim Lualine Style
 * 
 * Layout: (branch) 0.0%/197k (auto) | path | model • thinking
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";

const STATUS_BAR_ID = "status-bar";

let currentPath = "";
let gitBranch = "";
let stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000 };
let modelName = "";
let thinkingLevel = "";
let isWorking = false;
let isThinking = false;

function formatTokens(tokens: number): string {
	if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

function shortenPath(fullPath: string): string {
	const home = homedir();
	let path = fullPath;
	
	if (path.startsWith(home)) {
		path = "~" + path.slice(home.length);
	}
	
	// Shorten if too long
	if (path.length > 40) {
		const base = basename(path);
		const dir = dirname(path);
		if (dir.length > 20) {
			return ".../" + base;
		}
	}
	return path;
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
	
	// Center: current path (only if working/thinking)
	const center = (isWorking || isThinking) && currentPath 
		? ` ${shortenPath(currentPath)} `
		: "";
	
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
		result = left + " " + right.slice(0, Math.max(0, screenWidth - leftLen - 1));
	} else if (screenWidth <= leftLen + centerLen + rightLen + minGap * 2) {
		const availForCenter = screenWidth - leftLen - rightLen - minGap * 2;
		const truncatedCenter = centerLen > availForCenter && availForCenter > 0
			? center.slice(0, availForCenter)
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
				
				let color = "green";
				if (isWorking) color = "yellow";
				else if (isThinking) color = "accent";
				
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
			};
		}
	} catch {
		// Stats not available
	}
	
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
		isWorking = false;
		isThinking = false;
		stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000 };
		updateStats(ctx);
		updateStatusBar(ctx);
	});

	// ── Agent loop
	pi.on("agent_start", async (_event, ctx) => {
		isThinking = true;
		isWorking = false;
		updateStats(ctx);
		updateStatusBar(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		isThinking = false;
		isWorking = false;
		updateStatusBar(ctx);
	});

	// ── Tool execution
	pi.on("tool_execution_start", async (_event, ctx) => {
		isWorking = true;
		isThinking = false;
		updateStatusBar(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		isWorking = false;
		updateStats(ctx);
		updateStatusBar(ctx);
	});

	// ── Track file paths
	pi.on("input", async (event, ctx) => {
		const text = event.text;
		
		// Extract file paths from commands
		const readMatch = text.match(/^\/read\s+(\S+)/);
		const editMatch = text.match(/^\/edit\s+(\S+)/);
		const writeMatch = text.match(/^\/write\s+(\S+)/);
		
		const match = readMatch || editMatch || writeMatch;
		if (match) {
			currentPath = match[1]!;
			updateStatusBar(ctx);
		}
		
		// Track git branch
		const branchMatch = text.match(/\(?(main|master|develop|HEAD)\)?/);
		if (branchMatch && !gitBranch) {
			gitBranch = `(${branchMatch[1]})`;
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
				`Path: ${currentPath || "none"}\nBranch: ${gitBranch || "none"}\nTokens: ${formatTokens(totalTokens)}/${formatTokens(stats.maxContext)}\nModel: ${modelName} • ${thinkingLevel}`,
				"info"
			);
		},
	});
}
