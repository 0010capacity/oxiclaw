# Extension Marketplace

> Architecture definition only — implementation is forthcoming.

OxiClaw supports a plug-in extension system built on the pi Extension framework. Extensions are self-contained packages that add tools, skills, or capabilities to agent containers at runtime.

---

## Extension Manifest Schema

Every extension must include a `pi-extension.json` file at its root:

```json
{
  "name": "string",           // unique extension identifier (kebab-case)
  "version": "string",        // semver, e.g. "1.0.0"
  "description": "string",    // one-line summary
  "author": "string",         // e.g. "Your Name <you@example.com>"
  "repository": "string",     // git URL for updates / source
  "entry": "string",          // path to entry file relative to extension root
  "dependencies": {           // runtime dependencies (pi- prefixed packages)
    "pi-spotify": "^0.1.0"
  },
  "permissions": [            // required capability permissions
    "tool:spotify.play",
    "tool:spotify.pause"
  ]
}
```

---

## Registry API

Extensions are served from a registry endpoint. OxiClaw queries the registry for metadata and downloads.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/extensions` | List all available extensions (name, version, description) |
| `GET` | `/extensions/:name` | Fetch full metadata for a named extension |
| `GET` | `/extensions/:name/download` | Download extension source tarball |

### Response Shapes

**GET /extensions**
```json
[
  { "name": "spotify", "version": "1.2.0", "description": "Spotify playback controls" },
  { "name": "zai",    "version": "0.8.0", "description": "Image generation and TTS"    }
]
```

**GET /extensions/:name**
```json
{
  "name": "spotify",
  "version": "1.2.0",
  "description": "Spotify playback controls",
  "author": "OxiClaw Community",
  "repository": "https://github.com/oxiclaw/ext-spotify",
  "entry": "dist/index.js",
  "dependencies": { "pi-spotify": "^0.1.0" },
  "permissions": ["tool:spotify.play", "tool:spotify.pause", "tool:spotify.now_playing"]
}
```

---

## Installation Flow

```
/extension add <name>
  1. Fetch metadata  →  GET /extensions/:name
  2. Validate permissions against group policy
  3. Download source →  GET /extensions/:name/download
  4. Extract to extensions/ directory in container mount
  5. Restart agent container to load new extension
  6. Confirm load → inspect container logs for extension init
```

The `/extension add` command runs entirely on the host side. The container does not pull extensions directly — the host downloads and mounts the extension source before container restart.

### State Transitions

| State | Meaning |
|-------|---------|
| `available` | Extension exists in registry |
| `downloading` | Source tarball in transit |
| `installing` | Extraction and mount in progress |
| `loaded` | Container restarted, extension initialized |
| `failed` | Installation or init error (see logs) |

---

## Permissions Model

Extensions declare the capabilities they require. The host enforces a group-level permission policy before installation proceeds:

- If the group policy denies any declared permission, installation is rejected.
- Permissions map to tool names (`tool:*`) and channel access (`channel:telegram`, etc.).

## Updates

```
/extension update <name>
  1. Fetch latest metadata → compare version with installed version
  2. If newer available, download new tarball
  3. Swap in new source (replace mounted files)
  4. Restart container
```

Uninstall:
```
/extension remove <name>
  1. Remove mounted files from extensions/ directory
  2. Restart container
  3. Prune cached download (if any)
```
