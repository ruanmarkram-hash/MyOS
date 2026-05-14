# workflow-designer Skill

## Purpose

Design and generate standardized workflow briefs for execution across the workspace. Transforms conceptual workflow requirements into executable, resource-aware briefs that agents can follow with clarity and completeness.

## When to Use

Use `workflow-designer` when:
- Creating a new workflow (one-off or repeating)
- Defining a task that will be executed by an agent
- Need to generate a standardized brief with resource pointers, tool specs, success criteria
- Scaling workflows across operations (compliance, recruitment, incident management, business management)
- Adding new project phases or research tasks

Do NOT use `workflow-designer` for:
- Quick one-line tasks ("send this email")
- Tasks that need no structure (casual lookup)
- Modifying existing briefs (edit directly)

## How It Works

### Design Philosophy

**6 questions from the user. Sage fills the rest.**

The user answers only what Sage can't infer:
1. Workflow name
2. Workflow type
3. What outcome (objective)
4. What's in scope
5. What does "done" look like (success criteria)
6. When is it due (timeline)

Sage automatically fills: tools, resources, model recommendation, reasoning toggle, output format, output path, audience, blockers, decision trees, escalation path, out-of-scope items, and reviewer.

A review step at the end lets the user override any of Sage's defaults.

### Invocation

```bash
# Interactive (recommended)
python ~/workspace/skills/workflow-designer/scripts/sage-workflow-design.py

# With pre-filled args
python ~/workspace/skills/workflow-designer/scripts/sage-workflow-design.py --type compliance --name "Quarterly Audit"
sage-workflow-design incident "critical-incident-assessment" --path ~/workspace/sonke-support/incident-management/Critical\ Incident\ Assessment
sage-workflow-design research "market-analysis" --path ~/workspace/library/research/market-analysis
```

### Interactive Question Flow

The skill asks **one question at a time** and adapts based on workflow type. Questions are asked in this order:

#### Phase 1: Workflow Fundamentals

1. **Workflow Name** (prefilled if provided)
   - Confirm the name or provide a new one

2. **Workflow Type** (if not provided)
   - Options: compliance, incident, recruitment, onboarding, reconciliation, research, content, code, project, other
   - Adapts all subsequent questions to workflow type

3. **One-Sentence Objective**
   - What is the outcome we're solving for?
   - Validation: Must be a clear outcome, not activity
   - Example: "Identify gaps between current work practices and relevant legislative requirements"

4. **Business Context**
   - Why does this workflow exist? What problem does it solve?
   - Help text: "This helps agents make judgment calls on edge cases"
   - Example: "We audit quarterly to stay compliant and catch process gaps before regulators do"

#### Phase 2: Scope & Boundaries

5. **What's In Scope**
   - What IS this workflow responsible for?
   - Help: "List 3-5 concrete things"
   - Example: "Work practices, staff induction procedures, incident reporting processes, policy documentation"

6. **What's Out of Scope**
   - What is explicitly NOT included?
   - Help: "Define boundaries to prevent scope creep"
   - Example: "Financial controls, facility management, clinical assessment methodologies"

7. **Decision: Is This Repeating?**
   - One-off task or recurring (weekly/monthly/quarterly/on-demand)?
   - Adapts frequency-specific questions

#### Phase 3: Success Criteria & Outputs

8. **Success Criteria** (3-5 bullets, testable outcomes)
   - How will we know this workflow succeeded?
   - Validation: Must be observable, not subjective
   - Example: 
     - "List of 5-10 gaps, grouped by severity (Critical/High/Medium)"
     - "For each gap: legislative reference + evidence + recommended fix"
     - "Risk assessment for each gap"

9. **Output Format & Location**
   - What does the deliverable look like?
   - Format options: Markdown, Word doc, PDF, JSON, email, Slack post, form entry, database record, code commit, other
   - Location: Where should output land?
   - Example: "Word doc (for stakeholder review) → `/sonke-support/compliance/audit-reports/Q1-2026-findings.docx`"

10. **Output Audience**
    - Who will read/use this output?
    - Help: "Affects tone, detail level, and format"
    - Example: "Leadership team + regulatory auditors"

#### Phase 4: Resources & Tools

