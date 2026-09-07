/**
 * analyze-image — let a text-only model "see" images, the way Z.ai's
 * 4_5v_mcp does for Claude Code, but fully client-side:
 *
 * 1. context hook: when the active model has no image input, every image
 *    attachment is saved to disk and replaced by a placeholder pointing at
 *    the analyze_image tool.
 * 2. analyze_image tool: sends a local path or https URL to a vision model
 *    (default glm-4.6v on the zai-coding-cn coding plan) and returns its
 *    text description.
 *
 * Config via env: ANALYZE_IMAGE_PROVIDER / ANALYZE_IMAGE_BASE_URL / ANALYZE_IMAGE_MODEL
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDER = process.env.ANALYZE_IMAGE_PROVIDER ?? "zai-coding-cn";
const BASE_URL = (
  process.env.ANALYZE_IMAGE_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4"
).replace(/\/$/, "");
const VISION_MODEL = process.env.ANALYZE_IMAGE_MODEL ?? "glm-4.6v";

const DEFAULT_PROMPT =
  "请详细描述这张图片：界面布局、所有可见文字（逐字转录、保留原文语言）、颜色风格、主要组件和交互元素。";

const EXT_TO_MEDIA: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};
const MEDIA_TO_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/bmp": "bmp",
};

const TOOL_NAME = "analyze_image";

function isGlmModel(m: any): boolean {
  const provider = String(m?.provider ?? "").toLowerCase();
  const id = String(m?.id ?? "").toLowerCase();
  return provider.includes("zai") || id.startsWith("glm");
}

/** Activate the analyze_image tool only when a GLM model is in use. */
function syncToolActivation(pi: ExtensionAPI, model: any) {
  const active = new Set(pi.getActiveTools());
  if (isGlmModel(model)) active.add(TOOL_NAME);
  else active.delete(TOOL_NAME);
  pi.setActiveTools([...active]);
}

const imgDir = join(tmpdir(), "pi-images");

async function saveImage(mediaType: string, data: string): Promise<string> {
  const hash = createHash("sha1").update(data).digest("hex").slice(0, 16);
  const path = join(imgDir, `${hash}.${MEDIA_TO_EXT[mediaType] ?? "png"}`);
  await mkdir(imgDir, { recursive: true });
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

function mediaTypeFor(path: string): string {
  return EXT_TO_MEDIA[path.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => syncToolActivation(pi, ctx.model));
  pi.on("model_select", async (event) => syncToolActivation(pi, event.model));

  // Replace image blocks with saved-file placeholders when the model can't see images.
  pi.on("context", async (event, ctx) => {
    if (!isGlmModel(ctx.model)) return; // GLM models only
    const input = ctx.model?.input;
    if (!input || input.includes("image")) return; // model is vision-capable

    let changed = false;
    const messages = [];
    for (const m of event.messages) {
      if (m.role !== "user" || !Array.isArray((m as any).content)) {
        messages.push(m);
        continue;
      }
      const content = [];
      for (const block of (m as any).content as any[]) {
        if (block?.type !== "image" || block.source?.type !== "base64") {
          content.push(block);
          continue;
        }
        const path = await saveImage(block.source.mediaType ?? "image/png", block.source.data);
        changed = true;
        content.push({
          type: "text",
          text: `[image attachment: ${path} — the current model cannot view images directly. Call the analyze_image tool with this path to get a full visual description.]`,
        });
      }
      messages.push({ ...m, content });
    }
    return changed ? { messages } : undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Analyze Image",
    description:
      "Analyze an image with a vision model. Input is a local file path or https URL. " +
      "Returns detailed text: layout, verbatim transcription of all visible text (original language), " +
      "colors, components, interactive elements. Use whenever the conversation contains an image " +
      "placeholder you cannot see, or when the user asks about an image file.",
    parameters: Type.Object({
      source: Type.String({ description: "Local file path or https URL of the image" }),
      prompt: Type.Optional(Type.String({ description: "What to look for; default: full description" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (!key) throw new Error(`No API key for provider "${PROVIDER}" — run /login`);

      const url = params.source.startsWith("http")
        ? params.source
        : `data:${mediaTypeFor(params.source)};base64,${(await readFile(params.source)).toString("base64")}`;

      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: VISION_MODEL,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url } },
              { type: "text", text: params.prompt || DEFAULT_PROMPT },
            ],
          }],
        }),
        signal,
      });
      if (!res.ok) throw new Error(`vision API ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const j: any = await res.json();
      const c = j.choices?.[0]?.message?.content;
      const text = typeof c === "string"
        ? c
        : Array.isArray(c) ? c.map((b: any) => b?.text ?? "").join("") : "";
      return {
        content: [{ type: "text", text: text || `(empty response: ${JSON.stringify(j).slice(0, 300)})` }],
        details: { model: VISION_MODEL },
      };
    },
  });
}
