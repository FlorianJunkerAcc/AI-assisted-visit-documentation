# Open security risks

## R1 – C4C destination allows dynamic browser access (accepted)

- **Date:** 2026-11-16
- **Status:** Accepted by the project team.
- **Destination:** `SAP_Sales_Cloud_V1`. It uses BasicAuthentication with a technical user and sets `HTML5.DynamicDestination = true`.
- **Risk:** An authenticated browser session can call C4C directly through an application router that has dynamic destinations enabled (`/dynamic_dest/SAP_Sales_Cloud_V1/...`). This covers the managed approuter and SAP Build Work Zone. The call runs with the technical user's permissions and skips the CAP validation layer. That includes the owner/organizer check, the confirmation gate and the audit log.
- **Mitigation in this app:** The approuter of this app does not enable dynamic destinations. All C4C access goes through CAP. The risk remains for other apps in the same subaccount.
- **Recommended resolution (R1):** Before production, either use a separate destination without `HTML5.DynamicDestination`, or remove that property. The destination name is configurable in CAP, so no code change is needed.

## R2 – SQLite as application database on Cloud Foundry (accepted for MVP)

- **Date:** 2026-11-16
- **Status:** Accepted by the project team for the MVP. HANA Cloud is not used.
- **Risk:**
  - The Cloud Foundry container file system is ephemeral. On restart, restage, redeploy or platform maintenance, all application data is lost: VoiceSession, VisitDraft, TaskDraft, confirmations, audit log and idempotency records.
  - Only one application instance is possible, so there is no scaling or high availability.
  - SAP does not recommend SQLite for productive CAP use.
- **Consequences:**
  - A running conversation or draft can be lost. The user has to start again.
  - The audit log is not durable. There is no persistent record of who changed what.
  - Idempotency records can be lost between a partial failure and a retry.
- **Mitigation in this app:**
  - Before creating each Task or attachment, CAP checks C4C directly for an existing object: a follow-up Task on the same Visit with the same subject and processor, or an attachment with the same file name. This prevents duplicates even if local state was lost.
  - The CAP code is database-agnostic, so moving to HANA Cloud or PostgreSQL later needs only configuration and MTA changes.
- **Recommended resolution (R2):** Before production, move to a persistent database (HANA Cloud `hdi-shared`, already entitled, or PostgreSQL).

# Open privacy decisions

## P1 – Transcript retention and user notice (provisional)

- **Date:** 2026-11-16
- **Decided:** Audio is **not** stored. It is only processed live.
- **Provisional (not yet confirmed by data protection / works council):**
  - The transcript is kept in HANA only until the commit to C4C succeeds, then deleted. In C4C it remains as a PDF attachment on the Visit.
  - Sessions that are not completed are deleted after 7 days.
  - The audit log stores only metadata: who, when, which Visit, which Task IDs, outcome. It stores no conversation content.
  - The assistant gives a short spoken notice at session start (AI processing, transcript saved on the Visit). No explicit consent step.
- **To confirm before production:** the retention periods and whether the notice or a consent is required.
