/**
 * Status Bar Extension - Neovim Lualine Style
 * 
 * Layout: [mode] path | tokens cost
 * Clean, minimal, informative
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { basename } from "node:path";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORK_FRAMES = ["◐", "◓", "◑", "◒"];
const STATUS_BAR_ID = "status-bar";

type State = "sleeping" | "thinking" | "working" | "done" | "error";

let currentState: State = "sleeping";
let spinnerFrame = 0;
let workFrame = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;
let workingTimeoutId: ReturnType<typeof setTimeout> | null = null;
let errorTimeoutId: ReturnType<typeof setTimeout> | null = null;
let currentPath = "";
let stats = { inputTokens: 0, outputTokens: 0, cost: 0 };

function clearSpinner() {
	if (intervalId) {
		clearInterval(intervalId);
		intervalId = null;
	}
	if (workingTimeoutId) {
		clearTimeout(workingTimeoutId);
		workingTimeoutId = null;
	}
}

function getSpinner(): string {
	return SPINNER_FRAMES[spinnerFrame]!;
}

function getWorkSpinner(): string {
	return WORK_FRAMES[workFrame]!;
}

function getStateIcon(state: State): string {
	switch (state) {
		case "sleeping": return "○";
		case "thinking": return getSpinner();
		case "working": return getWorkSpinner();
		case "done": return "✓";
		case "error": return "✗";
	}
}

function formatCost(cost: number): string {
	if (cost < 0.001) return "$0.00";
	if (cost < 1) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

function buildStatusBar(screenWidth: number): string {
	const stateIcon = getStateIcon(currentState);
	const stateLabel = currentState === "sleeping" ? "idle" : currentState;
	
	// Left section: mode icon + state
	const left = `${stateIcon} ${stateLabel}`;
	
	// Center section: current path (if available)
	const center = currentPath ? ` ${currentPath} ` : "";
	
	// Right section: tokens | cost
	const totalTokens = stats.inputTokens + stats.outputTokens;
	const right = `tokens:${formatTokens(totalTokens)} ${formatCost(stats.cost)}`;
	
	// Calculate available space
	const leftLen = left.length;
	const rightLen = right.length;
	const centerLen = center.length;
	const minGap = 2;
	
	let result: string;
	
	if (screenWidth <= leftLen + rightLen + minGap) {
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
				const screenWidth = width ?? tui.width ?? 80;
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

function showSleeping(ctx: ExtensionContext) {
	currentState = "sleeping";
	clearSpinner();
	updateStatusBar(ctx);
}

function showThinking(ctx: ExtensionContext) {
	currentState = "thinking";
	updateStatusBar(ctx);
}

function showWorking(ctx: ExtensionContext) {
	currentState = "working";
	updateStatusBar(ctx);
}

function showDone(ctx: ExtensionContext) {
	currentState = "done";
	updateStatusBar(ctx);
}

function showError(ctx: ExtensionContext) {
	currentState = "error";
	updateStatusBar(ctx);
}

function startThinkingSpinner(ctx: ExtensionContext) {
	clearSpinner();
	showThinking(ctx);

	intervalId = setInterval(() => {
		if (currentState === "thinking") {
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			updateStatusBar(ctx);
		} else if (currentState === "working") {
			workFrame = (workFrame + 1) % WORK_FRAMES.length;
			updateStatusBar(ctx);
		}
	}, 80);
}

function transitionToWorking(ctx: ExtensionContext) {
	if (workingTimeoutId) {
		clearTimeout(workingTimeoutId);
	}

	workingTimeoutId = setTimeout(() => {
		if (currentState === "thinking") {
			showWorking(ctx);
		}
	}, 500);
}

function updateStats(ctx: ExtensionContext) {
	try {
		const sessionStats = ctx.sessionManager.getSessionStats();
		if (sessionStats) {
			stats = {
				inputTokens: sessionStats.promptTokens || 0,
				outputTokens: sessionStats.completionTokens || 0,
				cost: sessionStats.estimatedCost || 0,
			};
		}
	} catch {
		// Stats not available
	}
}

export default function (pi: ExtensionAPI) {
	// ── Session start
	pi.on("session_start", async (_event, ctx) => {
		currentPath = "";
		stats = { inputTokens: 0, outputTokens: 0, cost: 0 };
		showSleeping(ctx);
	});

	// ── Agent loop
	pi.on("agent_start", async (_event, ctx) => {
		if (errorTimeoutId) {
			clearTimeout(errorTimeoutId);
			errorTimeoutId = null;
		}
		if (currentState === "sleeping") {
			startThinkingSpinner(ctx);
			transitionToWorking(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (currentState !== "sleeping") {
			showDone(ctx);
			setTimeout(() => {
				showSleeping(ctx);
			}, 1500);
		}
	});

	// ── Tool execution
	pi.on("tool_execution_start", async (_event, ctx) => {
		if (errorTimeoutId) {
			clearTimeout(errorTimeoutId);
			errorTimeoutId = null;
		}
		showWorking(ctx);
	});

	pi.on("tool_execution_update", async (_event, ctx) => {
		if (currentState === "working") {
			showThinking(ctx);
		}
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (errorTimeoutId) {
			clearTimeout(errorTimeoutId);
			errorTimeoutId = null;
		}
		
		showDone(ctx);
		
		errorTimeoutId = setTimeout(() => {
			if (currentState === "done") {
				showThinking(ctx);
			}
		}, 500);
	});

	// ── Update path when working with files
	pi.on("input", async (event, ctx) => {
		const text = event.text;
		
		const readMatch = text.match(/^\/read\s+(.+)/i);
		const editMatch = text.match(/^\/edit\s+(.+)/i);
		const writeMatch = text.match(/^\/write\s+(.+)/i);
		
		const match = readMatch || editMatch || writeMatch;
		if (match) {
			const fullPath = match[1]!.split(/\s/)[0]!;
			currentPath = basename(fullPath);
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
		clearSpinner();
		ctx.ui.setWidget(STATUS_BAR_ID, undefined);
	});

	// ── Commands
	pi.registerCommand("status", {
		description: "Show current status bar info",
		handler: async (_args, ctx) => {
			updateStats(ctx);
			const totalTokens = stats.inputTokens + stats.outputTokens;
			ctx.ui.notify(
				`State: ${currentState}\nPath: ${currentPath || "none"}\nTokens: ${formatTokens(totalTokens)}\nCost: ${formatCost(stats.cost)}`,
				"info"
			);
		},
	});
}
