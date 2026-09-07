export type Member = {
  id: string;
  name: string;
  status: "active" | "restricted";
  branch: string;
  accounts: Array<{
    type: "Savings" | "Checking" | "Money Market";
    number: string;
    balance: string;
    history: AccountTransaction[];
  }>;
};

export type AccountTransaction = {
  datetime: string;
  accountNumber: string;
  accountType: "Savings" | "Checking" | "Money Market";
  type: "Deposit" | "Withdraw";
  amount: string;
  balance: string;
};

export type DemoUserRole = "READ_ONLY" | "READ_WRITE";

export type DemoUser = {
  username: string;
  displayName: string;
  role: DemoUserRole;
  passwordHash: string;
};

export const users: Record<string, DemoUser> = {
  read: {
    username: "read",
    displayName: "Read Only Operator",
    role: "READ_ONLY",
    passwordHash: "88567ae16a27e6271ffe2ea5e78df7f527ec90ee933de5992a76909ebed266bb"
  },
  readwrite: {
    username: "readwrite",
    displayName: "Read Write Operator",
    role: "READ_WRITE",
    passwordHash: "0e92538ce46794162f280cfcab4b9b3bda1d1d6b05f57332726601101095fe54"
  }
};

export const members: Record<string, Member> = {
  "12345": {
    id: "12345",
    name: "Avery Morgan",
    status: "active",
    branch: "North Loop",
    accounts: [
      {
        type: "Savings",
        number: "S-100234",
        balance: "$3,182.46",
        history: [
          {
            datetime: "2026-09-05T14:18:00",
            accountNumber: "S-100234",
            accountType: "Savings",
            type: "Deposit",
            amount: "+$125.00",
            balance: "$3,182.46"
          },
          {
            datetime: "2026-09-04T09:11:00",
            accountNumber: "S-100234",
            accountType: "Savings",
            type: "Withdraw",
            amount: "-$40.00",
            balance: "$3,057.46"
          }
        ]
      },
      {
        type: "Checking",
        number: "C-442910",
        balance: "$842.10",
        history: [
          {
            datetime: "2026-09-05T16:42:00",
            accountNumber: "C-442910",
            accountType: "Checking",
            type: "Withdraw",
            amount: "-$63.25",
            balance: "$842.10"
          },
          {
            datetime: "2026-09-03T08:30:00",
            accountNumber: "C-442910",
            accountType: "Checking",
            type: "Deposit",
            amount: "+$950.00",
            balance: "$905.35"
          }
        ]
      }
    ]
  },
  "54321": {
    id: "54321",
    name: "Jordan Ellis",
    status: "active",
    branch: "Lakeview",
    accounts: [
      {
        type: "Savings",
        number: "S-889120",
        balance: "$8,044.19",
        history: [
          {
            datetime: "2026-09-05T13:05:00",
            accountNumber: "S-889120",
            accountType: "Savings",
            type: "Deposit",
            amount: "+$500.00",
            balance: "$8,044.19"
          }
        ]
      },
      {
        type: "Checking",
        number: "C-119004",
        balance: "$12,000.00",
        history: [
          {
            datetime: "2026-09-05T10:15:00",
            accountNumber: "C-119004",
            accountType: "Checking",
            type: "Deposit",
            amount: "+$2,000.00",
            balance: "$12,000.00"
          }
        ]
      }
    ]
  },
  "88888": {
    id: "88888",
    name: "Restricted Member",
    status: "restricted",
    branch: "Operations",
    accounts: []
  }
};

export function findMember(memberId: string): Member | undefined {
  return members[memberId];
}

export function createMemberStore(): Record<string, Member> {
  return structuredClone(members);
}
