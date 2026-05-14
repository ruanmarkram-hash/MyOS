# Design Context: Starting from What Already Exists

**This is the most important one thing about this skill.**

Good hi-fi design always grows from existing design context. **Making hi-fi from scratch is the last resort and will always produce generic work.** So at the start of every design task, first ask: is there anything to reference?

## What is Design Context

In priority order from highest to lowest:

### 1. The User's Design System / UI Kit
The component library, color tokens, type specifications, and icon system already in the user's product. **The ideal scenario.**

### 2. The User's Codebase
If the user has provided a codebase, it contains living component implementations. Read those files:
- `theme.ts` / `colors.ts` / `tokens.css` / `_variables.scss`
- Specific components (Button.tsx, Card.tsx)
- Layout scaffold (App.tsx, MainLayout.tsx)
- Global stylesheets

**Read the code and lift exact values**: hex codes, spacing scale, font stack, border radius. Do not redraw from memory.

### 3. The User's Deployed Product
If the user has a live product but hasn't provided the code, use Playwright or ask the user to provide screenshots.

```bash
# Screenshot a public URL using Playwright
npx playwright screenshot https://example.com screenshot.png --viewport-size=1920,1080
```

This shows you the real visual vocabulary.

### 4. Brand Guidelines / Logo / Existing Assets
The user may have: a logo file, brand color spec, marketing materials, slide templates. All of these are context.

### 5. Competitor References
The user says "like XX website" — ask them to provide a URL or screenshot. **Do not** rely on the vague impressions in your training data.

### 6. Known Design Systems (Fallback)
If none of the above are available, use a recognized design system as the base:
- Apple HIG
- Material Design 3
- Radix Colors (for color)
- shadcn/ui (for components)
- Tailwind default palette

Be explicit with the user about what you're using, and make clear this is the starting point, not the final design.

## Process for Getting Context

### Step 1: Ask the User

The required checklist at the start of a task (from `workflow.md`):

```markdown
1. Do you have an existing design system / UI kit / component library? Where is it?
2. Do you have brand guidelines, color/type specs?
3. Can you give me screenshots or a URL of your current product?
4. Is there a codebase I can read?
```

### Step 2: When the User Says "No," Help Them Find Something

Don't give up immediately. Try:

```markdown
Let me see if there are any clues:
- Do you have related design from a previous project?
- What colors/fonts does your company's marketing website use?
- What style is your product's logo? Can you send me an image?
- Is there a product you admire that you'd like to reference?
```

### Step 3: Read All the Context You Can Find

If the user has given a codebase path, read:
1. **List the file structure first**: look for style/theme/component-related files
2. **Read theme/token files**: lift the specific hex/px values
3. **Read 2-3 representative components**: look at the visual vocabulary (hover states, shadows, borders, padding patterns)
4. **Read the global stylesheet**: base resets, font loading
5. **If there's a Figma link/screenshot**: look at it, but **trust the code more**

**Important**: **Do not** glance at it once and then work from impression. You haven't really lifted the context until you've extracted 30+ specific values.

### Step 4: Vocalize the System You're Going to Use

After reading the context, tell the user what system you're working with:

```markdown
Based on your codebase and product screenshots, here's the design system I've extracted:

**Color**
- Primary: #C27558 (from tokens.css)
- Background: #FDF9F0
- Text: #1A1A1A
- Muted: #6B6B6B

**Typography**
- Display: Instrument Serif (from global.css @font-face)
- Body: Geist Sans
- Mono: JetBrains Mono

**Spacing** (from your scale system)
- 4, 8, 12, 16, 24, 32, 48, 64

**Shadow pattern**
- `0 1px 2px rgba(0,0,0,0.04)` (subtle card)
- `0 10px 40px rgba(0,0,0,0.1)` (elevated modal)

**Border-radius**
- Small components 4px, cards 12px, buttons 8px

**Component vocabulary**
- Button: filled primary, outlined secondary, ghost tertiary — all 8px rounded
- Card: white background, subtle shadow, no border

I'll start building with this system. Confirm this looks right?
```

Wait for user confirmation before starting work.

## Designing Without Context (Fallback When Nothing Is Available)

**Strong warning**: output quality will be significantly lower in this scenario. Tell the user clearly.

```markdown
You have no design context, so I can only work from general intuition.
The result will be "looks OK but lacks distinctiveness."
Do you want to continue, or would you like to gather some reference material first?
```

If the user insists you proceed, follow this decision sequence:

### 1. Choose an Aesthetic Direction
Do not produce a generic result. Pick one clear direction:
- brutally minimal
- editorial/magazine
- brutalist/raw
- organic/natural
- luxury/refined
- playful/toy
- retro-futuristic
- soft/pastel

Tell the user which one you chose.

### 2. Choose a Known Design System as the Skeleton
- Use Radix Colors for the color palette (https://www.radix-ui.com/colors)
- Use shadcn/ui for component vocabulary (https://ui.shadcn.com)
- Use Tailwind spacing scale (multiples of 4)

### 3. Choose a Distinctive Font Pairing

Avoid Inter/Roboto. Suggested combinations (available free from Google Fonts):
- Instrument Serif + Geist Sans
- Cormorant Garamond + Inter Tight
- Bricolage Grotesque + Sohne (paid)
- Fraunces + Work Sans (note: Fraunces is already overused by AI)
- JetBrains Mono + Geist Sans (technical feel)

### 4. Every Key Decision Has Reasoning

Do not choose silently. Write it in an HTML comment:

```html
<!--
Design decisions:
- Primary color: warm terracotta (oklch 0.65 0.18 25) — fits the "editorial" direction
- Display: Instrument Serif for humanist, literary feel
- Body: Geist Sans for cleanness contrast
- No gradients — committed to minimal, no AI slop
- Spacing: 8px base, golden ratio friendly (8/13/21/34)
-->
```

## Import Strategy (When the User Provides a Codebase)

If the user says "import this codebase as reference":

### Small (<50 files)
Read everything; internalize the context.

### Medium (50-500 files)
Focus on:
- `src/components/` or `components/`
- All style/token/theme-related files
- 2-3 representative full-page components (Home.tsx, Dashboard.tsx)

### Large (>500 files)
Ask the user to specify a focus area:
- "I want to build a settings page" → read existing settings-related files
- "I want to build a new feature" → read the overall shell + the closest reference
- Aim for precision, not completeness

## Working with Figma / Design Mockups

If the user provides a Figma link:

- **Do not** expect to "convert Figma to HTML" directly — that requires additional tooling
- Figma links are usually not publicly accessible
- Ask the user to: export as a **screenshot** and send it to you + tell you the specific color/spacing values

If you only have a Figma screenshot, tell the user:
- I can see the visuals, but I can't extract exact values
- Please tell me the key numbers (hex, px), or export as code (Figma supports this)

## Final Reminder

**The quality ceiling of a project's design is determined by the quality of the context you have.**

10 minutes spent collecting context is more valuable than 1 hour drawing hi-fi from scratch.

**When there's no context, prioritize asking the user for it rather than pushing ahead without it.**
