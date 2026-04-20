
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Fallback Manager Extension
 * 
 * Intercepts model selection events and API failures to automatically
 * switch to a free fallback model (google/gemma-2-27b-it:free) 
 * when the primary model fails due to credits or availability.
 */

export default function (pi: ExtensionAPI) {
  const FALLBACK_MODEL = "google/gemma-2-27b-it:free";

  // Listen for agent errors, specifically looking for credit/balance issues
  pi.on("agent_end", async (event, ctx) => {
    if (event.status === "error" && event.error) {
      const isCreditIssue = /credit|balance|insufficient|payment|quota/i.test(event.error);
      
      if (isCreditIssue) {
        console.warn(`[fallback-manager] Detected credit/balance issue: ${event.error}. Switching to fallback.`);
        
        const success = await ctx.setModel(FALLBACK_MODEL);
        if (success) {
          ctx.ui.notify(`Primary model unavailable (credits). Switched to ${FALLBACK_MODEL}`, "warning");
        } else {
          ctx.ui.notify(`Failed to switch to fallback model ${FALLBACK_MODEL}`, "error");
        }
      }
    }
  });
}
