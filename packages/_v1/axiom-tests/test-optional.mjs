const line1 = 'fs("./data")?';
const line2 = 'fs("./data")';

const regex = /^([a-zA-Z_]+)\(([^)]*)\)\??$/;

console.log("Line 1:", line1);
console.log("  Match:", regex.test(line1));
console.log("  Groups:", line1.match(regex));
console.log("  endsWith('?'):", line1.endsWith('?'));

console.log("\nLine 2:", line2);
console.log("  Match:", regex.test(line2));
console.log("  Groups:", line2.match(regex));
console.log("  endsWith('?'):", line2.endsWith('?'));
