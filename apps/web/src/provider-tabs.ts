/**
 * One tab per model provider on the Agents keys strip. The first key is
 * the one whose presence lights the tab; base URLs ride along on the
 * provider they redirect.
 *
 * Kept out of the Credentials component so a unit test can name the
 * list without loading the auth client (which reads window).
 */
export const PROVIDER_TABS = [
  { id: "anthropic", label: "Anthropic", keys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
  { id: "openai", label: "OpenAI", keys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
  { id: "openrouter", label: "OpenRouter", keys: ["OPENROUTER_API_KEY"] },
  { id: "cursor", label: "Cursor", keys: ["CURSOR_API_KEY"] },
  { id: "gemini", label: "Gemini", keys: ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"] },
  { id: "poolside", label: "Poolside", keys: ["POOLSIDE_API_KEY"] },
  { id: "deepseek", label: "DeepSeek", keys: ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] },
  { id: "meta", label: "Meta", keys: ["META_API_KEY"] },
  { id: "ollama", label: "Ollama", keys: ["OLLAMA_API_KEY", "OLLAMA_BASE_URL"] },
  { id: "vercel", label: "Vercel AI Gateway", keys: ["AI_GATEWAY_API_KEY"] },
] as const;
