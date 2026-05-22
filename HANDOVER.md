# Knee Strong PWA — Claude Code Handover

## Project Overview

Single-file HTML PWA for marathon training tracking. Built for Steffi Kieffer, 52, Berlin Marathon 27.09.2026. Knee diagnosis: Chondropathie Grad 2 lateral, Grad 3 retropatellar, lateral meniscus micro-tear, Quadriceps tendinosis, Patella lateralization.

**File:** `Krafttraining-PWA.html` (single file, ~1430 lines, no build step)  
**Hosted:** GitHub Pages (or Netlify Drop)  
**Storage:** `localStorage` key `knee-strong-v2`

---

## App Architecture

### 4 Tabs
- **Heute** — daily view with task checklist, navigation, Oura check-in
- **Woche** — weekly overview, clickable days → navigate to that day
- **Körper** — coverage analytics per problem zone
- **Wissen** — two sub-tabs: Übungen (exercise guides) + Warum (problem→exercise mapping)

### State (localStorage `knee-strong-v2`)
```js
{
  completedTasks:  { 'YYYY-MM-DD': { 'task-id': true } },
  skippedTasks:    { 'YYYY-MM-DD': { 'task-id': true } },
  dayOverrides:    { 'YYYY-MM-DD': dayOfWeek_int },      // unused now, kept for compat
  extraDays:       { 'YYYY-MM-DD': [dayOfWeek_int] },
  suggestedTasks:  { 'YYYY-MM-DD': [{id, name, duration, tier, problems}] },
  customSessions:  { 'YYYY-MM-DD': [{id, type, label, tier}] },
  ouraScores:      { 'YYYY-MM-DD': 'good'|'okay'|'bad' },
  mondayIsRegen:   { 'YYYY-MM-DD': true|false },
}
```

### Key Global Variable (NOT persisted)
```js
let viewingDate = null; // null = today, else 'YYYY-MM-DD'
```
`getViewingDate()` returns the currently viewed day. All render functions use this for navigation through the week.

---

## Data Structures

### TASKS (41 total)
Day-indexed array. `day` is JS `Date.getDay()` int (0=Sun, 1=Mon…) or `'daily'`.

```js
{ id:'mo-sideplank', day:1, tier:'pflicht', name:'Side Plank',
  duration:'3 min · 2×30s', trigger:'nach Kraft',
  why:'Vom Orthopäden...', problems:['patella','knie','stabilitaet'] }
```

**Tier hierarchy:**
- `pflicht` — always shown, must-do (shown in black)
- `standard` — shown if week is normal (green)
- `bonus` — extra if motivated (amber)
- `activity` — runs/swim/bike (blue)

**Daily tasks** (`day:'daily'`) get date-suffixed IDs at render time: `daily-wallsit-2026-05-22`

**Current tier counts:** pflicht: 19, standard: 9, bonus: 8, activity: 5

### Weekly Structure (key exercises)

| Day | Pflicht (core) | Standard | Bonus |
|-----|---------------|----------|-------|
| Mo  | Coach-Plan, Side Plank, Hip Thrust, Beckenboden | Knee Extension Theraband | Reverse Lunge, Bulgarian Split |
| Di  | Pre-Run Aktivierung, Atemübung | Wadenheber | — |
| Mi  | Coach-Plan, Side Plank, Hip Thrust, Beckenboden | Single Leg Deadlift | — |
| Do  | Pre-Run Aktivierung | Wadenheber | — |
| Fr  | Coach-Plan, Side Plank, Hip Thrust, Beckenboden | Knee Extension Theraband | KB Step-Up |
| Sa  | — | SL Deadlift, Wadenheber | Copenhagen Plank, Bent-Knee Calf, Faszienrolle, Hüftöffner |
| So  | Pre-Run Aktivierung | Wadenheber (Long Run) | — |
| Daily | Meditation, Wall Sit, Einbeinstand | Sprunggelenk-Mobi | Bird Dog |

### REGEN_TASKS (Monday after Long Run)
Faszienrolle (pflicht), Spaziergang (pflicht), Beine hochlegen (pflicht), Hüftöffner + Psoas (standard)

### PROGRESSION map
```js
PROGRESSION['mo-knee'] = { phase1:'...', phase2:'...', phase3:'...' }
```
Phase shown as chip on task if exercise has progression entry.

### COVERAGE_ZONES (8 zones)
knie, patella, po, huefte, achilles, shinSplints, stabilitaet, recovery  
Each has `target` (weekly exercises) and `low` threshold.

### EXERCISE_GUIDES (30 exercises, 5 categories)
Pre-Run Aktivierung / Kraft Coach-Plan / Zusatz-Übungen / Tägliche Snacks / Regeneration  
Each exercise: `{ name, setup, bewegung, tipp }`

### PROBLEMS (8 entries)
Maps problem zones → exercise list for Warum tab.

---

## Key Functions

### Navigation
```js
todayKey(date?)          // YYYY-MM-DD using LOCAL date (not UTC)
parseLocalDate(str)      // YYYY-MM-DD → Date object (local)
getViewingDate()         // returns current viewing dateKey
setViewingDate(dk)       // set viewing date, triggers render()
navigateToDay(dk)        // setViewingDate + switch to Heute tab
getWeekStart(date?)      // Monday of current week
getPhase()               // { id:'phase1|2|3', name, label, weeksLeft }
```

