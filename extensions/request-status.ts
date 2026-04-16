/**
 * Request Status Extension
 *
 * Muestra estados de loading en la UI nativa (widget):
 * - Spinner animado mientras el agente procesa (Thinking)
 * - "Working..." cuando hay actividad pero sin output visible
 * - Muestra "Done" cuando termina
 * - "Sleeping" cuando no hay ninguna request activa
 *
 * Estados:
 * - sleeping: sin spinner, estado idle/ready
 * - thinking: spinner con "Thinking..."
 * - working: spinner con "Working..."
 * - done: ✓ con mensaje de completado
 * - error: ✗ con mensaje de error
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORK_FRAMES = ["◐", "◓", "◑", "◒"];  // Rotating circles for working state
const CHECK = "✓";
const ERROR = "✗";
const EXT_ID = "request-status";

// Reserved width to prevent layout shifts
const RESERVED_WIDTH = 20;

function pad(text: string): string {
	const width = RESERVED_WIDTH - [...text].reduce((n, c) => n + (c.codePointAt(0)! > 127 ? 2 : 1), 0);
	return text + " ".repeat(Math.max(0, width));
}

type StatusState = "sleeping" | "thinking" | "working" | "done" | "error";

export default function (pi: ExtensionAPI) {
	let currentState: StatusState = "sleeping";
	let spinnerFrame = 0;
	let workFrame = 0;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let workingTimeoutId: ReturnType<typeof setTimeout> | null = null;

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

	function makeWidget(text: string, color: "accent" | "success" | "error") {
		return (_tui: unknown, theme: { fg: (color: string, text: string) => string }) => ({
			render: () => [theme.fg(color, pad(text))],
			invalidate: () => {},
		});
	}

	function setWidget(ctx: ExtensionContext, widget: ReturnType<typeof makeWidget> | null) {
		if (widget) {
			ctx.ui.setWidget(EXT_ID, widget, { placement: "belowEditor" });
		} else {
			ctx.ui.setWidget(EXT_ID, undefined);
		}
	}

	function showSleeping(ctx: ExtensionContext) {
		currentState = "sleeping";
		clearSpinner();
		setWidget(ctx, makeWidget("○ sleeping", "accent"));
	}

	function showThinking(ctx: ExtensionContext) {
		currentState = "thinking";
		setWidget(ctx, makeWidget(`${getSpinner()} thinking...`, "accent"));
	}

	function showWorking(ctx: ExtensionContext) {
		currentState = "working";
		setWidget(ctx, makeWidget(`${getWorkSpinner()} working...`, "accent"));
	}

	function showDone(ctx: ExtensionContext, message?: string) {
		currentState = "done";
		setWidget(ctx, makeWidget(`${CHECK} ${message || "done"}`, "success"));
	}

	function showError(ctx: ExtensionContext, message: string) {
		currentState = "error";
		setWidget(ctx, makeWidget(`${ERROR} ${message}`, "error"));
	}

	function startThinkingSpinner(ctx: ExtensionContext) {
		clearSpinner();
		showThinking(ctx);

		intervalId = setInterval(() => {
			if (currentState === "thinking") {
				spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
				setWidget(ctx, makeWidget(`${getSpinner()} thinking...`, "accent"));
			} else if (currentState === "working") {
				workFrame = (workFrame + 1) % WORK_FRAMES.length;
				setWidget(ctx, makeWidget(`${getWorkSpinner()} working...`, "accent"));
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

	// ── Session start - show sleeping
	pi.on("session_start", async (_event, ctx) => {
		showSleeping(ctx);
	});

	// ── Agent loop start/stop
	pi.on("agent_start", async (_event, ctx) => {
		startThinkingSpinner(ctx);
		transitionToWorking(ctx);
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
		// Si ya estamos en thinking, pasamos directamente a working
		if (currentState === "thinking") {
			showWorking(ctx);
		} else if (currentState === "sleeping") {
			startThinkingSpinner(ctx);
			transitionToWorking(ctx);
		}
		// Si ya estamos en working, no hacemos nada (está bien)
	});

	pi.on("tool_execution_update", async (_event, ctx) => {
		// Solo regresamos a thinking si estamos en working y llega un update
		// Esto indica que el tool terminó y el agent está pensando de nuevo
		if (currentState === "working") {
			showThinking(ctx);
			// No necesitamos transitionToWorking aquí porque ya vamos a pensar
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		// Error siempre se muestra
		if (event.isError) {
			showError(ctx, `${event.toolName} failed`);
			return;
		}

		// Tool terminó bien: el agent sigue activo, vuelve a thinking
		// Solo si estaba en working (si estaba sleeping, no hacemos nada)
		if (currentState === "working") {
			showThinking(ctx);
		}
	});

	// ── Cleanup
	pi.on("session_end", async (_event, ctx) => {
		clearSpinner();
		setWidget(ctx, null);
	});

	// ── Test command
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
}
