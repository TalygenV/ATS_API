// Shared Groq JSON extraction, error handling, and repair utilities

const PRIMARY_MODEL = 'llama-3.1-8b-instant';
const REPAIR_MODEL = 'llama-3.3-70b-versatile';

function unwrapGroqApiError(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  if (obj.error && typeof obj.error === 'object' && (obj.error.code || obj.error.failed_generation)) {
    return obj.error;
  }
  if (obj.code || obj.failed_generation) {
    return obj;
  }
  return null;
}

function getGroqErrorPayload(error) {
  if (!error) {
    return null;
  }

  const fromSdk = unwrapGroqApiError(error.error);
  if (fromSdk) {
    return fromSdk;
  }

  if (error.body) {
    try {
      const body = typeof error.body === 'string' ? JSON.parse(error.body) : error.body;
      const unwrapped = unwrapGroqApiError(body);
      if (unwrapped) {
        return unwrapped;
      }
    } catch {
      // ignore
    }
  }

  const message = error.message || '';
  if (message.includes('json_validate_failed') || message.includes('Failed to generate JSON')) {
    const jsonStart = message.indexOf('{');
    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(message.substring(jsonStart));
        const unwrapped = unwrapGroqApiError(parsed);
        if (unwrapped) {
          return unwrapped;
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function isJsonValidateFailedError(error) {
  const payload = getGroqErrorPayload(error);
  if (payload?.code === 'json_validate_failed') {
    return true;
  }
  const msg = error?.message || '';
  return msg.includes('json_validate_failed') || msg.includes('Failed to generate JSON');
}

function getFailedGeneration(error) {
  const payload = getGroqErrorPayload(error);
  return payload?.failed_generation || null;
}

function extractJSONByBraces(text) {
  const startIndex = findJsonObjectStart(text);
  if (startIndex === -1) {
    return null;
  }

  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return text.substring(startIndex, i + 1);
        }
      }
    }
  }

  const fallbackMatch = text.match(/\{[\s\S]*\}/);
  return fallbackMatch ? fallbackMatch[0] : null;
}

