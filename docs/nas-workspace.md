# Headless NAS workspace

The NAS serves the web workspace, API, and HTTP MCP from one daemon. Generate on the Mac and send artifacts and companion files through MCP. Use explicit project IDs; the Mac desktop's selection is not the NAS workspace's selection. The NAS image is built from `deploy/Dockerfile`, without the Codex or HyperFrames rendering layers. Render and export HyperFrames locally, and upload files for preview.

Follow the [daemon data directory contract](../AGENTS.md#daemon-data-directory-contract) for persistence. Run the service behind private HTTPS with the container's port published only to host loopback. Keep API authentication enabled. Set `OD_PUBLIC_BASE_URL` to the external HTTPS origin, and configure `OD_ALLOWED_ORIGINS` for that same origin. MCP preview and studio links use the public origin; internal requests still use the daemon URL. Do not place credentials in URLs.

## Mac CLI

Use Node 24 and install from the same verified commit as the NAS image. Build and install the daemon's production dependency closure in a private directory:

```sh
revision=$(git rev-parse HEAD)
client_dir="$HOME/.local/share/opendesign-nas/$revision"
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @open-design/daemon deploy --legacy --prod "$client_dir"
chmod u+x "$client_dir/dist/odc.js"
```

After rollout approval, link only `$client_dir/dist/odc.js` as `odc` in a directory on `PATH`. Do not globally link the daemon package or change `/usr/bin/od`. Bare `odc` shows help rather than starting a daemon. Set `ODC_DAEMON_URL` to the private HTTPS origin, or pass `--daemon-url` to the command. Resolve `OD_API_TOKEN` through fnox from a 1Password reference:

```sh
fnox exec -- odc project list --json
```

An operator token uses Basic authentication, not the run-scoped `OD_TOOL_TOKEN` Bearer credential. For browser access, sign in with username `open-design` and the operator token as the password. For MCP, configure the same private origin with `/api/mcp` and authenticate with the operator token as Bearer, supplied through the client's secret mechanism.

## Rollout checks

- Deny anonymous API and MCP requests through the HTTPS ingress. Verify the retired public router is not reachable.
- Verify the browser, CLI, and MCP read the same project. Create a normal artifact with sibling files via MCP and verify the preview and assets in the browser, then repeat the read after container replacement.
- Confirm that agent discovery is empty. Requests requiring an agent must fail without installing or running anything locally or on the NAS.
- Compare the workspace with the Sealos workflow before editing client registrations. Install the two versioned `plugins/stream-machine` scenarios from a pinned source or archive; they are not part of the upstream bundled catalog.
- Restart only the affected Mac clients after cutover and confirm they do not launch Electron. The standalone Mac app and its local projects remain separate.
