/**
 * Status Bar Extension - Neovim Airline Style
 * 
 * Shows: state icon | branch | context% | path | cost | model • thinking
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";

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
let gitBranch = "";
let gitStatus = ""; // ▲▼● indicators
let stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000, cost: 0 };
let modelName = "";
let thinkingLevel = "";
let loadedSkills: Set<string> = new Set();

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
	
	if (path.length > 30) {
		const base = basename(path);
		const dir = dirname(path);
		if (dir.length > 18) {
			return ".../" + base;
		}
	}
	return path;
}

function getStateIcon(): string {
	switch (currentState) {
		case "sleeping": return "○";
		case "thinking": return getSpinner();
		case "working": return getWorkSpinner();
		case "done": return "✓";
		case "error": return "✗";
	}
}

function getStateLabel(): string {
	switch (currentState) {
		case "sleeping": return "sleeping";
		case "thinking": return "thinking";
		case "working": return "working";
		case "done": return "done";
		case "error": return "error";
	}
}

function buildStatusBar(screenWidth: number): string {
	const totalTokens = stats.inputTokens + stats.outputTokens;
	const usedPercent = stats.maxContext > 0 
		? ((totalTokens / stats.maxContext) * 100).toFixed(1)
		: "0.0";
	
	// State icon + label
	const stateIcon = getStateIcon();
	const stateLabel = getStateLabel();
	
	// Git info
	const gitInfo = gitBranch || gitStatus
		? `${gitBranch || ""}${gitStatus}`
		: "";
	
	// Build segments
	const statePart = `${stateIcon} ${stateLabel}`;
	const gitPart = gitInfo;
	const contextPart = `${usedPercent}%/${formatTokens(stats.maxContext)}`;
	const pathPart = currentPath ? shortenPath(currentPath) : "";
	const costPart = formatCost(stats.cost);
	const modelPart = modelName ? `${modelName} • ${thinkingLevel || "medium"}` : "";
	
	// Combine: state | git | context | path | cost | model
	// Try to fit as much as possible
	const parts: { text: string; priority: number }[] = [
		{ text: statePart, priority: 1 },
		{ text: gitPart, priority: 2 },
		{ text: contextPart, priority: 3 },
		{ text: pathPart, priority: 4 },
		{ text: costPart, priority: 5 },
		{ text: modelPart, priority: 6 },
	].filter(p => p.text);
	
	// Build from left to right, truncating as needed
	let result = "";
	let remaining = screenWidth;
	
	for (let i = 0; i < parts.length && remaining > 0; i++) {
		const part = parts[i]!;
		const separator = i > 0 ? " | " : "";
		const sepLen = i > 0 ? 3 : 0;
		
		if (part.text.length + sepLen > remaining) {
			// Truncate this part
			const availForText = Math.max(0, remaining - sepLen);
			if (availForText > 3) {
				result += separator + part.text.slice(0, availForText);
			}
			break;
		} else {
			result += separator + part.text;
			remaining -= part.text.length + sepLen;
		}
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
				if (currentState === "error") color = "error";
				else if (currentState === "done") color = "success";
				else if (currentState === "working") color = "warning";
				else if (currentState === "thinking") color = "muted";
				
				return [theme.fg(color, statusText)];
			},
			invalidate: () => {},
		};
	}, { placement: "belowEditor" });
}

function startThinkingSpinner(ctx: ExtensionContext) {
	clearSpinner();
	currentState = "thinking";
	updateStatusBar(ctx);

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
			currentState = "working";
			updateStatusBar(ctx);
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

function scanSkills() {
	const commands = pi.getCommands();
	for (const cmd of commands) {
		if (cmd.source === "skill") {
			loadedSkills.add(cmd.name);
		}
	}
}

async function getGitInfo() {
	try {
		const { execSync } = await import("node:child_process");
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
		loadedSkills = new Set();
		stats = { inputTokens: 0, outputTokens: 0, maxContext: 200000, cost: 0 };
		currentState = "sleeping";
		
		getGitInfo();
		updateStats(ctx);
		updateStatusBar(ctx);
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
			currentState = "done";
			updateStatusBar(ctx);
			setTimeout(() => {
				currentState = "sleeping";
				updateStatusBar(ctx);
			}, 1500);
		}
	});

	// ── Tool execution
	pi.on("tool_execution_start", async (_event, ctx) => {
		if (errorTimeoutId) {
			clearTimeout(errorTimeoutId);
			errorTimeoutId = null;
		}
		currentState = "working";
		updateStatusBar(ctx);
	});

	pi.on("tool_execution_update", async (_event, ctx) => {
		if (currentState === "working") {
			currentState = "thinking";
			updateStatusBar(ctx);
		}
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (errorTimeoutId) {
			clearTimeout(errorTimeoutId);
			errorTimeoutId = null;
		}
		
		currentState = "done";
		updateStatusBar(ctx);
		
		errorTimeoutId = setTimeout(() => {
			if (currentState === "done") {
				currentState = "thinking";
				updateStatusBar(ctx);
			}
		}, 500);
	});

	// ── Track file paths and skills
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
		
		// Detect skill loading
		if (text.startsWith("/skill:")) {
			const skillName = text.slice(7).split(/\s/)[0];
			if (skillName && !loadedSkills.has(skillName)) {
				loadedSkills.add(skillName);
				updateStatusBar(ctx);
			}
		}
	});

	// ── Update on turn end
	pi.on("turn_end", async (_event, ctx) => {
		scanSkills();
		updateStats(ctx);
		updateStatusBar(ctx);
	});

	// ── Cleanup
	pi.on("session_shutdown", async (_event, ctx) => {
		clearSpinner();
		ctx.ui.setWidget(STATUS_BAR_ID, undefined);
	});

	// ── Commands
	pi.registerCommand("test-loading", {
		description: "Test loading indicator",
		handler: async (_args, ctx) => {
			startThinkingSpinner(ctx);
			transitionToWorking(ctx);
			await new Promise((r) => setTimeout(r, 2000));
			currentState = "done";
			updateStatusBar(ctx);
			setTimeout(() => {
				currentState = "sleeping";
				updateStatusBar(ctx);
			}, 1500);
		},
	});

	pi.registerCommand("status", {
		description: "Show status bar info",
		handler: async (_args, ctx) => {
			scanSkills();
			updateStats(ctx);
			const totalTokens = stats.inputTokens + stats.outputTokens;
			ctx.ui.notify(
				`State: ${currentState}\nPath: ${currentPath || "none"}\nBranch: ${gitBranch || "none"}\nTokens: ${formatTokens(totalTokens)}/${formatTokens(stats.maxContext)}\nCost: ${formatCost(stats.cost)}\nModel: ${modelName} • ${thinkingLevel}\nSkills: ${Array.from(loadedSkills).join(", ") || "none"}`,
				"info"
			);
		},
	});
}
