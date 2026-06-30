const express = require('express');
const axios = require('axios');
const { supabase } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// VirtualSMS API Configuration
const VS_API_KEY = process.env.VIRTUALSMS_API_KEY;
const VS_BASE_URL = 'https://virtualsms.io/api/v1';

// ============================================
// COUNTRY-SPECIFIC SERVICES DATABASE
// ============================================

// USA - Full services (from your JSON)
const usaServices = [
    { code: 'kt', name: 'KakaoTalk', icon: '💬' },
    { code: 'nv', name: 'Naver', icon: '🔍' },
    { code: 'oi', name: 'Tinder', icon: '🔥' },
    { code: 'ig', name: 'Instagram+Threads', icon: '📸' },
    { code: 'tg', name: 'Telegram', icon: '✈️' },
    { code: 'dh', name: 'eBay', icon: '🛍️' },
    { code: 'vi', name: 'Viber', icon: '📞' },
    { code: 'fb', name: 'Facebook', icon: '📘' },
    { code: 'go', name: 'Google/Youtube/Gmail', icon: '🔴' },
    { code: 'me', name: 'Line Messenger', icon: '💚' },
    { code: 'mt', name: 'Steam', icon: '🎮' },
    { code: 'ts', name: 'PayPal', icon: '💳' },
    { code: 'wa', name: 'WhatsApp', icon: '💬' },
    { code: 'bz', name: 'Blizzard', icon: '🎮' },
    { code: 'nf', name: 'Netflix', icon: '📺' },
    { code: 'tw', name: 'Twitter/X', icon: '🐦' },
    { code: 'nz', name: 'Foodpanda', icon: '🍔' },
    { code: 'vk', name: 'VK.com', icon: '💙' },
    { code: 'ub', name: 'Uber', icon: '🚗' },
    { code: 'mm', name: 'Microsoft', icon: '🪟' },
    { code: 'uk', name: 'Airbnb', icon: '🏠' },
    { code: 'mb', name: 'Yahoo', icon: '💜' },
    { code: 'am', name: 'Amazon', icon: '📦' },
    { code: 'ab', name: 'Alibaba', icon: '🌐' },
    { code: 'wc', name: 'Craigslist', icon: '📰' },
    { code: 'ew', name: 'Nike', icon: '👟' },
    { code: 'lf', name: 'TikTok/Douyin', icon: '🎵' },
    { code: 'ka', name: 'Shopee', icon: '🛒' },
    { code: 'za', name: 'JD.com', icon: '🛍️' },
    { code: 'qq', name: 'Tencent QQ', icon: '🐧' },
    { code: 'im', name: 'Imo', icon: '💬' },
    { code: 'yl', name: 'Yalla', icon: '🎤' },
    { code: 'pm', name: 'AOL', icon: '📧' },
    { code: 'zk', name: 'Deliveroo', icon: '🍕' },
    { code: 'ls', name: 'Careem', icon: '🚘' },
    { code: 'zr', name: 'Papara', icon: '💳' },
    { code: 'hw', name: 'Alipay/Alibaba', icon: '💰' },
    { code: 'ds', name: 'Discord', icon: '🎮' },
    { code: 'an', name: 'Adidas', icon: '👟' },
    { code: 'xk', name: 'DiDi', icon: '🚕' },
    { code: 'wb', name: 'WeChat', icon: '💚' },
    { code: 'mc', name: 'Michat', icon: '💬' },
    { code: 'bff', name: 'Kawan Food', icon: '🍜' },
    { code: 'ip', name: 'Burger King', icon: '🍔' },
    { code: 'si', name: 'Cita Previa', icon: '📅' },
    { code: 'fr', name: 'Dana', icon: '💰' },
    { code: 'hk', name: '4Fun', icon: '🎮' },
    { code: 'yw', name: 'Grindr', icon: '💖' },
    { code: 'ni', name: 'Gojek', icon: '🏍️' },
    { code: 'xs', name: 'GroupMe', icon: '💬' },
    { code: 'ae', name: 'myGLO', icon: '💡' },
    { code: 'un', name: 'Humble Bundle', icon: '🎮' },
    { code: 'xf', name: 'LightChat', icon: '💬' },
    { code: 'fz', name: 'KFC', icon: '🍗' },
    { code: 'zo', name: 'Kaggle', icon: '📊' },
    { code: 'ry', name: 'McDonalds', icon: '🍟' },
    { code: 'vm', name: 'OkCupid', icon: '❤️' },
    { code: 'sn', name: 'OLX', icon: '🛒' },
    { code: 'fx', name: 'PGbonus', icon: '🎮' },
    { code: 'jq', name: 'Paysafecard', icon: '💳' },
    { code: 'pf', name: 'Plenty of Fish', icon: '🐟' },
    { code: 'dp', name: 'ProtonMail', icon: '🔒' },
    { code: 'nc', name: 'Payoneer', icon: '💳' },
    { code: 'qi', name: '32red', icon: '🎰' },
    { code: 'ij', name: 'Revolut', icon: '💳' },
    { code: 'alj', name: 'Spotify', icon: '🎵' },
    { code: 'bw', name: 'Signal', icon: '🔒' },
    { code: 'vj', name: 'Stormgain', icon: '📈' },
    { code: 'hb', name: 'Twitch', icon: '🎮' },
    { code: 'xd', name: 'Tokopedia', icon: '🛒' },
    { code: 'gc', name: 'TradingView', icon: '📈' },
    { code: 'qy', name: 'Zhihu', icon: '❓' },
    { code: 'kf', name: 'Weibo', icon: '🐦' },
    { code: 'wx', name: 'Apple', icon: '🍎' },
    { code: 'kc', name: 'Vinted', icon: '👕' },
    { code: 'tn', name: 'LinkedIn', icon: '🔗' },
    { code: 'bl', name: 'BIGO LIVE', icon: '📹' },
    { code: 'rc', name: 'Skype', icon: '💬' },
    { code: 'fu', name: 'Snapchat', icon: '👻' },
    { code: 'fi', name: 'Dundle', icon: '🎮' },
    { code: 'vz', name: 'Hinge', icon: '💕' },
    { code: 'wh', name: 'TanTan', icon: '💖' },
    { code: 'dr', name: 'OpenAI', icon: '🤖' },
    { code: 'ul', name: 'Getir', icon: '🛒' },
    { code: 'py', name: 'Monese', icon: '💳' },
    { code: 'lt', name: 'BitClout', icon: '💰' },
    { code: 'tx', name: 'Bolt', icon: '🚗' },
    { code: 'gt', name: 'Gett', icon: '🚕' },
    { code: 'ss', name: 'Hezzl', icon: '💬' },
    { code: 'dl', name: 'Lazada', icon: '🛒' },
    { code: 'xh', name: 'OVO', icon: '💰' },
    { code: 'vv', name: 'Seosprint', icon: '📈' },
    { code: 'tl', name: 'Truecaller', icon: '📞' },
    { code: 'mj', name: 'Zalo', icon: '💬' },
    { code: 'oz', name: 'Poshmark', icon: '👗' },
    { code: 'zz', name: 'DENT', icon: '📞' },
    { code: 'wg', name: 'Skout', icon: '💬' },
    { code: 'qd', name: 'Taobao', icon: '🛒' },
    { code: 'os', name: 'Dhani', icon: '💰' },
    { code: 'hn', name: 'Bonia', icon: '👛' },
    { code: 'ju', name: 'Indomaret', icon: '🛒' },
    { code: 'gf', name: 'Google Voice', icon: '📞' },
    { code: 'do', name: 'Leboncoin', icon: '🛒' },
    { code: 'yy', name: 'Venmo', icon: '💳' },
    { code: 'cn', name: 'Fiverr', icon: '💼' },
    { code: 'ii', name: 'CashKaro', icon: '💰' },
    { code: 'ir', name: 'Chispa', icon: '🔥' },
    { code: 'it', name: 'Cash App', icon: '💰' },
    { code: 'ix', name: 'Celcoin', icon: '💳' },
    { code: 'jd', name: 'GiraBank', icon: '🏦' },
    { code: 'jw', name: 'Br777', icon: '🎰' },
    { code: 'jy', name: 'Sorare', icon: '⚽' },
    { code: 'kk', name: 'Idealista', icon: '🏠' },
    { code: 'kq', name: 'FotoCasa', icon: '🏠' },
    { code: 'qf', name: 'RedBook', icon: '📖' },
    { code: 'et', name: 'Clubhouse', icon: '🎙️' },
    { code: 'mo', name: 'Bumble', icon: '🐝' },
    { code: 'pz', name: 'Lidl', icon: '🛒' },
    { code: 'yi', name: 'Yemeksepeti', icon: '🍕' },
    { code: 'ib', name: 'Immowelt', icon: '🏠' },
    { code: 'ex', name: 'Linode', icon: '☁️' },
    { code: 'rr', name: 'Wolt', icon: '🍕' },
    { code: 'bf', name: 'Keybase', icon: '🔑' },
    { code: 'xr', name: 'Tango', icon: '💬' },
    { code: 'xv', name: 'Wish', icon: '🛒' },
    { code: 'xx', name: 'Joyride', icon: '🎮' },
    { code: 'zh', name: 'Zoho', icon: '💼' },
    { code: 'lq', name: 'Potato', icon: '🥔' },
    { code: 'dn', name: 'Paxful', icon: '💰' },
    { code: 'iq', name: 'ICQ', icon: '💬' },
    { code: 'jg', name: 'Grab', icon: '🚗' },
    { code: 'en', name: 'Hermes', icon: '📦' },
    { code: 'ez', name: 'Goerli Faucet', icon: '💰' },
    { code: 'oh', name: 'MapleSEA', icon: '🎮' },
    { code: 'yo', name: 'Amasia', icon: '🌐' },
    { code: 'ys', name: 'ZCity', icon: '🏙️' },
    { code: 'zs', name: 'Bilibili', icon: '📺' },
    { code: 'vp', name: 'Kwai', icon: '📱' },
    { code: 'rl', name: 'inDriver', icon: '🚗' },
    { code: 'fj', name: 'Potato Chat', icon: '🥔' },
    { code: 'zx', name: 'Community Gaming', icon: '🎮' },
    { code: 'pu', name: 'Just Dating', icon: '💕' },
    { code: 'aj', name: 'OneAset', icon: '💰' },
    { code: 'gj', name: 'Carousell', icon: '🛒' },
    { code: 'zy', name: 'Nttgame', icon: '🎮' },
    { code: 'zw', name: 'Quack', icon: '🦆' },
    { code: 'zv', name: 'Digikala', icon: '🛒' },
    { code: 'zu', name: 'BigC', icon: '🛒' },
    { code: 'zt', name: 'Budweiser', icon: '🍺' },
    { code: 'zq', name: 'IndiaPlays', icon: '🎮' },
    { code: 'zn', name: 'Biedronka', icon: '🛒' },
    { code: 'zm', name: 'OfferUp', icon: '🛒' },
    { code: 'zj', name: 'Robinhood', icon: '📈' },
    { code: 'zg', name: 'Setel', icon: '🚗' },
    { code: 'zf', name: 'OnTaxi', icon: '🚕' },
    { code: 'zd', name: 'Zilch', icon: '💳' },
    { code: 'yx', name: 'JT Express', icon: '📦' },
    { code: 'yv', name: 'IPLwin', icon: '🏏' },
    { code: 'yp', name: 'Payzapp', icon: '💳' },
    { code: 'yn', name: 'Allegro', icon: '🛒' },
    { code: 'yj', name: 'eWallet', icon: '💰' },
    { code: 'xz', name: 'Paycell', icon: '💳' },
    { code: 'xy', name: 'Depop', icon: '👕' },
    { code: 'xw', name: 'Taki', icon: '💬' },
    { code: 'xu', name: 'RecargaPay', icon: '💰' },
    { code: 'xq', name: 'MPL', icon: '🎮' },
    { code: 'xn', name: 'Familia', icon: '🛒' },
    { code: 'xl', name: 'Wmaraci', icon: '💼' },
    { code: 'xi', name: 'InFund', icon: '💰' },
    { code: 'xe', name: 'GalaxyChat', icon: '💬' },
    { code: 'xb', name: 'RummyOla', icon: '🎮' },
    { code: 'wz', name: 'FoxFord', icon: '🚗' },
    { code: 'ww', name: 'BIP', icon: '💰' },
    { code: 'wv', name: 'AIS', icon: '📱' },
    { code: 'wt', name: 'IZI', icon: '💰' },
    { code: 'wq', name: 'Leboncoin', icon: '🛒' },
    { code: 'wp', name: '163.com', icon: '📧' },
    { code: 'wo', name: 'Parkplus', icon: '🚗' },
    { code: 'wn', name: 'GameArena', icon: '🎮' },
    { code: 'wl', name: 'YouGotaGift', icon: '🎁' },
    { code: 'wk', name: 'Mobile01', icon: '📱' },
    { code: 'vy', name: 'Meta', icon: '🔷' },
    { code: 'vx', name: 'HeyBox', icon: '📦' },
    { code: 'vw', name: 'CoinField', icon: '💰' },
    { code: 'vq', name: 'LadyMaria', icon: '💕' },
    { code: 'vo', name: 'Brand20ua', icon: '🛒' },
    { code: 'vn', name: 'Yaay', icon: '🎉' },
    { code: 'vf', name: 'Q12 Trivia', icon: '❓' },
    { code: 'vc', name: 'Banqi', icon: '🎮' },
    { code: 'va', name: 'SportGully', icon: '🏏' },
    { code: 'uz', name: 'OffGamers', icon: '🎮' },
    { code: 'uy', name: 'Meliuz', icon: '💰' },
    { code: 'uw', name: 'Kirana', icon: '🛒' },
    { code: 'uv', name: 'BinBin', icon: '📦' },
    { code: 'us', name: 'IRCTC', icon: '🚂' },
    { code: 'ur', name: 'MyDailyCash', icon: '💰' },
    { code: 'uq', name: 'TopDetal', icon: '🛒' },
    { code: 'uo', name: 'CafeBazaar', icon: '☕' },
    { code: 'uj', name: 'Champion Casino', icon: '🎰' },
    { code: 'ui', name: 'RuTube', icon: '📺' },
    { code: 'uh', name: 'Yubo', icon: '💬' },
    { code: 'ug', name: 'Fiqsy', icon: '💰' },
    { code: 'uf', name: 'Eneba', icon: '🎮' },
    { code: 'ue', name: 'Onet', icon: '📰' },
    { code: 'ud', name: 'JioHotstar', icon: '📺' },
    { code: 'tv', name: 'Flink', icon: '🛒' },
    { code: 'tu', name: 'Lyft', icon: '🚗' },
    { code: 'tt', name: 'Ziglu', icon: '💰' },
    { code: 'tr', name: 'Paysend', icon: '💳' },
    { code: 'tq', name: 'Swvl', icon: '🚌' },
    { code: 'tp', name: 'IndiaGold', icon: '💰' },
    { code: 'tm', name: 'Akulaku', icon: '🛒' },
    { code: 'tj', name: 'DbrUA', icon: '💬' },
    { code: 'ti', name: 'Crypto.com', icon: '💰' },
    { code: 'tf', name: 'Noon', icon: '🛒' },
    { code: 'te', name: 'eFood', icon: '🍕' },
    { code: 'td', name: 'Chainge Finance', icon: '💰' },
    { code: 'sy', name: 'Brahma', icon: '🔷' },
    { code: 'sx', name: 'Crowdtap', icon: '📊' },
    { code: 'sw', name: 'NCsoft', icon: '🎮' },
    { code: 'su', name: 'LOCO', icon: '🎮' },
    { code: 'sr', name: 'Starbucks', icon: '☕' },
    { code: 'sp', name: 'HappyFresh', icon: '🛒' },
    { code: 'so', name: 'RummyWealth', icon: '🎮' },
    { code: 'sm', name: 'YoWin', icon: '🎮' },
    { code: 'sk', name: 'Skroutz', icon: '🛒' },
    { code: 'sj', name: 'HandyPick', icon: '🛒' },
    { code: 'sf', name: 'SneakersnStuff', icon: '👟' },
    { code: 'se', name: 'Feeld', icon: '💕' },
    { code: 'sc', name: 'Voggt', icon: '🔬' },
    { code: 'sa', name: 'AGIBANK', icon: '🏦' },
    { code: 'rx', name: 'Sheerid', icon: '✅' },
    { code: 'rw', name: 'BLS-SPAIN', icon: '📋' },
    { code: 'rv', name: 'Kotak811', icon: '🏦' },
    { code: 'ru', name: 'HOP', icon: '🍺' },
    { code: 'rt', name: 'Hily', icon: '💕' },
    { code: 'rs', name: 'Lotus', icon: '🌸' },
    { code: 'rp', name: 'Hamrahaval', icon: '💰' },
    { code: 'ro', name: 'PingCode', icon: '💻' },
    { code: 'rn', name: 'Neftm', icon: '💰' },
    { code: 'rk', name: 'Fotka', icon: '📸' },
    { code: 'ri', name: 'BillMill', icon: '📄' },
    { code: 'rh', name: 'Ace2Three', icon: '🎮' },
    { code: 'rf', name: 'Akudo', icon: '💰' },
    { code: 'rb', name: 'Tick', icon: '✅' },
    { code: 'ra', name: 'KeyPay', icon: '💳' },
    { code: 'qx', name: 'WorldRemit', icon: '💳' },
    { code: 'qt', name: 'MoneyControl', icon: '📈' },
    { code: 'qn', name: 'Blued', icon: '💙' },
    { code: 'ql', name: 'CMTcuzdan', icon: '💰' },
    { code: 'qk', name: 'Bit', icon: '💰' },
    { code: 'qg', name: 'MoneyPay', icon: '💳' },
    { code: 'qe', name: 'GG', icon: '🎮' },
    { code: 'qb', name: 'Payberry', icon: '💰' },
    { code: 'px', name: 'Nifty', icon: '🎨' },
    { code: 'pw', name: 'SellMonitor', icon: '📊' },
    { code: 'pt', name: 'Bitaqaty', icon: '💰' },
    { code: 'pq', name: 'CDkeys', icon: '🎮' },
    { code: 'ph', name: 'SnappFood', icon: '🍕' },
    { code: 'pc', name: 'Casino/Betting', icon: '🎰' },
    { code: 'pb', name: 'SkyTV', icon: '📺' },
    { code: 'pa', name: 'Gamekit', icon: '🎮' },
    { code: 'oy', name: 'CashFly', icon: '💰' },
    { code: 'ox', name: 'Damejidlo', icon: '🍕' },
    { code: 'ou', name: 'Gabi', icon: '💬' },
    { code: 'oq', name: 'Vlife', icon: '🎮' },
    { code: 'oo', name: 'LigaPro', icon: '⚽' },
    { code: 'om', name: 'Corona', icon: '🍺' },
    { code: 'oe', name: 'Codashop', icon: '🎮' },
    { code: 'od', name: 'FWDMAX', icon: '📺' },
    { code: 'oc', name: 'DealShare', icon: '🛒' },
    { code: 'ob', name: 'Onlinerby', icon: '🛒' },
    { code: 'ny', name: 'BitcoinBon', icon: '💰' },
    { code: 'nu', name: 'Stripe', icon: '💳' },
    { code: 'ns', name: 'Oldubil', icon: '💰' },
    { code: 'np', name: 'Siply', icon: '💰' },
    { code: 'no', name: 'Virgo', icon: '♍' },
    { code: 'nn', name: 'Giftcloud', icon: '🎁' },
    { code: 'nm', name: 'Thisshop', icon: '🛒' },
    { code: 'nk', name: 'Gittigidiyor', icon: '🛒' },
    { code: 'nh', name: 'AlloBank', icon: '🏦' },
    { code: 'ng', name: 'FunPay', icon: '💰' },
    { code: 'ne', name: 'Coindcx', icon: '💰' },
    { code: 'mx', name: 'SoulApp', icon: '💬' },
    { code: 'mw', name: 'Transfergo', icon: '💳' },
    { code: 'mv', name: 'Fruitz', icon: '🍎' },
    { code: 'mu', name: 'MyMusicTaste', icon: '🎵' },
    { code: 'ms', name: 'NovaPoshta', icon: '📦' },
    { code: 'mr', name: 'Fastmail', icon: '📧' },
    { code: 'mq', name: 'GMNG', icon: '💰' },
    { code: 'mp', name: 'Winmasters', icon: '🎰' },
    { code: 'mn', name: 'RRSA', icon: '💰' },
    { code: 'ml', name: 'ApostaGanha', icon: '🎰' },
    { code: 'mk', name: 'LongHu', icon: '🐉' },
    { code: 'mf', name: 'Weidian', icon: '🛒' },
    { code: 'lz', name: 'Things', icon: '📱' },
    { code: 'lw', name: 'MrGreen', icon: '🎰' },
    { code: 'lu', name: 'Crickpe', icon: '🏏' },
    { code: 'lr', name: 'Okta', icon: '🔐' },
    { code: 'lp', name: 'Algida', icon: '🍦' },
    { code: 'lo', name: 'OPPO', icon: '📱' },
    { code: 'ln', name: 'Grofers', icon: '🛒' },
    { code: 'lk', name: 'PurePlatform', icon: '💼' },
    { code: 'lj', name: 'Santander', icon: '🏦' },
    { code: 'lg', name: 'MediBuddy', icon: '🏥' },
    { code: 'le', name: 'E-bike Gewinnspiel', icon: '🚲' },
    { code: 'ld', name: 'Cashmine', icon: '💰' },
    { code: 'la', name: 'Ssoidnet', icon: '🔐' },
    { code: 'ky', name: 'Spaten Oktoberfest', icon: '🍺' },
    { code: 'kx', name: 'Vivo', icon: '📱' },
    { code: 'kw', name: 'Foody', icon: '🍔' },
    { code: 'kv', name: 'Rush', icon: '🏃' },
    { code: 'ku', name: 'RoyalWin', icon: '🎰' },
    { code: 'ks', name: 'Hirect', icon: '💼' },
    { code: 'kr', name: 'Eyecon', icon: '👁️' },
    { code: 'ko', name: 'AdaKami', icon: '💰' },
    { code: 'kn', name: 'Verse', icon: '🎵' },
    { code: 'km', name: 'Rozetka', icon: '🛒' },
    { code: 'kl', name: 'Kolesa.kz', icon: '🚗' },
    { code: 'kh', name: 'Bukalapak', icon: '🛒' },
    { code: 'kg', name: 'FreeChargeApp', icon: '💰' },
    { code: 'kb', name: 'Kufar.by', icon: '🛒' },
    { code: 'jz', name: 'Kaya', icon: '🧴' },
    { code: 'jx', name: 'Swiggy', icon: '🍕' },
    { code: 'jt', name: 'Turkiye Petrolleri', icon: '🛢️' },
    { code: 'jm', name: 'Mzadqatar', icon: '🛒' },
    { code: 'jj', name: 'Aitu', icon: '💬' },
    { code: 'ji', name: 'Monobank', icon: '🏦' },
    { code: 'jh', name: 'PingPong', icon: '🏓' },
    { code: 'je', name: 'Nanovest', icon: '💰' },
    { code: 'jb', name: 'Wing Money', icon: '💰' },
    { code: 'ja', name: 'Weverse', icon: '🎵' },
    { code: 'iz', name: 'Global24', icon: '🌐' },
    { code: 'iy', name: 'FoodHub', icon: '🍔' },
    { code: 'iu', name: 'Bykea', icon: '🏍️' },
    { code: 'ih', name: 'Teen Patti Star Pro', icon: '🎮' },
    { code: 'ic', name: 'JoGo', icon: '💰' },
    { code: 'ia', name: 'Socios', icon: '⚽' },
    { code: 'hx', name: 'AliExpress', icon: '🛒' },
    { code: 'hu', name: 'Ukrnet', icon: '🌐' },
    { code: 'ht', name: 'Bitso', icon: '💰' },
    { code: 'hs', name: 'Asda', icon: '🛒' },
    { code: 'hr', name: 'JKF', icon: '💬' },
    { code: 'hq', name: 'Magicbricks', icon: '🏠' },
    { code: 'hp', name: 'Meesho', icon: '🛒' },
    { code: 'ho', name: 'Cathay', icon: '✈️' },
    { code: 'hm', name: 'Globus', icon: '🛒' },
    { code: 'hl', name: 'Band', icon: '🎵' },
    { code: 'hi', name: 'Junglee Rummy', icon: '🎮' },
    { code: 'hh', name: 'Uplay', icon: '🎮' },
    { code: 'hf', name: 'Cleartrip', icon: '✈️' },
    { code: 'he', name: 'Mewt', icon: '🐱' },
    { code: 'hd', name: 'MarketPapa', icon: '🛒' },
    { code: 'hc', name: 'MOMO', icon: '🛒' },
    { code: 'gy', name: 'MIYACHAT', icon: '💬' },
    { code: 'gv', name: 'Humta', icon: '💰' },
    { code: 'gu', name: 'Fora', icon: '🌐' },
    { code: 'gs', name: 'Samsung Shop', icon: '📱' },
    { code: 'gq', name: 'Freelancer', icon: '💼' },
    { code: 'gn', name: 'A9A', icon: '🎮' },
    { code: 'gl', name: 'GlobalTel', icon: '📞' },
    { code: 'gi', name: 'Hotline', icon: '📞' },
    { code: 'gh', name: 'GyFTR', icon: '🎁' },
    { code: 'gg', name: 'PagSmile', icon: '💰' },
    { code: 'ge', name: 'Paytm', icon: '💰' },
    { code: 'gd', name: 'Surveytime', icon: '📊' },
    { code: 'ga', name: 'Roposo', icon: '📱' },
    { code: 'fy', name: 'Mylove', icon: '💕' },
    { code: 'fw', name: '99acres', icon: '🏠' },
    { code: 'fv', name: 'Vidio', icon: '📺' },
    { code: 'fs', name: 'Sikayet var', icon: '⚠️' },
    { code: 'fp', name: 'Phound', icon: '🔍' },
    { code: 'fo', name: 'MobiKwik', icon: '💰' },
    { code: 'fm', name: 'Touchance', icon: '📈' },
    { code: 'fl', name: 'Rummy Loot', icon: '🎮' },
    { code: 'fk', name: 'BLIBLI', icon: '📺' },
    { code: 'fh', name: 'Lalamove', icon: '🚚' },
    { code: 'fg', name: 'IndianOil', icon: '🛢️' },
    { code: 'fe', name: 'CliQQ', icon: '💰' },
    { code: 'fc', name: 'PharmEasy', icon: '💊' },
    { code: 'fa', name: 'Xadrez Feliz', icon: '♟️' },
    { code: 'ey', name: 'Miloan', icon: '💰' },
    { code: 'ev', name: 'Picpay', icon: '💰' },
    { code: 'eu', name: 'LiveScore', icon: '⚽' },
    { code: 'er', name: 'Kwork', icon: '💼' },
    { code: 'ep', name: 'Temu', icon: '🛒' },
    { code: 'eo', name: 'Sizeer', icon: '👟' },
    { code: 'em', name: 'Ze Delivery', icon: '🚚' },
    { code: 'el', name: 'Bisu', icon: '🍪' },
    { code: 'ej', name: 'MrQ', icon: '🎰' },
    { code: 'ei', name: 'Taksheel', icon: '💰' },
    { code: 'eg', name: 'ContactSys', icon: '📞' },
    { code: 'ef', name: 'Nextdoor', icon: '🏠' },
    { code: 'ed', name: 'Gamer', icon: '🎮' },
    { code: 'ec', name: 'RummyCulture', icon: '🎮' },
    { code: 'eb', name: 'Voltz', icon: '⚡' },
    { code: 'ea', name: 'James Delivery', icon: '🚚' },
    { code: 'dx', name: 'Powerkredite', icon: '💰' },
    { code: 'dw', name: 'Divar', icon: '🛒' },
    { code: 'dv', name: 'NoBroker', icon: '🏠' },
    { code: 'du', name: 'AUBANK', icon: '🏦' },
    { code: 'dm', name: 'Iwplay', icon: '🎮' },
    { code: 'dk', name: 'Pairs', icon: '💕' },
    { code: 'di', name: 'Loanflix', icon: '💰' },
    { code: 'dd', name: 'CloudChat', icon: '💬' },
    { code: 'dc', name: 'YikYak', icon: '💬' },
    { code: 'db', name: 'Ezbuy', icon: '🛒' },
    { code: 'cz', name: 'Getmega', icon: '🎮' },
    { code: 'cx', name: 'Icrypex', icon: '💰' },
    { code: 'cw', name: 'Paddy Power', icon: '🎰' },
    { code: 'cv', name: 'WashXpress', icon: '🧼' },
    { code: 'cu', name: '炙热星河', icon: '🔥' },
    { code: 'cs', name: 'AgriDevelop', icon: '🌾' },
    { code: 'cq', name: 'Mercado', icon: '🛒' },
    { code: 'cp', name: 'Uklon', icon: '🚗' },
    { code: 'co', name: 'Rediffmail', icon: '📧' },
    { code: 'cm', name: 'Prom', icon: '🎓' },
    { code: 'cl', name: 'UWIN', icon: '🎮' },
    { code: 'ck', name: 'BeReal', icon: '📱' },
    { code: 'cj', name: 'Dotz', icon: '🔴' },
    { code: 'ci', name: 'RedBus', icon: '🚌' },
    { code: 'ch', name: 'Pocket52', icon: '🎮' },
    { code: 'cg', name: 'Gemgala', icon: '🎮' },
    { code: 'cf', name: 'Irancell', icon: '📱' },
    { code: 'cb', name: 'Bazos', icon: '🛒' },
    { code: 'ca', name: 'SuperS', icon: '🛒' },
    { code: 'bx', name: 'Dosi', icon: '🥤' },
    { code: 'bu', name: 'Monobank India', icon: '🏦' },
    { code: 'bt', name: 'Alfa', icon: '🏦' },
    { code: 'bs', name: 'TradeUP', icon: '📈' },
    { code: 'bq', name: 'Adani', icon: '🏢' },
    { code: 'bm', name: 'MarketGuru', icon: '📊' },
    { code: 'bk', name: 'G2G', icon: '🎮' },
    { code: 'bi', name: '勇仕网络 Ys4fun', icon: '🎮' },
    { code: 'bg', name: 'MIXMART', icon: '🛒' },
    { code: 'bc', name: 'GCash', icon: '💰' },
    { code: 'bb', name: 'LazyPay', icon: '💰' },
    { code: 'az', name: 'CityBase', icon: '🏙️' },
    { code: 'ay', name: 'Ruten', icon: '🛒' },
    { code: 'ax', name: 'Crefisa Mais', icon: '🏦' },
    { code: 'au', name: 'Haraj', icon: '🛒' },
    { code: 'at', name: 'Perfluence', icon: '📈' },
    { code: 'ar', name: 'Wondermart', icon: '🛒' },
    { code: 'aq', name: 'Glovo', icon: '🚚' },
    { code: 'ao', name: 'UU163', icon: '🎮' },
    { code: 'af', name: 'TradeX', icon: '📈' },
    { code: 'ad', name: 'Iti', icon: '🔐' },
    { code: 'aa', name: 'Probo', icon: '🎮' },
    { code: 'bn', name: 'Alfagift', icon: '🎁' },
    { code: 'hy', name: 'Ininal', icon: '💰' },
    { code: 'ke', name: 'Eldorado', icon: '🛒' },
    { code: 'cc', name: 'Quipp', icon: '📱' },
    { code: 'ee', name: 'Twilio', icon: '📞' },
    { code: 'kp', name: 'HQ Trivia', icon: '❓' },
    { code: 'gz', name: 'LYKA', icon: '📱' },
    { code: 'ac', name: 'DoorDash', icon: '🚚' },
    { code: 'ai', name: 'CELEBe', icon: '📱' },
    { code: 'aw', name: 'Taikang', icon: '🏥' },
    { code: 'ki', name: '99app', icon: '📱' },
    { code: 'jl', name: 'Hopi', icon: '🎮' },
    { code: 'gm', name: 'Mocospace', icon: '💬' },
    { code: 'es', name: 'iQIYI', icon: '📺' },
    { code: 'dy', name: 'Zomato', icon: '🍕' },
    { code: 'pr', name: 'Trendyol', icon: '🛒' },
    { code: 'gp', name: 'Ticketmaster', icon: '🎟️' },
    { code: 'eq', name: 'Qoo10', icon: '🛒' },
    { code: 'full', name: 'Full Rent', icon: '📞' },
    { code: 'lx', name: 'Dewu Poison', icon: '⚠️' },
    { code: 'wj', name: '1xbet', icon: '🎰' },
    { code: 'ha', name: 'My11Circle', icon: '🏏' },
    { code: 'nw', name: 'Ximalaya', icon: '🎵' },
    { code: 'zl', name: 'Airtel', icon: '📱' },
    { code: 'pp', name: 'Huya', icon: '🎮' },
    { code: 'ak', name: 'Douyu', icon: '🎮' },
    { code: 'ly', name: 'Olacabs', icon: '🚗' },
    { code: 'dz', name: 'Dominos Pizza', icon: '🍕' },
    { code: 'vs', name: 'Winzo Game', icon: '🎮' },
    { code: 'cr', name: 'TenChat', icon: '💬' },
    { code: 'hg', name: 'Switips', icon: '💰' },
    { code: 'gb', name: 'YouStar', icon: '⭐' },
    { code: 'pd', name: 'iFood', icon: '🍕' },
    { code: 'dt', name: 'Delivery Club', icon: '🚚' },
    { code: 'yg', name: 'Course Hero', icon: '📚' },
    { code: 'nq', name: 'Trip', icon: '✈️' },
    { code: 'qr', name: 'MEGA', icon: '☁️' },
    { code: 'rz', name: 'EasyPay', icon: '💰' },
    { code: 'kz', name: 'Nimo TV', icon: '🎮' },
    { code: 'my', name: 'CAIXA', icon: '🏦' },
    { code: 'gr', name: 'Astropay', icon: '💰' },
    { code: 'df', name: 'Happn', icon: '💕' },
    { code: 'dg', name: 'Mercari', icon: '🛒' },
    { code: 'po', name: 'Premium.one', icon: '⭐' },
    { code: 'iv', name: 'Inboxlv', icon: '📧' },
    { code: 'bp', name: 'GoFundMe', icon: '💰' },
    { code: 'gx', name: 'Hepsiburada.com', icon: '🛒' },
    { code: 'mi', name: 'Zupee', icon: '🎮' },
    { code: 'nr', name: 'Tosla', icon: '💰' },
    { code: 'bo', name: 'Wise', icon: '💳' },
    { code: 'gw', name: 'CallApp', icon: '📞' },
    { code: 'qz', name: 'Faceit', icon: '🎮' },
    { code: 'yu', name: 'Xiaomi', icon: '📱' },
    { code: 'kj', name: 'YAPPY', icon: '🐕' },
    { code: 've', name: 'Dream11', icon: '🏏' },
    { code: 'il', name: 'IQOS', icon: '🚬' },
    { code: 'vg', name: 'Shell Box', icon: '⛽' },
    { code: 'sq', name: 'KuCoin Play', icon: '💰' },
    { code: 'ba', name: 'Expressmoney', icon: '💰' },
    { code: 'li', name: 'Baidu', icon: '🔍' },
    { code: 'lc', name: 'Subito', icon: '🛒' },
    { code: 'zi', name: 'LoveLocal', icon: '❤️' },
    { code: 'jf', name: 'Likee', icon: '📱' },
    { code: 'boo', name: 'Casino Plus', icon: '🎰' },
    { code: 'ads', name: 'GoChat', icon: '💬' },
    { code: 'agb', name: 'Smiles', icon: '😊' },
    { code: 'ot', name: 'Any Other', icon: '❓' },
    { code: 'xo', name: 'Notifire', icon: '🔔' },
    { code: 'wu', name: 'PrivetMir', icon: '💰' },
    { code: 'wy', name: 'Yami', icon: '🍬' },
    { code: 'xc', name: 'SynotTip', icon: '🎰' },
    { code: 'yr', name: 'Miravia', icon: '🛒' },
    { code: 'wr', name: 'Walmart', icon: '🛒' },
    { code: 'xg', name: 'Fortuna SK', icon: '🎰' },
    { code: 'zb', name: 'FreeNow', icon: '🚗' },
    { code: 'ze', name: 'Shpock', icon: '🛒' },
    { code: 'vr', name: 'Motorku X', icon: '🏍️' },
    { code: 'ws', name: 'Feeld', icon: '💕' },
    { code: 'abq', name: 'Upwork', icon: '💼' },
    { code: 'acz', name: 'Claude', icon: '🤖' },
    { code: 'avt', name: 'Hunt The Mouse', icon: '🐭' },
    { code: 'adq', name: 'Uzum', icon: '🌐' },
    { code: 'agm', name: 'CMB', icon: '🏦' },
    { code: 'agk', name: 'Ipsos iSay', icon: '📊' },
    { code: 'zp', name: 'Pinduoduo', icon: '🛒' },
    { code: 'aab', name: 'BharatPe', icon: '💰' },
    { code: 'aay', name: 'JioMart', icon: '🛒' },
    { code: 'abs', name: 'Playerzpot', icon: '🎮' },
    { code: 'ace', name: 'Tata Neu', icon: '🛒' },
    { code: 'acf', name: 'Winter Loan', icon: '💰' },
    { code: 'acg', name: 'KoronaPay', icon: '💰' },
    { code: 'acr', name: 'QwikCilver', icon: '💰' },
    { code: 'acs', name: 'Tata CLiQ Palette', icon: '💄' },
    { code: 'acu', name: 'CityMall', icon: '🛒' },
    { code: 'acv', name: 'A23', icon: '🎮' },
    { code: 'adb', name: 'PoshVine', icon: '🍷' },
    { code: 'adg', name: 'Yono777', icon: '🎮' },
    { code: 'adh', name: 'Frizza', icon: '🍕' },
    { code: 'adi', name: 'Zepto', icon: '🚚' },
    { code: 'adj', name: 'RummyCircle', icon: '🎮' },
    { code: 'adk', name: 'Khatabook', icon: '📒' },
    { code: 'adl', name: 'EarnEasy', icon: '💰' },
    { code: 'adm', name: 'FitCredit', icon: '💰' },
    { code: 'aev', name: 'Inshallah', icon: '☪️' },
    { code: 'afj', name: 'Laybuy', icon: '💰' },
    { code: 'afn', name: 'Roomster', icon: '🏠' },
    { code: 'ago', name: 'Servify', icon: '🔧' },
    { code: 'agp', name: 'HDFC Bank', icon: '🏦' },
    { code: 'agq', name: 'Bajaj Finserv', icon: '🏦' },
    { code: 'agr', name: 'Driffle', icon: '🎮' },
    { code: 'aha', name: 'Angel One', icon: '📈' },
    { code: 'aht', name: 'MockGuru', icon: '📚' },
    { code: 'aii', name: 'Hinge Dating', icon: '💕' },
    { code: 'aed', name: 'Booking.com', icon: '🏨' },
    { code: 'ack', name: 'RegainRX', icon: '💊' },
    { code: 'aar', name: 'Bearwww', icon: '🐻' },
    { code: 'agh', name: 'Getnet', icon: '💰' },
    { code: 'ahe', name: 'Bunq', icon: '🏦' },
    { code: 'abd', name: 'BeBoo', icon: '🐝' },
    { code: 'abn', name: 'Bybit', icon: '💰' },
    { code: 'acn', name: 'Gringo', icon: '💰' },
    { code: 'adx', name: 'FirstCry', icon: '👶' },
    { code: 'afp', name: 'VFS Global', icon: '🌐' },
    { code: 'ahk', name: 'BlinBeri', icon: '🛒' },
    { code: 'ahm', name: 'Eureka', icon: '💡' },
    { code: 'ahx', name: 'Bitrue', icon: '💰' },
    { code: 'aid', name: 'Kwiff', icon: '🎰' },
    { code: 'aif', name: 'Royal Canin', icon: '🐕' },
    { code: 'aaw', name: 'Aya Bank', icon: '🏦' },
    { code: 'aaq', name: 'Netease', icon: '🎮' },
    { code: 'aba', name: 'Rappi', icon: '🚚' },
    { code: 'adp', name: 'Cabify', icon: '🚗' },
    { code: 'aij', name: 'NEQUI', icon: '💰' },
    { code: 'aaz', name: 'Ozan', icon: '💰' },
    { code: 'aih', name: 'Fups', icon: '💰' },
    { code: 'aer', name: 'PlayerAuctions', icon: '🎮' },
    { code: 'afk', name: 'Chevron', icon: '⛽' },
    { code: 'aas', name: 'XXGame', icon: '🎮' },
    { code: 'aav', name: 'Alchemy', icon: '⚗️' },
    { code: 'aax', name: 'Boyaa', icon: '🎮' },
    { code: 'abi', name: 'BytePlus', icon: '📱' },
    { code: 'abr', name: 'Privy', icon: '🔐' },
    { code: 'acj', name: 'Teri Meri Choice', icon: '🎮' },
    { code: 'aag', name: 'Pockit', icon: '💰' },
    { code: 'aap', name: 'Tiptapp', icon: '📦' },
    { code: 'aau', name: 'RockeTreach', icon: '🚀' },
    { code: 'abc', name: 'Taptap Send', icon: '💰' },
    { code: 'abe', name: 'Foodora', icon: '🚚' },
    { code: 'abz', name: 'Darit Legko', icon: '💰' },
    { code: 'ach', name: 'Playt', icon: '🎮' },
    { code: 'acy', name: 'Airtime', icon: '📞' },
    { code: 'ada', name: 'TRUTH Social', icon: '🐦' },
    { code: 'adc', name: 'PlayOJO', icon: '🎰' },
    { code: 'aec', name: 'AaHIRA Fashion', icon: '👗' },
    { code: 'aft', name: 'Neocrypto', icon: '💰' },
    { code: 'afy', name: 'Tuul', icon: '💰' },
    { code: 'afz', name: 'Klarna', icon: '💰' },
    { code: 'agc', name: 'VIMpay', icon: '💰' },
    { code: 'agd', name: 'Grailed', icon: '👕' },
    { code: 'age', name: 'Yetz Promo', icon: '🎁' },
    { code: 'agf', name: 'Meitu', icon: '📱' },
    { code: 'agg', name: 'OneForma', icon: '💼' },
    { code: 'ags', name: 'Abbott', icon: '💊' },
    { code: 'abk', name: 'GMX', icon: '📧' },
    { code: 'abo', name: 'WEB.DE', icon: '📧' },
    { code: 'ahj', name: 'Strato', icon: '☁️' },
    { code: 'ahs', name: '1&1', icon: '🌐' },
    { code: 'ahv', name: 'Curve', icon: '💰' },
    { code: 'acd', name: 'Cloud.ru', icon: '☁️' },
    { code: 'aco', name: 'AR Lens', icon: '🔍' },
    { code: 'acp', name: 'BonusLink', icon: '🎁' },
    { code: 'acq', name: 'Astha Tea', icon: '🍵' },
    { code: 'aeb', name: 'Shine Brand Seeds', icon: '🌱' },
    { code: 'aei', name: 'Sharyat', icon: '📱' },
    { code: 'afb', name: 'Nebu', icon: '💰' },
    { code: 'afm', name: 'Myboost', icon: '💰' },
    { code: 'agx', name: 'MeiQ Fashion', icon: '👗' },
    { code: 'ahf', name: "GAIL's Bakery", icon: '🍞' },
    { code: 'aig', name: 'Five Surveys', icon: '📊' },
    { code: 'aiv', name: 'Remitly', icon: '💰' },
    { code: 'agj', name: 'Marktplaats', icon: '🛒' },
    { code: 'aiq', name: 'Prime Opinion', icon: '📊' },
    { code: 'abt', name: 'ArenaPlus', icon: '🎮' },
    { code: 'adt', name: 'Willhaben', icon: '🛒' },
    { code: 'ahd', name: 'Midnite', icon: '🎰' },
    { code: 'adu', name: 'Seznam', icon: '🔍' },
    { code: 'afw', name: 'Packeta', icon: '📦' },
    { code: 'aga', name: 'Publi24', icon: '🛒' },
    { code: 'agl', name: 'Betano', icon: '🎰' },
    { code: 'ahw', name: 'Zasilkovna', icon: '📦' },
    { code: 'abu', name: 'BPJSTK', icon: '🏦' },
    { code: 'adf', name: 'Punjab Timber Traders', icon: '🪵' },
    { code: 'ael', name: 'Cloud Manager', icon: '☁️' },
    { code: 'aem', name: 'AstraPay', icon: '💰' },
    { code: 'aen', name: 'Madslots', icon: '🎰' },
    { code: 'aeo', name: 'Allofresh', icon: '🛒' },
    { code: 'aep', name: 'Slickcall', icon: '📞' },
    { code: 'aeq', name: 'Godrej', icon: '🏢' },
    { code: 'aet', name: 'Greywoods', icon: '🏠' },
    { code: 'aeu', name: 'TheFork', icon: '🍴' },
    { code: 'aew', name: 'Flip', icon: '🛒' },
    { code: 'aex', name: 'Neon', icon: '💰' },
    { code: 'afc', name: 'Bunda', icon: '👗' },
    { code: 'afd', name: 'Astra Otoshop', icon: '🚗' },
    { code: 'afx', name: 'Gamesofa', icon: '🎮' },
    { code: 'agn', name: 'Velobayk', icon: '🚲' },
    { code: 'agz', name: 'Jiva Petani', icon: '🌾' },
    { code: 'ahb', name: 'Ubisoft', icon: '🎮' },
    { code: 'aho', name: 'Upland', icon: '🏙️' },
    { code: 'ahp', name: 'Handyticket', icon: '🎟️' },
    { code: 'ahq', name: 'Bitget', icon: '💰' },
    { code: 'aip', name: 'AfreecaTV', icon: '📺' },
    { code: 'air', name: 'Cleartrip', icon: '✈️' },
    { code: 'ais', name: 'DiDi Food', icon: '🚚' },
    { code: 'ait', name: 'FeetFinder', icon: '🦶' },
    { code: 'acc', name: 'LuckyLand Slots', icon: '🎰' },
    { code: 'ahi', name: 'Daki', icon: '🛒' },
    { code: 'agy', name: 'Pixels', icon: '🎨' },
    { code: 'ahr', name: 'This Fate', icon: '🔮' },
    { code: 'agi', name: 'Njuskalo', icon: '🛒' },
    { code: 'abb', name: 'Coca-Cola', icon: '🥤' },
    { code: 'abx', name: 'Kaching', icon: '💰' },
    { code: 'aby', name: 'ITMS', icon: '📱' },
    { code: 'acb', name: 'Spark Driver', icon: '🚗' },
    { code: 'acl', name: 'Swissmoney', icon: '💰' },
    { code: 'acm', name: 'Razer', icon: '🎮' },
    { code: 'adn', name: 'Janganana', icon: '💰' },
    { code: 'ado', name: 'Jasper Home Fashions', icon: '🏠' },
    { code: 'ahy', name: 'Fliff', icon: '💰' },
    { code: 'ain', name: 'SpaceWeb', icon: '🌐' },
    { code: 'aiz', name: 'Brevo', icon: '📧' },
    { code: 'ajl', name: 'Av100pro', icon: '📱' },
    { code: 'akf', name: 'Ollis', icon: '💰' },
    { code: 'ajd', name: 'Bankera', icon: '🏦' },
    { code: 'aja', name: 'G2A', icon: '🎮' },
    { code: 'aje', name: 'Cupid Media', icon: '💕' },
    { code: 'ajf', name: 'Bananatok', icon: '🍌' },
    { code: 'ajg', name: 'Zaymigo', icon: '💰' },
    { code: 'ajh', name: 'WAUG', icon: '📞' },
    { code: 'ajj', name: 'Rebtel', icon: '📞' },
    { code: 'ajm', name: 'Gener8', icon: '💰' },
    { code: 'ajn', name: 'Gopuff', icon: '🚚' },
    { code: 'akd', name: 'Feels', icon: '💕' },
    { code: 'aik', name: 'ZUS Coffee', icon: '☕' },
    { code: 'ail', name: 'Smotryoshka', icon: '👀' },
    { code: 'ajo', name: 'Coffee Tea', icon: '☕' },
    { code: 'aix', name: 'Move It', icon: '🏃' },
    { code: 'aio', name: 'Prakerja', icon: '💼' },
    { code: 'ajk', name: 'Venteny', icon: '💰' },
    { code: 'ajp', name: 'Asia Miles', icon: '✈️' },
    { code: 'ajq', name: 'MyValue', icon: '💰' },
    { code: 'ajr', name: 'Boku', icon: '💰' },
    { code: 'ajs', name: 'GetPlus', icon: '💰' },
    { code: 'aju', name: 'Daya Auto', icon: '🚗' },
    { code: 'ajv', name: 'ShareParty', icon: '🎉' },
    { code: 'ajw', name: 'INDOBA', icon: '💰' },
    { code: 'ajx', name: 'Kemnaker RI', icon: '💼' },
    { code: 'ajy', name: 'All Access', icon: '🎟️' },
    { code: 'ajz', name: 'MotionPay', icon: '💰' },
    { code: 'aka', name: 'LinkAja', icon: '💰' },
    { code: 'akg', name: 'Book My Play', icon: '🎮' },
    { code: 'akw', name: 'WINDS', icon: '🌬️' },
    { code: 'ako', name: 'Ryde', icon: '🚗' },
    { code: 'akp', name: 'Her', icon: '💕' },
    { code: 'akq', name: 'Blank Street', icon: '🏙️' },
    { code: 'akr', name: 'Voi', icon: '🛴' },
    { code: 'akx', name: 'Sony LIV', icon: '📺' },
    { code: 'aks', name: 'Hanya', icon: '💰' },
    { code: 'akh', name: 'Prenagen Club', icon: '👶' },
    { code: 'aki', name: 'Tiket.com', icon: '🎟️' },
    { code: 'akj', name: 'Easycash', icon: '💰' },
    { code: 'akk', name: 'Dagangan', icon: '🛒' },
    { code: 'akl', name: 'DOKU', icon: '💰' },
    { code: 'akm', name: 'LOTTE Mart', icon: '🛒' },
    { code: 'akn', name: 'Chakra Rewards', icon: '🕉️' },
    { code: 'akt', name: 'Xworldwallet', icon: '💰' },
    { code: 'aky', name: 'GOMOFY', icon: '💰' },
    { code: 'ali', name: 'StockyDodo', icon: '🦤' },
    { code: 'alp', name: 'Mera Gaon', icon: '🏠' },
    { code: 'akb', name: 'Gurmanika', icon: '🍴' },
    { code: 'ake', name: 'DIKIDI', icon: '🛒' },
    { code: 'ale', name: 'Lydia', icon: '💰' },
    { code: 'alm', name: 'Muzz', icon: '💕' },
    { code: 'alg', name: 'Ankama', icon: '🎮' },
    { code: 'alo', name: 'Profee', icon: '💰' },
    { code: 'ald', name: 'Nice88', icon: '🎰' },
    { code: 'akc', name: 'Paybis', icon: '💰' },
    { code: 'alh', name: 'Lion Parcel', icon: '🦁' },
    { code: 'ala', name: 'GetResponse', icon: '📧' },
    { code: 'aln', name: 'Remotasks', icon: '💼' },
    { code: 'alv', name: 'TIER', icon: '🛴' },
    { code: 'als', name: 'Greggs', icon: '🥐' },
    { code: 'amf', name: 'Acko', icon: '🛡️' },
    { code: 'amg', name: 'SBI Card', icon: '💳' },
    { code: 'ama', name: 'WooPlus', icon: '💕' },
    { code: 'amb', name: 'Vercel', icon: '🌐' },
    { code: 'ame', name: 'Discover Hong Kong', icon: '🇭🇰' },
    { code: 'amd', name: 'Smart', icon: '📱' },
    { code: 'alt', name: 'Segari', icon: '🛒' },
    { code: 'alu', name: 'BC Game', icon: '🎰' },
    { code: 'alw', name: 'Vida', icon: '💖' },
    { code: 'alx', name: 'NutriClub', icon: '🥗' },
    { code: 'aly', name: 'Bebeclub', icon: '👶' },
    { code: 'amm', name: 'Punjab Citizen', icon: '🏢' },
    { code: 'ami', name: 'TEAMORU', icon: '🎮' },
    { code: 'amk', name: 'GORDAN', icon: '💰' },
    { code: 'amh', name: 'MitID', icon: '🔐' },
    { code: 'amt', name: 'Moneyview', icon: '💰' },
    { code: 'aez', name: 'Shein', icon: '👗' },
    { code: 'ane', name: 'Supercell', icon: '🎮' },
    { code: 'anc', name: 'VARUS', icon: '🛒' },
    { code: 'amo', name: 'CoinFantasy', icon: '💰' },
    { code: 'aml', name: 'Xbox', icon: '🎮' },
    { code: 'avz', name: 'Getsbet', icon: '🎰' },
    { code: 'ars', name: 'Bingo Plus', icon: '🎰' },
    { code: 'ayk', name: 'Radquest', icon: '📡' },
    { code: 'aoa', name: 'Hicard', icon: '💳' },
    { code: 'axr', name: 'Match', icon: '💕' },
    { code: 'avb', name: 'Tealive', icon: '☕' },
    { code: 'bdx', name: 'Benjamin', icon: '💰' },
    { code: 'ani', name: 'Talabat', icon: '🍕' },
    { code: 'aos', name: 'Loloo', icon: '💬' },
    { code: 'alq', name: 'Etsy', icon: '🛒' },
    { code: 'ade', name: 'Magicpin', icon: '📍' },
    { code: 'boc', name: '51exch', icon: '💰' },
    { code: 'bbm', name: 'TrueMoney', icon: '💰' },
    { code: 'apr', name: 'Capital One', icon: '🏦' },
    { code: 'bva', name: 'Bingo101', icon: '🎰' },
    { code: 'brh', name: 'Efsane', icon: '⭐' },
    { code: 'bgf', name: 'Rapido', icon: '🏍️' },
    { code: 'bqz', name: 'Credit Karma', icon: '📊' },
    { code: 'apl', name: 'Sideline', icon: '📱' },
    { code: 'bhi', name: 'Chase', icon: '🏦' },
    { code: 'auw', name: '3Fun', icon: '💕' },
    { code: 'ari', name: 'Ring4', icon: '📞' },
    { code: 'aud', name: 'bkSMS', icon: '📞' },
    { code: 'bol', name: 'My TELUS', icon: '📱' },
    { code: 'awv', name: 'Wallapop', icon: '🛒' },
    { code: 'bnl', name: 'Reddit', icon: '🔴' },
    { code: 'auz', name: 'Outlier', icon: '📊' },
    { code: 'blr', name: 'DocuSign', icon: '✍️' },
    { code: 'bnu', name: 'Qpon', icon: '💰' },
    { code: 'awq', name: 'Atlas Earth', icon: '🌍' },
    { code: 'hj', name: 'Nykaa', icon: '💄' },
    { code: 'bou', name: '汇旺 Huione Pay', icon: '💰' },
    { code: 'aws', name: '7-Eleven', icon: '🏪' },
    { code: 'avk', name: 'Quoka', icon: '🛒' },
    { code: 'aqj', name: 'BigBasket', icon: '🛒' },
    { code: 'bwb', name: 'Winmatch365', icon: '🎰' },
    { code: 'aog', name: 'Naukri', icon: '💼' },
    { code: 'bsw', name: 'Milanuncios', icon: '🛒' },
    { code: 'bex', name: 'Whatnot', icon: '🛒' },
    { code: 'bhl', name: 'Ati su', icon: '💰' },
    { code: 'blb', name: 'Foundit', icon: '🔍' },
    { code: 'bzb', name: 'Big Cash', icon: '💰' },
    { code: 'ble', name: 'Nexon', icon: '🎮' },
    { code: 'bbf', name: 'Neosurf', icon: '💳' },
    { code: 'bdp', name: 'Kredito', icon: '💰' },
    { code: 'brg', name: 'Letgo', icon: '🛒' },
    { code: 'awg', name: 'Natura Avon', icon: '💄' },
    { code: 'apa', name: 'Exness', icon: '💰' }
];

