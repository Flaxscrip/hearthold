# hearthold:agent-mcp — a standalone, linux-native image of Hearthold's agent-as-Sovereign MCP
# (@hearthold/agent-mcp). Built by `aegis-mcp build`.
#
# WHY standalone: @hearthold/agent-mcp depends ONLY on @didcid/mcp-server + the MCP SDK (no @hearthold
# workspace packages), so it installs clean from the registry. @didcid/mcp-server pulls a NATIVE sqlite3,
# so a host-mounted macOS node_modules won't run in the linux net — this image gets the linux binaries.
# The build has normal egress (it is NOT the sealed network); the resulting image runs in-network.
FROM node:22
WORKDIR /agent-mcp
COPY package.json ./package.json
COPY dist ./dist
RUN npm install --omit=dev --no-audit --no-fund
# The server binds its identity from env (HEARTHOLD_* first, ARCHON_* fallback) and speaks MCP over stdio.
ENTRYPOINT ["node", "/agent-mcp/dist/index.js"]
