const path = 'my-webapp\\README.md';
console.log('Original:', path);
console.log('Replaced:', path.replace(/\\/g, '/'));
console.log('Has backslash after?', path.replace(/\\/g, '/').includes('\\'));

// Test array map
const artifacts = [
  { path: 'my-webapp\\README.md', kind: 'file' },
  { path: 'my-webapp\\app\\layout.tsx', kind: 'file' }
];

console.log('\nOriginal artifacts:');
artifacts.forEach(a => console.log('  -', a.path));

const posixArtifacts = artifacts.map(a => ({
  ...a,
  path: a.path.replace(/\\/g, '/')
}));

console.log('\nPOSIX artifacts:');
posixArtifacts.forEach(a => console.log('  -', a.path));
console.log('\nHas backslash?', posixArtifacts[0].path.includes('\\'));
