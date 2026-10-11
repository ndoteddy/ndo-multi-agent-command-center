const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROVIDERS,
  detectAll,
  discoverModels,
  replayPrompt,
  estimateTokens,
} = require('./providers');
const { loadServers, saveServers, selectServers, NAME_RE } = require('./mcp-store');

const PORT = process.env.PORT || 4000;
const RUN_TIMEOUT_MS = 180_000;
const MAX_BUDGET_USD = '0.50';
const MAX_CONTEXT_CHARS = 3000;
const VAULT_DIR = path.join(__dirname, '..', 'vault');
const INDEX_PATH = path.join(VAULT_DIR, '.index.json');
const SAFE_ID = /^[a-zA-Z0-9-]+$/;
// Must start alphanumeric so a model value can never be parsed as a CLI flag.
const SAFE_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$/;

fs.mkdirSync(VAULT_DIR, { recursive: true });

// Deny-by-default: each task type only gets the tools it actually needs.
// --allowedTools pre-approves exactly those (so headless mode never stalls
// waiting on an approval prompt nobody can answer); --disallowedTools is a
// backstop that blocks the filesystem/shell tools regardless. (Claude-specific
// names; the other adapters map the policy onto their own flags.)
const ALLOWED_TOOLS = {
  'draft-article': '',
  'web-search': 'WebSearch,WebFetch',
  generic: '',
};

const DISALLOWED_TOOLS = {
  'draft-article': 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebSearch,WebFetch',
  'web-search': 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit',
  generic: 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebSearch,WebFetch',
};

// Claude Code's default system prompt frames it as a software-engineering
// assistant, which makes it reflexively refuse unrelated requests (e.g. "I'm
// a software engineering assistant and can't search for flight tickets")
// even when the WebSearch tool is explicitly enabled below. Appending a
// task-specific persona on top of (not replacing) the default prompt fixes
// that without losing Claude Code's normal tool-use behavior.
const SYSTEM_PROMPT_ADDITIONS = {
  'draft-article':
    'For this session, act as a general-purpose writing assistant for the user — not a software-engineering assistant. Write the requested content directly and completely. Do not refuse or redirect just because the topic has nothing to do with code.',
  'web-search':
    'For this session, act as a general-purpose web research assistant for the user — not a software-engineering assistant. You have the WebSearch and WebFetch tools enabled and must actually use them for every request, including things like travel, prices, products, news, or any other everyday topic. Give a direct, concrete answer (specific options, prices, sources) instead of refusing or telling the user to go check a website themselves — you have the tools to check it yourself, so do that.',
  generic:
    'For this session, act as a general-purpose assistant for the user, not limited to software engineering. Answer the request directly and helpfully regardless of topic.',
};

// --- Vault (Obsidian-openable knowledge store) -----------------------------
//
// Every agent gets one Markdown note in VAULT_DIR that accumulates its full
// conversation across turns. Related agents are linked with [[wikilinks]]
// in a "Related Agents" section, which Obsidian's graph view renders as
// edges automatically — no extra config needed, just open VAULT_DIR as a
// vault in Obsidian.

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

function noteFilename(id, name) {
  return `${slugify(name)}-${id.slice(0, 8)}.md`;
}

function notePath(id, name) {
  return path.join(VAULT_DIR, noteFilename(id, name));
}

function readNoteBody(id) {
  const index = loadIndex();
  const entry = index[id];
  if (!entry) return null;
  try {
    const raw = fs.readFileSync(path.join(VAULT_DIR, entry.filename), 'utf8');
    return raw.replace(/^---[\s\S]*?---\n/, '').trim();
  } catch {
    return null;
  }
}

function writeNote(session) {
  const index = loadIndex();
  index[session.id] = { name: session.name, filename: noteFilename(session.id, session.name) };
  saveIndex(index);

  const relatedLines = session.relatedIds
    .map((relId) => index[relId])
    .filter(Boolean)
    .map((rel) => `- [[${rel.filename.replace(/\.md$/, '')}|${rel.name}]]`);

  const conversation = session.transcript
    .map((turn) => `**${turn.role === 'user' ? 'You' : 'Agent'}:** ${turn.text}`)
    .join('\n\n');

  const { inputTokens, outputTokens, estimated } = session.usage;

  const frontmatter = [
    '---',
    `id: ${session.id}`,
    `name: "${session.name.replace(/"/g, "'")}"`,
    `taskType: ${session.taskType}`,
    `provider: ${session.provider}`,
    `model: ${session.model || 'default'}`,
    `tokens: ${inputTokens + outputTokens}`,
    `status: ${session.status}`,
    `updated: ${new Date().toISOString()}`,
    `tags: [agent, ${slugify(session.taskType)}]`,
    '---',
    '',
  ].join('\n');

  const body = [
    `# ${session.name}`,
    '',
    `**Task type:** ${session.taskType}`,
    `**CLI / model:** ${session.provider} / ${session.model || 'default'}`,
    `**Tokens:** ${inputTokens} in, ${outputTokens} out${estimated ? ' (estimated)' : ''}`,
    `**Original brief:** ${session.brief}`,
    '',
    '## Related Agents',
    relatedLines.length > 0 ? relatedLines.join('\n') : '_None_',
    '',
    '## Conversation',
    '',
    conversation,
    '',
  ].join('\n');

  fs.writeFileSync(notePath(session.id, session.name), frontmatter + body);
}

