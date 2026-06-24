/* Multi-format session parsers — 100% client-side. Nothing here makes a network call.
   Supported: Claude Code (jsonl), Codex CLI (jsonl), ChatGPT export (conversations.json),
   Anthropic chat export (conversations.json). Each adapter -> NormalizedSession[].
   NormalizedSession: { source, id, project, title, turns:[NormTurn] }
   NormTurn: { role:'user'|'assistant', ts:ISO|null, text, tools:[{n,b,cat}], nthink, think } */
(function (global) {
  const EDIT = new Set(["Edit","Write","NotebookEdit","MultiEdit","apply_patch","create_file","str_replace_editor"]);
  const LOOK = new Set(["Read","Grep","Glob","Explore","Task","Agent","WebFetch","WebSearch","ToolSearch","view","search"]);
  const SHELL = new Set(["Bash","shell","local_shell","run_terminal_cmd","exec","exec_command","container.exec"]);
  const SCOLOR = {synth:"#ff7ab6",gepa:"#ffb000",libero:"#00e0c6",rust:"#ff5d4d",ledger:"#7b6cff",core:"#4d9fff",proof:"#54e07a",infra:"#8a93a6",chat:"#9aa3b2"};
  const TIERCOLOR = {shipped:"#54e07a",built:"#ffb000",explored:"#6f7a8c"};
  // Stage = farthest the session crossed the ship funnel. Merged wins over shipped wins over committed.
  const STAGECOLOR = {merged:"#7b6cff",shipped:"#54e07a",committed:"#00e0c6",built:"#ffb000",explored:"#6f7a8c"};

  // ---- moon phase (pure math, no network) ----
  // Synodic month = 29.530588853 days. Reference new moon: 2000-01-06 18:14 UTC (NASA).
  const SYNODIC = 29.530588853;
  const MOON_REF = Date.UTC(2000,0,6,18,14);
  const PHASE_NAMES = ["New Moon","Waxing Crescent","First Quarter","Waxing Gibbous","Full Moon","Waning Gibbous","Last Quarter","Waning Crescent"];
  const PHASE_EMOJI = ["🌑","🌒","🌓","🌔","🌕","🌖","🌗","🌘"];
  function moonPhase(when){
    const t = (typeof when==="string") ? Date.parse(when) : (when && when.getTime ? when.getTime() : +when);
    if(!isFinite(t)) return null;
    const days = (t - MOON_REF) / 86400000;
    const age = ((days % SYNODIC) + SYNODIC) % SYNODIC;       // 0..29.53 days
    const phase = age / SYNODIC;                                // 0..1
    // 8-way bucket centered on cardinal points (each bucket ~3.69 days wide)
    const idx = Math.floor(((phase + 1/16) % 1) * 8);
    const illum = 0.5 * (1 - Math.cos(2*Math.PI*phase));        // 0..1
    return { phase, age:+age.toFixed(2), idx, name:PHASE_NAMES[idx], emoji:PHASE_EMOJI[idx], illum:+illum.toFixed(3) };
  }

  function strand(s){ s=(s||"").toLowerCase();
    const m=re=>re.test(s);
    if(m(/rust|kernel|ffi/))return"rust"; if(m(/gepa|optimi|scorer|verifier|reward/))return"gepa";
    if(m(/libero|vla|jepa|rollout|robot|manip/))return"libero"; if(m(/embed|encoder|cluster|contrastive|synth/))return"synth";
    if(m(/htn|ledger|fork|trajectory|sim\b|plan/))return"ledger"; if(m(/eval|test|crap|complexity|spec|contract|grader/))return"proof";
    if(m(/core|storage|boundary|world|broker|rbac|runtime|service|audit|api/))return"core"; return"infra"; }

  // Each shell sub-command is classified independently; we keep the *farthest* stage reached.
  // Stage rank: merge > pr > push > commit. A command like "git commit && git push" → push.
  const GIT_MERGE = /(?:^|\s)(?:gh\s+pr\s+merge|git\s+merge(?!\s+(?:--abort|--continue|--quit|base|--squash\s+--no-commit)))/;
  const GIT_PR    = /(?:^|\s)(?:gh\s+pr\s+create|gh\s+pr\s+ready)/;
  const GIT_PUSH  = /(?:^|\s)(?:git\s+push|jj\s+git\s+push)(?!\w)/;
  const GIT_COMM  = /(?:^|\s)(?:git\s+commit|jj\s+(?:commit|describe))(?!\w)/;
  function classifyGit(cmd){
    const c = String(cmd||"");
    if(GIT_MERGE.test(c)) return "gitmerge";
    if(GIT_PR.test(c))    return "gitpr";
    if(GIT_PUSH.test(c))  return "gitpush";
    if(GIT_COMM.test(c))  return "gitcommit";
    return null;
  }
  function catTool(name, input){
    name = name||"";
    const i = (input && typeof input==="object") ? input : {};
    const cmd = String(i.command || i.cmd || "");
    let cat = "other", brief = "";
    for(const k of ["description","command","cmd","file_path","path","pattern","prompt","query","input"]){
      if(i[k]){ brief=String(i[k]).replace(/\s+/g," ").slice(0,90); break; }
    }
    if(EDIT.has(name)) cat="edit";
    else if(LOOK.has(name)) cat="look";
    else if(SHELL.has(name)){                              // shell tool: classify by the command
      const g = classifyGit(cmd);
      if(g) cat = g;
      else if(/apply_patch|sed -i|(^|\s)tee\s|>\s*\S+\.[A-Za-z0-9]/.test(cmd)) cat="edit"; // file writes
      else cat="bash";
    }
    // Codex / MCP tool names — PR creation is the same stage as `gh pr create`
    if(name==="_create_pull_request") cat="gitpr";
    else if(/^_fetch|^_search|list_mcp|update_plan/.test(name)) cat="look";
    return {n:name||cat, b:brief, cat};
  }
  function cleanUser(t){
    if(typeof t!=="string") return "";
    ["system_instruction","system-reminder","command-name","command-message","command-args","command-output"]
      .forEach(tag=>{ t=t.replace(new RegExp("<"+tag+">[\\s\\S]*?</"+tag+">","g"),""); });
    return t.replace(/<\/?[a-zA-Z_-]+>/g,"").replace(/^Caveat:.*$/gm,"").trim();
  }
  const isoOrNull = v => { try{ const d = (typeof v==="number") ? new Date(v>2e10? v : v*1000) : new Date(v); return isNaN(d)?null:d.toISOString(); }catch(_){ return null; } };

  // ---------- adapters ----------
  function parseClaude(text){
    const turns=[]; let project="", title="";
    for(const line of text.split("\n")){
      if(!line.trim()) continue; let o; try{o=JSON.parse(line);}catch(_){continue;}
      project = o.gitBranch || o.cwd || project;
      const m=o.message; if(!m||typeof m!=="object") continue;
      const c=m.content;
      if(o.type==="user" && typeof c==="string"){ const ct=cleanUser(c);
        if(ct){ turns.push({role:"user",ts:isoOrNull(o.timestamp),text:ct.slice(0,8000),tools:[],nthink:0,think:""});
          if(!title) title=ct.slice(0,90); } }
      else if(o.type==="assistant" && Array.isArray(c)){
        const txt=c.filter(b=>b.type==="text").map(b=>b.text).join(" ").trim();
        const tools=c.filter(b=>b.type==="tool_use").map(b=>catTool(b.name,b.input));
        const th=c.filter(b=>b.type==="thinking");
        if(txt||tools.length||th.length) turns.push({role:"assistant",ts:isoOrNull(o.timestamp),
          text:txt.slice(0,8000),tools,nthink:th.length,think:(th[0]?String(th[0].thinking||"").slice(0,300):"")});
      }
    }
    return turns.length? [{source:"Claude Code",id:null,project,title,turns}] : [];
  }

  function parseCodex(text){
    // Conversation text comes from the clean `event_msg` stream (user_message / agent_message /
    // agent_reasoning); tool calls come from `response_item` function_call. The `response_item`
    // *messages* carry injected context (AGENTS.md etc.) so we don't use them for text.
    const turns=[]; let project="",title="",id=null;
    for(const line of text.split("\n")){
      if(!line.trim()) continue; let o; try{o=JSON.parse(line);}catch(_){continue;}
      const t=o.type, p=(o.payload&&typeof o.payload==="object")?o.payload:{};
      if(t==="session_meta"){ project=p.cwd||project; id=p.id||id; continue; }
      if(t==="event_msg"){
        if(p.type==="user_message"){ const ct=cleanUser(String(p.message||"")); if(!ct) continue;
          turns.push({role:"user",ts:isoOrNull(o.timestamp),text:ct.slice(0,8000),tools:[],nthink:0,think:""});
          if(!title) title=ct.slice(0,90);
        } else if(p.type==="agent_message"){ const txt=String(p.message||"").trim(); if(!txt) continue;
          turns.push({role:"assistant",ts:isoOrNull(o.timestamp),text:txt.slice(0,8000),tools:[],nthink:0,think:""});
        } else if(p.type==="agent_reasoning"){ const th=String(p.text||"").trim();
          turns.push({role:"assistant",ts:isoOrNull(o.timestamp),text:"",tools:[],nthink:1,think:th.slice(0,300)});
        }
      } else if(t==="response_item" && p.type==="function_call"){
        let args=p.arguments; if(typeof args==="string"){ try{args=JSON.parse(args);}catch(_){args={command:args};} }
        turns.push({role:"assistant",ts:isoOrNull(o.timestamp),text:"",tools:[catTool(p.name,args)],nthink:0,think:""});
      }
    }
    return turns.length? [{source:"Codex",id,project,title,turns}] : [];
  }

  function parseChatGPT(json){
    if(!Array.isArray(json)) return [];
    return json.map(conv=>{
      const map=conv.mapping||{}; const nodes=Object.values(map).filter(n=>n&&n.message);
      nodes.sort((a,b)=>(a.message.create_time||0)-(b.message.create_time||0));
      const turns=[]; let title=conv.title||"";
      for(const n of nodes){ const m=n.message; const role=(m.author&&m.author.role)||"";
        const parts=(m.content&&(m.content.parts||[]))||[];
        const txt=parts.map(p=>typeof p==="string"?p:(p&&(p.text||""))||"").join(" ").trim();
        if(!txt && role!=="tool") continue;
        if(role==="user") turns.push({role:"user",ts:isoOrNull(m.create_time),text:txt.slice(0,8000),tools:[],nthink:0,think:""});
        else if(role==="assistant"||role==="tool") turns.push({role:"assistant",ts:isoOrNull(m.create_time),text:txt.slice(0,8000),tools:[],nthink:0,think:""});
      }
      return turns.length? {source:"ChatGPT",id:conv.conversation_id||conv.id||null,project:"",title,turns}:null;
    }).filter(Boolean);
  }

  function parseAnthropic(json){
    if(!Array.isArray(json)) return [];
    return json.map(conv=>{
      const msgs=conv.chat_messages||conv.messages||[]; const turns=[];
      for(const m of msgs){ const role=(m.sender||m.role)==="human"||(m.sender||m.role)==="user"?"user":"assistant";
        let txt=m.text; if(!txt && Array.isArray(m.content)) txt=m.content.map(b=>b.text||"").join(" ");
        txt=String(txt||"").trim(); if(!txt) continue;
        turns.push({role,ts:isoOrNull(m.created_at||m.create_time),text:txt.slice(0,8000),tools:[],nthink:0,think:""});
      }
      return turns.length? {source:"Anthropic",id:conv.uuid||null,project:"",title:conv.name||conv.title||"",turns}:null;
    }).filter(Boolean);
  }

  function firstNonEmptyLine(text){
    const nl = text.indexOf("\n");
    const head = (nl>0 ? text.slice(0, nl) : text).trim();
    if(head) { try{ return JSON.parse(head); }catch(_){} }
    // fallback: scan a few lines
    for(const line of text.split("\n", 5)){ const s=line.trim(); if(s){ try{ return JSON.parse(s); }catch(_){} } }
    return null;
  }
  function detectAndParse(filename, text){
    const lead = text.slice(0, 200).trim();
    if(!lead) return null;
    // JSON exports (a top-level array of conversations)
    if(lead[0]==="["){ let json; try{ json=JSON.parse(text); }catch(_){ return null; }
      if(Array.isArray(json) && json.length){
        if(json[0] && json[0].mapping) return {source:"ChatGPT", sessions:parseChatGPT(json)};
        if(json[0] && (json[0].chat_messages||json[0].name)) return {source:"Anthropic", sessions:parseAnthropic(json)};
      }
      return null;
    }
    // JSONL (one object per line)
    const first = firstNonEmptyLine(text);
    if(first && typeof first==="object"){
      const keys=Object.keys(first).join(",");
      // Codex rollouts open with a session_meta line (type + payload, no message)
      if(first.type==="session_meta" || /response_item|record_type/.test(keys)
         || (first.payload && (first.payload.cwd || first.payload.id) && !first.message))
        return {source:"Codex", sessions:parseCodex(text)};
      if(/sessionId|gitBranch/.test(keys) || (first.message && first.type) || (first.type && first.cwd))
        return {source:"Claude Code", sessions:parseClaude(text)};
    }
    return null;
  }

  // ---------- build display data (matches sessions.html + flow.html schemas) ----------
  function buildAll(norm){
    const TZ_NOTE = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    const sessions = norm.map((s,idx)=>{
      const ts = s.turns.map(t=>t.ts).filter(Boolean).sort();
      const start = ts[0]||null, end = ts[ts.length-1]||null;
      let edit=0,look=0,bash=0,gitc=0,gitp=0,gitpr=0,gitm=0,think=0,nu=0,na=0;
      for(const t of s.turns){ if(t.role==="user")nu++; else na++; think+=t.nthink||0;
        for(const x of (t.tools||[])){
          if(x.cat==="edit")edit++;
          else if(x.cat==="look")look++;
          else if(x.cat==="bash")bash++;
          else if(x.cat==="gitcommit"){bash++;gitc++;}
          else if(x.cat==="gitpush"){bash++;gitp++;}
          else if(x.cat==="gitpr"){bash++;gitpr++;}
          else if(x.cat==="gitmerge"){bash++;gitm++;}
        }
      }
      // Stage = farthest the session crossed the ship funnel.
      // merged > shipped (pushed/PR) > committed (local only) > built > explored
      const stage = gitm>0 ? "merged"
                  : (gitp>0||gitpr>0) ? "shipped"
                  : gitc>0 ? "committed"
                  : (edit>=5 || (edit+bash)>=12) ? "built"
                  : "explored";
      // Legacy tier preserved for flow.html backward compat (shipped == any git-commit-or-later).
      const tier = (gitc+gitp+gitpr+gitm)>0 ? "shipped" : (stage==="built" ? "built" : "explored");
      const k = s.project||s.title ? strand((s.project||"")+" "+(s.title||"")) : "chat";
      const dur = (start&&end)? Math.round((new Date(end)-new Date(start))/60000):0;
      const sh = start? new Date(start):null;
      const moon = start ? moonPhase(start) : null;
      return {raw:s, source:s.source, id:(s.id||(s.source[0]+idx)), short:(s.id||String(idx)).slice(0,8),
        ws:s.source, branch:s.project||"", start, end, dur, nu, na,
        title:s.title||"(untitled)", k, color:SCOLOR[k]||SCOLOR.infra,
        tier, tierColor:TIERCOLOR[tier], stage, stageColor:STAGECOLOR[stage],
        edit, look, bash, gitc, gitp, gitpr, gitm, think, moon,
        startH: sh? +(sh.getHours()+sh.getMinutes()/60).toFixed(2):null,
        turns:s.turns.map(t=>t.role==="user"?{role:"user",ts:t.ts,text:t.text}
          :{role:"assistant",ts:t.ts,text:t.text,tools:t.tools,nthink:t.nthink,think:t.think}),
        commits:[] };
    });

    // SESSIONS / SMETA (sessions.html)
    const SESSIONS = sessions.map(s=>({id:s.id,short:s.short,ws:s.ws,branch:s.branch,start:s.start,end:s.end,
      dur:s.dur,nu:s.nu,na:s.na,title:s.title,k:s.k,color:s.color,stage:s.stage,stageColor:s.stageColor,
      gitc:s.gitc,gitp:s.gitp,gitpr:s.gitpr,gitm:s.gitm,moon:s.moon,turns:s.turns,commits:s.commits}));
    const starts=sessions.map(s=>s.start).filter(Boolean).sort();
    const SMETA={n:SESSIONS.length,turns:SESSIONS.reduce((a,s)=>a+s.turns.length,0),
      from:(starts[0]||"").slice(0,10),to:(starts[starts.length-1]||"").slice(0,10),
      linked:0, tz:TZ_NOTE};

    // TURNS (flow.html) — circadian bins use uploader-local hour
    const hours=Array.from({length:24},(_,h)=>({h,shipped:0,built:0,explored:0,edits:0,total:0}));
    for(const s of sessions){ for(const t of s.raw.turns){ if(!t.ts) continue;
      const h=new Date(t.ts).getHours(); const isEdit=(t.tools||[]).some(x=>x.cat==="edit");
      hours[h][s.tier]++; hours[h].total++; if(isEdit) hours[h].edits++; } }
    const med=a=>{ if(!a.length)return 0; const b=[...a].sort((x,y)=>x-y); const m=b.length>>1; return b.length%2?b[m]:Math.round((b[m-1]+b[m])/2); };
    const tiers=["shipped","built","explored"].map(tier=>{ const ss=sessions.filter(s=>s.tier===tier); if(!ss.length) return null;
      const sum=k=>ss.reduce((a,s)=>a+s[k],0); const toolsum=(sum("edit")+sum("look")+sum("bash"))||1;
      return {tier,color:TIERCOLOR[tier],n:ss.length,turns:ss.reduce((a,s)=>a+s.turns.length,0),commits:sum("gitc"),
        medDur:med(ss.map(s=>s.dur)),edit:sum("edit"),look:sum("look"),bash:sum("bash"),think:sum("think"),
        pEdit:Math.round(sum("edit")/toolsum*100),pLook:Math.round(sum("look")/toolsum*100),pBash:Math.round(sum("bash")/toolsum*100),
        thinkPerTurn:+(sum("think")/Math.max(1,ss.reduce((a,s)=>a+s.turns.length,0))).toFixed(2)};
    }).filter(Boolean);
    const TURNS={meta:{nSessions:sessions.length,nTurns:hours.reduce((a,r)=>a+r.total,0),
      shipped:sessions.filter(s=>s.tier==="shipped").length,notShipped:sessions.filter(s=>s.tier!=="shipped").length,tz:TZ_NOTE},
      hours,tiers,sessions:sessions.map(s=>({ws:s.ws,sid:s.short,branch:s.branch,tier:s.tier,color:s.tierColor,
        startH:s.startH,start:s.start,turns:s.turns.length,edit:s.edit,look:s.look,bash:s.bash,gitc:s.gitc,think:s.think,dur:s.dur,title:s.title}))};

    const hasTools = sessions.some(s=>s.edit||s.bash||s.gitc);

    // CYCLES (cycles.html) — sessions grouped by moon phase, with stage funnel + 60-day timeline.
    // Browser path: MERGES/WEATHER stay empty unless scope.js (--git-merge / --weather) baked them in.
    const phases = Array.from({length:8},(_,i)=>({i,name:PHASE_NAMES[i],emoji:PHASE_EMOJI[i],
      sessions:0,merged:0,shipped:0,committed:0,built:0,explored:0,turns:0,edits:0}));
    const items = [];
    for(const s of sessions){ if(!s.moon) continue;
      const p = phases[s.moon.idx];
      p.sessions++; p[s.stage]++; p.turns += s.turns.length; p.edits += s.edit;
      items.push({sid:s.short, ws:s.ws, branch:s.branch, start:s.start, stage:s.stage,
        stageColor:s.stageColor, title:s.title, turns:s.turns.length, edit:s.edit, bash:s.bash,
        gitc:s.gitc, gitp:s.gitp, gitpr:s.gitpr, gitm:s.gitm, moon:s.moon});
    }
    items.sort((a,b)=>(b.start||"").localeCompare(a.start||""));
    const stageCounts = {merged:0,shipped:0,committed:0,built:0,explored:0};
    for(const s of sessions) stageCounts[s.stage]++;
    // Dominant phase: the bucket with the highest count of any-merged/shipped/committed (i.e. the "did something" buckets).
    const ranked = phases.map(p=>({...p, did:p.merged+p.shipped+p.committed})).sort((a,b)=>b.did-a.did);
    const dominant = ranked[0] && ranked[0].did>0 ? ranked[0] : null;
    const CYCLES = { phases, items, stageCounts, dominant,
      meta:{ n:sessions.length, tz:TZ_NOTE, latestStart: starts[starts.length-1]||null } };

    return {SESSIONS,SMETA,TURNS,CYCLES,hasTools};
  }

  global.SessionParsers = { detectAndParse, buildAll, moonPhase };
})(window);
