# Local Agent Quota

A local, read-only quota CLI and MCP server for Codex and Claude Code. It reports provider windows, percentage used and remaining, reset times, source, and freshness. It does not change models, start agent turns, spend reset credits, or estimate quota from token counts. Requires Node.js 20+, authenticated provider installations, and `npm install`.

## Run

```powershell
npm install
node src/cli.js get              # both providers, JSON
node src/cli.js get codex
node src/cli.js get claude
npm test
```

Codex uses `codex app-server` and `account/rateLimits/read`, with the credentials available to that process. Set `AGENT_QUOTA_CODEX` to the absolute path of a different executable, or `CODEX_HOME` for the intended account. A T3-managed or remote account may use a different home; check the source/account setup before relying on the result. API-key-only configurations may not have subscription windows.

## Claude usage

The Claude reader uses the Claude Agent SDK's **experimental** usage method without sending a model prompt. It may change or stop working. The SDK launches Claude Code; set `AGENT_QUOTA_CLAUDE` to an absolute executable path if its default CLI is not the intended one, and `CLAUDE_CONFIG_DIR` if needed to select the account. API-key and proxy accounts may not expose subscription limits. A successful observation is cached for 10 minutes; a failed refresh returns an older snapshot marked stale. Each process may refresh independently, so avoid running many simultaneous probes. The data is account-specific and may differ from T3's selected account.

### Optional status-line capture

Claude's documented status-line input can also include quota after its first response for supported subscriptions. Both sources store **only normalized quota windows and the observation time**, in `~/.agent-quota/claude.json`. The tool does not directly read OAuth credentials. An empty status-line update does not overwrite the last reading; an old reading is marked `stale` after 10 minutes by default. Missing data is `unavailable`, never zero usage.

Configure Claude Code's `statusLine` command to invoke the capture on the machine and account where Claude runs. On Windows, replace the paths with your actual absolute paths, and merge this into your existing Claude settings rather than replacing other settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"C:/nvm4w/nodejs/node.exe\" \"C:/path/to/local-agent-quota/src/cli.js\" claude-statusline"
  }
}
```

This replaces an existing status-line command unless you combine the two yourself. It displays remaining quota in the Claude terminal. T3 may run Claude headlessly without invoking status lines; this integration has not been established for T3. The snapshot belongs to the account producing it; multiple accounts need separate snapshot paths (`AGENT_QUOTA_CLAUDE_SNAPSHOT`).

## MCP setup

Start `node` with the absolute path to `src/cli.js` and argument `mcp` using your client's MCP configuration. For example, in Codex's `config.toml`:

```toml
[mcp_servers.local_agent_quota]
command = "C:/nvm4w/nodejs/node.exe"
args = ["C:/path/to/local-agent-quota/src/cli.js", "mcp"]
```

For Claude Code, use its MCP configuration with the same command and arguments. Restart/reload the agent session after configuration. The `get_quota` tool accepts optional `provider` (`all`, `codex`, `claude`) and `maxAgeSeconds` (0–86400, default 600). Claude is refreshed when its cache is too old; Codex performs a live read per call. Do not infer how many prompts remain from percentages: windows can change while agents run.

This is a local repository, not automatically installed or registered in T3. Configure MCP in the environment running each provider. Use an instruction such as: “When quota affects a delegation decision, call get_quota and consider reset times and stale/unavailable states.”

## Sources

- [Codex app-server protocol](https://developers.openai.com/codex/app-server)
- [Claude Code status-line fields](https://code.claude.com/docs/en/statusline)
- [MCP tools protocol](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
