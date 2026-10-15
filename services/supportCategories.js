// services/supportCategories.js
// ─────────────────────────────────────────────────────────────────
// CANONICAL support category registry.
//
// This is the ONLY place support categories are defined.
// Every surface — widget, backend routes, admin UI, DB seed,
// notification templates, reporting — must consume this module.
//
// Do NOT hardcode category arrays anywhere else.
// ─────────────────────────────────────────────────────────────────

'use strict';

const CATEGORIES = Object.freeze([
    { key: 'wallet',            label: 'Wallet',              service: 'wallet',      icon: 'wallet'      },
    { key: 'funding',           label: 'Funding',             service: 'deposit',     icon: 'deposit'     },
    { key: 'airtime',           label: 'Airtime',             service: 'airtime',     icon: 'airtime'     },
    { key: 'data',              label: 'Data',                service: 'data',        icon: 'data'        },
    { key: 'bills',             label: 'Bills & Utilities',   service: 'bills',       icon: 'bills'       },
    { key: 'gift_cards',        label: 'Gift Cards',          service: 'gift_cards',  icon: 'giftcard'    },
    { key: 'esim',              label: 'eSIM',                service: 'esim',        icon: 'esim'        },
    { key: 'virtual_sms',       label: 'Virtual Numbers',     service: 'virtual_sms', icon: 'virtual'     },
    { key: 'social_boosting',   label: 'Social Boosting',     service: 'boost',       icon: 'boost'       },
    { key: 'marketplace',       label: 'Marketplace',         service: 'marketplace', icon: 'marketplace' },
    { key: 'account_security',  label: 'Account & Security',  service: 'account',     icon: 'account'     },
    { key: 'other',             label: 'Other',               service: null,          icon: 'other'       }
]);

const KEY_SET = new Set(CATEGORIES.map(c => c.key));
const LABEL_MAP = new Map(CATEGORIES.map(c => [c.key, c.label]));
const BY_KEY = new Map(CATEGORIES.map(c => [c.key, c]));

const SERVICE_KEYS = new Set([
    'airtime', 'data', 'bills', 'esim', 'gift_cards', 'virtual_sms',
    'social_boosting', 'marketplace', 'wallet', 'deposit', 'account'
]);

function normalizeKey(key) {
    return String(key || '').trim().toLowerCase();
}

function isValidCategory(key) {
    return KEY_SET.has(normalizeKey(key));
}

function labelFor(key) {
    return LABEL_MAP.get(normalizeKey(key)) || 'Other';
}

function getCategory(key) {
    return BY_KEY.get(normalizeKey(key)) || null;
}

function getCategories() {
    // Return a defensive copy so callers can't mutate the registry.
    return CATEGORIES.map(c => ({ ...c }));
}

function keys() {
    return Array.from(KEY_SET);
}

module.exports = {
    CATEGORIES,
    SERVICE_KEYS,
    isValidCategory,
    labelFor,
    getCategory,
    getCategories,
    keys,
    normalizeKey
};