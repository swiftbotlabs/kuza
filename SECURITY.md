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

The wallet count is an indicator, not a verified number. The Origin check can be forged and hashes can be made up.
Caps per caller and per day limit that, but they don't prevent it.

## Untrusted input

Everything from a link, the chain, the Worker or the RPC node is treated as data.

- All text reaches the page through `textContent`. There is no `innerHTML` or `eval`. The only dynamic import is the
  local `mock.js` for `?demo=1`, which never loads inside the wallet.
- Invite links are size-capped. Name, id, target, date, network and owner are each validated, addresses must pass the
  checksum, and contract addresses are refused.
- On-chain notes are decoded, stripped of control, format and bidi characters and capped. Gifts under 1 NIM, gifts
  from the owner and gifts past 500 per goal are ignored, because a goal id is public once its link is shared.
- Pool lists and prices are checked in the page as well as in the Worker.
- A Content-Security-Policy limits scripts to this origin and network calls to this origin, the two RPC hosts and the
  Worker. `swiftbotlab.github.io` also hosts other sites of ours, so that origin and its browser storage are shared
  with them.
- The Worker checks origin, body size and hash format, and reads upstream responses and request bodies with a size cap.

## Transactions

An invalid transaction can leave the wallet waiting on it, so the page checks each one first:

- It re-reads the stake and the spendable balance from the chain and the wallet, and checks them against the network's
  staking rules. If a read fails or the wallet isn't in consensus, it doesn't send.
- Gifts only go to plain accounts.
- Withdrawal steps re-confirm the wallet's account first.

These checks reduce the risk; they can't rule it out. An outcome the wallet reports as unknown is never retried by the
page, and it waits for the chain to settle it. Before a gift, the page shows the full recipient address and tells the
sender to pay only if they know who sent the link.

## Reporting a problem

Open an issue at https://github.com/swiftbotlab/kuza/issues. For anything sensitive, ask for a private channel there
first and leave out the details.
