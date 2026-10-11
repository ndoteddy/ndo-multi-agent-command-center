const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Each provider adapter knows how to (1) locate its CLI, (2) turn a request
// into argv, (3) write per-agent MCP config, and (4) parse the CLI's output
// into { text, usage }. Everything is array-form argv with shell:false, so
// user-typed briefs can never be interpreted by a shell.

const MAX_TRANSCRIPT_CHARS = 12_000;

// --- Binary resolution ------------------------------------------------------
//
// On Windows the global npm commands are .cmd shims that Node can't spawn
// without a shell. Instead we read the package's own "bin" entry and run it
// with the current node binary.

function npmGlobalRoots() {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.npm_config_prefix) {
    roots.push(path.join(process.env.npm_config_prefix, 'node_modules'));
  }
  return roots;
}

function resolveNpmPackageBin(pkgName, binName) {
  for (const root of npmGlobalRoots()) {
    const pkgDir = path.join(root, ...pkgName.split('/'));
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const bin =
        typeof pkg.bin === 'string'
          ? pkg.bin
          : (pkg.bin?.[binName] ?? Object.values(pkg.bin ?? {})[0]);
      if (!bin) continue;
      const entry = path.join(pkgDir, bin);
      if (fs.existsSync(entry)) return entry;
    } catch {
      // not installed under this root
    }
  }
  return null;
}

function resolveClaude() {
  if (process.platform === 'win32') {
    const exe = path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (fs.existsSync(exe)) return { cmd: exe, prefix: [] };
  }
  return { cmd: 'claude', prefix: [] };
}

function resolveNpmCli(pkgName, binName) {
  return () => {
    if (process.platform === 'win32') {
      const entry = resolveNpmPackageBin(pkgName, binName);
      if (entry) return { cmd: process.execPath, prefix: [entry] };
    }
    return { cmd: binName, prefix: [] };
  };
}

// --- Prompt building --------------------------------------------------------
//
// Claude resumes its own sessions. Gemini and Copilot run stateless per call,
// so we replay the (capped) transcript in the prompt instead.

function replayPrompt({ persona, transcript, message, contextPrefix }) {
  const parts = [];
  if (persona) parts.push(`[Instructions]\n${persona}`);
  if (transcript.length > 0) {
    let history = transcript
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
      .join('\n\n');
    if (history.length > MAX_TRANSCRIPT_CHARS) history = '…' + history.slice(-MAX_TRANSCRIPT_CHARS);
    parts.push(`[Conversation so far]\n${history}`);
  }
  parts.push(contextPrefix ? `${contextPrefix}\n\n---\n\nUser: ${message}` : `User: ${message}`);
  return parts.join('\n\n');
}

const estimateTokens = (text) => Math.ceil((text || '').length / 4);

// --- Claude -----------------------------------------------------------------

function mcpToClaude(server) {
  return server.type === 'http'
    ? { type: 'http', url: server.url, headers: server.headers }
    : { type: 'stdio', command: server.command, args: server.args, env: server.env };
}

