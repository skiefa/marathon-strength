if(window.top !== window.self){ try { window.top.location = window.self.location; } catch(e){ document.documentElement.style.display = 'none'; } }
/* ================= Konfiguration ================= */
const REPO = 'skiefa/coach-state';
const PLAN_PATH = 'training/plan.json';
const STATE_PATH = 'training/state.json';
const API = p => `https://api.github.com/repos/${REPO}/contents/${p}`;
const LS = {token:'tb-token', plan:'tb-plan', state:'tb-state', tab:'tb-tab'};

/* ================= Helfer ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => String(Math.round(n*100)/100).replace('.', ',');
const iso = d => d.toLocaleDateString('sv-SE');
const TODAY = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s+'T12:00'); d.setDate(d.getDate()+n); return iso(d); };
const monday = s => { const d = new Date(s+'T12:00'); const w = (d.getDay()+6)%7; d.setDate(d.getDate()-w); return iso(d); };
const WD = ['So','Mo','Di','Mi','Do','Fr','Sa'];
const shortRange = wk => { const a = new Date(wk+'T12:00'), b = new Date(addDays(wk,6)+'T12:00'), M = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return a.getMonth() === b.getMonth() ? `${a.getDate()}.–${b.getDate()}. ${M[b.getMonth()]}` : `${a.getDate()}. ${M[a.getMonth()]} – ${b.getDate()}. ${M[b.getMonth()]}`; };
const dayLabel = s => { const d = new Date(s+'T12:00'); return `${WD[d.getDay()]} ${d.getDate()}.${d.getMonth()+1}.`; };
const longDate = s => new Date(s+'T12:00').toLocaleDateString('de-DE', {weekday:'long', day:'numeric', month:'long'});
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const now = () => Date.now();
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = s => decodeURIComponent(escape(atob(String(s).replace(/\s/g,''))));
function lsGet(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
function toast(t){ const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(()=> el.hidden = true, 2200); }

/* ================= Token ================= */
const DEV = location.search.includes('dev');
function token(){
  if(DEV) return 'dev';
  try { localStorage.removeItem('coach-sync'); } catch(e){}   // alter Schlüssel der abgeschalteten Coach-App
  return lsGet(LS.token, '');
}
const gh = () => ({ 'Authorization':'Bearer '+token(), 'Accept':'application/vnd.github+json' });

/* ================= Daten ================= */
let PLAN = cleanPlan(lsGet(LS.plan, null));
let S = lsGet(LS.state, null) || {v:1, tage:{}, kraft:[], vollWoche:{}};
S.tage = S.tage || {}; S.kraft = S.kraft || []; S.vollWoche = S.vollWoche || {};
let syncSha = null, syncTimer = null, syncBusy = false, syncQueued = false, syncErr = null, lastSync = null;

/* Plan säubern: ids/typ nur Buchstaben, Ziffern, -, _; Zahlen nur Zahlen */
function cleanPlan(p){
  const ID = v => String(v ?? '').replace(/[^\w-]/g, ''), N = v => (typeof v === 'number' && isFinite(v)) ? v : (parseFloat(v) || 0);
  Object.values((p && p.tage) || {}).forEach(ss => (ss || []).forEach(s => {
    s.id = ID(s.id); s.typ = ID(s.typ); if(s.dauer != null) s.dauer = N(s.dauer);
    (s.uebungen || []).forEach(u => { u.id = ID(u.id); u.saetze = N(u.saetze); u.wdh = N(u.wdh); u.einheit = ID(u.einheit); });
    const fix = st => (st || []).forEach(x => { if(x.wiederhole){ x.wiederhole = N(x.wiederhole); fix(x.schritte); } else { x.art = ID(x.art); ['min','sek','zone'].forEach(k => { if(x[k] != null) x[k] = N(x[k]); }); if(x.hf) x.hf = x.hf.map(N); } });
    fix(s.schritte);
  }));
  Object.values((p && p.erledigt) || {}).forEach(as => (as || []).forEach(a => { a.typ = ID(a.typ); a.id = ID(a.id); a.min = N(a.min); if(a.km != null) a.km = N(a.km); ['hf','pace','hfMax','kad','hm'].forEach(k => { if(a[k] != null) a[k] = N(a[k]); }); if(a.serie){ a.serie.dt = N(a.serie.dt) || 30; ['hf','p'].forEach(k => a.serie[k] = (a.serie[k] || []).map(v => v == null ? null : N(v))); } }));
  (p && p.gymVorlage || []).forEach(u => { u.id = ID(u.id); u.saetze = N(u.saetze); u.wdh = N(u.wdh); u.einheit = ID(u.einheit); });
  Object.values((p && p.wochenSoll) || {}).forEach(w => Object.keys(w).forEach(k => w[k] = N(w[k])));
  return p;
}
function day(d){ return S.tage[d] = S.tage[d] || {}; }
function save(){ lsSet(LS.state, S); clearTimeout(syncTimer); syncTimer = setTimeout(syncUp, 3000); setSyncLabel('speichert …'); }

/* Vereinigung zweier Stände: Objekte rekursiv, Listen nach id (neueres u gewinnt), sonst lokal gewinnt */
function merge(a, b){
  if(Array.isArray(a) && Array.isArray(b)){
    const m = new Map();
    [...b, ...a].forEach(x => { const k = x && x.id ? x.id : JSON.stringify(x); const o = m.get(k); if(!o || (x.u||0) >= (o.u||0)) m.set(k, x); });
    return [...m.values()];
  }
  if(a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)){
    if(typeof a.u === 'number' && typeof b.u === 'number') return a.u >= b.u ? a : b;   // neuerer Stand gewinnt (z. B. Tagebuch)
    const r = {...b};
    for(const k in a) r[k] = (k in b) ? merge(a[k], b[k]) : a[k];
    return r;
  }
  return a === undefined ? b : a;
}

/* Gelöschte Listeneinträge (ids in S.geloescht) dürfen durch den Merge nicht zurückkommen */
function prune(o, del){
  if(Array.isArray(o)) return o.filter(x => !(x && x.id && del.has(x.id))).map(x => prune(x, del));
  if(o && typeof o === 'object'){ for(const k in o) if(k !== 'geloescht') o[k] = prune(o[k], del); }
  return o;
}
function mergeState(a, b){ const r = merge(a, b); const del = new Set((r.geloescht || []).map(x => x.id)); return del.size ? prune(r, del) : r; }
function forget(id){ (S.geloescht = S.geloescht || []).push({id, u:now()}); S = prune(S, new Set([id])); }

async function loadPlan(){
  if(DEV){ PLAN = cleanPlan(await (await fetch('dev-plan.json', {cache:'no-store'})).json()); render(); return; }
  if(!token()) return;
  try {
    const r = await fetch(API(PLAN_PATH), {headers:{...gh(), Accept:'application/vnd.github.raw+json'}, cache:'no-store'});
    if(r.status === 401){ lsSet(LS.token, ''); render(); return; }   // Schlüssel gelöscht/abgelaufen → neu verbinden
    if(!r.ok) throw new Error(r.status===401 ? 'Token ungültig' : r.status===404 ? 'Noch kein Plan' : 'HTTP '+r.status);
    PLAN = cleanPlan(await r.json()); lsSet(LS.plan, PLAN); render();
  } catch(e){ syncErr = String(e.message||e); setSyncLabel(); }
}
async function syncDown(){
  if(!token() || DEV) return;
  try {
    const r = await fetch(API(STATE_PATH), {headers:gh(), cache:'no-store'});
    if(r.status === 404){ syncSha = ''; syncUp(); return; }
    if(!r.ok) throw new Error(r.status===401 ? 'Token ungültig' : 'HTTP '+r.status);
    const j = await r.json(); syncSha = j.sha;
    const remote = JSON.parse(b64dec(j.content));
    const before = JSON.stringify(S);
    S = mergeState(S, remote); lsSet(LS.state, S);
    if(JSON.stringify(S) !== JSON.stringify(remote)) save();
    lastSync = new Date(); syncErr = null; setSyncLabel();
    if(JSON.stringify(S) !== before) render();
  } catch(e){ syncErr = String(e.message||e); setSyncLabel(); }
}
async function syncUp(){
  if(!token() || DEV) return;
  if(syncBusy){ syncQueued = true; return; }
  syncBusy = true;
  try {
    if(syncSha === null){
      const g = await fetch(API(STATE_PATH), {headers:gh(), cache:'no-store'});
      if(g.ok){ const j = await g.json(); syncSha = j.sha; S = mergeState(S, JSON.parse(b64dec(j.content))); lsSet(LS.state, S); }
      else if(g.status === 404) syncSha = '';
      else throw new Error(g.status===401 ? 'Token ungültig' : 'HTTP '+g.status);
    }
    const body = {message:'Trainingsbuch', content:b64enc(JSON.stringify(S))};
    if(syncSha) body.sha = syncSha;
    let r = await fetch(API(STATE_PATH), {method:'PUT', headers:gh(), body:JSON.stringify(body)});
    if(r.status === 409 || r.status === 422){ syncSha = null; syncBusy = false; if((syncUp.tries = (syncUp.tries || 0) + 1) <= 3) return syncUp(); syncUp.tries = 0; throw new Error('Konflikt beim Sichern'); }
    syncUp.tries = 0;
    if(!r.ok) throw new Error(r.status===401 ? 'Token ungültig' : 'HTTP '+r.status);
    syncSha = (await r.json()).content.sha; lastSync = new Date(); syncErr = null;
  } catch(e){ syncErr = String(e.message||e); }
  syncBusy = false; setSyncLabel();
  if(syncQueued){ syncQueued = false; syncUp(); }
}
function setSyncLabel(t){
  const el = $('#sync'); if(!el) return;
  el.className = 'sync' + (syncErr ? ' err' : '');
  el.textContent = t || (syncErr ? '⚠ ' + syncErr : lastSync ? 'gesichert ' + lastSync.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}) : '');
}
addEventListener('pagehide', () => { if(syncTimer){ clearTimeout(syncTimer); syncUp(); } });
addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible'){ loadPlan(); syncDown(); } });

/* ================= Plan-Zugriff ================= */
const P = () => PLAN || {};
const sessions = d => (P().tage && P().tage[d]) || [];
const RING_TYP = {lauf:'lauf', kraft:'kraft', gym:'kraft', schwimmen:'ausdauer', rad:'ausdauer', wandern:'ausdauer', grundlage:'ausdauer', mobility:'mobility'};
const MIN_EINHEIT = 10;   // kurze Aktivitäten (unter 10 min) zählen nicht als Einheit
function garminAll(d){ return (P().erledigt && P().erledigt[d]) || []; }
function garminDone(d){ return garminAll(d).filter(a => (a.min || 0) >= MIN_EINHEIT); }
function isDone(d, s){
  if(day(d).check && day(d).check[s.id]) return true;
  if(S.kraft.some(k => k.datum === d && k.session === s.id)) return true;
  const g = garminDone(d), t = RING_TYP[s.typ];
  if(s.typ === 'lauf') return g.some(a => a.typ === 'lauf');
  if(t === 'ausdauer') return g.some(a => RING_TYP[a.typ] === 'ausdauer');
  return false;
}
function vollWoche(d){ return !!S.vollWoche[monday(d)]; }
function visibleSessions(d){ return sessions(d).filter(s => !(vollWoche(d) && s.pflicht === false && s.typ !== 'frei')); }
function nextSession(from){
  for(let i = 0; i < 21; i++){ const d = addDays(from, i); const ss = visibleSessions(d).filter(s => s.typ !== 'frei' && !isDone(d, s)); if(ss.length) return {d, s:ss[0]}; }
  return null;
}

