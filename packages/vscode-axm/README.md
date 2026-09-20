# axiom-axm (VS Code extension)

Language support for AXIOM `.axm` plans. Thin `vscode-languageclient` that spawns
`@codai/axiom-axm-lsp` over node-ipc; the TextMate grammar (`syntaxes/axm.tmLanguage.json`)
provides colouring before the server answers, then semantic tokens refine it.

- language id `axm`, extension `.axm`, comments `//` and `/* */`, brackets `{}` `[]`
- heredoc bodies and `check … {json}` / `meta {json}` blocks are highlighted as strings / embedded JSON
- diagnostics, completion, hover, outline, *Format Document*, semantic highlighting — see
  `packages/axm-lsp/README.md`

## Develop

```
pnpm build                              # builds @codai/axiom-axm-lsp (root filter is @codai/axiom-*)
pnpm --filter axiom-axm run build       # this package (not matched by that filter)
code --extensionDevelopmentPath=packages/vscode-axm   (F5 "Run Extension" also works)
```

In a workspace install the client resolves `@codai/axiom-axm-lsp/main` from `node_modules`, so
rebuilding `packages/axm-lsp` is picked up on the next reload without repackaging.

## Package

```
pnpm --filter axiom-axm run package     # tsdown, then → <repo>/.copilot-tmp/axiom-axm-<version>.vsix
```

`vsce package --no-dependencies` with **no** `node_modules` in the .vsix: both
`dist/extension.cjs` (client) and `dist/server.cjs` (the LSP bin bundled with
`vscode-languageserver`) are self-contained. vsce rejects pnpm's `catalog:` spec for
`@types/vscode`, so the script writes the resolved version into `package.json` for the duration of
the call and restores the file afterwards. The .vsix is not committed; install a local build with
`code --install-extension <file>.vsix`.

## Release (S-412)

`release.yml` job `vscode-extension` runs on every `v*` tag after the npm publish: it packages the
.vsix, uploads it as a workflow artifact and attaches it to the GitHub release
(`gh release upload`). When the repo secret **`VSCE_PAT`** exists (Azure DevOps PAT with
*Marketplace → Manage* for publisher `codai`) it also runs `vsce publish --packagePath`, so
`ext install codai.axiom-axm` works. Without the secret the job emits a notice and the release
page still carries the .vsix — creating the publisher and the PAT is the owner step that unblocks
S-412. The .vsix `version` is stamped from `@codai/axiom-mcp`'s version at package time (the
extension is `private` and outside the changesets group), so it always matches the release tag
and never collides with an already-published Marketplace version.
