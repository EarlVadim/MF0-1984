/**
 * src/modelContextConfig.js
 *
 * Per-provider context budget configuration.
 *
 * maxInputTokens   — сколько токенов отправляем модели (input budget).
 *                    Должно быть заметно меньше реального окна модели,
 *                    чтобы оставался запас на системный промпт и ответ.
 *
 * recentMessageCount — сколько последних сообщений диалога включать
 *                      в контекст напрямую (остальное идёт через RAG/retrieval).
 *                      Движок зажимает значение в [6, 24] — это ограничение
 *                      в buildModelContext.js (строка Math.min(24, Math.max(6, n))).
 *                      Если нужно больше 24 — нужно менять и тот файл.
 *
 * Провайдеры:
 *   gemini-flash  — Google Gemini (1M окно)
 *   or-1          — OpenRouter Slot 1
 *   or-2          — OpenRouter Slot 2
 *   or-3          — OpenRouter Slot 3
 *   openai        — OpenAI (128k окно у большинства моделей)
 *   anthropic     — Claude (200k окно)
 *   ollama        — локальные модели (окно зависит от модели)
 *   default       — fallback для неизвестных провайдеров
 */

/** @type {Record<string, { maxInputTokens: number, recentMessageCount: number }>} */
export const MODEL_CONTEXT_CONFIG = {
  // ── Google Gemini (1M контекстное окно) ──────────────────────────────────
  "gemini-flash": {
    maxInputTokens:      200_000,   // ~20% от 1M — разумный лимит для скорости
    recentMessageCount:  24,        // максимум что пропускает движок
  },

  // ── OpenRouter Slot 1 (предполагается модель с 1M окном) ─────────────────
  "or-1": {
    maxInputTokens:      200_000,
    recentMessageCount:  24,
  },

  // ── OpenRouter Slot 2 (предполагается модель с 1M окном) ─────────────────
  "or-2": {
    maxInputTokens:      200_000,
    recentMessageCount:  24,
  },

  // ── OpenRouter Slot 3 (256k окно) ────────────────────────────────────────
  "or-3": {
    maxInputTokens:      180_000,   // ~70% от 256k
    recentMessageCount:  24,
  },

  // ── OpenAI (128k у GPT-4o, 32k у старых) ────────────────────────────────
  "openai": {
    maxInputTokens:      100_000,
    recentMessageCount:  20,
  },

  // ── Anthropic Claude (200k окно) ─────────────────────────────────────────
  "anthropic": {
    maxInputTokens:      150_000,
    recentMessageCount:  24,
  },

  // ── Ollama (локально, окно зависит от модели — консервативно) ────────────
  "ollama": {
    maxInputTokens:      180_000,
    recentMessageCount:  24,
  },

  // ── Fallback ─────────────────────────────────────────────────────────────
  "default": {
    maxInputTokens:      64_000,
    recentMessageCount:  16,
  },
};

/**
 * Получить конфиг контекста для провайдера.
 * @param {string} providerId
 * @returns {{ maxInputTokens: number, recentMessageCount: number }}
 */
export function getModelContextConfig(providerId) {
  return MODEL_CONTEXT_CONFIG[providerId] ?? MODEL_CONTEXT_CONFIG["default"];
}
