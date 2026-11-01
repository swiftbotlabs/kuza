# Security

Kuza is a static page plus one small helper Worker. It holds no funds, no keys and no user accounts.

## What runs where

| Part | What it can do | What it can't do |
|---|---|---|
| Page (`docs/`) | Ask Nimiq Pay to show an approval sheet. Read public chain data. | Sign anything or move NIM without the user's approval in the wallet's own native sheet. |
| Worker (`worker/`) | Count a hash once. Serve a trimmed pool list, a price and a reward estimate. | Touch money. It never sees an address. |

## Data

- Goals live in the browser storage of the mini app on the user's phone.
- The page sends one SHA-256 of the wallet address to the Worker, once, on mainnet, unless the user turns that off.
- The Worker keys that hash again with a secret (HMAC) before storing it, so public addresses can't be hashed and
  matched against the table. No IP address, user agent or timestamp finer than a day is stored. A per-caller cap
  lives in memory only.
- Invite links carry the goal name, target, date and owner address, which the owner chooses to share.

## Untrusted input

Everything from a link, the chain, the Worker or the RPC node is treated as data.

- All text reaches the page through `textContent`. There is no `innerHTML`, `eval` or dynamic script loading,
  apart from the local `mock.js` for `?demo=1`.
- Invite links are size-capped and every field is validated. Addresses must pass the checksum.
- On-chain notes are decoded, stripped of control and bidi characters and capped.
- A Content-Security-Policy limits scripts to this origin and network calls to the two RPC hosts and the Worker.
- The Worker checks origin, body size and hash format, and caps upstream responses and new wallets per caller.

## Transactions

Before each transaction the page re-reads the chain and checks it against the network's staking rules. An invalid
transaction can leave the wallet waiting on it, so nothing that the chain would refuse is ever sent. Unknown outcomes
are never retried; the page waits for the chain to settle them.

## Reporting a problem

Open an issue at https://github.com/swiftbotlab/kuza/issues. For anything sensitive, ask for a private channel there
first and leave out the details.
