# Design Critique In-Depth Guide

> Detailed reference for Phase 7. Provides scoring rubrics, scene-specific emphasis, and a common issues checklist.

---

## Scoring Rubric Detail

### 1. Philosophy Alignment

| Score | Criteria |
|------|------|
| 9-10 | Design perfectly embodies the core spirit of the chosen philosophy; every detail is philosophically grounded |
| 7-8 | Overall direction is correct, key characteristics are present; isolated details deviate |
| 5-6 | Intent is visible, but execution mixes in elements from other styles — not pure enough |
| 3-4 | Surface imitation only; the philosophical core is not understood |
| 1-2 | Essentially unrelated to the chosen philosophy |

**Critique focus**:
- Does it use the signature techniques of the chosen designer/studio?
- Do the color, typography, and layout comply with the philosophy's system?
- Are there any "self-contradicting" elements? (e.g., chose Kenya Hara but packed it with content)

### 2. Visual Hierarchy

| Score | Criteria |
|------|------|
| 9-10 | The viewer's eye naturally flows along the designer's intended path; zero friction in information retrieval |
| 7-8 | Primary/secondary relationships are clear; 1-2 hierarchy levels are occasionally ambiguous |
| 5-6 | Title and body can be distinguished, but the intermediate levels are muddled |
| 3-4 | Information is laid out flat with no clear visual entry point |
| 1-2 | Chaotic; the user does not know where to look first |

**Critique focus**:
- Is the size contrast between heading and body text sufficient? (at least 2.5x)
- Do color/weight/size establish 3-4 clear levels?
- Is whitespace guiding the eye?
- "Squint test": squint and look — is the hierarchy still clear?

### 3. Craft Quality

| Score | Criteria |
|------|------|
| 9-10 | Pixel-perfect precision; zero flaws in alignment, spacing, or color |
| 7-8 | Overall polished; 1-2 minor alignment/spacing issues |
| 5-6 | Basically aligned, but spacing is inconsistent and color use is not systematic |
| 3-4 | Obvious alignment errors, chaotic spacing, too many colors |
| 1-2 | Rough — looks like a draft |

**Critique focus**:
- Is a consistent spacing system in use (e.g., 8pt grid)?
- Is spacing between like elements consistent?
- Is the number of colors controlled? (typically no more than 3-4)
- Is the type family unified? (typically no more than 2)
- Is edge alignment precise?

### 4. Functionality

| Score | Criteria |
|------|------|
| 9-10 | Every design element serves the goal; zero redundancy |
| 7-8 | Clearly function-oriented; a small amount of decoration could be removed |
| 5-6 | Basically usable, but obviously decorative elements distract from the message |
| 3-4 | Form over function; the user has to work to find information |
| 1-2 | Completely buried in decoration; has lost the ability to communicate information |

**Critique focus**:
- If any element were removed, would the design suffer? (If not, it should be cut)
- Is the CTA/key information in the most prominent position?
- Are there elements added "because they look good"?
- Does information density match the medium? (PPT should not be too dense; PDF can be denser)

### 5. Originality

| Score | Criteria |
|------|------|
| 9-10 | Feels fresh; found a distinctive expression within the philosophy's framework |
| 7-8 | Has its own ideas; not simply a template fill-in |
| 5-6 | Competent but looks templated |
| 3-4 | Heavy use of clichés (e.g., gradient spheres to represent AI) |
| 1-2 | Entirely assembled from templates or stock assets |

**Critique focus**:
- Does it avoid common clichés? (see "Common Issues Checklist" below)
- Does it have personal expression while adhering to the design philosophy?
- Are there any "unexpected but perfectly right" design decisions?

---

## Scene-Specific Critique Focus

Different output types have different review priorities:

| Scene | Most important dimension | Secondary | Can be relaxed |
|------|-----------|--------|--------|
| Social media cover / illustration | Originality, Visual Hierarchy | Philosophy Alignment | Functionality (single image, no interaction) |
| Infographic | Functionality, Visual Hierarchy | Craft Quality | Originality (accuracy first) |
| PPT/Keynote | Visual Hierarchy, Functionality | Craft Quality | Originality (clarity first) |
| PDF/White paper | Craft Quality, Functionality | Visual Hierarchy | Originality (professionalism first) |
| Landing page / website | Functionality, Visual Hierarchy | Originality | — (all dimensions required) |
| App UI | Functionality, Craft Quality | Visual Hierarchy | Philosophy Alignment (usability first) |
| Short-form social image | Originality, Visual Hierarchy | Philosophy Alignment | Craft Quality (atmosphere first) |

