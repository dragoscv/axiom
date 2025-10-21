const fs = require('fs');
const path = require('path');
const { parse } = require('./packages/axiom-core/dist/index.js');
const { generate } = require('./packages/axiom-engine/dist/index.js');

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'axiom-debug-'));
  try {
    const ir = parse('agent test { capability net("api") emit service "my-app" }');
    const result = await generate(ir, tmpDir, 'edge');
    
    console.log('First 5 artifact paths from manifest:');
    result.manifest.artifacts.slice(0, 5).forEach((a, i) => {
      console.log(`  ${i+1}. "${a.path}" - has backslash: ${a.path.includes('\\')}`);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
})();