/* ================= Wochenringe ================= */
function ringsFor(wk){
  const soll = (P().wochenSoll && P().wochenSoll[wk]) || {};
  const ist = {lauf:0, kraft:0, ausdauer:0, mobility:0};
  for(let i = 0; i < 7; i++){
    const d = addDays(wk, i), seen = new Set();
    garminDone(d).forEach(a => { const t = RING_TYP[a.typ]; if(t && t !== 'kraft' && !seen.has(t+a.id)){ ist[t]++; seen.add(t+a.id); } });
    const kraftHeute = new Set(S.kraft.filter(k => k.datum === d).map(k => k.session || 'frei'));
    sessions(d).forEach(s => { if(day(d).check && day(d).check[s.id]){ const t = RING_TYP[s.typ]; if(t === 'kraft') kraftHeute.add(s.id); else if(t && !garminDone(d).some(a => RING_TYP[a.typ] === t)) ist[t]++; } });
    ist.kraft += kraftHeute.size;
    ist.mobility += (day(d).mobility || []).length;
  }
  const erh = P().erholung || {}; const sl = [];
  for(let i = 0; i < 7; i++){ const e = erh[addDays(wk, i)]; if(e && e.schlaf_h) sl.push(e.schlaf_h); }
  const schlaf = sl.length ? sl.reduce((a,b)=>a+b,0)/sl.length : null;
  const h = schlaf ? `${Math.floor(schlaf)}:${String(Math.round((schlaf%1)*60)).padStart(2,'0')} h` : '–';
  return [
    ['Laufen','--c-lauf', ist.lauf, soll.lauf],
    ['Kraft','--c-kraft', ist.kraft, soll.kraft],
    ['Ausdauer','--c-ausdauer', ist.ausdauer, soll.ausdauer],
    ['Mobility','--c-mobility', ist.mobility, soll.mobility],
    ['Schlaf','--c-schlaf', schlaf ? Math.min(schlaf, 8) : 0, 7.5, h]
  ];
}
function ringsHTML(wk){
  const T = {'--c-lauf':'lauf','--c-kraft':'kraft','--c-ausdauer':'grundlage','--c-mobility':'mobility','--c-schlaf':'schlaf'};
  return `<div class="rings">${ringsFor(wk).map(([n,c,v,soll,txt]) => {
    const f = soll ? Math.min(1, v/soll) : 0, ok = soll && v >= soll;
    const val = txt ? txt : soll ? `${v} von ${soll}${ok ? ' ✓' : ''}` : `${v}×`;
    const sub = txt ? 'Ø pro Nacht' : soll ? '' : 'diese Woche ohne Soll';
    return `<div class="tile t-${T[c]} ${c === '--c-schlaf' ? 'wide' : ''}"><span class="n">${n}</span><span class="v">${val}</span>${sub ? `<span class="s">${sub}</span>` : ''}${soll ? `<div class="bar"><b style="width:${f*100}%"></b></div>` : ''}</div>`;
  }).join('')}</div>`;
}

/* ================= Phase ================= */
function phaseHTML(){
  const ph = P().phasen || []; if(!ph.length) return '';
  const t = TODAY(), w = ph.map(p => Math.max(1, (new Date(p.ende) - new Date(p.start))/864e5));
  const cols = w.map(x => x+'fr').join(' ');
  return `<div class="phase" style="grid-template-columns:${cols}" aria-hidden="true">${ph.map(p => `<div class="${p.start <= t && t <= p.ende ? 'on' : ''}"></div>`).join('')}</div>
    <div class="phase-l">${(() => { const i = ph.findIndex(p => p.start <= t && t <= p.ende), nx = ph[i+1];
      return `<span><b>${esc(i >= 0 ? ph[i].name : '')}</b>${i >= 0 ? ' bis ' + dayLabel(ph[i].ende).replace(/^\S+ /, '') : ''}</span>${nx ? `<span>danach ${esc(nx.name)}</span>` : ''}`; })()}</div>`;
}
function currentPhase(){ const t = TODAY(); return (P().phasen || []).find(p => p.start <= t && t <= p.ende); }

/* ================= Charts ================= */
function tempoChart(W, H){
  const f = P().fortschritt || {}, E = f.tempo135 || []; if(E.length < 2) return '';
  const ziel = f.tempoZiel || null, vals = E.map(e => e[1]).concat(ziel ? [ziel] : []);
  const lo = Math.floor((Math.min(...vals)-8)/10)*10, hi = Math.ceil((Math.max(...vals)+8)/10)*10;
  const L=42,R=10,T=14,B=22,n=E.length, x=i=>L+(W-L-R)*i/(n-1), y=v=>T+(H-T-B)*(v-lo)/(hi-lo);
  const pm = s => Math.floor(s/60)+':'+String(Math.round(s%60)).padStart(2,'0');
  const M = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  let s = '';
  for(let v = lo; v <= hi; v += 20) s += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width=".7"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end" font-size="14" fill="var(--muted)" font-family="Lexend">${pm(v)}</text>`;
  if(ziel) s += `<line x1="${L}" x2="${W-R}" y1="${y(ziel)}" y2="${y(ziel)}" stroke="var(--c-kraft)" stroke-dasharray="4 4"/><text x="${W-R}" y="${y(ziel)-5}" text-anchor="end" font-size="14" fill="var(--ink)" font-family="Lexend">Ziel ${pm(ziel)}</text>`;
  s += `<polyline fill="none" stroke="var(--c-lauf)" stroke-width="3" stroke-linejoin="round" points="${E.map((e,i)=>x(i)+','+y(e[1])).join(' ')}"/>`;
  E.forEach((e,i) => s += `<circle cx="${x(i)}" cy="${y(e[1])}" r="${i===n-1?6:3.5}" fill="var(--c-lauf)"/><text x="${x(i)}" y="${H-5}" text-anchor="middle" font-size="14" fill="var(--muted)" font-family="Lexend">${M[+e[0].slice(5,7)-1]}</text>`);
  s += `<text x="${L+2}" y="${T-3}" font-size="13.5" fill="var(--muted)" font-family="Lexend">oben = schneller</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Lockeres Tempo bei Puls 135">${s}</svg>`;
}
function belastChart(W, H){
  const D = (P().fortschritt || {}).belastbarkeit || []; if(D.length < 2) return '';
  const max = Math.ceil(Math.max(...D.map(p=>p[1]))/25)*25;
  const L=30,R=10,T=14,B=22,n=D.length,x=i=>L+(W-L-R)*i/(n-1),y=v=>T+(H-T-B)*(max-v)/max;
  const M = {'01':'Jan','02':'Feb','03':'Mär','04':'Apr','05':'Mai','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Okt','11':'Nov','12':'Dez'};
  let s = '';
  for(let v = 0; v <= max; v += 25) s += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width=".7"/><text x="${L-5}" y="${y(v)+4}" text-anchor="end" font-size="14" fill="var(--muted)" font-family="Lexend">${v}</text>`;
  D.forEach((p,i) => { if(p[0].slice(-2) === '01') s += `<text x="${x(i)}" y="${H-5}" text-anchor="middle" font-size="14" fill="var(--muted)" font-family="Lexend">${M[p[0].slice(5,7)]}</text>`; });
  s += `<polygon fill="var(--c-lauf)" opacity=".13" points="${x(0)},${y(0)} ${D.map((p,i)=>x(i)+','+y(p[1])).join(' ')} ${x(n-1)},${y(0)}"/><polyline fill="none" stroke="var(--c-lauf)" stroke-width="2.4" points="${D.map((p,i)=>x(i)+','+y(p[1])).join(' ')}"/>`;
  let mi = 0; D.forEach((p,i) => { if(p[1] > D[mi][1]) mi = i; });
  s += `<circle cx="${x(mi)}" cy="${y(D[mi][1])}" r="4" fill="var(--c-lauf)"/><text x="${x(mi)-6}" y="${y(D[mi][1])-8}" text-anchor="end" font-size="13" fill="var(--ink)">am fittesten: ${Math.round(D[mi][1])}</text>`;
  (P().fortschritt.marker || []).forEach(([dd, t]) => { const i = D.findIndex(p => p[0] === dd); if(i >= 0) s += `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H-B}" stroke="var(--muted)" stroke-dasharray="3 3"/><text x="${x(i)-5}" y="${T+12}" text-anchor="end" font-size="13" fill="var(--ink)" font-weight="700">${esc(t)}</text>`; });
  s += `<circle cx="${x(n-1)}" cy="${y(D[n-1][1])}" r="3.5" fill="var(--c-lauf)"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Belastbarkeit">${s}</svg>`;
}
function spark(vals){
  if(vals.length < 2) return '';
  const max = Math.max(...vals), min = Math.min(...vals), r = (max-min) || 1;
  const pts = vals.map((v,i) => `${6+i*(188/(vals.length-1))},${42-(v-min)/r*34}`);
  return `<svg viewBox="0 0 200 48" class="chart" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.2"/><circle cx="${pts[pts.length-1].split(',')[0]}" cy="${pts[pts.length-1].split(',')[1]}" r="3.5" fill="var(--accent)"/></svg>`;
}