const claude = {
  id: 'claude',
  binName: 'claude',
  resolve: resolveClaude,
  stateful: true,

  buildArgs({
    prompt,
    persona,
    model,
    taskPolicy,
    mcpServers,
    dir,
    sessionId,
    isFirstTurn,
    maxBudget,
  }) {
    const args = ['-p', prompt, '--output-format', 'json', '--max-budget-usd', maxBudget];
    args.push('--permission-mode', 'default', '--disallowedTools', taskPolicy.disallowed);

    const allowed = [taskPolicy.allowed, ...mcpServers.map((s) => `mcp__${s.name}`)].filter(
      Boolean,
    );
    if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));
    if (persona) args.push('--append-system-prompt', persona);
    if (model) args.push('--model', model);

    // --strict-mcp-config keeps the user's global/project MCP servers out, so
    // an agent only ever sees the servers explicitly attached to it.
    const configPath = path.join(dir, 'mcp.json');
    const mcpServersConfig = Object.fromEntries(mcpServers.map((s) => [s.name, mcpToClaude(s)]));
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: mcpServersConfig }, null, 2));
    args.push('--mcp-config', configPath, '--strict-mcp-config');

    args.push(isFirstTurn ? '--session-id' : '--resume', sessionId);
    return args;
  },

  parse(stdout) {
    const data = JSON.parse(stdout);
    // `usage` only covers the main model. Web research also runs a small helper
    // model to digest fetched pages, and that shows up only in `modelUsage`,
    // so sum every model there and fall back to `usage` if it is absent.
    const perModel = Object.values(data.modelUsage ?? {});
    let input;
    let output;
    if (perModel.length > 0) {
      input = perModel.reduce(
        (n, m) =>
          n +
          (m.inputTokens ?? 0) +
          (m.cacheReadInputTokens ?? 0) +
          (m.cacheCreationInputTokens ?? 0),
        0,
      );
      output = perModel.reduce((n, m) => n + (m.outputTokens ?? 0), 0);
    } else {
      const u = data.usage ?? {};
      input =
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      output = u.output_tokens ?? 0;
    }
    return {
      text: String(data.result ?? ''),
      isError: Boolean(data.is_error),
      usage: {
        inputTokens: input,
        outputTokens: output,
        costUsd: typeof data.total_cost_usd === 'number' ? data.total_cost_usd : undefined,
        estimated: false,
      },
    };
  },
};

// --- Gemini -----------------------------------------------------------------

function mcpToGemini(server) {
  // trust:true skips Gemini's per-call approval prompt, which nobody can
  // answer in headless mode. The user opted in by attaching the server.
  return server.type === 'http'
    ? { httpUrl: server.url, headers: server.headers, trust: true }
    : { command: server.command, args: server.args, env: server.env, trust: true };
}

const gemini = {
  id: 'gemini',
  binName: 'gemini',
  resolve: resolveNpmCli('@google/gemini-cli', 'gemini'),
  stateful: false,

  buildArgs({ prompt, model, mcpServers, dir }) {
    // Project-level settings in the agent's private sandbox dir.
    const settingsDir = path.join(dir, '.gemini');
    fs.mkdirSync(settingsDir, { recursive: true });
    const mcp = Object.fromEntries(mcpServers.map((s) => [s.name, mcpToGemini(s)]));
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ mcpServers: mcp }, null, 2),
    );

    const args = ['-p', prompt, '--output-format', 'json'];
    if (model) args.push('-m', model);
    if (mcpServers.length > 0) {
      args.push('--allowed-mcp-server-names', ...mcpServers.map((s) => s.name));
    }
    return args;
  },

  parse(stdout) {
    // The CLI can print banner/warning lines before the JSON object.
    const start = stdout.indexOf('{');
    const data = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
    if (data.error) throw new Error(data.error.message ?? 'Gemini CLI reported an error.');
    let input = 0;
    let output = 0;
    let found = false;
    for (const model of Object.values(data.stats?.models ?? {})) {
      const t = model.tokens ?? {};
      if (t.prompt != null || t.candidates != null) found = true;
      input += t.prompt ?? t.input ?? 0;
      output += (t.candidates ?? 0) + (t.thoughts ?? 0);
    }
    return {
      text: String(data.response ?? ''),
      isError: false,
      usage: found ? { inputTokens: input, outputTokens: output, estimated: false } : null,
    };
  },
};

// --- Copilot ----------------------------------------------------------------

function mcpToCopilot(server) {
  return server.type === 'http'
    ? { type: 'http', url: server.url, headers: server.headers, tools: ['*'] }
    : { type: 'local', command: server.command, args: server.args, env: server.env, tools: ['*'] };
}

const copilot = {
  id: 'copilot',
  binName: 'copilot',
  resolve: resolveNpmCli('@github/copilot', 'copilot'),
  stateful: false,

  buildArgs({ prompt, model, taskPolicy, mcpServers, dir }) {
    const args = ['-p', prompt, '--silent'];
    if (model) args.push('--model', model);
    if (taskPolicy.allowed.includes('WebFetch')) args.push('--allow-all-urls');
    if (mcpServers.length > 0) {
      const configPath = path.join(dir, 'copilot-mcp.json');
      const mcp = Object.fromEntries(mcpServers.map((s) => [s.name, mcpToCopilot(s)]));
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: mcp }, null, 2));
      args.push('--additional-mcp-config', `@${configPath}`);
      for (const s of mcpServers) args.push(`--allow-tool=${s.name}`);
    }
    return args;
  },

  // Copilot's CLI prints plain text and does not report token counts.
  parse(stdout) {
    return { text: stdout.trim(), isError: false, usage: null };
  },
};

