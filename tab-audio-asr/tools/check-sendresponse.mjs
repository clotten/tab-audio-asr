import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const root = "C:/Users/clotten/Desktop/研究/tab-audio-asr";
let bad = 0;
function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (n.endsWith(".js")) out.push(f);
  }
  return out;
}
for (const f of walk(root)) {
  if (f.includes("vendor")) continue;
  const src = readFileSync(f, "utf8");
  const uses = /sendResponse\s*\(/.test(src);
  if (!uses) continue;
  const listener = src.match(/onMessage\.addListener\(([^)]*)\)/);
  const sig = listener ? listener[1] : "";
  const ok = /\bsendResponse\b/.test(sig);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${f.split("tab-audio-asr")[1]} 签名=${sig.trim() || "（没找到监听器）"}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
