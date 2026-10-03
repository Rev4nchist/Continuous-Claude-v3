---
name: kusto-cli
description: Use this skill whenever you need to work with Kusto, KQL, Azure Data Explorer, logs, telemetry, data, dashboards, or anything related to queries. Always use it for data questions.
---

# Kusto CLI Skill

`Kusto.Cli.exe` sends KQL queries and control commands to a Kusto service (Azure Data Explorer or
Microsoft Fabric Eventhouse). On this machine it is at `C:\tools\kusto-cli\Kusto.Cli.exe`.

## Run a query headless

1. Build the connection string: `https://<cluster>.kusto.fabric.microsoft.com;Fed=True;Initial Catalog=<db>`.
2. Run `Kusto.Cli.exe "<connection string>" -execute:"<KQL>"`.
3. For CSV, add `-lineMode:false` and redirect the output to a file.
