"""
Workflow Placement & Context Cascade Module

Handles:
1. Creating workflow directory structure
2. Updating parent context.md files at all hierarchy levels
"""

import os
import sys


def update_parent_context(context_path, workflow_entry, wf_name, wf_type, frequency):
    """Update parent context.md to reference new workflow."""
    parent_dir = os.path.dirname(context_path)
    os.makedirs(parent_dir, exist_ok=True)
    
    if not os.path.exists(context_path):
        # Create new context file
        with open(context_path, "w") as f:
            f.write(f"# {os.path.basename(parent_dir)} Context\n\n")
            f.write("## Active Workflows\n\n")
            f.write(f"- **{wf_name}** ({wf_type}) — `{workflow_entry}`\n")
    else:
        # Append to existing context
        with open(context_path, "r") as f:
            lines = f.readlines()
        
        # Look for "## Active Workflows" section
        found_section = False
        insert_index = len(lines)
        
        for i, line in enumerate(lines):
            if "## Active Workflows" in line:
                found_section = True
                # Find next section or end of file
                for j in range(i + 1, len(lines)):
                    if lines[j].startswith("##"):
                        insert_index = j
                        break
                else:
                    insert_index = len(lines)
                break
        
        if not found_section:
            # Add new section
            lines.append("\n## Active Workflows\n\n")
            lines.append(f"- **{wf_name}** ({wf_type}) — `{workflow_entry}`\n")
        else:
            # Insert into existing section
            lines.insert(insert_index, f"- **{wf_name}** ({wf_type}) — `{workflow_entry}`\n")
        
        with open(context_path, "w") as f:
            f.writelines(lines)


def update_task_ledger(workspace_root, wf_name, wf_type, frequency, workflow_path):
    if frequency == "one-off":
        return
    
    rel_path = os.path.relpath(workflow_path, workspace_root)
    entry = f"- **{wf_name}** ({wf_type}) — Scheduled: {frequency} — Location: `{rel_path}` — Status: Pending kickoff\n"
    
    if not os.path.exists(ledger_path):
        with open(ledger_path, "w") as f:
            f.write("# Task Ledger\n\n## Automated Workflows\n\n")
            f.write(entry)
    else:
        with open(ledger_path, "a") as f:
            f.write(entry)


def cascade_context_updates(workspace_root, workflow_dir, wf_name, wf_type, frequency):
    """
    Update all parent context.md files and task ledger for new workflow.
    
    Handles hierarchies like:
    - workspace/operating-system/security-and-operating-system/[Workflow Name]/
    """
    rel_path = os.path.relpath(workflow_dir, workspace_root)
    path_parts = rel_path.split(os.sep)
    
    # Check if this is an operating-system workflow
    if "operating-system" in path_parts:
        os_idx = path_parts.index("operating-system")
        
        if len(path_parts) >= os_idx + 3:
            subcategory = path_parts[os_idx + 1]
            workflow_folder = path_parts[os_idx + 2]
            
            # Update operating-system/context.md
            os_context = os.path.join(workspace_root, "operating-system", "context.md")
            workflow_ref = os.path.join("operating-system", subcategory, workflow_folder)
            update_parent_context(os_context, workflow_ref, wf_name, wf_type, frequency)
            print(f"  ✅ Updated: operating-system/context.md")
            
            # Update operating-system/[subcategory]/context.md
            subcat_context = os.path.join(workspace_root, "operating-system", subcategory, "context.md")
            update_parent_context(subcat_context, workflow_folder, wf_name, wf_type, frequency)
            print(f"  ✅ Updated: operating-system/{subcategory}/context.md")
    
    if frequency and frequency != "one-off":
        update_task_ledger(workspace_root, wf_name, wf_type, frequency, workflow_dir)
