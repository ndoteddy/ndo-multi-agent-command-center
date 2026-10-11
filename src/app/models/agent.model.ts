export type AgentStatus = 'idle' | 'working' | 'done';

export type AgentTaskType = 'draft-article' | 'web-search' | 'generic';

export type ProviderId = 'claude' | 'gemini' | 'copilot';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** True when the CLI reports no usage and the backend estimated it (~4 chars/token). */
  estimated?: boolean;
}

export interface Turn {
  role: 'user' | 'agent';
  text: string;
  usage?: TokenUsage;
}

export type McpServer =
  | { name: string; type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { name: string; type: 'http'; url: string; headers: Record<string, string> };

export interface Agent {
  id: string;
  name: string;
  brief: string;
  taskType: AgentTaskType;
  provider: ProviderId;
  /** Empty string means "the CLI's own default model". */
  model: string;
  mcp: string[];
  relatedIds: string[];
  status: AgentStatus;
  progress: number;
  transcript: Turn[];
  usage: TokenUsage;
  error: boolean;
}

export const TASK_TYPE_LABELS: Record<AgentTaskType, string> = {
  'draft-article': 'Draft Article',
  'web-search': 'Search Internet',
  generic: 'Generic Task',
};

export interface ModelOption {
  value: string;
  label: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  models: ModelOption[];
  install: string;
  login: string;
  verify: string;
  notes: string[];
  docsUrl: string;
}

// Model lists are presets only: the spawn form also offers a free-text
// "Custom…" option, so newly released models work without a code change.
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    models: [
      { value: 'sonnet', label: 'Sonnet (latest)' },
      { value: 'opus', label: 'Opus (latest)' },
      { value: 'haiku', label: 'Haiku (latest)' },
    ],
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude',
    verify: 'claude --version',
    notes: [
      'Run `claude` once and follow the sign-in prompt (Claude subscription or API billing).',
      'Reports exact token usage and cost per run.',
    ],
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    models: [
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
    ],
    install: 'npm install -g @google/gemini-cli',
    login: 'gemini',
    verify: 'gemini --version',
    notes: [
      'Run `gemini` once and choose "Login with Google", or set GEMINI_API_KEY before starting the backend.',
      'Follow-up replies replay the conversation, since each Gemini run is stateless.',
      'Runs headless, so tools that need approval are denied; attached MCP servers are trusted.',
    ],
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    models: [
      { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { value: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      { value: 'gpt-5', label: 'GPT-5' },
    ],
    install: 'npm install -g @github/copilot',
    login: 'copilot  (then type /login)',
    verify: 'copilot --version',
    notes: [
      'Requires an active GitHub Copilot subscription. Run `copilot`, then `/login` to authenticate.',
      'Copilot does not report token counts, so usage is estimated (about 4 characters per token).',
      'Follow-up replies replay the conversation, since each Copilot run is stateless.',
      'Available models depend on your Copilot plan; use "Custom…" for any model name.',
    ],
    docsUrl: 'https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
