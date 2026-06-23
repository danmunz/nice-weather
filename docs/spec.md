# Product Specification: isitniceout.com

## 1. Core Concept

A minimalist, single-serving web application that answers one question: **"Is it nice out?"**

It requests the user's browser location, queries the National Weather Service (NWS) API, runs the data through a strict comfort algorithm, and delivers an unpretentious, direct answer. All logic runs client-side. The site is deployed as a static asset on GitHub Pages with zero server infrastructure.

---

## 2. Architecture Overview

### 2.1 Deployment & Hosting

| Concern | Decision |
|---------|----------|
| Host | GitHub Pages (custom domain: `isitniceout.com`) |
| Build | None required. Ship a single `index.html` with inlined CSS and JS. If the JS exceeds ~300 lines, split into `style.css` and `app.js` as separate files in the repo root. |
| CI/CD | GitHub Actions deploys `main` branch to Pages on push. |
| SSL | Provided by GitHub Pages (enforced via HTTPS). |

### 2.2 Technology Stack

* **Markup/Style**: Semantic HTML5, vanilla CSS (no preprocessor).
* **Logic**: Vanilla ES2022+ JavaScript (no framework, no transpilation).
* **External dependencies**: None. Zero `node_modules`.

### 2.3 Browser Support

Target: last 2 major versions of Chrome, Safari, Firefox, and Edge. The Geolocation API and Fetch API are baseline in all targets.

### 2.4 CORS Constraint

The browser **cannot** set a custom `User-Agent` header on cross-origin requests — doing so triggers a CORS preflight that `api.weather.gov` does not support. The app must rely solely on CORS-safelisted headers (see Section 4.2). The browser's built-in User-Agent will identify the client to NWS.

---

## 3. User Experience & Interface States

The interface is entirely typographical — no icons, images, or weather illustrations. Content is centered vertically and horizontally on the viewport. Dark/light mode follows `prefers-color-scheme` automatically.

### State A: Initial Load (every visit)

* **Text**: "is it nice out"
* **Style**: Lowercase, centered, rendered as a `<button>` with a visible underline and hover/press feedback (see Section 7.4). Must be immediately recognizable as interactive.
* **Behavior**: On click, disable the button, call `navigator.geolocation.getCurrentPosition()`, and transition to State B. If a pipeline is already in-flight, abort it via `AbortController` before starting a new one.
* **Note**: The click is always required, even on repeat visits. There is no auto-fetch.

### State B: Loading

* **Text**: "checking..."
* **Style**: Same position and size as State A text; replaces it in-place. Text pulses with an opacity animation (1 → 0.4 → 1, 1.5s loop) to signal the system is alive.
* **Timeout escalation**: If State B persists longer than 5 seconds, append "still working..." below. If longer than 12 seconds, replace with "this is taking a while — hang on."

### State C: Nice Out (all checks pass, no alerts)

* **Main text**: "YES"
* **Detail lines** (smaller text, staggered entrance, all shown):
  * "It's [temp]° and [sky description]." — e.g., "It's 72° and sunny."
  * "Wind is [speed] mph." — e.g., "Wind is 6 mph."
* **Return affordance**: Below the footer, subtle text: "check again" — a tappable `<button>` that resets to State A.
* **Footer**: "Data from the National Weather Service." — "National Weather Service" is a link to the observation station's page.

### State D: Nice Out, But Alert Active

This state fires when all comfort checks pass BUT one or more active watches/advisories exist.

* **Main text**: "YES"
* **Detail lines**: Same as State C.
* **Alert banner** (below details, in amber, visually distinct):
  * "but a [Alert Event Name] is in effect until [expiry time]" — rendered as an `<a>` link to the NWS alert URL.
  * If multiple alerts: show each on its own line, each linked.
* **Extreme-severity override**: If any alert has `properties.severity === "Extreme"` (e.g., Tornado Warning), override to State E with the failure reason: "There's a [event name] right now." — regardless of comfort check results.
* **Return affordance**: Same as State C.
* **Footer**: Same as State C.

### State E: Not Nice Out

* **Main text**: "NO"
* **Detail lines** (show all that apply, staggered entrance, in this order):
  * "Too cold ([temp]°)." — if temp < 62°F
  * "Too hot ([temp]°)." — if temp > 78°F
  * "Way too windy ([speed] mph)." — if wind ≥ 15 mph
  * "It's raining." / "It's snowing." — if precipitation detected (snow if temp ≤ 35°F, rain otherwise)
  * "Sky isn't great ([description])." — if sky description fails the passlist; show actual NWS description
  * "There's a [event name] right now." — only if Extreme-severity alert triggered override