// Germany - Same as USA
const germanyServices = [...usaServices];

// Nigeria - Limited services (WhatsApp, Telegram, Tinder, Alibaba, Twitter)
const nigeriaServices = [
    { code: 'wa', name: 'WhatsApp', icon: '💬' },
    { code: 'tg', name: 'Telegram', icon: '✈️' },
    { code: 'oi', name: 'Tinder', icon: '🔥' },
    { code: 'ab', name: 'Alibaba', icon: '🌐' },
    { code: 'tw', name: 'Twitter/X', icon: '🐦' }
];

// Other countries - Basic popular services
const otherServices = [
    { code: 'wa', name: 'WhatsApp', icon: '💬' },
    { code: 'tg', name: 'Telegram', icon: '✈️' },
    { code: 'ig', name: 'Instagram', icon: '📸' },
    { code: 'fb', name: 'Facebook', icon: '📘' },
    { code: 'lf', name: 'TikTok', icon: '🎵' },
    { code: 'tw', name: 'Twitter/X', icon: '🐦' },
    { code: 'ds', name: 'Discord', icon: '🎮' },
    { code: 'ub', name: 'Uber', icon: '🚗' },
    { code: 'bn', name: 'Binance', icon: '💰' },
    { code: 'ts', name: 'PayPal', icon: '💳' }
];

