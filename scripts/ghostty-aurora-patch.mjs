#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const demoPath =
  process.env.GHOSTTY_WEB_DEMO_BIN ||
  "/usr/local/lib/node_modules/@ghostty-web/demo/bin/demo.js";

const startMarker = "const HTML_TEMPLATE = `";
const endMarker =
  "`;\n\n// ============================================================================\n// MIME Types";

const html = `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>incus-web terminal</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;480;560;650&family=JetBrains+Mono:wght@400;520;600&family=Manrope:wght@700;800&display=swap" rel="stylesheet">
    <style>
      :root,
      .dark {
        --aurora-page-bg: #07131c;
        --aurora-panel-medium: #102330;
        --aurora-panel-strong: #13293a;
        --aurora-control-surface: #0c1a24;
        --aurora-hover-bg: #17364b;
        --aurora-border-default: #1d3d4e;
        --aurora-border-strong: #24536c;
        --aurora-text-primary: #e6f4fb;
        --aurora-text-muted: #a7bcc9;
        --aurora-accent-primary: #29b6f6;
        --aurora-accent-strong: #67cbfa;
        --aurora-success: #7dd3c7;
        --aurora-warn: #c6a36b;
        --aurora-error: #c78490;
        --aurora-info: #72c8f5;
        --aurora-radius-2: 18px;
        --aurora-shadow-strong: 0 20px 38px rgba(0, 0, 0, 0.26);
        --aurora-highlight-medium: inset 0 1px 0 rgba(255, 255, 255, 0.035);
        --aurora-active-glow: 0 0 0 1px color-mix(in srgb, var(--aurora-accent-primary) 28%, transparent),
          0 2px 8px color-mix(in srgb, var(--aurora-accent-primary) 18%, transparent);
        --aurora-font-display: 'Manrope', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        --aurora-font-sans: 'Inter', 'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        --aurora-font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;
        --aurora-shell-bg: radial-gradient(circle at 12% 0%, rgba(41, 182, 246, 0.09), transparent 28%),
          radial-gradient(circle at 88% 0%, rgba(28, 127, 172, 0.1), transparent 24%),
          var(--aurora-page-bg);
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      html {
        min-height: 100%;
        background: var(--aurora-page-bg);
      }

      body {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
        background: var(--aurora-shell-bg);
        color: var(--aurora-text-primary);
        font-family: var(--aurora-font-sans);
        font-feature-settings: "kern" 1, "liga" 1, "cv05" 1, "cv10" 1;
        line-height: 1.58;
        text-rendering: geometricPrecision;
        -moz-osx-font-smoothing: grayscale;
        -webkit-font-smoothing: antialiased;
      }

      .terminal-window {
        width: min(100%, 1120px);
        min-height: 680px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--aurora-border-strong);
        border-radius: var(--aurora-radius-2);
        background: var(--aurora-page-bg);
        box-shadow: var(--aurora-shadow-strong), var(--aurora-active-glow);
      }

      .title-bar {
        height: 42px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
        padding: 0 14px;
        border-bottom: 1px solid var(--aurora-border-default);
        background: var(--aurora-panel-strong);
        box-shadow: var(--aurora-highlight-medium);
      }

      .labby-mark {
        width: 10px;
        height: 14px;
        flex: 0 0 auto;
      }

      .title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--aurora-text-muted);
        font-family: var(--aurora-font-mono);
        font-size: 12px;
        font-weight: 520;
        letter-spacing: 0;
      }

      .session-chip {
        padding: 3px 7px;
        border: 1px solid color-mix(in srgb, var(--aurora-accent-primary) 34%, transparent);
        border-radius: 4px;
        background: color-mix(in srgb, var(--aurora-accent-primary) 12%, var(--aurora-panel-medium));
        color: color-mix(in srgb, var(--aurora-accent-primary) 88%, white);
        font-family: var(--aurora-font-mono);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0;
      }

      .connection-status {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        color: var(--aurora-text-muted);
        font-size: 11px;
        font-weight: 560;
        letter-spacing: 0.012em;
      }

      .status-dot {
        width: 7px;
        height: 7px;
        flex: 0 0 auto;
        border-radius: 999px;
        background: var(--aurora-neutral, var(--aurora-text-muted));
      }

      .status-dot.connected {
        background: var(--aurora-success);
        box-shadow: 0 0 7px color-mix(in srgb, var(--aurora-success) 70%, transparent);
      }

      .status-dot.disconnected {
        background: var(--aurora-error);
        box-shadow: 0 0 7px color-mix(in srgb, var(--aurora-error) 62%, transparent);
      }

      .status-dot.connecting {
        background: var(--aurora-warn);
        box-shadow: 0 0 7px color-mix(in srgb, var(--aurora-warn) 62%, transparent);
        animation: aurora-pulse 1.2s ease-in-out infinite;
      }

      .window-dots {
        display: flex;
        align-items: center;
        gap: 4px;
        padding-left: 4px;
      }

      .window-dots span {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        background: var(--aurora-border-strong);
      }

      .terminal-content {
        position: relative;
        flex: 1;
        min-height: 0;
        padding: 16px;
        overflow: hidden;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--aurora-control-surface) 82%, transparent), transparent 38%),
          var(--aurora-page-bg);
      }

      .terminal-content::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        border-top: 1px solid color-mix(in srgb, var(--aurora-accent-primary) 14%, transparent);
      }

      .terminal-content canvas {
        display: block;
      }

      @keyframes aurora-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.48; }
      }

      @media (max-width: 768px) {
        body {
          padding: 18px 12px;
        }

        .terminal-window {
          min-height: calc(100vh - 36px);
        }

        .title-bar {
          height: 40px;
          padding: 0 10px;
        }

        .session-chip {
          display: none;
        }

        .terminal-content {
          padding: 12px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 1ms !important;
          animation-iteration-count: 1 !important;
          scroll-behavior: auto !important;
          transition-duration: 1ms !important;
        }
      }
    </style>
  </head>
  <body>
    <div class="terminal-window">
      <div class="title-bar">
        <svg class="labby-mark" viewBox="0 0 10 14" fill="none" aria-hidden="true">
          <path d="M5 0L9 2.5L5 5L1 2.5Z" fill="var(--aurora-accent-primary)" opacity="0.95" />
          <path d="M5 3L9 5.5L5 8L1 5.5Z" fill="var(--aurora-accent-primary)" opacity="0.75" />
          <path d="M5 6L9 8.5L5 11L1 8.5Z" fill="var(--aurora-accent-primary)" opacity="0.5" />
          <path d="M5 9L9 11.5L5 14L1 11.5Z" fill="var(--aurora-accent-primary)" opacity="0.28" />
        </svg>
        <span class="title">incus-web terminal</span>
        <span class="session-chip">ghostty-web</span>
        <div class="connection-status">
          <div class="status-dot connecting" id="status-dot"></div>
          <span id="status-text">Connecting...</span>
        </div>
        <div class="window-dots" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
      <div class="terminal-content" id="terminal"></div>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';

      await init();
      const term = new Terminal({
        cols: 80,
        rows: 24,
        fontFamily: 'JetBrains Mono, IBM Plex Mono, ui-monospace, Menlo, monospace',
        fontSize: 13,
        theme: {
          background: '#07131c',
          foreground: '#e6f4fb',
          cursor: '#29b6f6',
          selectionBackground: 'rgba(41, 182, 246, 0.22)',
          black: '#07131c',
          red: '#c78490',
          green: '#7dd3c7',
          yellow: '#c6a36b',
          blue: '#72c8f5',
          magenta: '#f9a8c4',
          cyan: '#29b6f6',
          white: '#e6f4fb',
          brightBlack: '#5d7482',
          brightRed: '#d9909a',
          brightGreen: '#9de2d8',
          brightYellow: '#e2c48a',
          brightBlue: '#67cbfa',
          brightMagenta: '#fbc4d6',
          brightCyan: '#67cbfa',
          brightWhite: '#ffffff',
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const container = document.getElementById('terminal');
      await term.open(container);
      fitAddon.fit();
      fitAddon.observeResize();

      const statusDot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');

      function setStatus(status, text) {
        statusDot.className = 'status-dot ' + status;
        statusText.textContent = text;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;

      async function fetchAuthToken() {
        const response = await fetch('/api/token', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Token request failed with HTTP ' + response.status);
        }

        const body = await response.json();
        if (!body || typeof body.token !== 'string' || body.token.length === 0) {
          throw new Error('Token response did not include a token');
        }

        return body.token;
      }

      function buildWebSocketUrl(token) {
        const params = new URLSearchParams();
        params.set('cols', String(term.cols));
        params.set('rows', String(term.rows));
        params.set('token', token);
        return protocol + '//' + window.location.host + '/ws?' + params.toString();
      }

      async function connect() {
        setStatus('connecting', 'Authenticating...');

        let token;
        try {
          token = await fetchAuthToken();
        } catch (error) {
          console.error('Authentication failed:', error);
          setStatus('disconnected', 'Auth error');
          term.write('\\r\\n\\x1b[31mAuthentication failed. Retrying in 2s...\\x1b[0m\\r\\n');
          setTimeout(connect, 2000);
          return;
        }

        setStatus('connecting', 'Connecting...');
        ws = new WebSocket(buildWebSocketUrl(token));

        ws.onopen = () => {
          setStatus('connected', 'Connected');
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onclose = () => {
          setStatus('disconnected', 'Disconnected');
          term.write('\\r\\n\\x1b[31mConnection closed. Reconnecting in 2s...\\x1b[0m\\r\\n');
          setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          setStatus('disconnected', 'Error');
        };
      }

      connect();

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      window.addEventListener('resize', () => {
        fitAddon.fit();
      });

      if (window.visualViewport) {
        const terminalContent = document.querySelector('.terminal-content');
        const terminalWindow = document.querySelector('.terminal-window');
        const originalHeight = terminalContent.style.height;
        const body = document.body;

        window.visualViewport.addEventListener('resize', () => {
          const keyboardHeight = window.innerHeight - window.visualViewport.height;
          if (keyboardHeight > 100) {
            body.style.padding = '0';
            body.style.alignItems = 'flex-start';
            terminalWindow.style.borderRadius = '0';
            terminalWindow.style.maxWidth = '100%';
            terminalWindow.style.minHeight = '100vh';
            terminalContent.style.height = (window.visualViewport.height - 42) + 'px';
            window.scrollTo(0, 0);
          } else {
            body.style.padding = '40px 20px';
            body.style.alignItems = 'center';
            terminalWindow.style.borderRadius = 'var(--aurora-radius-2)';
            terminalWindow.style.maxWidth = '1120px';
            terminalWindow.style.minHeight = '680px';
            terminalContent.style.height = originalHeight || '';
          }
          fitAddon.fit();
        });
      }
    </script>
  </body>
</html>`;

const currentSource = readFileSync(demoPath, "utf8");
const backupPath = `${demoPath}.incus-web-stock`;
const source = currentSource.includes(startMarker) || !existsSync(backupPath)
  ? currentSource
  : readFileSync(backupPath, "utf8");
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start === -1 || end === -1) {
  throw new Error(`Could not locate ghostty-web demo HTML template in ${demoPath}`);
}

if (!existsSync(backupPath)) {
  writeFileSync(backupPath, source, "utf8");
}

const patched =
  source.slice(0, start) +
  `const HTML_TEMPLATE = ${JSON.stringify(html)};` +
  source.slice(end + 2);

writeFileSync(demoPath, patched, "utf8");
console.log(`patched ${demoPath} with Aurora terminal chrome`);
