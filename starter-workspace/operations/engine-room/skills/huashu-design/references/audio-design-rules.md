# Audio Design Rules · huashu-design

> The audio recipe applied to all animation demos. Use alongside `sfx-library.md` (asset inventory).
> Battle-tested: huashu-design hero v1-v9 iterations · Gemini deep-analysis of 3 official Anthropic videos · 8000+ A/B comparisons

---

## Core Principle · Dual-Track Audio (Hard Rule)

Animation audio **must be designed as two independent layers** — you cannot do only one:

| Layer | Role | Time Scale | Relationship to Visuals | Frequency Range |
|---|---|---|---|---|
| **SFX (beat layer)** | Marks each visual beat | 0.2-2s brief hits | **Strong sync** (frame-level alignment) | **High freq 800Hz+** |
| **BGM (ambient bed)** | Emotional foundation, sound field | Continuous 20-60s | Weak sync (section-level) | **Mid-low freq <4kHz** |

**Animation with only BGM is crippled** — audiences subconsciously notice "visuals are moving but nothing responds in sound." This is the root cause of that cheap feeling.

---

## Gold Standard · Golden Ratios

These values were derived from measured engineering parameters across 3 official Anthropic videos + our own v9 final comparison. Apply them directly:

### Volume
- **BGM volume**: `0.40-0.50` (relative to full scale 1.0)
- **SFX volume**: `1.00`
- **Loudness gap**: BGM peak **-6 to -8 dB** below SFX peak (clarity comes from loudness difference, not SFX absolute volume)
- **amix parameter**: `normalize=0` (never use normalize=1 — it crushes dynamic range)

### Frequency Band Isolation (P1 Hard Optimization)
Anthropic's secret is not "SFX volume high" — it's **frequency layering**:

```bash
[bgm_raw]lowpass=f=4000[bgm]      # BGM confined to mid-low freq <4kHz
[sfx_raw]highpass=f=800[sfx]      # SFX pushed to mid-high freq 800Hz+
[bgm][sfx]amix=inputs=2:duration=first:normalize=0[a]
```

Why: Human hearing is most sensitive in the 2-5kHz range (the "presence band"). If SFX all sit in this range and BGM covers full spectrum, **SFX gets masked by BGM's high-frequency content**. Using highpass to push SFX up + lowpass to push BGM down means each occupies its own spectral territory — SFX clarity jumps a full tier.

### Fade
- BGM in: `afade=in:st=0:d=0.3` (0.3s, avoids hard cut)
- BGM out: `afade=out:st=N-1.5:d=1.5` (1.5s long tail, sense of closure)
- SFX has built-in envelope, no extra fade needed

---

## SFX Cue Design Rules

### Density (SFX count per 10 seconds)
Measured SFX density across 3 Anthropic videos — three tiers:

| Video | SFX per 10s | Product Character | Scene |
|---|---|---|---|
| Artifacts (ref-1) | **~9/10s** | Dense features, lots of info | Complex tool demo |
| Code Desktop (ref-2) | **0** | Pure atmosphere, meditative | Developer focus state |
| Word (ref-3) | **~4/10s** | Balanced, office rhythm | Productivity tool |

**Heuristics**:
- Product character is calm/focused → Low SFX density (0-3/10s), BGM-driven
- Product character is lively/info-heavy → High SFX density (6-9/10s), SFX drives rhythm
- **Don't fill every visual beat** — negative space is more sophisticated than density. **Deleting 30-50% of cues makes the remaining ones more dramatic**.

### Cue Selection Priority
Not every visual beat needs an SFX. Select by this priority:

**P0 Must-have** (omitting feels wrong):
- Typing (terminal/input)
- Click/select (user decision moment)
- Focus switch (visual subject transfer)
- Logo reveal (brand closure)

**P1 Recommended**:
- Element entry/exit (modal / card)
- Completion/success feedback
- AI generation start/end
- Major transition (scene change)

**P2 Optional** (too many will clutter):
- hover / focus-in
- Progress tick
- Decorative ambient

