---
name: supabase
description: >
  Complete Supabase setup, schema management, auth configuration, RLS policies, and data migration
  for the custom workflow project. Use when: setting up a new Supabase project, running or updating the
  database schema, managing auth users, configuring Row Level Security, debugging Supabase errors,
  migrating data from mock to live, or any task involving the Supabase backend for custom workflow.
  NOT for: general Postgres queries unrelated to custom workflow, or frontend React work.
---

# Supabase Skill — custom workflow

## Project Details

- **Project URL:** https://uzhlzwcczrfptnrrjfmd.supabase.co
- **Region:** ap-southeast-2 (Sydney, Australia) ✅ compliant
- **Credentials:** in `sonke-hub/.env.local`
- **Schema file:** `sonke-hub/src/lib/schema.sql`
- **Reset + rebuild schema:** `~/Desktop/sonke-hub-schema-FINAL.sql`
- **Data layer:** `sonke-hub/src/lib/db.js`
- **Client:** `sonke-hub/src/lib/supabase.js`

---

## Critical Rules (Lessons Learned)

1. **Never seed profiles manually.** The `handle_new_user()` trigger auto-creates profile rows when auth users are created. Manually inserting into `profiles` before the auth user exists will cause "Database error creating new user" when Supabase tries to insert via the trigger.

2. **Always use `security definer set search_path = ''`** on trigger functions. This is the official Supabase pattern — without it, the function may fail silently.

3. **Always include `ON CONFLICT (id) DO NOTHING`** in the trigger insert as a safety net.

4. **RLS must be enabled AND policies must exist.** Enabling RLS without policies blocks ALL access via the anon key. Always add at minimum a permissive policy for development.

5. **When rebuilding schema:** Drop all tables first (`CASCADE`), then drop trigger and function, then recreate. Never run `CREATE TABLE IF NOT EXISTS` on top of existing tables with RLS policies — it causes policy name conflicts.

6. **Verify external facts with web_search before stating them.** Example: "Supabase has no Australian region" was wrong. Always check supabase.com/docs/guides/platform/regions.

---

## Correct Trigger Pattern (Official Supabase Docs)

```sql
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, role, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'worker'),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

---

## Schema Management

### First-time setup
1. Use `~/Desktop/sonke-hub-schema-FINAL.sql` — drops everything and rebuilds clean
2. Run in Supabase SQL Editor
3. Create auth user via Dashboard → Authentication → Users → Add user
4. Set role via user metadata or update profiles table directly after creation

### Adding new tables
```sql
create table public.new_table (
  id uuid primary key default gen_random_uuid(),
  -- columns
  created_at timestamptz not null default now()
);

alter table public.new_table enable row level security;
create policy "allow_all" on public.new_table for all using (true) with check (true);
```

### Adding columns to existing tables
```sql
alter table public.clients add column if not exists new_column text;
```

### Checking what tables exist
```sql
select table_name from information_schema.tables where table_schema = 'public';
```

---

## Auth Management

### Create user via API (requires service role key)
```js
const { data, error } = await supabase.auth.admin.createUser({
  email: 'user@example.com',
  password: 'password',
  email_confirm: true,
  user_metadata: { role: 'director', full_name: 'your name' }
})
```

### Update user role
```sql
update public.profiles set role = 'director' where email = 'ruan@sonke.com.au';
```

### Get service role key
Supabase Dashboard → Settings → API → Service Role Key (secret). Store in secrets.json, never in .env.local.

---

## RLS Policy Patterns

### Development (permissive — allows all authenticated users)
```sql
create policy "allow_all" on public.table_name for all using (true) with check (true);
```

### Production — Director/Admin full access
```sql
create policy "director_admin_full" on public.clients
  for all using (
    (select role from public.profiles where id = auth.uid()) in ('director', 'admin')
  );
```

### Production — Worker sees own shifts only
```sql
create policy "worker_own_shifts" on public.shifts
  for select using (worker_id = auth.uid());
```

### Production — Family sees their client only
```sql
create policy "family_own_client" on public.clients
  for select using (
    id::text = (select raw_user_meta_data->>'client_id' from auth.users where id = auth.uid())
  );
```

---

## Common Errors and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| "Database error creating new user" | Profile row already exists with that email/id, OR trigger fails | Delete conflicting row from profiles table; ensure trigger uses ON CONFLICT DO NOTHING |
| "new row violates row-level security policy" | RLS enabled but no policy exists | Add a policy to the table |
| "permission denied for table profiles" | RLS enabled, no matching policy for current user | Add policy or check user's role |
| "relation already exists" | Running CREATE TABLE without IF NOT EXISTS on existing table | Use DROP TABLE CASCADE first, or ALTER TABLE to add columns |
| Policy name conflict | Running schema twice — second run tries to create same policy name | Use DROP TABLE CASCADE to wipe policies, then recreate |
| "operator does not exist: uuid = text" | Comparing UUID to text in RLS policy | Cast: `id::text = 'some-string'` or use proper UUID |

---

## custom workflow Table Reference

See `references/tables.md` for full schema documentation.

---

## Environment Variables

```env
VITE_SUPABASE_URL=https://uzhlzwcczrfptnrrjfmd.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...  (in .env.local)
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...  (in .env.local)
```

Service role key: stored in `workspace/config/secrets.json` — never expose to frontend.

---

## Data Migration (Mock → Live)

custom workflow uses a fallback pattern: every Supabase call wraps mock data as fallback.

```js
// Pattern from src/lib/db.js
export async function getClients() {
  try {
    const { data, error } = await supabase.from('clients').select('*')
    if (error) throw error
    return { data, error: null }
  } catch (err) {
    console.warn('Supabase unavailable, using mock data:', err.message)
    return { data: MOCK_CLIENTS, error: null }
  }
}
```

Demo mode banner: shown when `VITE_SUPABASE_URL` is not set or connection fails.

---

## Useful SQL Queries

```sql
-- Check all tables and row counts
select schemaname, tablename, n_live_tup
from pg_stat_user_tables
order by n_live_tup desc;

-- Check RLS status on all tables
select tablename, rowsecurity
from pg_tables
where schemaname = 'public';

-- List all policies
select tablename, policyname, cmd, qual
from pg_policies
where schemaname = 'public';

-- Check triggers
select trigger_name, event_object_table, action_timing, event_manipulation
from information_schema.triggers
where trigger_schema = 'public';
```
