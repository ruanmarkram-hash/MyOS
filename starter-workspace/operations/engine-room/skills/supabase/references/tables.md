# custom workflow — Supabase Table Reference

All tables are in the `public` schema. RLS enabled on all tables.

## profiles
Extends `auth.users`. Auto-created via trigger on user signup.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | FK to auth.users(id) ON DELETE CASCADE |
| role | text | director, admin, teamleader, worker, family, participant |
| full_name | text | |
| email | text | |
| phone | text | |
| created_at | timestamptz | |

## clients
clients receiving support.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| full_name | text | |
| dob | date | |
| address | text | |
| diagnoses | text[] | |
| ndis_number | text | |
| funding_type | text | NDIA Managed, Plan Managed, Self Managed |
| plan_start / plan_end | date | |
| plan_managed_by | text | |
| registration_group | text | legacy single value |
| registration_groups | text[] | core, module-2, module-2a |
| status | text | active, inactive, onboarding, exited |
| created_at | timestamptz | |

## client_contacts
Key contacts for each client (family, guardians, etc.)

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| client_id | uuid FK | → clients(id) CASCADE |
| name | text | |
| relationship | text | |
| phone / email | text | |
| is_primary | boolean | |
| notification_pref | text | email, sms, none |

## client_medications
Medication register per client.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| client_id | uuid FK | → clients(id) CASCADE |
| name | text | |
| dose / route / schedule | text | |
| classification | text | OTC, S4, S8 |
| competency_required | text | |
| notes | text | |

## shifts
Scheduled and completed support shifts.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| client_id | uuid FK | → clients(id) CASCADE |
| worker_id | uuid FK | → profiles(id) SET NULL |
| start_time / end_time | timestamptz | |
| status | text | scheduled, in_progress, completed, cancelled |
| location_lat / location_lng | double precision | GPS clock-in location |
| geofence_radius | integer | metres |
| cancellation_tier / reason | text | SCHADS tiers 1-3 |
| created_at | timestamptz | |

## shift_notes
Shift notes — gate must be complete before timesheet submission.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| shift_id | uuid FK | → shifts(id) CASCADE |
| worker_id | uuid FK | → profiles(id) CASCADE |
| client_id | uuid FK | → clients(id) CASCADE |
| note_text | text | |
| submitted_at | timestamptz | |
| note_gate_complete | boolean | |

## incidents
Incident reports — reportable incidents go to regulator.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| client_id | uuid FK | → clients(id) CASCADE |
| reported_by | uuid FK | → profiles(id) SET NULL |
| occurred_at | timestamptz | |
| type / severity | text | severity: low, medium, high, critical |
| description / actions_taken | text | |
| notified_parties | text[] | |
| created_at | timestamptz | |

## invoices
Billing records — PRODA CSV export.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| client_id | uuid FK | → clients(id) CASCADE |
| period_start / period_end | date | |
| line_items | jsonb | array of {support_item, hours, rate, total} |
| total | numeric(10,2) | |
| status | text | draft, sent, paid, overdue, void |
| funding_type | text | |
| created_at | timestamptz | |

## referral_contacts
Business development — referral partner relationships.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| name / organisation / role | text | |
| phone / email | text | |
| notes | text | |
| relationship_strength | text | cold, warm, strong |
| created_at | timestamptz | |

## business_profile
Single row — organisation settings.

| Column | Type | Default |
|--------|------|---------|
| id | uuid PK | |
| org_name | text | Example Organisation Pty Ltd |
| trading_name | text | Example Organisation |
| abn | text | 00 000 000 000 |
| phone_primary | text | 0000 000 000 |
| email_general | text | info@example.com |
| website | text | www.example.com |
| address | text | City State Postcode |
| ndis_reg_number | text | registration-number |
| ndis_reg_expiry | date | |

## client_prospects
Prospect intake flow — 60-second phone call capture before full client creation.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | gen_random_uuid() |
| org_id | uuid FK | references organisations(id) |
| participant_first_name | text NOT NULL | Child/participant's first name |
| guardian_name | text | Parent/guardian name |
| guardian_phone | text | Upsert key — same phone = same prospect |
| guardian_email | text | |
| support_type | text | e.g. daily_living, community_access, behaviour |
| intake_step_current | integer NOT NULL | Default 1 (auto-advances on create) |
| status | text NOT NULL | active, converted, archived |
| converted_client_id | uuid FK | Links to clients(id) after conversion |
| notes | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | Auto-updated via trigger |

**RPC function:** `upsert_client_prospect(p_participant_first_name, p_guardian_name, p_guardian_phone, p_guardian_email, p_support_type)` → returns `{ prospect_id, intake_link, intake_step_current, is_new }`

## documents
Document management — unified library with registration group tags.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| name / description | text | |
| file_path | text | Supabase Storage path |
| document_type | text | policy, procedure, form_template, sop, client_doc, staff_doc, register, other |
| registration_groups | text[] | core, module-2, module-2a |
| access_level | text | director, admin, all_staff, per_client, per_staff |
| client_id | uuid FK | null for company-wide docs |
| staff_id | uuid FK | null for non-staff docs |
| status | text | active, archived, pending_review |
| version | text | |
| review_date | date | |
| uploaded_by | uuid FK | |
| uploaded_at | timestamptz | |
| signed_at / signed_by | timestamptz / text | |
| archived_date | timestamptz | Nullable. Set when document is archived |
| is_current | boolean | Default true. False = archived |

## archive_queue
Tracks SharePoint file move operations for document archiving.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | gen_random_uuid() |
| document_id | uuid FK | → documents(id) CASCADE |
| old_sharepoint_path | text NOT NULL | Original file location |
| new_sharepoint_path | text NOT NULL | Target archive location |
| status | archive_status ENUM | pending, in_progress, completed, failed |
| error_message | text | Nullable. Last error if failed |
| retry_count | integer | Default 0 |
| max_retries | integer | Default 3 |
| created_at | timestamptz | |
| completed_at | timestamptz | Nullable. Set on completion |
| next_retry_at | timestamptz | Nullable. Scheduled retry time |

## archive_audit_log
Immutable audit trail for archive queue operations.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | gen_random_uuid() |
| queue_id | uuid FK | → archive_queue(id) CASCADE |
| action | archive_action ENUM | queued, move_started, move_success, move_failed, retried, abandoned |
| details | jsonb | Nullable. Structured event details |
| created_at | timestamptz | |
| tags | text[] | |