// --- Agent sessions ----------------------------------------------------
//
// Each agent gets one persistent sandbox directory reused across turns. For
// Claude, its own session persistence (keyed by id + cwd) lets us --resume a
// conversation instead of starting over every time — this is what lets the
// UI "reply" to a clarifying question instead of dead-ending. The other CLIs
// are stateless, so their follow-ups replay the transcript in the prompt.

const sessions = new Map(); // id -> session (see getOrCreateSession)

function getOrCreateSession(id, opts) {
  let session = sessions.get(id);
  if (!session) {
    session = {
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-')),
      id,
      started: false,
      ...opts,
      contextPrefix: buildContextPrefix(opts.relatedIds),
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0, estimated: false },
      status: 'working',
    };
    sessions.set(id, session);
  }
  return session;
}

function buildContextPrefix(relatedIds) {
  const index = loadIndex();
  const contextBlocks = relatedIds
    .map((relId) => ({ meta: index[relId], body: readNoteBody(relId) }))
    .filter((entry) => entry.meta && entry.body)
    .map(
      (entry) =>
        `### Context from related agent "${entry.meta.name}":\n${entry.body.slice(0, MAX_CONTEXT_CHARS)}`,
    );
  if (contextBlocks.length === 0) return '';
  return `You are given context from related agent(s). Use it if relevant to the task below.\n\n${contextBlocks.join('\n\n')}`;
}

