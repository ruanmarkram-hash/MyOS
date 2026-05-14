#!/usr/bin/env python3
"""
Workflow Designer — Streamlined Brief Generator
================================================
6 questions from user. The agent fills the rest intelligently.
Review step at end for corrections.

Usage:
  python workflow-design.py
  python workflow-design.py --type compliance --name "Quarterly Audit"
  python workflow-design.py --path /path/to/workflow/folder
"""

import argparse
import os
import sys
import json
from datetime import datetime, timedelta
from pathlib import Path
from workflow_placement import cascade_context_updates

# ============================================================
# WORKSPACE KNOWLEDGE — The agent fills these automatically
# ============================================================

WORKSPACE_ROOT = os.path.expanduser("~/workspace")

# Folder structure: [root]/[operation-or-project]/[workflow-name]/brief.md + output/
# e.g. <example-domain>/compliance/quarterly-internal-audit/brief.md
#      <example-domain>/compliance/quarterly-internal-audit/output/
RESOURCE_PATHS = {
    "compliance": {
        "parent": "<example-domain>/compliance",
        "data": "<example-domain>/compliance/data/",
        "<industry>": "<example-domain>/compliance/data/<industry-standards>/",
        "legislation": "<example-domain>/compliance/data/legislation/",
    },
    "recruitment": {
        "parent": "<example-domain>/recruitment",
        "data": "<example-domain>/recruitment/data/",
    },
    "incident": {
        "parent": "<example-domain>/incident-management",
        "data": "<example-domain>/incident-management/data/",
    },
    "bsp": {
        "parent": "<example-domain>/behaviour-support-plans",
        "data": "<example-domain>/behaviour-support-plans/data/",
    },
    "business": {
        "parent": "<example-domain>/business-management",
        "data": "<example-domain>/business-management/data/",
    },
    "onboarding": {
        "parent": "<example-domain>/recruitment",
        "data": "<example-domain>/recruitment/data/",
    },
    "research": {
        "parent": "library",
        "data": "library/",
    },
    "content": {
        "parent": "library",
        "data": "library/",
    },
    "code": {
        "parent": "projects/<your-project>",
        "data": "projects/<your-project>/data/",
    },
    "project": {
        "parent": "projects",
        "data": "projects/",
    },
    "reconciliation": {
        "parent": "<example-domain>/business-management",
        "data": "<example-domain>/business-management/data/",
    },
}

# Tool recommendations by workflow type
TOOL_DEFAULTS = {
    "compliance": ["read", "web_search", "write"],
    "incident": ["read", "write"],
    "recruitment": ["read", "write", "web_search"],
    "onboarding": ["read", "write"],
    "reconciliation": ["read", "write", "exec"],
    "research": ["read", "web_search", "web_fetch"],
    "content": ["read", "write", "web_search"],
    "code": ["read", "write", "exec"],
    "project": ["read", "write"],
}

# Model recommendations by complexity
MODEL_DEFAULTS = {
    "compliance": ("Opus", True),      # (model, reasoning)
    "incident": ("Sonnet", False),
    "recruitment": ("Sonnet", False),
    "onboarding": ("Haiku", False),
    "reconciliation": ("Sonnet", True),
    "research": ("Opus", True),
    "content": ("Sonnet", False),
    "code": ("Sonnet", True),
    "project": ("Sonnet", False),
}

# Default escalation
DEFAULT_ESCALATION = "<USER_NAME>"
DEFAULT_REVIEWER = "<USER_NAME> (final approval + sign-off)"

# Output format defaults
OUTPUT_FORMAT_DEFAULTS = {
    "compliance": "Word doc",
    "incident": "Word doc",
    "recruitment": "Markdown",
    "onboarding": "Markdown",
    "reconciliation": "Markdown",
    "research": "Markdown",
    "content": "Markdown",
    "code": "Code commit",
    "project": "Markdown",
}

WORKFLOW_TYPES = {
    "1": ("compliance", "Compliance Audit / Governance"),
    "2": ("incident", "Incident Assessment / Response"),
    "3": ("recruitment", "Recruitment / Screening"),
    "4": ("onboarding", "Staff Onboarding"),
    "5": ("reconciliation", "Data Reconciliation / Cleanup"),
    "6": ("research", "Research / Analysis"),
    "7": ("content", "Content / Document Creation"),
    "8": ("code", "Code / Development"),
    "9": ("project", "Project Management"),
}


