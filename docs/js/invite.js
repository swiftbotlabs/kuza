// Invite links and how a phone gets from a link into Nimiq Pay. No DOM, no network: strings in, strings out.
//
// Checked 2026-11-06 against Nimiq Pay 2.22.0 (its Android manifest and its deep-link handler) and nimpay.app's own
// "Open in Nimiq Pay" button:
//  - Android: nimiqpay:// is a BROWSABLE scheme of com.nimiq.pay, so an intent: link opens the app when it's installed
//    and the Play Store when it isn't.
//  - iOS: nimiqpay://miniapp?url=... opens the app; there is no fallback, so the page offers the App Store itself.
//  - nimiqpay://miniapp?url=<link> opens <link> as a mini app, query included (proven with a gift link on two phones).

import { encodeInvite } from './jar.js';

export const APP_URL = 'https://kuza.swiftbotlab.workers.dev/';
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.nimiq.pay';
export const APPSTORE_URL = 'https://apps.apple.com/app/nimiq-pay/id6471844738';
export const NIMIQ_PAY_URL = 'https://nimpay.app/';

/** The invite link for a goal: always the public address, never wherever this copy happens to run. */
export function inviteLink(goal, owner, net) {
  return `${APP_URL}?j=${encodeInvite({ id: goal.id, name: goal.name, target: goal.target, date: goal.date, owner, net })}`;
}

/** 'android', 'ios' or null (a computer, or anything else). */
export function platformOf(ua = '', touchPoints = 0) {
  if (/Android/i.test(ua)) return 'android';
  if (/iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1)) return 'ios';
  return null;
}

/** Opens a link as a mini app inside Nimiq Pay. */
export function payDeepLink(url) {
  return `nimiqpay://miniapp?url=${encodeURIComponent(url)}`;
}

/** The same on Android, with the Play Store as the fallback when Nimiq Pay isn't installed. */
export function androidIntent(url) {
  return `intent://miniapp?url=${encodeURIComponent(url)}#Intent;scheme=nimiqpay;package=com.nimiq.pay;S.browser_fallback_url=${encodeURIComponent(PLAY_URL)};end`;
}

export function openInPayLink(url, platform) {
  return platform === 'android' ? androidIntent(url) : payDeepLink(url);
}

export function storeFor(platform) {
  if (platform === 'android') return [PLAY_URL];
  if (platform === 'ios') return [APPSTORE_URL];
  return [PLAY_URL, APPSTORE_URL];
}
