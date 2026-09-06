export type Member = {
  id: string;
  name: string;
  status: "active" | "restricted";
  branch: string;
  accounts: Array<{
    type: "Savings" | "Checking" | "Money Market";
    number: string;
    balance: string;
  }>;
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
        balance: "$3,182.46"
      },
      {
        type: "Checking",
        number: "C-442910",
        balance: "$842.10"
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
        balance: "$8,044.19"
      },
      {
        type: "Checking",
        number: "C-119004",
        balance: "$12,000.00"
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