### State Mutations
```js
toggleTask(id, dk)           // complete/uncomplete a task
toggleSkipTask(id, dk)       // skip/unskip a task
setOura(val)                 // 'good'|'okay'|'bad' for today
setMondayRegen(val)          // true|false for viewing Monday
addSuggestion(baseId, name, duration, tier)  // add missed task to today
deleteSuggestion(id, dk)     // remove suggested task
confirmSession()             // save session from sheet state
deleteSession(id, dk)        // remove custom session
resetWeek()                  // clear all state for current week
```

### Render Pipeline
```js
render()                // calls all sub-renders
renderToday()           // main today view (uses getViewingDate())
renderTodayTasks(dayOfWeek, dk)  // task list for a day
renderDaySwitcher(viewingDow, viewingDk)  // week navigation pills
renderSuggestions()     // missed tasks box (today only)
renderWeek()            // weekly overview cards
renderBodyCoverage()    // zone progress bars
renderExercises()       // exercise guides
renderWhy()             // problem → exercise mapping
renderPhaseBanner()     // phase display in streak bar
renderOuraCheckin()     // oura buttons (today only)
renderMondayQuestion()  // long run question (Monday only)
```

### Logic
```js
getTasksForDay(dayOfWeek, dateKey?)  // returns tasks + daily tasks
isPflichtComplete(date)              // checks if all pflicht done
isAdaptedDay(dk)                     // true if Oura = bad
adjustedTier(tier, dk)               // downgrades tier if Oura bad
getMissedSuggestions()               // past days this week, not done
calculateCoverage()                  // counts completed exercises per zone
getPhase()                           // auto from weeks to marathon
```

---

## Phase System (auto-calculated)
- **Phase 1 Aufbau:** > 11 weeks to marathon
- **Phase 2 Spezifik:** 5–11 weeks
- **Phase 3 Taper:** < 5 weeks

Phase shown in streak bar. Per-exercise progression chips shown from `PROGRESSION` map.

---

## Known Bugs Fixed (do not re-introduce)

1. **Timezone bug:** `todayKey()` MUST use `getFullYear/getMonth/getDate` (local), NOT `toISOString()` (UTC). Germany = UTC+2, toISOString gives wrong date before 2am.
2. **Session dk bug:** Custom sessions saved under `sheetState.selectedDay`, shown in the tab matching that dateKey. All session toggles pass `dk` explicitly.
3. **viewingDate navigation:** `renderTodayTasks` receives `dk = getViewingDate()` — not hardcoded `todayKey()`. All task interactions use this dk.
4. **Daily task IDs:** Daily tasks get `-YYYY-MM-DD` suffix appended at render time to separate completion state per day. Base ID is stripped with `.replace(/-\d{4}-\d{2}-\d{2}$/, '')` when needed.

---

## Design System

```css
--bg: #f4f1ea       /* warm parchment */
--ink: #1a1a1a      /* near black */
--paper: #fdfbf6    /* off-white cards */
--line: #c8c3b4     /* dividers */
--accent: #d63a17   /* red-orange (CTA, today indicator) */
--green: #3d6b2c    /* standard tier, good coverage */
--amber: #9b7c2a    /* bonus tier, warn coverage */
--blue: #1c4a6c     /* activity */
--teal: #2a7a8a     /* regen */
```

Typography: Georgia (body/headings italic), Helvetica Neue (labels/UI).  
Max width: 480px, centered. Safe area insets for iOS notch.

---

## Possible Next Features

- **Pogo Jumps:** Evaluate in Phase 2 (July 2026) if knee stays quiet. Currently excluded due to Grade 3 cartilage damage.
- **TrainingPeaks sync:** Pull actual run data instead of manual session entry
- **Streak calendar:** Visual month view of completed days
- **Export/backup:** JSON export of state for backup
- **Oura API integration:** Auto-pull readiness score instead of manual entry
- **Progressive overload tracker:** Log actual weights used per session
- **Phase 2 plan changes:** Different exercise mix in Spezifik phase

---

## Deployment

**Repository:** https://github.com/skiefa/marathon-strength  
**Live URL:** https://skiefa.github.io/marathon-strength  
**Hosted via:** GitHub Pages (branch: `main`, root `/`)

To update the live site: edit `index.html`, then `git add`, `git commit`, `git push`. GitHub Pages deploys automatically within ~1 minute.

**iOS home screen:** Open the live URL in Safari → Share → Add to Home Screen. Remove and re-add if the icon doesn't update.

---

## Home Screen Icon (`icon.png`)

180×180px PNG, generated with pure Python (no dependencies).  
Design: bold **M** in `#1A1A1A` on parchment `#F4F1EA` background, red checkered finish line (`#D63A17`) at bottom.

Referenced in `index.html` as:
```html
<link rel="apple-touch-icon" href="icon.png">
<link rel="icon" type="image/png" href="icon.png">
```

To regenerate or redesign the icon, re-run the Python script that was used in the session (pure `struct` + `zlib`, no Pillow needed). Icon must be a real PNG file — data URIs do not work for `apple-touch-icon` on iOS.

---

## File Locations
```
index.html   — main app (single file, ~1430 lines)
icon.png     — home screen icon (180×180px)
HANDOVER.md  — this file
```

To continue in Claude Code:
1. Open this project folder in Claude Code
2. All app logic is in a single `<script>` tag at the bottom of `index.html`
3. Push changes with `git push` — GitHub Pages deploys automatically
