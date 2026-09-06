import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { URL } from "node:url";
import type { AccountTransaction, Member } from "./data.js";
import { loadPersistentState, savePersistentState, seededState } from "./state-store.js";

const defaultPort = Number(process.env.PORT ?? 3000);

export type DemoAppServer = ReturnType<typeof createDemoAppServer>;

type RequestContext = {
  url: URL;
  scenario?: string;
  noticeDismissed: boolean;
  members: Record<string, Member>;
  persistState: () => void;
};

export function createDemoAppServer(options: {
  persistState?: boolean;
  statePath?: string;
} = {}) {
  const state = options.persistState
    ? loadPersistentState(options.statePath)
    : seededState();
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const context: RequestContext = {
        url: requestUrl,
        scenario: requestUrl.searchParams.get("scenario") ?? undefined,
        noticeDismissed: requestUrl.searchParams.get("dismissNotice") === "1",
        members: state.members,
        persistState: () => {
          if (options.persistState) {
            savePersistentState(state, options.statePath);
          }
        }
      };

      if (context.scenario === "slow") {
        await delay(850);
      }

      routeRequest(request, response, context);
    } catch (error) {
      sendHtml(response, 500, layout("Application Error", systemErrorPage(String(error)), { hideNotice: true }));
    }
  });
}

function routeRequest(_request: IncomingMessage, response: ServerResponse, context: RequestContext): void {
  const pathname = context.url.pathname;

  if (context.scenario === "session-expired") {
    sendHtml(response, 440, layout("Session Expired", sessionExpiredPage(), { hideNotice: true }));
    return;
  }

  if (context.scenario === "error") {
    sendHtml(response, 500, layout("Application Error", systemErrorPage("Simulated host exception HC-5007."), { hideNotice: true }));
    return;
  }

  if (pathname === "/" || pathname === "/servicing" || pathname === "/servicing/search") {
    sendHtml(response, 200, layout("Heritage Core Servicing - Member Search", memberSearchPage(context), noticeOptions(context)));
    return;
  }

  if (pathname === "/servicing/member/search") {
    const memberId = context.url.searchParams.get("memberNumber")?.trim() ?? "";
    redirect(response, withScenario(`/servicing/member/${encodeURIComponent(memberId)}`, context));
    return;
  }

  const memberMatch = pathname.match(/^\/servicing\/member\/([^/]+)$/);
  if (memberMatch) {
    sendMemberDetails(response, decodeURIComponent(memberMatch[1] ?? ""), context);
    return;
  }

  const accountsFrameMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/accounts-frame$/);
  if (accountsFrameMatch) {
    sendAccountsFrame(response, decodeURIComponent(accountsFrameMatch[1] ?? ""), context);
    return;
  }

  const accountTransactionsMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/account-transactions$/);
  if (accountTransactionsMatch) {
    sendAccountTransactions(response, decodeURIComponent(accountTransactionsMatch[1] ?? ""), context);
    return;
  }

  const accountTransactionMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/account-transaction$/);
  if (accountTransactionMatch) {
    sendAccountTransactionForm(response, decodeURIComponent(accountTransactionMatch[1] ?? ""), context);
    return;
  }

  const accountTransactionReviewMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/account-transaction-review$/);
  if (accountTransactionReviewMatch) {
    sendAccountTransactionReview(response, decodeURIComponent(accountTransactionReviewMatch[1] ?? ""), context);
    return;
  }

  const accountTransactionConfirmationMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/account-transaction-confirmed$/);
  if (accountTransactionConfirmationMatch) {
    sendAccountTransactionConfirmation(response, decodeURIComponent(accountTransactionConfirmationMatch[1] ?? ""), context);
    return;
  }

  const openSubAccountMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/open-sub-account$/);
  if (openSubAccountMatch) {
    sendOpenSubAccountForm(response, decodeURIComponent(openSubAccountMatch[1] ?? ""), context);
    return;
  }

  const reviewMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/sub-account-review$/);
  if (reviewMatch) {
    sendReview(response, decodeURIComponent(reviewMatch[1] ?? ""), context);
    return;
  }

  const confirmMatch = pathname.match(/^\/servicing\/member\/([^/]+)\/sub-account-confirmed$/);
  if (confirmMatch) {
    sendConfirmation(response, decodeURIComponent(confirmMatch[1] ?? ""), context);
    return;
  }

  sendHtml(response, 404, layout("Not Found", `<h2>Screen not found</h2><p>No host screen exists for ${escapeHtml(pathname)}.</p>`));
}

