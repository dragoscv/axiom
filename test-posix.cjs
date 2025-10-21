// Test rapid pentru toPosixPath
const { toPosixPath } = require('./packages/axiom-engine/dist/util.js');

const testCases = [
  'my-webapp\\README.md',
  'my-webapp/README.md',
  'app\\notes\\page.tsx',
  'C:\\Users\\test\\file.txt'
];

console.log('Testing toPosixPath():');
testCases.forEach(tc => {
  const result = toPosixPath(tc);
  const hasBackslash = result.includes('\\');
  console.log(`  "${tc}" => "${result}" [has \\: ${hasBackslash}]`);
});
