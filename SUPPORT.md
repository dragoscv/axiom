# Support Policy

## Version Support

| Version Series | Status | Bugfixes | Security Patches | End of Life |
|----------------|--------|----------|------------------|-------------|
| 1.x (LTS)      | ✅ Active | ✅ Yes | ✅ Yes | October 2026 |
| 0.x            | ❌ EOL | ❌ No | ❌ No | October 2025 |

## Support Channels

### Community Support (Free)
- **GitHub Issues:** Bug reports, feature requests
- **GitHub Discussions:** Questions, usage help, best practices
- **Response SLA:** 72 hours (community-driven, best effort)

### Security Issues
- **Email:** security@axiom-lang.org
- **GitHub Security Advisories:** Private vulnerability reporting
- **Response SLA:** 72 hours triage, 7 days critical fix

## What We Support

### Covered
✅ IR schema 1.0.0 (validation, generation)  
✅ MCP endpoints: `/parse`, `/validate`, `/generate`, `/check`, `/reverse`, `/diff`, `/apply`  
✅ Core emitters: `web-app`, `api-service`, `docker-image`, `batch-job`  
✅ Built-in profiles: `default`, `edge`, `budget`  
✅ Capability model: `net()`, `fs()`, `ai()`  
✅ Deterministic manifest generation  
✅ Golden snapshot testing  

### Not Covered
❌ Custom emitters (community-maintained)  
❌ Experimental features marked `@experimental` in docs  
❌ Undocumented MCP endpoints or IR fields  
❌ Third-party integrations (LSP servers, plugins)  
❌ Performance issues in user-defined check evaluators  

## Backport Policy

**Security patches:** All severity levels backported to active LTS versions  
**Bug fixes:** Critical and high-severity bugs only (data loss, determinism breakage)  
**Features:** No feature backports (upgrade to latest minor for new features)  

**Example:**
- If 1.5.0 introduces a new emit type, it will NOT be backported to 1.0.x
- If 1.5.0 fixes a determinism bug, it WILL be backported to 1.0.x

## Upgrade Path

### Minor Upgrades (1.0 → 1.1)
- **Compatibility:** Backward compatible
- **Migration:** No code changes required
- **Testing:** Recommended but not required

### Major Upgrades (1.x → 2.0)
- **Compatibility:** Breaking changes possible
- **Migration:** Codemod provided: `npx @axiom/codemod migrate-ir --from=1.x --to=2.0`
- **Testing:** Required - run full test suite
- **Deprecation Window:** 3 months notice before 2.0.0 release

## Enterprise Support

For commercial support, SLAs, training, or custom development:

📧 **Contact:** enterprise@axiom-lang.org

**Available Services:**
- Dedicated Slack channel
- Priority issue resolution (4-hour response for P0)
- Custom emitter development
- On-site training workshops
- Architecture review and consulting

## Contribution Guidelines

Want to help maintain AXIOM? See [CONTRIBUTING.md](CONTRIBUTING.md)

**Quick Links:**
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Development Setup](docs/development.md)
- [Testing Guide](docs/testing.md)

## Release Cadence

- **Major (x.0.0):** Annually (breaking changes, new capabilities)
- **Minor (1.x.0):** Quarterly (new features, backward compatible)
- **Patch (1.0.x):** As needed (bugfixes, security)

**Next Planned Releases:**
- 1.1.0: January 2026 (signed emitters, profile.lock)
- 1.2.0: April 2026 (runtime capability enforcement, audit trail)
- 2.0.0: October 2026 (WASM sandbox, signed emitter registry)

---

**Questions?** Open a [GitHub Discussion](https://github.com/axiom-lang/axiom/discussions)

**Last Updated:** October 20, 2025  
**Version:** 1.0.0
