import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultPort = Number(process.env.PORT ?? 3010);

type RiversideUser = {
  username: string;
  passwordHash: string;
  role: "READ_ONLY";
};

const users: Record<string, RiversideUser> = {
  analyst: {
    username: "analyst",
    passwordHash: hashPassword("a123"),
    role: "READ_ONLY"
  }
};

const memberBalances: Record<string, Array<{ product: string; account: string; available: string }>> = {
  "24680": [
    {
      product: "Everyday Share",
      account: "RS-240001",
      available: "$1,420.55"
    },
    {
      product: "Rainy Day Checking",
      account: "RC-240778",
      available: "$6,230.04"
    }
  ]
};

export type RiversideAppServer = ReturnType<typeof createRiversideAppServer>;

export function createRiversideAppServer(options: {
  authRequired?: boolean;
} = {}) {
  const sessions = new Map<string, string>();
  const authRequired = options.authRequired ?? false;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const currentUser = currentUserFromRequest(request, sessions);

      if (url.pathname === "/signin") {
        if (request.method === "POST") {
          await handleLogin(request, response, sessions);
          return;
        }
        sendHtml(response, 200, layout("Riverside Member Console - Sign In", loginPage()));
        return;
      }

      if (url.pathname === "/signout") {
        const sessionId = cookieValue(request.headers.cookie, "rs_session");
        if (sessionId) {
          sessions.delete(sessionId);
        }
        response.writeHead(302, {
          Location: "/signin",
          "Set-Cookie": "rs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
        });
        response.end();
        return;
      }

      if (authRequired && !currentUser) {
        redirect(response, "/signin");
        return;
      }

      if (url.pathname === "/" || url.pathname === "/console" || url.pathname === "/console/member-lookup") {
        sendHtml(response, 200, layout("Riverside Member Console - Lookup", lookupPage(currentUser)));
        return;
      }

      if (url.pathname === "/console/member") {
        sendHtml(response, 200, layout("Riverside Member Console - Relationship Summary", relationshipSummary(url)));
        return;
      }

      sendHtml(response, 404, layout("Riverside Member Console - Not Found", "<h1>Screen not found</h1>"));
    } catch (error) {
      sendHtml(response, 500, layout("Riverside Member Console - Error", `<h1>Host Error</h1><p>${escapeHtml(String(error))}</p>`));
    }
  });
}

async function handleLogin(request: IncomingMessage, response: ServerResponse, sessions: Map<string, string>): Promise<void> {
  const params = new URLSearchParams(await readRequestBody(request));
  const username = params.get("operatorId")?.trim() ?? "";
  const passcode = params.get("passcode") ?? "";
  const user = users[username];

  if (!user || user.passwordHash !== hashPassword(passcode)) {
    sendHtml(response, 401, layout("Riverside Member Console - Sign In", `${loginPage()}<p class="error">Invalid operator credentials.</p>`));
    return;
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, username);
  response.writeHead(302, {
    Location: "/console/member-lookup",
    "Set-Cookie": `rs_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`
  });
  response.end();
}

function loginPage(): string {
  return `
    <section class="signin">
      <h1>Riverside Member Console</h1>
      <form method="post" action="/signin">
        <label for="operatorId">Operator ID</label>
        <input id="operatorId" name="operatorId" autocomplete="off" />
        <label for="passcode">Passcode</label>
        <input id="passcode" name="passcode" type="password" />
        <button type="submit">Enter Console</button>
      </form>
    </section>
  `;
}

function lookupPage(currentUser: RiversideUser | undefined): string {
  return `
    <header class="topbar">
      <strong>Riverside</strong>
      <span>${currentUser ? `Signed in as ${escapeHtml(currentUser.username)}` : "Demo access"}</span>
    </header>
    <main class="shell">
      <section class="lookup-panel">
        <h1>Customer Lookup</h1>
        <form action="/console/member" method="get">
          <label for="customerNumber">Customer Number</label>
          <input id="customerNumber" name="customerNumber" autocomplete="off" />
          <button type="submit">Find Relationship</button>
        </form>
      </section>
    </main>
  `;
}

function relationshipSummary(url: URL): string {
  const customerNumber = url.searchParams.get("customerNumber")?.trim() ?? "";
  const balances = memberBalances[customerNumber];

  if (!balances) {
    return `
      <main class="shell">
        <a href="/console/member-lookup">Back to lookup</a>
        <h1>Relationship Summary</h1>
        <p class="empty">No relationship found for ${escapeHtml(customerNumber)}.</p>
      </main>
    `;
  }

  const rows = balances.map((account) => `
    <tr>
      <td>${escapeHtml(account.product)}</td>
      <td>${escapeHtml(account.account)}</td>
      <td>${escapeHtml(account.available)}</td>
    </tr>
  `).join("");

  return `
    <main class="shell">
      <a href="/console/member-lookup">Back to lookup</a>
      <h1>Relationship Summary</h1>
      <p>Customer ${escapeHtml(customerNumber)}</p>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Account</th>
            <th>Available Balance</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </main>
  `;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(title)}</title>
      <style>
        body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: #f4f7f6; color: #17211f; }
        .topbar { display: flex; justify-content: space-between; padding: 14px 22px; background: #154734; color: white; }
        .shell { max-width: 880px; margin: 42px auto; padding: 0 22px; }
        .signin { max-width: 360px; margin: 80px auto; padding: 28px; background: white; border: 1px solid #d8e2de; }
        .lookup-panel { background: white; border-left: 5px solid #154734; padding: 26px; }
        h1 { font-size: 26px; margin: 0 0 20px; }
        label { display: block; font-weight: 700; margin: 14px 0 6px; }
        input { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #9fb2aa; font-size: 16px; }
        button { margin-top: 18px; padding: 10px 14px; border: 0; background: #154734; color: white; font-weight: 700; cursor: pointer; }
        table { width: 100%; border-collapse: collapse; background: white; margin-top: 18px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #d8e2de; }
        th { background: #e6efeb; }
        a { color: #154734; }
        .error { color: #b42318; font-weight: 700; }
        .empty { background: white; padding: 18px; border: 1px solid #d8e2de; }
      </style>
    </head>
    <body>${body}</body>
  </html>`;
}

function currentUserFromRequest(request: IncomingMessage, sessions: Map<string, string>): RiversideUser | undefined {
  const sessionId = cookieValue(request.headers.cookie, "rs_session");
  const username = sessionId ? sessions.get(sessionId) : undefined;
  return username ? users[username] : undefined;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .map((part) => part.split("="))
    .find(([key]) => key === name)?.[1];
}

function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { Location: location });
  response.end();
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createRiversideAppServer({ authRequired: true }).listen(defaultPort, () => {
    console.log(`Riverside Member Console running at http://localhost:${defaultPort}/console/member-lookup`);
  });
}
