# Write-back to Christian — portal scope, in writing

**Purpose:** close check (3) of the A5 milestone bar — *"Dave's written statement of Christian's
vision sent and confirmed."* The bar is explicit that the milestone **fails if the scoping call
happens and the boundary is still verbal** (A5 §Next Milestone).

**Status:** draft, pre-session (2026-08-06). Send before or immediately after the session — the
acknowledgment is what counts, not the meeting.

**Voice:** reflecting Christian's direction back to him. Section 2 is his call; section 3 is
labelled as Dave's derivation so the acknowledgment is unambiguous about what he is agreeing to.

**What it deliberately does NOT do:** it does not claim the boundary is fully drawn. Check (2) of
the bar lists four sub-questions the control-centre answer does not by itself settle; those are
named as open in section 4 rather than assumed.

**Send as:** plain text, Teams or email. Everything between the dividers is the message.

---

Christian — putting your portal answer in writing so we are working from the same statement, and
so the scope is on record rather than in a meeting.

**What I understood you to say**

The External Developer Portal is not primarily a documentation and onboarding experience. It is
the customer-facing operational control centre for MCP integrations — token management, tool
discovery, skills, and agents. Documentation and onboarding sit inside that, they are not the
point of it.

The north star you described for how it should feel: an agent on the portal page that sets the
customer up and coaches them through setup and use. The portal configures itself with the
customer, rather than handing them instructions and leaving.

That is the answer to the question I put to the sponsors on 30 July, and it is the one everything
else has been waiting on.

**What I take that to mean — my derivation, tell me if any of it is wrong**

1. Token, key and webhook surfaces are portal concerns, not only Fourth360 concerns. That puts
   the portal directly alongside work Engineering has already started — Toma confirmed on 29 July
   that a customer token-request UI begins with Vance within a few weeks. I do not think that is a
   conflict, but it does mean the boundary has to be drawn feature by feature, and soon, or we
   build the same surface twice. This is the most time-sensitive item on the list.

2. The tool catalog is in scope, which means the security gate is live. We logged it on 30 July as
   an escalation: the portal cannot publish installable tools without a review-and-signing gate
   ahead of them. It is roughly a sprint of work and it still has no owner. If a catalog is in,
   that gate needs a name against it — my read is that the decision is yours.

3. Skills and agents are portal surfaces, not a separate product. I had proposed parking the
   skills ecosystem to keep the portal's maintained surface small. Your answer brings it back in,
   so I will plan for it rather than around it.

**What your answer does not settle, and I am not assuming**

- Where the line falls between Developer Portal, Fourth360 and the landing zone, feature by feature.
- Whether the portal mirrors the API-key and webhook configuration already prototyped in Fourth360,
  or replaces it.
- How much token provisioning is exposed to the customer versus automated behind the scenes.
- How delegated consultant administration works — who configures on a customer's behalf.

These are the four I would like to close next, in that order. The first one is the one that gets
expensive if we leave it.

**What I need from you**

A reply confirming this is right, or correcting the parts that are not. That is the whole ask —
once it is acknowledged in writing I can scope the build against it and stop hedging every plan
against two possible portals.

Dave

---

## After it is acknowledged

- Update the A5 project row: milestone checks (1)(3) satisfied; (2) partially — record which of the
  four sub-questions remain open.
- Reflect the confirmed vision to Toma (Dave's on-record commitment, A3 @46:20, week of 08-10).
- Re-scope `pillar3-devportal.md` §§5–7 against the control-centre branch; the addendum currently
  marks them as pre-confirmation analysis.
- Open the agent-on-the-page design workstream — nothing in the session pack designs it yet.
