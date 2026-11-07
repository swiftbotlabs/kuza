// Group jar: a link that describes a goal, and the memo that ties a gift to it.
// Nothing here touches a server. The link carries the goal, the chain carries the gifts.

import { LUNA, normalizeAddress, utf8Bytes, cutBytes, hexToText } from './nim.js';
import { STAKING_CONTRACT } from './staking.js';

export const MEMO_PREFIX = 'KZ1';
export const MEMO_MAX = 64;
const ID_RE = /^[a-z2-9]{6}$/;
const NOBODY = new Set([STAKING_CONTRACT, 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', 'NQ81 C01N BASE 0000 0000 0000 0000 0000 0000']);

export function cleanText(input, maxChars) {
  if (typeof input !== 'string') return '';
  // Control, format and bidi characters and blank look-alikes have no place in a name or a public note.
  // Invisible characters go entirely (a joiner hidden before a dot must not survive as a gap); breaks become spaces.
  const noCtl = input.replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u2800\u3164\uFFA0]/gu, ' ');
  return [...noCtl.replace(/\s+/g, ' ').trim()].slice(0, maxChars).join('');
}

const DOTS = /[。．｡﹒․܁܂]/g;
const LINKISH = /(:\/\/|www\.|[\p{L}\p{N}\p{Extended_Pictographic}_-]\.\p{L}{2,}|\d{1,3}(\.\d{1,3}){3}|@[\p{L}\p{N}_]{3,}|\bNQ\s?\d{2}(\s?[0-9A-Z]{4}){2})/iu;

/**
 * Does the text read like a way to reach someone: a web address (any script, look-alike dots, invisible marks before
 * the dot, a bare IP), an @handle or a Nimiq address? A goal name and a gift note are shown to strangers (the invite
 * page, a shared message), so neither may carry one someone else planted. The comparison runs on a folded copy
 * (NFKC, no invisible or combining marks, look-alike dots made plain); the text itself is never changed by it.
 */
export function linkish(text) {
  if (typeof text !== 'string') return false;
  const s = text.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, '').replace(DOTS, '.')
    .replace(SHORT, (all, pre, a, b) => (nameNotAddress(a, b) ? `${pre}${a} ${b}` : all))
    .replace(AT_WORD, '$1at $2');
  return LINKISH.test(s);
}

