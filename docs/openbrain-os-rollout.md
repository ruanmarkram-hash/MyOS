# OpenBrain OS Rollout

## Goal

Make OpenBrain the portable memory and knowledge substrate for MyOS without making core mission execution depend on a remote brain being healthy.

## Stage 1: Truthful Wiring

- Mission Control reports whether OpenBrain search/capture is configured.
- Mission Control reports whether OB-Graph is configured and reachable.
- Brain search/capture keeps SQLite fallback behaviour.
- Brain graph shows real OB-Graph nodes when available, otherwise a clearly labelled local memory topic map.

## Stage 2: OB-Graph Deployment

- Apply `migrations/ob1/003_ob_graph.sql` to the OpenBrain Supabase project.
- Deploy the `ob-graph-mcp` edge function from `vendor/ob1/recipes/ob-graph`.
- Set `MCP_ACCESS_KEY` and `DEFAULT_USER_ID` function secrets.
- Set `OB1_GRAPH_FUNCTION=ob-graph-mcp` in `.env`.
- Restart Sage from Telegram with `/restart`.

## Stage 3: Metadata Discipline

Every new durable thought should carry:

- source type
- source path or URL when available
- confidence
- created-by agent
- mission id when applicable
- sensitivity tier

Old records may be enriched with inferred metadata, but the UI must label it as inferred rather than original.

## Stage 4: Import Pipelines

Import sources one at a time with deduplication and source labels:

- mission manifests and deliverables
- brief action items and useful brief outputs
- decisions and lessons
- selected workspace files
- external exports only after credentials or export files are available

## Stage 5: Local Embeddings

- Configure a local embedding provider.
- Confirm vector dimensions match the OpenBrain schema before switching.
- Backfill embeddings in a controlled job.
- Keep remote and local search comparable until quality is proven.

## Operating Rule

OpenBrain enriches the OS. It must not become a single point of failure for dispatch, review, agent restart, notifications, or mission durability.