* **Return affordance**: Same as State C.
* **Footer**: Same as State C.

### State F: Error Fallbacks ("IDK" States)

Errors are never clinical. The app shows **"IDK"** with a casual human explanation.

| Error Condition | Subtext |
|-----------------|---------|
| Geolocation denied or unavailable | "I don't know where you are. You have to let me see your location." |
| Browser offline (`!navigator.onLine`) | "You're offline right now." |
| NWS API timeout or HTTP error (after retry) | "The weather service is being slow. Try again in a sec." |
| NWS returns unparseable data | "Got something weird back from the weather service. Try again." |
| Observation data is stale (>2 hours old) | "Weather data is stale. The station might be having issues." |

All IDK states include the "check again" return affordance.

---

## 4. Technical Pipeline

```
User clicks "is it nice out"
        │
        ▼
┌─────────────────────────────┐
│ Disable button.             │
│ Abort any in-flight pipeline│
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ Check navigator.onLine      │──── false ──▶ State F (offline)
└─────────────┬───────────────┘
              │ (online or uncertain)
              ▼
┌─────────────────────────────┐
│ navigator.geolocation       │──── denied/error ──▶ State F (IDK)
│ .getCurrentPosition()       │
└─────────────┬───────────────┘
              │ (lat, lon)
              ▼
┌─────────────────────────────┐
│ Check sessionStorage cache  │──── valid (<15min) ─▶ Run algorithm
│ for this lat/lon (2 dp)     │                       with cached data
└─────────────┬───────────────┘
              │ (cache miss or expired)
              ▼
┌─────────────────────────────────────────────┐
│ Promise.all([                               │
│   fetch /alerts/active?point={lat},{lon}    │
│   fetch /points/{lat},{lon}                 │
│ ])                                          │──── timeout/error ──▶ retry once
└─────────────┬───────────────────────────────┘     (1s delay, then
              │ (alerts array + station URL)          State F if retry fails)
              ▼
┌─────────────────────────────┐
│ Fetch: first station's      │
│   /observations/latest      │──── timeout/error ──▶ retry once, then F
└─────────────┬───────────────┘
              │ (observation data)
              ▼
┌─────────────────────────────┐
│ Staleness check:            │──── >2 hours old ──▶ State F (stale data)
│ observation.properties      │
│   .timestamp                │
└─────────────┬───────────────┘
              │ (fresh observation)
              ▼
┌─────────────────────────────┐
│ Cache response in           │
│ sessionStorage w/ timestamp │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ Run Comfort Algorithm       │──▶ State C, D, or E
└─────────────────────────────┘
              │
              ▼
        Re-enable button
```

### 4.1 API Endpoints Used

All requests target `https://api.weather.gov`.

| Step | Endpoint | Purpose | Parallelizable |
|------|----------|---------|----------------|
| 1 | `GET /alerts/active?point={lat},{lon}` | Retrieve active alerts for the user's location | Yes (with step 2) |
| 2 | `GET /points/{lat},{lon}` | Discover forecast office and observation station URLs | Yes (with step 1) |
| 3 | `GET /stations/{stationId}/observations/latest` | Get most recent weather observation | No (depends on step 2) |

Steps 1 and 2 are independent and **must** be fetched in parallel via `Promise.all()` to reduce perceived latency from 3 sequential round-trips to 2.

### 4.2 Request Requirements

Every `fetch()` call must include only CORS-safelisted headers:

```
Headers:
  Accept: application/geo+json
```

**Note**: A custom `User-Agent` header cannot be set on cross-origin browser requests without triggering a preflight that `api.weather.gov` does not support. The browser's built-in User-Agent is sent automatically. NWS identification is handled by the `Referer` header (sent automatically from `isitniceout.com`).

### 4.3 Retry Logic

Each `fetch()` call gets **one silent retry** on failure (timeout, 5xx, or network error):

```javascript
async function fetchWithRetry(url, options = {}, timeoutMs = 8000) {
  try {
    return await fetchWithTimeout(url, options, timeoutMs);
  } catch (e) {
    // Single retry after 1s delay — only for transient errors
    await new Promise(r => setTimeout(r, 1000));
    return await fetchWithTimeout(url, options, timeoutMs);
  }
}
```

Do **not** retry 4xx responses (client errors indicate a bad request, not transient failure).

---

## 5. The Comfort Algorithm

