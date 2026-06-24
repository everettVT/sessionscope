#!/usr/bin/env node
/* Sessionscope — local indexer.  Usage:  node scope.js [extraDir ...] [--no-open]
 *
 * Reads your AI-coding sessions from the standard hidden locations, parses them with
 * the SAME parsers.js the web app uses, and opens the dashboards with data preloaded.
 * 100% local: it only reads files and writes scope_data.js next to the dashboards.
 * Nothing is uploaded; no network call is made. */
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");

const HERE = __dirname;
const HOME = os.homedir();
const args = process.argv.slice(2);
const noOpen = args.includes("--no-open");
const extraDirs = args.filter(a => !a.startsWith("--"));

// load the validated browser parser in a fake-window sandbox (single source of truth)
const win = {};
new Function("window", fs.readFileSync(path.join(HERE, "parsers.js"), "utf8"))(win);
const P = win.SessionParsers;

const SKIP = new Set(["node_modules",".git","Library",".cache",".npm",".cargo",".rustup",".gradle",
  ".m2",".Trash","go","dist","build",".venv","venv","target",".next",".pnpm-store","Applications","Photos Library.photoslibrary"]);

function walk(dir, depth, out, nameFilter){
  if(depth > 9) return;
  let ents; try{ ents = fs.readdirSync(dir, {withFileTypes:true}); }catch(_){ return; }
  for(const e of ents){
    const full = path.join(dir, e.name);
    if(e.isDirectory()){ if(SKIP.has(e.name)) continue; walk(full, depth+1, out, nameFilter); }
    else if(/\.(jsonl|json)$/i.test(e.name) && (!nameFilter || nameFilter.test(e.name))) out.push(full);
  }
}

// roots: agent session dirs (any json), + Downloads (only export-looking json)
const roots = [
  { dir: path.join(HOME, ".claude", "projects"), filter: null },
  { dir: path.join(HOME, ".codex", "sessions"),  filter: null },
  { dir: path.join(HOME, "Downloads"),            filter: /conversation|chatgpt|claude|anthropic|export/i },
  ...extraDirs.map(d => ({ dir: path.resolve(d), filter: null })),
];

console.log("Sessionscope · scanning (local, read-only)…");
const files = [];
for(const r of roots){ if(fs.existsSync(r.dir)){ const before=files.length; walk(r.dir, 0, files, r.filter);
  console.log(`  ${r.dir.replace(HOME,"~")}  ${files.length-before} candidate file(s)`); } }

const norm = []; const bySource = {};
let scanned = 0;
for(const f of files){
  let st; try{ st = fs.statSync(f); }catch(_){ continue; }
  if(st.size > 80*1024*1024) continue;                 // skip >80MB
  let txt; try{ txt = fs.readFileSync(f, "utf8"); }catch(_){ continue; }
  scanned++;
  let r=null; try{ r = P.detectAndParse(f, txt); }catch(_){ r=null; }
  if(r && r.sessions && r.sessions.length){ bySource[r.source]=(bySource[r.source]||0)+r.sessions.length; norm.push(...r.sessions); }
}

if(!norm.length){
  console.error("\nNo sessions found. Pass a folder explicitly:  node scope.js <path-to-sessions>");
  process.exit(1);
}
const D = P.buildAll(norm);
fs.writeFileSync(path.join(HERE, "scope_data.js"),
  "window.SCOPE = " + JSON.stringify({SESSIONS:D.SESSIONS, SMETA:D.SMETA, TURNS:D.TURNS}) + ";\n");

// summary
console.log(`\nParsed ${scanned} file(s) → ${D.SESSIONS.length} sessions, ${D.SMETA.turns} turns  (${D.SMETA.from} → ${D.SMETA.to})`);
console.log("  by source: " + Object.entries(bySource).map(([k,v])=>`${k} ${v}`).join(" · "));
console.log("  tiers:     " + D.TURNS.tiers.map(t=>`${t.tier} ${t.n}`).join(" · ")
            + `   (shipped ${D.TURNS.meta.shipped} / not ${D.TURNS.meta.notShipped})`);
const peak = D.TURNS.hours.reduce((a,b)=>b.total>a.total?b:a);
console.log(`  peak activity hour (local): ${String(peak.h).padStart(2,"0")}:00`);
console.log(`\nwrote ${path.join(HERE,"scope_data.js")}`);

if(!noOpen){
  const page = path.join(HERE, "sessions.html");
  const opener = process.platform==="darwin" ? "open" : process.platform==="win32" ? "start" : "xdg-open";
  try{ cp.execSync(`${opener} "${page}"`); console.log(`opening ${page}`); }
  catch(_){ console.log(`open this file in your browser:\n  ${page}`); }
}
