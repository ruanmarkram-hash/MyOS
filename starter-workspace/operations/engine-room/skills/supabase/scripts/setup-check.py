#!/usr/bin/env python3
"""
Supabase setup verification script for custom workflow.
Run before and after schema changes to verify everything is correct.

Usage: python3 setup-check.py
"""

import os
import sys

def check_env():
    env_path = os.path.expanduser("~/sonke-hub/.env.local")
    if not os.path.exists(env_path):
        print("❌ .env.local not found")
        return False
    with open(env_path) as f:
        content = f.read()
    if "VITE_SUPABASE_URL" not in content:
        print("❌ VITE_SUPABASE_URL not set in .env.local")
        return False
    if "VITE_SUPABASE_ANON_KEY" not in content:
        print("❌ VITE_SUPABASE_ANON_KEY not set in .env.local")
        return False
    print("✅ .env.local configured")
    return True

def check_schema_file():
    schema_path = os.path.expanduser("~/sonke-hub/src/lib/schema.sql")
    final_path = os.path.expanduser("~/Desktop/sonke-hub-schema-FINAL.sql")
    if os.path.exists(schema_path):
        print(f"✅ Schema file: {schema_path}")
    if os.path.exists(final_path):
        print(f"✅ Final reset schema on Desktop")
    return True

def check_supabase_connection():
    try:
        import urllib.request
        import json
        
        env_path = os.path.expanduser("~/sonke-hub/.env.local")
        url = None
        key = None
        with open(env_path) as f:
            for line in f:
                if line.startswith("VITE_SUPABASE_URL="):
                    url = line.split("=", 1)[1].strip()
                elif line.startswith("VITE_SUPABASE_ANON_KEY="):
                    key = line.split("=", 1)[1].strip()
        
        if not url or not key:
            print("❌ Could not read credentials")
            return False
        
        # Test connection by hitting the health endpoint
        req = urllib.request.Request(
            f"{url}/rest/v1/",
            headers={"apikey": key, "Authorization": f"Bearer {key}"}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            print(f"✅ Supabase connection OK ({url})")
            return True
    except Exception as e:
        print(f"❌ Supabase connection failed: {e}")
        return False

def main():
    print("custom workflow — Supabase Setup Check")
    print("=" * 40)
    
    results = [
        check_env(),
        check_schema_file(),
        check_supabase_connection(),
    ]
    
    print("=" * 40)
    if all(results):
        print("✅ All checks passed")
    else:
        print("⚠️  Some checks failed — review above")
    
if __name__ == "__main__":
    main()