function memberSearchPage(context: RequestContext): string {
  const generatedId = generatedHostId("memberNumber", context);
  return `
    <h2>Member Search</h2>
    <table class="layout-table">
      <tr>
        <td class="nav-cell">
          <form action="/servicing/member/search" method="get">
            ${hiddenScenarioInput(context)}
            <label for="${generatedId}">Member Number</label>
            <input id="${generatedId}" name="memberNumber" autocomplete="off" />
            <div class="button-row">
              <button type="submit">Search</button>
              <button type="reset">Search</button>
            </div>
          </form>
        </td>
        <td>
          <h3>Operator Queue</h3>
          <table class="nested-table">
            <tr><th>Queue</th><th>Count</th></tr>
            <tr><td>New requests</td><td>4</td></tr>
            <tr><td>Exceptions</td><td>1</td></tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function sendMemberDetails(response: ServerResponse, memberId: string, context: RequestContext): void {
  if (memberId === "00000" || memberId.length === 0) {
    sendHtml(response, 200, layout("Heritage Core Servicing - Member Not Found", memberNotFoundPage(memberId), noticeOptions(context)));
    return;
  }

  const member = context.members[memberId];
  if (!member) {
    sendHtml(response, 200, layout("Heritage Core Servicing - Member Not Found", memberNotFoundPage(memberId), noticeOptions(context)));
    return;
  }

  if (member.status === "restricted") {
    sendHtml(response, 403, layout("Heritage Core Servicing - Permission Denied", permissionDeniedPage(member), noticeOptions(context)));
    return;
  }

  sendHtml(response, 200, layout("Heritage Core Servicing - Member Details", memberDetailsPage(member, context), noticeOptions(context)));
}

function memberDetailsPage(member: Member, context: RequestContext): string {
  return `
    <h2>Member Details</h2>
    <table class="layout-table">
      <tr>
        <td class="label-cell">Member Number</td>
        <td>${escapeHtml(member.id)}</td>
        <td class="label-cell">Branch</td>
        <td>${escapeHtml(member.branch)}</td>
      </tr>
      <tr>
        <td class="label-cell">Member Name</td>
        <td>${escapeHtml(member.name)}</td>
        <td class="label-cell">Status</td>
        <td>Active</td>
      </tr>
    </table>
    <div class="toolbar">
      <a class="host-button" href="${withScenario(`/servicing/member/${member.id}/open-sub-account`, context)}">Open Sub Account</a>
      <button>Print</button>
      <button>Print</button>
    </div>
    <h3>Accounts</h3>
    <iframe name="acctFrame" title="Accounts" src="/servicing/member/${encodeURIComponent(member.id)}/accounts-frame"></iframe>
  `;
}

function sendAccountsFrame(response: ServerResponse, memberId: string, context: RequestContext): void {
  const member = context.members[memberId];
  if (!member || member.status !== "active") {
    sendHtml(response, 404, frameLayout("<p>Accounts unavailable.</p>"));
    return;
  }

  const rows = member.accounts
    .map(
      (account) => {
        const query = accountQuery(account.number, context);
        return `
        <tr>
          <td>${escapeHtml(account.type)}</td>
          <td>${escapeHtml(account.number)}</td>
          <td class="amount">${escapeHtml(account.balance)}</td>
          <td>
            <a class="host-button" target="_top" href="/servicing/member/${encodeURIComponent(member.id)}/account-transaction?operation=deposit&${query}">Deposit</a>
            <a class="host-button" target="_top" href="/servicing/member/${encodeURIComponent(member.id)}/account-transaction?operation=withdraw&${query}">Withdraw</a>
            <a class="host-button" target="_top" href="/servicing/member/${encodeURIComponent(member.id)}/account-transactions?${query}">Transactions</a>
          </td>
        </tr>`;
      }
    )
    .join("");

  sendHtml(
    response,
    200,
    frameLayout(`
      <table class="accounts-table">
        <tr><th>Account Type</th><th>Account Number</th><th>Balance</th><th>Actions</th></tr>
        ${rows}
      </table>
    `)
  );
}

function sendAccountTransactions(response: ServerResponse, memberId: string, context: RequestContext): void {
  const member = context.members[memberId];
  if (!member || member.status !== "active") {
    sendHtml(response, 404, layout("Transactions", memberNotFoundPage(memberId), noticeOptions(context)));
    return;
  }

  const account = findAccountByNumber(member, context.url.searchParams.get("accountNumber"));
  if (!account) {
    sendHtml(response, 200, layout("Transactions", businessMessagePage("Account not found", `No account exists for member ${member.id} with the supplied account number.`), noticeOptions(context)));
    return;
  }

  const rows = recentTransactions(account)
    .map((transaction) => `
      <tr>
        <td>${escapeHtml(transaction.datetime)}</td>
        <td>${escapeHtml(transaction.accountNumber)}</td>
        <td>${escapeHtml(transaction.accountType)}</td>
        <td>${escapeHtml(transaction.type)}</td>
        <td class="amount">${escapeHtml(transaction.amount)}</td>
        <td class="amount">${escapeHtml(transaction.balance)}</td>
      </tr>`
    )
    .join("");

  sendHtml(
    response,
    200,
    layout(
      "Heritage Core Servicing - Transactions",
      `
        <h2>Transactions</h2>
        <p>Member ${escapeHtml(member.id)} - ${escapeHtml(member.name)}</p>
        <table class="layout-table">
          <tr><td class="label-cell">Account Type</td><td>${escapeHtml(account.type)}</td></tr>
          <tr><td class="label-cell">Account Number</td><td>${escapeHtml(account.number)}</td></tr>
          <tr><td class="label-cell">Current Balance</td><td>${escapeHtml(account.balance)}</td></tr>
        </table>
        <h3>Most Recent 10 Transactions</h3>
        <table class="accounts-table">
          <tr><th>Date/Time</th><th>Account Number</th><th>Account Type</th><th>Type</th><th>Amount</th><th>Balance</th></tr>
          ${rows || `<tr><td colspan="6">No transactions found</td></tr>`}
        </table>
        <a class="host-button" href="${withScenario(`/servicing/member/${member.id}`, context)}">Return to Member Details</a>
      `,
      noticeOptions(context)
    )
  );
}

function sendAccountTransactionForm(response: ServerResponse, memberId: string, context: RequestContext): void {
  const member = context.members[memberId];
  if (!member || member.status !== "active") {
    sendHtml(response, 404, layout("Account Transaction", memberNotFoundPage(memberId), noticeOptions(context)));
    return;
  }

  const operation = normalizeOperation(context.url.searchParams.get("operation"));
  const account = findAccountByNumber(member, context.url.searchParams.get("accountNumber"));
  if (!account) {
    sendHtml(response, 200, layout("Account Transaction", businessMessagePage("Account not found", `No account exists for member ${member.id} with the supplied account number.`), noticeOptions(context)));
    return;
  }

  const amountId = generatedHostId("amount", context);
  const memoId = generatedHostId("memo", context);
  const title = operation === "deposit" ? "Deposit Funds" : "Withdraw Funds";

  sendHtml(
    response,
    200,
    layout(
      `Heritage Core Servicing - ${title}`,
      `
        <h2>${title}</h2>
        <p>Member ${escapeHtml(member.id)} - ${escapeHtml(member.name)}</p>
        <form action="/servicing/member/${encodeURIComponent(member.id)}/account-transaction-review" method="get">
          ${hiddenScenarioInput(context)}
          <input type="hidden" name="operation" value="${operation}" />
          <input type="hidden" name="accountNumber" value="${escapeAttribute(account.number)}" />
          <table class="layout-table">
            <tr><td class="label-cell">Account Type</td><td>${escapeHtml(account.type)}</td></tr>
            <tr><td class="label-cell">Account Number</td><td>${escapeHtml(account.number)}</td></tr>
            <tr><td class="label-cell">Current Balance</td><td>${escapeHtml(account.balance)}</td></tr>
            <tr>
              <td><label for="${amountId}">Amount</label></td>
              <td><input id="${amountId}" name="amount" autocomplete="off" value="25.00" /></td>
            </tr>
            <tr>
              <td><label for="${memoId}">Memo</label></td>
              <td><input id="${memoId}" name="memo" value="${operation === "deposit" ? "Counter deposit" : "Counter withdrawal"}" /></td>
            </tr>
          </table>
          <div class="button-row">
            <button type="submit">Continue</button>
            <a class="host-button" href="${withScenario(`/servicing/member/${member.id}`, context)}">Cancel</a>
          </div>
        </form>
      `,
      noticeOptions(context)
    )
  );
}

function sendAccountTransactionReview(response: ServerResponse, memberId: string, context: RequestContext): void {
  const transaction = resolveTransaction(memberId, context);
  if (!transaction.ok) {
    sendHtml(response, 200, layout("Transaction Review", businessMessagePage(transaction.title, transaction.message), noticeOptions(context)));
    return;
  }

  const { account, amount, member, operation } = transaction;
  const currentBalance = parseMoney(account.balance);
  const projectedBalance = operation === "deposit" ? currentBalance + amount : currentBalance - amount;
  const title = operation === "deposit" ? "Deposit Review" : "Withdrawal Review";

  sendHtml(
    response,
    200,
    layout(
      `Heritage Core Servicing - ${title}`,
      `
        <h2>${title}</h2>
        <div class="warning">Confirm ${operation === "deposit" ? "Deposit" : "Withdrawal"} changes persisted account data and requires human approval in automation.</div>
        <table class="layout-table">
          <tr><td class="label-cell">Member</td><td>${escapeHtml(member.id)} - ${escapeHtml(member.name)}</td></tr>
          <tr><td class="label-cell">Account Type</td><td>${escapeHtml(account.type)}</td></tr>
          <tr><td class="label-cell">Account Number</td><td>${escapeHtml(account.number)}</td></tr>
          <tr><td class="label-cell">Current Balance</td><td>${escapeHtml(account.balance)}</td></tr>
          <tr><td class="label-cell">Amount</td><td>${escapeHtml(formatMoney(amount))}</td></tr>
          <tr><td class="label-cell">Projected Balance</td><td>${escapeHtml(formatMoney(projectedBalance))}</td></tr>
        </table>
        <form action="/servicing/member/${encodeURIComponent(member.id)}/account-transaction-confirmed" method="get">
          ${hiddenScenarioInput(context)}
          <input type="hidden" name="operation" value="${operation}" />
          <input type="hidden" name="accountNumber" value="${escapeAttribute(account.number)}" />
          <input type="hidden" name="amount" value="${escapeAttribute(amount.toFixed(2))}" />
          <input type="hidden" name="memo" value="${escapeAttribute(context.url.searchParams.get("memo") ?? "")}" />
          <button type="submit">Confirm ${operation === "deposit" ? "Deposit" : "Withdrawal"}</button>
          <a class="host-button" href="${withScenario(`/servicing/member/${member.id}`, context)}">Cancel</a>
        </form>
      `,
      noticeOptions(context)
    )
  );
}

function sendAccountTransactionConfirmation(response: ServerResponse, memberId: string, context: RequestContext): void {
  const transaction = resolveTransaction(memberId, context);
  if (!transaction.ok) {
    sendHtml(response, 200, layout("Transaction Confirmation", businessMessagePage(transaction.title, transaction.message), noticeOptions(context)));
    return;
  }

  const { account, amount, member, operation } = transaction;
  const previousBalance = parseMoney(account.balance);
  const newBalance = operation === "deposit" ? previousBalance + amount : previousBalance - amount;
  account.balance = formatMoney(newBalance);
  account.history.unshift(transactionEntry({
    account,
    amount,
    balance: account.balance,
    operation
  }));
  context.persistState();

  const title = operation === "deposit" ? "Deposit Confirmation" : "Withdrawal Confirmation";
  sendHtml(
    response,
    200,
    layout(
      `Heritage Core Servicing - ${title}`,
      `
        <h2>${title}</h2>
        <p>${operation === "deposit" ? "Deposit" : "Withdrawal"} completed for member ${escapeHtml(member.id)}.</p>
        <table class="layout-table">
          <tr><th>Field</th><th>Value</th></tr>
          <tr><td class="label-cell">Account Type</td><td>${escapeHtml(account.type)}</td></tr>
          <tr><td class="label-cell">Previous Balance</td><td>${escapeHtml(formatMoney(previousBalance))}</td></tr>
          <tr><td class="label-cell">Amount</td><td>${escapeHtml(formatMoney(amount))}</td></tr>
          <tr><td class="label-cell">New Balance</td><td>${escapeHtml(account.balance)}</td></tr>
          <tr><td class="label-cell">Reference Number</td><td>HC-${escapeHtml(member.id)}-${operation === "deposit" ? "DEP" : "WDR"}-20260906</td></tr>
        </table>
        <a class="host-button" href="${withScenario(`/servicing/member/${member.id}`, context)}">Return to Member Details</a>
      `,
      noticeOptions(context)
    )
  );
}

function sendOpenSubAccountForm(response: ServerResponse, memberId: string, context: RequestContext): void {
  const member = context.members[memberId];
  if (!member || member.status !== "active") {
    sendHtml(response, 404, layout("Open Sub Account", memberNotFoundPage(memberId), noticeOptions(context)));
    return;
  }

  const accountTypeId = generatedHostId("accountType", context);
  const nicknameId = generatedHostId("nickname", context);

  sendHtml(
    response,
    200,
    layout(
      "Heritage Core Servicing - Open Sub Account",
      `
        <h2>Open Sub Account</h2>
        <p>Member ${escapeHtml(member.id)} - ${escapeHtml(member.name)}</p>
        <form action="/servicing/member/${encodeURIComponent(member.id)}/sub-account-review" method="get">
          ${hiddenScenarioInput(context)}
          <table class="layout-table">
            <tr>
              <td><label for="${accountTypeId}">Account Type</label></td>
              <td>
                <select id="${accountTypeId}" name="accountType">
                  <option value="savings">Savings</option>
                  <option value="money-market">Money Market</option>
                </select>
              </td>
            </tr>
            <tr>
              <td><label for="${nicknameId}">Account Nickname</label></td>
              <td><input id="${nicknameId}" name="nickname" value="New Savings" /></td>
            </tr>
          </table>
          <div class="button-row">
            <button type="submit">Continue</button>
            <a class="host-button" href="${withScenario(`/servicing/member/${member.id}`, context)}">Cancel</a>
          </div>
        </form>
      `,
      noticeOptions(context)
    )
  );
}

function sendReview(response: ServerResponse, memberId: string, context: RequestContext): void {
  const member = context.members[memberId];
  if (!member || member.status !== "active") {
    sendHtml(response, 404, layout("Review", memberNotFoundPage(memberId), noticeOptions(context)));
    return;
  }

  const accountType = context.url.searchParams.get("accountType") ?? "savings";
  const nickname = context.url.searchParams.get("nickname") ?? "New Savings";

  sendHtml(
    response,
    200,
    layout(
      "Heritage Core Servicing - Review",
      `
        <h2>Review</h2>
        <div class="warning">Confirm Opening is irreversible and requires human approval in automation.</div>
        <table class="layout-table">
          <tr><td class="label-cell">Member</td><td>${escapeHtml(member.id)} - ${escapeHtml(member.name)}</td></tr>
          <tr><td class="label-cell">Account Type</td><td>${escapeHtml(accountType)}</td></tr>
          <tr><td class="label-cell">Nickname</td><td>${escapeHtml(nickname)}</td></tr>
        </table>
        <form action="/servicing/member/${encodeURIComponent(member.id)}/sub-account-confirmed" method="get">
          ${hiddenScenarioInput(context)}
          <input type="hidden" name="accountType" value="${escapeAttribute(accountType)}" />
          <input type="hidden" name="nickname" value="${escapeAttribute(nickname)}" />
          <button type="submit">Confirm Opening</button>
          <a class="host-button" href="${withScenario(`/servicing/member/${member.id}`, context)}">Cancel</a>
        </form>
      `,
      noticeOptions(context)
    )
  );
}

function sendConfirmation(response: ServerResponse, memberId: string, context: RequestContext): void {
  const member = context.members[memberId];
  if (!member || member.status !== "active") {
    sendHtml(response, 404, layout("Confirmation", memberNotFoundPage(memberId), noticeOptions(context)));
    return;
  }

  const account = createSubAccount(member, context.url.searchParams.get("accountType") ?? "savings");
  context.persistState();

  sendHtml(
    response,
    200,
    layout(
      "Heritage Core Servicing - Confirmation",
      `
        <h2>Sub Account Opening Confirmation</h2>
        <p>New ${escapeHtml(account.type)} sub-account created for member ${escapeHtml(member.id)}.</p>
        <p>New Account Number: ${escapeHtml(account.number)}</p>
        <p>Opening Balance: ${escapeHtml(account.balance)}</p>
        <p>Reference Number: HC-${escapeHtml(member.id)}-20260904</p>
        <a class="host-button" href="${withScenario(`/servicing/member/${member.id}`, context)}">Return to Member Details</a>
      `,
      noticeOptions(context)
    )
  );
}

function createSubAccount(member: Member, accountType: string): Member["accounts"][number] {
  const normalizedType: Member["accounts"][number]["type"] = accountType === "money-market" ? "Money Market" : "Savings";
  const prefix = normalizedType === "Money Market" ? "M" : "S";
  const nextOrdinal = member.accounts.length + 1;
  const account = {
    type: normalizedType,
    number: `${prefix}-${member.id.slice(0, 4)}${nextOrdinal.toString().padStart(2, "0")}`,
    balance: "$0.00",
    history: [
      {
        datetime: transactionTimestamp(),
        accountNumber: `${prefix}-${member.id.slice(0, 4)}${nextOrdinal.toString().padStart(2, "0")}`,
        accountType: normalizedType,
        type: "Deposit" as const,
        amount: "+$0.00",
        balance: "$0.00"
      }
    ]
  };
  member.accounts.push(account);
  return account;
}

type AccountOperation = "deposit" | "withdraw";

type ResolvedTransaction =
  | {
    ok: true;
    member: Member;
    account: Member["accounts"][number];
    operation: AccountOperation;
    amount: number;
  }
  | {
    ok: false;
    title: string;
    message: string;
  };

function resolveTransaction(memberId: string, context: RequestContext): ResolvedTransaction {
  const member = context.members[memberId];
  if (!member || member.status !== "active") {
    return {
      ok: false,
      title: "Member not found",
      message: `No active member record exists for member number ${memberId || "(blank)"}.`
    };
  }

  const accountNumber = context.url.searchParams.get("accountNumber");
  const account = findAccountByNumber(member, accountNumber);
  if (!account) {
    return {
      ok: false,
      title: "Account not found",
      message: `No account exists for member ${member.id} with the supplied account number.`
    };
  }

  const amount = parseTransactionAmount(context.url.searchParams.get("amount"));
  if (amount === undefined) {
    return {
      ok: false,
      title: "Invalid amount",
      message: "Enter a positive dollar amount with no more than two decimal places."
    };
  }

  const operation = normalizeOperation(context.url.searchParams.get("operation"));
  if (operation === "withdraw" && amount > parseMoney(account.balance)) {
    return {
      ok: false,
      title: "Insufficient funds",
      message: `The ${account.type} account balance is ${account.balance}, which is less than the requested ${formatMoney(amount)} withdrawal.`
    };
  }

  return {
    ok: true,
    member,
    account,
    operation,
    amount
  };
}

function findAccountByNumber(member: Member, accountNumber: string | null): Member["accounts"][number] | undefined {
  return member.accounts.find((account) => account.number === accountNumber);
}

function normalizeOperation(value: string | null): AccountOperation {
  return value === "withdraw" ? "withdraw" : "deposit";
}

function accountQuery(accountNumber: string, context: RequestContext): string {
  const params = new URLSearchParams({
    accountNumber
  });
  if (context.scenario) {
    params.set("scenario", context.scenario);
  }
  return params.toString();
}

function parseTransactionAmount(value: string | null): number | undefined {
  if (!value || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value.trim())) {
    return undefined;
  }
  const amount = Number(value);
  return amount > 0 ? amount : undefined;
}

function parseMoney(value: string): number {
  return Number(value.replace(/[$,]/g, ""));
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function recentTransactions(account: Member["accounts"][number]): AccountTransaction[] {
  return [...account.history]
    .sort((a, b) => b.datetime.localeCompare(a.datetime))
    .slice(0, 10);
}

function transactionEntry(options: {
  account: Member["accounts"][number];
  operation: AccountOperation;
  amount: number;
  balance: string;
}): AccountTransaction {
  const signedAmount = `${options.operation === "deposit" ? "+" : "-"}${formatMoney(options.amount)}`;
  return {
    datetime: transactionTimestamp(),
    accountNumber: options.account.number,
    accountType: options.account.type,
    type: options.operation === "deposit" ? "Deposit" : "Withdraw",
    amount: signedAmount,
    balance: options.balance
  };
}

function transactionTimestamp(date = new Date()): string {
  return date.toISOString().slice(0, 19);
}

function businessMessagePage(title: string, message: string): string {
  return `
    <h2>${escapeHtml(title)}</h2>
    <div class="host-message">${escapeHtml(title)}</div>
    <p>${escapeHtml(message)}</p>
    <a class="host-button" href="/servicing/search">Back to Search</a>
  `;
}

function memberNotFoundPage(memberId: string): string {
  return `
    <h2>Member Search</h2>
    <div class="host-message">Member not found</div>
    <p>No member record exists for member number ${escapeHtml(memberId || "(blank)")}.</p>
    <a class="host-button" href="/servicing/search">Back to Search</a>
  `;
}

function permissionDeniedPage(member: Member): string {
  return `
    <h2>Permission Denied</h2>
    <div class="host-message">Permission denied</div>
    <p>Operator role may not view member ${escapeHtml(member.id)}.</p>
    <a class="host-button" href="/servicing/search">Back to Search</a>
  `;
}

function sessionExpiredPage(): string {
  return `
    <h2>Session Expired</h2>
    <div class="host-message">Your host session has expired.</div>
    <p>Return to the servicing entry point after re-authentication.</p>
    <a class="host-button" href="/servicing/search">Start New Session</a>
  `;
}

function systemErrorPage(message: string): string {
  return `
    <h2>Application Error</h2>
    <div class="host-message">Application error</div>
    <p>${escapeHtml(message)}</p>
    <a class="host-button" href="/servicing/search">Back to Search</a>
  `;
}

function layout(title: string, body: string, options: { hideNotice?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111; background: #d7d7d7; }
    header { background: #06345d; color: white; padding: 8px 14px; border-bottom: 4px solid #8a8a8a; }
    header h1 { font-size: 20px; margin: 0; letter-spacing: 0; }
    .shell { display: table; width: 100%; min-height: calc(100vh - 48px); }
    nav { display: table-cell; width: 190px; background: #eeeeee; border-right: 1px solid #888; padding: 10px; vertical-align: top; }
    main { display: table-cell; padding: 14px; vertical-align: top; background: #f7f7f7; }
    a { color: #06345d; }
    nav a { display: block; margin-bottom: 8px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    h3 { margin-bottom: 8px; font-size: 15px; }
    table { border-collapse: collapse; }
    .layout-table, .nested-table, .accounts-table { width: 100%; background: white; border: 1px solid #777; }
    .layout-table td, .nested-table td, .nested-table th, .accounts-table td, .accounts-table th { border: 1px solid #aaa; padding: 7px; }
    .label-cell, th { background: #e1e7ef; font-weight: bold; }
    .nav-cell { width: 55%; vertical-align: top; }
    input, select { font: inherit; padding: 4px; min-width: 180px; }
    button, .host-button { display: inline-block; font: inherit; color: #111; background: #efefef; border: 1px solid #555; padding: 5px 10px; text-decoration: none; margin-right: 6px; }
    .button-row, .toolbar { margin-top: 12px; }
    iframe { width: 100%; height: 180px; border: 2px inset #999; background: white; }
    .amount { text-align: right; font-family: "Courier New", monospace; }
    .host-message, .warning { background: #fff4c2; border: 1px solid #a68a00; padding: 9px; margin-bottom: 12px; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.18); }
    .modal { position: fixed; top: 95px; left: 50%; transform: translateX(-50%); width: 360px; background: white; border: 3px ridge #777; padding: 14px; box-shadow: 3px 3px 8px rgba(0,0,0,.35); }
    .modal h2 { font-size: 16px; }
  </style>
</head>
<body>
  <header><h1>Heritage Core Servicing</h1></header>
  <div class="shell">
    <nav>
      <strong>Host Menu</strong>
      <a href="/servicing/search">Member Search</a>
      <a href="/servicing/search?scenario=interstitial">System Notice Scenario</a>
      <a href="/servicing/search?scenario=slow">Slow Page Scenario</a>
      <a href="/servicing/search?scenario=session-expired">Session Expired Scenario</a>
      <a href="/servicing/search?scenario=error">App Error Scenario</a>
    </nav>
    <main>${body}</main>
  </div>
  ${options.hideNotice ? "" : systemNotice()}
</body>
</html>`;
}

