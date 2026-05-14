---
name: live-retrieval
description: |
  ALWAYS search Open Brain via the brain-mcp tools BEFORE claiming you don't know
  something the user is asking about. This skill is mandatory when the user asks
  any factual question about their own past decisions, preferences, people,
  projects, config, code, or history. Fires silently — search first, answer from
  results. Only say "I don't know" after search_thoughts returns nothing.
  Also fires on topic shifts (new person, project, or technology mentioned).
author: your name
version: 2.0.0
---

# Live Retrieval

Surface relevant Open Brain thoughts before answering questions about the user's
own context. The user has a persistent brain at `brain-mcp` (MCP tools
`search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought`).
Assume it knows things you don't.

## Core Rule

> Never say "I don't have memory of that" or "I don't know" or "could you remind
> me" until you have called `search_thoughts` against the user's question.

This applies every time. No exceptions for short questions, casual phrasing, or
uncertainty about whether the brain will have the answer.

## When to Fire

### 1. Factual recall questions (MANDATORY)

Any question shaped like:
- "What did I decide about...?"
- "What's my [preference / config / rule / value] for...?"
- "Do you remember...?"
- "What colour / number / path / port / version...?"
- "How did I... / Why did I...?"
- "What's the status of...?"

→ Call `search_thoughts({ query: "<user's question verbatim>", limit: 5, threshold: 0.4 })`
   BEFORE composing your reply.

If results come back, use them to answer directly.
If results are empty, say so and offer to broaden the search — don't claim you
have no memory.

### 2. Session start

When a new session begins, if the user's first message is already a factual
question, run the search immediately. Otherwise run:

```
list_thoughts({ limit: 5 })
```

to see what's recent. Surface only if relevant.

### 3. Topic shift detection

When the user's message introduces a new entity (person name, project name,
technology, place) that wasn't in the previous messages, search for it.

## How to Detect Factual Recall

A question is factual-recall if it asks for something **the user once said or
decided**. Signs:
- Past-tense verbs referring to user actions: "did", "chose", "picked", "decided"
- Possessive references: "my", "our", "the [project]'s"
- Specific values being requested (numbers, names, hex codes, paths, ports)
- Direct "do you remember" / "do you know" prompts

If in doubt, search. A cheap search that misses is better than a confident "I
don't know" that's wrong.

## How to Surface Results

**On hit (any result above threshold):**

Answer the user's question using the retrieved content. Inline the specific fact
they asked for. Quote the captured thought verbatim if a precise value matters.
Do NOT prepend "[OB1: found N thoughts]" — just answer.

**On miss:**

Reply plainly: "I searched the brain and didn't find anything on that." Offer to
search with broader terms if the user wants. Do not say "I don't remember"
without having searched first.

## Rules

1. **Never skip the search on factual questions.** The brain exists for this.
2. **Use the user's own wording as the query.** Don't rewrite their question.
3. **Threshold 0.4** for factual recall — lower than default so you catch
   loosely-worded matches.
4. **One search per question** is fine. Don't spam.
5. **Keep the response focused.** Answer the question; skip retrieval metadata
   unless the user asks where it came from.

## Failure Behavior

| Failure | What Happens |
|---------|-------------|
| brain-mcp tool unavailable | Only then say "I can't reach the brain right now." |
| Search returns error | Note the error briefly, offer to retry. |
| Results are low-score | Say so honestly: "closest match was X% — may not be what you meant." |