---

## Top 10 Common Design Issues

### 1. AI Tech Clichés
**Problem**: Gradient spheres, digital rain, blue circuit boards, robot faces
**Why it's a problem**: Users are visually fatigued by these; you become indistinguishable from everyone else
**Fix**: Replace literal symbols with abstract metaphors (e.g., use a "dialogue" metaphor rather than a chat bubble icon)

### 2. Insufficient Type Scale
**Problem**: The gap between heading and body is too small (<2.5x)
**Why it's a problem**: Users cannot quickly locate key information
**Fix**: Heading should be at least 3x the body size (e.g., body 16px → heading 48-64px)

### 3. Too Many Colors
**Problem**: Using 5+ colors with no clear hierarchy
**Why it's a problem**: Visual confusion; weak brand identity
**Fix**: Limit to 1 primary + 1 secondary + 1 accent + grey scale

### 4. Inconsistent Spacing
**Problem**: Arbitrary spacing between elements with no system
**Why it's a problem**: Looks unprofessional; chaotic visual rhythm
**Fix**: Establish an 8pt grid system (spacing only in 8/16/24/32/48/64px increments)

### 5. Insufficient Whitespace
**Problem**: All available space is filled with content
**Why it's a problem**: Crowded information causes reading fatigue and actually reduces communication efficiency
**Fix**: Whitespace should occupy at least 40% of the total area (60%+ for minimal styles)

### 6. Too Many Typefaces
**Problem**: Using 3 or more typefaces
**Why it's a problem**: Visual noise; weakens cohesion
**Fix**: 2 typefaces maximum (1 for headings + 1 for body); use weight and size to create variation

### 7. Inconsistent Alignment
**Problem**: Some elements left-aligned, some centered, some right-aligned
**Why it's a problem**: Destroys visual order
**Fix**: Choose one alignment (left-align recommended) and apply it globally

### 8. Decoration Overpowering Content
**Problem**: Background patterns/gradients/shadows upstage the main content
**Why it's a problem**: Priorities are inverted; users come to read information, not admire decoration
**Fix**: "If I removed this decoration, would the design suffer?" If not, remove it

### 9. Overuse of Cyber Neon
**Problem**: Dark blue background (#0D1117) + neon glow effects
**Why it's a problem**: Default aesthetic prohibited zone (the taste baseline for this skill), and one of the biggest clichés — user can override per their own brand
**Fix**: Choose a more distinctive color scheme (refer to the color systems of the 20 styles)

### 10. Information Density Mismatch with Medium
**Problem**: A full page of text in a PPT slide / 10 elements crammed into a cover image
**Why it's a problem**: Different media have different optimal information densities
**Fix**:
- PPT: one core point per slide
- Cover image: one visual focal point
- Infographic: layered presentation
- PDF: can be denser, but needs clear navigation

---

## Critique Output Template

```
## Design Critique Report

**Overall Score**: X.X/10 [Excellent (8+) / Good (6-7.9) / Needs Improvement (4-5.9) / Failing (<4)]

**Dimension Scores**:
- Philosophy Alignment: X/10 [one-line explanation]
- Visual Hierarchy: X/10 [one-line explanation]
- Craft Quality: X/10 [one-line explanation]
- Functionality: X/10 [one-line explanation]
- Originality: X/10 [one-line explanation]

### Strengths (Keep)
- [Specifically identify what works, described in design language]

### Issues (Fix)
[Ordered by severity]

**1. [Issue name]** — ⚠️ Critical / ⚡ Important / 💡 Optimize
- Current: [describe the current state]
- Problem: [why this is a problem]
- Fix: [specific action, including numeric values]

### Quick Wins
If you only have 5 minutes, prioritize these 3 things:
- [ ] [Highest-impact fix]
- [ ] [Second most important fix]
- [ ] [Third most important fix]
```

---

**Version**: v1.0
**Updated**: 2026-02-13
