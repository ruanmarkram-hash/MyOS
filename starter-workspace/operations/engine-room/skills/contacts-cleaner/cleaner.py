#!/usr/bin/env python3
"""Contacts cleaner. Scans AddressBook, generates HTML review page, serves it, deletes approved contacts via AppleScript."""
import sqlite3, os, re, json, subprocess, html, sys, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs

HOME = os.path.expanduser("~")
SOURCES_DIR = os.path.join(HOME, "Library/Application Support/AddressBook/Sources")

def find_sources_db():
    for entry in os.listdir(SOURCES_DIR):
        path = os.path.join(SOURCES_DIR, entry, "AddressBook-v22.abcddb")
        if os.path.exists(path):
            return path
    return None

DB_PATH = find_sources_db()
if not DB_PATH:
    print("No Sources abcddb found", file=sys.stderr)
    sys.exit(1)

JUNK_PATTERNS = re.compile(
    r"tuk[ -]?tuk|taxi|airport|bike\s*rent|weligama|colombo|"
    r"roaming helpdesk|voicemail|helpdesk|hotel|hostel|"
    r"tour guide|driver",
    re.IGNORECASE,
)

def country_of(num):
    if not num:
        return None
    n = num.replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    if n.startswith("+61"): return "AU"
    if n.startswith("+27"): return "ZA"
    if n.startswith("+64"): return "NZ"
    if n.startswith("+44"): return "UK"
    if n.startswith("+1"):  return "US/CA"
    if n.startswith("+49"): return "DE"
    if n.startswith("+85"): return "HK/SG"
    if n.startswith("+94"): return "LK"
    if n.startswith("+"):   return "INTL"
    if re.match(r"^0[2-9]\d{8}$", n): return "AU"  # local AU format
    return "UNK"

def load_contacts():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    cur = conn.cursor()
    cur.execute("""
      SELECT r.Z_PK, r.ZUNIQUEID, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION,
             GROUP_CONCAT(p.ZFULLNUMBER, ' | ') as phones
      FROM ZABCDRECORD r
      LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
      WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL
      GROUP BY r.Z_PK
    """)
    rows = []
    for z_pk, uid, first, last, org, phones in cur.fetchall():
        name = " ".join(x for x in [first, last] if x).strip() or org or "(no name)"
        phone_list = (phones or "").split(" | ") if phones else []
        countries = set(country_of(p) for p in phone_list if p)
        rows.append({
            "pk": z_pk, "uid": uid, "name": name,
            "phones": phone_list, "countries": sorted(c for c in countries if c),
        })
    conn.close()
    return rows

def classify(contacts):
    """Returns (review_list, skipped_au_only, skipped_za_family, skipped_no_phone)."""
    review, au_only, za, no_phone = [], [], [], []
    for c in contacts:
        if not c["phones"]:
            no_phone.append(c); continue
        ctrs = set(c["countries"])
        if ctrs == {"AU"}:
            au_only.append(c); continue
        if "ZA" in ctrs:
            za.append(c); continue
        # everything else goes in review
        c["is_junk"] = bool(JUNK_PATTERNS.search(c["name"]))
        review.append(c)
    # Sort: junk first, then by country, then by name
    review.sort(key=lambda c: (not c["is_junk"], c["countries"], c["name"].lower()))
    return review, au_only, za, no_phone