const PROVIDERS = { claude, gemini, copilot };

// --- Detection --------------------------------------------------------------

const detectionCache = new Map();

function detect(provider) {
  const cached = detectionCache.get(provider.id);
  if (cached && Date.now() - cached.at < 30_000) return Promise.resolve(cached.value);

  return new Promise((resolve) => {
    const { cmd, prefix } = provider.resolve();
    execFile(
      cmd,
      [...prefix, '--version'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        const value = err
          ? { installed: false }
          : { installed: true, version: String(stdout).trim().split('\n').pop().slice(0, 60) };
        detectionCache.set(provider.id, { at: Date.now(), value });
        resolve(value);
      },
    );
  });
}

async function detectAll() {
  const entries = await Promise.all(
    Object.values(PROVIDERS).map(async (p) => [p.id, await detect(p)]),
  );
  return Object.fromEntries(entries);
}

// --- Model discovery --------------------------------------------------------
//
// None of the CLIs has a "list models" command, so we ask each one what it
// can: Claude's --help names its aliases and a one-word run reveals which
// concrete model each alias currently resolves to (modelUsage in the JSON
// result); Copilot's --help may enumerate --model choices. Gemini exposes
// nothing, so the UI falls back to its built-in presets for it.

function capture(provider, args, timeout) {
  return new Promise((resolve) => {
    const { cmd, prefix } = provider.resolve();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-models-'));
    const child = execFile(
      cmd,
      [...prefix, ...args],
      { timeout, windowsHide: true, cwd, maxBuffer: 4_000_000 },
      (err, stdout, stderr) => {
        fs.rm(cwd, { recursive: true, force: true }, () => {});
        resolve({ err, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin.end(); // avoid the CLI waiting on stdin
  });
}

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1);

// `claude --help` only names a few aliases, but the CLI's own /model picker
// offers many specific versions. Those live in the binary's model catalog, so
// we read the model ids out of it (streamed: the binary is ~200 MB).
function findClaudeBinaryFile() {
  const { cmd } = claude.resolve();
  const candidates = path.isAbsolute(cmd)
    ? [cmd]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .flatMap((dir) => [path.join(dir, 'claude'), path.join(dir, 'claude.exe')]);
  for (const file of candidates) {
    try {
      const real = fs.realpathSync(file);
      if (fs.statSync(real).size > 5_000_000) return real; // skip tiny shell shims
    } catch {
      // not here
    }
  }
  return null;
}

// Minor versions are a single digit; a longer match is a prefix of something else.
const MODEL_ID = /claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d)?(?![\w-])/g;

function scanBinaryForModelIds(file) {
  return new Promise((resolve) => {
    const found = new Set();
    let tail = '';
    const stream = fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 4 << 20 });
    stream.on('data', (chunk) => {
      const text = tail + chunk;
      for (const m of text.matchAll(MODEL_ID)) found.add(m[0]);
      tail = text.slice(-80); // ids can straddle chunk boundaries
    });
    stream.on('end', () => resolve([...found]));
    stream.on('error', () => resolve([]));
  });
}

// Newer models an older CLI's catalog may not list yet. They are offered anyway:
// a CLI that is too old answers with a clear "run claude update" error.
const KNOWN_RECENT = [
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
];