11. **Required Data/Documents**
    - What source documents will the executor need?
    - Sage searches workspace and returns exact paths
    - Multi-answer: Can add multiple sources
    - Example answer: "relevant regulatory framework" → Sage points to `/example-org/compliance/reference/standards/...`

12. **Required Tools**
    - What tools are essential? (read, write, web_search, image, exec, etc.)
    - Multi-select with explanations
    - Sage validates against available tools
    - Example: read (for compliance docs), web_search (for updated legislation)

13. **Required Skills**
    - Any custom skills needed? (gog, agent-browser, etc.)
    - Optional; skip if none
    - Example: "agent-browser (for checking live regulatory portals)"

14. **Recommended LLM/Model**
    - What model should execute this? (Haiku, Sonnet, Opus)
    - Help: "Haiku = simple classification/extraction. Sonnet = balanced. Opus = complex reasoning."
    - Default: Sonnet
    - Example: "Haiku (straightforward gap identification)"

15. **Reasoning/Thinking Required?**
    - Does this task benefit from extended reasoning?
    - Yes/No
    - Example: "No (this is factual comparison, not strategic reasoning)"

#### Phase 5: Execution & Edge Cases

16. **Known Blockers/Risks**
    - What might slow down or block the executor?
    - Optional; can skip
    - Example: "Rostering policy doc is in Sharepoint and may be stale (>6 months). Verify date before using."

17. **Edge Cases / Decision Trees**
    - Common "If X, then Y" scenarios
    - Optional; can skip or add multiple
    - Example: "If gap is regulatory-critical, flag for immediate escalation to compliance lead"

18. **Escalation Path**
    - If executor gets stuck, who do they ask?
    - What types of problems trigger escalation?
    - Example: "Escalate to [YOUR NAME] if: (a) cannot access a required document, (b) legislative requirement unclear, (c) gap appears systemic (affects 3+ areas)"

#### Phase 6: Timeline & Approval

19. **Timeline**
    - When is this due?
    - Are there interim checkpoints?
    - Example: "First pass due Friday 3pm. Review feedback Friday 4-5pm. Final due Monday 9am."

20. **Approval/Review Required?**
    - Does output need review before finalization?
    - By whom? When?
    - Example: "Yes. [YOUR NAME] reviews, provides feedback, approves final version."

21. **Frequency** (if repeating)
    - How often does this workflow run?
    - Schedule trigger (manual/cron/n8n/on-demand)?
    - Example: "Quarterly, first day of each quarter. Manual trigger (you decide when to run)."

#### Phase 7: Refinement & Validation

22. **Review**
    - Sage summarizes the brief
    - Ask: "Anything missing or need adjustment?"
    - Allow edits to any field

23. **Validation**
    - Check for ambiguity, missing scope, undefined success criteria
    - Flag risks (e.g., "Success criteria are vague: 'surface issues' — needs specificity")
    - Ask: "Is this brief ready to hand to an executor?"

---

## Output: Generated Brief.md

Once all questions are answered and validated, skill generates:

```markdown
# [Workflow Name] Brief

## Objective
[One-sentence outcome from Q3]

## Context & Motivation
[Business context from Q4]

## Scope
**In Scope:**
- [Item 1 from Q5]
- [Item 2]

**Out of Scope:**
- [Item 1 from Q6]
- [Item 2]

## Success Criteria
- [Criterion 1 from Q8]
- [Criterion 2]
- [Criterion 3]

## Output Format & Delivery
- **Format:** [From Q9]
- **Location:** [From Q9]
- **Audience:** [From Q10]
- **Timeline:** [From Q19]

## Required Resources

### Data & Documents
- [Document Name] → [Exact path from Q11]
- [Document Name] → [Exact path]

### Tools
- [Tool 1] — [Why needed, from Q12]
- [Tool 2] — [Why needed]

### Skills
- [Skill 1] (if applicable, from Q13)

### LLM Configuration
- **Model:** [From Q14]
- **Reasoning:** [Enabled/Disabled, from Q15]

## Execution Notes

### Known Blockers
- [Blocker 1 from Q16]
- [Blocker 2]

### Decision Trees
- **If** [scenario from Q17] **then** [action]
- **If** [scenario] **then** [action]

### Escalation Path
[From Q18]
- Escalate to: [Name]
- For: [Conditions]

## Review & Approval
- **Review required:** [Yes/No from Q20]
- **Reviewed by:** [Person, if yes]
- **Timeline:** [Review schedule from Q19]

## Frequency
[From Q21, if repeating]
- **Repeats:** [Quarterly/Monthly/etc.]
- **Trigger:** [Manual/Cron/On-demand]
- **Next run:** [Date]

---

## How to Use This Brief

1. **Read the Objective and Context** — Understand the why
2. **Review Scope** — Know what's in/out
3. **Check Success Criteria** — Know what "done" looks like
4. **Gather Required Resources** — Get all data/docs before starting
5. **Follow Execution Notes** — Handle known blockers and edge cases
6. **Execute** — Run the workflow
7. **Deliver Output** — Place in specified location
8. **Request Review** — If approval required, get sign-off
9. **Close** — Document completion in project context/memory

---

## Notes for Executor

- This brief is your specification. Deviate only if you discover new information requiring scope change (escalate if so).
- Success criteria must be met. If you can't meet them, flag blockers early.
- Use the decision trees for common scenarios. For anything not listed, escalate.
- Output format is specified for a reason — maintain consistency for downstream systems.
```