def banner():
    print("=" * 60)
    print("WORKFLOW DESIGNER: Streamlined Brief Generator")
    print("6 questions from you. The agent fills the rest.")
    print("=" * 60)
    print()


def ask(prompt, required=True, multiline=False):
    """Ask a single question. Returns string."""
    if multiline:
        print(f"{prompt}")
        print("  (Enter lines. End with blank line.)")
        lines = []
        while True:
            line = input("  > ").strip()
            if not line:
                if lines or not required:
                    break
                print("  Cannot skip this question.")
                continue
            lines.append(line)
        return lines
    else:
        while True:
            answer = input(f"{prompt}: ").strip()
            if answer or not required:
                return answer
            print("  This field is required.")


def ask_choice(prompt, options):
    """Ask a numbered choice question."""
    print(f"\n{prompt}")
    for key, (code, label) in options.items():
        print(f"  {key}. {label}")
    while True:
        choice = input("Select (number): ").strip()
        if choice in options:
            return options[choice]
        print("  Invalid selection. Try again.")


def infer_workflow_dir(wf_type, wf_name):
    """Return the workflow folder path: [root]/[operation]/[Workflow Name]/
    Operations use kebab-case. Workflow folders use Title Case with spaces."""
    paths = RESOURCE_PATHS.get(wf_type, RESOURCE_PATHS["project"])
    # Workflow name keeps human-readable Title Case
    return f"{paths['parent']}/{wf_name.strip()}"


def infer_output_path(wf_type, wf_name, output_format):
    """Output goes in [workflow-dir]/Outputs/[filename]"""
    wf_dir = infer_workflow_dir(wf_type, wf_name)
    slug = wf_name.strip().replace(" ", "-")

    if output_format == "Word doc":
        ext = ".docx"
    elif output_format == "PDF":
        ext = ".pdf"
    elif output_format == "Code commit":
        return f"{wf_dir}/Outputs/"
    else:
        ext = ".md"

    return f"{wf_dir}/Outputs/{slug}{ext}"


def infer_resources(wf_type):
    """Infer likely resource paths based on workflow type."""
    paths = RESOURCE_PATHS.get(wf_type, RESOURCE_PATHS["project"])
    resources = []

    for key, path in paths.items():
        if key == "parent":
            continue  # parent is structural, not a resource
        full = os.path.join(WORKSPACE_ROOT, path)
        if os.path.exists(full):
            resources.append(f"`{path}`")

    return resources


def infer_blockers(wf_type):
    """Infer common blockers for this workflow type."""
    blockers = {
        "compliance": [
            "Source documents may be incomplete or scattered across locations",
            "the user's industry standards may have been updated mid-quarter (check for changes)",
            "Some work practices may not be formally documented yet",
        ],
        "incident": [
            "Incident details may be incomplete or inconsistent across reports",
            "Witness accounts may conflict",
            "Related incidents may not be cross-referenced",
        ],
        "recruitment": [
            "Screening check results may be delayed from external providers",
            "Candidate availability may shift during process",
            "Reference checks may be slow to return",
        ],
        "research": [
            "Source quality may vary; prioritize government and peer-reviewed sources",
            "Some data may be behind paywalls",
            "Information may be jurisdiction-specific (default: Queensland/Australia)",
        ],
        "code": [
            "Dependencies may have breaking changes",
            "Test coverage may be incomplete for affected modules",
            "Build/deploy pipeline may have queued items",
        ],
    }
    return blockers.get(wf_type, [
        "Source data may be incomplete",
        "Dependencies on other teams or external inputs",
    ])


