#!/usr/bin/env node
/* Sessionscope — local indexer.  Usage:  node scope.js [extraDir ...] [opts]
 *   --no-open                   don't auto-open the browser
 *   --git-merge [--repo <path>] scan CWD (and any --repo paths) for merge commits → MERGES[]
 *   --weather <coords|name>     fetch weather from Open-Meteo (free, no key)
 *   --location <label>          friendly location label (default: derived from --weather)
 *
 * Reads sessions from standard hidden locations, parses them with the SAME parsers.js
 * the web app uses, and opens the dashboards with data preloaded. The default mode is
 * 100% local. Network calls happen ONLY when you opt in via --weather; --git-merge stays
 * local (it runs `git log` on your own repos). The browser still makes zero network
 * calls — Open-Meteo data, if fetched, is baked into scope_data.js at index time. */
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");

const HERE = __dirname;
const HOME = os.homedir();
const args = process.argv.slice(2);
const noOpen = args.includes("--no-open");
const wantsMerge = args.includes("--git-merge") || args.includes("--merges");
function flagVal(name){ const i = args.indexOf(name); return (i>=0 && i+1<args.length) ? args[i+1] : null; }
function flagAll(name){ const out=[]; for(let i=0;i<args.length;i++) if(args[i]===name && i+1<args.length) out.push(args[++i]); return out; }
const wxArg = flagVal("--weather");
const locArg = flagVal("--location");
const extraRepos = flagAll("--repo");
// positional args = extra session dirs (anything not a flag and not a flag's value)
const valFlags = new Set(["--weather","--location","--repo"]);
const extraDirs = [];
for(let i=0;i<args.length;i++){
  const a=args[i]; if(a.startsWith("--")){ if(valFlags.has(a)) i++; continue; }
  extraDirs.push(a);
}

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

// ---- optional: scan repos for merge commits (local, no network) ----
let MERGES = [];
if(wantsMerge){
  const repos = new Set(extraRepos.map(p => path.resolve(p)));
  // include CWD if it's a git repo
  try{ const root = cp.execSync(`git -C "${process.cwd()}" rev-parse --show-toplevel`, {stdio:["ignore","pipe","ignore"]}).toString().trim();
    if(root) repos.add(root); }catch(_){}
  console.log(`\nscanning ${repos.size} repo(s) for merge commits…`);
  for(const repo of repos){
    let mainBranch = "main";
    try{
      // Try origin/HEAD; fall back to main, master, develop in order.
      const head = cp.execSync(`git -C "${repo}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`, {stdio:["ignore","pipe","ignore"]}).toString().trim();
      if(head) mainBranch = head.split("/").pop();
    }catch(_){
      for(const b of ["main","master","develop","trunk"]){
        try{ cp.execSync(`git -C "${repo}" rev-parse --verify ${b} 2>/dev/null`, {stdio:"ignore"}); mainBranch=b; break; }catch(_){}
      }
    }
    let out=""; try{
      out = cp.execSync(`git -C "${repo}" log ${mainBranch} --merges --pretty=format:%H%x01%ct%x01%s --since='1 year ago'`,
        {stdio:["ignore","pipe","ignore"]}).toString();
    }catch(_){ continue; }
    const name = path.basename(repo);
    let n=0;
    for(const ln of out.split("\n")){
      const parts = ln.split("\x01"); if(parts.length<3) continue;
      MERGES.push({repo:name, sha:parts[0].slice(0,8),
        date: new Date(+parts[1]*1000).toISOString(),
        subject: parts[2].slice(0,140)});
      n++;
    }
    console.log(`  ${name} @ ${mainBranch}  ${n} merge commit(s)`);
  }
  MERGES.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
}

// ---- optional: fetch weather (Open-Meteo, free, no key, no tracking) ----
let WEATHER = null;
const WCODE = {0:"clear",1:"mostly clear",2:"partly cloudy",3:"overcast",45:"fog",48:"rime fog",
  51:"drizzle",53:"drizzle",55:"drizzle",56:"freezing drizzle",57:"freezing drizzle",
  61:"rain",63:"rain",65:"heavy rain",66:"freezing rain",67:"freezing rain",
  71:"snow",73:"snow",75:"heavy snow",77:"snow grains",
  80:"showers",81:"showers",82:"heavy showers",85:"snow showers",86:"snow showers",
  95:"thunderstorm",96:"thunderstorm w/ hail",99:"thunderstorm w/ hail"};
