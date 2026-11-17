import fs from "node:fs";
const LIMIT = 10 * 1024 * 1024;
const size = fs.statSync("main.js").size;
console.log(`main.js: ${(size / 1048576).toFixed(2)} MB (limit 10 MB)`);
if (size > LIMIT) {
  console.error("main.js exceeds the 10 MB budget");
  process.exit(1);
}
