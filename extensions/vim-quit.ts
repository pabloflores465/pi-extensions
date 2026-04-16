import type { ExtensionAPI, ExtensionUIContext } from '@mariozechner/pi-coding-agent';

/**
 * Vim Quit Extension
 *
 * Intercepts raw terminal input to replace vim-style commands in real-time:
 * - `:q` → `/quit` (as you type, before sending)
 * - `:q!` → `/quit`
 *
 * Uses onTerminalInput + setEditorText to modify the input buffer.
 */
export default function (pi: ExtensionAPI) {
  let ui: ExtensionUIContext | null = null;

  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ui = ctx.ui;

    const unsubscribe = ctx.ui.onTerminalInput((data: string) => {
      // Ignore control characters except Enter
      if (data === '\r' || data === '\n') {
        return;
      }

      if (data === '\x03') {  // Ctrl+C
        return;
      }

      if (data === '\x1b') {  // Escape
        return;
      }

      // Only process printable characters
      if (data.length === 1 && data >= ' ' && data <= '~') {
        const currentText = ui!.getEditorText();

        // Check if the new text starts with :q or :q!
        const newText = currentText + data;
        if (newText === ':q' || newText === ':q!') {
          // Transform to /quit
          ui!.setEditorText('/quit');
          return { consume: true };
        }
      }

      return;
    });

    pi.on('session_shutdown', async () => {
      unsubscribe();
      ui = null;
    });
  });
}