async function getJSON(url){
  if(typeof fetch !== "function") throw new Error("fetch not available — needs Node ≥18 for --weather");
  const r = await fetch(url, {headers:{"user-agent":"sessionscope-scope.js/1.0"}});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchWeather(){
  if(!wxArg) return null;
  let lat, lon, label = locArg || wxArg;
  if(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(wxArg.trim())){
    [lat,lon] = wxArg.split(",").map(Number);
  } else {
    const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(wxArg)}&count=1&format=json`);
    const r = (j.results||[])[0];
    if(!r){ console.log(`  weather: '${wxArg}' could not be geocoded`); return null; }
    lat=r.latitude; lon=r.longitude;
    if(!locArg) label = `${r.name}${r.admin1?`, ${r.admin1}`:""}${r.country_code?`, ${r.country_code}`:""}`;
  }
  const dates = D.SESSIONS.map(s=>String(s.start||"").slice(0,10)).filter(Boolean).sort();
  const today = new Date().toISOString().slice(0,10);
  const start = dates[0] || today;
  const end = today;
  console.log(`  weather: ${label} (${lat.toFixed(3)},${lon.toFixed(3)}) · ${start}→${end}`);
  const daily = {};
  try{
    // Open-Meteo archive serves historical data (≥ 5 days ago); forecast covers recent + future.
    const fiveAgo = new Date(Date.now() - 5*86400000).toISOString().slice(0,10);
    if(start < fiveAgo){
      const archEnd = fiveAgo > end ? end : fiveAgo;
      const hist = await getJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${archEnd}&daily=temperature_2m_mean,weather_code&timezone=auto`);
      const t = hist.daily?.time||[], tm = hist.daily?.temperature_2m_mean||[], wc = hist.daily?.weather_code||[];
      for(let i=0;i<t.length;i++) if(tm[i]!=null) daily[t[i]] = {tempC:tm[i], code: WCODE[wc[i]]||`code ${wc[i]}`};
    }
    // recent days + today + forecast: use forecast endpoint
    const fcStart = start < fiveAgo ? fiveAgo : start;
    const fc = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${fcStart}&end_date=${end}&current=temperature_2m,weather_code&daily=temperature_2m_mean,weather_code&timezone=auto`);
    const t = fc.daily?.time||[], tm = fc.daily?.temperature_2m_mean||[], wc = fc.daily?.weather_code||[];
    for(let i=0;i<t.length;i++) if(tm[i]!=null) daily[t[i]] = {tempC:tm[i], code: WCODE[wc[i]]||`code ${wc[i]}`};
    const now = fc.current ? {tempC: fc.current.temperature_2m, code: WCODE[fc.current.weather_code]||`code ${fc.current.weather_code}`} : null;
    console.log(`  weather: ${Object.keys(daily).length} daily entries · now ${now?Math.round(now.tempC)+"°C "+now.code:"?"}`);
    return {location:label, lat, lon, now, daily, fetchedAt: new Date().toISOString()};
  }catch(e){
    console.log(`  weather: fetch failed — ${e.message.slice(0,80)}`);
    return null;
  }
}

(async () => {
  if(wxArg) WEATHER = await fetchWeather();
  const payload = {SESSIONS:D.SESSIONS, SMETA:D.SMETA, TURNS:D.TURNS, CYCLES:D.CYCLES};
  if(MERGES.length) payload.MERGES = MERGES;
  if(WEATHER) payload.WEATHER = WEATHER;
  fs.writeFileSync(path.join(HERE, "scope_data.js"),
    "window.SCOPE = " + JSON.stringify(payload) + ";\n");
  afterWrite();
})();

function afterWrite(){

// summary
console.log(`\nParsed ${scanned} file(s) → ${D.SESSIONS.length} sessions, ${D.SMETA.turns} turns  (${D.SMETA.from} → ${D.SMETA.to})`);
console.log("  by source: " + Object.entries(bySource).map(([k,v])=>`${k} ${v}`).join(" · "));
console.log("  tiers:     " + D.TURNS.tiers.map(t=>`${t.tier} ${t.n}`).join(" · ")
            + `   (shipped ${D.TURNS.meta.shipped} / not ${D.TURNS.meta.notShipped})`);
const peak = D.TURNS.hours.reduce((a,b)=>b.total>a.total?b:a);
console.log(`  peak activity hour (local): ${String(peak.h).padStart(2,"0")}:00`);
console.log(`\nwrote ${path.join(HERE,"scope_data.js")}`);

if(MERGES.length) console.log(`  merges:    ${MERGES.length} from ${new Set(MERGES.map(m=>m.repo)).size} repo(s)`);
if(WEATHER) console.log(`  weather:   ${WEATHER.location} — ${Object.keys(WEATHER.daily).length} day(s) · ${WEATHER.now?Math.round(WEATHER.now.tempC)+"°C "+WEATHER.now.code:"no current"}`);

if(!noOpen){
  const page = path.join(HERE, "sessions.html");
  const opener = process.platform==="darwin" ? "open" : process.platform==="win32" ? "start" : "xdg-open";
  try{ cp.execSync(`${opener} "${page}"`); console.log(`opening ${page}`); }
  catch(_){ console.log(`open this file in your browser:\n  ${page}`); }
}

}  // end afterWrite
