import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { redactStructuredValue } from "../policy/redaction.js";
import type { InterventionManager } from "./intervention-manager.js";

export type OperatorServer = {
  server: Server;
  url: string;
  waitForApproval(timeoutMs: number): Promise<boolean>;
  waitForResume(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
};

export async function createOperatorServer(manager: InterventionManager, options: {
  port?: number;
  title?: string;
  instructions?: string;
  showApproval?: boolean;
  showResume?: boolean;
  sensitiveValues?: string[];
  screenshotPath?: string;
  highlightText?: string;
  ttlSeconds?: number;
  onApprove?: () => void;
  onResume?: () => void;
  onClose?: () => void;
} = {}): Promise<OperatorServer> {
  let approvalGranted = false;
  let resumeRequested = false;
  const approvalWaiters: Array<(value: boolean) => void> = [];
  const resumeWaiters: Array<(value: boolean) => void> = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/status") {
      if (request.headers.accept?.includes("text/html") && request.url === "/") {
        sendHtml(response, 200, operatorPage(manager, {
          title: options.title ?? "LegacyBridge Operator Console",
          instructions: options.instructions,
          showApproval: options.showApproval ?? false,
          showResume: options.showResume ?? true,
          approvalGranted,
          resumeRequested,
          sensitiveValues: options.sensitiveValues ?? [],
          screenshotPath: options.screenshotPath,
          highlightText: options.highlightText,
          ttlSeconds: options.ttlSeconds
        }));
        return;
      }
      sendJson(response, 200, {
        status: manager.controlState.currentState(),
        owner: manager.controlState.currentOwner(),
        approvalGranted,
        resumeRequested,
        evidence: manager.evidence()
      });
      return;
    }

    if (url.pathname === "/screenshot" && options.screenshotPath) {
      await sendScreenshot(response, options.screenshotPath);
      return;
    }

    if (request.method === "POST" && url.pathname === "/approve") {
      approvalGranted = true;
      options.onApprove?.();
      resolveWaiters(approvalWaiters, true);
      sendHtml(response, 200, operatorPage(manager, {
        title: options.title ?? "LegacyBridge Operator Console",
        instructions: "Approval recorded. Return to the terminal for the automation result.",
        showApproval: options.showApproval ?? false,
        showResume: options.showResume ?? true,
        approvalGranted,
        resumeRequested,
        sensitiveValues: options.sensitiveValues ?? [],
        screenshotPath: options.screenshotPath,
        highlightText: options.highlightText
      }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/resume") {
      resumeRequested = true;
      options.onResume?.();
      resolveWaiters(resumeWaiters, true);
      sendHtml(response, 200, operatorPage(manager, {
        title: options.title ?? "LegacyBridge Operator Console",
        instructions: "Resume confirmed. Return to the terminal for the automation result.",
        showApproval: options.showApproval ?? false,
        showResume: options.showResume ?? true,
        approvalGranted,
        resumeRequested,
        sensitiveValues: options.sensitiveValues ?? [],
        screenshotPath: options.screenshotPath,
        highlightText: options.highlightText
      }));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/close" || url.pathname === "/timeout")) {
      options.onClose?.();
      resolveWaiters(approvalWaiters, false);
      resolveWaiters(resumeWaiters, false);
      sendHtml(response, 200, operatorClosedPage(url.pathname === "/timeout" ? "Timer expired." : "Operator window closed."));
      return;
    }

    sendJson(response, 404, {
      error: "not found"
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected operator server to listen on a TCP address");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    waitForApproval(timeoutMs: number) {
      if (approvalGranted) {
        return Promise.resolve(true);
      }
      return waitForSignal(approvalWaiters, timeoutMs);
    },
    waitForResume(timeoutMs: number) {
      if (resumeRequested) {
        return Promise.resolve(true);
      }
      return waitForSignal(resumeWaiters, timeoutMs);
    },
    async close() {
      resolveWaiters(approvalWaiters, false);
      resolveWaiters(resumeWaiters, false);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function waitForSignal(waiters: Array<(value: boolean) => void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    waiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function resolveWaiters(waiters: Array<(value: boolean) => void>, value: boolean): void {
  while (waiters.length > 0) {
    waiters.shift()?.(value);
  }
}

function operatorPage(manager: InterventionManager, options: {
  title: string;
  instructions?: string;
  showApproval: boolean;
  showResume: boolean;
  approvalGranted: boolean;
  resumeRequested: boolean;
  sensitiveValues: string[];
  screenshotPath?: string;
  highlightText?: string;
  ttlSeconds?: number;
}): string {
  const evidence = redactStructuredValue(manager.evidence(), options.sensitiveValues);
  const intervention = evidence.intervention;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(options.title)}</title>
  <style>
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111; background: #f3f4f6; }
    header { position: sticky; top: 0; z-index: 2; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: #12395a; color: white; padding: 12px 16px; border-bottom: 3px solid #7a8794; }
    h1 { margin: 0 12px 0 0; font-size: 20px; letter-spacing: 0; }
    main { padding: 16px; }
    button { font: inherit; padding: 7px 12px; margin-right: 8px; border: 1px solid #555; background: #efefef; }
    .panel { background: white; border: 1px solid #bbb; padding: 12px; margin-bottom: 12px; }
    .label { font-weight: bold; display: inline-block; min-width: 135px; }
    .timer { font-family: "Courier New", monospace; padding: 6px 10px; border: 1px solid rgba(255,255,255,.55); }
    .screenshot-wrap { position: relative; display: inline-block; max-width: 100%; border: 1px solid #777; background: white; }
    .screenshot-wrap img { display: block; max-width: 100%; height: auto; }
    .highlight { position: absolute; top: 72px; right: 32px; border: 3px solid #f59e0b; background: rgba(255,255,255,.92); padding: 8px 10px; font-weight: bold; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
    .highlight:after { content: ""; position: absolute; right: 18px; top: 100%; width: 0; height: 0; border-left: 9px solid transparent; border-right: 9px solid transparent; border-top: 14px solid #f59e0b; }
    pre { white-space: pre-wrap; overflow: auto; background: #111827; color: #f9fafb; padding: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(options.title)}</h1>
    ${options.ttlSeconds ? `<span class="timer">Time left: <span id="countdown">${options.ttlSeconds}</span>s</span>` : ""}
    ${options.showApproval ? `<form method="post" action="/approve" style="display:inline"><button type="submit">${options.approvalGranted ? "Approval Recorded" : "Approve Action"}</button></form>` : ""}
    ${options.showResume ? `<form method="post" action="/resume" style="display:inline"><button type="submit">${options.resumeRequested ? "Resume Requested" : "Confirm Resume"}</button></form>` : ""}
    <form method="post" action="/close" style="display:inline"><button type="submit">Close</button></form>
  </header>
  <main>
    <section class="panel">
      <p>${escapeHtml(options.instructions ?? "Review the intervention context, then use the action button at the top of this page.")}</p>
      <p><span class="label">State</span>${escapeHtml(manager.controlState.currentState())}</p>
      <p><span class="label">Owner</span>${escapeHtml(manager.controlState.currentOwner())}</p>
      <p><span class="label">Reason</span>${escapeHtml(intervention?.reason ?? "none")}</p>
      <p><span class="label">Current route</span>${escapeHtml(intervention?.currentRoute ?? "none")}</p>
    </section>
    ${options.screenshotPath ? `
    <section class="panel">
      <h2>Current Screen</h2>
      <div class="screenshot-wrap">
        <img src="/screenshot" alt="Captured application screen" />
        ${options.highlightText ? `<div class="highlight">Click target: ${escapeHtml(options.highlightText)}</div>` : ""}
      </div>
    </section>` : ""}
    <section class="panel">
      <h2>Evidence</h2>
      <pre>${escapeHtml(JSON.stringify(evidence, null, 2))}</pre>
    </section>
  </main>
  ${options.ttlSeconds ? countdownScript(options.ttlSeconds) : ""}
</body>
</html>`;
}

function operatorClosedPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>LegacyBridge Operator Window</title></head>
<body><h1>${escapeHtml(message)}</h1><p>You can return to the terminal for the final automation result.</p></body>
</html>`;
}

function countdownScript(ttlSeconds: number): string {
  return `<script>
    let remaining = ${ttlSeconds};
    let stopped = false;
    const countdown = document.getElementById("countdown");
    for (const form of document.querySelectorAll("form")) {
      form.addEventListener("submit", () => {
        stopped = true;
      });
    }
    const timer = setInterval(() => {
      if (stopped) {
        clearInterval(timer);
        return;
      }
      remaining -= 1;
      if (countdown) {
        countdown.textContent = String(Math.max(remaining, 0));
      }
      if (remaining <= 0) {
        stopped = true;
        clearInterval(timer);
        fetch("/timeout", { method: "POST" }).finally(() => {
          document.body.innerHTML = "<h1>Timer expired.</h1><p>Return to the terminal for the automation result.</p>";
        });
      }
    }, 1000);
  </script>`;
}

async function sendScreenshot(response: ServerResponse, path: string): Promise<void> {
  const body = await readFile(resolve(path));
  response.writeHead(200, {
    "Content-Type": contentTypeFor(path),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function contentTypeFor(path: string): string {
  return extname(path).toLowerCase() === ".png" ? "image/png" : "application/octet-stream";
}

function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
