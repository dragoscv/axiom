# axiom-axm (VS Code extension, private)

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
the call and restores the file afterwards. The .vsix is not committed and not published to the
Marketplace; install it with `code --install-extension <file>.vsix`.