The algorithm evaluates four independent condition checks. All four must pass for a "YES" result. Alerts are evaluated separately as a caveat layer.

**Critical null-handling rule**: If `temperature.value` or `windSpeed.value` is `null` or `undefined`, abort the algorithm and transition to State F ("Got something weird back from the weather service"). Null numeric values must never silently pass comparisons. For `precipitationLastHour.value`, `null` means "no measurable precipitation" and is a pass.

### 5.1 Temperature Check

* **Source**: `properties.temperature.value` (returned in Celsius by NWS)
* **Null handling**: If `null` or `undefined` → State F (IDK).
* **Pass range**: 16.5°C – 25.5°C (62°F – 78°F inclusive)
* **Display**: Always convert to Fahrenheit, round to nearest integer. Use `font-variant-numeric: tabular-nums` for rendering.
* **Failure text**: "Too cold ([temp]°)." if below range; "Too hot ([temp]°)." if above range.

### 5.2 Wind Check

* **Source**: `properties.windSpeed.value` (returned in km/h by NWS)
* **Null handling**: If `null` or `undefined` → State F (IDK).
* **Pass threshold**: < 24 km/h (< 15 mph)
* **Display**: Convert to mph, round to nearest integer.
* **Pass text**: "Wind is [speed] mph."
* **Failure text**: "Way too windy ([speed] mph)."

### 5.3 Precipitation Check

* **Source**: `properties.precipitationLastHour.value`
* **Pass condition**: Value is `null`, absent, or ≤ 1.0 mm. (Values ≤ 1.0 mm are typically sensor noise from condensation or dew, not perceptible precipitation.)
* **Secondary signal**: If `precipitationLastHour` passes but `properties.textDescription` contains any of the keywords `"Rain"`, `"Drizzle"`, `"Snow"`, `"Showers"`, `"Thunderstorm"`, `"Sleet"`, `"Freezing"` — then the precipitation check **fails**. This catches active light precipitation that the gauge hasn't accumulated yet.
* **Failure text**: "It's raining." (if temp > 35°F) or "It's snowing." (if temp ≤ 35°F)

### 5.4 Sky Condition Check

* **Source**: `properties.textDescription`
* **Null handling**: If `null`, empty, or `undefined` → State F (IDK).
* **Logic**: The description string must contain one of the terms in the **passlist** (case-insensitive substring match). If none match, the check fails.

#### Sky Passlist

```
Clear, Sunny, Mostly Sunny, Partly Sunny, Mostly Clear, Fair, Partly Cloudy, A Few Clouds
```

This list covers both daytime terms ("Sunny", "Mostly Sunny", "Partly Sunny") and nighttime equivalents ("Mostly Clear", "Fair"). NWS compound descriptions like "Fair and Breezy" will match on "Fair" — this is intentional since wind is checked separately.

**Note on substring matching**: "Cloudy" alone is NOT in the passlist. "Partly Cloudy" matches specifically because "Partly Cloudy" is a passlist entry. A bare "Cloudy" or "Mostly Cloudy" will correctly fail.

* **Failure text**: "Sky isn't great ([actual NWS description])."

### 5.5 Observation Staleness Check

* **Source**: `properties.timestamp` (ISO 8601)
* **Check**: If the observation timestamp is more than **2 hours** old, do not run the algorithm. Transition to State F: "Weather data is stale. The station might be having issues."
* **Rationale**: Stale observations can produce confident answers that don't reflect current conditions. This is especially dangerous in rapidly-changing weather.

### 5.6 Alert Evaluation (Caveat Layer)

Alerts are evaluated **after** the comfort checks and modify the result.

