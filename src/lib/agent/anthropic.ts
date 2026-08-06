/**
 * Anthropic client and the structured-output helper every skill uses.
 *
 * Model defaults to claude-opus-5. Adaptive thinking is on — mortgage document
 * work is exactly the careful-reading task where it pays for itself, and on
 * Opus 5 thinking is on by default anyway, so we set it explicitly to make the
 * intent visible rather than incidental.
 *
 * Note on `max_tokens`: it caps thinking AND response text together. The
 * generous default here is deliberate — a truncated classification is worse
 * than a slow one.
 */

import Anthropic from '@anthropic-ai/sdk';

import { anthropicConfig } from '@/lib/env';

let cached: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const config = anthropicConfig();
  cached = new Anthropic({ apiKey: config.apiKey });
  return cached;
}

export interface StructuredCallOptions {
  system: string;
  /** User-turn content: text, and optionally documents/images. */
  content: Anthropic.ContentBlockParam[];
  /** JSON Schema. Must set additionalProperties:false and list `required`. */
  schema: Record<string, unknown>;
  model?: string;
  effort?: string;
  maxTokens?: number;
}

export interface StructuredCallResult<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One structured call to Claude, returning parsed JSON.
 *
 * Uses `output_config.format` (structured outputs) rather than prompting for
 * JSON and hoping. Assistant prefill — the old way to force a JSON shape —
 * returns a 400 on Opus 5, so this is not merely the nicer option, it is the
 * supported one.
 *
 * Streams the response: with a large `max_tokens` a non-streaming request can
 * exceed the SDK's HTTP timeout, which surfaces as a confusing socket error
 * rather than anything actionable.
 */
export async function structuredCall<T>(
  options: StructuredCallOptions,
): Promise<StructuredCallResult<T>> {
  const config = anthropicConfig();
  const client = getAnthropic();

  const stream = client.messages.stream({
    model: options.model ?? config.model,
    max_tokens: options.maxTokens ?? 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: (options.effort ?? config.effort) as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
      format: { type: 'json_schema', schema: options.schema },
    },
    system: options.system,
    messages: [{ role: 'user', content: options.content }],
  });

  const message = await stream.finalMessage();

  // Opus 5 safety classifiers can decline a request with a normal HTTP 200.
  // Reading content[0] without this check would throw something unhelpful.
  if (message.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined this request (category: ${message.stop_details?.category ?? 'unknown'}). ` +
        'This usually means the document content tripped a safety classifier; review it manually.',
    );
  }

  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      'Response hit the max_tokens ceiling before completing. Raise maxTokens for this skill.',
    );
  }

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text block; cannot parse structured output.');
  }

  let parsed: T;
  try {
    parsed = JSON.parse(textBlock.text) as T;
  } catch (error) {
    throw new Error(
      `Structured output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    data: parsed,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
