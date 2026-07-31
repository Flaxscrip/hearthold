import { loadConfig, type HearthholdConfig } from '@hearthold/core';

/**
 * The Warden's on-device VISION captioner. It turns an `image` submission into a factual text description +
 * content tags, which then flow through the EXISTING text classifier (sensitivity) → ingestion gate →
 * triage → recall. No parallel image pipeline, no multimodal index — the caption is what gets classified and
 * embedded; the image bytes are just the sealed artefact payload. Same Ollama `/api/chat` endpoint as the
 * classifier, with an `images:[b64]` attachment. Runs on the node's Ollama: on-device, no egress.
 */
export interface ImageCaption {
  /** A factual 1–3 sentence description (includes transcribed text / OCR the model surfaces). */
  description: string;
  /** Content tags (people, text, location cues, documents, sensitive material, …). */
  tags: string[];
}

export interface VisionCaptioner {
  /** Caption an image; returns null on ANY failure (model absent/errored/empty) so the caller fails closed. */
  caption(input: { bytesB64: string; mediaType?: string }): Promise<ImageCaption | null>;
}

// A plain, NEUTRAL description prompt — NOT structured output and NOT a "flag sensitive content" instruction.
// Two hard-won lessons about small vision models (moondream): a `format` JSON schema makes them ramble into
// invalid JSON, and a prompt that names "people / sensitive / credentials" makes them return EMPTY (a
// small-model guardrail). So the vision step just DESCRIBES (factually, incl. visible text/OCR); the sensitivity
// assessment is the TEXT classifier's job downstream, over the caption. Content tags are derived best-effort.
const PROMPT = 'Describe this image in detail, including any visible text.';

/** Coarse content tags from the description (lowercased significant words) — a hint, not authoritative. */
function tagsFromDescription(description: string): string[] {
  const stop = new Set(['this', 'that', 'with', 'from', 'have', 'they', 'their', 'there', 'which', 'image', 'shows', 'appears', 'likely', 'some', 'been', 'into', 'onto', 'over', 'about']);
  return [...new Set(
    description.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !stop.has(w)),
  )].slice(0, 12);
}

/** Local Ollama vision captioner (default `moondream`). Any failure → null (caller classifies SEALED). */
export class OllamaVisionCaptioner implements VisionCaptioner {
  constructor(
    private readonly url: string,
    private readonly model: string,
  ) {}

  async caption(input: { bytesB64: string; mediaType?: string }): Promise<ImageCaption | null> {
    try {
      const res = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          options: { temperature: 0 },
          messages: [{ role: 'user', content: PROMPT, images: [input.bytesB64] }],
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string } };
      const description = String(data.message?.content ?? '').replace(/\s+/g, ' ').trim();
      if (!description) throw new Error('empty description');
      return { description, tags: tagsFromDescription(description) };
    } catch {
      return null; // fail-closed: a missing/failed vision model must quarantine (SEALED), never leak
    }
  }
}

/** Select the vision captioner from config: the local model, or none when the model stack is disabled. */
export function createVisionCaptioner(config: HearthholdConfig = loadConfig()): VisionCaptioner | undefined {
  if (config.classifierMode === 'quarantine') return undefined; // model stack off → images fail closed to SEALED
  return new OllamaVisionCaptioner(config.ollamaUrl, config.visionModel);
}
