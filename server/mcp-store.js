const fs = require('fs');
const path = require('path');

// The MCP library is a saved list of servers the user can attach to any agent.
// It lives in config/mcp-servers.json (gitignored, since `env` and `headers`
// commonly hold API keys). Agents reference servers by name; the backend
// translates the selection into each CLI's own config format at run time.

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const MCP_PATH = path.join(CONFIG_DIR, 'mcp-servers.json');
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

function isStringRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

// Returns a cleaned server object, or throws with a message fit for the UI.
function validateServer(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Each MCP server must be an object.');
  const name = String(raw.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid MCP name "${name}": use letters, numbers, "-" or "_" (max 32).`);
  }

  if (raw.type === 'http') {
    let url;
    try {
      url = new URL(String(raw.url));
    } catch {
      throw new Error(`MCP "${name}": invalid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`MCP "${name}": URL must be http(s).`);
    }
    const headers = raw.headers ?? {};
    if (!isStringRecord(headers)) throw new Error(`MCP "${name}": headers must be strings.`);
    return { name, type: 'http', url: url.toString(), headers };
  }

  if (raw.type === 'stdio') {
    const command = String(raw.command ?? '').trim();
    if (!command) throw new Error(`MCP "${name}": command is required.`);
    const args = raw.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
      throw new Error(`MCP "${name}": args must be a list of strings.`);
    }
    const env = raw.env ?? {};
    if (!isStringRecord(env)) throw new Error(`MCP "${name}": env must be strings.`);
    return { name, type: 'stdio', command, args, env };
  }

  throw new Error(`MCP "${name}": type must be "stdio" or "http".`);
}

function loadServers() {
  try {
    const list = JSON.parse(fs.readFileSync(MCP_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveServers(rawList) {
  if (!Array.isArray(rawList)) throw new Error('Expected a list of MCP servers.');
  if (rawList.length > 50) throw new Error('Too many MCP servers (max 50).');
  const servers = rawList.map(validateServer);
  const names = new Set();
  for (const server of servers) {
    if (names.has(server.name)) throw new Error(`Duplicate MCP name "${server.name}".`);
    names.add(server.name);
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MCP_PATH, JSON.stringify(servers, null, 2));
  return servers;
}

// Resolve the names an agent asked for against the saved library. Unknown
// names are dropped silently (e.g. the server was deleted after spawn).
function selectServers(names) {
  const library = new Map(loadServers().map((s) => [s.name, s]));
  return names.map((name) => library.get(name)).filter(Boolean);
}

module.exports = { loadServers, saveServers, selectServers, NAME_RE, MCP_PATH };