/* ================= Kraft-Logik ================= */
function history(uebung){ return S.kraft.filter(k => k.uebung === uebung && (k.saetze||[]).some(x => x.ok)).sort((a,b) => (a.datum+a.u) < (b.datum+b.u) ? -1 : 1); }
function bestKg(uebung, excludeId){ let m = 0; S.kraft.forEach(k => { if(k.uebung === uebung && k.id !== excludeId) (k.saetze||[]).forEach(x => { if(x.ok && x.kg > m) m = x.kg; }); }); return m; }
function suggestion(u){
  const h = history(u.id).filter(k => k.datum !== TODAY()); const last = h[h.length-1];
  if(!last) return {kg: u.startKg ?? 0, wdh: u.wdh, text: u.einheit === 'kg' ? (u.startKg ? `Erstes Mal: mit ${fmt(u.startKg)} kg starten, sollte sich wie 7 von 10 anfühlen.` : 'Erstes Mal: Gewicht wählen, das sich wie 7 von 10 anfühlt.') : 'Erstes Mal: sauber und kontrolliert.', last:null};
  const ok = last.saetze.filter(x => x.ok);
  const kg = Math.max(...ok.map(x => x.kg || 0));
  const alle = ok.length >= u.saetze && ok.every(x => (x.wdh||0) >= u.wdh);
  const lastTxt = `zuletzt ${u.einheit === 'kg' ? fmt(kg)+' kg × ' : ''}${ok.map(x => x.wdh).join('/')}${u.einheit === 's' ? ' s' : ''}`;
  if(u.einheit !== 'kg') return {kg:0, wdh: alle ? u.wdh + (u.einheit === 's' ? 5 : 1) : u.wdh, text: alle ? 'Heute etwas länger/mehr.' : 'Heute das Gleiche, sauber.', last:lastTxt};
  return alle ? {kg: kg + (u.step||2.5), wdh:u.wdh, text:`Heute ${fmt(kg + (u.step||2.5))} kg versuchen.`, last:lastTxt}
              : {kg, wdh:u.wdh, text:`Heute bei ${fmt(kg)} kg bleiben und alle Wiederholungen schaffen.`, last:lastTxt};
}
function entryFor(d, sid, u){
  let e = S.kraft.find(k => k.datum === d && k.session === sid && k.uebung === u.id);
  if(!e){ const sg = suggestion(u); e = {id:uid(), u:now(), datum:d, session:sid, uebung:u.id, name:u.name, einheit:u.einheit, saetze:Array.from({length:u.saetze}, () => ({kg:sg.kg, wdh:sg.wdh, ok:false}))}; S.kraft.push(e); }
  return e;
}
/* Diktat: „3×12 Face Pulls mit 15 kg, 10 min Rudergerät“ */
function parseDiktat(text){
  return text.split(/,|;|\bund\b|\n/).map(s => s.trim()).filter(Boolean).map(s => {
    let m = s.match(/^(\d+)\s*[x×]\s*(\d+)\s*(?:s|sek\w*)?\s+(.+?)(?:\s+(?:mit|à|a|@)\s+([\d.,]+)\s*kg)?$/i);
    if(m) return {name:m[3], saetze:+m[1], wdh:+m[2], kg:m[4] ? parseFloat(m[4].replace(',','.')) : null};
    m = s.match(/^(\d+)\s*min\w*\s+(.+)$/i) || s.match(/^(.+?)\s+(\d+)\s*min\w*$/i);
    if(m) return /^\d/.test(m[1]) ? {name:m[2], min:+m[1]} : {name:m[1], min:+m[2]};
    return {name:s, unklar:true};
  });
}
const slug = s => s.toLowerCase().replace(/[äöüß]/g, c => ({'ä':'ae','ö':'oe','ü':'ue','ß':'ss'}[c])).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

/* ================= Views ================= */
const TABS = [['dash','Übersicht'],['heute','Heute'],['woche','Woche'],['kraft','Kraft'],['buch','Tagebuch'],['besser','Geschichte']];
const WIDE = () => matchMedia('(min-width:900px)').matches;
let TAB = (DEV && new URLSearchParams(location.search).get('tab')) || lsGet(LS.tab, null) || (WIDE() ? 'dash' : 'heute');
let [selDay, selSes] = DEV && new URLSearchParams(location.search).get('sel') ? new URLSearchParams(location.search).get('sel').split('|') : [null, null]; let weekOff = DEV ? +(new URLSearchParams(location.search).get('w') || 0) : 0, kraftSel = null, restTimer = null;

function render(){
  if(TAB === 'dash' && !WIDE()) TAB = 'heute';
  $('#nav').innerHTML = TABS.filter(([k]) => k !== 'dash' || WIDE()).map(([k,l]) => `<button data-tab="${k}" ${TAB===k ? 'aria-current="page"' : ''}>${l}</button>`).join('');
  if(!token()){ $('#main').innerHTML = setupView(); bindSetup(); return; }
  if(!PLAN){ $('#main').innerHTML = `<div class="card narrow"><p class="big">Plan wird geladen …</p><p class="mut">Falls das so bleibt: Internet prüfen. Den ersten Plan legt Claude auf dem Mac an.</p></div>`; return; }
  $('#main').innerHTML = ({dash:viewDash, heute:viewHeute, woche:viewWoche, kraft:viewKraft, buch:viewBuch, besser:viewBesser}[TAB])();
  bind();
}

function setupView(){
  return `<div class="card narrow"><p class="big">Einmal verbinden</p>
    <p class="mut">Nimm den Schlüssel „Trainingsbuch“. Deine Einträge bleiben erhalten.</p>
    <p>Deine Trainingsdaten liegen privat bei GitHub. Füge hier einmal deinen Zugangsschlüssel ein (beginnt mit <span class="num">github_pat_</span>). Claude hat dir gezeigt, woher du ihn bekommst.</p>
    <label class="lbl" for="tok">Schlüssel</label><input type="password" id="tok" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="github_pat_…">
    <button class="btn primary" id="tokok">Verbinden</button></div>`;
}
function bindSetup(){ $('#tokok').onclick = () => { const t = $('#tok').value.trim(); if(!t) return; lsSet(LS.token, t); render(); loadPlan(); syncDown(); }; }

/* ---------- WORKOUT-DIAGRAMM (wie TrainingPeaks) ----------
   s.schritte = [{art: aufwaermen|aktiv|pause|auslaufen|steigerung, min | sek, zone 1–5, hf:[von,bis], pace:"5:45", text}]
   oder {wiederhole: n, schritte:[…]}. Höhe = Intensität, Breite = Dauer. */
const ZONE_IF = {0:.55, 1:.55, 2:.72, 3:.83, 4:.90, 5:1.0, 6:1.05};   // hrTSS-Faktoren laut training/trainingslehre.md §5 (0 = Gehen, 5 = Schwelle, 6 = darüber/Steigerung)
const ZONE_PACE = {0:11.5, 1:8.8, 2:7.8, 3:7.1, 4:6.9, 5:6.6, 6:5.8}; // min/km, Schätzung aus der Leistungsdiagnostik (nur für die km-Angabe)
const ART = {aufwaermen:'Aufwärmen', aktiv:'Aktiv', pause:'Erholung', auslaufen:'Auslaufen', steigerung:'Steigerung', locker:'Locker', gehen:'Gehen'};
function flatSteps(ss){ const out = []; (ss||[]).forEach(x => { if(x.wiederhole){ for(let i = 0; i < x.wiederhole; i++) flatSteps(x.schritte).forEach(y => out.push({...y, rep:true})); } else out.push(x); }); return out; }
const woFill = z => z >= 5 ? `color-mix(in srgb,var(--c-lauf) ${100 - (z-5)*0}%,var(--ink) ${(z-4)*12}%)` : `color-mix(in srgb,var(--c-lauf) ${35 + z*16}%,var(--surface))`;
const secOf = x => x.sek || (x.min || 0)*60;
const zoneOf = x => x.art === 'steigerung' ? 6 : (x.zone ?? 2);
function woStats(s){
  const st = flatSteps(s.schritte); let sec = 0, km = 0, tss = 0;
  st.forEach(x => { const t = secOf(x), z = zoneOf(x); sec += t; km += (t/60) / ZONE_PACE[z]; tss += (t/3600) * ZONE_IF[z]**2 * 100; });
  return {sec, km, tss};
}
function workoutHTML(s){
  if(!(s.schritte||[]).length) return '';
  const st = flatSteps(s.schritte), {sec, km, tss} = woStats(s), W = 600, H = 14 + Math.max(...st.map(zoneOf)) * 17 + 6;
  let x = 0, bars = '';
  st.forEach(y => { const w = secOf(y)/sec*W, z = zoneOf(y), h = 14 + z*17;
    bars += `<rect x="${x+0.5}" y="${H-h}" width="${Math.max(1, w-1)}" height="${h}" rx="3" fill="${woFill(z)}"/>`; x += w; });
  const hm = Math.floor(sec/3600) + ':' + String(Math.round(sec%3600/60)).padStart(2,'0');
  const line = y => `${ART[y.art] || y.art} ${y.sek ? y.sek+' s' : y.min+' min'}${y.hf ? ` @ ${y.hf[0]}–${y.hf[1]} bpm` : ''}${y.pace ? ` · ca. ${y.pace}/km` : ''}${y.zone && y.art !== 'steigerung' && y.art !== 'gehen' ? ` · Zone ${y.zone}` : ''}${y.text ? ` · ${y.text}` : ''}`;
  const sw = y => `<i style="background:${woFill(zoneOf(y))}"></i>`;
  const list = (s.schritte).map(y => y.wiederhole
    ? `<li><span></span><span><b>${y.wiederhole}× wiederholen</b></span></li>` + y.schritte.map(z => `<li class="rep">${sw(z)}<span>${esc(line(z))}</span></li>`).join('')
    : `<li>${sw(y)}<span>${esc(line(y))}</span></li>`).join('');
  return `<div class="wo">
    <div class="wo-head"><div><b>${hm}</b> <span>h</span></div><div><b>~${fmt(Math.round(km*10)/10)}</b> <span>km</span></div><div><b>~${Math.round(tss)}</b> <span>Belastung</span></div></div>
    ${s.zweck ? `<div class="wo-ziel"><span class="lbl">Ziel</span><span>${esc(s.zweck)}</span>${s.zahltEin ? `<span class="mut">Zahlt ein auf: ${esc(s.zahltEin)}</span>` : ''}</div>` : ''}
    <svg class="wo-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Aufbau der Einheit">${bars}</svg>
    <ul class="wo-steps">${list}</ul></div>`;
}

/* ---------- ÜBERSICHT (nur große Bildschirme): Heute | Woche | Fortschritt ---------- */
function viewDash(){
  return `<div class="dash"><section class="dcol"><h2 class="dh">Heute</h2>${viewHeute()}</section>
    <section class="dcol"><h2 class="dh">Woche</h2>${viewWoche()}</section>
    <section class="dcol"><h2 class="dh">Geschichte</h2>${viewBesser()}</section></div>`;
}
let _wide = WIDE(); addEventListener('resize', () => { if(WIDE() !== _wide){ _wide = WIDE(); render(); } });

/* ---------- HEUTE ----------
   Design 08.10.2026: dunkler Kopf (ein Satz), danach weiße Abschnitte. Farbe nur Pink (Laufen), Lila (Kraft/Körper),
   Türkis (Wasser/Schwimmen) – kein Rot/Orange, keine dunklen Knöpfe. */