def gen_html(review, stats):
    rows_html = []
    for c in review:
        checked = "checked" if c["is_junk"] else ""
        phones_str = html.escape(", ".join(c["phones"]))
        name_esc = html.escape(c["name"])
        countries_str = html.escape("/".join(c["countries"]))
        junk_badge = '<span class="junk">JUNK</span>' if c["is_junk"] else ''
        rows_html.append(f"""
          <tr class="{'junk-row' if c['is_junk'] else ''}">
            <td><input type="checkbox" name="uid" value="{html.escape(c['uid'] or '')}" data-pk="{c['pk']}" {checked}></td>
            <td>{name_esc} {junk_badge}</td>
            <td>{countries_str}</td>
            <td class="phones">{phones_str}</td>
          </tr>
        """)
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Contact cleanup</title>
<style>
body {{ font-family: -apple-system, sans-serif; margin: 2rem; background: #fafafa; color: #222; }}
h1 {{ margin: 0 0 0.3rem 0; }}
.stats {{ color: #666; margin-bottom: 1.5rem; font-size: 0.9rem; }}
table {{ border-collapse: collapse; width: 100%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,.08); }}
th, td {{ padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; text-align: left; }}
th {{ background: #f0f0f0; position: sticky; top: 0; }}
.junk-row {{ background: #fff6f6; }}
.junk {{ background: #c00; color: white; padding: 1px 5px; font-size: 0.7rem; border-radius: 3px; margin-left: 0.4rem; }}
.phones {{ font-family: monospace; font-size: 0.85rem; color: #555; }}
.actions {{ position: sticky; bottom: 0; background: white; padding: 1rem; border-top: 2px solid #333; margin-top: 1rem; box-shadow: 0 -2px 8px rgba(0,0,0,.1); }}
button {{ padding: 0.6rem 1.2rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; }}
.danger {{ background: #c00; color: white; }}
.danger:hover {{ background: #900; }}
.secondary {{ background: #ddd; margin-right: 0.5rem; }}
#result {{ margin-top: 1rem; padding: 0.8rem; border-radius: 4px; display: none; }}
.ok {{ background: #e8f5e9; color: #1b5e20; }}
.err {{ background: #ffebee; color: #b71c1c; }}
</style></head>
<body>
<h1>Contact cleanup</h1>
<div class="stats">
  Total: {stats['total']}  |  AU-only (skipped): {stats['au_only']}  |  South African (kept): {stats['za']}  |  No phone (skipped): {stats['no_phone']}  |  <b>For review: {stats['review']}</b><br>
  Junk pre-checked. Untick anything you want to keep. Tick anything else to delete. Hit delete at the bottom.
</div>
<form id="form">
<table>
<thead><tr><th>Delete</th><th>Name</th><th>Country</th><th>Phones</th></tr></thead>
<tbody>
{''.join(rows_html)}
</tbody>
</table>
<div class="actions">
  <button type="button" class="secondary" onclick="document.querySelectorAll('input[type=checkbox]').forEach(c=>c.checked=false)">Uncheck all</button>
  <button type="button" class="secondary" onclick="document.querySelectorAll('.junk-row input').forEach(c=>c.checked=true)">Re-check junk</button>
  <button type="submit" class="danger">Delete selected</button>
  <span id="result"></span>
</div>
</form>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {{
  e.preventDefault();
  const uids = [...document.querySelectorAll('input[name=uid]:checked')].map(c=>c.value);
  if (!uids.length) {{ alert('Nothing selected'); return; }}
  if (!confirm(`Delete ${{uids.length}} contacts? This goes through Contacts.app and syncs to iCloud.`)) return;
  const r = await fetch('/delete', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body: JSON.stringify({{uids}})}});
  const j = await r.json();
  const el = document.getElementById('result');
  el.style.display = 'inline-block';
  if (j.ok) {{
    el.className = 'ok';
    el.textContent = `Deleted ${{j.deleted}} of ${{uids.length}}. ${{j.failed ? j.failed + ' failed.' : ''}}`;
    document.querySelectorAll('input[name=uid]:checked').forEach(c => c.closest('tr').style.opacity = '0.3');
  }} else {{
    el.className = 'err';
    el.textContent = 'Error: ' + (j.error || 'unknown');
  }}
}});
</script>
</body></html>"""

def delete_contact(uid):
    """Delete by unique ID via AppleScript through Contacts.app."""
    script = f'''
    tell application "Contacts"
      try
        set target to (first person whose id is "{uid}")
        delete target
        save
        return "OK"
      on error errmsg
        return "ERR: " & errmsg
      end try
    end tell
    '''
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=15)
    return result.stdout.strip().startswith("OK"), result.stdout.strip() + result.stderr.strip()

class Handler(BaseHTTPRequestHandler):
    html_cache = ""
    def log_message(self, format, *args): pass  # quiet

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(Handler.html_cache.encode())
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        if self.path != "/delete":
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length))
        uids = payload.get("uids", [])
        deleted, failed, errors = 0, 0, []
        for uid in uids:
            ok, msg = delete_contact(uid)
            if ok: deleted += 1
            else:
                failed += 1
                errors.append(f"{uid}: {msg}")
        resp = json.dumps({"ok": True, "deleted": deleted, "failed": failed, "errors": errors[:5]})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(resp.encode())

def main():
    contacts = load_contacts()
    review, au_only, za, no_phone = classify(contacts)
    stats = {
        "total": len(contacts), "review": len(review),
        "au_only": len(au_only), "za": len(za), "no_phone": len(no_phone),
    }
    print(f"Loaded {stats['total']} contacts.", file=sys.stderr)
    print(f"  AU-only (skipped):   {stats['au_only']}", file=sys.stderr)
    print(f"  South African (kept):{stats['za']}", file=sys.stderr)
    print(f"  No phone (skipped):  {stats['no_phone']}", file=sys.stderr)
    print(f"  For review:          {stats['review']}  (junk pre-checked: {sum(1 for c in review if c['is_junk'])})", file=sys.stderr)

    Handler.html_cache = gen_html(review, stats)
    port = int(os.environ.get("PORT", "8765"))
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving at http://127.0.0.1:{port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