// Initials and short titles written without a space are names, not addresses: B.Sc, M.Sc, B.Com, J.Smith, St.Mary,
// Dr.Visit. Only this shape is let through: one capital letter (or St, Dr, Mr, Ms, Mt, Jr, Sr) standing alone before the
// dot, one capitalised word after it, and nothing next that could continue an address (a path, ?, #, a backslash,
// another dot, an @, a colon). And only when that word is NOT a real top-level domain (the full IANA list below, IDN
// ones too), or the whole token is one of the degrees that happen to collide with one (B.Sc, B.Com ...). A token mixing
// scripts is never let through, and the word is also checked with Cyrillic and Greek look-alikes read as Latin, so
// "Dr.Ѕbs" (Cyrillic Ѕ) can't stand in for dr.sbs. It all runs on the folded copy (NFKC, no invisible marks, plain dots).
const SHORT = /(^|[^\p{L}\p{N}_.@-])(\p{Lu}|St|Dr|Mr|Ms|Mt|Jr|Sr)\.(\p{Lu}\p{Ll}{1,15})(?![\p{L}\p{N}\p{M}_/\\?#.@:-])/gu;
// Only degrees whose ending is a real domain ending and which are not registrable as written (b.sc, m.sc, b.com are
// one-letter names). M.Com, B.Tech, M.Tech are refused like any other real ending; B.Ed passes anyway (.ed is no ending).
const DEGREES = new Set(['B.Sc', 'M.Sc', 'B.Com']);
// IANA root zone, version 2026110700, lower case, IDN TLDs as Unicode. Source: https://data.iana.org/TLD/tlds-alpha-by-domain.txt
// The last six were missing from that copy (goo helsinki hotel juniper wolterskluwer) or are special-use (onion).
export const TLDS = new Set('aaa aarp abb abbott abbvie abc able abogado abudhabi ac academy accenture accountant accountants aco actor ad ads adult ae aeg aero aetna af afl africa ag agakhan agency ai aig airbus airforce airtel akdn al alibaba alipay allfinanz allstate ally alsace alstom am amazon americanexpress americanfamily amex amfam amica amsterdam analytics android anquan anz ao aol apartments app apple aq aquarelle ar arab aramco archi army arpa art arte as asda asia associates at athleta attorney au auction audi audible audio auspost author auto autos aw aws ax axa az azure ba baby baidu banamex band bank bar barcelona barclaycard barclays barefoot bargains baseball basketball bauhaus bayern bb bbc bbt bbva bcg bcn bd be beats beauty beer berlin best bestbuy bet bf bg bh bharti bi bible bid bike bing bingo bio biz bj black blackfriday blockbuster blog bloomberg blue bm bms bmw bn bnpparibas bo boats boehringer bofa bom bond boo book booking bosch bostik boston bot boutique box br bradesco bridgestone broadway broker brother brussels bs bt build builders business buy buzz bv bw by bz bzh ca cab cafe cal call calvinklein cam camera camp canon capetown capital capitalone car caravan cards care career careers cars casa case cash casino cat catering catholic cba cbn cbre cc cd center ceo cern cf cfa cfd cg ch chanel channel charity chase chat cheap chintai christmas chrome church ci cipriani circle cisco citadel citi citic city ck cl claims cleaning click clinic clinique clothing cloud club clubmed cm cn co coach codes coffee college cologne com commbank community company compare computer comsec condos construction consulting contact contractors cooking cool coop corsica country coupon coupons courses cpa cr credit creditcard creditunion cricket crown crs cruise cruises cu cuisinella cv cw cx cy cymru cyou cz dad dance data date dating datsun day dclk dds de deal dealer deals degree delivery dell deloitte delta democrat dental dentist desi design dev dhl diamonds diet digital direct directory discount discover dish diy dj dk dm dnp do docs doctor dog domains dot download drive dtv dubai dupont durban dvag dvr dz earth eat ec eco edeka edu education ee eg email emerck energy engineer engineering enterprises epson equipment er ericsson erni es esq estate et eu eurovision eus events exchange expert exposed express extraspace fage fail fairwinds faith family fan fans farm farmers fashion fast fedex feedback ferrari ferrero fi fidelity fido film final finance financial fire firestone firmdale fish fishing fit fitness fj fk flickr flights flir florist flowers fly fm fo foo food football ford forex forsale forum foundation fox fr free fresenius frl frogans frontier ftr fujitsu fun fund furniture futbol fyi ga gal gallery gallo gallup game games gap garden gay gb gbiz gd gdn ge gea gent genting george gf gg ggee gh gi gift gifts gives giving gl glass gle global globo gm gmail gmbh gmo gmx gn godaddy gold goldpoint golf goodyear goog google gop got gov gp gq gr grainger graphics gratis green gripe grocery group gs gt gu gucci guge guide guitars guru gw gy hair hamburg hangout haus hbo hdfc hdfcbank health healthcare help here hermes hiphop hisamitsu hitachi hiv hk hkt hm hn hockey holdings holiday homedepot homegoods homes homesense honda horse hospital host hosting hot hotels hotmail house how hr hsbc ht hu hughes hyatt hyundai ibm icbc ice icu id ie ieee ifm ikano il im imamat imdb immo immobilien in inc industries infiniti info ing ink institute insurance insure int international intuit investments io ipiranga iq ir irish is ismaili ist istanbul it itau itv jaguar java jcb je jeep jetzt jewelry jio jll jm jmp jnj jo jobs joburg jot joy jp jpmorgan jprs juegos kaufen kddi ke kerryhotels kerryproperties kfh kg kh ki kia kids kim kindle kitchen kiwi km kn koeln komatsu kosher kp kpmg kpn kr krd kred kuokgroup kw ky kyoto kz la lacaixa lamborghini lamer land landrover lanxess lasalle lat latino latrobe law lawyer lb lc lds lease leclerc lefrak legal lego lexus lgbt li lidl life lifeinsurance lifestyle lighting like lilly limited limo lincoln link live living lk llc llp loan loans locker locus lol london lotte lotto love lpl lplfinancial lr ls lt ltd ltda lu lundbeck luxe luxury lv ly ma madrid maif maison makeup man management mango map market marketing markets marriott marshalls mattel mba mc mckinsey md me med media meet melbourne meme memorial men menu merck merckmsd mg mh miami microsoft mil mini mint mit mitsubishi mk ml mlb mls mm mma mn mo mobi mobile moda moe moi mom monash money monster mormon mortgage moscow moto motorcycles mov movie mp mq mr ms msd mt mtn mtr mu museum music mv mw mx my mz na nab nagoya name navy nba nc ne nec net netbank netflix network neustar new news next nextdirect nexus nf nfl ng ngo nhk ni nico nike nikon ninja nissan nissay nl no nokia norton now nowruz nowtv np nr nra nrw ntt nu nyc nz obi observer office okinawa olayan olayangroup ollo om omega one ong onl online ooo open oracle orange org organic origins osaka otsuka ott ovh pa page panasonic paris pars partners parts party pay pccw pe pet pf pfizer pg ph pharmacy phd philips phone photo photography photos physio pics pictet pictures pid pin ping pink pioneer pizza pk pl place play playstation plumbing plus pm pn pnc pohl poker politie porn post pr praxi press prime pro prod productions prof progressive promo properties property protection pru prudential ps pt pub pw pwc py qa qpon quebec quest racing radio re read realestate realtor realty recipes red redumbrella rehab reise reisen reit reliance ren rent rentals repair report republican rest restaurant review reviews rexroth rich richardli ricoh ril rio rip ro rocks rodeo rogers room rs rsvp ru rugby ruhr run rw rwe ryukyu sa saarland safe safety sakura sale salon samsclub samsung sandvik sandvikcoromant sanofi sap sarl sas save saxo sb sbi sbs sc scb schaeffler schmidt scholarships school schule schwarz science scot sd se search seat secure security seek select sener services seven sew sex sexy sfr sg sh shangrila sharp shell shia shiksha shoes shop shopping shouji show si silk sina singles site sj sk ski skin sky skype sl sling sm smart smile sn sncf so soccer social softbank software sohu solar solutions song sony soy spa space sport spot sr srl ss st stada staples star statebank statefarm stc stcgroup stockholm storage store stream studio study style su sucks supplies supply support surf surgery suzuki sv swatch swiss sx sy sydney systems sz tab taipei talk taobao target tatamotors tatar tattoo tax taxi tc tci td tdk team tech technology tel temasek tennis teva tf tg th thd theater theatre tiaa tickets tienda tips tires tirol tj tjmaxx tjx tk tkmaxx tl tm tmall tn to today tokyo tools top toray toshiba total tours town toyota toys tr trade trading training travel travelers travelersinsurance trust trv tt tube tui tunes tushu tv tvs tw tz ua ubank ubs ug uk unicom university uno uol ups us uy uz va vacations vana vanguard vc ve vegas ventures verisign versicherung vet vg vi viajes video vig viking villas vin vip virgin visa vision viva vivo vlaanderen vn vodka volvo vote voting voto voyage vu wales walmart walter wang wanggou watch watches weather weatherchannel web webcam weber website wed wedding weibo weir wf whoswho wien wiki williamhill win windows wine winners wme woodside work works world wow ws wtc wtf xbox xerox xihuan xin कॉम セール 佛山 ಭಾರತ 慈善 集团 在线 한국 ଭାରତ 点看 คอม ভাৰত ভারত 八卦 ישראל موقع বাংলা 公益 公司 香格里拉 网站 移动 我爱你 москва қаз католик онлайн сайт 联通 срб бг бел קום 时尚 微博 淡马锡 ファッション орг नेट ストア アマゾン 삼성 சிங்கப்பூர் 商标 商店 商城 дети мкд ею ポイント 新闻 家電 كوم 中文网 中信 中国 中國 娱乐 谷歌 భారత్ ලංකා 電訊盈科 购物 クラウド ભારત 通販 भारतम् भारत भारोत 网店 संगठन 餐厅 网络 ком укр 香港 亚马逊 食品 飞利浦 台湾 台灣 手机 мон الجزائر عمان ارامكو ایران العليان امارات بازار موريتانيا پاکستان الاردن بارت بھارت المغرب ابوظبي البحرين السعودية ڀارت كاثوليك سودان همراه عراق مليسيا 澳門 닷컴 政府 شبكة بيتك عرب გე 机构 组织机构 健康 ไทย سورية 招聘 рус рф تونس 大拿 ລາວ みんな グーグル ευ ελ 世界 書籍 ഭാരതം ਭਾਰਤ 网址 닷넷 コム 天主教 游戏 vermögensberater vermögensberatung 企业 信息 嘉里大酒店 嘉里 مصر قطر 广东 இலங்கை இந்தியா հայ 新加坡 فلسطين 政务 xxx xyz yachts yahoo yamaxun yandex ye yodobashi yoga yokohama you youtube yt yun za zappos zara zero zip zm zone zuerich zw goo helsinki hotel juniper onion wolterskluwer'.split(' '));
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', ѕ: 's', і: 'i', ј: 'j', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', һ: 'h', к: 'k', м: 'm',
  н: 'h', т: 't', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', г: 'r', ь: 'b', з: '3', α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v',
  ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ζ: 'z', μ: 'u', ω: 'w' };
const scripts = (text) => new Set([...text].filter((c) => /\p{L}/u.test(c))
  .map((c) => (/\p{Script=Latin}/u.test(c) ? 'L' : /\p{Script=Cyrillic}/u.test(c) ? 'C' : /\p{Script=Greek}/u.test(c) ? 'G' : 'O')));
function nameNotAddress(a, b) {
  if (DEGREES.has(`${a}.${b}`)) return true;
  if (scripts(a + b).size > 1) return false;
  const low = b.toLowerCase();
  // Also as a domain name would be matched: ß as ss, final ς as σ, accents dropped ("Preß" is press, "Café" is cafe).
  const folded = low.normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  const latin = (w) => [...w].map((c) => LOOKALIKE[c] || c).join('');
  return ![low, latin(low), folded, latin(folded)].some((w) => TLDS.has(w));
}
// "Fix roof @home", "Lunch @work": only these two words, lower case, with a space or the end after them.
const AT_WORD = /(^|[^\p{L}\p{N}_@])@(home|work)(?=\s|$)/gu;

/** A goal name as it may be shown: cleaned, with at least one letter or digit, and nothing that reads like a link. */
export function cleanName(input) {
  const name = cleanText(input, 40);
  return name && /[\p{L}\p{N}]/u.test(name) && !linkish(name) ? name : '';
}

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeJar({ id, name, target, date, owner, net }) {
  return b64urlEncode(JSON.stringify({ v: 1, i: id, n: name, t: target, d: date, a: owner.replace(/\s/g, ''), e: net === 'testnet' ? 't' : 'm' }));
}

/** Parse the ?jar= value. Everything in it is untrusted; returns null unless all of it checks out. */
export function decodeJar(param) {
  if (typeof param !== 'string' || !param || param.length > 512 || !/^[A-Za-z0-9_-]+$/.test(param)) return null;
  let o;
  try {
    o = JSON.parse(b64urlDecode(param));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  const owner = normalizeAddress(o.a);
  const name = cleanName(o.n);
  if (!owner || NOBODY.has(owner) || !name || typeof o.i !== 'string' || !ID_RE.test(o.i)) return null;
  if (!Number.isSafeInteger(o.t) || o.t <= 0 || o.t > 21e14) return null;
  if (o.d !== null && o.d !== undefined && (typeof o.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.d) || Number.isNaN(Date.parse(`${o.d}T12:00:00Z`)))) return null;
  if (o.e !== 'm' && o.e !== 't') return null;
  return { id: o.i, name, target: o.t, date: o.d || null, owner, net: o.e === 't' ? 'testnet' : 'mainnet' };
}

/**
 * The short form of the same link, used for every new invite: ?j=<net><address>.<id>.<target>.<date>.<name>
 *   net m or t, the address without spaces (its checksum still checks), the goal id, the target in Luna as base 36,
 *   the date as YYYYMMDD or empty, the name as base64url UTF-8. About 120 characters in all instead of 200.
 */
export function encodeInvite({ id, name, target, date, owner, net }) {
  const day = date ? date.replace(/-/g, '') : '';
  return `${net === 'testnet' ? 't' : 'm'}${owner.replace(/\s/g, '')}.${id}.${target.toString(36)}.${day}.${b64urlEncode(cleanText(name, 40))}`;
}

const INVITE_RE = /^([mt])(NQ[0-9]{2}[0-9A-Z]{32})\.([a-z2-9]{6})\.([0-9a-z]{1,11})\.(\d{8})?\.([A-Za-z0-9_-]{1,216})$/;

/** Parse the ?j= value. Untrusted like the long form: null unless every part checks out. */
export function decodeInvite(param) {
  if (typeof param !== 'string' || !param || param.length > 300) return null;
  const m = INVITE_RE.exec(param);
  if (!m) return null;
  const owner = normalizeAddress(m[2]);
  if (!owner || NOBODY.has(owner)) return null;
  const target = parseInt(m[4], 36);
  if (!Number.isSafeInteger(target) || target <= 0 || target > 21e14) return null;
  let date = null;
  if (m[5]) {
    date = `${m[5].slice(0, 4)}-${m[5].slice(4, 6)}-${m[5].slice(6)}`;
    const back = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== date) return null;
  }
  let name;
  try {
    name = cleanName(b64urlDecode(m[6]));
  } catch {
    return null;
  }
  if (!name) return null;
  return { id: m[3], name, target, date, owner, net: m[1] === 't' ? 'testnet' : 'mainnet' };
}