// Country-specific service mapping
const countryServicesMap = {
    187: usaServices,      // USA
    12: germanyServices,   // Germany
    161: nigeriaServices,  // Nigeria
    // Default for all other countries
    default: otherServices
};

// ============================================
// GET /api/sms/countries - Get available countries
// ============================================
router.get('/countries', authMiddleware, async (req, res) => {
    try {
        const countries = [
            { name: 'United States', code: 'US', flag: '🇺🇸', vs_code: 187 },
            { name: 'Canada', code: 'CA', flag: '🇨🇦', vs_code: 115 },
            { name: 'Brazil', code: 'BR', flag: '🇧🇷', vs_code: 55 },
            { name: 'Poland', code: 'PL', flag: '🇵🇱', vs_code: 48 },
            { name: 'Switzerland', code: 'CH', flag: '🇨🇭', vs_code: 41 },
            { name: 'United Kingdom', code: 'GB', flag: '🇬🇧', vs_code: 22 },
            { name: 'China', code: 'CN', flag: '🇨🇳', vs_code: 86 },
            { name: 'Nigeria', code: 'NG', flag: '🇳🇬', vs_code: 161 },
            { name: 'Ghana', code: 'GH', flag: '🇬🇭', vs_code: 233 },
            { name: 'Germany', code: 'DE', flag: '🇩🇪', vs_code: 12 },
            { name: 'Japan', code: 'JP', flag: '🇯🇵', vs_code: 81 },
            { name: 'India', code: 'IN', flag: '🇮🇳', vs_code: 77 },
            { name: 'New Zealand', code: 'NZ', flag: '🇳🇿', vs_code: 64 },
            { name: 'Australia', code: 'AU', flag: '🇦🇺', vs_code: 61 },
            { name: 'UAE', code: 'AE', flag: '🇦🇪', vs_code: 971 }
        ];
        
        res.json({ success: true, countries });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/sms/services - Get services for selected country
// ============================================
router.post('/services', authMiddleware, async (req, res) => {
    try {
        const { country_code } = req.body;
        
        // Get services based on country
        let services = countryServicesMap[country_code] || countryServicesMap.default;
        
        res.json({ success: true, services });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/sms/price - Check price for service + country
// ============================================
router.post('/price', authMiddleware, async (req, res) => {
    try {
        const { service, country_code } = req.body;
        
        // Get real price from VirtualSMS API
        const response = await axios.get(`https://virtualsms.io/stubs/handler_api.php`, {
            params: {
                action: 'getNumber',
                service: service,
                country: country_code,
                api_key: VS_API_KEY
            }
        });
        
        let usdPrice = 0.15; // Default fallback
        const responseText = response.data;
        
        if (responseText.startsWith('ACCESS_NUMBER')) {
            const parts = responseText.split(':');
            if (parts.length >= 4) {
                const activationId = parts[1];
                // Cancel immediately to just get price
                await axios.get(`https://virtualsms.io/stubs/handler_api.php`, {
                    params: { action: 'setStatus', id: activationId, status: 8, api_key: VS_API_KEY }
                });
            }
        }
        
        // Calculate NGN price: USD price × 1000 × 2 (your markup)
        let priceNGN = usdPrice * 1000 * 2;
        
        // Special pricing for WhatsApp USA
        if (service === 'wa' && country_code === 187) {
            priceNGN = 3000;
        }
        
        res.json({ 
            success: true, 
            price_usd: usdPrice,
            price_ngn: Math.round(priceNGN),
            service, 
            country_code 
        });
    } catch (error) {
        console.error('Price check error:', error.message);
        // Fallback pricing
        let fallbackPrice = 1500;
        if (req.body.service === 'wa' && req.body.country_code === 187) fallbackPrice = 3000;
        res.json({ success: true, price_ngn: fallbackPrice, is_fallback: true });
    }
});

// ============================================
// POST /api/sms/rent - Rent a virtual number
// ============================================
router.post('/rent', authMiddleware, async (req, res) => {
    try {
        const { service, country_code } = req.body;
        const userId = req.user.id;
        
        // Get user balance first
        const { data: user, error: userError } = await supabase
            .from('profiles')
            .select('balance')
            .eq('id', userId)
            .single();
        
        if (userError) throw userError;
        
        // Calculate price
        let priceNGN = 1500;
        if (service === 'wa' && country_code === 187) priceNGN = 3000;
        
        // Check balance
        if (user.balance < priceNGN) {
            return res.status(400).json({ 
                error: `Insufficient balance. Need ₦${priceNGN.toLocaleString()}. Your balance: ₦${user.balance.toLocaleString()}` 
            });
        }
        
        // Get number from VirtualSMS
        const response = await axios.get(`https://virtualsms.io/stubs/handler_api.php`, {
            params: {
                action: 'getNumber',
                service: service,
                country: country_code,
                api_key: VS_API_KEY
            }
        });
        
        const responseText = response.data;
        
        if (!responseText.startsWith('ACCESS_NUMBER')) {
            throw new Error(`Failed to get number: ${responseText}`);
        }
        
        const parts = responseText.split(':');
        const activationId = parts[1];
        const phoneNumber = parts[2];
        
        // Deduct balance
        const newBalance = user.balance - priceNGN;
        await supabase
            .from('profiles')
            .update({ balance: newBalance })
            .eq('id', userId);
        
        // Save order to database
        const { data: order, error: orderError } = await supabase
            .from('sms_orders')
            .insert([{
                user_id: userId,
                activation_id: activationId,
                phone_number: phoneNumber,
                service: service,
                country_code: country_code,
                cost_ngn: priceNGN,
                status: 'pending',
                expires_at: new Date(Date.now() + 20 * 60 * 1000),
                created_at: new Date()
            }])
            .select()
            .single();
        
        if (orderError) {
            // Refund if order save fails
            await supabase.from('profiles').update({ balance: user.balance }).eq('id', userId);
            throw orderError;
        }
        
        res.json({
            success: true,
            message: 'Number rented successfully!',
            data: {
                order_id: order.id,
                activation_id: activationId,
                phone_number: phoneNumber,
                expires_in: '20 minutes'
            }
        });
        
    } catch (error) {
        console.error('Rent error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/sms/check-code - Check for SMS code
// ============================================
router.post('/check-code', authMiddleware, async (req, res) => {
    try {
        const { order_id } = req.body;
        const userId = req.user.id;
        
        const { data: order, error: orderError } = await supabase
            .from('sms_orders')
            .select('*')
            .eq('id', order_id)
            .eq('user_id', userId)
            .single();
        
        if (orderError || !order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const response = await axios.get(`https://virtualsms.io/stubs/handler_api.php`, {
            params: {
                action: 'getStatus',
                id: order.activation_id,
                api_key: VS_API_KEY
            }
        });
        
        const statusText = response.data;
        
        if (statusText === 'STATUS_WAIT_CODE') {
            return res.json({ success: true, status: 'waiting', message: 'No SMS yet. Waiting...' });
        }
        
        if (statusText.startsWith('STATUS_OK')) {
            const code = statusText.split(':')[1];
            
            await supabase
                .from('sms_orders')
                .update({ 
                    sms_code: code, 
                    status: 'completed',
                    received_at: new Date()
                })
                .eq('id', order_id);
            
            await axios.get(`https://virtualsms.io/stubs/handler_api.php`, {
                params: {
                    action: 'setStatus',
                    id: order.activation_id,
                    status: 6,
                    api_key: VS_API_KEY
                }
            });
            
            return res.json({ 
                success: true, 
                status: 'completed', 
                sms_code: code,
                message: 'SMS received!'
            });
        }
        
        if (statusText === 'STATUS_CANCEL') {
            return res.json({ success: false, status: 'cancelled', error: 'Order was cancelled' });
        }
        
        res.json({ success: true, status: 'waiting', message: 'Still waiting for SMS...' });
        
    } catch (error) {
        console.error('Check code error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/sms/cancel - Cancel order and refund
// ============================================
router.post('/cancel', authMiddleware, async (req, res) => {
    try {
        const { order_id } = req.body;
        const userId = req.user.id;
        
        const { data: order, error: orderError } = await supabase
            .from('sms_orders')
            .select('*')
            .eq('id', order_id)
            .eq('user_id', userId)
            .single();
        
        if (orderError || !order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        if (order.status === 'completed') {
            return res.status(400).json({ error: 'Cannot cancel completed order' });
        }
        
        await axios.get(`https://virtualsms.io/stubs/handler_api.php`, {
            params: {
                action: 'setStatus',
                id: order.activation_id,
                status: 8,
                api_key: VS_API_KEY
            }
        });
        
        const { data: user, error: userError } = await supabase
            .from('profiles')
            .select('balance')
            .eq('id', userId)
            .single();
        
        if (!userError && user) {
            const newBalance = user.balance + order.cost_ngn;
            await supabase
                .from('profiles')
                .update({ balance: newBalance })
                .eq('id', userId);
        }
        
        await supabase
            .from('sms_orders')
            .update({ status: 'cancelled' })
            .eq('id', order_id);
        
        res.json({ success: true, message: 'Order cancelled and refunded' });
        
    } catch (error) {
        console.error('Cancel error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// GET /api/sms/my-rentals - Get user's rentals
// ============================================
router.get('/my-rentals', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('sms_orders')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        res.json({ success: true, rentals: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;