def infer_decision_trees(wf_type):
    """Infer common decision trees for this workflow type."""
    trees = {
        "compliance": [
            "If source document is missing: flag as gap, note in blockers, continue with available evidence",
            "If regulatory standard interpretation is unclear: web_search latest guidance, escalate to <USER_NAME> if still ambiguous",
            "If gap severity is borderline: default to higher severity (conservative approach)",
        ],
        "incident": [
            "If incident involves a child: treat as Critical, escalate immediately",
            "If details are conflicting: document both accounts, flag for investigation",
            "If reportable conduct threshold is unclear: default to reporting (over-report, never under-report)",
        ],
        "recruitment": [
            "If screening check returns concerns: escalate to <USER_NAME> before proceeding",
            "If candidate withdraws mid-process: document reason, update pipeline",
        ],
        "research": [
            "If sources conflict: prioritize government sources, then peer-reviewed, then industry",
            "If data is jurisdiction-specific: default to QLD/Australian context unless specified",
        ],
        "code": [
            "If change affects >5 files: split into smaller commits",
            "If test fails: fix before proceeding, do not skip",
        ],
    }
    return trees.get(wf_type, [
        "If blocker exceeds 3 hours: escalate to <USER_NAME>",
        "If scope change discovered: document and escalate before acting",
    ])