* **Source**: `/alerts/active?point={lat},{lon}` → `features[]` array
* **Filter**: Include alerts where `properties.severity` ∈ `["Extreme", "Severe", "Moderate"]`. Exclude entries where `properties.messageType === "Test"` or the event string contains "Statement".
* **Extreme-severity override**: If ANY alert has `properties.severity === "Extreme"`, force result to State E (NO) regardless of comfort checks. Add failure line: "There's a [event] right now."
* **If conditions are nice AND non-extreme alerts exist**: Show State D (YES with amber alert banner).
* **If conditions are NOT nice AND alerts exist**: Show State E (NO) with normal failure reasons only; do not separately surface the alert.
* **If no qualifying alerts exist**: Show State C (YES) or State E (NO) normally.
* **Alert display format**: "but a [event] is in effect until [expires formatted as h:mm a]" — the line is an `<a>` link to `properties.id` (the alert's canonical URL).

---

### 5.7 Comfort Range Editorial Note

The 62°F–78°F temperature range and <15 mph wind threshold are **editorial opinions**, not universal standards. They represent a moderate East Coast US baseline. This is a deliberate product choice — the app is opinionated, not configurable.

---

## 6. Performance, Caching & Edge Cases

### 6.1 No Location Caching

The app requests fresh geolocation on every click. There is no `localStorage` caching of coordinates. If geolocation is denied or fails for any reason, the app shows the IDK state immediately.

### 6.2 API Response Caching (Two Tiers)

#### Observation Cache (ephemeral)

* **Storage**: `sessionStorage`
* **Key schema**: `nws_obs_{lat}_{lon}` (coordinates rounded to **2 decimal places**, ~1.1 km precision — sufficient for weather, avoids GPS jitter causing cache misses on mobile)
* **Value**: JSON object containing `{ timestamp, alerts, observation }`
* **TTL**: 15 minutes. On click, if a valid cache entry exists for the current coordinates and is less than 15 minutes old, skip all network requests and run the algorithm on cached data.
* **Invalidation**: Expired entries are overwritten on next fetch. Closing the tab clears `sessionStorage` automatically.

#### Points/Station Cache (persistent)

* **Storage**: `localStorage`
* **Key schema**: `nws_points_{lat}_{lon}` (same 2-decimal rounding)
* **Value**: JSON object containing `{ stationId, stationUrl, stationName }`
* **TTL**: 24 hours. The `/points` endpoint returns metadata that changes extremely rarely (station assignments don't shift). Caching this eliminates one API call on subsequent visits.
* **Invalidation**: Overwrite if older than 24 hours on next pipeline run.

### 6.3 Timeout Handling

Every `fetch()` call uses an `AbortController` with an **8-second** timeout:

```javascript
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}
```

8 seconds accommodates slow mobile connections (3G, weak signal in rural areas — the exact demographic checking weather) while still failing within a reasonable window. Combined with the retry in Section 4.3, worst-case total wait per call is ~17 seconds — but parallelization of steps 1+2 means total pipeline worst-case is ~34s (two rounds × 8s × retry), with the timeout escalation UI (Section 3, State B) keeping the user informed.

### 6.4 Offline Detection

Before initiating any fetch, check `navigator.onLine`. If `false`, skip the entire pipeline and show the offline IDK state.

**Important**: `navigator.onLine` is a **heuristic**, not a guarantee. It only detects whether a network interface is up — it cannot detect captive portals, DNS failures, or firewalled traffic. The fetch timeout handles those cases. This check is a fast-path optimization for obviously-offline states (airplane mode, WiFi off).

### 6.5 Geolocation Options

```javascript
navigator.geolocation.getCurrentPosition(success, error, {
  enableHighAccuracy: false,   // coarse location is sufficient
  timeout: 10000,              // 10s timeout for location acquisition
  maximumAge: 300000           // accept a cached position up to 5 min old
});
```

`maximumAge: 300000` allows the browser to reuse a recently-acquired position without re-prompting the GPS hardware, which speeds up repeated clicks within the same session.

### 6.6 Request Debouncing

On click, the button is disabled immediately (`disabled` attribute + `aria-disabled="true"`). If a pipeline is already in-flight, it is aborted (all active `AbortController`s are signaled) before the new pipeline begins. The button is re-enabled only after reaching a terminal state (C, D, E, or F). This prevents race conditions from rapid clicks.

---

## 7. Visual Design

### 7.1 Layout

* All content is centered vertically and horizontally using a flex container on `<body>`.
* Maximum content width: `600px`. Content never touches viewport edges (minimum `24px` horizontal padding).
* The main answer text (YES / NO / IDK) is the dominant visual element.
* **Spacing rhythm**: Use a 4px base unit. All vertical spacing is a multiple: 8, 16, 24, 32, 48px.
  * Main answer → detail lines: `clamp(1rem, 3vw, 2rem)`
  * Between detail lines: `0.5rem` (8px)
  * Detail lines → footer: `2rem` (32px)
  * Footer → "check again": `1rem` (16px)

### 7.2 Typography

* **Font stack**: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  * Load Inter via Google Fonts (`<link>` in `<head>`, weights 400 and 700 only).
  * Google Fonts URL must include `&display=swap` to prevent FOIT on slow connections.
  * Preload the font file: `<link rel="preload" href="..." as="font" crossorigin>`.
  * If Inter fails to load, the system stack provides near-identical rendering.
* **Main answer**: `clamp(4rem, 12vw, 8rem)`, weight 700, uppercase.
* **Prompt text** ("is it nice out"): `clamp(1.5rem, 4vw, 2.5rem)`, weight 400, lowercase.
* **Detail lines**: `1rem`, weight 400.
* **Footer**: `0.8125rem` (13px), weight 400, reduced opacity.
* **"Check again"**: `0.875rem` (14px), weight 400, underline.
* **Temperature values**: `font-variant-numeric: tabular-nums` to prevent layout shift.
* **Font rendering**:
  ```css
  html {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  ```
* **Text wrapping**:
  ```css
  h1, .answer { text-wrap: balance; }
  p, li { text-wrap: pretty; }
  ```

### 7.3 Color

Follow `prefers-color-scheme` with no manual toggle.

| Token | Light Mode | Dark Mode |
|-------|-----------|----------|
| Background | `#FAFAFA` | `#111111` |
| Primary text | `#111111` | `#F0F0F0` |
| Secondary text (details, footer) | `#555555` | `#AAAAAA` |
| Prompt button | `#111111` | `#F0F0F0` |
| YES text | `#111111` | `#F0F0F0` |
| NO text | `#111111` | `#F0F0F0` |
| Alert caveat text | `#4D3600` | `#FFD666` |
| Alert link | `#4D3600` underline | `#FFD666` underline |

**Contrast ratios** (verified):
* Primary on background: 17.4:1 (light), 13.3:1 (dark) ✓
* Secondary on background: 7.4:1 (light), 7.2:1 (dark) ✓
* Alert amber on background: 5.5:1 (light), 10.5:1 (dark) ✓ WCAG AA

No color is used for YES/NO differentiation — the word itself carries the meaning.

### 7.4 Interactions & Transitions

#### Button (State A) — Prompt

```css
.prompt {
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-thickness: 2px;
  cursor: pointer;
  transition: opacity 150ms ease, transform 150ms ease;
}

.prompt:hover {
  opacity: 0.7;
}

.prompt:active {
  transform: scale(0.96);
}

.prompt:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 4px;
  border-radius: 2px;
}
```

The `scale(0.96)` provides tactile press feedback. Never go below `0.95`. The `text-underline-offset` prevents the underline from colliding with descenders at large sizes.

#### Button — "Check Again"

Same interaction pattern as the prompt, but at smaller size. Minimum touch target: 48×48px (achieved via padding).

#### Loading State (State B) — Pulse Animation

```css
.loading {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

#### State Transitions — Enter/Exit

State changes use **asymmetric opacity + translateY** transitions:

```css
/* Exiting state */
.state-exit {
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 150ms ease-in, transform 150ms ease-in;
}

/* Entering state */
.state-enter {
  opacity: 0;
  transform: translateY(-4px);
}
.state-enter-active {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 250ms ease-out, transform 250ms ease-out;
}
```

* **Exit**: 150ms, `ease-in`, drifts down 4px. Fast and snappy.
* **Enter**: 250ms, `ease-out`, drifts up 4px into resting position. Settled and deliberate.
* **Never** use `transition: all` — always specify exact properties (`opacity, transform`).

#### Detail Line Stagger

Detail lines in States C/D/E appear with a cascading delay:

```css
.detail-line:nth-child(1) { transition-delay: 80ms; }
.detail-line:nth-child(2) { transition-delay: 160ms; }
.detail-line:nth-child(3) { transition-delay: 240ms; }
.detail-line:nth-child(4) { transition-delay: 320ms; }
```

The main answer appears first, then detail lines cascade in. This provides movement and rhythm for a text-only interface.

#### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

This effectively disables visible motion while preserving the transition lifecycle (so JS callbacks still fire). Does NOT set `transition: none` — that would break event-driven state logic.

### 7.5 Responsive Behavior

* Single column at all viewports; no breakpoint-driven layout changes.
* Text scales fluidly via `clamp()`.
* Touch target for the prompt button: minimum `48px × 48px` (met inherently by the text size + padding).
* On viewports narrower than 360px, horizontal padding drops to `16px`.

---

## 8. Accessibility

* The prompt is a `<button>` element (not a styled `<a>`), ensuring keyboard focus and activation via Enter/Space.
* The "check again" affordance is also a `<button>`.
* All state transitions update an `aria-live="polite"` region so screen readers announce the result.
* Color contrast ratios meet WCAG 2.1 AA — verified in Section 7.3 (minimum 5.5:1 for all body text, 13.3:1 for primary text).
* No information is conveyed by color alone.
* Focus styles are explicit and visible:
  ```css
  :focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 4px;
    border-radius: 2px;
  }
  ```
* The page has a single `<h1>` ("is it nice out") for document structure; the answer and details are rendered in `<p>` and `<ul>` elements.
* `lang="en"` set on `<html>`.
* Buttons have accessible labels: the prompt button's text content is its label; "check again" is self-describing.
* When disabled during loading, the prompt button has `aria-disabled="true"` in addition to the `disabled` attribute.

---

## 9. SEO & Meta

```html
<title>Is It Nice Out?</title>
<meta name="description" content="Find out if the weather is nice outside right now. Uses your location and real-time NWS data.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Is It Nice Out?">
<meta property="og:description" content="A one-click answer to whether the weather is nice right now.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://isitniceout.com">
<meta property="og:image" content="https://isitniceout.com/og.png">
<link rel="canonical" href="https://isitniceout.com">
```

**`og.png`**: A static 1200×630px image with white background and "Is It Nice Out?" in Inter 700. This ensures social link previews are clean and clickable. Generate once and commit to repo root.

---

## 10. File Structure

```
/
├── index.html          # Markup, inlined <style> and <script> (or linked below)
├── style.css           # (optional, only if CSS > ~80 lines)
├── app.js              # (optional, only if JS > ~300 lines)
├── og.png              # Social preview image (1200×630, static)
├── CNAME               # Custom domain for GitHub Pages
├── docs/
│   └── spec.md         # This document
└── .github/
    └── workflows/
        └── deploy.yml  # GitHub Actions: deploy to Pages on push to main
```

The implementation should start as a single `index.html`. If the file becomes unwieldy during development (>500 total lines), factor out `style.css` and `app.js` as separate files.

---

## 11. Error Handling Summary

| Failure Point | Detection | User-Facing Result |
|---------------|-----------|-------------------|
| Geolocation denied | `error.code === 1` | IDK: "I don't know where you are..." |
| Geolocation timeout | `error.code === 3` | IDK: "I don't know where you are..." |
| Geolocation unavailable | `error.code === 2` | IDK: "I don't know where you are..." |
| Browser offline | `!navigator.onLine` (heuristic) | IDK: "You're offline right now." |
| Fetch timeout (8s × 2 attempts) | `AbortController` fires both times | IDK: "The weather service is being slow..." |
| HTTP 5xx from NWS (after retry) | `!response.ok` on both attempts | IDK: "The weather service is being slow..." |
| HTTP 4xx from NWS (no retry) | `!response.ok`, status 400–499 | IDK: "Got something weird back..." |
| JSON parse failure | `try/catch` on `.json()` | IDK: "Got something weird back..." |
| Missing `properties` top-level key | Null check after parse | IDK: "Got something weird back..." |
| `temperature.value` is null | Explicit null check in algorithm | IDK: "Got something weird back..." |
| `windSpeed.value` is null | Explicit null check in algorithm | IDK: "Got something weird back..." |
| `textDescription` is null/empty | Explicit null check in algorithm | IDK: "Got something weird back..." |
| Observation timestamp > 2 hours old | Compare `properties.timestamp` to `Date.now()` | IDK: "Weather data is stale..." |
| `precipitationLastHour.value` is null | Treated as "no precipitation" — **passes** | (Not an error) |

**Definition of "unparseable"**: Response is not valid JSON, OR response JSON lacks the top-level `properties` key. Missing individual fields within `properties` are handled per-check as shown above.

---

## 12. Testing Strategy

Since there is no build step or framework, testing is manual + lightweight automation:

* **Manual**: Open `index.html` locally, use browser DevTools to mock geolocation coordinates and intercept network requests with different NWS response fixtures.
* **Fixture file** (optional, `test/fixtures.json`): A collection of known NWS API responses representing various weather conditions (hot, cold, windy, rainy, clear night, alert active, etc.) for regression testing.
* **Automated** (optional, future): A simple Node.js script using `fetch` mocks that imports the algorithm logic (if factored into a module) and asserts correct outputs for each fixture.

---

## 13. Future Considerations (Out of Scope for v1)

These are explicitly not part of the initial build but are noted for potential future work:

* PWA with service worker (offline shell, add-to-homescreen)
* "Share" button (copy a screenshot or link with the current result)
* Humidity as an additional comfort factor
* Heat index / wind chill in extreme ranges
* Custom threshold preferences (personal "nice" calibration)
* Multi-language support