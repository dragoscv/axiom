# 🔧 AXIOM 1.0.8 - Critical Fix for npm Compatibility

## 🐛 Problem Fixed

**Issue**: `workspace:*` protocol not supported by npm registry
```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

**Root Cause**: Published package `@codai/axiom-mcp@1.0.7` contained `workspace:*` dependencies, which work in pnpm monorepos but fail when installed from npm registry.

**Impact**: MCP server failed to start in VS Code with connection error (Process exited with code 1).

---

## ✅ Solution

### Strategy
1. **Published internal packages** to npm registry with `internal` tag
2. **Replaced `workspace:*`** with standard version ranges (`^1.0.x`)
3. **Republished `@codai/axiom-mcp@1.0.8`** with resolved dependencies

### Published Internal Packages
All published with deprecation warnings (intentional - use only via axiom-mcp):

| Package | Version | Tag | Status |
|---------|---------|-----|--------|
| `@codai/axiom-core` | 1.0.1 | internal | ✅ Published |
| `@codai/axiom-engine` | 1.0.2 | internal | ✅ Published |
| `@codai/axiom-policies` | 1.0.1 | internal | ✅ Published |
| `@codai/axiom-emitter-apiservice` | 1.0.1 | internal | ✅ Published |
| `@codai/axiom-emitter-batchjob` | 1.0.1 | internal | ✅ Published |
| `@codai/axiom-emitter-docker` | 1.0.1 | internal | ✅ Published |
| `@codai/axiom-emitter-webapp` | 1.0.1 | internal | ✅ Published |

### Dependency Changes (axiom-mcp package.json)
```diff
  "dependencies": {
-   "@codai/axiom-core": "workspace:*",
+   "@codai/axiom-core": "^1.0.1",
-   "@codai/axiom-emitter-apiservice": "workspace:*",
+   "@codai/axiom-emitter-apiservice": "^1.0.1",
-   "@codai/axiom-emitter-batchjob": "workspace:*",
+   "@codai/axiom-emitter-batchjob": "^1.0.1",
-   "@codai/axiom-emitter-docker": "workspace:*",
+   "@codai/axiom-emitter-docker": "^1.0.1",
-   "@codai/axiom-emitter-webapp": "workspace:*",
+   "@codai/axiom-emitter-webapp": "^1.0.1",
-   "@codai/axiom-engine": "workspace:*",
+   "@codai/axiom-engine": "^1.0.2",
-   "@codai/axiom-policies": "workspace:*",
+   "@codai/axiom-policies": "^1.0.1",
    "@modelcontextprotocol/sdk": "^1.20.1"
  }
```

---

## 🧪 Validation

### Installation Test
```bash
npm install @codai/axiom-mcp@1.0.8
# ✅ Success: added 97 packages in 5s
# ⚠️ Expected deprecation warnings for internal packages (intentional)
```

### MCP Server Test
```bash
npx @codai/axiom-mcp@latest
# ✅ Output: "AXIOM MCP Server running on stdio"
```

### VS Code Integration Test
```jsonc
// .vscode/mcp.json
{
  "servers": {
    "axiom-mcp": {
      "command": "npx",
      "args": ["-y", "--package=@codai/axiom-mcp@latest", "axiom-mcp-stdio"]
    }
  }
}
```
**Result**: ✅ Server starts successfully, no EUNSUPPORTEDPROTOCOL errors

---

## 📦 Package Details

**Published**: `@codai/axiom-mcp@1.0.8`  
**Size**: 4.1KB (unchanged from 1.0.7)  
**Total files**: 5  
**Registry**: https://www.npmjs.com/package/@codai/axiom-mcp  

### Dependencies Installed
When installing `@codai/axiom-mcp@1.0.8`, npm will:
1. Fetch `@codai/axiom-mcp@1.0.8` (4.1KB)
2. Resolve and fetch 7 internal packages (~30KB total)
3. Install `@modelcontextprotocol/sdk` and transitive dependencies
4. **Total**: 97 packages (~5s install time)

### Deprecation Warnings (Intentional)
```
npm warn deprecated @codai/axiom-core@1.0.1: Internal package. Install only @codai/axiom-mcp.
npm warn deprecated @codai/axiom-engine@1.0.2: Internal package. Install only @codai/axiom-mcp.
npm warn deprecated @codai/axiom-policies@1.0.1: Internal package. Install only @codai/axiom-mcp.
...
```
These warnings are **intentional** to prevent direct installation of internal packages.

---

## 🔄 Upgrade Instructions

### For Users
```bash
# Update to latest version
npm install @codai/axiom-mcp@latest

# Or use in VS Code MCP config
npx -y --package=@codai/axiom-mcp@latest axiom-mcp-stdio
```

### For Development
```bash
# In monorepo, continue using workspace:*
cd axiom-monorepo
pnpm install  # workspace:* works in monorepo
pnpm build
pnpm test

# Only axiom-mcp uses version ranges for npm publish
```

---

## 🎯 Impact

### Before 1.0.8
- ❌ `npm install @codai/axiom-mcp` failed with EUNSUPPORTEDPROTOCOL
- ❌ VS Code MCP server crashed on startup
- ❌ Published package unusable outside pnpm monorepo

### After 1.0.8
- ✅ `npm install @codai/axiom-mcp@1.0.8` works perfectly
- ✅ VS Code MCP server starts successfully
- ✅ Package works in all npm-compatible environments
- ✅ Monorepo development still uses `workspace:*` (unchanged)

---

## 📝 Technical Notes

### Why workspace:* Failed
- `workspace:*` is a **pnpm-specific protocol**
- npm registry doesn't understand `workspace:*` syntax
- Published packages must use standard semver ranges
- pnpm converts `workspace:*` → local symlinks in monorepos
- But published tarball contains literal `workspace:*` strings

### Why This Solution Works
- Internal packages published to npm registry
- Standard version ranges (`^1.0.x`) work in all package managers
- Deprecation warnings prevent accidental direct usage
- Monorepo still benefits from `workspace:*` during development
- Only the **published** axiom-mcp package uses version ranges

### Alternative Solutions (Not Used)
1. **Bundle all code**: Increases package size significantly
2. **Use tarballs**: Complex publish workflow
3. **Peer dependencies**: Breaks automatic installation
4. **Make packages public**: Confuses users with multiple packages

---

## 🚀 Next Steps

### Immediate
- ✅ Published to npm as `@codai/axiom-mcp@1.0.8`
- ✅ Validated installation and MCP server startup
- ✅ Updated GitHub repository

### Future Improvements
1. **Automated testing**: Add CI test for npm install
2. **Version automation**: Script to sync versions before publish
3. **Bundle optimization**: Consider rollup/esbuild for smaller size
4. **Documentation**: Update README with troubleshooting guide

---

## 📚 Related Documentation

- **Installation Guide**: See `README.md`
- **Previous Release**: `RELEASE-NOTES-1.0.7.md`
- **MCP Config**: `.vscode/mcp.json` example
- **Troubleshooting**: See GitHub Issues

---

## ✅ Release Checklist

- [x] Internal packages published to npm
- [x] axiom-mcp@1.0.8 dependencies updated
- [x] Package published with `latest` tag
- [x] Installation tested (npm install)
- [x] MCP server startup validated
- [x] VS Code integration tested
- [x] GitHub repository updated
- [x] Release notes created
- [x] Deprecation warnings verified

---

**Status**: ✅ PRODUCTION READY  
**Published**: 2025-10-21  
**Version**: 1.0.8  
**Critical Fix**: workspace:* → standard semver ranges  
**Install**: `npm install @codai/axiom-mcp@latest`
