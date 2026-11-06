# Security

Kuza is a static page plus one small helper Worker. It holds no funds, no keys and no user accounts.

## What runs where

| Part | What it can do | What it can't do |
|---|---|---|
| Page (`docs/`) | Ask Nimiq Pay to show an approval sheet. Read public chain data. | Sign anything or move NIM without the user's approval in the wallet's own native sheet. |
| Worker (`worker/`) | Count a hash once. Serve a trimmed pool list, a price and a reward estimate. | Touch money. It receives a hash of an address, not the address. |

The page reads balances from a public third-party RPC node (`rpc.nimiqwatch.com`), and those numbers feed the checks
below. The wallet's native sheet, which shows the real transaction, is the final check.

## Data

- Goals live in the browser storage of the mini app on the user's phone.
- The page sends one SHA-256 of the wallet address to the Worker, once, on mainnet, unless the user turns that off.
  Anyone with a list of addresses could compute the same value, so the Worker keys it again with a secret (HMAC)
  before storing it. The stored table can't be matched against public addresses. Someone watching a quiet public count
  could still test whether one address has already been counted, which the five-minute cache only makes slower.
- No IP address, user agent or timestamp finer than a day is stored. A per-caller cap lives in memory only.
- Invite links carry the goal name, target, date and owner address, which the owner chooses to share.
- Earned is read from the chain: the history of the wallet address and the payment accounts it funded (only valid
  Nimiq addresses named by the node are followed). The history read is capped at 16 requests, 2 pages per account,
  12 accounts and 15 seconds, with each request's timeout cut to what's left of the 15; sums for old payment accounts
  are kept on the phone so they're read once. A read that can't finish shows "not known yet" and is retried after
  30 s, then 1, 2, 4 minutes and so on, up to 10.
- The wallet's own account list is kept with the goals, so a reopened app can read the balance (Nimiq Pay's `getBalance`
  needs no approval). It never leaves the phone.

The wallet count is an indicator, not a verified number. The Origin check can be forged and hashes can be made up.
Caps per caller and per day limit that, but they don't prevent it.

## Untrusted input

Everything from a link, the chain, the Worker or the RPC node is treated as data.

- All text reaches the page through `textContent`. There is no `innerHTML` or `eval`. The only dynamic import is the
  local `mock.js` for `?demo=1`, which never loads inside the wallet.
- Invite links (`?j=`, and the older `?jar=`) are size-capped. Name, id, target, date, network and owner are each
  validated, addresses must pass the checksum, and contract addresses are refused. The button that opens Nimiq Pay is
  built from those checked values, never from the raw page address.
- A goal name passed to the new-goal form through the address (`#/new/...`) is cleaned and capped like any other name.
- A pasted Lightning invoice is trimmed, size-capped and checked for shape, network and amount before it's handed to the
  wallet, which decodes it and asks the user again.
- On-chain notes are decoded, stripped of control, format and bidi characters and capped. Gifts under 1 NIM, gifts
  from the owner and gifts past 500 per goal are ignored, because a goal id is public once its link is shared.
- Anyone can publish a note by paying 1 NIM, so the pages anyone with an invite link sees (in a browser or inside
  Nimiq Pay) show gift amounts only; the goal's owner reads notes in their own goal's history. A note, or a goal name,
  that reads like a way to reach someone is dropped or refused: web addresses in any script (checked on a folded copy:
  NFKC, invisible and combining marks removed, look-alike dots made plain), bare IP addresses, @handles and Nimiq
  addresses. Names also need a letter or digit; invisible characters are removed from all text. Test lists: 27 known
  bypasses refused, 20 real names in the app's languages unchanged (test/security.test.mjs).
- Pool lists and prices are checked in the page as well as in the Worker.
- A Content-Security-Policy limits scripts to this origin and network calls to this origin, the two RPC hosts and the
  Worker. Response headers forbid framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`): Nimiq Pay opens mini
  apps as a page in its own web view, not in a frame. The app has its own host, so that origin and its browser storage are not shared with any other site.
- The Worker checks origin, body size and hash format, and reads upstream responses and request bodies with a size cap.

## Transactions

An invalid transaction can leave the wallet waiting on it, so the page checks each one first:

- It re-reads the stake and the spendable balance from the chain and the wallet, and checks them against the network's
  staking rules. If a read fails or the wallet isn't in consensus, it doesn't send.
- Gifts only go to plain accounts.
- Withdrawal steps re-confirm the wallet's account first. So does every saving after a reopen: the page asks the
  wallet for its accounts once per visit before the first transaction, even though it could read a balance without.
- Lightning payments are made by Nimiq Pay (`payLightningInvoice`). Before the wallet is asked, a SHA-256 of the
  invoice is stored on the phone (the last 50), and an invoice already handed over is refused, across sheets and
  reloads. It is forgotten again only when the user cancelled or the wallet refused the invoice before sending;
  anything else (paid, duplicate, unknown, network error) may have gone out, so it stays refused. The list moves along
  when the wallet switches accounts.
- Moving a reached goal's stake to the next goal is bookkeeping on the phone. No transaction is sent.

These checks reduce the risk; they can't rule it out. An outcome the wallet reports as unknown is never retried by the
page, and it waits for the chain to settle it. Before a gift, the page shows the full recipient address and tells the
sender to pay only if they know who sent the link.

## Reporting a problem

Open an issue at https://github.com/swiftbotlabs/kuza/issues. For anything sensitive, ask for a private channel there
first and leave out the details.