function frameLayout(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Accounts Frame</title>
  <style>
    body { margin: 6px; font-family: Arial, Helvetica, sans-serif; background: white; }
    table { width: 100%; border-collapse: collapse; }
    td, th { border: 1px solid #999; padding: 6px; }
    th { background: #e1e7ef; }
    .amount { text-align: right; font-family: "Courier New", monospace; }
    button, .host-button { display: inline-block; font: inherit; color: #111; background: #efefef; border: 1px solid #555; padding: 3px 7px; text-decoration: none; margin-right: 4px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function systemNotice(): string {
  return `
    <div class="modal-backdrop"></div>
    <section class="modal" role="dialog" aria-label="System Notice">
      <h2>System Notice</h2>
      <p>Maintenance scheduled tonight</p>
      <a class="host-button" href="?dismissNotice=1">Dismiss</a>
    </section>
  `;
}

function noticeOptions(context: RequestContext): { hideNotice: boolean } {
  return {
    hideNotice: context.scenario !== "interstitial" || context.noticeDismissed
  };
}

function hiddenScenarioInput(context: RequestContext): string {
  if (!context.scenario) {
    return "";
  }
  return `<input type="hidden" name="scenario" value="${escapeAttribute(context.scenario)}" />`;
}

function withScenario(pathname: string, context: RequestContext): string {
  if (!context.scenario) {
    return pathname;
  }
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}scenario=${encodeURIComponent(context.scenario)}`;
}

function generatedHostId(prefix: string, context: RequestContext): string {
  const seed = context.scenario ?? "base";
  let hash = 0;
  for (const char of `${prefix}:${seed}`) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  }
  return `ctl_${hash}_${prefix}`;
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

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createDemoAppServer({ persistState: true }).listen(defaultPort, () => {
    console.log(`Heritage Core Servicing running at http://localhost:${defaultPort}/servicing/search`);
  });
}