def generate_brief(answers, inferred):
    """Generate the brief.md content."""
    lines = []
    lines.append(f"# {answers['name']} Brief\n")

    # Objective
    lines.append("## Objective")
    lines.append(answers["objective"])
    lines.append("")

    # Scope
    lines.append("## Scope")
    lines.append("**In Scope:**")
    for item in answers["in_scope"]:
        lines.append(f"- {item}")
    lines.append("")
    lines.append("**Out of Scope:**")
    for item in inferred["out_of_scope"]:
        lines.append(f"- {item}")
    lines.append("")

    # Success Criteria
    lines.append("## Success Criteria")
    for item in answers["success_criteria"]:
        lines.append(f"- {item}")
    lines.append("")

    # Output Format & Delivery
    lines.append("## Output Format & Delivery")
    lines.append(f"- **Format:** {inferred['output_format']}")
    lines.append(f"- **Location:** {WORKSPACE_ROOT}/{inferred['output_path']}")
    lines.append(f"- **Audience:** {inferred['audience']}")
    lines.append(f"- **Timeline:** {answers['timeline']}")
    lines.append("")

    # Required Resources
    lines.append("## Required Resources\n")
    lines.append("### Data & Documents")
    for r in inferred["resources"]:
        lines.append(f"- {r}")
    lines.append("")
    lines.append("### Tools")
    for t in inferred["tools"]:
        lines.append(f"- {t}")
    lines.append("")
    lines.append("### LLM Configuration")
    lines.append(f"- **Model:** {inferred['model']}")
    lines.append(f"- **Reasoning:** {'Enabled' if inferred['reasoning'] else 'Disabled'}")
    lines.append("")

    # Execution Notes
    lines.append("## Execution Notes\n")
    lines.append("### Known Blockers")
    for b in inferred["blockers"]:
        lines.append(f"- {b}")
    lines.append("")
    lines.append("### Decision Trees")
    for d in inferred["decision_trees"]:
        lines.append(f"- {d}")
    lines.append("")
    lines.append("### Escalation Path")
    lines.append(f"Escalate to {DEFAULT_ESCALATION} if:")
    lines.append("- Interpretation is unclear or depends on a policy decision")
    lines.append("- Any issue appears Critical severity and requires immediate action")
    lines.append("- Any blockers consume >3 hours of work without resolution")
    lines.append("- Scope change is discovered during execution")
    lines.append("")

    # Review & Approval
    lines.append("## Review & Approval")
    lines.append(f"- **Review required:** Yes")
    lines.append(f"- **Reviewed by:** {DEFAULT_REVIEWER}")
    lines.append(f"- **Timeline:** {answers['timeline']}")
    lines.append("")

    # Frequency
    if answers.get("frequency"):
        lines.append("## Frequency")
        lines.append(f"**Repeats:** {answers['frequency']}")
        lines.append("")

    # Delivery
    if answers.get("delivery_email"):
        lines.append("## Delivery")
        lines.append(f"On completion, email the output to: **{answers['delivery_email']}**")
        lines.append(f"- Attach the output file ({inferred['output_format']})")
        lines.append("- Email body: brief summary of findings/results")
        lines.append(f"- Send from: <recipient@your-domain> via Microsoft Graph")
        lines.append("")

    # Separator
    lines.append("---\n")

    # How to Use
    lines.append("## How to Use This Brief\n")
    lines.append("1. **Read the Objective** — Understand the why")
    lines.append("2. **Review Scope** — Know what's in/out")
    lines.append("3. **Check Success Criteria** — Know what 'done' looks like")
    lines.append("4. **Gather Required Resources** — Get all data/docs before starting")
    lines.append("5. **Follow Execution Notes** — Handle known blockers and edge cases")
    lines.append("6. **Execute** — Run the workflow")
    lines.append("7. **Deliver Output** — Place in specified location")
    lines.append("8. **Request Review** — Get sign-off from reviewer")
    lines.append("9. **Close** — Document completion in project context/memory")
    lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Workflow Designer — Streamlined Brief Generator")
    parser.add_argument("--name", help="Workflow name")
    parser.add_argument("--type", help="Workflow type (compliance, incident, recruitment, etc.)")
    parser.add_argument("--path", help="Output folder path for the brief")
    args = parser.parse_args()

    banner()

    # ============================================================
    # 6 QUESTIONS — User answers these
    # ============================================================

    print("[YOUR 6 QUESTIONS]\n")

    # Q1: Name
    if args.name:
        wf_name = args.name
        print(f"Q1. Workflow name: {wf_name} (from args)\n")
    else:
        wf_name = ask("Q1. Workflow name (e.g., 'Quarterly Internal Audit')")
        print()

    # Q2: Type
    if args.type:
        wf_type = args.type
        wf_label = next((v[1] for v in WORKFLOW_TYPES.values() if v[0] == args.type), args.type)
        print(f"Q2. Workflow type: {wf_label} (from args)\n")
    else:
        wf_type, wf_label = ask_choice("Q2. Workflow type?", WORKFLOW_TYPES)
        print()

    # Q3: Objective
    print("Q3. What outcome are you solving for?")
    objective = ask("    (one sentence, outcome-focused)")
    print()

    # Q4: Scope
    in_scope = ask("Q4. What's in scope?", multiline=True)
    print()

    # Q5: Success criteria
    success_criteria = ask("Q5. What does 'done' look like? (testable outcomes)", multiline=True)
    print()

    # Q6: Timeline
    timeline = ask("Q6. When is it due? (include any checkpoints)")
    print()

    # Optional: frequency
    print("Is this repeating? (enter frequency or leave blank for one-off)")
    frequency = ask("    Frequency", required=False)
    print()

    # Optional: delivery
    delivery_defaults = {
        "compliance": "<recipient@your-domain>",
        "incident": "<recipient@your-domain>",
        "reconciliation": "<recipient@your-domain>",
    }
    default_email = delivery_defaults.get(wf_type, "")
    if default_email:
        print(f"Send completed output via email? (default: {default_email}, blank to skip)")
    else:
        print("Send completed output via email? (enter address or blank to skip)")
    delivery_email = ask("    Email", required=False)
    if not delivery_email and default_email:
        delivery_email = default_email
    print()

    # ============================================================
    # AGENT FILLS THE REST - Intelligent defaults
    # ============================================================

    print("=" * 60)
    print("FILLING REMAINING FIELDS...")
    print("=" * 60)
    print()

    model, reasoning = MODEL_DEFAULTS.get(wf_type, ("Sonnet", False))
    output_format = OUTPUT_FORMAT_DEFAULTS.get(wf_type, "Markdown")
    output_path = infer_output_path(wf_type, wf_name, output_format)
    tools = TOOL_DEFAULTS.get(wf_type, ["read", "write"])
    resources = infer_resources(wf_type)
    blockers = infer_blockers(wf_type)
    decision_trees = infer_decision_trees(wf_type)

    # Infer out-of-scope (everything NOT this domain)
    all_domains = ["Financial controls", "IT security", "Facility management", "Marketing"]
    out_of_scope = [d for d in all_domains]
    if wf_type != "code":
        out_of_scope.append("Code changes or deployments")
    if wf_type != "recruitment":
        out_of_scope.append("Staff recruitment or screening")

    # Audience default
    audience = f"{DEFAULT_ESCALATION} (decision authority), Leadership team"
    if wf_type == "compliance":
        audience += ", the user's industry auditors if triggered"

    inferred = {
        "model": model,
        "reasoning": reasoning,
        "output_format": output_format,
        "output_path": output_path,
        "tools": tools,
        "resources": resources,
        "blockers": blockers,
        "decision_trees": decision_trees,
        "out_of_scope": out_of_scope,
        "audience": audience,
    }

    # Show what <AGENT_NAME> filled
    print("Here's what I filled in:\n")
    print(f"  Model:          {model} ({'with' if reasoning else 'no'} reasoning)")
    print(f"  Output format:  {output_format}")
    print(f"  Output path:    {output_path}")
    print(f"  Tools:          {', '.join(tools)}")
    print(f"  Resources:      {len(resources)} paths found")
    print(f"  Blockers:       {len(blockers)} identified")
    print(f"  Decision trees: {len(decision_trees)} rules")
    print(f"  Out of scope:   {len(out_of_scope)} items")
    print(f"  Audience:       {audience}")
    print(f"  Reviewer:       {DEFAULT_REVIEWER}")
    print(f"  Escalation:     {DEFAULT_ESCALATION}")
    if delivery_email:
        print(f"  Delivery:       Email to {delivery_email}")
    print()

    # ============================================================
    # REVIEW STEP — User can override
    # ============================================================

    print("Review these defaults? (enter to accept, or type field name to change)")
    review = input("  [Enter to accept / 'model', 'format', 'path' to change]: ").strip().lower()

    if review == "model":
        _, (model, reasoning) = ask_choice("Model?", {
            "1": ("Haiku", False),
            "2": ("Sonnet", False),
            "3": ("Sonnet", True),
            "4": ("Opus", False),
            "5": ("Opus", True),
        })
        inferred["model"] = model
        inferred["reasoning"] = reasoning
    elif review == "format":
        output_format = ask("Output format (Markdown, Word doc, PDF, JSON)")
        inferred["output_format"] = output_format
        inferred["output_path"] = infer_output_path(wf_type, wf_name, output_format)
    elif review == "path":
        output_path = ask("Output path (relative to workspace)")
        inferred["output_path"] = output_path

    # ============================================================
    # GENERATE BRIEF
    # ============================================================

    answers = {
        "name": wf_name,
        "type": wf_type,
        "objective": objective,
        "in_scope": in_scope,
        "success_criteria": success_criteria,
        "timeline": timeline,
        "frequency": frequency,
        "delivery_email": delivery_email,
    }

    brief_content = generate_brief(answers, inferred)

    # Determine save path: [root]/[operation]/[workflow-name]/brief.md
    if args.path:
        save_dir = args.path
    else:
        wf_dir = infer_workflow_dir(wf_type, wf_name)
        save_dir = os.path.join(WORKSPACE_ROOT, wf_dir)

    save_path = os.path.join(save_dir, "brief.md")

    # Show the brief
    print("\n" + "=" * 60)
    print("GENERATED BRIEF")
    print("=" * 60 + "\n")
    print(brief_content)

    # Save brief
    os.makedirs(save_dir, exist_ok=True)
    with open(save_path, "w") as f:
        f.write(brief_content)

    # Create Outputs/ folder inside the workflow directory
    outputs_dir = os.path.join(save_dir, "Outputs")
    os.makedirs(outputs_dir, exist_ok=True)
    print(f"  Outputs folder created: {outputs_dir}")

    # Cascade context updates to all parent levels
    print()
    print("📋 Updating context files at all hierarchy levels...")
    cascade_context_updates(WORKSPACE_ROOT, save_dir, wf_name, wf_type, frequency)


    print("=" * 60)
    print(f"✅ BRIEF SAVED: {save_path}")
    print("=" * 60)
    print()
    print("Next steps:")
    print("1. Review the brief")
    print("2. Hand to executor agent")
    print("3. Agent executes following the brief")
    print(f"4. Output delivered to: {WORKSPACE_ROOT}/{inferred['output_path']}")
    print()


if __name__ == "__main__":
    main()
