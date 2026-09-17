const source = `
agent "block-agent" {
  intent "Test block parsing"
  
  capabilities {
    net("http","https")
    fs("./data")?
    ai("gpt-4")
  }
}
`.trim();

// Simulăm extragerea blocului
function between(src, start, end) {
  const results = [];
  let i = 0;
  while (i < src.length) {
    const s = src.indexOf(start, i);
    if (s < 0) break;
    const e = src.indexOf(end, s + start.length);
    if (e < 0) break;
    results.push(src.slice(s + start.length, e));
    i = e + end.length;
  }
  return results;
}

const capsBlock = between(source, "capabilities {", "}")[0] ?? "";
console.log("Capabilities block:");
console.log(JSON.stringify(capsBlock));

console.log("\nSplit by /\\n|;|,/:");
const lines = capsBlock.split(/\n|;|,/).map(l => l.trim()).filter(Boolean);
lines.forEach((line, i) => {
  console.log(`  ${i+1}. "${line}"`);
});