File is saved to: `[workflow-path]/brief.md`

---

## Script: sage-workflow-design

Location: `~/workspace/skills/workflow-designer/scripts/sage-workflow-design.py`

This script:
1. Parses command-line arguments
2. Initializes interactive question flow
3. Validates answers in real-time
4. Searches workspace for resource pointers (via QMD or file system)
5. Generates brief.md
6. Outputs success message + path to brief.md

### Usage

```bash
cd ~/workspace
python skills/workflow-designer/scripts/sage-workflow-design.py \
  --type compliance \
  --name "quarterly-internal-audit" \
  --path ~/workspace/sonke-support/compliance/Quarterly\ Internal\ Audit
```

Or via Sage spawn (subagent):

```
Sage spawns workflow-designer subagent with:
- task: "Design workflow brief for [type] [name] at [path]"
```

---

## Workflow Type Customizations

### Compliance Audit Workflows

**Additional Q (after Q4):**
- **Regulatory Framework:** Which regulations/standards apply?
  - Help: "regulatory framework, privacy law, safety standards, other?"
  - Used in: Resource list, scope validation

**Additional Q (after Q16):**
- **Policy Document Age:** Do we have current policy docs? When were they last reviewed?
  - Help: "Stale docs = blocked audit"

### Incident Assessment Workflows

**Additional Q (after Q3):**
- **Root Cause Framework:** What framework guides the assessment?
  - Options: 5-Whys, Causal Loop, Timeline-Based, Process Failure, Human Error
  - Example: "Timeline-based reconstruction"

**Additional Q (after Q10):**
- **Reportability Question:** Does this assessment determine if incident is reportable?
  - Yes/No (if yes, specifies regulatory reporting timelines)

### Recruitment/Onboarding Workflows

**Additional Q (after Q4):**
- **Audience Experience Level:** What's the executor's experience?
  - Options: New support worker (0 experience), Experienced worker (1+ years), Manager, Other
  - Used in: Depth, tone, assumption level

### Research Workflows

**Additional Q (after Q8):**
- **Confidence Levels:** How should findings be ranked?
  - Options: By evidence strength, By relevance, By recency, Other
  - Example: "Top 3 findings ranked by evidence strength"

**Additional Q (after Q12):**
- **Source Quality Standards:** What sources are acceptable?
  - Help: "Academic only? Industry reports? Blog posts?"

### Project/Code Workflows

**Additional Q (after Q5):**
- **Tech Stack/Systems:** What systems does this touch?
  - Multi-answer: Supabase, n8n, SharePoint, GitHub, other
  - Used in: Skill requirements, tool selection

---

## Workflow Types Supported

