# HOWTO: Run AXIOM Tests

This guide provides instructions for running the AXIOM test suite across different platforms and environments.

## Prerequisites

- **Node.js:** v18.0.0 or later (v24.x recommended)
- **pnpm:** v8.0.0 or later (package manager)
- **Git:** For repository operations (optional for most tests)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test
```

## Running Specific Test Suites

### Core Functionality Tests

```bash
# Engine tests (generation, manifest, apply)
cd packages/axiom-engine
pnpm test

# Core tests (parser, IR, validation)
cd packages/axiom-core
pnpm test

# Integration tests
cd packages/axiom-tests
pnpm test
```

### New v1.0.24 Test Suites

```bash
cd packages/axiom-tests

# Cross-drive atomic write semantics
npx vitest run apply-cross-drive-semantics

# Path validation (property-based)
npx vitest run path-validation-fastcheck

# Windows long paths (>260 chars)
npx vitest run long-paths-windows

# Concurrency safety (200 parallel writes)
npx vitest run concurrency-uniqueness

# Error handling and failure reporting
npx vitest run error-paths

# Previous test suites (still valid)
npx vitest run apply-same-drive-abs
npx vitest run apply-repopath-dot
npx vitest run apply-enhanced-fs
```

## Platform-Specific Considerations

### Windows

**Long Path Support:**
- Windows 10 (v1607+) required for long path tests
- Enable long paths: `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force`
- Or run tests as Administrator

**Cross-Drive Tests:**
- Requires multiple drives (C:, D:, E:, etc.)
- Tests automatically skip if secondary drives not available
- Use `AXIOM_OUT_ROOT` to specify target drive

**Reserved Names:**
- CON, PRN, NUL, AUX, COM1-9, LPT1-9 validation tests run on Windows only
- Other platforms skip these tests

### Linux / macOS

**Cross-Drive Tests:**
- Automatically skipped (multi-volume testing is Windows-specific)
- Same-volume atomic writes still tested

**File Permissions:**
- Read-only directory tests require proper permissions
- May require `sudo` for certain error path tests
- Tests automatically adapt to permission restrictions

**Case Sensitivity:**
- Linux/macOS filesystems may be case-sensitive
- Path resolution tests account for platform differences

## Environment Variables

### Test Configuration

```bash
# Force specific test behavior
export AXIOM_TEST_SKIP_LONG_PATH=1      # Skip long path tests
export AXIOM_TEST_SKIP_CROSS_DRIVE=1    # Skip cross-drive tests
export AXIOM_TEST_KEEP_FIXTURES=1       # Don't cleanup test directories

# Runtime configuration (tested scenarios)
export AXIOM_REPO_ROOT=/absolute/path   # Explicit repo root
export AXIOM_OUT_ROOT=/absolute/path    # Custom output location
```

### CI/CD Environment

```yaml
# Example GitHub Actions workflow
name: Test
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [18, 20, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 8
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
        env:
          AXIOM_REPO_ROOT: ${{ github.workspace }}
```

## Debugging Failed Tests

### Verbose Output

```bash
# Run single test with full output
npx vitest run path-validation-fastcheck --reporter=verbose

# Keep test fixtures for inspection
AXIOM_TEST_KEEP_FIXTURES=1 npx vitest run apply-cross-drive-semantics
```

### Common Issues

**Issue:** `ERR_REPOPATH_RELATIVE_UNSAFE`
- **Cause:** Test running from HOME directory
- **Solution:** Set `AXIOM_REPO_ROOT` or run from different directory

**Issue:** Cross-drive tests fail
- **Cause:** Secondary drive not available (Windows)
- **Solution:** Tests should skip automatically; verify drives exist

**Issue:** Long path tests fail
- **Cause:** Long paths not enabled on Windows
- **Solution:** Enable via registry or run as Administrator

**Issue:** Permission errors in error-paths tests
- **Cause:** Insufficient permissions on Linux/macOS
- **Solution:** Run with appropriate permissions or tests will skip

## Test Coverage

```bash
# Generate coverage report
cd packages/axiom-tests
npx vitest run --coverage

# View HTML coverage report
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
start coverage/index.html  # Windows
```

## Performance Benchmarking

```bash
# Run concurrency tests with timing
npx vitest run concurrency-uniqueness --reporter=verbose

# Expected results:
# - 200 files: ~2-5 seconds (parallel writes)
# - 100 same-dir files: ~1-3 seconds
# - Per-file average: <25ms
```

## Continuous Integration

### Minimal CI Pipeline

```bash
#!/bin/bash
set -e

# Install and build
pnpm install
pnpm build

# Run critical test suites
pnpm test:core           # Parser and IR validation
pnpm test:engine         # Generation and manifest
pnpm test:integration    # End-to-end apply tests

# Run new hardening tests
cd packages/axiom-tests
npx vitest run apply-cross-drive-semantics
npx vitest run path-validation-fastcheck
npx vitest run error-paths
```

### Full Test Matrix (CI)

```bash
# All platforms, all Node versions
for node in 18 20 24; do
  for os in ubuntu windows macos; do
    echo "Testing Node $node on $os"
    # Run full test suite
  done
done
```

## Troubleshooting

### Tests Hang

- **Symptom:** Tests never complete
- **Causes:**
  - Orphaned test directories with file locks
  - Background processes not cleaned up
- **Solution:** Kill test process, manually cleanup `C:\Users\<user>\AppData\Local\Temp\axiom-*`

### Flaky Tests

- **Symptom:** Tests pass/fail randomly
- **Causes:**
  - Race conditions in parallel writes (should be fixed in v1.0.24)
  - Filesystem timing issues
- **Solution:** Rerun test; if persistent, file issue with logs

### Windows-Specific Failures

- **Reserved name tests:** Ensure running on Windows
- **Long path tests:** Enable long paths in system settings
- **Cross-drive tests:** Verify secondary drive availability

## Getting Help

- **Documentation:** `README.md`, `CHANGELOG.md`
- **Issues:** https://github.com/dragoscv/axiom/issues
- **API Docs:** `docs/` directory
- **Release Notes:** `RELEASE-NOTES-*.md`

## Test Suite Summary

| Suite | Files | Focus | Platform |
|-------|-------|-------|----------|
| `apply-same-drive-abs` | 1 | Same-drive phantom write fix | All |
| `apply-repopath-dot` | 1 | Fail-closed HOME protection | All |
| `apply-enhanced-fs` | 1 | AXIOM_OUT_ROOT support | All |
| `apply-cross-drive-semantics` | 1 | Atomic rename guarantees | Windows (partial on others) |
| `path-validation-fastcheck` | 1 | Property-based validation | All |
| `long-paths-windows` | 1 | Paths >260 chars | Windows only |
| `concurrency-uniqueness` | 1 | Parallel write safety | All |
| `error-paths` | 1 | Error handling | All (partial on Windows) |

**Total Test Files:** 8  
**Total Test Cases:** ~50+  
**Expected Duration:** 5-15 seconds (depending on platform)  
**Success Rate:** 100% on supported platforms
