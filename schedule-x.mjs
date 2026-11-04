#!/usr/bin/env node
// Schedules approved items from a local SQLite content queue to X/Twitter through your own
// already-signed-in Chrome tab, using the narrow chrome-bridge surface.
//
// It never posts immediately: it fills the composer, sets X's native schedule
// picker, confirms, and presses Schedule. Without --commit it stops before the
// final press and reports what it would have done.
//
//   node scripts/schedule-x.mjs                 # dry run, every Ready item
//   node scripts/schedule-x.mjs --limit 1       # dry run, first item only
//   node scripts/schedule-x.mjs --limit 1 --commit
//   node scripts/schedule-x.mjs --commit

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, 'chrome-bridge.mjs')
const TAB = 'https://x.com/'
const DB = process.env.QUEUE_DB || `${process.env.HOME}/content-queue.sqlite3`
const X_LIMIT = 280

const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}
const commit = process.argv.includes('--commit')
const limit = Number(arg('--limit') ?? '0') || Infinity

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// X throttles background tabs and its modals then render empty, so the tab is
// brought to the front before anything else runs.
function focusTab() {
  execFileSync('node', [BRIDGE, 'focus', '--url', TAB], { encoding: 'utf8' })
}

function evalInTab(code) {
  const out = execFileSync('node', [BRIDGE, 'eval', '--url', TAB, '--code', code], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return out.trim()
}

function evalJson(code) {
  const raw = evalInTab(code)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Tab returned something that is not JSON: ${raw.slice(0, 200)}`)
  }
}

function readQueue() {
  const sql = `select json from editorialItems where json_extract(json,'$.destinationPlatform')='X/Twitter' and json_extract(json,'$.reviewState')='Ready' and json_extract(json,'$.scheduledAt') is not null and json_extract(json,'$.status')<>'Scheduled' order by json_extract(json,'$.scheduledAt')`
  const out = execFileSync('/usr/bin/sqlite3', [DB, sql], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// X's picker is six native <select> elements: month, day, year, hour,
// minute, am/pm. Month is set first because it rewrites the day options.
const parts = (iso) => {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Monterrey',
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: true
  }).formatToParts(new Date(iso))
  const get = (type) => f.find((p) => p.type === type).value
  return {
    month: String(Number(get('month'))),
    day: String(Number(get('day'))),
    year: get('year'),
    hour: String(Number(get('hour'))),
    minute: String(Number(get('minute'))),
    ampm: get('dayPeriod').toLowerCase()
  }
}

const j = (value) => JSON.stringify(value)
const squash = (text) => text.replace(/\s+/g, ' ').trim()

const OPEN_COMPOSER = `(function(){
  if(document.querySelector("[data-testid=tweetTextarea_0]")) return JSON.stringify({ok:true,already:true});
  var b=document.querySelector("[data-testid=SideNav_NewTweet_Button]");
  if(!b) return JSON.stringify({ok:false,why:"no compose button"});
  b.click(); return JSON.stringify({ok:true,already:false});
})()`

const setTextCode = (text) => `(function(){
  var e=document.querySelector("[data-testid=tweetTextarea_0]");
  if(!e) return JSON.stringify({ok:false,why:"no editor"});
  e.focus(); document.execCommand("selectAll"); document.execCommand("delete");
  document.execCommand("insertText",false,${j(text)});
  return JSON.stringify({ok:true,text:e.innerText});
})()`

const OPEN_PICKER = `(function(){
  var tb=document.querySelector("[data-testid=toolBar]");
  if(!tb) return JSON.stringify({ok:false,why:"no toolbar"});
  var b=tb.querySelector("[data-testid=scheduleOption]");
  if(!b) return JSON.stringify({ok:false,why:"no schedule button"});
  b.click(); return JSON.stringify({ok:true});
})()`

const setWhenCode = (p) => `(function(){
  var s=document.querySelectorAll("select");
  if(s.length!==6) return JSON.stringify({ok:false,why:"expected 6 selects, saw "+s.length});
  var want=[${j(p.month)},${j(p.day)},${j(p.year)},${j(p.hour)},${j(p.minute)},${j(p.ampm)}];
  var order=[0,2,1,3,4,5];
  for(var k=0;k<order.length;k++){
    var i=order[k], el=s[i];
    var setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,"value").set;
    setter.call(el,want[i]);
    el.dispatchEvent(new Event("change",{bubbles:true}));
  }
  var got=Array.prototype.map.call(document.querySelectorAll("select"),function(e){return e.value});
  var dlg=document.querySelector("[role=dialog]");
  return JSON.stringify({ok:String(got)===String(want),got:got,want:want,summary:dlg?dlg.innerText.split("\\n").slice(0,3).join(" | "):""});
})()`

const CONFIRM = `(function(){
  var b=document.querySelector("[data-testid=scheduledConfirmationPrimaryAction]");
  if(!b) return JSON.stringify({ok:false,why:"no confirm button"});
  b.click(); return JSON.stringify({ok:true});
})()`

const FIND_SCHEDULE_BUTTON = `(function(){
  var cands=Array.prototype.slice.call(document.querySelectorAll("[data-testid=tweetButton],[data-testid=tweetButtonInline]"));
  var hit=cands.filter(function(e){return /schedule/i.test(e.innerText||"")})[0];
  return JSON.stringify({found:!!hit,labels:cands.map(function(e){return (e.getAttribute("data-testid")||"")+":"+(e.innerText||"").trim()})});
})()`

const PRESS_SCHEDULE = `(function(){
  var cands=Array.prototype.slice.call(document.querySelectorAll("[data-testid=tweetButton],[data-testid=tweetButtonInline]"));
  var hit=cands.filter(function(e){return /schedule/i.test(e.innerText||"")})[0];
  if(!hit) return JSON.stringify({ok:false,why:"no Schedule button"});
  if(hit.getAttribute("aria-disabled")==="true") return JSON.stringify({ok:false,why:"Schedule button disabled"});
  hit.click(); return JSON.stringify({ok:true});
})()`

function markScheduled(item) {
  const sql = `update editorialItems set json = json_set(json,'$.status','Scheduled','$.destinationUrl','x.com scheduled queue','$.updatedAt',${JSON.stringify(new Date().toISOString())}) where id = ${JSON.stringify(item.id)}`
  execFileSync('/usr/bin/sqlite3', [DB, sql], { encoding: 'utf8' })
}

const step = (label, result) => {
  if (!result.ok) throw new Error(`${label}: ${result.why ?? JSON.stringify(result)}`)
  return result
}

focusTab()
const queue = readQueue().slice(0, limit === Infinity ? undefined : limit)
console.log(`${queue.length} item${queue.length === 1 ? '' : 's'} to schedule on X. Mode: ${commit ? 'COMMIT' : 'dry run'}\n`)

const done = []
const failed = []

for (const item of queue) {
  const text = item.draftText
  const when = parts(item.scheduledAt)
  const label = `${when.year}-${when.month.padStart(2, '0')}-${when.day.padStart(2, '0')} ${when.hour}:${when.minute.padStart(2, '0')}${when.ampm}`
  console.log(`- ${label}  ${squash(text).slice(0, 60)}`)

  if (new Date(item.scheduledAt) <= new Date()) {
    console.log('  SKIP: that time has already passed')
    failed.push({ item, why: 'time already passed' })
    continue
  }
  if (text.length > X_LIMIT) {
    console.log(`  SKIP: ${text.length} characters is over the ${X_LIMIT} limit`)
    failed.push({ item, why: 'over character limit' })
    continue
  }

  try {
    step('open composer', evalJson(OPEN_COMPOSER))
    for (let i = 0; i < 12 && !evalJson('JSON.stringify({ok:!!document.querySelector("[data-testid=tweetTextarea_0]")})').ok; i++) sleep(1000)
    const typed = step('set text', evalJson(setTextCode(text))); sleep(600)
    if (squash(typed.text) !== squash(text)) throw new Error('composer text does not match the queue item')
    step('open picker', evalJson(OPEN_PICKER))
    // The picker renders asynchronously; poll for the six selects instead of a fixed sleep.
    for (let i = 0; i < 12 && evalJson('JSON.stringify({n:document.querySelectorAll("select").length})').n !== 6; i++) sleep(1000)
    const set = step('set date and time', evalJson(setWhenCode(when))); sleep(600)
    console.log(`  picker says: ${set.summary}`)
    step('confirm', evalJson(CONFIRM)); sleep(2000)
    const btn = evalJson(FIND_SCHEDULE_BUTTON)
    if (!btn.found) throw new Error(`no Schedule button after confirm (saw ${btn.labels.join(', ')})`)

    if (!commit) {
      console.log('  DRY RUN: stopping here, Schedule not pressed')
      done.push({ item, label, committed: false })
      continue
    }
    step('press Schedule', evalJson(PRESS_SCHEDULE)); sleep(3500)
    markScheduled(item)
    console.log('  SCHEDULED')
    done.push({ item, label, committed: true })
  } catch (error) {
    console.log(`  FAILED: ${error.message}`)
    failed.push({ item, why: error.message })
    break
  }
}

console.log(`\n${done.length} handled, ${failed.length} not.`)
if (failed.length) for (const f of failed) console.log(`  not done: ${squash(f.item.draftText).slice(0, 50)}: ${f.why}`)
