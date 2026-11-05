# Streamdown Implementation Guide

> Self-contained reference for implementing streaming markdown rendering with animation in React/Next.js, with LLM integration patterns for Claude/Anthropic and OpenAI.
>
> **Source:** [vercel/streamdown](https://github.com/vercel/streamdown) | [Docs](https://streamdown.ai/docs) | v2.x

---

## Table of Contents

1. [Overview](#1-overview)
2. [Installation & Setup](#2-installation--setup)
3. [Quick Start](#3-quick-start)
4. [Animation System](#4-animation-system)
5. [Carets](#5-carets)
6. [Configuration Reference](#6-configuration-reference)
7. [Plugin System](#7-plugin-system)
8. [Styling](#8-styling)
9. [Custom Components & Tags](#9-custom-components--tags)
10. [LLM Integration: Claude/Anthropic](#10-llm-integration-claudeanthropic)
11. [LLM Integration: OpenAI](#11-llm-integration-openai)
12. [Performance](#12-performance)
13. [Static Mode](#13-static-mode)
14. [Security](#14-security)
15. [Best Practices](#15-best-practices)

---

## 1. Overview

Streamdown is a React component library by Vercel -- a drop-in replacement for `react-markdown` built specifically for AI-powered streaming. It handles the unique challenges of rendering Markdown that arrives token-by-token from LLMs:

- **Incomplete syntax** -- Bold text not closed yet: `**This is bol`
- **Partial code blocks** -- Missing closing backticks
- **Unterminated links** -- Links without closing brackets: `[Click here`
- **Progressive rendering** -- Token-by-token content updates

Streamdown solves this with `remend` (its preprocessor for unterminated Markdown blocks), block-level memoization for performance, and built-in animation support.

**Key capabilities:**
- Drop-in `react-markdown` replacement with streaming optimization
- GitHub Flavored Markdown (tables, task lists, strikethrough)
- Syntax highlighting via Shiki (200+ languages, lazy-loaded)
- Mermaid diagram rendering
- LaTeX math via KaTeX
- CJK language support
- Per-word/per-character streaming animation
- Caret (cursor) indicators during streaming
- Security hardening via `rehype-sanitize` + `rehype-harden`
- Block-level memoization for efficient re-renders
- Custom component overrides and custom HTML tags

---

## 2. Installation & Setup

### Requirements

- **Node.js** >= 18
- **React** >= 19.1.1 (compatible with React 18+)
- **Tailwind CSS** (for styling)

### Install Streamdown

```bash
npm i streamdown
```

Or install via AI Elements (Vercel's component library):

```bash
npx ai-elements@latest add message
```

### Install Plugins (optional, install only what you need)

```bash
# Syntax highlighting
npm install @streamdown/code

# Mermaid diagrams
npm install @streamdown/mermaid

# Math rendering (also requires katex)
npm install @streamdown/math

# CJK language support
npm install @streamdown/cjk

# All at once
npm install @streamdown/code @streamdown/mermaid @streamdown/math @streamdown/cjk
```

### Tailwind CSS Configuration

#### Tailwind v4

Add this CSS source directive to `globals.css` (or your main CSS file):

```css
/* globals.css */
@source "../node_modules/streamdown/dist/*.js";
```

The path must be relative from your CSS file to `node_modules/streamdown`. In a standard Next.js project where `globals.css` lives in `app/`, the default path works.

#### Tailwind v3

Add Streamdown to your `content` array in `tailwind.config.js`:

```js
// tailwind.config.js
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/streamdown/dist/*.js",
  ],
};
```

#### Monorepo Setup

In a monorepo (npm workspaces, Turbo, pnpm), dependencies are hoisted to root `node_modules`. Adjust the relative path:

```
monorepo/
├── node_modules/streamdown/  <-- hoisted here
├── apps/
│   └── web/
│       └── app/
│           └── globals.css   <-- your CSS file
```

```css
/* Tailwind v4: apps/web/app/globals.css -- 3 levels up */
@source "../../../node_modules/streamdown/dist/*.js";
```

```js
// Tailwind v3: tailwind.config.js
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "../../node_modules/streamdown/dist/*.js",
  ],
};
```

### Animation CSS

If using the `animated` prop, import the animation stylesheet:

```tsx
// app/layout.tsx
import "streamdown/styles.css";
```

---

## 3. Quick Start

### Minimal Example

```tsx
import { Streamdown } from "streamdown";

export default function Page() {
  const markdown = "# Hello World\n\nThis is **streaming** markdown!";
  return <Streamdown>{markdown}</Streamdown>;
}
```

### With AI SDK Streaming

```tsx
"use client";

import { useChat } from "@ai-sdk/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";

export default function Chat() {
  const { messages, status } = useChat();

  return (
    <div>
      {messages.map((message) => (
        <div key={message.id}>
          {message.parts
            .filter((part) => part.type === "text")
            .map((part, index) => (
              <Streamdown
                key={index}
                animated
                plugins={{ code, mermaid, math }}
                isAnimating={status === "streaming"}
              >
                {part.text}
              </Streamdown>
            ))}
        </div>
      ))}
    </div>
  );
}
```

---

## 4. Animation System

Streamdown supports per-word streaming animation through the built-in `animated` prop. Words fade in as they mount, creating a smooth text-reveal effect. When streaming ends, animation is removed entirely -- zero DOM overhead on completed messages.

### Enable Animation

```tsx
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

<Streamdown animated isAnimating={status === "streaming"}>
  {markdown}
</Streamdown>
```

The `isAnimating` prop controls when animation is active. When `false`, the animate plugin is excluded from the rehype pipeline entirely -- no extra `<span>` wrappers remain.

### How It Works

The animation is a rehype transformer that:

1. Walks the HAST tree, visiting text nodes
2. Splits each text node into per-word `<span>` elements with `data-sd-animate`
3. Sets CSS custom properties for animation name, duration, and easing
4. Skips text inside `code`, `pre`, `svg`, `math`, and `annotation` elements

React's reconciliation ensures only newly-mounted spans trigger the CSS animation.

### Built-in Animation Types

#### fadeIn (default)

Simple opacity transition from invisible to visible.

```tsx
<Streamdown animated={{ animation: "fadeIn" }} isAnimating={status === "streaming"}>
  {markdown}
</Streamdown>
```

#### blurIn

Combines opacity with a blur-to-sharp transition. Best for fast-streaming models where many tokens arrive at once -- blur masks batch appearance better than pure opacity.

```tsx
<Streamdown animated={{ animation: "blurIn" }} isAnimating={status === "streaming"}>
  {markdown}
</Streamdown>
```

#### slideUp

Words fade in while sliding up 4px, creating a subtle rising effect.

```tsx
<Streamdown animated={{ animation: "slideUp" }} isAnimating={status === "streaming"}>
  {markdown}
</Streamdown>
```

### Animation Configuration

Pass an options object to `animated`:

```tsx
<Streamdown
  animated={{
    animation: "blurIn",   // "fadeIn" | "blurIn" | "slideUp" | custom string
    duration: 200,          // milliseconds (default: 150)
    easing: "ease-out",     // CSS timing function (default: "ease")
    sep: "word",            // "word" | "char" (default: "word")
  }}
  isAnimating={status === "streaming"}
>
  {markdown}
</Streamdown>
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `animation` | `string` | `"fadeIn"` | Animation name. Built-in: `fadeIn`, `blurIn`, `slideUp`. Custom strings are prefixed with `sd-`. |
| `duration` | `number` | `150` | Animation duration in milliseconds. |
| `easing` | `string` | `"ease"` | CSS timing function. |
| `sep` | `"word" \| "char"` | `"word"` | Split text by word or character. |

### Character-Level Animation

Set `sep: "char"` for typewriter-like effect (more DOM nodes -- use sparingly):

```tsx
<Streamdown animated={{ animation: "fadeIn", sep: "char" }} isAnimating={status === "streaming"}>
  {markdown}
</Streamdown>
```

### Custom Animations

Define your own `@keyframes` and reference by name. Streamdown auto-prefixes with `sd-`:

```css
/* globals.css */
@keyframes sd-myCustomAnimation {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
```

```tsx
<Streamdown animated={{ animation: "myCustomAnimation" }} isAnimating={status === "streaming"}>
  {markdown}
</Streamdown>
```

### CSS Custom Properties

Each animated span receives these CSS custom properties via inline styles:

| Property | Description |
|----------|-------------|
| `--sd-animation` | The `@keyframes` name to use |
| `--sd-duration` | Animation duration |
| `--sd-easing` | CSS timing function |

The `[data-sd-animate]` selector in `styles.css`:

```css
[data-sd-animate] {
  animation: var(--sd-animation, sd-fadeIn)
    var(--sd-duration, 150ms)
    var(--sd-easing, ease) both;
}
```

### Advanced: createAnimatePlugin

For direct access to the rehype plugin (e.g. in custom pipelines):

```tsx
import { createAnimatePlugin } from "streamdown";

const animate = createAnimatePlugin({
  animation: "blurIn",
  duration: 200,
});

// animate.rehypePlugin is a standard rehype plugin
```

### Skipped Elements

Animation skips text inside these elements: `<code>`, `<pre>`, `<svg>`, `<math>`, `<annotation>`.

---

## 5. Carets

Carets are visual cursor indicators that display at the end of streaming content.

### Usage

```tsx
<Streamdown caret="block" isAnimating={isStreaming}>
  {content}
</Streamdown>
```

### Caret Styles

| Style | Character | Description |
|-------|-----------|-------------|
| `"block"` | `\u2588` | Vertical bar, terminal-cursor style |
| `"circle"` | `\u25CF` | Filled circle, subtler indicator |

### Conditional Display

Show carets only for the last assistant message:

```tsx
{messages.map((message, index) => (
  <Streamdown
    key={message.id}
    caret={
      message.role === "assistant" && index === messages.length - 1
        ? "block"
        : undefined
    }
    isAnimating={isStreaming}
  >
    {message.content}
  </Streamdown>
))}
```

### Technical Details

- Caret value is passed as CSS custom property (`--streamdown-caret`)
- A `::after` pseudo-element is added to the last child element
- When `isAnimating` becomes `false` or `caret` is `undefined`, styles are removed
- No additional DOM elements -- efficient CSS-only implementation

---

## 6. Configuration Reference

### Core Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `string` | -- | The Markdown content to render |
| `parseIncompleteMarkdown` | `boolean` | `true` | Enable remend preprocessor for unterminated Markdown blocks |
| `remend` | `RemendOptions` | -- | Configure which Markdown completions remend should perform |
| `isAnimating` | `boolean` | `false` | Indicates if content is currently streaming (disables copy buttons) |
| `className` | `string` | -- | CSS class for the container element |
| `mode` | `"streaming" \| "static"` | `"streaming"` | Mode of the Streamdown component |

### Styling Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `shikiTheme` | `[string, string]` | `["github-light", "github-dark"]` | Light and dark themes for code syntax highlighting |
| `components` | `object` | -- | Custom component overrides for Markdown elements |
| `allowedTags` | `Record<string, string[]>` | -- | Custom HTML tags to allow through sanitization |

### CDN Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `cdnUrl` | `string \| null` | `"https://streamdown.ai/cdn"` | Base URL for loading Shiki languages/themes, Mermaid, KaTeX CSS. Set `null` to disable. |

### Plugin Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `plugins` | `object` | -- | Streamdown plugins (`code`, `mermaid`, `math`, `cjk`) |
| `rehypePlugins` | `Pluggable[]` | `Object.values(defaultRehypePlugins)` | Rehype plugins for HTML processing |
| `remarkPlugins` | `Pluggable[]` | `Object.values(defaultRemarkPlugins)` | Remark plugins for Markdown processing |

### Feature-Specific Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `animated` | `boolean \| AnimateOptions` | -- | Enable streaming animation |
| `caret` | `"block" \| "circle"` | -- | Caret style during streaming |
| `mermaid` | `MermaidOptions` | -- | Mermaid diagram configuration |
| `controls` | `ControlsConfig` | `true` | Control visibility of interactive buttons |

### Element Filtering Props

These match the `react-markdown` API for drop-in compatibility:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `allowedElements` | `string[]` | -- | Tag names to allow (removes all others) |
| `disallowedElements` | `string[]` | `[]` | Tag names to disallow (keeps all others) |
| `allowElement` | `(element, index, parent) => boolean` | -- | Custom filter function per element |
| `unwrapDisallowed` | `boolean` | `false` | Replace disallowed elements with children instead of removing |
| `skipHtml` | `boolean` | `false` | Ignore raw HTML in Markdown completely |
| `urlTransform` | `(url, key, node) => string` | `defaultUrlTransform` | Transform all URLs in the Markdown |

### Advanced Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `BlockComponent` | `React.ComponentType<BlockProps>` | `Block` | Custom block component for rendering individual markdown blocks |
| `parseMarkdownIntoBlocksFn` | `(markdown: string) => string[]` | `parseMarkdownIntoBlocks` | Custom function to parse markdown into blocks |

### Controls Config

```tsx
<Streamdown
  controls={{
    table: true,           // Show table download button
    code: true,            // Show code copy button
    mermaid: {
      download: true,      // Show mermaid download button
      copy: true,          // Show mermaid copy button
      fullscreen: true,    // Show mermaid fullscreen button
      panZoom: true,       // Show mermaid pan/zoom controls
    },
  }}
>
  {markdown}
</Streamdown>
```

### Remend Options

Configure which Markdown completions are performed during streaming. All default to `true`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `links` | `boolean` | `true` | Complete incomplete links |
| `images` | `boolean` | `true` | Complete incomplete images |
| `bold` | `boolean` | `true` | Complete bold formatting (`**`) |
| `italic` | `boolean` | `true` | Complete italic formatting (`*` and `_`) |
| `boldItalic` | `boolean` | `true` | Complete bold-italic formatting (`***`) |
| `inlineCode` | `boolean` | `true` | Complete inline code formatting (`` ` ``) |
| `strikethrough` | `boolean` | `true` | Complete strikethrough formatting (`~~`) |
| `katex` | `boolean` | `true` | Complete block KaTeX math (`$$`) |
| `setextHeadings` | `boolean` | `true` | Handle incomplete setext headings |
| `linkMode` | `"protocol" \| "text-only"` | `"protocol"` | How to handle incomplete links |
| `handlers` | `RemendHandler[]` | -- | Custom handlers for your own completion logic |

```tsx
<Streamdown remend={{ links: false, katex: false }}>
  {markdown}
</Streamdown>
```

---

## 7. Plugin System

### Architecture

Streamdown uses two plugin layers:

1. **Built-in remark/rehype plugins** -- included by default, process Markdown and HTML
2. **Streamdown plugins** -- standalone packages for advanced features (code, mermaid, math, cjk)

### Built-in Remark Plugins

| Plugin | Description |
|--------|-------------|
| `remark-gfm` | GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks, footnotes) |

### Built-in Rehype Plugins

| Plugin | Description |
|--------|-------------|
| `rehype-raw` | Allows raw HTML in Markdown |
| `rehype-sanitize` | XSS protection and safe HTML rendering |
| `rehype-harden` | Security hardening for links and images |

### Customizing Built-in Plugins

```tsx
import { Streamdown, defaultRemarkPlugins, defaultRehypePlugins } from "streamdown";

// Add your own plugins alongside defaults
<Streamdown
  remarkPlugins={[...Object.values(defaultRemarkPlugins), myCustomPlugin]}
  rehypePlugins={[...Object.values(defaultRehypePlugins), anotherPlugin]}
>
  {markdown}
</Streamdown>
```

Access default plugin references:

```tsx
import { defaultRemarkPlugins, defaultRehypePlugins } from "streamdown";

// defaultRemarkPlugins.gfm
// defaultRehypePlugins.raw
// defaultRehypePlugins.sanitize
// defaultRehypePlugins.harden
```

### @streamdown/code

Syntax highlighting via [Shiki](https://shiki.style/). 200+ languages, lazy-loaded on demand, dual theme support, token caching.

```tsx
import { code } from "@streamdown/code";

<Streamdown plugins={{ code }}>{markdown}</Streamdown>
```

Custom configuration:

```tsx
import { createCodePlugin } from "@streamdown/code";

const code = createCodePlugin({
  themes: ["github-light", "github-dark"], // [light, dark]
});
```

### @streamdown/mermaid

Renders [Mermaid](https://mermaid.js.org/) diagrams. Interactive controls (fullscreen, download, copy), custom theming, error handling with retry.

```tsx
import { mermaid } from "@streamdown/mermaid";

<Streamdown plugins={{ mermaid }}>{markdown}</Streamdown>
```

Custom configuration:

```tsx
import { createMermaidPlugin } from "@streamdown/mermaid";

const mermaid = createMermaidPlugin({
  config: {
    theme: "dark",
    fontFamily: "monospace",
  },
});
```

Mermaid options on the component:

```tsx
<Streamdown
  plugins={{ mermaid }}
  mermaid={{
    config: { theme: "neutral" },
    errorComponent: MyErrorComponent,  // React.ComponentType<MermaidErrorComponentProps>
  }}
>
  {markdown}
</Streamdown>
```

### @streamdown/math

LaTeX math rendering via [KaTeX](https://katex.org/). Requires CSS import.

```tsx
import { math } from "@streamdown/math";
import "katex/dist/katex.min.css";

<Streamdown plugins={{ math }}>{markdown}</Streamdown>
```

Custom configuration:

```tsx
import { createMathPlugin } from "@streamdown/math";

const math = createMathPlugin({
  singleDollarTextMath: true,  // Enable $...$ syntax
  errorColor: "#ff0000",
});

// Get CSS path programmatically:
const cssPath = math.getStyles(); // "katex/dist/katex.min.css"
```

### @streamdown/cjk

Proper handling of Chinese, Japanese, Korean text. Correct emphasis formatting near ideographic punctuation, autolink splitting at CJK punctuation boundaries.

```tsx
import { cjk } from "@streamdown/cjk";

<Streamdown plugins={{ cjk }}>{markdown}</Streamdown>
```

### Using All Plugins Together

```tsx
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import "katex/dist/katex.min.css";

<Streamdown plugins={{ code, mermaid, math, cjk }}>
  {markdown}
</Streamdown>
```

---

## 8. Styling

### CSS Variables (Recommended)

Streamdown uses shadcn/ui's design system with CSS variables. Set these in `globals.css`:

```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --border: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}
```

#### Variables Used by Streamdown

| Variable | Usage | Elements |
|----------|-------|----------|
| `--primary` | Links, accent colors | `<a>` tags |
| `--muted` | Subtle backgrounds | Code blocks, table headers |
| `--muted-foreground` | De-emphasized text | Blockquote text |
| `--border` | Borders and dividers | Tables, HRs, code blocks |
| `--ring` | Focus rings | Interactive buttons |
| `--radius` | Border radius | Code blocks, tables, buttons |

### Data Attribute Selectors

Target specific elements using `data-streamdown` attributes:

```css
/* Headings */
[data-streamdown="heading-1"] { }
[data-streamdown="heading-2"] { }
[data-streamdown="heading-3"] { }

/* Text elements */
[data-streamdown="strong"] { }
[data-streamdown="link"] { }
[data-streamdown="inline-code"] { }

/* Lists */
[data-streamdown="ordered-list"] { }
[data-streamdown="unordered-list"] { }
[data-streamdown="list-item"] { }

/* Blocks */
[data-streamdown="blockquote"] { }
[data-streamdown="horizontal-rule"] { }
[data-streamdown="code-block"] { }
[data-streamdown="mermaid-block"] { }

/* Tables */
[data-streamdown="table-wrapper"] { }
[data-streamdown="table"] { }
[data-streamdown="table-header"] { }
[data-streamdown="table-body"] { }
[data-streamdown="table-row"] { }
[data-streamdown="table-header-cell"] { }
[data-streamdown="table-cell"] { }

/* Other */
[data-streamdown="superscript"] { }
[data-streamdown="subscript"] { }
```

### Scoped Styling

Scope styles to specific Streamdown instances:

```tsx
<Streamdown className="docs-content">{markdown}</Streamdown>
```

```css
.docs-content [data-streamdown="heading-1"] {
  font-family: "Inter", sans-serif;
  letter-spacing: -0.02em;
}
```

### Quick Theme Examples

**Minimal Gray:**
```css
:root {
  --primary: 0 0% 20%;
  --muted: 0 0% 96%;
  --border: 0 0% 90%;
  --radius: 0.25rem;
}
```

**Vibrant Blue:**
```css
:root {
  --primary: 217 91% 60%;
  --muted: 214 100% 97%;
  --border: 214 32% 91%;
  --radius: 0.75rem;
}
```

### Styling Priority

1. **Custom Components** -- Complete control over rendering
2. **CSS via `data-streamdown` selectors** -- Element-specific styling
3. **CSS Variables** -- Global theme tokens

---

## 9. Custom Components & Tags

### Component Overrides

Replace any Markdown element with your own React component:

```tsx
<Streamdown
  components={{
    h1: ({ children }) => (
      <h1 className="text-4xl font-bold text-blue-600">{children}</h1>
    ),
    a: ({ href, children, ...props }) => (
      <a href={href} className="text-purple-600 underline" {...props}>
        {children}
      </a>
    ),
    p: ({ children }) => (
      <p className="text-gray-700 leading-relaxed">{children}</p>
    ),
  }}
>
  {markdown}
</Streamdown>
```

#### Available Components

- **Headings:** `h1`, `h2`, `h3`, `h4`, `h5`, `h6`
- **Text:** `p`, `strong`, `em`
- **Lists:** `ul`, `ol`, `li`
- **Links:** `a`
- **Code:** `code`, `pre`
- **Quotes:** `blockquote`
- **Tables:** `table`, `thead`, `tbody`, `tr`, `th`, `td`
- **Media:** `img`
- **Other:** `hr`, `sup`, `sub`, `section`

Custom components receive: `children`, `className`, `node` (AST node), and element-specific props (`href` for links, `src` for images, etc.).

### Custom HTML Tags

Render custom HTML tags from AI responses (like `<source>`, `<mention>`) using `allowedTags` + `components`:

```tsx
<Streamdown
  allowedTags={{
    source: ["id"],              // Allow <source> with id attribute
    mention: ["user_id", "type"], // Allow <mention> with user_id, type
  }}
  components={{
    source: ({ id, children }) => (
      <button
        onClick={() => console.log(`Navigate to source: ${id}`)}
        className="text-blue-600 underline cursor-pointer"
      >
        {children}
      </button>
    ),
    mention: ({ user_id, children }) => (
      <UserMention userId={user_id as string}>{children}</UserMention>
    ),
  }}
>
  {markdown}
</Streamdown>
```

Use `data*` in the attributes array to allow all `data-*` attributes on a tag:

```tsx
<Streamdown
  allowedTags={{ widget: ["data*"] }}
  components={{ widget: (props) => <Widget {...props} /> }}
>
  {markdown}
</Streamdown>
```

**Security notes:**
- Without `allowedTags`, custom tags are stripped by the sanitizer (content preserved, tags removed)
- Only listed attributes are preserved; unlisted are stripped
- `allowedTags` only works with the default rehype plugins
- Never allow `script`, `style`, or event handler attributes

---

## 10. LLM Integration: Claude/Anthropic

### Install Dependencies

```bash
npm install ai @ai-sdk/anthropic streamdown @streamdown/code @streamdown/mermaid
```

### API Route Handler

Create a route handler that uses the Anthropic provider:

```tsx
// app/api/chat/route.ts
import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: anthropic("claude-sonnet-5-5"),
    messages,
    system: "You are a helpful assistant. Use markdown formatting in your responses.",
  });

  return result.toDataStreamResponse();
}
```

Set your API key in `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### Client Component with Streamdown

```tsx
// app/chat/page.tsx
"use client";

import { useChat } from "@ai-sdk/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import "streamdown/styles.css";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat();

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={message.role === "user" ? "text-right" : "text-left"}
          >
            <div className="inline-block max-w-2xl text-left">
              {message.role === "user" ? (
                <p className="bg-blue-100 dark:bg-blue-900 rounded-lg px-4 py-2">
                  {message.content}
                </p>
              ) : (
                <Streamdown
                  animated={{
                    animation: "blurIn",
                    duration: 200,
                    easing: "ease-out",
                  }}
                  caret={
                    index === messages.length - 1 ? "block" : undefined
                  }
                  plugins={{ code, mermaid }}
                  isAnimating={
                    status === "streaming" && index === messages.length - 1
                  }
                >
                  {message.content}
                </Streamdown>
              )}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask Claude anything..."
          className="w-full px-4 py-2 border rounded-lg"
          disabled={status === "streaming"}
        />
      </form>
    </div>
  );
}
```

### Using message.parts (recommended for multi-part responses)

```tsx
{messages.map((message, index) => (
  <div key={message.id}>
    {message.parts
      .filter((part) => part.type === "text")
      .map((part, partIndex) => (
        <Streamdown
          key={partIndex}
          animated
          plugins={{ code, mermaid }}
          isAnimating={status === "streaming" && index === messages.length - 1}
        >
          {part.text}
        </Streamdown>
      ))}
  </div>
))}
```

---

## 11. LLM Integration: OpenAI

### Install Dependencies

```bash
npm install ai @ai-sdk/openai streamdown @streamdown/code @streamdown/mermaid
```

### API Route Handler

```tsx
// app/api/chat/route.ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai("gpt-4o"),
    messages,
    system: "You are a helpful assistant. Use markdown formatting in your responses.",
  });

  return result.toDataStreamResponse();
}
```

Set your API key in `.env.local`:

```
OPENAI_API_KEY=sk-...
```

### Client Component with Streamdown

The client component is identical to the Claude example -- `useChat` and Streamdown work the same regardless of backend provider:

```tsx
// app/chat/page.tsx
"use client";

import { useChat } from "@ai-sdk/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import "streamdown/styles.css";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat();

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={message.role === "user" ? "text-right" : "text-left"}
          >
            <div className="inline-block max-w-2xl text-left">
              {message.role === "user" ? (
                <p className="bg-green-100 dark:bg-green-900 rounded-lg px-4 py-2">
                  {message.content}
                </p>
              ) : (
                <Streamdown
                  animated={{
                    animation: "blurIn",
                    duration: 200,
                    easing: "ease-out",
                  }}
                  caret={
                    index === messages.length - 1 ? "block" : undefined
                  }
                  plugins={{ code, mermaid }}
                  isAnimating={
                    status === "streaming" && index === messages.length - 1
                  }
                >
                  {message.content}
                </Streamdown>
              )}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask GPT anything..."
          className="w-full px-4 py-2 border rounded-lg"
          disabled={status === "streaming"}
        />
      </form>
    </div>
  );
}
```

### Multi-Provider Setup

Use the same Streamdown frontend with multiple providers:

```tsx
// app/api/chat/route.ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

export async function POST(req: Request) {
  const { messages, provider } = await req.json();

  const model =
    provider === "anthropic"
      ? anthropic("claude-sonnet-5-5")
      : openai("gpt-4o");

  const result = streamText({ model, messages });
  return result.toDataStreamResponse();
}
```

Client-side, pass the provider:

```tsx
const { messages, input, handleInputChange, handleSubmit, status } = useChat({
  body: { provider: "anthropic" }, // or "openai"
});
```

---

## 12. Performance

### Block-Level Memoization

Streamdown parses markdown into individual blocks, each memoized separately:

- Only blocks with changed content re-render
- Unchanged blocks remain memoized even as new blocks arrive
- The main `Streamdown` component is wrapped with `React.memo`

The component only re-renders when:
- `children` (markdown content) changes
- `shikiTheme` changes
- `isAnimating` changes

### Syntax Highlighting Cache

The Shiki highlighter maintains an internal cache:
- Languages loaded once and cached for reuse
- Theme changes don't require reloading languages
- Multiple code blocks in the same language share the highlighter instance

### Plugin Performance

- Built-in plugin arrays created once at module level for caching
- Shiki languages lazy-loaded only when needed
- Token results cached to avoid re-highlighting
- KaTeX CSS loaded only when math syntax is used
- Animation excluded from pipeline when `isAnimating` is `false`

### Streaming Efficiency Tips

1. **Use `message.parts`** instead of `message.content` for granular rendering
2. **Set `isAnimating` conditionally** -- only for the actively streaming message
3. **Avoid unnecessary re-renders** -- keep plugin references stable (define outside component or use `useMemo`)
4. **Install only needed plugins** -- each adds bundle weight

```tsx
// GOOD: stable plugin reference
const plugins = { code, mermaid };

function Chat() {
  return <Streamdown plugins={plugins}>{markdown}</Streamdown>;
}

// BAD: new object every render
function Chat() {
  return <Streamdown plugins={{ code, mermaid }}>{markdown}</Streamdown>;
}
```

---

## 13. Static Mode

For pre-generated content (blog posts, docs) where streaming optimization is unnecessary:

```tsx
<Streamdown
  mode="static"
  plugins={{ code, mermaid }}
  shikiTheme={["github-light", "github-dark"]}
>
  {content}
</Streamdown>
```

### How Static Mode Works

- **No block parsing** -- content rendered as a single unit
- **No incomplete markdown handling** -- assumes well-formed markdown
- **Improved code blocks** -- optimized rendering for static code
- **Simpler rendering** -- direct rendering without streaming overhead

All standard Streamdown props work in static mode (components, themes, mermaid, plugins).

---

## 14. Security

Streamdown uses two layers of protection by default:

1. **`rehype-sanitize`** -- Strips dangerous HTML elements/attributes using GitHub's sanitization schema
2. **`rehype-harden`** -- Restricts URL protocols, link domains, and image sources

### Default Configuration (Permissive)

```tsx
{
  allowedImagePrefixes: ["*"],   // All images allowed
  allowedLinkPrefixes: ["*"],    // All links allowed
  allowedProtocols: ["*"],       // All protocols allowed
  defaultOrigin: undefined,      // No origin restriction
  allowDataImages: true,         // Base64 images allowed
}
```

### Restrict for Production

```tsx
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { harden } from "rehype-harden";

<Streamdown
  rehypePlugins={[
    defaultRehypePlugins.raw,
    defaultRehypePlugins.sanitize,
    [
      harden,
      {
        defaultOrigin: "https://your-app.com",
        allowedLinkPrefixes: [
          "https://your-app.com",
          "https://github.com",
        ],
        allowedImagePrefixes: ["https://your-cdn.com"],
        allowedProtocols: ["http", "https", "mailto"],
        allowDataImages: false,
      },
    ],
  ]}
>
  {markdown}
</Streamdown>
```

**Warning:** `rehypePlugins` **replaces** the entire default array -- always include `defaultRehypePlugins.sanitize` to preserve XSS protection.

### Disable Raw HTML

```tsx
<Streamdown
  rehypePlugins={[
    // Omit defaultRehypePlugins.raw
    defaultRehypePlugins.sanitize,
    defaultRehypePlugins.harden,
  ]}
>
  {markdown}
</Streamdown>
```

### Skip HTML Completely

```tsx
<Streamdown skipHtml>{markdown}</Streamdown>
```

---

## 15. Best Practices

### Fast-Streaming Models

Fast models (Claude, GPT-4o) dump many tokens per React commit. To handle this:

- Use `blurIn` animation -- blur masks batch arrivals better than opacity alone
- Increase duration to 200-300ms for smoother appearance
- Use `ease-out` easing for natural deceleration

```tsx
<Streamdown
  animated={{
    animation: "blurIn",
    duration: 250,
    easing: "ease-out",
  }}
  isAnimating={status === "streaming"}
>
  {markdown}
</Streamdown>
```

### Accessibility

- Maintain proper color contrast when customizing CSS variables
- Ensure focus states are preserved on interactive elements
- Keep semantic HTML structure when using custom components
- Test with screen readers -- Streamdown preserves semantic Markdown structure

### Performance Checklist

- [ ] Import `streamdown/styles.css` in layout, not per-component
- [ ] Keep plugin references stable (outside component or `useMemo`)
- [ ] Set `isAnimating` only for the actively streaming message
- [ ] Install only the plugins you need
- [ ] Use `mode="static"` for non-streaming content

### Element Filtering Examples

```tsx
// Only allow specific elements
<Streamdown allowedElements={["p", "a", "em"]}>{markdown}</Streamdown>

// Remove images but keep everything else
<Streamdown disallowedElements={["img"]}>{markdown}</Streamdown>

// Remove images but keep alt text
<Streamdown disallowedElements={["img"]} unwrapDisallowed>{markdown}</Streamdown>

// Custom filter: remove h3+ headings
<Streamdown
  allowElement={(element) =>
    !["h3", "h4", "h5", "h6"].includes(element.tagName)
  }
>
  {markdown}
</Streamdown>
```

### URL Transform

```tsx
import { Streamdown, defaultUrlTransform } from "streamdown";

// Proxy all images through your CDN
<Streamdown
  urlTransform={(url, key, node) => {
    if (key === "src") {
      return `https://your-cdn.com/proxy?url=${encodeURIComponent(url)}`;
    }
    return defaultUrlTransform(url, key, node);
  }}
>
  {markdown}
</Streamdown>
```

---

## Sources

- [vercel/streamdown GitHub Repository](https://github.com/vercel/streamdown)
- [Streamdown Documentation](https://streamdown.ai/docs)
- [Vercel AI SDK](https://ai-sdk.dev)
- [Vercel Changelog: Introducing Streamdown](https://vercel.com/changelog/introducing-streamdown)
- [Vercel Changelog: Streamdown v2](https://vercel.com/changelog/streamdown-v2)
