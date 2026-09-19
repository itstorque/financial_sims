// Account types and fill/withdraw logic.
import { ReturnsSchedule } from './returnsSchedule.js';

// checking/hysa/taxable/retirement grow (or shrink) like normal investments.
// 'debt' accounts hold a negative balance that *appreciates* (grows more
// negative) at its own interest rate unless paid down by an expense block.
export const ACCOUNT_TYPES = ['checking', 'hysa', 'taxable', 'retirement', 'debt'];

export const ACCOUNT_TYPE_LABELS = {
  checking: 'Checking',
  hysa: 'HYSA / Savings',
  taxable: 'Taxable Brokerage',
  retirement: 'Retirement (401k/IRA)',
  debt: 'Debt (loan/credit card)',
};

let _idCounter = 0;
export function nextAccountId() {
  return 'acc_' + (++_idCounter) + '_' + Date.now().toString(36);
}

export class Account {
  constructor({ id, name, type = 'checking', balance = 0, sigma = 0, useCustomReturns = false, returnsSchedule = null }) {
    this.id = id || nextAccountId();
    this.name = name;
    this.type = type;
    this.balance = balance;
    // Optional extra noise (fraction, e.g. 0.02) applied to balance moves,
    // independent of the returns-schedule sigma (e.g. models estimation error).
    this.sigma = sigma;
    this.useCustomReturns = useCustomReturns;
    this.returnsSchedule = returnsSchedule instanceof ReturnsSchedule ? returnsSchedule : new ReturnsSchedule([]);
  }
}

/** Returns true if contributions to this account type are tax-deferred (traditional retirement). */
export function isTaxDeferred(account) {
  return account.type === 'retirement';
}

export function defaultAccounts() {
  const accounts = {};
  const checking = new Account({ id: 'checking', name: 'Checking', type: 'checking', balance: 8000 });
  const hysa = new Account({ id: 'hysa', name: 'HYSA', type: 'hysa', balance: 20000 });
  const taxable = new Account({ id: 'taxable', name: 'Taxable Brokerage', type: 'taxable', balance: 30000 });
  const retirement = new Account({ id: 'retirement', name: '401k / IRA', type: 'retirement', balance: 90000 });
  for (const a of [checking, hysa, taxable, retirement]) accounts[a.id] = a;
  return accounts;
}