/** The goal a page address points at: the short ?j= form first, then the older ?jar= form. */
export function readInvite(params) {
  const short = params.get('j');
  if (short !== null) return { jar: decodeInvite(short), given: true };
  const long = params.get('jar');
  if (long !== null) return { jar: decodeJar(long), given: true };
  return { jar: null, given: false };
}

/** Public text for the transaction: KZ1|goalid|note, at most 64 bytes. */
export function buildMemo(id, note) {
  const head = `${MEMO_PREFIX}|${id}|`;
  return head + cutBytes(cleanText(note, 60).replace(/\|/g, '/'), MEMO_MAX - utf8Bytes(head));
}

/**
 * Would this gift note be hidden from the owner? parseMemo drops link-like notes, so the friend's form asks for an edit
 * before anything goes on chain, rather than publishing a note nobody will see. Checks the note exactly as it is sent.
 */
export function noteRefused(note) {
  const head = `${MEMO_PREFIX}|aaaaaa|`;
  return linkish(cleanText(buildMemo('aaaaaa', note).slice(head.length), 60));
}

export function parseMemo(hex) {
  const text = hexToText(hex);
  const m = /^KZ1\|([a-z2-9]{6})\|?(.*)$/s.exec(text);
  if (!m) return null;
  const note = cleanText(m[2], 60);
  return { id: m[1], note: linkish(note) ? '' : note }; // anyone can pay 1 NIM with a note: no links shown
}

/**
 * Gifts in a list of transactions, as returned by getTransactionsByAddress.
 * Only executed transfers TO the owner, from someone else, of at least 1 NIM, with a valid memo count, each once.
 * The goal id is public in the invite link, so dust must not be able to fill up a goal's history.
 */
export function giftsFromHistory(txs, owner, goalId) {
  const seen = new Set();
  const out = [];
  for (const tx of txs || []) {
    if (!tx || tx.executionResult === false || tx.to !== owner || tx.from === owner || seen.has(tx.hash)) continue;
    const memo = parseMemo(tx.recipientData || '');
    if (!memo || (goalId && memo.id !== goalId)) continue;
    if (!Number.isSafeInteger(tx.value) || tx.value < LUNA) continue;
    seen.add(tx.hash);
    out.push({ hash: tx.hash, goal: memo.id, note: memo.note, luna: tx.value, from: tx.from, at: Math.abs(tx.timestamp) <= 8.64e15 ? tx.timestamp : 0, block: tx.blockNumber });
  }
  return out.sort((a, b) => b.at - a.at);
}