| Type | Examples | Key Customizations |
|------|----------|---|
| **compliance** | Audit, gap assessment, policy review | Regulatory framework, policy age, reporting requirements |
| **incident** | Incident assessment, RCS determination, escalation | Root cause framework, reportability, timeline |
| **recruitment** | Onboarding, screening, probation review | Experience level, training requirements, checkpoints |
| **onboarding** | New worker induction, system setup, training | Duration, hands-on vs. independent, sign-offs |
| **reconciliation** | Financial reconciliation, data sync, verification | Systems involved, tolerance levels, discrepancy handling |
| **research** | Market analysis, competitive intelligence, discovery | Source standards, confidence ranking, uncertainty handling |
| **content** | Document creation, policy writing, communications | Audience, tone, format, approval chain |
| **code** | Feature development, bug fix, refactor | Tech stack, testing requirements, deployment |
| **project** | Phase delivery, sprint, milestone | Dependencies, resources, handoff requirements |
| **other** | Custom workflow type | Use base template, no customizations |

---

## Best Practices

### For Brief Designers (You)

1. **Be specific about success.** "Surface issues and gaps" is vague. "List 5-10 gaps, grouped by severity, with evidence and fixes" is testable.

2. **Know your executor.** If assigning to an inexperienced agent, provide more examples and decision trees. For experienced agents, trust judgment.

3. **Clarify decision authority early.** "Agent decides and acts" vs. "Agent surfaces findings, you decide" are very different workflows.

4. **Resource pointers matter.** The executor should not hunt for documents. Skill finds exact paths. You confirm.

5. **Edge cases are data.** If you know a common blocker (e.g., "Sharepoint doc might be stale"), flag it so executor isn't blindsided.

### For Brief Executors (Agents)

1. **Read the full brief before starting.** Don't skip to "Output Format."

2. **Gather all resources first.** Check that all required documents are accessible before executing.

3. **Use decision trees early.** If you hit a scenario listed in "Decision Trees," follow it. If not, escalate.

4. **Document your assumptions.** If you make a judgment call, note it in the output or escalation.

5. **Meet success criteria.** If you can't, escalate. Don't deliver partial work.

### Workflow Placement & Context Cascade

When a new workflow is created, the skill **automatically**:

1. **Creates directory structure**
   - Place: `workspace/operating-system/[subcategory]/[Workflow Name]/`
   - Example: `workspace/operating-system/security-and-operating-system/Fortnightly System Scan/`

2. **Generates brief.md** inside the workflow folder
   - Not in an `Outputs/` subfolder — brief itself IS the workflow definition

3. **Creates Outputs/ subfolder** for deliverables
   - Executor places all output artifacts here

4. **Updates parent context.md files** (cascade)
   - Updates `operating-system/context.md` with new workflow reference
   - Updates `operating-system/[subcategory]/context.md` with new workflow reference
   - Pattern: `- **[Workflow Name]** ([Type]) — [folder path]`

   - Adds entry with workflow name, type, frequency, location, and status
   - Status starts as "Pending kickoff"
   - You update to "Active" once scheduled

**Result:** Workflow is discoverable at all hierarchy levels and integrated into task tracking immediately.

---

## Limitations

- **Skill does not execute the workflow.** It only generates the brief. An agent executes the brief.
- **Resource paths rely on current workspace state.** If files move after brief generation, links break. Brief should be reviewed before handoff.
- **Questions are sequential, not branching.** If you need to answer Q8 differently based on Q3, ask Sage to re-run with adjusted answer.
- **Doesn't handle complex multi-step workflows.** For workflows with >10 discrete steps, consider adding a "Execution Step-by-Step" section manually.

---

## Troubleshooting

**Q: Brief generated but some resource paths are wrong**
- A: Workspace structure changed after brief generation. Run skill again or manually edit paths in brief.md

**Q: Questions don't match my workflow type**
- A: Workflow type may be misclassified. Re-run skill with explicit `--type` flag

**Q: Success criteria feel too vague**
- A: This is normal. Answer Q8 with 5+ specific, testable outcomes. Skill will validate and prompt for specificity.

**Q: I don't know the answer to a question**
- A: Skip it (skill will note TBD). You can edit brief.md manually later. Or ask Sage for help.

---

## Future Enhancements

- **Workflow templates:** Pre-filled briefs for common workflows (quarterly audit, incident assessment)
- **Workflow versioning:** Track brief changes over time
- **Workflow analytics:** Which briefs led to successful executions? Which had the most rework?
- **Integration with n8n/cron:** Auto-wrap generated briefs into automation configs
- **Approval workflow:** Brief review/approval before handoff to executor
