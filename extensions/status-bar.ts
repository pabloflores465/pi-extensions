/**
 * Status Bar Extension - Neovim Lualine Style
 * 
 * Layout: (branch ▲▼) 0.0%/197k | ~/path | cost | model • thinking
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";

const STATUS_BAR_ID = "status-bar";

let currentPath = "";
let gitBranch = "";
let gitStatus = ""; // ▲▼ indicators
let stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000, cost: 0 };
let modelName = "";
let thinkingLevel = "";
let isWorking = false;
let isThinking = false;

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
	let path = fullPath;
	
	if (path.startsWith(home)) {
		path = "~" + path.slice(home.length);
	}
	
	if (path.length > 35) {
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
	
	// Left: git branch with status indicators
	const gitInfo = gitBranch || gitStatus
		? `${gitBranch || ""}${gitStatus}`
		: "";
	const left = gitInfo 
		? `${gitInfo} ${usedPercent}%/${formatTokens(stats.maxContext)}`
		: `${usedPercent}%/${formatTokens(stats.maxContext)}`;
	
	// Center: current path (always show if available)
	const center = currentPath 
		? ` ${shortenPath(currentPath)} `
		: "";
	
	// Right: cost + model
	const costStr = formatCost(stats.cost);
	const right = modelName 
		? `${costStr} | ${modelName} • ${thinkingLevel || "medium"}`
		: costStr;
	
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
				
				let color = "accent";
				if (isWorking) color = "warning";
				else if (isThinking) color = "muted";
				
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

// Sync git info using import.meta.url workaround
async function getGitInfoAsync() {
	const { execSync } = await import("node:child_process");
	try {
		const cwd = process.cwd();
		
		const branch = execSync("git branch --show-current 2>/dev/null || echo ''", { cwd, encoding: "utf8" }).trim();
		gitBranch = branch ? `(${branch})` : "";
		
		const status = execSync("git status --porcelain 2>/dev/null | head -1 || echo ''", { cwd, encoding: "utf8" }).trim();
		if (status) {
			const hasChanges = status.includes(" M") || status.includes("??");
			const hasStaged = /^[A-Z]/.test(status);
			gitStatus = hasChanges ? " ▲" : hasStaged ? " ●" : "";
		} else {
			gitStatus = "";
		}
	} catch {
		gitBranch = "";
		gitStatus = "";
	}
}

export default function (pi: ExtensionAPI) {
	// ── Session start
	pi.on("session_start", async (_event, ctx) => {
		currentPath = "";
		gitBranch = "";
		gitStatus = "";
		modelName = "";
		thinkingLevel = "";
		isWorking = false;
		isThinking = false;
		stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000, cost: 0 };
		
		// Get git info asynchronously
		getGitInfoAsync();
		
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
		
		const readMatch = text.match(/^\/read\s+(\S+)/);
		const editMatch = text.match(/^\/edit\s+(\S+)/);
		const writeMatch = text.match(/^\/write\s+(\S+)/);
		
		const match = readMatch || editMatch || writeMatch;
		if (match) {
			currentPath = match[1]!;
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
