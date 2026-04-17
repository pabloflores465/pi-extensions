/**
 * always-caveman — Persist caveman communication mode across all sessions.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, _ctx) => {
    const caveman = `\n\nCaveman mode ACTIVE (full). Respond terse like smart caveman. Drop articles, filler, pleasantries, hedging. Fragments OK. Short synonyms. Technical terms exact. Pattern: [thing] [action] [reason]. [next step]. Code blocks normal. Off only if user says "stop caveman" or "normal mode".`;
    return { systemPrompt: (event.systemPrompt || "") + caveman };
  });
}
