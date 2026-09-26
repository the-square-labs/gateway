/**
 * Maya's own account: MFA factors, browser sessions and AI usage. Seeds 64700–64799.
 */
import type { BrowserSession, User } from "@/types";
import type { InferenceSelfUsage, InferenceUsageOverview } from "@/types/inference";
import { adminUser } from "../identity";
import { ago, agoMs, ahead, uuid } from "../time";

/**
 * The profile screen shows Maya with a local (password) account: Gateway MFA
 * (passkeys, authenticator app) only applies to local sign-in, so the Account
 * security panel is hidden for OIDC users.
 */
export const localAccountUser: User = { ...adminUser, oidcSubject: null, authMethod: "password" };

export const mfaStatus = {
  totpConfigured: true,
  passkeyCount: 1,
  recoveryCodeCount: 8,
  required: true,
};

export const passkeys = [
  {
    id: uuid(64701),
    name: "MacBook Pro Touch ID",
    lastUsedAt: ago(3, "h"),
    createdAt: ago(146, "d"),
  },
];

export const browserSessions: BrowserSession[] = [
  {
    id: uuid(64710),
    authMethod: "password",
    createdAt: agoMs(3, "h"),
    lastSeenAt: agoMs(1, "m"),
    expiresAt: Date.parse(ahead(7, "d")),
    ipAddress: "198.51.100.24",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    mfaSatisfiedAt: agoMs(3, "h"),
    isCurrent: true,
  },
  {
    id: uuid(64711),
    authMethod: "password",
    createdAt: agoMs(2, "d"),
    lastSeenAt: agoMs(5, "h"),
    expiresAt: Date.parse(ahead(5, "d")),
    ipAddress: "203.0.113.57",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    mfaSatisfiedAt: agoMs(2, "d"),
    isCurrent: false,
  },
  {
    id: uuid(64712),
    authMethod: "password",
    createdAt: agoMs(6, "d"),
    lastSeenAt: agoMs(1, "d"),
    expiresAt: Date.parse(ahead(1, "d")),
    ipAddress: "198.51.100.140",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    mfaSatisfiedAt: agoMs(6, "d"),
    isCurrent: false,
  },
];

export const inferenceSelfUsage: InferenceSelfUsage = {
  measuredAt: ago(30, "s"),
  enabled: true,
  api: { configured: false, percentage: 0, recoveryAt: ahead(1, "d") },
  subscription: {
    "5h": { configured: true, percentage: 18, recoveryAt: ahead(3, "h") },
    "7d": { configured: true, percentage: 42, recoveryAt: ahead(4, "d") },
    "30d": { configured: true, percentage: 27, recoveryAt: ahead(19, "d") },
  },
};

// Weekday-shaped activity over the last 30 days.
const dailyUsage = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(agoMs(29 - index, "d"));
  const weekday = date.getUTCDay();
  const base = weekday === 0 || weekday === 6 ? 4 : 22;
  const requests = base + ((index * 7) % 13);
  return {
    date: date.toISOString().slice(0, 10),
    requests,
    credits: Math.round(requests * 0.31 * 100) / 100,
    apiMicrodollars: requests * 1_180,
    tokens: requests * 5_200,
  };
});

const totals = dailyUsage.reduce(
  (sum, row) => ({
    requests: sum.requests + row.requests,
    credits: sum.credits + row.credits,
    apiMicrodollars: sum.apiMicrodollars + row.apiMicrodollars,
    tokens: sum.tokens + row.tokens,
  }),
  { requests: 0, credits: 0, apiMicrodollars: 0, tokens: 0 }
);

export const inferenceUsageOverview: InferenceUsageOverview = {
  windowDays: 30,
  requestTotals: [
    {
      status: "completed",
      requests: totals.requests - 6,
      credits: totals.credits.toFixed(2),
      apiMicrodollars: totals.apiMicrodollars,
      tokens: totals.tokens,
    },
    { status: "failed", requests: 6, credits: "0", apiMicrodollars: 0, tokens: 0 },
  ],
  ledgerTotals: [
    {
      budgetType: "subscription",
      credits: totals.credits.toFixed(2),
      apiMicrodollars: totals.apiMicrodollars,
      tokens: totals.tokens,
    },
  ],
  dailyUsage,
};
