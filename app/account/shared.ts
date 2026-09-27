// Constants shared by the browser UI and the server. Must stay free of Node imports.

export const PUBLIC_SITE_ORIGIN = 'https://h5.tryx402.xyz';
export const REFERRAL_RULE_TEXT = '每成功邀请 1 人注册 +15 次，新用户 +5 次，最多 10 人';
export const PENDING_REFERRAL_STORAGE_KEY = 'sonic-board:pending-ref';

export function referralLink(code: string) {
  return `${PUBLIC_SITE_ORIGIN}/studio?ref=${encodeURIComponent(code)}`;
}

export type AccountSummary = {
  username: string;
  credits: number;
  referralCode: string;
  rewardedReferrals: number;
  maxRewardedReferrals: number;
};