### Timestamp Alignment Precision
- **Same-frame alignment** (0ms error): click / focus switch / logo land
- **1-2 frames early** (-33ms): fast whoosh (gives audience anticipatory cue)
- **1-2 frames late** (+33ms): object landing / impact (matches real physics)

---

## BGM Selection Decision Tree

huashu-design skill ships with 6 BGM tracks (`assets/bgm-*.mp3`):

```
What is the animation's character?
├─ Product launch / tech demo → bgm-tech.mp3 (minimal synth + piano)
├─ Tutorial / tool walkthrough → bgm-tutorial.mp3 (warm, instructional)
├─ Educational / concept explanation → bgm-educational.mp3 (curious, thoughtful)
├─ Marketing / brand promotion → bgm-ad.mp3 (upbeat, promotional)
└─ Need a variation of the same style → bgm-*-alt.mp3 (respective alternates)
```

### Scenes Where No BGM Works (worth considering)
Reference Anthropic Code Desktop (ref-2): **0 SFX + pure Lo-fi BGM** can still be high-end.

**When to choose no BGM**:
- Animation under 10s (BGM can't establish itself)
- Product character is "focused/meditative"
- Scene already has ambient sound / voiceover
- Very high SFX density (avoid auditory overload)

---

## Scene Recipes (Ready to Use)

### Recipe A · Product Launch Hero (same as huashu-design v9)
```
Duration: 25s
BGM: bgm-tech.mp3 · 45% · freq band <4kHz
SFX density: ~6/10s

Cues:
  Terminal typing → type × 4 (0.6s intervals)
  Enter          → enter
  Cards converge → card × 4 (staggered 0.2s)
  Select         → click
  Ripple         → whoosh
  4 focus beats  → focus × 4
  Logo           → thud (1.5s)

Volume: BGM 0.45 / SFX 1.0 · amix normalize=0
```

### Recipe B · Tool Feature Demo (reference: Anthropic Code Desktop)
```
Duration: 30-45s
BGM: bgm-tutorial.mp3 · 50%
SFX density: 0-2/10s (very sparse)

Strategy: Let BGM + voiceover drive; SFX only at decisive moments (file save / command completion)
```

### Recipe C · AI Generation Demo
```
Duration: 15-20s
BGM: bgm-tech.mp3 or no BGM
SFX density: ~8/10s (high density)

Cues:
  User input → type + enter
  AI starts processing → magic/ai-process (1.2s loop)
  Generation complete → feedback/complete-done
  Result appears → magic/sparkle

Highlight: ai-process can loop 2-3 times across the entire generation process
```

### Recipe D · Pure Atmosphere Long Take (reference: Artifacts)
```
Duration: 10-15s
BGM: none
SFX: 3-5 carefully designed cues used solo

Strategy: Each SFX is the lead actor — no "blending into mush" from BGM.
Best for: Single product slow-motion, close-up showcase
```

---

## ffmpeg Composition Templates

### Template 1 · Single SFX Overlay on Video
```bash
ffmpeg -y -i video.mp4 -itsoffset 2.5 -i sfx.mp3 \
  -filter_complex "[0:a][1:a]amix=inputs=2:normalize=0[a]" \
  -map 0:v -map "[a]" output.mp4
```

### Template 2 · Multi-SFX Timeline Composition (aligned to cue timestamps)
```bash
ffmpeg -y \
  -i sfx-type.mp3 -i sfx-enter.mp3 -i sfx-click.mp3 -i sfx-thud.mp3 \
  -filter_complex "\
[0:a]adelay=1100|1100[a0];\
[1:a]adelay=3200|3200[a1];\
[2:a]adelay=7000|7000[a2];\
[3:a]adelay=21800|21800[a3];\
[a0][a1][a2][a3]amix=inputs=4:duration=longest:normalize=0[mixed]" \
  -map "[mixed]" -t 25 sfx-track.mp3
```
**Key parameters**:
- `adelay=N|N`: first value is left channel delay (ms), second is right — write both to ensure stereo alignment
- `normalize=0`: preserves dynamic range — critical!
- `-t 25`: truncates to specified duration

### Template 3 · Video + SFX Track + BGM (with frequency band isolation)
```bash
ffmpeg -y -i video.mp4 -i sfx-track.mp3 -i bgm.mp3 \
  -filter_complex "\
[2:a]atrim=0:25,afade=in:st=0:d=0.3,afade=out:st=23.5:d=1.5,\
     lowpass=f=4000,volume=0.45[bgm];\
[1:a]highpass=f=800,volume=1.0[sfx];\
[bgm][sfx]amix=inputs=2:duration=first:normalize=0[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k final.mp4
```

---

## Failure Mode Quick Reference

| Symptom | Root Cause | Fix |
|---|---|---|
| SFX inaudible | BGM high-freq content masking SFX | Add `lowpass=f=4000` to BGM + `highpass=f=800` to SFX |
| Sound effects too harsh/loud | SFX absolute volume too high | Reduce SFX to 0.7, BGM to 0.3 — maintain the gap |
| BGM and SFX rhythm clash | Wrong BGM choice (strong-beat music) | Switch to ambient / minimal synth BGM |
| BGM cuts abruptly at end | No fade out | `afade=out:st=N-1.5:d=1.5` |
| SFX overlap into mush | Too many cues + individual SFX too long | Keep SFX duration under 0.5s, cue interval >= 0.2s |
| WeChat mp4 has no audio | WeChat sometimes mutes auto-play | No action needed — user hears audio when they open it; GIF never had audio anyway |

---

## Visual-Audio Pairing (Advanced)

### SFX Timbre Should Match Visual Style
- Warm beige / paper-texture visuals → SFX with **woody/soft** timbre (Morse, paper snap, soft click)
- Cold hi-tech visuals → SFX with **metallic/digital** timbre (beep, pulse, glitch)
- Hand-drawn / playful visuals → SFX with **cartoon/exaggerated** timbre (boing, pop, zap)

Our current `apple-gallery-showcase.md` warm beige base → pairs with `keyboard/type.mp3` (mechanical) + `container/card-snap.mp3` (soft) + `impact/logo-reveal-v2.mp3` (cinematic bass)

### SFX Can Guide Visual Rhythm
Advanced technique: **design the SFX timeline first, then adjust visual animations to align with SFX** (not the other way around).
Each SFX cue is a "clock tick" — visual animations adapting to the SFX rhythm stay rock-solid. The reverse (SFX chasing visuals) often results in ±1-frame misalignment that feels off.

---

## Quality Checklist (Pre-publish Self-check)

- [ ] Loudness gap: SFX peak - BGM peak = -6 to -8 dB?
- [ ] Frequency bands: BGM lowpass 4kHz + SFX highpass 800Hz?
- [ ] amix normalize=0 (preserves dynamic range)?
- [ ] BGM fade-in 0.3s + fade-out 1.5s?
- [ ] SFX count appropriate (density matched to scene character)?
- [ ] Each SFX aligned to visual beat within ±1 frame?
- [ ] Logo reveal SFX duration sufficient (recommend 1.5s)?
- [ ] Mute BGM and listen once: is SFX alone rhythmically satisfying?
- [ ] Mute SFX and listen once: does BGM alone have emotional arc?

Both layers should stand alone when listened to individually. If it only sounds good with both layers combined, the design work isn't done.

---

## References

- SFX asset inventory: `sfx-library.md`
- Visual style reference: `apple-gallery-showcase.md`
- In-depth audio analysis of 3 Anthropic videos: `/Users/alchain/Documents/writing/01-WeChat-articles/projects/2026.04-huashu-design-launch/reference-animations/AUDIO-BEST-PRACTICES.md`
- huashu-design v9 real-world case study: `/Users/alchain/Documents/writing/01-WeChat-articles/projects/2026.04-huashu-design-launch/assets/hero-animation-v9-final.mp4`
