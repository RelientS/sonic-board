#!/usr/bin/env node
// Account admin CLI working directly on the JSON store (SONIC_DATA_DIR,
// default ./.data). Safe to run while the server is up: writes take the same
// file lock as the server.
//
//   node scripts/account-admin.mjs list
//   node scripts/account-admin.mjs show <username>
//   node scripts/account-admin.mjs grant <username> <amount> [note]
import { findUserByUsername, grantCredits, ledgerBalance } from '../app/account/accounts.ts';
import { JsonAccountStore } from '../app/account/store.ts';

const [command, ...args] = process.argv.slice(2);
const store = new JsonAccountStore();

function usage(code = 1) {
  console.error('Usage: node scripts/account-admin.mjs <list | show <username> | grant <username> <amount> [note]>');
  process.exit(code);
}

function formatTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

if (command === 'list') {
  const rows = await store.read((state) => Object.values(state.users)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((user) => ({
      username: user.username,
      credits: user.balance,
      referrals: user.rewardedReferrals,
      referralCode: user.referralCode,
      referredBy: user.referredBy ? state.users[user.referredBy]?.username ?? '?' : '',
      createdAt: formatTime(user.createdAt),
    })));
  console.log(`store: ${store.file}`);
  if (rows.length) console.table(rows);
  else console.log('(no users)');
} else if (command === 'show') {
  if (!args[0]) usage();
  const result = await store.read((state) => {
    const user = findUserByUsername(state, args[0]);
    if (!user) return undefined;
    return {
      user,
      audit: ledgerBalance(state, user.id),
      entries: state.ledger.filter((entry) => entry.userId === user.id),
    };
  });
  if (!result) {
    console.error(`No such user: ${args[0]}`);
    process.exit(2);
  }
  console.log(`${result.user.username}  credits=${result.user.balance}  ledgerSum=${result.audit}  referralCode=${result.user.referralCode}  rewardedReferrals=${result.user.rewardedReferrals}`);
  console.table(result.entries.map((entry) => ({ at: formatTime(entry.at), type: entry.type, amount: entry.amount, ref: entry.ref ?? '', note: entry.note ?? '' })));
} else if (command === 'grant') {
  const [username, rawAmount, ...noteParts] = args;
  const amount = Number(rawAmount);
  if (!username || !Number.isSafeInteger(amount) || amount === 0) usage();
  const balance = await store.transact((state, now) => {
    const user = findUserByUsername(state, username);
    if (!user) return undefined;
    grantCredits(state, user.id, amount, now, noteParts.join(' ') || 'cli');
    return user.balance;
  });
  if (balance === undefined) {
    console.error(`No such user: ${username}`);
    process.exit(2);
  }
  console.log(`Granted ${amount} to ${username}; balance is now ${balance}.`);
} else {
  usage(command ? 1 : 0);
}
