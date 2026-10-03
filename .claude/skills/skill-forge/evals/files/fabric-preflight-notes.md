# Session notes: Fabric preflight (FourthCompanyBrain)

What we did today before every Fabric run. I want this as a repeatable thing I start by hand.

1. `az account show` to confirm the playground tenant, not a customer tenant.
2. Run `python docs/playground/deploy.py preflight`. It checks four tokens without interaction,
   the capacity state, running jobs, cost items and untriaged incidents.
3. If preflight shows a running job, wait. One Fabric job at a time on the F2.
4. If any capacity error shows up (HTTP 429, "capacity has exceeded its limits"): stop all load and report.
   No retries.
5. Never pause, resume or resize the capacity from a script. That is the owner's step.
   Claude did this once in a past session and it cost money.
6. Save the preflight output under `.claudedocs/` with the date.
