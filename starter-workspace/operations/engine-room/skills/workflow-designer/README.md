# Workflow Designer Skill

**Status:** v1.0 (Draft for Review)

## Quick Start

Generate a standardized workflow brief in 10-15 minutes:

```bash
cd /Users/sagecos1/workspace
python skills/workflow-designer/scripts/sage-workflow-design.py \
  --type compliance \
  --name "quarterly-internal-audit" \
  --path /Users/sagecos1/workspace/sonke-support/compliance/Quarterly\ Internal\ Audit
```

Or start interactive mode:

```bash
python skills/workflow-designer/scripts/sage-workflow-design.py
```

Output: `[workflow-path]/brief.md`

---

## What This Skill Does

Transforms your workflow requirements into a **standardized, executable brief** that agents can follow with clarity.

**Input:** Workflow concept + a few questions  
**Output:** `brief.md` with objective, scope, success criteria, resource pointers, and execution guidance

---

## Files in This Skill

- **SKILL.md** — Full skill documentation (read this first)
- **scripts/sage-workflow-design.py** — Interactive brief generator
- **README.md** — This file

---

## Workflow Types Supported

| Type | Use For | Examples |
|------|---------|----------|
| **compliance** | Audits, gap assessments, policy reviews | Quarterly Internal Audit, Policy Gap Assessment |
| **incident** | Incident investigations, root cause analysis, RCS determination | Critical Incident Assessment, Escalation Decision |
| **recruitment** | Onboarding, screening, probation reviews | New Worker Onboarding, Probation Review |
| **reconciliation** | Financial reconciliation, data sync, verification | Monthly Reconciliation, Invoice Matching |
| **research** | Market analysis, competitive intelligence, discovery | Market Analysis, Trend Research |
| **content** | Policy documents, communications, procedure manuals | Policy Document, Procedure Manual |
| **code** | Feature development, bug fixes, refactors | Feature Development, Bug Fix |
| **project** | Sprint phases, milestone delivery, project phases | Sprint Phase, Milestone Delivery |
| **other** | Custom workflow type (uses base template) | Custom process |

---

## Key Features

✅ **Adaptive questions** — Asks only questions relevant to your workflow type  
✅ **Resource discovery** — Sage finds exact file paths for data/documents  
✅ **One-page briefs** — Concise, readable, ready to hand to an executor  
✅ **Workspace-aware** — Generates briefs in workflow folders with correct structure  
✅ **Scalable** — Same skill for compliance audits, incident assessments, recruiting, research, code sprints  

---

## The 8-Section Brief Template

Every generated brief contains these sections:

1. **Objective** — One-sentence outcome
2. **Context & Motivation** — Why it matters
3. **Scope** — What's in/out
4. **Success Criteria** — How we know it's done (testable)
5. **Output Format & Delivery** — What/where/for whom
6. **Required Resources** — Data, tools, skills, LLM
7. **Execution Notes** — Blockers, decision trees, escalation
8. **Review & Approval** — Who reviews, when

---

## Example: Quarterly Internal Audit

**Command:**
```bash
python skills/workflow-designer/scripts/sage-workflow-design.py \
  --type compliance \
  --name "quarterly-internal-audit"
```

**Questions Asked:**
1. Workflow name? → "Quarterly Internal Audit"
2. Workflow type? → "Compliance Audit"
3. Objective? → "Identify gaps in work practices vs. relevant legislative requirements"
4. Context? → "Quarterly audits ensure compliance and catch process gaps early"
5. In scope? → Work practices, staff induction, incident reporting, policies
6. Out of scope? → Financial controls, facility management
7. Success criteria? → "5-10 gaps listed, grouped by severity, with evidence + fixes"
8. Output format? → "Word doc"
9. Where? → "/sonke-support/compliance/audit-reports/Q1-2026-findings.docx"
10. Audience? → "Leadership + regulatory auditors"
... (continues with resources, blockers, timeline)

**Output:**
```
/Users/sagecos1/workspace/sonke-support/compliance/Quarterly Internal Audit/brief.md
```

Ready for an agent to execute.

---

## For Brief Designers (You)

**Best Practices:**

1. **Be specific about success.** "Surface issues" is vague. "List 5-10 gaps, grouped by severity, with evidence and fixes" is testable.

2. **Know your executor.** Inexperienced executors need more guidance. Experienced ones need room for judgment.

3. **Clarify decision authority.** "Agent decides + acts" vs. "Agent surfaces findings + you decide" are different workflows.

4. **Resource pointers are critical.** The executor shouldn't hunt for documents. Let Sage find exact paths.

5. **Flag edge cases.** "Sharepoint doc might be stale" beats discovering it mid-execution.

---

## For Brief Executors (Agents)

**How to Use a Generated Brief:**

1. Read the Objective and Context
2. Review Scope (know what's in/out)
3. Check Success Criteria (know what done looks like)
4. Gather all Required Resources before starting
5. Follow Execution Notes (handle blockers + edge cases)
6. Execute the workflow
7. Deliver output to specified location
8. Request review if required
9. Close and document completion

---

## Workflow-Specific Customizations

### Compliance Audits

**Additional questions:**
- Regulatory framework? (regulatory framework, privacy law, safety standards, etc.)
- Policy document age? (Are docs current?)

**Output typically:** Word doc, shared with leadership + regulators

### Incident Assessments

**Additional questions:**
- Root cause framework? (5-Whys, Timeline-Based, Process Failure, etc.)
- Is this reportable? (Does it trigger RCS notification?)

**Output typically:** Incident report, decision memo, action plan

### Recruitment/Onboarding

**Additional questions:**
- Audience experience? (New support worker vs. experienced)

**Output typically:** Checklist, training plan, sign-off forms

### Research

**Additional questions:**
- Source quality standards? (Academic only? Industry reports?)
- Confidence ranking? (Top findings by evidence strength)

**Output typically:** Research brief, findings document, recommendations

---

## Troubleshooting

**Q: Script won't run / Python error**
- A: Ensure Python 3.8+ is installed. Run from workspace root. Use full paths for `--path` argument.

**Q: Resource paths are wrong in generated brief**
- A: Workspace structure may have changed. Edit brief.md manually or re-run skill.

**Q: Questions don't match my workflow type**
- A: Workflow type may be misclassified. Re-run with explicit `--type` flag.

**Q: Success criteria feel too vague**
- A: This is normal. Answer with 5+ specific, testable outcomes. Skill will prompt for specificity.

**Q: I don't know the answer to a question**
- A: Skip it (skill will note TBD). Edit brief.md manually afterward or ask Sage for help.

---

## Future Enhancements

- Workflow templates (pre-filled briefs for common workflows)
- Workflow versioning (track brief changes over time)
- Integration with n8n/cron (auto-wrap briefs into automation configs)
- Approval workflow (review briefs before handoff)
- Analytics (which briefs led to successful executions?)

---

## Files & Paths

```
skills/workflow-designer/
├── SKILL.md                          (Full documentation)
├── README.md                         (This file)
└── scripts/
    └── sage-workflow-design.py       (Interactive script)
```

Generated briefs land in:
```
[workflow-folder]/brief.md
```

Examples:
- `sonke-support/compliance/Quarterly Internal Audit/brief.md`
- `sonke-support/incident-management/Critical Incident Assessment/brief.md`
- `projects/sonke-hub/sprints/[sprint-name]/brief.md`

---

## Version History

**v1.0 (Draft)** — Initial skill release. Ready for review and testing with first compliance audit workflow.

---

## Questions?

Ask Sage. This skill is designed to scale across the workspace, so feedback on the question flow, output format, and resource discovery is valuable for iteration.
