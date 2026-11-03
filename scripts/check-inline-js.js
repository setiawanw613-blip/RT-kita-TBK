const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("index.html", "utf8");
const scripts = [...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)];
let checked = 0;

for (const [index, match] of scripts.entries()) {
  const attributes = match[1] || "";
  const source = match[2] || "";
  if (/\\bsrc\\s*=/.test(attributes) || !source.trim()) continue;
  const type = attributes.match(/\\btype\\s*=\\s*["']([^"']+)["']/i)?.[1];
  if (type && !/^(text|application)\\/(javascript|ecmascript)$/i.test(type) && type !== "module") continue;
  new vm.Script(source, { filename: `index.html:inline-script-${index + 1}` });
  checked += 1;
}

if (!checked) throw new Error("No inline JavaScript blocks were checked.");
console.log(`Checked ${checked} inline JavaScript block(s).`);
