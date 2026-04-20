
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";

/**
 * Compaction Master Extension
 * 
 * Combines reasoning fixes, model overrides, and batch-based summarization
 * to handle extremely large contexts and specific model requirements.
 */

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const BATCH_MERGE_PROMPT = `The messages below are multiple partial summaries of different segments of a long conversation.
Your task is to MERGE these partial summaries into one final, coherent, and comprehensive structured summary.

Follow this EXACT format:

## Goal
[Consolidated goal(s)]

## Constraints & Preferences
- [Consolidated constraints]

## Progress
### Done
- [x] [Consolidated completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Current issues]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Prioritized next steps]

## Critical Context
- [Consolidated references, paths, and data]

Keep it concise but ensure no critical details (like specific file paths or errors) are lost.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// Max characters to keep per message to avoid overflowing a single batch
// 120k chars is ~30k-40k tokens, safe for most 128k/200k windows
const MAX_MSG_CHARS = 120000; 

function serializeMessage(msg: any): string {
  let content = "";
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((c: any) => (c.type === "text" ? c.text : c.type === "thinking" ? `[thinking: ${c.thinking}]` : `[${c.type}]`))
      .join("\n");
  }

  if (content.length > MAX_MSG_CHARS) {
    const half = Math.floor(MAX_MSG_CHARS / 2);
    content = content.slice(0, half) + 
              `\n\n... [TRUNCATED ${content.length - MAX_MSG_CHARS} CHARACTERS] ...\n\n` + 
              content.slice(-half);
  }

  return `[${msg.role.toUpperCase()}]\n${content}\n`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function runSummarization(
  prompt: string,
  model: any,
  apiKey: string,
  headers: any,
  thinking: string | undefined,
  signal: AbortSignal,
  maxOutputTokens = 4096
): Promise<string> {
  const completionOptions: any = { maxTokens: maxOutputTokens, signal, apiKey, headers };
  
  // Force reasoning if model supports it or if explicitly set in settings
  if (thinking && thinking !== "none") {
    completionOptions.reasoning = thinking;
  } else if (model.reasoning) {
    completionOptions.reasoning = "high";
  }

  const response = await completeSimple(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    completionOptions
  );

  if (response.stopReason === "error") {
    throw new Error(`AI request failed: ${response.errorMessage || "Unknown error"}`);
  }

  return response.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const prep = event.preparation;
    const settings = pi.settings?.compaction;
    
    // 1. Resolve Compaction Model
    const modelId = settings?.model;
    let compactionModel = ctx.model;

    if (modelId) {
      const found = ctx.modelRegistry.find(undefined, modelId) || 
                   ctx.modelRegistry.getAll().find((m: any) => m.id === modelId);
      if (found) {
        compactionModel = found;
        console.log(`[compaction-master] Using configured model: ${compactionModel.provider}/${compactionModel.id}`);
      }
    }

    // 2. Resolve Auth
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(compactionModel);
    if (!auth.ok) {
      throw new Error(`[compaction-master] Failed to get auth for ${compactionModel.id}: ${auth.error}`);
    }

    const thinking = settings?.thinking;
    const contextWindow = compactionModel.contextWindow || 128000;
    const batchSizeTokens = Math.floor(contextWindow * 0.6); // 60% for safety

    // 3. Process Messages
    const allMessages = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
    let totalEstimatedTokens = 0;
    for (const msg of allMessages) {
       totalEstimatedTokens += estimateTokens(serializeMessage(msg));
    }

    console.log(`[compaction-master] Processing ${allMessages.length} messages (~${totalEstimatedTokens} tokens)`);

    try {
      // Logic split: Batching vs Single Summarization
      let finalSummary = "";
      
      // A. Always batch if context is large
      if (totalEstimatedTokens > contextWindow * 0.7) {
        ctx.ui.notify(`[compaction-master] Batching large context into ~${Math.ceil(totalEstimatedTokens/batchSizeTokens)} chunks...`, "info");
        
        const historyBatches: string[] = [];
        let currentBatch: any[] = [];
        let currentBatchTokens = 0;

        for (const msg of prep.messagesToSummarize) {
          const serialized = serializeMessage(msg);
          const tokens = estimateTokens(serialized);
          
          if (currentBatchTokens + tokens > batchSizeTokens && currentBatch.length > 0) {
            ctx.ui.notify(`[compaction-master] Summarizing history batch ${historyBatches.length + 1}...`, "info");
            const summary = await runSummarization(
              `<conversation>\n${currentBatch.map(serializeMessage).join("\n---\n")}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`,
              compactionModel, auth.apiKey, auth.headers, thinking, event.signal
            );
            historyBatches.push(summary);
            currentBatch = [];
            currentBatchTokens = 0;
          }
          currentBatch.push(msg);
          currentBatchTokens += tokens;
        }

        if (currentBatch.length > 0) {
          ctx.ui.notify(`[compaction-master] Summarizing final history batch...`, "info");
          const summary = await runSummarization(
            `<conversation>\n${currentBatch.map(serializeMessage).join("\n---\n")}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`,
            compactionModel, auth.apiKey, auth.headers, thinking, event.signal
          );
          historyBatches.push(summary);
        }

        // Merge history batches
        if (historyBatches.length === 1) {
          finalSummary = historyBatches[0];
        } else {
          ctx.ui.notify(`[compaction-master] Merging ${historyBatches.length} partial summaries...`, "info");
          finalSummary = await runSummarization(
            `<partial-summaries>\n${historyBatches.join("\n\n---\n\n")}\n</partial-summaries>\n\n${BATCH_MERGE_PROMPT}`,
            compactionModel, auth.apiKey, auth.headers, thinking, event.signal
          );
        }
      } else {
        // B. Standard Single Summarization (with fixes)
        ctx.ui.notify(`[compaction-master] Summarizing ${prep.messagesToSummarize.length} messages...`, "info");
        finalSummary = await runSummarization(
          `<conversation>\n${prep.messagesToSummarize.map(serializeMessage).join("\n---\n")}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`,
          compactionModel, auth.apiKey, auth.headers, thinking, event.signal
        );
      }

      // 4. Handle Turn Prefix (Split turns)
      if (prep.isSplitTurn && prep.turnPrefixMessages.length > 0) {
        ctx.ui.notify(`[compaction-master] Summarizing turn prefix...`, "info");
        const turnPrefixSummary = await runSummarization(
          `<turn-prefix>\n${prep.turnPrefixMessages.map(serializeMessage).join("\n---\n")}\n</turn-prefix>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`,
          compactionModel, auth.apiKey, auth.headers, thinking, event.signal, 2048
        );
        finalSummary += `\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
      }

      // 5. Append File Operations
      const readFiles = Array.from(prep.fileOps.read as Set<string>);
      const editedFiles = Array.from(prep.fileOps.edited as Set<string>);
      
      if (readFiles.length > 0 || editedFiles.length > 0) {
        finalSummary += "\n\n### File Operations\n";
        if (readFiles.length > 0) finalSummary += "- **Read**: " + readFiles.join(", ") + "\n";
        if (editedFiles.length > 0) finalSummary += "- **Edited**: " + editedFiles.join(", ") + "\n";
      }

      return {
        compaction: {
          summary: finalSummary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: { readFiles, modifiedFiles: editedFiles }
        }
      };
    } catch (error: any) {
      console.error(`[compaction-master] Critical Failure: ${error.message}`);
      ctx.ui.notify(`[compaction-master] Failed: ${error.message}`, "error");
      throw error; // Stop core/other plugins from trying and causing loop/OOM
    }
  });
}