function sendEvent(res, type, payload) {
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleRun(req, res, query) {
  const message = (query.get('brief') || '').trim();
  const taskType = query.get('taskType') || 'generic';
  const id = query.get('id') || '';
  const name = query.get('name') || 'Agent';
  const providerId = query.get('provider') || 'claude';
  const model = (query.get('model') || '').trim();
  const splitList = (key) =>
    (query.get(key) || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  const relatedIds = splitList('relatedIds');
  const mcpNames = splitList('mcp');

  const provider = PROVIDERS[providerId];
  const problem = !message
    ? 'brief is required'
    : !(taskType in DISALLOWED_TOOLS)
      ? 'unknown taskType'
      : !id || !SAFE_ID.test(id) || !relatedIds.every((relId) => SAFE_ID.test(relId))
        ? 'invalid id'
        : !provider
          ? 'unknown provider'
          : model && !SAFE_MODEL.test(model)
            ? 'invalid model'
            : !mcpNames.every((n) => NAME_RE.test(n))
              ? 'invalid mcp name'
              : '';
  if (problem) {
    sendJson(res, 400, { error: problem });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const session = getOrCreateSession(id, {
    name,
    taskType,
    brief: message,
    relatedIds,
    provider: providerId,
    model,
  });
  const isFirstTurn = !session.started;
  const persona = SYSTEM_PROMPT_ADDITIONS[taskType];
  const mcpServers = selectServers(mcpNames);

  const prompt = provider.stateful
    ? isFirstTurn && session.contextPrefix
      ? `${session.contextPrefix}\n\n---\n\nTask: ${message}`
      : message
    : replayPrompt({
        persona,
        transcript: session.transcript,
        message,
        contextPrefix: session.contextPrefix,
      });

  session.transcript.push({ role: 'user', text: message });

  let args;
  try {
    args = provider.buildArgs({
      prompt,
      persona,
      model,
      taskPolicy: { allowed: ALLOWED_TOOLS[taskType], disallowed: DISALLOWED_TOOLS[taskType] },
      mcpServers,
      dir: session.dir,
      sessionId: id,
      isFirstTurn,
      maxBudget: MAX_BUDGET_USD,
    });
  } catch (err) {
    sendEvent(res, 'error', { message: `Could not prepare ${providerId} run: ${err.message}` });
    res.end();
    return;
  }

  // Array-form argv with shell:false (the spawn default) — the prompt is
  // passed as a single argument, never interpolated into a shell string, so
  // it cannot inject extra commands no matter what the user types.
  const { cmd, prefix } = provider.resolve();
  const child = spawn(cmd, [...prefix, ...args], { cwd: session.dir, shell: false });
  child.stdin.end(); // no piped input — close it so the CLI doesn't wait probing stdin

  let stdout = '';
  let stderr = '';
  let finished = false;

  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    child.kill();
    sendEvent(res, 'error', {
      message: `Agent run timed out after ${RUN_TIMEOUT_MS / 1000}s.`,
    });
    res.end();
  }, RUN_TIMEOUT_MS);

  const settle = () => {
    finished = true;
    clearTimeout(timeout);
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (err) => {
    if (finished) return;
    settle();
    const hint =
      err.code === 'ENOENT'
        ? ` Is the ${providerId} CLI installed? Click the Help button in the header for setup steps.`
        : '';
    sendEvent(res, 'error', {
      message: `Could not start ${providerId} CLI: ${err.message}.${hint}`,
    });
    res.end();
  });

  child.on('close', (code) => {
    if (finished) return;
    settle();

    let parsed = null;
    let parseError = '';
    try {
      parsed = provider.parse(stdout);
    } catch (err) {
      parseError = err.message;
    }

    if (code !== 0 || !parsed || parsed.isError) {
      const detail = (parsed?.text || stderr || stdout || parseError).trim().slice(0, 1500);
      sendEvent(res, 'error', {
        message: detail || `${providerId} CLI exited with code ${code}.`,
      });
      res.end();
      return;
    }

    // Providers that don't report usage get a ~4 chars/token estimate,
    // flagged as such so the UI can mark it.
    const usage = parsed.usage ?? {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(parsed.text),
      estimated: true,
    };
    session.usage.inputTokens += usage.inputTokens;
    session.usage.outputTokens += usage.outputTokens;
    session.usage.estimated = session.usage.estimated || usage.estimated;

    session.started = true;
    session.status = 'done';
    session.transcript.push({ role: 'agent', text: parsed.text });
    try {
      writeNote(session);
    } catch (err) {
      console.error('Failed to write vault note:', err);
    }

    sendEvent(res, 'chunk', { text: parsed.text });
    sendEvent(res, 'usage', usage);
    sendEvent(res, 'done', { code });
    res.end();
  });

  req.on('close', () => {
    settle();
    child.kill();
  });
}

function handleForget(res, id) {
  if (!id || !SAFE_ID.test(id)) {
    sendJson(res, 400, { error: 'invalid id' });
    return;
  }
  const session = sessions.get(id);
  if (session) {
    fs.rm(session.dir, { recursive: true, force: true }, () => {});
    sessions.delete(id);
  }
  sendJson(res, 200, { ok: true });
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// Last-resort safety net: a POC backend running agent processes shouldn't go
// down and drop every other in-flight run because of one bug in a handler.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (backend kept alive):', err);
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/agents/run') {
    handleRun(req, res, url.searchParams);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers') {
    detectAll().then((status) => sendJson(res, 200, status));
    return;
  }

  // Cached in config/models.json; ?refresh=1 re-asks the CLIs (costs a few cents for Claude).
  if (req.method === 'GET' && url.pathname === '/api/models') {
    const cachePath = path.join(__dirname, '..', 'config', 'models.json');
    const readCache = () => {
      try {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      } catch {
        return null;
      }
    };
    if (url.searchParams.get('refresh') !== '1') {
      sendJson(res, 200, readCache() ?? { updatedAt: null, providers: {} });
      return;
    }
    discoverModels()
      .then((providers) => {
        const previous = readCache()?.providers ?? {};
        // A failed discovery must not wipe a previously good list.
        for (const [id, entry] of Object.entries(providers)) {
          if (entry.models.length === 0 && previous[id]?.models?.length) {
            providers[id] = { ...previous[id], error: entry.error };
          }
        }
        const cache = { updatedAt: new Date().toISOString(), providers };
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
        sendJson(res, 200, cache);
      })
      .catch((err) => sendJson(res, 500, { error: err.message }));
    return;
  }

  if (url.pathname === '/api/mcp' && req.method === 'GET') {
    sendJson(res, 200, loadServers());
    return;
  }

  if (url.pathname === '/api/mcp' && req.method === 'PUT') {
    readBody(req)
      .then((raw) => sendJson(res, 200, saveServers(JSON.parse(raw))))
      .catch((err) => sendJson(res, 400, { error: err.message }));
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/agents/')) {
    handleForget(res, url.pathname.slice('/api/agents/'.length));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

// Loopback only: this API can launch CLIs and stores MCP commands/secrets, so
// it must not be reachable from other machines on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent runner backend listening on http://127.0.0.1:${PORT}`);
  console.log(`Knowledge vault (open this folder in Obsidian): ${VAULT_DIR}`);
});
