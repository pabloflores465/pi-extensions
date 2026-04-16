/**
 * Vision Handoff Extension
 * 
 * Automatically describes images using a multimodal model when the current model
 * doesn't support vision. This allows non-multimodal models to process image
 * inputs by converting them to text descriptions.
 * 
 * How it works:
 * 1. Intercepts text containing image file paths (from Ctrl+V paste)
 * 2. Reads the image files
 * 3. If current model doesn't support vision, uses a multimodal model to describe
 * 4. Replaces image references with detailed text descriptions
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model, ImageContent } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

const SYSTEM_PROMPT = `You are an image description assistant. Given one or more images, provide a detailed, accurate description of what you see. Your description should be:

1. Concise but comprehensive
2. Focus on visually important elements
3. Include any text visible in the image
4. Note colors, arrangement, and spatial relationships
5. Be factual - don't speculate beyond what's visible

Format your response as a clear description. If there are multiple images, number them.`;

function isMultimodalModel(model: Model | undefined): boolean {
  if (!model) return false;
  const inputTypes = model.input ?? [];
  return inputTypes.includes("image");
}

function findImagePaths(text: string): string[] {
  // Match common image file paths (from /var/folders tmp files or any image path)
  // Pattern matches paths that look like image files
  const patterns = [
    // macOS clipboard temp files
    /\/var\/folders\/[^\/]+\/[^\/]+\/T\/pi-clipboard-[a-f0-9-]+\.(png|jpg|jpeg|gif|webp)/gi,
    // Generic image paths
    /\/[^\s]+\.(png|jpg|jpeg|gif|webp|bmp)/gi,
  ];
  
  const found = new Set<string>();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.add(match[0]);
    }
  }
  return Array.from(found);
}

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext);
}

async function readImageAsBase64(filePath: string): Promise<ImageContent | null> {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[vision-handoff] File not found: ${filePath}`);
      return null;
    }
    
    const stats = fs.statSync(filePath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB limit
      console.error(`[vision-handoff] File too large: ${filePath} (${stats.size} bytes)`);
      return null;
    }
    
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    let mimeType = "image/png";
    if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
    else if (ext === ".gif") mimeType = "image/gif";
    else if (ext === ".webp") mimeType = "image/webp";
    else if (ext === ".bmp") mimeType = "image/bmp";
    
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType,
    };
  } catch (error) {
    console.error(`[vision-handoff] Error reading image: ${error}`);
    return null;
  }
}

async function describeImages(
  images: ImageContent[],
  multimodalModel: Model,
  apiKey: string,
  headers?: Record<string, string>,
  signal?: AbortSignal
): Promise<string[]> {
  const content: Array<{ type: "text"; text: string } | ImageContent> = [];

  content.push({
    type: "text",
    text: `Please describe the following ${images.length} image(s) in detail. Include all visible text, colors, layout, and important elements:`,
  });

  for (const img of images) {
    content.push({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    });
  }

  const response = await complete(
    multimodalModel,
    {
      messages: [{ role: "user", content, timestamp: Date.now() }],
      systemPrompt: SYSTEM_PROMPT,
    },
    {
      apiKey,
      headers,
      maxTokens: 4096,
      signal,
    }
  );

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return [text.trim()];
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    // Skip if no text
    if (!event.text || event.text.trim() === "") {
      return { action: "continue" };
    }

    // Skip if already from extension (avoid loops)
    if (event.source === "extension") {
      return { action: "continue" };
    }

    const text = event.text;
    
    // Find image paths in text
    const imagePaths = findImagePaths(text);
    
    if (imagePaths.length === 0) {
      // No image paths found, check if there are inline images
      if (!event.images || event.images.length === 0) {
        return { action: "continue" };
      }
      // Has inline images, will handle below
    }

    const currentModel = ctx.model;
    console.error(`[vision-handoff] Current model: ${currentModel?.provider}/${currentModel?.id}`);
    console.error(`[vision-handoff] Current model input: ${JSON.stringify(currentModel?.input)}`);
    console.error(`[vision-handoff] Is multimodal: ${isMultimodalModel(currentModel)}`);
    console.error(`[vision-handoff] Image paths found: ${imagePaths.length}`);

    // Check if current model supports vision
    if (isMultimodalModel(currentModel)) {
      console.error(`[vision-handoff] Model supports vision, passing through`);
      return { action: "continue" };
    }

    // Collect all images (from paths and inline)
    const allImages: ImageContent[] = [];

    // Read images from paths
    for (const imgPath of imagePaths) {
      const img = await readImageAsBase64(imgPath);
      if (img) {
        allImages.push(img);
        console.error(`[vision-handoff] Loaded image: ${imgPath} (${img.data.length} chars base64)`);
      }
    }

    // Add inline images if any
    if (event.images) {
      allImages.push(...event.images);
      console.error(`[vision-handoff] Added ${event.images.length} inline images`);
    }

    if (allImages.length === 0) {
      console.error(`[vision-handoff] No images could be loaded`);
      return { action: "continue" };
    }

    // Find the multimodal model
    const visionProviders = [
      { provider: "openrouter", id: "google/gemini-3.1-flash-lite-preview" },
    ];

    let multimodalModel: Model | undefined;
    let foundProvider = "";
    let foundId = "";

    for (const vp of visionProviders) {
      const found = ctx.modelRegistry.find(vp.provider, vp.id);
      if (found) {
        multimodalModel = found;
        foundProvider = vp.provider;
        foundId = vp.id;
        break;
      }
    }

    if (!multimodalModel) {
      ctx.ui.notify(
        `[vision-handoff] No vision model found in registry. Cannot describe images.`,
        "error"
      );
      return { action: "continue" };
    }

    console.error(`[vision-handoff] Using vision model: ${foundProvider}/${foundId}`);

    // Get API key for multimodal model
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(multimodalModel);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify(
        `[vision-handoff] No API key for ${foundProvider}.`,
        "error"
      );
      return { action: "continue" };
    }

    try {
      ctx.ui.notify(
        `[vision-handoff] Describing ${allImages.length} image(s) with ${foundId}...`,
        "info"
      );

      const descriptions = await describeImages(
        allImages,
        multimodalModel,
        auth.apiKey,
        auth.headers,
        ctx.signal
      );

      // Build new text with image descriptions
      // Remove the image paths from the original text
      let newText = text;
      for (const imgPath of imagePaths) {
        newText = newText.replace(imgPath, "");
      }
      newText = newText.trim();

      // Add descriptions
      if (newText) {
        newText += "\n\n";
      }

      if (descriptions.length === 1) {
        newText += `[Image: ${descriptions[0]}]`;
      } else {
        for (let i = 0; i < descriptions.length; i++) {
          newText += `[Image ${i + 1}: ${descriptions[i]}]\n\n`;
        }
      }

      ctx.ui.notify(`[vision-handoff] Done describing. Passing to text model.`, "info");
      console.error(`[vision-handoff] Transformed text length: ${newText.length}`);

      return { action: "transform", text: newText.trim() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[vision-handoff] Error: ${message}`);
      ctx.ui.notify(`[vision-handoff] Failed: ${message}`, "warning");
      return { action: "continue" };
    }
  });

  // Notify on model change
  pi.on("model_select", async (event, ctx) => {
    const isCurrentMultimodal = isMultimodalModel(event.model);
    console.error(`[vision-handoff] Model changed to: ${event.model?.provider}/${event.model?.id}, multimodal: ${isCurrentMultimodal}`);
  });
}
