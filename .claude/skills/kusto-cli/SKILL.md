---
name: kusto-cli
description: Microsoft Kusto.Cli for KQL queries against Azure Data Explorer and Microsoft Fabric Eventhouse — connection strings, headless execution, CSV export
---

# Kusto CLI Skill

`Kusto.Cli.exe` is Microsoft's reference command-line tool for sending KQL queries and control commands to a Kusto service (Azure Data Explorer or Microsoft Fabric Eventhouse). It is REPL-first but supports fully headless execution via `-execute` / `-script`.

On this machine: `C:\tools\kusto-cli\Kusto.Cli.exe`, version `14.1.2`, .NET Framework 4.7.2 build (no .NET runtime install required — built into Windows 10/11). Source NuGet: [Microsoft.Azure.Kusto.Tools](https://www.nuget.org/packages/Microsoft.Azure.Kusto.Tools/).

Run `Kusto.Cli.exe -help` for basics, `-verboseHelp` for advanced switches. `-helpmd` and `-verboseHelpMd` emit MarkDown.

## Connection Strings

The connection string is the first positional argument. Always wrap in double quotes — PowerShell parses unquoted semicolons as command separators.

| Target | Pattern |
|--------|---------|
| Microsoft Fabric Eventhouse / KQL DB | `"https://<workspace-id>.kusto.fabric.microsoft.com/<database>;Fed=true"` |
| Azure Data Explorer cluster | `"https://<cluster>.<region>.kusto.windows.net/<database>;Fed=true"` |
| Public help cluster (Microsoft samples) | `"https://help.kusto.windows.net/Samples;Fed=true"` or shorthand `"@help/Samples"` |

`Fed=true` enables AAD federated auth — opens a browser on first use, caches tokens afterward. Other auth modes (managed identity, application key, federated certificate) are encoded as additional fragments. Full reference: [Kusto connection strings](https://learn.microsoft.com/kusto/api/connection-strings/kusto).

## Headless Execution

Default behavior is REPL. For scripts and CI, always pair `-execute:` with `-keepRunning:false` so the process exits.

Single query:

```powershell
Kusto.Cli.exe "<conn>" -execute:"StormEvents | take 5" -keepRunning:false
```

Multiple commands run in order:

```powershell
Kusto.Cli.exe "<conn>" `
  -execute:"#save c:\temp\out.csv" `
  -execute:"StormEvents | take 100" `
  -keepRunning:false
```

Script file (one command per line; use `&` at end of line to continue, `&&` to fold):

```powershell
Kusto.Cli.exe "<conn>" -script:"queries\daily.kql" -scriptQuitOnError:true -keepRunning:false
```

`-scriptml:` treats the entire file as a single command — use it when KQL spans multiple lines without `&` continuation. For very long queries, use a response file: `Kusto.Cli.exe @args.rsp`.

## Output

Default is a console table. **No native JSON.** Structured export goes through the `#save` directive, which writes the *next* query result to a CSV file:

```powershell
Kusto.Cli.exe "<conn>" -execute:"#save c:\temp\events.csv" -execute:"StormEvents | take 100" -keepRunning:false
```

For pipelines that need JSON, post-process with PowerShell:

```powershell
Import-Csv c:\temp\events.csv | ConvertTo-Json -Depth 5
```

Other output toggles (directives, runtime-only): `#csvheaderson|off`, `#tableon|off`, `#markdownon|off`, `#focuson|off`, `#timeon|off`. Set `-transcript:<file>` to mirror all output to a log.

## CLI vs Other Routes

| Route | Use For |
|-------|---------|
| Kusto.Cli (this skill) | KQL data queries, batch scripts, CSV export for analysis |
| `az kusto` (Azure CLI) | **Management plane only** — provisioning clusters, databases, principals. Cannot run KQL. |
| Kusto SDK (Python/.NET) | Production data pipelines, JSON results, programmatic integration |
| Kusto.Explorer / Web UI | Interactive exploration with charts and visualization |

## Common Recipes

```powershell
# Connect, set DB context, run query
Kusto.Cli.exe "@help/Samples" -execute:"#dbcontext Samples" -execute:".show tables" -keepRunning:false

# Show cluster diagnostics
Kusto.Cli.exe "<conn>" -execute:".show cluster" -keepRunning:false

# Export query result to CSV (no headers)
Kusto.Cli.exe "<conn>" -execute:"#csvheadersoff" -execute:"#save out.csv" -execute:"<KQL>" -keepRunning:false

# Run a saved script and quit on first error
Kusto.Cli.exe "<conn>" -script:"daily-rollup.kql" -scriptQuitOnError:true -keepRunning:false

# Capture transcript for audit
Kusto.Cli.exe "<conn>" -transcript:"run-$(Get-Date -Format yyyyMMdd-HHmmss).log" -execute:"<KQL>" -keepRunning:false
```

## Gotchas

- **Always quote the connection string** — `Fed=true` parsed bare in PowerShell becomes a separate command and breaks the call.
- **Default is REPL** — forgetting `-keepRunning:false` leaves the process waiting on stdin in a non-interactive shell.
- **Exit code 1 from `-help` is normal** — not an error.
- **No JSON output** — use `#save` to CSV, then `Import-Csv | ConvertTo-Json` if needed.
- **AAD interactive on first use** — first headless run opens a browser. CI needs managed identity or app-key auth encoded in the conn string.
- **Positional conn string** — must be the first non-switch arg, before any `-execute`/`-script`.
- **`Kusto.Cli.exe -ekr:`** (alias for `-executeAndKeepRunning`) runs commands then drops into REPL — useful when interactively iterating after a setup query, but never use it in scripts.

## Safety

See [.claude/rules/kusto-cli-safety.md](../../rules/kusto-cli-safety.md) for the dangerous-command list (`.drop`, `.delete`, `.purge`, `.clear`, `.alter ... policy`, `.ingest into`, `.set-or-append`, `.set-or-replace`). Pure read queries, `.show` commands, and `#save` are safe.

## When to Use

Trigger keywords: `kusto`, `Kusto.Cli`, `KQL`, `kql query`, `Azure Data Explorer`, `ADX`, `Fabric Eventhouse`, `Fabric KQL DB`, `kusto.fabric.microsoft.com`, `kusto.windows.net`, `.show tables`, `StormEvents`
