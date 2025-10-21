const source = `
agent "roundtrip-agent" {
  intent "Golden IR comparison"
  capability net("api")
  check sla "latency" { expect "cold_start_ms <= 50" }
  emit service "app"
}
`.trim();

const inlineCapLines = source.split(/\n/).filter(l => {
  const trimmed = l.trim();
  return trimmed.includes('capability ') && !trimmed.startsWith('//');
});

console.log("Found capability lines:", inlineCapLines.length);
inlineCapLines.forEach((line, i) => {
  console.log(`  ${i+1}. "${line}"`);
  
  const matches = Array.from(line.matchAll(/capability\s+([a-zA-Z_]+)\(([^)]*)\)(\?)?/g));
  console.log(`     Matches: ${matches.length}`);
  matches.forEach(m => {
    console.log(`       - kind=${m[1]}, args=${m[2]}`);
  });
});