async function discoverClaudeVersions(skip) {
  const file = findClaudeBinaryFile();
  const inCatalog = new Set(file ? await scanBinaryForModelIds(file) : []);
  const ids = [...new Set([...inCatalog, ...KNOWN_RECENT])];
  const parsed = ids
    .map((id) => {
      const m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/);
      return (
        m && {
          id,
          family: m[1],
          major: Number(m[2]),
          minor: m[3] === undefined ? null : Number(m[3]),
        }
      );
    })
    // A bare "claude-opus-4" is ambiguous; only fable is versioned by major alone.
    .filter((p) => p && (p.minor !== null || p.family === 'fable') && !skip.has(p.id))
    .map((p) => ({ ...p, listed: inCatalog.has(p.id) }));
  const order = { opus: 0, sonnet: 1, haiku: 2, fable: 3 };
  parsed.sort(
    (a, b) =>
      order[a.family] - order[b.family] || b.major - a.major || (b.minor ?? 0) - (a.minor ?? 0),
  );
  return parsed.map((p) => ({
    value: p.id,
    label: `${titleCase(p.family)} ${p.major}${p.minor === null ? '' : '.' + p.minor}`,
    resolved: p.id,
    available: true,
    group: 'versions',
    note: p.listed
      ? 'From the CLI model catalog; not verified against your plan.'
      : 'Newer than your CLI knows about. If it errors, run `claude update`.',
  }));
}

async function discoverClaude() {
  const help = await capture(claude, ['--help'], 15_000);
  const section = help.stdout.match(/alias for the latest model \(e\.g\.([\s\S]*?)\)/);
  const aliases = [...(section?.[1] ?? '').matchAll(/'([a-z][a-z0-9-]*)'/g)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith('claude-'));
  // `--help` only names some aliases; haiku is always accepted.
  const unique = [...new Set([...aliases, 'haiku'])];
  if (unique.length === 0) throw new Error('Could not read model aliases from `claude --help`.');

  // One tiny prompt per alias. Costs a few cents in total. A failed probe is
  // retried once on its own: parallel CLI starts occasionally trip over each other.
  const probe = async (alias) => {
    const run = await capture(
      claude,
      [
        '-p',
        'hi',
        '--model',
        alias,
        '--output-format',
        'json',
        '--max-budget-usd',
        '0.3',
        '--disallowedTools',
        'Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch',
      ],
      60_000,
    );
    try {
      const data = JSON.parse(run.stdout);
      const resolved = Object.keys(data.modelUsage ?? {})[0];
      if (data.is_error || !resolved) {
        return {
          value: alias,
          label: titleCase(alias),
          available: false,
          note: String(data.result ?? 'unavailable').slice(0, 140),
        };
      }
      return { value: alias, label: titleCase(alias), resolved, available: true };
    } catch {
      return {
        value: alias,
        label: titleCase(alias),
        available: false,
        note: 'Could not resolve this alias.',
      };
    }
  };
  const aliasModels = await Promise.all(unique.map(probe));
  for (let i = 0; i < aliasModels.length; i++) {
    const failed = !aliasModels[i].available && !/credits/i.test(aliasModels[i].note ?? '');
    if (failed) aliasModels[i] = await probe(aliasModels[i].value);
  }

  // Specific versions, minus any the aliases already resolved to.
  const resolved = aliasModels.map((m) => m.resolved).filter(Boolean);
  const versions = (await discoverClaudeVersions(new Set())).filter(
    // `claude-haiku-4-5` is the same model as an alias resolving to `claude-haiku-4-5-20251001`.
    (v) => !resolved.some((id) => id === v.value || id.startsWith(`${v.value}-`)),
  );
  return [...aliasModels, ...versions];
}

async function discoverCopilot() {
  const help = await capture(copilot, ['--help'], 15_000);
  const line = help.stdout.match(/--model\s+<model>[\s\S]*?\(choices:\s*([^)]*)\)/);
  const choices = [...(line?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (choices.length === 0) throw new Error('Copilot --help does not list model choices.');
  return choices.map((value) => ({ value, label: value, resolved: value, available: true }));
}

const DISCOVERERS = { claude: discoverClaude, copilot: discoverCopilot };

// Returns { [providerId]: { models, error? } } for every provider we can ask.
async function discoverModels() {
  const status = await detectAll();
  const result = {};
  await Promise.all(
    Object.entries(DISCOVERERS).map(async ([id, discover]) => {
      if (!status[id]?.installed) {
        result[id] = { models: [], error: 'CLI not installed' };
        return;
      }
      try {
        result[id] = { models: await discover() };
      } catch (err) {
        result[id] = { models: [], error: err.message };
      }
    }),
  );
  return result;
}

module.exports = { PROVIDERS, detectAll, discoverModels, replayPrompt, estimateTokens };
