// A copy of scripts/github/fixtures/slot-queue/tick-*.json, the tick output the CLI prints (plan sec 5, O1). The plugin test runner loads only code
// files from inside this folder, so the JSON text sits here as strings. scripts/github/slot-queue-mod-sync.test.mjs fails when a copy differs
// from its fixture: change the fixture, then paste its text here.
export const TICKS = {
  queued: `{
  "ok": true,
  "effective": true,
  "locked": false,
  "actions": [
    {
      "kind": "toast",
      "pr": 900,
      "text": "PR #900: queued for the free CodeRabbit slot, 1 of 1. Next slot in about 12 minutes."
    }
  ],
  "rows": [
    {
      "pr": 900,
      "band": "HIGH",
      "state": "queued",
      "position": 1,
      "total": 1,
      "head7": "0000000",
      "queuedMin": 0,
      "timeoutInMin": 60,
      "nextSlotInMin": 12,
      "posts": 0,
      "asked": {
        "paid30": false,
        "timeout60": false
      }
    }
  ],
  "nextSlotInMin": 12
}`,
  posted: `{
  "ok": true,
  "effective": true,
  "locked": false,
  "actions": [
    {
      "kind": "toast",
      "pr": 901,
      "text": "PR #901: free slot taken, @coderabbitai review posted."
    }
  ],
  "rows": [
    {
      "pr": 900,
      "band": "HIGH",
      "state": "queued",
      "position": 1,
      "total": 1,
      "head7": "0000000",
      "queuedMin": 10,
      "timeoutInMin": 50,
      "nextSlotInMin": 60,
      "posts": 0,
      "asked": {
        "paid30": false,
        "timeout60": false
      }
    },
    {
      "pr": 901,
      "band": "CRITICAL",
      "state": "posted",
      "position": null,
      "total": 1,
      "head7": "0000000",
      "queuedMin": 20,
      "timeoutInMin": null,
      "nextSlotInMin": 60,
      "posts": 0,
      "asked": {
        "paid30": false,
        "timeout60": false
      }
    }
  ],
  "nextSlotInMin": 60
}`,
  ask: `{
  "ok": true,
  "effective": true,
  "locked": false,
  "actions": [
    {
      "kind": "toast",
      "pr": 901,
      "text": "PR #901: no free slot for 30 minutes. Paid round $2.75 (cr-paid ALLOW). Type /slot pay 901, or wait."
    }
  ],
  "rows": [
    {
      "pr": 901,
      "band": "CRITICAL",
      "state": "queued",
      "position": 1,
      "total": 1,
      "head7": "0000000",
      "queuedMin": 31,
      "timeoutInMin": 29,
      "nextSlotInMin": 600,
      "posts": 0,
      "asked": {
        "paid30": true,
        "timeout60": false
      }
    }
  ],
  "nextSlotInMin": 600
}`,
  timeout: `{
  "ok": true,
  "effective": true,
  "locked": false,
  "actions": [
    {
      "kind": "toast",
      "pr": 900,
      "text": "PR #900: no free slot for 60 minutes; still queued; READY still needs a CodeRabbit review. Type /slot pay 900 or /slot wait 900."
    }
  ],
  "rows": [
    {
      "pr": 900,
      "band": "HIGH",
      "state": "timed-out",
      "position": 1,
      "total": 1,
      "head7": "0000000",
      "queuedMin": 61,
      "timeoutInMin": 0,
      "nextSlotInMin": 600,
      "posts": 0,
      "asked": {
        "paid30": false,
        "timeout60": true
      }
    }
  ],
  "nextSlotInMin": 600
}`,
}