function findJsonObjectStart(text) {
  const quotedKeyMatch = text.match(/\{\s*"[\w]/);
  if (quotedKeyMatch) {
    return text.indexOf(quotedKeyMatch[0]);
  }
  const newlineKeyMatch = text.match(/\{\s*\n\s*"/);
  if (newlineKeyMatch) {
    return text.indexOf(newlineKeyMatch[0]);
  }
  return text.indexOf('{');
}

function cleanAndExtractJson(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let jsonText = text.trim();
  jsonText = jsonText.replace(/\u0000/g, '');
  jsonText = jsonText.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
  jsonText = jsonText.replace(/```json\n?/gi, '').replace(/```\n?/g, '');

  const jsonStart = findJsonObjectStart(jsonText);
  if (jsonStart > 0) {
    jsonText = jsonText.substring(jsonStart);
  } else if (jsonStart === -1) {
    const firstBracketIndex = jsonText.indexOf('[');
    if (firstBracketIndex >= 0) {
      jsonText = jsonText.substring(firstBracketIndex);
    } else {
      return '';
    }
  }

  const extractedJson = extractJSONByBraces(jsonText);
  if (extractedJson) {
    jsonText = extractedJson;
    jsonText = jsonText.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
  } else {
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
      jsonText = jsonText.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
    } else {
      return '';
    }
  }

  return jsonText.trim();
}

function tryParseJson(text, { quiet = false } = {}) {
  const jsonText = cleanAndExtractJson(text);

  if (!jsonText || (!jsonText.startsWith('{') && !jsonText.startsWith('['))) {
    return { ok: false, jsonText: jsonText || '' };
  }

  try {
    const data = JSON.parse(jsonText);
    return { ok: true, data, jsonText };
  } catch (parseError) {
    if (!quiet) {
      console.error(`     JSON Parse Error: ${parseError.message}`);
      console.error(`     JSON text length: ${jsonText.length}`);
      console.error(`     JSON preview (first 200 chars): ${jsonText.substring(0, 200)}`);
    }
    return { ok: false, jsonText, parseError };
  }
}

async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (isJsonValidateFailedError(error)) {
        throw error;
      }

      const isNetworkError = error.message && (
        error.message.includes('fetch failed') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('network') ||
        error.message.includes('timeout')
      );

      if (!isNetworkError || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Plain Groq chat (no response_format) — original matcher behavior
 */
async function callGroqChatPlain(groq, { messages, model = PRIMARY_MODEL, temperature = 0.3, max_tokens = 4096 }) {
  const result = await retryWithBackoff(async () => {
    return await groq.chat.completions.create({
      messages,
      model,
      temperature,
      max_tokens
    });
  }, 3, 2000);

  return {
    content: result.choices[0]?.message?.content || ''
  };
}

/**
 * Call Groq chat with json_object; on json_validate_failed return failed_generation content
 */
async function callGroqJsonChat(groq, { messages, model = PRIMARY_MODEL, temperature = 0.3, max_tokens = 8000 }) {
  try {
    const result = await retryWithBackoff(async () => {
      return await groq.chat.completions.create({
        messages,
        model,
        temperature,
        max_tokens,
        response_format: { type: 'json_object' }
      });
    }, 3, 2000);

    return {
      success: true,
      content: result.choices[0]?.message?.content || ''
    };
  } catch (error) {
    if (isJsonValidateFailedError(error)) {
      const failedGeneration = getFailedGeneration(error);
      return {
        success: false,
        content: failedGeneration || '',
        jsonValidateFailed: true
      };
    }
    throw error;
  }
}

/**
 * Repair malformed output into valid JSON using 70b model
 */
async function repairJsonWithGroq(groq, { repairPrompt, fallbackPrompt, logLabel = 'JSON' }) {
  console.warn(`     Repairing ${logLabel} with ${REPAIR_MODEL}`);

  const userPrompt = repairPrompt && repairPrompt.trim().length > 0
    ? repairPrompt
    : fallbackPrompt;

  if (!userPrompt || userPrompt.trim().length === 0) {
    throw new Error('No content available for JSON repair');
  }

  let text = '';

  try {
    const result = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You convert text into valid JSON. Respond with ONLY a valid JSON object. No markdown or extra text.'
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      model: REPAIR_MODEL,
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: 'json_object' }
    });
    text = result.choices[0]?.message?.content || '';
  } catch (error) {
    if (isJsonValidateFailedError(error)) {
      const failedGeneration = getFailedGeneration(error);
      if (failedGeneration) {
        const parsed = tryParseJson(failedGeneration, { quiet: true });
        if (parsed.ok) {
          return parsed.data;
        }
        text = failedGeneration;
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  const parsed = tryParseJson(text);
  if (parsed.ok) {
    return parsed.data;
  }

  throw new Error(`Repair model returned unparseable JSON: ${parsed.parseError?.message || 'unknown parse error'}`);
}

/**
 * Resolve raw Groq text to parsed JSON (local extract, then 70b repair)
 */
async function resolveGroqJsonContent(groq, rawText, { repairPrompt, fallbackPrompt, jsonValidateFailed = false, logLabel = 'JSON' }) {
  if (!rawText || rawText.trim().length === 0) {
    if (jsonValidateFailed && fallbackPrompt) {
      return repairJsonWithGroq(groq, { repairPrompt: '', fallbackPrompt, logLabel });
    }
    throw new Error('Empty response from Groq API');
  }

  const hasJsonStructure = rawText.includes('{') || rawText.includes('[');

  if (!hasJsonStructure) {
    if (jsonValidateFailed || fallbackPrompt) {
      console.warn(`     Model output has no JSON braces, re-parsing with ${REPAIR_MODEL}`);
      return repairJsonWithGroq(groq, {
        repairPrompt: rawText.trim() ? `Convert the following into valid JSON only:\n\n${rawText}` : '',
        fallbackPrompt,
        logLabel
      });
    }
    throw new Error(`No JSON structure in model response. Preview: ${rawText.substring(0, 200)}`);
  }

  const localResult = tryParseJson(rawText, { quiet: true });
  if (localResult.ok) {
    return localResult.data;
  }

  console.warn(`     Local JSON extraction failed, invoking ${REPAIR_MODEL}`);
  return repairJsonWithGroq(groq, {
    repairPrompt: `The following is invalid or mixed-format output. Return ONLY valid JSON:\n\n${rawText}`,
    fallbackPrompt,
    logLabel
  });
}

module.exports = {
  PRIMARY_MODEL,
  REPAIR_MODEL,
  unwrapGroqApiError,
  getGroqErrorPayload,
  isJsonValidateFailedError,
  getFailedGeneration,
  extractJSONByBraces,
  findJsonObjectStart,
  cleanAndExtractJson,
  tryParseJson,
  retryWithBackoff,
  callGroqChatPlain,
  callGroqJsonChat,
  repairJsonWithGroq,
  resolveGroqJsonContent
};
