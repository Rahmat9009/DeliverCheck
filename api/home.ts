export const maxDuration = 300;
export const runtime = "nodejs";

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="DeliverCheck turns agent output into validated, schema-ready input for the next agent.">
  <title>DeliverCheck — Verified agent handoffs</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #f5f7ff;
      --muted: #a8b2ca;
      --line: #263352;
      --panel: rgba(15, 25, 48, .76);
      --blue: #78a9ff;
      --mint: #71e7bd;
    }
    * { box-sizing: border-box; }
    html { background: #080d1a; }
    body {
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 15% 12%, rgba(62, 104, 190, .24), transparent 34rem),
        radial-gradient(circle at 85% 80%, rgba(26, 144, 116, .15), transparent 30rem),
        #080d1a;
      font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    a { color: inherit; }
    a:focus-visible { outline: 3px solid var(--mint); outline-offset: 4px; }
    .skip {
      position: fixed;
      left: 1rem;
      top: -5rem;
      z-index: 2;
      padding: .6rem 1rem;
      color: #06110d;
      background: var(--mint);
      border-radius: .5rem;
    }
    .skip:focus { top: 1rem; }
    .shell { width: min(1080px, calc(100% - 2rem)); margin: 0 auto; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1.5rem 0;
    }
    .brand { font-weight: 750; letter-spacing: -.02em; text-decoration: none; }
    .status { display: inline-flex; align-items: center; gap: .5rem; color: var(--muted); font-size: .84rem; }
    .status::before { width: .5rem; height: .5rem; content: ""; background: var(--mint); border-radius: 50%; box-shadow: 0 0 1rem var(--mint); }
    main { padding: clamp(3.5rem, 9vw, 8rem) 0 4rem; }
    .eyebrow { margin: 0 0 1rem; color: var(--mint); font-size: .78rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
    h1 { max-width: 860px; margin: 0; font-size: clamp(2.7rem, 7vw, 5.8rem); line-height: .98; letter-spacing: -.055em; }
    .lede { max-width: 650px; margin: 1.6rem 0 0; color: var(--muted); font-size: clamp(1.05rem, 2.2vw, 1.3rem); }
    .actions { display: flex; flex-wrap: wrap; gap: .8rem; margin: 2rem 0 3.5rem; }
    .button { padding: .7rem 1rem; border: 1px solid var(--line); border-radius: .65rem; text-decoration: none; background: var(--panel); }
    .button:hover { border-color: var(--blue); }
    .button.primary { color: #07101f; border-color: var(--blue); background: var(--blue); font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    .card { padding: clamp(1.2rem, 3vw, 1.7rem); border: 1px solid var(--line); border-radius: 1rem; background: var(--panel); }
    .card h2 { margin: 0 0 .35rem; font-size: 1.1rem; }
    .price { color: var(--mint); font-size: .9rem; font-weight: 700; }
    .card p { margin: .7rem 0 1.1rem; color: var(--muted); }
    code { color: #c7d8ff; font: .84rem/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .principle { margin-top: 1rem; padding: 1rem 1.25rem; border-left: 3px solid var(--mint); color: var(--muted); }
    .principle strong { color: var(--ink); }
    footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; padding: 2rem 0 2.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .88rem; }
    .links { display: flex; flex-wrap: wrap; gap: 1rem; }
    @media (max-width: 680px) {
      .grid { grid-template-columns: 1fr; }
      main { padding-top: 3rem; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">
    <header aria-label="Site header">
      <a class="brand" href="/">DeliverCheck</a>
      <a class="status" href="/health">Service health</a>
    </header>
    <main id="main">
      <p class="eyebrow">Evidence-first agent commerce</p>
      <h1>Make one agent’s output usable by the next.</h1>
      <p class="lede">Diagnose contract failures for free, or repair malformed JSON and verify the result before it moves downstream.</p>
      <nav class="actions" aria-label="Primary links">
        <a class="button primary" href="/api/v1/listing">View service listing</a>
        <a class="button" href="/.well-known/agent.json">Agent card</a>
      </nav>

      <section class="grid" aria-label="Available services">
        <article class="card">
          <h2>Free diagnose</h2>
          <span class="price">0 Arena credits</span>
          <p>Find structural and schema mismatches without changing the submitted artifact.</p>
          <code>POST /api/v1/diagnose</code>
        </article>
        <article class="card">
          <h2>Verified repair</h2>
          <span class="price">7 Arena credits</span>
          <p>Produce a minimally changed candidate, then verify it against the declared contract.</p>
          <code>POST /api/v1/repair</code>
        </article>
      </section>

      <p class="principle"><strong>Never invents missing facts.</strong> DeliverCheck repairs representation and structure; it does not claim factual truth.</p>
    </main>
    <footer>
      <span>REST and MCP interfaces for reliable agent handoffs.</span>
      <nav class="links" aria-label="Technical links">
        <a href="/health">Health</a>
        <a href="/.well-known/agent.json">Agent card</a>
        <a href="/api/v1/listing">Listing</a>
        <a href="/api/mcp">MCP <code>/api/mcp</code></a>
        <a href="https://github.com/Rahmat9009/DeliverCheck">GitHub</a>
      </nav>
    </footer>
  </div>
</body>
</html>`;

export function GET(): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "public, max-age=300",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