function suppListe(){ const l = (P().supplements || {}).liste; return Array.isArray(l) ? l.filter(x => x && x.id && x.name) : []; }
const hm = h => `${Math.floor(h)}:${String(Math.round((h%1)*60)).padStart(2,'0')} h`;
function viewHeute(){
  const t = TODAY(), h = (P().heute || {})[t], ss = visibleSessions(t), e = (P().erholung || {})[t];
  const ampel = h ? h.ampel : null;
  const akt = ss.filter(s => s.typ !== 'frei'), frei = ss.find(s => s.typ === 'frei');
  const satz = h ? h.satz : akt.length ? `Heute: ${akt.map(s => s.titel).join(' und ')}.` : frei ? frei.titel + '.' : 'Heute ist frei.';
  const warum = (h && h.warum) || (e ? [['Schlaf', e.schlaf_h ? hm(e.schlaf_h) : '–'], ['Erholung', e.hrv ? 'HRV ' + e.hrv : '–']] : null);
  const d = day(t), wasser = (d.wasser || []).reduce((a, x) => a + x.ml, 0);
  const wz = (P().wasserZiel || {})[t] || (P().wasserZiel || {}).standard || 2400;
  const ins = (P().einsichten || [])[0];
  return `<div class="stack narrow" style="margin:0 auto">
    <div class="hx">
      <div class="hx-top"><span>${esc(longDate(t))}</span></div>
      ${ampel ? `<div class="hx-st ${esc(ampel)}"><i></i>${esc(h.ampelText || '')}</div>` : ''}
      <h1 class="hx-satz">${esc(satz)}</h1>
      ${h && h.sub ? `<p class="hx-sub">${esc(h.sub)}</p>` : ''}
      ${warum ? `<div class="hx-why">${warum.map(([k,v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
    </div>
    <div class="card">
      <div class="sh"><h3>Wasser</h3><span>Ziel ${fmt(wz/1000)} l</span></div>
      <div class="wnum num">${fmt(Math.round(wasser/100)/10)}<small>Liter</small></div>
      <div class="bar wbar"><b style="width:${Math.min(100, wasser/wz*100)}%"></b></div>
      <div class="wbtn">${[300,400,500].map(m => `<button data-w="${m}">+${m}</button>`).join('')}</div>
      ${(d.wasser||[]).length ? `<button class="linkbtn" id="wundo">↶ letzten Eintrag zurück</button>` : ''}
    </div>
    ${akt.map(s => sessionCard(t, s)).join('')}
    ${ins ? `<div class="card ins"><span class="kick">Neu entdeckt</span><h2>${esc(ins.titel)}</h2>${ins.text ? `<p>${esc(ins.text)}</p>` : ''}<button class="more" data-goto="besser">Deine Geschichte →</button></div>` : ''}
    ${weekStrip(t)}
    ${snackCard(t)}
    <div class="card">
      <div class="sh"><h3>Supplements</h3></div>
      ${suppListe().length ? `<div class="pills">${['morgen','abend'].map(z => suppListe().filter(x => x.zeit === z).length ? `<span class="plbl">${z === 'morgen' ? 'Morgens' : 'Abends'}</span>` + suppListe().filter(x => x.zeit === z).map(x => `<button class="pill" data-supp="${esc(x.id)}" aria-pressed="${!!(d.supp && d.supp[x.id])}">${esc(x.name)}</button>`).join('') : '').join('')}</div>` : `<div class="chk"><input type="checkbox" id="sm" ${d.supp && d.supp.morgen ? 'checked' : ''}><label for="sm">Morgens: ${esc((P().supplements||{}).morgen || 'Supplements')}</label></div>
      <div class="chk"><input type="checkbox" id="sa" ${d.supp && d.supp.abend ? 'checked' : ''}><label for="sa">Abends: ${esc((P().supplements||{}).abend || 'Supplements')}</label></div>`}
    </div>
  </div>`;
}
const TYPNAME = {lauf:'Laufen', kraft:'Kraft', gym:'Kraft', schwimmen:'Schwimmen', rad:'Rad', wandern:'Wandern', grundlage:'Rad / Wandern', mobility:'Mobility'};
/* Diese Woche (Startseite): Was ist geschafft, was steht noch an? Pflicht zählt, Kür ist Bonus. Keine Kategorien-Soll mehr. */
function weekStrip(t){
  const wk = monday(t), days = Array.from({length:7}, (_,i) => addDays(wk, i)); let pf = 0, pfDone = 0; const typen = new Set(), offen = [];
  const cells = days.map(d => { const ss = visibleSessions(d).filter(s => s.typ !== 'frei');
    const extra = garminDone(d).filter(a => !ss.some(s => isDone(d, s) && (RING_TYP[s.typ] === RING_TYP[a.typ] || s.typ === a.typ)));
    ss.forEach(s => { typen.add(s.typ === 'gym' ? 'kraft' : s.typ); if(s.pflicht !== false){ pf++; if(isDone(d, s)) pfDone++; }
      if(!isDone(d, s) && d >= t) offen.push(`${WD[new Date(d+'T12:00').getDay()]} ${s.titel}`); });
    extra.forEach(a => typen.add(a.typ));
    const dots = ss.map(s => `<i class="t-${esc(s.typ)} ${isDone(d, s) ? 'f' : ''}"></i>`).join('') + extra.slice(0, 2).map(a => `<i class="t-${esc(a.typ)} f"></i>`).join('');
    return `<div class="${d === t ? 'today' : ''}"><b>${WD[new Date(d+'T12:00').getDay()]}</b><div class="dots">${dots}</div></div>`; }).join('');
  return `<div class="card">
    <div class="sh"><h3>Diese Woche</h3>${pf ? `<span><b class="pfz">${pfDone} von ${pf}</b> Pflicht geschafft${pfDone >= pf ? ' ✓' : ''}</span>` : ''}</div>
    <div class="wks">${cells}</div>
    <div class="wleg">${[...typen].map(x => `<span class="t-${esc(x)}"><i></i>${esc(TYPNAME[x] || x)}</span>`).join('')}<span class="hint"><i class="o"></i>geplant</span></div>
    ${offen.length ? `<p class="wnext"><span>Noch offen</span> ${offen.slice(0, 3).map(esc).join(' · ')}</p>` : pf ? `<p class="wnext">Alles für diese Woche erledigt.</p>` : ''}
    ${snackWoche(wk)}
  </div>`;
}
function sessionCard(d, s){
  if(s.typ === 'schwimmen') return swimCard(d, s);
  const done = isDone(d, s), chk = day(d).check || {}, hasSteps = (s.schritte||[]).length;
  const ist = done ? sollIstHTML(d, s) : '';
  const more = hasSteps || (s.details||[]).length || (s.uebungen||[]).length;
  return `<div class="card scard t-${s.typ}">
    <div class="sess"><div class="edge"></div><div style="flex:1;min-width:0;display:grid;gap:4px">
      <span class="meta">${esc(s.zeit || '')}${s.dauer ? ' · '+s.dauer+' min' : ''} · ${s.pflicht === false ? 'Kür' : 'Pflicht'}${done ? ' · <b class="okt">✓ erledigt</b>' : ''}</span>
      <h2>${esc(s.titel)}</h2>${s.art ? `<span class="mut">${esc(s.art)}</span>` : ''}
      ${hasSteps ? miniBlocks(s) : ''}
      ${s.zweck ? `<p class="zw">${esc(s.zweck)}</p>` : s.ziel ? `<p class="zw">${esc(s.ziel)}</p>` : ''}
    </div></div>
    ${ist ? `<details open><summary>Soll / Ist</summary>${ist}</details>` : ''}
    ${more && !ist ? `<details><summary>Aufbau & Details</summary>
      ${hasSteps ? workoutHTML(s) : ''}
      ${(s.uebungen||[]).length ? `<ul>${s.uebungen.map(u => `<li>${esc(u.name)} · ${u.saetze}×${u.wdh}${u.einheit === 's' ? ' s' : ''}</li>`).join('')}</ul>` : ''}
      ${(s.details||[]).length ? `<ul>${s.details.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${s.kurz ? `<div class="note"><b>Nur wenig Zeit?</b> ${esc(s.kurz)}</div>` : ''}</details>` : ''}
    <div class="btns">${(s.typ === 'kraft' || s.typ === 'gym') && (s.uebungen||[]).length ? `<button class="btn primary" data-go="${d}|${s.id}">Training starten</button>` : ''}
      <button class="btn" data-chk="${d}|${s.id}" aria-pressed="${!!chk[s.id]}">${chk[s.id] ? '✓ Erledigt' : 'Als erledigt markieren'}</button></div>
  </div>`;
}
function miniBlocks(s){
  const st = flatSteps(s.schritte), sec = st.reduce((a, x) => a + secOf(x), 0) || 1, W = 300, H = 40;
  let x = 0, r = '';
  st.forEach(y => { const w = secOf(y)/sec*W, z = zoneOf(y), h = 10 + z*5; r += `<rect x="${x+0.5}" y="${H-h}" width="${Math.max(1.2, w-1)}" height="${h}" rx="2" fill="${woFill(z)}"/>`; x += w; });
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${r}</svg>`;
}

/* ---------- SNACKS: Mobility, Breathwork, Meditation, Kette & Sehnen ----------
   S.tage[d].snacks = [{id,u,k}] · altes S.tage[d].mobility zählt als k:'mobility'. Liste änderbar über plan.snacks. */
const SNACKS_STD = [{id:'mobility', name:'Mobility'}, {id:'atem', name:'Breathwork'}, {id:'meditation', name:'Meditation'},
  {id:'achilles', name:'Achilles'}, {id:'po', name:'Po'}, {id:'hamstring', name:'Hamstring'}, {id:'beckenboden', name:'Beckenboden'}];
const snackListe = () => { const l = P().snacks; return Array.isArray(l) && l.length ? l.filter(x => x && x.id && x.name) : SNACKS_STD; };
function snacksOf(d){ const x = day(d); return [...(x.snacks || []), ...(x.mobility || []).map(m => ({...m, k:'mobility'}))]; }
function snackCard(t){
  const heute = snacksOf(t), n = k => heute.filter(x => x.k === k).length;
  return `<div class="card">
    <div class="sh"><h3>Snacks & Ruhe</h3>${heute.length ? `<button class="linkbtn" id="snundo">↶ letzten zurück</button>` : ''}</div>
    ${snackGruppen(t, n)}
    ${snackListe().some(x => (x.anleitung || []).length) ? `<details><summary>Anleitungen</summary><div class="anls">${snackListe().filter(x => (x.anleitung || []).length).map(x => `<details class="anl"><summary>${esc(x.name)}${x.dauer ? ` <span class="mut">· ${esc(x.dauer)}</span>` : ''}</summary>${x.hinweis ? `<p class="mut">${esc(x.hinweis)}</p>` : ''}<ol>${x.anleitung.map(u => `<li><b>${esc(u.name)}</b>${u.dauer ? ` <span class="mut">· ${esc(u.dauer)}</span>` : ''}${u.wie ? `<p>${esc(u.wie)}</p>` : ''}${u.warum ? `<p class="mut">${esc(u.warum)}</p>` : ''}</li>`).join('')}</ol></details>`).join('')}</div></details>` : ''}
  </div>`;
}
/* Gruppen: rhythmus 'tag' (Haken = heute gemacht) oder 'woche' (Zähler gegen soll, Reset montags). Ohne rhythmus → wie bisher eine Liste. */
function snackGruppen(t, n){
  const L = snackListe(), wk = monday(t), wn = k => { let c = 0; for(let i = 0; i < 7; i++) c += snacksOf(addDays(wk, i)).filter(x => x.k === k).length; return c; };
  const btn = x => { const w = x.rhythmus === 'woche', c = w ? wn(x.id) : n(x.id), voll = w && x.soll && c >= x.soll;
    return `<button class="pill snk" data-snack="${esc(x.id)}" aria-pressed="${w ? !!voll : c > 0}">${esc(x.name)}${w && x.soll ? ` <span class="cnt">${c}/${x.soll}</span>` : w && c ? ` <span class="cnt">${c}×</span>` : !w && c > 1 ? ` ${c}×` : ''}</button>`; };
  if(!L.some(x => x.rhythmus)) return `<div class="pills">${L.map(btn).join('')}</div>`;
  const tag = L.filter(x => x.rhythmus === 'tag'), woche = L.filter(x => x.rhythmus !== 'tag');
  return `<div class="pills">${tag.length ? `<span class="plbl">Täglich</span>${tag.map(btn).join('')}` : ''}${woche.length ? `<span class="plbl">Pro Woche</span>${woche.map(btn).join('')}` : ''}</div>`;
}
function snackWoche(wk){
  const c = {}; for(let i = 0; i < 7; i++) snacksOf(addDays(wk, i)).forEach(x => c[x.k] = (c[x.k] || 0) + 1);
  for(let i = 0; i < 7; i++) garminAll(addDays(wk, i)).forEach(a => { if(a.typ === 'atem' || a.typ === 'meditation') c[a.typ] = (c[a.typ] || 0) + 1; });
  const parts = snackListe().filter(x => c[x.id]).map(x => `${c[x.id]}× ${x.name}`);
  return parts.length ? `<p class="wnext"><span>Snacks</span> ${parts.map(esc).join(' · ')}</p>` : '';
}

/* ---------- SOLL / IST (wie TrainingPeaks) ----------
   Erledigte Einheit: Plan gegen Garmin. Läufe mit Kurve (erledigt[].serie, 30-s-Punkte) → Puls pro Abschnitt gegen den HF-Bereich. */
const pm = s => s ? `${Math.floor(s/60)}:${String(Math.round(s%60)).padStart(2,'0')}` : '–';
const toMin = z => { const m = /^(\d+):(\d+)/.exec(z || ''); return m ? +m[1]*60 + +m[2] : null; };
function matchGarmin(d, s){
  const t = RING_TYP[s.typ], c = garminDone(d).filter(a => s.typ === 'lauf' ? a.typ === 'lauf' : t === 'ausdauer' ? RING_TYP[a.typ] === 'ausdauer' : a.typ === s.typ);
  if(c.length < 2) return c[0] || null;
  const z = toMin(s.zeit); return z == null ? c[0] : c.slice().sort((a,b) => Math.abs(toMin(a.zeit)-z) - Math.abs(toMin(b.zeit)-z))[0];
}
function sollIstHTML(d, s){
  if(s.typ === 'kraft' || s.typ === 'gym') return kraftIst(d, s);
  const a = matchGarmin(d, s); if(!a) return '';
  const plan = (s.schritte||[]).length ? woStats(s) : {sec:(s.dauer||0)*60, km:0};
  const rows = [['Dauer', plan.sec ? Math.round(plan.sec/60)+' min' : '–', a.min+' min'], ['Distanz', plan.km ? '~'+fmt(Math.round(plan.km*10)/10)+' km' : '–', a.km ? fmt(a.km)+' km' : '–'],
    ['Ø Puls', (() => { const m = flatSteps(s.schritte).filter(x => x.hf).sort((p,q) => secOf(q) - secOf(p))[0]; return m ? m.hf.join('–') : ''; })(), a.hf ? Math.round(a.hf)+'' : '–']];
  if(a.pace) rows.push(['Tempo', '', pm(a.pace)+' /km']);
  let abschn = '', chart = '', fazit = '';
  const se = a.serie, st = flatSteps(s.schritte);
  if(se && se.hf && se.hf.length && st.length){
    // Abschnitte: Wiederholungen zusammenfassen
    const grp = []; let t0 = 0;
    (s.schritte).forEach(x => { if(x.wiederhole){ const sec = flatSteps([x]).reduce((q,y) => q + secOf(y), 0); grp.push({name:`${x.wiederhole}× ${ART[x.schritte[0].art] || x.schritte[0].art}`, t0, t1:t0+sec, hf:null}); t0 += sec; }
      else { const sec = secOf(x); grp.push({name:`${ART[x.art] || x.art} ${x.min ? x.min+' min' : x.sek+' s'}`, t0, t1:t0+sec, hf:x.hf}); t0 += sec; } });
    const at = (a0, a1) => se.hf.slice(Math.floor(a0/se.dt), Math.ceil(a1/se.dt)).filter(v => v);
    let inZ = 0, tot = 0;
    abschn = grp.map(g => { const v = at(g.t0, g.t1); if(!v.length) return `<tr><td>${esc(g.name)}</td><td>${g.hf ? g.hf.join('–') : ''}</td><td class="mut">nicht gelaufen</td></tr>`;
      const avg = Math.round(v.reduce((q,y) => q+y, 0)/v.length);
      let mark = '';
      if(g.hf){ const ok = v.filter(y => y >= g.hf[0] && y <= g.hf[1]).length; inZ += ok; tot += v.length; mark = avg > g.hf[1] ? '↑' : avg < g.hf[0] ? '↓' : '✓'; }
      return `<tr><td>${esc(g.name)}</td><td>${g.hf ? g.hf.join('–') : ''}</td><td><b>${avg}</b> <span class="mk">${mark}</span></td></tr>`; }).join('');
    abschn = `<table class="si"><tr><th>Abschnitt</th><th>Soll</th><th>Ist</th></tr>${abschn}</table>`;
    chart = istChart(se, grp, Math.max(t0, se.hf.length*se.dt));
    if(tot) fazit = `${Math.round(inZ/tot*100)} % der Zeit im Zielbereich.`;
  }
  if(a.hf && a.pace && s.typ === 'lauf') fazit += ` ${(Math.round(a.hf*a.pace/60)).toLocaleString('de-DE')} Herzschläge pro km.`;
  return `<div class="soll-ist">
    ${fazit ? `<p class="fz">${esc(fazit.trim())}</p>` : ''}
    <table class="si"><tr><th></th><th>Soll</th><th>Ist</th></tr>${rows.map(r => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td><td><b>${esc(r[2])}</b></td></tr>`).join('')}</table>
    ${chart}${abschn}</div>`;
}
function istChart(se, grp, T){
  const W = 340, H = 120, v = se.hf.filter(x => x), bands = grp.filter(g => g.hf).flatMap(g => g.hf);
  const lo = Math.min(...v, ...bands) - 5, hi = Math.max(...v, ...bands) + 5, x = t => t/T*W, y = h => 6 + (hi-h)/(hi-lo)*(H-26);
  let s = '';
  grp.forEach(g => { if(g.hf) s += `<rect x="${x(g.t0)}" y="${y(g.hf[1])}" width="${Math.max(1, x(g.t1)-x(g.t0))}" height="${y(g.hf[0])-y(g.hf[1])}" fill="color-mix(in srgb,var(--c-kraft) 22%,var(--surface))"/>`; });
  let path = '', pen = false;
  se.hf.forEach((h, i) => { if(h){ path += `${pen ? 'L' : 'M'}${x(i*se.dt + se.dt/2).toFixed(1)},${y(h).toFixed(1)} `; pen = true; } else pen = false; });
  s += `<path d="${path}" fill="none" stroke="var(--c-lauf)" stroke-width="2" stroke-linejoin="round"/>`;
  s += `<text x="0" y="${H-4}">0</text><text x="${W}" y="${H-4}" text-anchor="end">${Math.round(T/60)} min</text>`;
  return `<svg class="schart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Puls gegen Zielbereich">${s}</svg><p class="leg"><i style="background:color-mix(in srgb,var(--c-kraft) 30%,var(--surface))"></i>Zielbereich <i style="background:var(--c-lauf)"></i>dein Puls</p>`;
}
function kraftIst(d, s){
  const logs = S.kraft.filter(k => k.datum === d && (k.saetze||[]).some(x => x.ok));
  const rows = (s.uebungen || []).map(u => { const k = logs.find(k => k.uebung === u.id && (k.session === s.id || !k.session)) || logs.find(k => k.uebung === u.id);
    const ok = k ? k.saetze.filter(x => x.ok) : [];
    const ist = ok.length ? `${ok.length}×${ok.map(x => x.wdh).filter((v,i,a) => a.indexOf(v) === i).join('/')}${u.einheit === 's' ? ' s' : ''}${Math.max(...ok.map(x => x.kg || 0)) ? ' · ' + fmt(Math.max(...ok.map(x => x.kg || 0))) + ' kg' : ''}` : '–';
    return `<tr><td>${esc(u.name)}</td><td>${u.saetze}×${u.wdh}${u.einheit === 's' ? ' s' : ''}</td><td><b>${ist}</b></td></tr>`; }).join('');
  const extra = logs.filter(k => !(s.uebungen || []).some(u => u.id === k.uebung));
  return `<div class="soll-ist"><table class="si"><tr><th>Übung</th><th>Soll</th><th>Ist</th></tr>${rows}</table>${extra.length ? `<p class="mut">Zusätzlich: ${extra.map(k => esc(k.name)).join(', ')}</p>` : ''}</div>`;
}
/* Schwimmen: Training macht die Trainerin → kein Plan, nur Ist + Tagebuch */
function swimBody(d, s){
  const a = matchGarmin(d, s), ns = (day(d).notizen || []).slice().sort((x,y) => x.u - y.u);
  return `${a ? `<table class="si"><tr><td>Dauer</td><td><b>${a.min} min</b></td></tr>${a.km ? `<tr><td>Distanz</td><td><b>${fmt(a.km)} km</b></td></tr>` : ''}${a.hf ? `<tr><td>Ø Puls</td><td><b>${Math.round(a.hf)}</b></td></tr>` : ''}</table>` : `<p class="mut">Training mit deiner Trainerin.</p>`}
    ${ns.length ? `<div class="notes">${ns.map(n => `<p><span class="mut">${zeit(n.u)}</span> ${esc(n.text)}</p>`).join('')}</div>` : ''}
    <button class="btn" data-goto="buch">${ns.length ? 'Im Tagebuch ergänzen' : 'Im Tagebuch festhalten, was ihr gemacht habt'}</button>`;
}
function swimCard(d, s){
  return `<div class="card scard t-schwimmen"><div class="sess"><div class="edge"></div><div style="flex:1;min-width:0;display:grid;gap:4px">
    <span class="meta">${esc(s.zeit || '')}${s.dauer ? ' · '+s.dauer+' min' : ''} · ${s.pflicht === false ? 'Kür' : 'Pflicht'}${isDone(d, s) ? ' · <b class="okt">✓ erledigt</b>' : ''}</span>
    <h2>${esc(s.titel)}</h2></div></div>${swimBody(d, s)}</div>`;
}

/* ---------- GESCHICHTE: Muster aus Garmin + Oura + Tagebuch, von Claude in plan.geschichte gepflegt ----------
   geschichte = {hero:{kick,titel,text}, stories:[{kick,badge,big,bigEinheit,titel,text,chart,tip:[label,text]}], vorhersagen:[{text,status:offen|ja|nein}]}
   chart = {typ:'linie', farbe, punkte:[[label,wert,zeigen?]]} | {typ:'balken', farbe, balken:[[zeile1,zeile2,wert,hervor 0|1|2]]} | {typ:'vergleich', einheit, zeilen:[[label,wert,farbe]]} */
const CF = f => `var(--c-${({lauf:'lauf',kraft:'kraft',schwimmen:'schwimmen',wasser:'schwimmen'})[f] || 'kraft'})`;
function storyChart(c){
  if(!c) return '';
  const nf = v => String(v).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if(c.typ === 'linie' && (c.punkte||[]).length > 1){
    const P2 = c.punkte, W = 340, H = 130, v = P2.map(p => +p[1]), lo = Math.min(...v), hi = Math.max(...v), r = (hi-lo) || 1;
    const x = i => 12 + i*(W-24)/(P2.length-1), y = q => 16 + (hi-q)/r*(H-44);
    let s = `<line x1="0" x2="${W}" y1="${H-22}" y2="${H-22}" stroke="var(--line)"/>`;
    s += `<polyline fill="none" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${P2.map((p,i) => x(i)+','+y(+p[1])).join(' ')}"/>`;
    P2.forEach((p,i) => { const last = i === P2.length-1, first = i === 0;
      if(first || last) s += `<circle cx="${x(i)}" cy="${y(+p[1])}" r="${last ? 5 : 4}" fill="${last ? CF(c.farbe) : 'var(--ink)'}"/><text x="${x(i)}" y="${y(+p[1]) + (y(+p[1]) < 30 ? 18 : -10)}" text-anchor="${first ? 'start' : 'end'}">${nf(p[1])}</text>`;
      if(first || last || p[2]) s += `<text x="${x(i)}" y="${H-6}" text-anchor="${first ? 'start' : last ? 'end' : 'middle'}">${esc(p[0])}</text>`; });
    return `<svg class="schart" viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
  }
  if(c.typ === 'balken' && (c.balken||[]).length){
    const B = c.balken, W = 340, H = 150, n = B.length, gw = W/n, bw = gw - 10, mx = Math.max(...B.map(b => +b[2])) || 1;
    let s = `<line x1="0" x2="${W}" y1="118" y2="118" stroke="var(--line)"/>`;
    B.forEach((b,i) => { const h = (+b[2]/mx)*92, x0 = i*gw + 5, f = b[3] ? `color-mix(in srgb,${CF(c.farbe)} ${b[3] === 1 ? 100 : 55}%,var(--surface))` : 'var(--chip2)';
      s += `<rect x="${x0}" y="${118-h}" width="${bw}" height="${h}" rx="4" fill="${f}"/><text x="${x0+bw/2}" y="${112-h}" text-anchor="middle" class="${b[3] ? 'hi' : ''}">${nf(b[2])}</text><text x="${x0}" y="134">${esc(b[0])}</text><text x="${x0}" y="146">${esc(b[1] || '')}</text>`; });
    return `<svg class="schart" viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
  }
  if(c.typ === 'vergleich' && (c.zeilen||[]).length){
    const Z = c.zeilen, W = 340, mx = Math.max(...Z.map(z => +z[1])) || 1, H = Z.length*34 + 18;
    let s = '';
    Z.forEach((z,i) => { const w = (+z[1]/mx)*240, y0 = i*34 + 4;
      s += `<text x="0" y="${y0+12}">${esc(z[0])}</text><rect x="92" y="${y0}" width="${w}" height="16" rx="4" fill="${CF(z[2])}"/><text x="${92+w-6}" y="${y0+12}" text-anchor="end" class="in">${nf(z[1])}</text>`; });
    if(c.einheit) s += `<text x="92" y="${H-2}">${esc(c.einheit)}</text>`;
    return `<svg class="schart" viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
  }
  return '';
}
function geschichteHTML(){
  const g = P().geschichte; if(!g) return '';
  const V = {offen:'◯', ja:'✓', nein:'✕'};
  return `${g.hero ? `<div class="hx">${g.hero.kick ? `<span class="kick">${esc(g.hero.kick)}</span>` : ''}<h1 class="hx-satz">${esc(g.hero.titel)}</h1>${g.hero.text ? `<p class="hx-sub">${esc(g.hero.text)}</p>` : ''}</div>` : ''}
    ${(g.stories || []).map(x => `<div class="card story">
      <span class="kick">${esc(x.kick || '')}${x.badge ? ` <span class="badge">${esc(x.badge)}</span>` : ''}</span>
      ${x.big ? `<div class="sbig num">${esc(x.big)}<small>${esc(x.bigEinheit || '')}</small></div>` : ''}
      <h2>${esc(x.titel)}</h2>${x.text ? `<p>${esc(x.text)}</p>` : ''}
      ${storyChart(x.chart)}
      ${x.tip ? `<p class="tip"><b>${esc(x.tip[0])}</b> ${esc(x.tip[1])}</p>` : ''}</div>`).join('')}
    ${g.tests && (g.tests.items || []).length ? `<div class="card story"><span class="kick">Stark mit 80</span><h2>${esc(g.tests.titel || 'Deine Tests alle 3 Monate')}</h2>${g.tests.text ? `<p>${esc(g.tests.text)}</p>` : ''}
      <div class="tests">${g.tests.items.map(x => { const w = x.werte || [], l = w[w.length-1], v = w.length > 1 ? w[w.length-2] : null;
        return `<div class="trow"><div><b>${esc(x.name)}</b>${x.ziel ? `<span>Ziel ${esc(x.ziel)}</span>` : ''}</div><div class="tv">${l ? esc(l[1]) : '–'}${v ? `<span>vorher ${esc(v[1])}</span>` : ''}</div></div>`; }).join('')}</div>
      ${g.tests.termin ? `<p class="tip"><b>Nächster Test:</b> ${esc(g.tests.termin)}</p>` : ''}</div>` : ''}
    ${(g.vorhersagen || []).length ? `<div class="card story"><span class="kick">Offene Vorhersagen</span><h2>Ich wette mit deinem Körper.</h2>
      <p>Jede Vorhersage wird aufgelöst, wenn die Daten da sind.</p>
      <div class="vh">${g.vorhersagen.map(v => `<p class="${esc(v.status || 'offen')}"><span>${V[v.status] || '◯'}</span>${esc(v.text)}<em>${v.status === 'ja' ? 'eingetroffen' : v.status === 'nein' ? 'nicht eingetroffen' : 'offen'}</em></p>`).join('')}</div></div>` : ''}`;
}

/* ---------- WOCHE / BERICHT ---------- */
/* Woche (Redesign 08.10.2026): Überblick zuerst. Datum über jedem Tag, Einheiten als ruhige Zeilen, Details klappen direkt
   unter der angetippten Einheit auf. Wochenbericht + Phase unten, Bericht nur für genau diese Woche (kein Vorwochen-Fallback). */
function sesDetail(d, sel){
  if(sel.typ === 'schwimmen') return `<div class="det">${swimBody(d, sel)}</div>`;
  if(isDone(d, sel)){ const ist = sollIstHTML(d, sel); if(ist) return `<div class="det">${ist}</div>`; }
  return `<div class="det">${workoutHTML(sel)}${sel.ziel && !(sel.schritte||[]).length ? `<p>${esc(sel.ziel)}</p>` : ''}${sel.zweck && !(sel.schritte||[]).length ? `<div class="wo-ziel"><span class="lbl">Ziel</span><span>${esc(sel.zweck)}</span>${sel.zahltEin ? `<span class="mut">Zahlt ein auf: ${esc(sel.zahltEin)}</span>` : ''}</div>` : ''}${(sel.details||[]).length ? `<ul>${sel.details.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${(sel.uebungen||[]).length ? `<ul>${sel.uebungen.map(u => `<li>${esc(u.name)} · ${u.saetze}×${u.wdh}${u.einheit === 's' ? ' s' : ''}</li>`).join('')}</ul>` : ''}${sel.kurz ? `<div class="note"><b>Nur wenig Zeit?</b> ${esc(sel.kurz)}</div>` : ''}</div>`;
}
function viewWoche(){
  const wk = addDays(monday(TODAY()), weekOff*7), t = TODAY();
  const br = (P().bericht || {})[wk];
  const days = Array.from({length:7}, (_,i) => addDays(wk, i));
  const gd = (P().wochenGedanke || {})[wk];
  const list = days.map(d => { const ss = visibleSessions(d);
    const extra = garminDone(d).filter(a => !ss.some(s => s.typ !== 'frei' && isDone(d, s) && (RING_TYP[s.typ] === RING_TYP[a.typ] || s.typ === a.typ)));
    const kurz = garminAll(d).filter(a => (a.min || 0) < MIN_EINHEIT);
    const rows = ss.filter(s => s.typ !== 'frei').map(s => { const dn = isDone(d, s), open = selDay === d && selSes === s.id;
      return `<button class="wrow t-${s.typ} ${dn ? 'done' : ''}" data-sel="${d}|${s.id}" aria-expanded="${open}"><i></i><span class="wt">${esc(s.titel)}<small>${esc(s.zeit || '')}${s.dauer ? ' · '+s.dauer+' min' : ''}${s.pflicht === false ? ' · Kür' : ''}</small></span><span class="ws">${dn ? '✓' : ''}</span></button>${open ? sesDetail(d, s) : ''}`; }).join('');
    const ex = extra.map(a => `<div class="wrow t-${a.typ} done extra"><i></i><span class="wt">${esc(a.name)}<small>${esc(a.zeit || '')} · ${a.min} min${a.km && a.typ !== 'schwimmen' ? ' · '+fmt(a.km)+' km' : ''} · ohne Plan</small></span><span class="ws">✓</span></div>`).join('');
    const fr = ss.find(s => s.typ === 'frei');
    const leer = !rows && !ex ? `<p class="wfrei">${fr ? esc(fr.titel) : 'frei'}</p>` : '';
    return `<section class="wday ${d === t ? 'today' : ''} ${d < t ? 'past' : ''}"><h4>${d === t ? 'Heute · ' : ''}${dayLabel(d)}</h4>${rows}${ex}${leer}${kurz.length ? `<p class="wkurz">${kurz.map(a => `${esc(a.name)} ${a.min} min`).join(' · ')}</p>` : ''}</section>`; }).join('');
  return `<div class="stack narrow" style="margin:0 auto">
    <div class="card">
      <div class="wnav"><button class="btn small" id="wprev" aria-label="Woche zurück">←</button><h2>${shortRange(wk)}</h2><button class="btn small" id="wnext" aria-label="Woche vor">→</button></div>
    </div>
    ${gd ? `<div class="card ins"><span class="kick">${esc(gd.kick || 'Gedanke der Woche')}</span><h2>${esc(gd.titel)}</h2>${gd.text ? `<p>${esc(gd.text)}</p>` : ''}</div>` : ''}
    <div class="card wlist">${list}
      <div class="row" style="margin-top:6px"><span class="mut">Kür fällt in vollen Wochen weg.</span><button class="btn small" id="voll" aria-pressed="${!!S.vollWoche[wk]}">Volle Woche</button></div>
      ${S.vollWoche[wk] ? `<div class="note">Volle Woche: nur Pflicht. Alles Wichtige ist drin, nichts gilt als verpasst.</div>` : ''}
    </div>
    ${br ? `<div class="card"><span class="kick">${esc(br.label || 'Wochenbericht')}</span><h2 style="font-size:1.2rem">${esc(br.titel)}</h2><p class="mut">${esc(br.text)}</p></div>` : ''}
    ${(P().phasen || []).length ? `<div class="card"><span class="kick">Phase</span>${phaseHTML()}</div>` : ''}
  </div>`;
}
function liftsHTML(){
  const ids = [...new Set(S.kraft.filter(k => (k.saetze||[]).some(x => x.ok) && k.einheit !== 's').map(k => k.uebung))];
  if(!ids.length) return `<p class="mut">Sobald du im Gym Gewichte einträgst, siehst du hier pro Übung deine Kurve.</p>`;
  return `<div class="lifts">${ids.map(id => {
    const h = history(id), vals = h.map(k => Math.max(...k.saetze.filter(x => x.ok).map(x => k.einheit === 'kg' ? x.kg : x.wdh)));
    const first = vals[0], last = vals[vals.length-1], g = first ? Math.round((last/first - 1)*100) : 0;
    return `<div class="lift"><span class="lbl">${esc(h[h.length-1].name)}</span><div class="row"><span class="num" style="font-weight:600;font-size:1.1rem">${fmt(last)} ${h[0].einheit === 'kg' ? 'kg' : 'Wdh'}</span>${vals.length > 1 ? `<span class="lbl" style="color:var(--good)">${g >= 0 ? '+' : ''}${g} %</span>` : ''}</div>${spark(vals)}<span class="mut" style="font-size:.78rem">${vals.length}× trainiert</span></div>`;
  }).join('')}</div>`;
}

/* ---------- KRAFT ---------- */
function kraftOptions(){
  const t = TODAY(), out = [];
  for(let i = -1; i < 7; i++){ const d = addDays(t, i); sessions(d).forEach(s => { if((s.typ === 'kraft' || s.typ === 'gym') && (s.uebungen||[]).length) out.push({d, s}); }); }
  const g = P().gymVorlage; if(g && g.length) out.push({d:t, s:{id:'gym-'+t, titel:'Gym · Full Body', typ:'gym', uebungen:g, frei:true}});
  return out;
}
/* Kraft (Redesign 08.10.2026): dunkler Kopf mit Fortschritt, Einheiten als Chips statt Dropdown,
   Übungskarten mit Nummer + Ziel-Chip + Vorschlag; fertige Übungen klappen zu einer Zeile zusammen. */
let kraftOpen = new Set();
function kraftEntry(t, cur, u){ return S.kraft.find(k => k.datum === t && k.session === cur.s.id && k.uebung === u.id); }
function kraftFortschritt(cur){
  let best = null;
  cur.s.uebungen.forEach(u => { const h = history(u.id); if(h.length < 2) return;
    const v = k => Math.max(...k.saetze.filter(x => x.ok).map(x => u.einheit === 'kg' ? (x.kg || 0) : (x.wdh || 0)));
    const a = v(h[0]), b = v(h[h.length-1]); if(a > 0 && b > a){ const g = Math.round((b/a - 1)*100); if(!best || g > best.g) best = {g, u, a, b}; } });
  if(!best) return null;
  const e = best.u.einheit === 'kg' ? ' kg' : best.u.einheit === 's' ? ' s' : ' Wdh';
  return `${best.u.name}: ${fmt(best.a)} → ${fmt(best.b)}${e} seit dem ersten Mal (+${best.g} %).`;
}
function viewKraft(){
  const opts = kraftOptions(), t = TODAY();
  if(!kraftSel){ const o = opts.find(o => o.d === t && !o.s.frei) || opts.find(o => o.d >= t && !o.s.frei) || opts.find(o => o.s.frei) || opts[0]; kraftSel = o ? o.d+'|'+o.s.id : null; }
  const cur = opts.find(o => o.d+'|'+o.s.id === kraftSel) || opts[0];
  const diktate = S.kraft.filter(k => k.datum === t && k.quelle === 'diktat');
  const chips = `<div class="kchips">${opts.map(o => { const k = o.d+'|'+o.s.id, on = cur && k === cur.d+'|'+cur.s.id;
    return `<button class="kchip ${on ? 'on' : ''}" data-ksel="${k}"><small>${o.s.frei ? 'jederzeit' : o.d === t ? 'heute' : dayLabel(o.d)}</small>${esc(o.s.titel)}</button>`; }).join('')}</div>`;
  if(!cur) return `<div class="stack narrow" style="margin:0 auto">${chips}<div class="card"><p>Diese Woche steht keine Krafteinheit an.</p></div>${diktatCard(diktate)}</div>`;
  const U = cur.s.uebungen, fertig = U.filter(u => { const e = kraftEntry(t, cur, u); return e && e.saetze.length && e.saetze.every(x => x.ok); }).length;
  const erst = U.some(u => u.einheit === 'kg' && !suggestion(u).last), fs = kraftFortschritt(cur);
  return `<div class="stack narrow" style="margin:0 auto">
    ${chips}
    <div class="hx">
      <span class="kick">${cur.s.frei ? 'Gym' : cur.d === t ? 'Kraft heute' : 'Kraft · geplant ' + dayLabel(cur.d)}</span>
      <h1 class="hx-satz">${esc(cur.s.titel)}</h1>
      <p class="hx-sub">${[cur.s.art, cur.s.dauer ? cur.s.dauer + ' min' : '', cur.s.ziel].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="kprog"><div class="bar"><b style="width:${U.length ? fertig/U.length*100 : 0}%"></b></div><span><b>${fertig}</b> von ${U.length} Übungen</span></div>
      ${fs ? `<p class="kfs">↗ ${esc(fs)}</p>` : erst ? `<p class="kfs">Erstes Mal: Gewicht so wählen, dass sich der letzte Satz wie 7 von 10 anfühlt.</p>` : cur.s.zweck ? `<p class="hx-sub">${esc(cur.s.zweck)}</p>` : ''}
      ${cur.d !== t && !cur.s.frei ? `<p class="hx-sub">Einträge zählen für heute.</p>` : ''}
    </div>
    <div id="timer"></div>
    ${U.map((u, ui) => { const sg = suggestion(u), e = kraftEntry(t, cur, u); const saetze = e ? e.saetze : Array.from({length:u.saetze}, () => ({kg:sg.kg, wdh:sg.wdh, ok:false}));
      const kgU = u.einheit === 'kg', unit = u.einheit === 's' ? ' s' : '', done = e && e.saetze.length && e.saetze.every(x => x.ok);
      if(done && !kraftOpen.has(ui)){ const mx = Math.max(...e.saetze.map(x => x.kg || 0));
        return `<button class="card exdone" data-kopen="${ui}"><span class="exn">✓</span><span><b>${esc(u.name)}</b><small>${e.saetze.length}×${[...new Set(e.saetze.map(x => x.wdh))].join('/')}${unit}${mx ? ' · ' + fmt(mx) + ' kg' : ''}${e.pr ? ' · Bestleistung!' : ''}</small></span><span class="mut">ändern</span></button>`; }
      const cols = `28px ${kgU ? 'minmax(0,1.5fr) ' : ''}minmax(0,1fr) 48px`;
      return `<div class="card ex">
        <div class="exh"><span class="exn">${ui+1}</span><div><b>${esc(u.name)}</b>${u.hinweis ? `<span class="mut">${esc(u.hinweis)}</span>` : ''}</div><span class="tgt">${u.saetze}×${u.wdh}${unit}</span></div>
        ${sg.last ? `<div class="sg"><b>${esc(sg.text)}</b><span>${esc(sg.last)}</span></div>` : ''}
        ${infoHTML(u)}
        <div class="sethead" style="grid-template-columns:${cols}"><span>Satz</span>${kgU ? '<span>kg</span>' : ''}<span>${u.einheit === 's' ? 'Sekunden' : 'Wdh'}</span><span></span></div>
        ${saetze.map((x, si) => `<div class="set ${x.ok ? 'ok-row' : ''}" style="grid-template-columns:${cols}"><span class="sn">${si+1}</span>
          ${kgU ? `<div class="stp"><button data-st="${ui}|${si}|kg|-1" aria-label="weniger kg">−</button><input class="kgin" data-kg="${ui}|${si}" inputmode="decimal" value="${x.kg ? fmt(x.kg) : ''}" placeholder="kg" aria-label="Satz ${si+1} kg"><button data-st="${ui}|${si}|kg|1" aria-label="mehr kg">+</button></div>` : ''}
          <div class="stp"><button data-st="${ui}|${si}|wdh|-1" aria-label="weniger">−</button><span>${x.wdh}${unit}</span><button data-st="${ui}|${si}|wdh|1" aria-label="mehr">+</button></div>
          <button class="ok" data-ok="${ui}|${si}" aria-pressed="${!!x.ok}" aria-label="Satz erledigt">✓</button></div>`).join('')}
        ${e && e.pr ? `<div class="pr">Neue Bestleistung: ${fmt(e.pr)} kg</div>` : ''}
        ${done ? `<button class="linkbtn" data-kopen="${ui}">zuklappen</button>` : ''}
      </div>`; }).join('')}
    ${diktatCard(diktate)}
  </div>`;
}
function diktatCard(diktate){
  return `<div class="card"><div class="sh"><h3>Noch was gemacht?</h3></div>
      <span class="mut">Einfach diktieren, z. B. „3×12 Face Pulls mit 15 kg, 10 min Rudergerät“.</span>
      <textarea id="dik" aria-label="Zusätzliche Übungen diktieren"></textarea>
      <button class="btn primary" id="dikok">Übernehmen</button>
      ${diktate.length ? `<span class="lbl">Heute zusätzlich</span>${diktate.map(k => `<div class="row"><b>${esc(k.name)}</b><span class="num">${k.min ? k.min+' min' : k.unklar ? 'ordne ich abends ein' : `${k.saetze.length}×${k.saetze[0].wdh}${k.saetze[0].kg ? ' · '+fmt(k.saetze[0].kg)+' kg' : ''}`} <button class="btn small" data-kdel="${k.id}" aria-label="entfernen">✕</button></span></div>`).join('')}` : ''}
    </div>`;
}
function infoHTML(u){
  const i = (P().uebungsInfo || {})[u.id] || u.info; if(!i) return '';
  const q = encodeURIComponent((i.suche || u.name) + ' Übung Ausführung');
  return `<details><summary>Wie geht das?</summary><div class="info">
    ${i.wie ? `<p>${esc(i.wie)}</p>` : ''}${i.muskeln ? `<p><b>Trainiert:</b> ${esc(i.muskeln)}</p>` : ''}${i.warum ? `<p><b>Warum für dich:</b> ${esc(i.warum)}</p>` : ''}
    <a href="https://www.youtube.com/results?search_query=${q}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:700">Video ansehen ↗</a></div></details>`;
}
function currentKraft(){ const opts = kraftOptions(); return opts.find(o => o.d+'|'+o.s.id === kraftSel) || opts[0]; }
function startRest(sec){
  clearInterval(restTimer); let s = sec; const draw = () => { const el = $('#timer'); if(el) el.innerHTML = s > 0 ? `<div class="timer"><span>Pause</span><span class="num">${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}</span></div>` : `<div class="timer"><span>Nächster Satz</span><span>los</span></div>`; };
  draw(); restTimer = setInterval(() => { s--; draw(); if(s <= 0){ clearInterval(restTimer); setTimeout(() => { const el = $('#timer'); if(el) el.innerHTML = ''; }, 4000); } }, 1000);
}

/* ---------- TAGEBUCH ---------- */
/* Tagebuch: mehrere Einträge pro Tag (S.tage[d].notizen = [{id,u,text}]); Energie/Stimmung einmal pro Tag */
function migrateNotizen(){
  let changed = false;
  Object.entries(S.tage).forEach(([d, x]) => { const tb = x.tagebuch;
    if(tb && tb.text){ (x.notizen = x.notizen || []).push({id:'alt-'+d, u:tb.u || now(), text:tb.text}); tb.text = ''; tb.u = now(); changed = true; } });
  if(changed) save();
}
const zeit = u => new Date(u).toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'});
function viewBuch(){
  migrateNotizen();
  const t = TODAY(), b = day(t).tagebuch || {}, heute = (day(t).notizen || []).slice().sort((a,b) => a.u - b.u);
  const E = ['leer','müde','okay','gut','voll da'], M = ['mies','gedrückt','okay','gut','super'];
  const past = Object.keys(S.tage).filter(d => d < t && (((S.tage[d].notizen || []).length) || (S.tage[d].tagebuch && S.tage[d].tagebuch.energie))).sort().reverse().slice(0, 7);
  return `<div class="stack narrow" style="margin:0 auto">
    <div class="card"><span class="lbl">${esc(longDate(t))}</span>
      <b>Energie</b><div class="scale">${E.map((w,i) => `<button data-mo="energie|${i+1}" aria-pressed="${b.energie === i+1}">${w}</button>`).join('')}</div>
      <b>Stimmung</b><div class="scale">${M.map((w,i) => `<button data-mo="stimmung|${i+1}" aria-pressed="${b.stimmung === i+1}">${w}</button>`).join('')}</div></div>
    <div class="card"><label for="tx" class="lbl">Neuer Eintrag <span class="mut" style="font-weight:400">(tippen oder diktieren)</span></label>
      <textarea id="tx" placeholder="Wie geht's dir gerade? Zwickt etwas, schreib es einfach dazu."></textarea>
      <button class="btn primary" id="txok">Speichern</button>
      ${heute.length ? `<div class="notes">${heute.map(n => `<div class="note-item"><span class="lbl">${zeit(n.u)}</span><p>${esc(n.text)}</p><button class="btn small" data-ndel="${esc(n.id)}" aria-label="Eintrag löschen">✕</button></div>`).join('')}</div>` : ''}</div>
    ${past.length ? `<div class="card"><span class="lbl">Letzte Tage</span>${past.map(d => { const x = S.tage[d], tb = x.tagebuch || {}, ns = (x.notizen || []).slice().sort((a,b) => a.u - b.u);
        return `<div class="past"><b>${dayLabel(d)}</b> ${tb.energie ? `<span class="mut">Energie ${E[tb.energie-1]}${tb.stimmung ? ', Stimmung '+M[tb.stimmung-1] : ''}</span>` : ''}${ns.map(n => `<p><span class="mut">${zeit(n.u)}</span> ${esc(n.text)}</p>`).join('')}</div>`; }).join('')}</div>` : ''}
  </div>`;
}

/* ---------- FORTSCHRITT ---------- */
function viewBesser(){
  const f = P().fortschritt || {};
  return `<div class="stack narrow" style="margin:0 auto">

    ${geschichteHTML()}
    <span class="lbl" style="margin-top:6px">Deine Zahlen</span>
    ${(f.karten || []).map(k => `<div class="card"><span class="lbl">${esc(k.label)}</span><div class="row"><span class="big num">${esc(k.wert)}</span><span class="mut">${esc(k.vergleich || '')}</span></div>${k.id === 'tempo' ? tempoChart(340, 150) : ''}${k.text ? `<p class="mut">${esc(k.text)}</p>` : ''}</div>`).join('')}
    <div class="card"><span class="lbl">Kraft</span>${liftsHTML()}</div>
    ${(f.belastbarkeit || []).length ? `<div class="card"><span class="lbl">Belastbarkeit</span><p>Wie viel Training dein Körper gewohnt ist. ${esc(f.belastSatz || '')}</p>${belastChart(440, 210)}</div>` : ''}
    <div class="card"><span class="lbl">Meilensteine</span><div class="ms">${(P().meilensteine || []).map(([d,x]) => `<div class="msi"><span class="num">${esc(d)}</span><span>${esc(x)}</span></div>`).join('')}</div></div>
  </div>`;
}

/* ================= Interaktion ================= */
function bind(){
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { TAB = b.dataset.tab; lsSet(LS.tab, TAB); render(); scrollTo(0,0); });
  const t = TODAY(), d = day(t);
  // Heute
  document.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { (d.wasser = d.wasser || []).push({id:uid(), u:now(), ml:+b.dataset.w}); save(); render(); });
  if($('#wundo')) $('#wundo').onclick = () => { const last = d.wasser.slice().sort((a,b) => a.u - b.u).pop(); forget(last.id); save(); render(); };
  document.querySelectorAll('[data-supp]').forEach(b => b.onclick = () => { const sp = d.supp = d.supp || {}; sp[b.dataset.supp] = sp[b.dataset.supp] ? 0 : now(); save(); render(); });
  document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { TAB = b.dataset.goto; lsSet(LS.tab, TAB); render(); scrollTo(0,0); });
  if($('#sm')) $('#sm').onchange = e => { (d.supp = d.supp || {}).morgen = e.target.checked ? now() : 0; save(); };
  if($('#sa')) $('#sa').onchange = e => { (d.supp = d.supp || {}).abend = e.target.checked ? now() : 0; save(); };
  document.querySelectorAll('[data-snack]').forEach(b => b.onclick = () => { (d.snacks = d.snacks || []).push({id:uid(), u:now(), k:b.dataset.snack}); save(); render(); });
  if($('#snundo')) $('#snundo').onclick = () => { const last = snacksOf(t).sort((a,b) => a.u - b.u).pop(); if(last){ forget(last.id); save(); render(); toast('Zurückgenommen'); } };
  if($('#mob')) $('#mob').onclick = () => { (d.mobility = d.mobility || []).push({id:uid(), u:now()}); save(); render(); toast('Mobility notiert'); };
  document.querySelectorAll('[data-chk]').forEach(b => b.onclick = () => { const [dd, id] = b.dataset.chk.split('|'); const c = day(dd).check = day(dd).check || {}; c[id] = c[id] ? 0 : now(); save(); render(); });
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { kraftSel = b.dataset.go; TAB = 'kraft'; lsSet(LS.tab, TAB); render(); scrollTo(0,0); });
  // Woche
  if($('#wprev')) $('#wprev').onclick = () => { weekOff--; render(); };
  if($('#wnext')) $('#wnext').onclick = () => { weekOff++; render(); };
  if($('#voll')) $('#voll').onclick = () => { const wk = addDays(monday(TODAY()), weekOff*7); S.vollWoche[wk] = !S.vollWoche[wk]; save(); render(); };
  document.querySelectorAll('[data-sel]').forEach(b => b.onclick = () => { const [dd, id] = b.dataset.sel.split('|'); if(selDay === dd && selSes === id){ selSes = null; } else { selDay = dd; selSes = id; } render(); });
  // Kraft
  document.querySelectorAll('[data-ksel]').forEach(b => b.onclick = () => { kraftSel = b.dataset.ksel; kraftOpen = new Set(); render(); });
  document.querySelectorAll('[data-kopen]').forEach(b => b.onclick = () => { const i = +b.dataset.kopen; kraftOpen.has(i) ? kraftOpen.delete(i) : kraftOpen.add(i); render(); });
  document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => {
    const [ui, si, f, dir] = b.dataset.st.split('|'), cur = currentKraft(), u = cur.s.uebungen[+ui], e = entryFor(t, cur.s.id, u), x = e.saetze[+si];
    if(f === 'kg') x.kg = Math.max(0, Math.round((x.kg + (+dir)*(u.step || 2.5))*100)/100);
    else x.wdh = Math.max(0, x.wdh + (+dir)*(u.einheit === 's' ? 5 : 1));
    // Folgesätze mitziehen, solange sie noch nicht abgehakt sind
    e.saetze.forEach((y, j) => { if(j > +si && !y.ok) y[f] = x[f]; });
    e.u = now(); save(); render();
  });
  document.querySelectorAll('[data-kg]').forEach(inp => inp.onchange = () => {
    const [ui, si] = inp.dataset.kg.split('|').map(Number), cur = currentKraft(), u = cur.s.uebungen[ui], e = entryFor(t, cur.s.id, u);
    const v = parseFloat(inp.value.replace(',', '.')); if(isNaN(v)) return;
    e.saetze[si].kg = v; e.saetze.forEach((y, j) => { if(j > si && !y.ok) y.kg = v; }); e.u = now(); save(); render();
  });
  document.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => {
    const [ui, si] = b.dataset.ok.split('|').map(Number), cur = currentKraft(), u = cur.s.uebungen[ui], e = entryFor(t, cur.s.id, u), x = e.saetze[si];
    x.ok = !x.ok; e.u = now();
    if(x.ok){
      if(u.einheit === 'kg'){ const best = bestKg(u.id, e.id); if(best && x.kg > best && (!e.pr || x.kg > e.pr)){ e.pr = x.kg; toast('Neue Bestleistung!'); } }
      startRest(u.pause || 90);
    }
    if(!cur.s.frei){ const c = day(t).check = day(t).check || {}; if(e.saetze.some(y => y.ok)) c[cur.s.id] = c[cur.s.id] || now(); }
    save(); render();
  });
  if($('#dikok')) $('#dikok').onclick = () => {
    const txt = $('#dik').value.trim(); if(!txt) return;
    parseDiktat(txt).forEach(p => S.kraft.push({id:uid(), u:now(), datum:t, session:null, quelle:'diktat', roh:txt, uebung:slug(p.name), name:p.name, einheit:p.kg ? 'kg' : 'wdh', min:p.min || null, unklar:!!p.unklar,
      saetze: p.saetze ? Array.from({length:p.saetze}, () => ({kg:p.kg || 0, wdh:p.wdh, ok:true})) : []}));
    save(); render(); toast('Übernommen');
  };
  document.querySelectorAll('[data-kdel]').forEach(b => b.onclick = () => { forget(b.dataset.kdel); save(); render(); });
  // Tagebuch
  document.querySelectorAll('[data-mo]').forEach(b => b.onclick = () => { const [k, v] = b.dataset.mo.split('|'); const tb = d.tagebuch = d.tagebuch || {}; tb[k] = +v; tb.u = now(); save(); render(); });
  if($('#txok')) $('#txok').onclick = () => { const txt = $('#tx').value.trim(); if(!txt) return; (d.notizen = d.notizen || []).push({id:uid(), u:now(), text:txt}); save(); render(); toast('Gespeichert'); };
  document.querySelectorAll('[data-ndel]').forEach(b => b.onclick = () => { forget(b.dataset.ndel); save(); render(); });
}


render();
loadPlan();
syncDown();
