#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

const allowedHosts = ['substack.com', 'x.com', 'threads.com']

function usage() {
  console.log(`Usage:
  chrome-bridge.mjs list
  chrome-bridge.mjs focus --url <exact-or-partial-url>
  chrome-bridge.mjs read --url <exact-or-partial-url>
  chrome-bridge.mjs eval --url <exact-or-partial-url> --code <javascript>
  chrome-bridge.mjs nav --url <open-tab-url> --to <destination-url>

The bridge only targets open Google Chrome tabs on Substack, X, and Threads.`)
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

function runAppleScript(script) {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' }).trim()
}

function requireAllowedUrl(url) {
  if (!url) throw new Error('A target URL is required.')
  const parsed = new URL(url)
  if (!allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    throw new Error(`Refusing to target ${parsed.hostname}. Allowed hosts: ${allowedHosts.join(', ')}.`)
  }
}

function quote(value) {
  return JSON.stringify(value)
}

function findTabScript(targetUrl, action) {
  return `
tell application "Google Chrome"
  set targetUrl to ${quote(targetUrl)}
  set matchedWindow to 0
  set matchedTab to 0
  repeat with wi from 1 to (count windows)
    repeat with ti from 1 to (count tabs of window wi)
      set candidateUrl to URL of tab ti of window wi
      if candidateUrl contains targetUrl then
        set matchedWindow to wi
        set matchedTab to ti
        exit repeat
      end if
    end repeat
    if matchedWindow is not 0 then exit repeat
  end repeat
  if matchedWindow is 0 then error "No matching Chrome tab found for " & targetUrl
  set targetTab to tab matchedTab of window matchedWindow
  ${action}
end tell`
}

function listTabs() {
  const output = runAppleScript(`
tell application "Google Chrome"
  set rows to {}
  repeat with wi from 1 to (count windows)
    repeat with ti from 1 to (count tabs of window wi)
      set t to tab ti of window wi
      set end of rows to ((wi as text) & ":" & (ti as text) & " | " & (title of t) & " | " & (URL of t))
    end repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return rows as text
end tell`)
  console.log(output)
}

function main() {
  const command = process.argv[2]
  if (!command || command === '--help') {
    usage()
    return
  }
  if (command === 'list') {
    listTabs()
    return
  }

  const targetUrl = valueAfter('--url')
  requireAllowedUrl(targetUrl)

  if (command === 'focus') {
    runAppleScript(findTabScript(targetUrl, 'set active tab index of window matchedWindow to matchedTab\n  activate'))
    return
  }

  if (command === 'nav') {
    const destination = valueAfter('--to')
    requireAllowedUrl(destination)
    runAppleScript(findTabScript(targetUrl, `set URL of targetTab to ${quote(destination)}`))
    console.log(`Navigated tab matching ${targetUrl} to ${destination}`)
    return
  }

  if (command === 'read') {
    const result = runAppleScript(findTabScript(targetUrl, 'return execute targetTab javascript "document.body.innerText"'))
    console.log(result)
    return
  }

  if (command === 'eval') {
    const code = valueAfter('--code')
    if (!code) throw new Error('JavaScript is required with --code.')
    const result = runAppleScript(findTabScript(targetUrl, `return execute targetTab javascript ${quote(code)}`))
    console.log(result)
    return
  }

  usage()
  process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
