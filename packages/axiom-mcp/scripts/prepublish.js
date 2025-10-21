#!/usr/bin/env node
/**
 * AXIOM MCP Prepublish Script
 * 
 * Bundles all internal workspace dependencies into axiom-mcp dist/
 * so that the published package is self-contained and doesn't require workspace:* protocol.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INTERNAL_PACKAGES = [
  'axiom-core',
  'axiom-engine',
  'axiom-policies',
  'axiom-emitter-apiservice',
  'axiom-emitter-batchjob',
  'axiom-emitter-docker',
  'axiom-emitter-webapp'
];

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  
  for (const file of readdirSync(src)) {
    const srcPath = join(src, file);
    const destPath = join(dest, file);
    
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (file.endsWith('.js') || file.endsWith('.d.ts')) {
      copyFileSync(srcPath, destPath);
      console.log(`  ✓ ${file}`);
    }
  }
}

console.log('📦 Bundling internal dependencies...\n');

for (const pkg of INTERNAL_PACKAGES) {
  const srcDir = join(__dirname, '..', '..', pkg, 'dist');
  const destDir = join(__dirname, '..', 'dist', 'vendor', pkg);
  
  console.log(`Bundling @codai/${pkg}:`);
  copyDir(srcDir, destDir);
  console.log('');
}

console.log('✅ Bundle complete! Package is self-contained.\n');
