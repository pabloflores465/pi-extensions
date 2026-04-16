/**
 * Status Bar Extension with Full-Width Status Bar
 *
 * Layout: status | [.......filler.......] | extensions + skills
 * - Status al principio (sleeping/thinking/working/done/error)
 * - Extensiones y skills al FINAL de la barra (con checks ✓)
 * - La barra ocupa TODO el ancho horizontal
 * - Las extensiones se truncan con "..." si no hay espacio
 * - Los skills SIEMPRE se muestran (prioridad)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORK_FRAMES = ["◐", "◓", "◑", "◒"];
const CHECK = "✓";
const ERROR = "✗";
const STATUS_BAR_ID = "status-bar";

// Track all extensions and loaded skills
let allExtensions: Set<string> = new Set();
let loadedSkills: Set<string> = new Set();

export default function (pi: ExtensionAPI) {
	let currentState: "sleeping" | "thinking" | "working" | "done" | "error" = "sleeping";
	let spinnerFrame = 0;
	let workFrame = 0;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let workingTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let errorTimeoutId: ReturnType<typeof setTimeout> | null = null;

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

	// ── Scan all extensions from filesystem
	function scanExtensionsFromFS() {
		const extensionsPaths = [
			join(process.env.HOME || "", ".pi/agent/extensions"),
		];
		
		for (const extPath of extensionsPaths) {
			try {
				if (!statSync(extPath).isDirectory()) continue;
				
				const entries = readdirSync(extPath, { withFileTypes: true });
				
				for (const entry of entries) {
					const fullPath = join(extPath, entry.name);
					
					if (entry.isFile() && entry.name.endsWith(".ts")) {
						const name = basename(entry.name, ".ts");
						allExtensions.add(name);
					} else if (entry.isDirectory()) {
						allExtensions.add(entry.name);
					}
				}
			} catch {
				// Directory doesn't exist
			}
		}
	}

	// ── Scan and update loaded skills
	function scanSkills() {
		const commands = pi.getCommands();
		
		for (const cmd of commands) {
			if (cmd.source === "skill") {
				loadedSkills.add(cmd.name);
			}
		}
	}

	// ── Build status bar
	function buildStatusBar(screenWidth: number): string {
		scanSkills();
		
		const extList = Array.from(allExtensions);
		const skillsList = Array.from(loadedSkills);
		
		// Status at the beginning
		let statusPart = "";
		switch (currentState) {
			case "sleeping":
				statusPart = "○ sleeping";
				break;
			case "thinking":
				statusPart = `${getSpinner()} thinking...`;
				break;
			case "working":
				statusPart = `${getWorkSpinner()} working...`;
				break;
			case "done":
				statusPart = `${CHECK} done`;
				break;
			case "error":
				statusPart = `${ERROR} error`;
				break;
		}
		
		// Build end part: ✓skills [extensions]
		const endParts: string[] = [];
		
		// Skills first with checkmark (never truncate)
		if (skillsList.length > 0) {
			endParts.push(`✓${skillsList.join(", ")}`);
		}
		
		// Extensions with checkmark (all loaded by default)
		if (extList.length > 0) {
			endParts.push(`[${extList.join(", ")}]`);
		}
		
		const endPart = endParts.join(" ");
		const endPartLen = endPart.length;
		
		// Calculate filler
		const statusLen = statusPart.length;
		const minGap = 2;
		const availableForFiller = screenWidth - 1 - statusLen - minGap - endPartLen;
		
		let result = statusPart;
		
		if (availableForFiller > 0) {
			// Fill with spaces
			const filler = " ".repeat(availableForFiller);
			result += " " + filler;
		} else if (availableForFiller < 0) {
			// Need to truncate end part
			let remaining = screenWidth - 1 - statusLen - minGap;
			
			// Truncate extensions first (now at index 1)
			if (extList.length > 0) {
				let truncatedExts = [...extList];
				let extStr = `[${truncatedExts.join(", ")}]`;
				
				while (extStr.length > remaining && truncatedExts.length > 1) {
					truncatedExts.pop();
					extStr = `[${truncatedExts.join(", ")}, ...]`;
				}
				
				if (extStr.length <= remaining) {
					endParts[1] = extStr;
					remaining -= extStr.length + 1;
				} else {
					// Just show [...]
					endParts[1] = "[...]";
					remaining -= 5 + 1;
				}
			}
			
			// Skills ALWAYS fit first (now at index 0)
			if (remaining > 0 && skillsList.length > 0) {
				endParts[0] = `✓${skillsList.join(", ")}`;
			} else if (skillsList.length > 0) {
				// Truncate to fit skills
				const skillsPart = `✓${skillsList.join(", ")}`;
				if (skillsPart.length < screenWidth - 1 - statusLen - 1) {
					endParts[1] = "";
					endParts[0] = skillsPart;
				}
			}
		}
		
		result += " " + endParts.join(" ");
		
		// Final trim if needed
		if (result.length > screenWidth) {
			result = result.slice(0, screenWidth);
		}
		
		return result;
	}

	// ── Update status bar widget
	function updateStatusBar(ctx: ExtensionContext) {
		ctx.ui.setWidget(STATUS_BAR_ID, (tui: TUI, theme: { fg: (color: string, text: string) => string }) => {
			return {
				render: (width?: number) => {
					const screenWidth = width ?? tui.width ?? 80;
					const statusText = buildStatusBar(screenWidth);
					return [theme.fg("accent", statusText)];
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

	function showDone(ctx: ExtensionContext, _message?: string) {
		currentState = "done";
		updateStatusBar(ctx);
	}

	function showError(ctx: ExtensionContext, _message: string) {
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

	// ── Session start
	pi.on("session_start", async (_event, ctx) => {
		allExtensions = new Set();
		loadedSkills = new Set();
		
		scanExtensionsFromFS();
		showSleeping(ctx);
	});

	// ── Agent loop
	pi.on("agent_start", async (_event, ctx) => {
		if (errorTimeoutId) {
			clearTimeout(errorTimeoutId);
			errorTimeoutId = null;
		}
		// If we were in error state, reset to working; otherwise start fresh
		if (currentState === "error" || currentState === "done") {
			currentState = "working";
			updateStatusBar(ctx);
		} else {
			startThinkingSpinner(ctx);
			transitionToWorking(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (currentState === "thinking" || currentState === "working") {
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
		if (currentState === "thinking") {
			showWorking(ctx);
		} else if (currentState === "sleeping") {
			startThinkingSpinner(ctx);
			transitionToWorking(ctx);
		}
	});

	pi.on("tool_execution_update", async (_event, ctx) => {
		if (currentState === "working") {
			showThinking(ctx);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.isError) {
			showError(ctx, `${event.toolName} failed`);
			// Reset to sleeping after 4 seconds if no new work starts
			if (errorTimeoutId) clearTimeout(errorTimeoutId);
			errorTimeoutId = setTimeout(() => {
				if (currentState === "error") {
					showSleeping(ctx);
				}
			}, 4000);
			return;
		}


		if (currentState === "working") {
			showThinking(ctx);
		}
	});

	// ── Detect skill loading
	pi.on("input", async (event, ctx) => {
		if (event.text.startsWith("/skill:")) {
			const skillName = event.text.slice(7).split(/\s/)[0];
			if (skillName && !loadedSkills.has(skillName)) {
				loadedSkills.add(skillName);
				updateStatusBar(ctx);
			}
		}
	});

	// ── Turn end - refresh
	pi.on("turn_end", async (_event, ctx) => {
		updateStatusBar(ctx);
	});

	// ── Cleanup
	pi.on("session_shutdown", async (_event, ctx) => {
		clearSpinner();
		ctx.ui.setWidget(STATUS_BAR_ID, undefined);
	});

	// ── Commands
	pi.registerCommand("test-loading", {
		description: "Test loading indicator: /test-loading [ms]",
		handler: async (args, ctx) => {
			const duration = Math.min(parseInt(args.trim()) || 2000, 8000);

			startThinkingSpinner(ctx);
			transitionToWorking(ctx);

			await new Promise((r) => setTimeout(r, duration));

			showDone(ctx, "test done!");

			setTimeout(() => {
				showSleeping(ctx);
			}, 1500);
		},
	});

	pi.registerCommand("status", {
		description: "Show loaded extensions and skills",
		handler: async (_args, ctx) => {
			scanSkills();
			const exts = Array.from(allExtensions);
			const skills = Array.from(loadedSkills);
			ctx.ui.notify(
				`Extensions (${exts.length}): ${exts.join(", ")}\nSkills (${skills.length}): ${skills.join(", ")}`,
				"info"
			);
		},
	});
}
