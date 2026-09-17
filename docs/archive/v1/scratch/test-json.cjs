// Test JSON.stringify comportament cu forward slashes
const obj = {
  path: "my-webapp/README.md",
  nested: {
    another: "app/layout.tsx"
  }
};

console.log("Original object:");
console.log(JSON.stringify(obj, null, 2));

console.log("\nContains backslash?", JSON.stringify(obj).includes('\\'));

const parsed = JSON.parse(JSON.stringify(obj));
console.log("\nAfter parse:");
console.log("path:", parsed.path);
console.log("Contains backslash?", parsed.path.includes('\\'));
