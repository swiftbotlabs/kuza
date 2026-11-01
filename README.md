# Kuza

Savings goals in your own NIM stake, as a Mini App for [Nimiq Pay](https://nimiq.com). *Kuza* means "grow" in Swahili.

You set a goal. Your NIM goes into your own stake with a validator, so it earns while it waits. Kuza never holds it:
every move is a transaction you approve in Nimiq Pay.

**Live:** https://kuza.swiftbotlab.workers.dev/ (open it in Nimiq Pay under Mini Apps. A normal browser shows a landing
page with a demo that uses pretend NIM.)

<p>
  <img src="docs/img/shots/home.png" width="240" alt="Home with your stake and a goal">
  <img src="docs/img/shots/save.png" width="240" alt="Adding to a goal">
  <img src="docs/img/shots/cooling.png" width="240" alt="The cooling-off steps">
</p>

*Screenshots from the real Nimiq Pay app on testnet.*

## What it does

- **Goals:** a name, a target, a date and a weekly plan.
- **Saving:** a staking transaction that you approve. Under the network's 100 NIM minimum for a new stake, the goal
  fills in your wallet instead and tells you how far you are from being able to stake.
- **Progress:** your stake and what it earned are read from the chain. Streaks, set-aside notes and how stake is split
  between goals are kept on your phone. There's a weekly reminder in the app.
- **Breaking a goal:** shows the real unstaking path and the real wait, with live block numbers.
- **Group jar:** an invite link lets a friend pay your own address directly, with a note in the transaction.
  Kuza reads the note on-chain and counts it toward the goal.
- **English, Spanish, French and Swahili**, following the language set in Nimiq Pay.

## What it doesn't do

Staked NIM isn't held back by any rule that stops its owner. You can start taking it out at any time, and the
network's cooling-off takes about 12 to 24 hours. Kuza's goals work through that pause and your own plan, not through
force. The Nimiq provider can't create vesting contracts, so an enforced time lock isn't possible from a Mini App.

Reward figures are estimates and they change. They're labelled that way in the app.

## Tested so far

In the real Nimiq Pay app on testnet: connecting and cancelling, creating a goal, setting NIM aside, a new stake, a
top-up under 100 NIM, sending a gift with a note, starting a cooling-off, and goals surviving a close and reopen.
Finishing a withdrawal (retire and remove) on a real wallet is still to come, because it needs the cooling-off to run
out. On mainnet, the wait below matches the on-chain history of a real staker.

## How the unstaking wait is worked out

| Step | Transaction | Rule |
|---|---|---|
| Stop earning | `sendSetActiveStakeTransaction` | Inactive from the next election block (one every 43,200 blocks) |
| Cooling-off | none | Released one epoch after that, so 12 to 24 hours at about one block a second |
| Retire | `sendRetireStakeTransaction` | Only released stake. What stays must be 0 or at least 100 NIM |
| Remove | `sendRemoveStakeTransaction` | Must take the whole retired balance |

If the pool's validator is jailed, the stake can't leave until the jail ends, which can add several days. The maths is
in [`docs/js/staking.js`](docs/js/staking.js), with its sources listed at the top and tests against real chain data.

## Layout

```
docs/          the site, served by GitHub Pages as is. No build step.
  js/app.js    screens and flows
  js/staking.js, goals.js, jar.js, nim.js   pure logic, unit tested
  js/chain.js  read-only JSON-RPC
  js/wallet.js the Nimiq Pay provider
  js/mock.js   pretend wallet and chain for ?demo=1
  js/vendor/   @nimiq/mini-app-sdk 0.2.4 from npm, unmodified apart from the source map comment
worker/        optional helper on Cloudflare Workers: wallet count, trimmed pool list, price
test/          unit tests and a phone-sized run through the demo
```

## Run it

```
python3 -m http.server -d docs 8000     # open http://localhost:8000/?demo=1
npm test                                # logic and translations
node test/ui/drive.mjs /tmp/kuza-ui     # needs google-chrome; drives the demo and keeps screenshots
```

No dependencies to install. The vendored SDK matches npm's `sha512-gDumiC+5OiN5rIaWXS2moNmDKTav8evrAvs2qLMfcSyTVgIKtX7Prmcgj7k9PXrMyGk0JMmIKaG1lbPkSg8/Ew==`.

## Privacy

Goals stay on your phone. To show a public count of wallets, Kuza sends a hash of your address once, and you can switch
that off in settings. The helper keys it again with a secret before storing it. See [SECURITY.md](SECURITY.md).

## Licence

MIT
