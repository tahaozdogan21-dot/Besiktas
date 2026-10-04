const express = require('express');
const axios = require('axios');
const { createClient } = require('@libsql/client');
const app = express();

app.use(express.json());

const BOT_SURUMU = 'BJK-SADE sürüm 2026-10-04-a';

// ─── ENV ───────────────────────────────────────────────────────────────────────
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'besiktas2024';
// Anahtar temizlenir: baş/son boşluk, satır sonu, tırnak, "CLAUDE_API_KEY=" ve "Bearer " ön ekleri atılır
const CLAUDE_API_KEY  = String(process.env.CLAUDE_API_KEY || '').trim().replace(/^["']+|["']+$/g, '').replace(/^(CLAUDE_API_KEY\s*=\s*|Bearer\s+)/i, '').replace(/\s+/g, '');
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TURSO_URL          = process.env.TURSO_URL;
const TURSO_TOKEN        = process.env.TURSO_TOKEN;
const MODEL_ADI = 'claude-haiku-4-5-20251001';
const WA_NUMARA = '905366303654';

// ─── TURSO KURULUM ─────────────────────────────────────────────────────────────
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function dbInit() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kullanicilar_bjks (
      id TEXT PRIMARY KEY,
      gorsel_gitti INTEGER DEFAULT 0,
      kart_uyari_gitti INTEGER DEFAULT 0,
      konusmalar TEXT DEFAULT '[]',
      son_mesaj INTEGER DEFAULT 0,
      guncelleme INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS islenmis_yorumlar_bjks (
      yorum_id TEXT PRIMARY KEY,
      tarih INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS takip_mesajlari_bjks (
      id TEXT PRIMARY KEY,
      adet INTEGER DEFAULT 0,
      tarih INTEGER DEFAULT (unixepoch())
    )
  `);
  // Gönderilen ürün görselinin mesaj kimliği → ürün kodu (müşteri görsele yanıt verince hangi ürün olduğu anlaşılır)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gorsel_mid_bjks (
      mid TEXT PRIMARY KEY,
      kod TEXT,
      kullanici_id TEXT,
      tarih INTEGER
    )
  `);
  try { await db.execute('ALTER TABLE kullanicilar_bjks ADD COLUMN son_mesaj INTEGER DEFAULT 0'); } catch(e) {}
  try { await db.execute('ALTER TABLE kullanicilar_bjks ADD COLUMN siparis_verildi INTEGER DEFAULT 0'); } catch(e) {}
  try { await db.execute('ALTER TABLE kullanicilar_bjks ADD COLUMN siparis_tarihi INTEGER DEFAULT 0'); } catch(e) {}
  await db.execute(`
    CREATE TABLE IF NOT EXISTS bekleyen_siparisler_bjks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      siparis_json TEXT NOT NULL,
      deneme INTEGER DEFAULT 0,
      tarih INTEGER DEFAULT (unixepoch())
    )
  `);
}
dbInit().catch(e => console.error('DB init err:', e.message));

// 7 günden eski işlenmiş yorumları ve 30 günden eski görsel kayıtlarını temizle
async function eskiYorumlariTemizle() {
  const sinir = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  await db.execute({ sql: 'DELETE FROM islenmis_yorumlar_bjks WHERE tarih < ?', args: [sinir] });
  await db.execute({ sql: 'DELETE FROM gorsel_mid_bjks WHERE tarih < ?', args: [Math.floor(Date.now() / 1000) - 30 * 24 * 3600] });
}
setInterval(() => eskiYorumlariTemizle().catch(() => {}), 24 * 60 * 60 * 1000);

async function yorumIslendi(yorumId) {
  try {
    await db.execute({ sql: 'INSERT INTO islenmis_yorumlar_bjks (yorum_id) VALUES (?)', args: [yorumId] });
    return true;
  } catch(e) {
    return false;
  }
}

// Takip mesajı — günde en fazla 1 kez
async function takipMesajiGonderilsinMi(id) {
  const simdi = Math.floor(Date.now() / 1000);
  const gunBaslangic = simdi - (simdi % 86400);
  try {
    const r = await db.execute({ sql: 'SELECT adet, tarih FROM takip_mesajlari_bjks WHERE id = ?', args: [id] });
    if (r.rows.length === 0) {
      await db.execute({ sql: 'INSERT INTO takip_mesajlari_bjks (id, adet, tarih) VALUES (?, 1, ?)', args: [id, simdi] });
      return true;
    }
    const row = r.rows[0];
    const ayniGun = Number(row.tarih) >= gunBaslangic;
    if (ayniGun && Number(row.adet) >= 1) return false;
    await db.execute({ sql: 'UPDATE takip_mesajlari_bjks SET adet = 1, tarih = ? WHERE id = ?', args: [simdi, id] });
    return true;
  } catch(e) {
    return false;
  }
}

const BIR_GUN_SANIYE = 24 * 60 * 60; // 24 saat

async function dbKullaniciAl(id) {
  const r = await db.execute({ sql: 'SELECT * FROM kullanicilar_bjks WHERE id = ?', args: [id] });
  const simdi = Math.floor(Date.now() / 1000);
  if (r.rows.length === 0) {
    await db.execute({ sql: 'INSERT INTO kullanicilar_bjks (id, son_mesaj) VALUES (?, ?)', args: [id, simdi] });
    return { gorselGitti: false, kartUyariGitti: false, konusmalar: [], siparisVerildi: false, siparisTarihi: 0 };
  }
  const row = r.rows[0];
  const sonMesaj = Number(row.son_mesaj) || 0;
  const siparisVerildi = !!row.siparis_verildi;
  const siparisTarihi = Number(row.siparis_tarihi) || 0;
  const BES_GUN = 5 * 24 * 60 * 60;

  // Sipariş verilmişse
  if (siparisVerildi) {
    if ((simdi - siparisTarihi) > BES_GUN) {
      // 5 gün geçti, sıfırla
      await db.execute({ sql: 'UPDATE kullanicilar_bjks SET gorsel_gitti=0, kart_uyari_gitti=0, konusmalar=?, siparis_verildi=0, siparis_tarihi=0 WHERE id=?', args: ['[]', id] });
      return { gorselGitti: false, kartUyariGitti: false, konusmalar: [], siparisVerildi: false, siparisTarihi: 0 };
    }
    // 5 gün dolmadı: görsel/kampanya tekrar gitmez, sorular cevaplanır
    return {
      gorselGitti:    true,
      kartUyariGitti: !!row.kart_uyari_gitti,
      konusmalar:     JSON.parse(row.konusmalar || '[]'),
      siparisVerildi: true,
      siparisTarihi,
    };
  }

  // Sipariş verilmemiş, 24 saat geçtiyse sıfırla
  if ((simdi - sonMesaj) > BIR_GUN_SANIYE && row.gorsel_gitti) {
    return { gorselGitti: false, kartUyariGitti: false, konusmalar: [], siparisVerildi: false, siparisTarihi: 0 };
  }
  return {
    gorselGitti:    !!row.gorsel_gitti,
    kartUyariGitti: !!row.kart_uyari_gitti,
    konusmalar:     JSON.parse(row.konusmalar || '[]'),
    siparisVerildi: false,
    siparisTarihi:  0,
  };
}

async function dbKaydet(id, data) {
  const simdi = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `UPDATE kullanicilar_bjks
          SET gorsel_gitti = ?, kart_uyari_gitti = ?, konusmalar = ?,
              son_mesaj = ?, guncelleme = unixepoch(),
              siparis_verildi = ?, siparis_tarihi = ?
          WHERE id = ?`,
    args: [
      data.gorselGitti ? 1 : 0,
      data.kartUyariGitti ? 1 : 0,
      JSON.stringify(data.konusmalar),
      simdi,
      data.siparisVerildi ? 1 : 0,
      data.siparisTarihi || 0,
      id,
    ],
  });
}

async function eskiKayitlariTemizle() {
  const sinir = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  await db.execute({ sql: 'DELETE FROM kullanicilar_bjks WHERE guncelleme < ? AND siparis_verildi = 0', args: [sinir] });
}
setInterval(() => eskiKayitlariTemizle().catch(() => {}), 24 * 60 * 60 * 1000);

async function midKaydet(mid, kod, kullaniciId) {
  try {
    await db.execute({ sql: 'INSERT OR REPLACE INTO gorsel_mid_bjks (mid, kod, kullanici_id, tarih) VALUES (?, ?, ?, ?)', args: [mid, kod, kullaniciId, Math.floor(Date.now() / 1000)] });
  } catch (e) { console.error('mid kayıt err:', e.message); }
}
async function midUrunu(mid) {
  try {
    const r = await db.execute({ sql: 'SELECT kod FROM gorsel_mid_bjks WHERE mid = ?', args: [mid] });
    return r.rows.length ? String(r.rows[0].kod) : null;
  } catch (e) { return null; }
}

// ─── RAM: Sadece geçici işlem state'i ─────────────────────────────────────────
const islemDurumu = {};
const floodKoruma = {}; // { [id]: { sayac, ilkZaman, engellendi } }

function islemDurumuAl(id) {
  if (!islemDurumu[id]) {
    islemDurumu[id] = { mesgulMu: false, bekleyenler: [], timer: null, takipTimer: null, sonNotrMesaj: 0 };
  }
  return islemDurumu[id];
}

function floodKontrol(id) {
  const simdi = Date.now();
  if (!floodKoruma[id]) floodKoruma[id] = { sayac: 0, ilkZaman: simdi, engellendi: false };
  const f = floodKoruma[id];

  // Engel süresi bitti mi?
  if (f.engellendi && (simdi - f.ilkZaman) > 10 * 60 * 1000) {
    floodKoruma[id] = { sayac: 1, ilkZaman: simdi, engellendi: false };
    return false;
  }
  if (f.engellendi) return true;

  // 10 saniye penceresi
  if ((simdi - f.ilkZaman) > 10 * 1000) {
    floodKoruma[id] = { sayac: 1, ilkZaman: simdi, engellendi: false };
    return false;
  }

  f.sayac++;
  if (f.sayac >= 10) { // görsellere art arda yanıt verenler engellenmesin
    f.engellendi = true;
    f.ilkZaman = simdi;
    console.log('Flood engeli:', id);
    return true;
  }
  return false;
}

// ─── SABİTLER ──────────────────────────────────────────────────────────────────
// ÜRÜN EKLEMEK / KALDIRMAK / GÖRSEL EKLEMEK İÇİN SADECE BU LİSTEYİ DÜZENLE (görseller bu sırayla gider)
//   kod    : 4 haneli ürün kodu (görselin üzerinde yazan kod)
//   tip    : 'polar' ya da 'forma'
//   ad     : müşteriye ve siparişe yazılan ürün adı (BÜYÜK HARF)
//   gorsel : görsel linki (boş bırakılırsa o ürünün görseli gönderilmez; link eklenince otomatik gider)
const URUNLER = [
  { kod: '0019', tip: 'polar', ad: 'BJK SİYAH POLAR',    gorsel: 'https://ik.imagekit.io/dlu7adglt/BJK%20CUBUKLU_PoNTrJNRY.png?updatedAt=1791076307523' },
  { kod: '0003', tip: 'polar', ad: 'BJK BEYAZ POLAR',    gorsel: 'https://ik.imagekit.io/dlu7adglt/BJK%20CUBUKLU.png?updatedAt=1791076243289' },
  { kod: '0020', tip: 'forma', ad: 'BJK SİYAH FORMA',    gorsel: 'https://ik.imagekit.io/dlu7adglt/0019.jpeg?updatedAt=1791076230571' },
  { kod: '0021', tip: 'forma', ad: 'BJK ÇUBUKLU FORMA',  gorsel: 'https://ik.imagekit.io/dlu7adglt/BJK%20CUBUKLU_KXsgjyY0H.png?updatedAt=1791076304698' },
];
const GORSELLI_URUNLER = URUNLER.filter(u => u.gorsel);
URUNLER.filter(u => !u.gorsel).forEach(u => console.warn('⚠️ GÖRSEL LİNKİ BOŞ, gönderilmeyecek:', u.kod, u.ad));
const URUN_KODLARI = Object.fromEntries(URUNLER.map(u => [u.kod, u.ad]));
const ESKI_KODLAR = {}; // eski kod → yeni kod eşleşmesi gerekirse buraya yazılır, örn. { '0299': '0301' }

const KART_UYARI = 'Kartla ödemelerde kargo firması Pos Cihazı Hizmet Bedeli adı altında +50₺ ekstra ücret alıyor. En uygunu nakit ödemedir, nakit olarak sisteme alalım mı?';
const KART_CEVAP = 'Kapıda kartla da ödeyebilirsiniz, kartla ödemelerde Pos Cihazı Hizmet Bedeli olarak +50₺ ekstra ücret vardır';

// Kampanya (vitrin) mesajı: görsellerden sonra müşteriye yalnızca BİR KEZ gider
const VITRIN = '⚫️ 1 Polar Üst · 1250₺\n⚫️ 2 Polar Üst · 2500₺\n\n🎁 2 Polar Üst alana 1 hediye\n(polar üst ya da forma)\n\n✨ 2\'Lİ SET\n⚫️ 1 Polar Üst + 👕 1 Forma · 1600₺\n\n🚚 Kargo dahil · Kapıda ödeme · Şeffaf kargo';

// ─── YARDIMCI FONKSİYONLAR ─────────────────────────────────────────────────────
function kodaIsimCevir(metin) {
  let s = metin;
  Object.keys(URUN_KODLARI).forEach(k => {
    s = s.replace(new RegExp(k, 'g'), URUN_KODLARI[k]);
  });
  return s;
}

// Müşterinin yazdığı eski ürün kodlarını yenisine çevirir (ESKI_KODLAR listesine göre)
function kodDuzelt(metin) {
  let s = metin;
  Object.keys(ESKI_KODLAR).forEach(k => { s = s.replace(new RegExp('(?<!\\d)' + k + '(?!\\d)', 'g'), ESKI_KODLAR[k]); });
  return s;
}

function kartVar(m) {
  return ['kart', 'kard', 'kartla', 'karta', 'kredi'].some(k =>
    m.toLowerCase().includes(k)
  );
}

function siparisiParsEt(metin) {
  try {
    const m = metin.match(/###SIPARIS_BASLA###([\s\S]*?)###SIPARIS_BITIS###/);
    if (m) return JSON.parse(m[1].trim());
  } catch (e) {}
  return null;
}

function anlamsizMi(txt) {
  const t = txt.trim();
  if (!t) return true;
  if (/^[.…\s😊👍❤️🙏]+$/.test(t)) return true;
  if (t.length < 2 && !/^(s|m|l)$/i.test(t)) return true; // tek harfli beden (S, M, L) yok sayılmaz
  return false;
}

function bekle(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Claude cevabında emoji kalmasın (kampanya mesajları sabit metin, bundan etkilenmez)
function emojiTemizle(metin) {
  return String(metin || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/[ \t]+\n/g, '\n').trim();
}

// ── BEDEN ÖNERİSİ: boy + kilodan KOD hesaplar (Claude'a [BEDEN ÖNERİSİ: X] notu olarak verilir; Claude hesap yapmaz) ──
// BEDEN TABLOSU: tek yerden düzenlenir. KİLO bedeni belirler (aralıklar ardışık, boşluk/çakışma yok); BOY sadece uzun müşteriyi YUKARI çeker.
const BEDEN_SIRASI_LISTE = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const BEDEN_KILO_UST_SINIRLARI = [['S', 60], ['M', 70], ['L', 80], ['XL', 90], ['XXL', 100], ['XXXL', 115]]; // bu kiloya KADAR (dahil)
const BEDEN_BOY_EN_AZ = [[194, 'XXL'], [188, 'XL'], [183, 'L'], [177, 'M']];                                  // boy bu değer ve üzeriyse EN AZ bu beden
const BEDEN_KILO_MIN = 40, BEDEN_KILO_MAX = 115, BEDEN_BOY_MIN = 150, BEDEN_BOY_MAX = 205;                  // dışındakiler canlı desteğe
function bedenOner(boy, kilo, tercih) {
  if (!(kilo >= BEDEN_KILO_MIN && kilo <= BEDEN_KILO_MAX && boy >= BEDEN_BOY_MIN && boy <= BEDEN_BOY_MAX)) return { ok: false };
  let idx = BEDEN_KILO_UST_SINIRLARI.findIndex(([, ust]) => kilo <= ust);
  for (const [bm, b] of BEDEN_BOY_EN_AZ) { if (boy >= bm) { idx = Math.max(idx, BEDEN_SIRASI_LISTE.indexOf(b)); break; } }
  if (tercih > 0) idx++;          // bol giymek isteyen: bir beden büyük
  if (tercih < 0) idx--;          // dar/vücuda oturan isteyen: bir beden küçük
  idx = Math.max(0, Math.min(BEDEN_SIRASI_LISTE.length - 1, idx));
  return { ok: true, beden: BEDEN_SIRASI_LISTE[idx] };
}
// "180 85", "180 cm 85 kg", "boyum 1.80 kilom 85", "85 kilo 180 boy" ... → { boy, kilo, tercih, etiketli } ya da null
function boyKiloAyikla(metin) {
  const t = String(metin || '').toLocaleLowerCase('tr').replace(/(\d),(\d)/g, '$1.$2');
  if (/(yaş|yas|çocuk|cocuk|oğlum|oglum|kızım|kizim)/.test(t)) return null;                    // çocuk bedeni ayrı konu
  if (/(?<![\p{L}\d])(s|m|l|xl|xxl|xxxl|2xl|3xl)(?![\p{L}\d])/u.test(t)) return null;           // müşteri beden de yazmışsa o geçerli
  const sayilar = [];
  const re = /(\d+(?:\.\d+)?)/g; let m;
  while ((m = re.exec(t)) !== null) sayilar.push({ deger: parseFloat(m[1]), bas: m.index, son: m.index + m[1].length });
  if (sayilar.length < 2 || sayilar.length > 3) return null;
  let boy = null, kilo = null, etiketli = false;
  const kullanilan = new Set();
  sayilar.forEach((n, i) => {
    const sonra = t.slice(n.son, n.son + 14).trim(), once = t.slice(Math.max(0, n.bas - 14), n.bas).trim();
    const boyE = /^(cm|santim|santimetre|boy)(?![\p{L}])/u.test(sonra) || /(boyum|boyu|boy)\s*[:=]?\s*$/.test(once);
    const kiloE = /^(kg|kilo|kilogram)(?![\p{L}])/u.test(sonra) || /(kilom|kilo|kg)\s*[:=]?\s*$/.test(once);
    if (boyE && boy === null) { boy = n.deger < 3 ? Math.round(n.deger * 100) : n.deger; kullanilan.add(i); etiketli = true; }
    else if (kiloE && kilo === null) { kilo = n.deger; kullanilan.add(i); etiketli = true; }
  });
  sayilar.forEach((n, i) => {   // etiketsiz sayılar: 1.40-2.20 (metre) ya da 140-220 → boy, 35-160 → kilo
    if (kullanilan.has(i)) return;
    if (boy === null && ((n.deger >= 1.4 && n.deger <= 2.2) || (n.deger >= 140 && n.deger <= 220))) { boy = n.deger < 3 ? Math.round(n.deger * 100) : n.deger; kullanilan.add(i); }
    else if (kilo === null && n.deger >= 35 && n.deger <= 160) { kilo = n.deger; kullanilan.add(i); }
  });
  if (boy === null || kilo === null) return null;
  const tercih = /(?<![\p{L}\d])(bol|rahat|geniş)/u.test(t) ? 1 : (/(?<![\p{L}\d])(dar|oturan|vücuda|fit)(?![\p{L}])/u.test(t) ? -1 : 0);
  // sade: mesaj yalnızca sayılardan (ve cm/kg/boy/kilo/bol/dar gibi kelimelerden) oluşuyor
  const kalan = t.replace(/[\d.,]+/g, ' ').replace(/(?<![\p{L}\d])(cm|kg|kilo|kilom|kilogram|boy|boyum|boyu|santim|santimetre|ve|bol|dar|rahat|geniş|oturan|fit|vücuda|olsun|giymek|istiyorum)(?![\p{L}\d])/gu, ' ').trim();
  return { boy, kilo, tercih, etiketli, sade: kalan === '' };
}

// Müşterinin farklı yazdığı büyük bedenleri tek biçime çevirir: 2XL / 2-XL / XXL / double XL → XXL ; 3XL / 3-XL / XXXL / XXX L / triple XL → XXXL
// (boşluklu "3 XL" / "2 XL" adet de olabileceği için dokunulmaz, komuttaki kuralla ayrılır)
function bedenYazimDuzelt(metin) {
  const L = '(?<![\\p{L}\\d])', R = '(?![\\p{L}\\d])';
  let s = String(metin);
  s = s.replace(new RegExp(L + '(?:3\\s*[-.]?\\s*x\\s*[-.]?\\s*l(?:arge)?|3\\s*x(?:-|\\s)?large|(?:3|üç|uc)\\s*-?\\s*xl|x\\s*x\\s*x\\s*[-]?\\s*l(?:arge)?|triple\\s*-?\\s*x\\s*l|üç\\s*x\\s*l)' + R, 'giu'), (m) => /^\s*3\s+xl$/i.test(m) ? m : 'XXXL');
  s = s.replace(new RegExp(L + '(?:2\\s*[-.]?\\s*x\\s*[-.]?\\s*l(?:arge)?|x\\s*x\\s*[-]?\\s*l(?:arge)?|double\\s*-?\\s*x\\s*l|çift\\s*-?\\s*x\\s*l|cift\\s*-?\\s*x\\s*l)' + R, 'giu'), (m) => /^\s*2\s+xl$/i.test(m) ? m : 'XXL');
  s = s.replace(new RegExp(L + '(?:extra\\s*large|x\\s*large)' + R, 'giu'), 'XL');
  return s;
}

// Müşteri "3 adet", "iki tane" gibi yazdıysa toplam adedi bota not olarak verir (hediye bu adedin İÇİNDEDİR); "1 adet daha" gibi ek adetlere dokunmaz
const ADET_KELIMELERI = { bir: 1, iki: 2, 'üç': 3, uc: 3, 'dört': 4, dort: 4, 'beş': 5, bes: 5 };
function adetNotu(metin) {
  const m = String(metin).toLocaleLowerCase('tr').match(/(?<![\p{L}\d])(\d{1,2}|bir|iki|üç|uc|dört|dort|beş|bes)\s*(?:adet|tane|tanesi)(?![\p{L}])(?!\s*daha)/u);
  if (!m) return '';
  const n = /^\d/.test(m[1]) ? parseInt(m[1], 10) : ADET_KELIMELERI[m[1]];
  return n >= 2 && n <= 9 ? ' [MÜŞTERİ ADEDİ: ' + n + ' adet (hediye dahil toplam)]' : '';
}

// Mesajdaki ürünleri (görsele yanıt etiketi ya da 4 haneli kod) sayar: [MESAJDAKİ ÜRÜNLER: 1 polar üst + 1 forma (...)]
function urunOzetiNotu(metin) {
  const bulunan = URUNLER.filter(u => metin.includes('[' + u.ad + ' görseline yanıt]') || new RegExp('(?<!\\d)' + u.kod + '(?!\\d)').test(metin));
  if (bulunan.length < 2) return '';
  const p = bulunan.filter(u => u.tip === 'polar').length, f = bulunan.length - p;
  return ' [MESAJDAKİ ÜRÜNLER: ' + p + ' polar üst + ' + f + ' forma (' + bulunan.map(u => u.ad).join(', ') + ')]';
}

// İlk mesaj yalnızca selam / fiyat-bilgi-görsel isteğiyse kampanya mesajı zaten cevaptır, ardından ayrıca yazılmaz
const ILK_MESAJ_SESSIZ = new Set(('merhaba merhabalar selam selamlar slm mrb sa as günaydın gunaydin iyi günler gunler akşamlar aksamlar hey efendim lütfen lutfen rica ederim ' +
  'fiyat fiyatı fiyati fiyatlar fiyatları fiyatlari fiyatını fiyatini nedir ne kadar kaç kac para lira tl bilgi bilgisi bilgiler detay detaylı detayli görsel görseller görseli gorsel ' +
  'katalog kampanya kampanyalar kampanyanız ürün ürünler ürünleriniz model modeller var mı mi mu mü için ve hakkında hakkinda öğrenmek ogrenmek öğrenebilir miyim alabilir ' +
  'verir misiniz mısınız yazar atar atabilir gönderir gönderebilir yardımcı olur musunuz merak ettim ilgileniyorum ilgilendim bakabilir bakıyorum bakiyorum').split(/\s+/));
function sadeceSelamVeBilgi(metin) {
  const t = String(metin || '').toLocaleLowerCase('tr').replace(/bilgi\s+al\p{L}*|fiyat\s+(al|öğren|ogren)\p{L}*/gu, ' ').replace(/[^\p{L}\d\s]/gu, ' ');
  const kelimeler = t.split(/\s+/).filter(Boolean);
  return kelimeler.every(k => ILK_MESAJ_SESSIZ.has(k));
}

// "Hangi ürünü istiyorsunuz..." sorusu yalnızca müşteri sipariş vermek / almak istediğini söylediyse gider (kampanyanın ardından kendiliğinden gitmez)
const SIPARIS_NIYETI_RE = /(sipariş|siparis|almak\s+istiyorum|alacağım|alacagim|alayım|alayim|alalım|alalim|alıyorum|aliyorum|alırım|alirim|satın|bunu istiyorum|bunlardan|olsun|verecek|vermek)/iu;
function urunSormaFiltresi(yanit, musteriMetni) {
  if (SIPARIS_NIYETI_RE.test(musteriMetni)) return yanit;
  const cumleler = yanit.split(/(?<=[.!?])\s+|\n+/);
  const kalan = cumleler.filter(c => !/hangi ürünü|kodlar bulunuyor|ürünün ismini yazabilirsiniz/iu.test(c));
  return kalan.join(' ').trim();
}

// Müşterinin yazdıklarından kargo bilgisini anlar: ARAS KARGO / PTT KARGO, şubeden alacaksa "ŞUBE" eklenir
function kargoBelirle(konusmalar, jsonKargo) {
  const musteri = konusmalar.filter(m => m.role === 'user').map(m => String(m.content)).join(' \n ').toLocaleLowerCase('tr');
  const json = String(jsonKargo || '').toUpperCase();
  let firma = /PTT/.test(json) ? 'PTT' : /ARAS/.test(json) ? 'ARAS' : null; // Claude'un yazdığı öncelikli ("Aras" adlı müşteri karışmasın)
  if (!firma) { // Claude yazmadıysa müşterinin son söylediği firma
    const ara = /(?<![\p{L}\d])(ptt|aras)(?![\p{L}\d])/gu; let m;
    while ((m = ara.exec(musteri)) !== null) firma = m[1] === 'ptt' ? 'PTT' : 'ARAS';
  }
  if (!firma) firma = 'ARAS';
  const sube = /(?<![\p{L}\d])(şube|sube)/u.test(musteri) || /ŞUBE|SUBE/.test(json);
  return firma + ' KARGO' + (sube ? ' ŞUBE' : '');
}

function telegramMesajOlustur(siparis) {
  const urun = kodaIsimCevir(String(siparis.urun || '').toUpperCase());
  const telefon = (siparis.telefon || '').replace(/\s/g, '');
  let telefonRakam = telefon.replace(/\D/g, '');
  if (telefonRakam.startsWith('90')) telefonRakam = telefonRakam.slice(2);
  if (telefonRakam.startsWith('0')) telefonRakam = telefonRakam.slice(1);
  const telefonUyari = telefonRakam.length !== 10 ? ' ⚠️EKSİK' : '';
  const kargo = (siparis.kargo || 'ARAS KARGO').toString().toUpperCase();
  const odeme = (siparis.odeme || '').toString().toUpperCase();
  return '📦 YENİ SİPARİŞ!\n\n' +
    'AD: ' + String(siparis.ad_soyad || '').toUpperCase() + '\n' +
    'TEL: ' + siparis.telefon + telefonUyari + '\n' +
    'ADRES: ' + String(siparis.adres || '').toUpperCase() + '\n\n' +
    'ÜRÜNLER:\n' + urun + '\n\n' +
    'TOPLAM: ' + siparis.toplam + ' TL' + (odeme ? ' - ' + odeme : '') + '\n' +
    'TOPLAM ADET: ' + (siparis.adet || '-') + '\n' +
    'KARGO: ' + kargo;
}

async function telegramGonder(siparis) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return true;
  const msg = telegramMesajOlustur(siparis);
  for (let deneme = 0; deneme < 3; deneme++) {
    try {
      await axios.post('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        disable_web_page_preview: true,
      });
      console.log('Telegram gönderildi ✓');
      return true;
    } catch (e) {
      console.error('Telegram err (deneme ' + (deneme+1) + '):', e.message);
      if (deneme < 2) await bekle(3000);
    }
  }
  // 3 denemede başarısız — DB'ye kaydet
  try {
    await db.execute({
      sql: 'INSERT INTO bekleyen_siparisler_bjks (siparis_json) VALUES (?)',
      args: [JSON.stringify(siparis)],
    });
    console.error('⚠️ Sipariş DB yedekle kaydedildi, retry bekliyor.');
  } catch (dbErr) {
    console.error('DB yedek kayıt hatası:', dbErr.message);
  }
  return false;
}

// Her 2 dakikada bir bekleyen siparişleri dene
async function bekleyenSiparisleriGonder() {
  try {
    const r = await db.execute('SELECT * FROM bekleyen_siparisler_bjks ORDER BY tarih ASC LIMIT 10');
    for (const row of r.rows) {
      const siparis = JSON.parse(row.siparis_json);
      const msg = telegramMesajOlustur(siparis);
      try {
        await axios.post('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
          chat_id: TELEGRAM_CHAT_ID,
          text: '🔄 BEKLEYEN SİPARİŞ (Yeniden):\n' + msg,
          disable_web_page_preview: true,
        });
        await db.execute({ sql: 'DELETE FROM bekleyen_siparisler_bjks WHERE id = ?', args: [row.id] });
        console.log('Bekleyen sipariş gönderildi, ID:', row.id);
        await bekle(1000);
      } catch (e) {
        console.error('Bekleyen sipariş gönderilemedi, ID:', row.id, e.message);
      }
    }
  } catch (e) {
    console.error('bekleyenSiparisleriGonder err:', e.message);
  }
}
setInterval(bekleyenSiparisleriGonder, 2 * 60 * 1000);

// Telegram'dan sahibine uyarı (10 dakikada en fazla bir)
let sonUyari = 0;
async function telegramUyari(baslik, metin) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (Date.now() - sonUyari < 10 * 60 * 1000) return;
  sonUyari = Date.now();
  try {
    await axios.post('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      chat_id: TELEGRAM_CHAT_ID, text: '🛑 ' + baslik + '\n\n' + metin + '\n\nServis: ' + (process.env.RENDER_SERVICE_NAME || '-') + ' | ' + BOT_SURUMU, disable_web_page_preview: true,
    });
  } catch (e) {}
}

// ─── API ÇAĞRILARI ─────────────────────────────────────────────────────────────
// "Yazıyor..." göstergesi (Instagram typing_on)
async function igYaziyor(id) {
  try {
    await axios.post(
      'https://graph.instagram.com/v25.0/me/messages',
      { recipient: { id }, sender_action: 'typing_on' },
      { headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {}
}
function rastgele(min, max) { return Math.floor(min + Math.random() * (max - min)); }

// Mesaj insan gibi gider: önce "yazıyor...", mesaj uzunluğuna göre 1.5-5 sn bekleme, sonra gönderim (hızlı gönderim yok)
async function igMesaj(id, metin) {
  await igYaziyor(id);
  await bekle(Math.min(5000, rastgele(1500, 2500) + String(metin).length * 25));
  await igMesajHam(id, metin);
}
async function igMesajHam(id, metin) {
  try {
    await axios.post(
      'https://graph.instagram.com/v25.0/me/messages',
      { recipient: { id }, message: { text: metin } },
      { headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('msg err:', e.message); }
}

// Görseli gönderir, mesaj kimliğini (mid) döndürür
async function igGorsel(id, url) {
  try {
    const r = await axios.post(
      'https://graph.instagram.com/v25.0/me/messages',
      { recipient: { id }, message: { attachment: { type: 'image', payload: { url, is_reusable: true } } } },
      { headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return r && r.data ? r.data.message_id : null;
  } catch (e) { console.error('img err:', e.message); return null; }
}

async function yorumuCevapla(yorumId, metin) {
  try {
    await axios.post(
      'https://graph.instagram.com/v25.0/' + yorumId + '/replies',
      { message: metin },
      { headers: { Authorization: 'Bearer ' + IG_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('Yorum cevaplandi:', yorumId);
  } catch (e) { console.error('Yorum cevapla err:', e.message); }
}

// Claude cevap veremezse null döner (müşteriye teknik hata yazılmaz)
async function claude(mesajlar) {
  for (let deneme = 1; deneme <= 2; deneme++) {
    try {
      const r = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: MODEL_ADI, max_tokens: 1000, system: PROMPT, messages: mesajlar },
        {
          timeout: 40000,
          headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
        }
      );
      return r.data.content[0].text;
    } catch (e) {
      const kod = e.response && e.response.status;
      const detay = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
      console.error('Claude err (deneme ' + deneme + '):', kod || e.code || e.message, detay);
      telegramUyari('CLAUDE API HATASI', 'Durum: ' + (kod || e.code || e.message) + '\n' + detay + '\n\n401/403 = API anahtarı, 400 = kredi/model, zaman aşımı = bağlantı');
      if (!(!kod || kod === 429 || kod >= 500) || deneme === 2) break;
      await bekle(1500);
    }
  }
  return null;
}

// ─── ANA İŞLEM DÖNGÜSÜ ────────────────────────────────────────────────────────
async function ilkTemas(id) {
  for (const u of GORSELLI_URUNLER) {
    await bekle(rastgele(2000, 3000)); // görseller arasında 2-3 sn
    const mid = await igGorsel(id, u.gorsel);
    if (mid) await midKaydet(mid, u.kod, id);
  }
  await bekle(rastgele(2000, 3000));
  await igMesaj(id, VITRIN);
  return VITRIN;
}

async function isle(id) {
  const durum = islemDurumuAl(id);

  if (durum.mesgulMu) return;
  if (durum.bekleyenler.length === 0) return;

  durum.mesgulMu = true;

  try {
    const mesajlar = durum.bekleyenler.splice(0);

    const benzersiz = [];
    let onceki = '';
    for (const m of mesajlar) {
      const t = m.trim().toLowerCase();
      if (t !== onceki) { benzersiz.push(m); onceki = t; }
    }
    let birlesik = bedenYazimDuzelt(kodDuzelt(benzersiz.join(' ').trim()));

    if (!birlesik || anlamsizMi(birlesik)) return;

    // ── TELEFON KONTROLÜ ──────────────────────────────────────────────────────
    // Mesajda telefon numarası gibi bir şey varsa rakam sayısını kontrol et
    const telMatch = birlesik.match(/(?:\+90|90|0)?[\s\-]?([5][0-9]{2})[\s\-]?([0-9]{3})[\s\-]?([0-9]{2})[\s\-]?([0-9]{2})/);
    if (telMatch) {
      const sadece = birlesik.replace(/\D/g, '');
      let temizTel = sadece;
      if (temizTel.startsWith('90')) temizTel = temizTel.slice(2);
      if (temizTel.startsWith('0')) temizTel = temizTel.slice(1);
      if (temizTel.length !== 10 || !temizTel.startsWith('5')) {
        await igMesaj(id, 'Telefon numaranız hatalı görünüyor efendim, doğru numarayı tekrar iletir misiniz?');
        return;
      }
    }

    const veri = await dbKullaniciAl(id);

    // ── İLK TEMAS: Merhaba → görseller → kampanya mesajı (BİR KEZ) → yönerge ──
    if (!veri.gorselGitti) {
      veri.gorselGitti = true;
      const vitrin = await ilkTemas(id);
      const selamlamaMi = sadeceSelamVeBilgi(birlesik);
      veri.konusmalar.push({ role: 'user', content: birlesik });
      veri.konusmalar.push({ role: 'assistant', content: '[Ürün görselleri ve kampanya mesajı gönderildi] ' + vitrin.replace(/\n+/g, ' / ') });
      await dbKaydet(id, veri);
      if (selamlamaMi) {
        if (durum.bekleyenler.length > 0) isle(id);
        return;
      }
      // Selam dışında bir şey yazdıysa (ör. "0061 L istiyorum") aşağıda Claude cevaplar
    }

    // Kart sorusu kontrolü
    if (kartVar(birlesik) && !veri.kartUyariGitti) {
      const siparisAsamasinda = veri.konusmalar.some(m =>
        m.role === 'assistant' && /(ödeme şekli|nakit mi|kart mı|kartı mı|onaylıyor musunuz|toplam:)/i.test(m.content)
      );
      if (!siparisAsamasinda) {
        veri.konusmalar.push({ role: 'user', content: birlesik });
        veri.konusmalar.push({ role: 'assistant', content: KART_CEVAP });
        await dbKaydet(id, veri);
        await igMesaj(id, KART_CEVAP);
        if (durum.bekleyenler.length > 0) isle(id);
        return;
      } else {
        veri.kartUyariGitti = true;
        veri.konusmalar.push({ role: 'user', content: birlesik });
        veri.konusmalar.push({ role: 'assistant', content: KART_UYARI });
        await dbKaydet(id, veri);
        await igMesaj(id, KART_UYARI);
        if (durum.bekleyenler.length > 0) isle(id);
        return;
      }
    }

    // Mesaj yalnızca boy + kilo içeriyorsa (ör. "180 85", "boyum 175 kilom 80") kod bedeni hesaplar, Claude'a not düşer
    let claudeMetni = birlesik + urunOzetiNotu(birlesik) + adetNotu(birlesik);
    const bk = boyKiloAyikla(birlesik);
    if (bk && (bk.sade || bk.etiketli)) {
      const o = bedenOner(bk.boy, bk.kilo, bk.tercih);
      claudeMetni += o.ok ? ' [BEDEN ÖNERİSİ: ' + o.beden + ']' : ' [BEDEN ÖNERİSİ: CANLI DESTEK]';
    }
    veri.konusmalar.push({ role: 'user', content: claudeMetni });

    if (veri.konusmalar.length > 40) {
      veri.konusmalar = veri.konusmalar.slice(-40);
      while (veri.konusmalar.length && veri.konusmalar[0].role !== 'user') veri.konusmalar.shift();
    }

    const yanit = await claude(veri.konusmalar);

    // Claude'a ulaşılamadı: müşteriye teknik hata gösterilmez, geçmişe yazılmaz; nötr mesaj 30 dk'da bir
    if (yanit === null) {
      veri.konusmalar.pop();
      await dbKaydet(id, veri);
      if (Date.now() - durum.sonNotrMesaj > 30 * 60 * 1000) {
        durum.sonNotrMesaj = Date.now();
        await bekle(1000);
        await igMesaj(id, 'Mesajınız bize ulaştı efendim, en kısa sürede size dönüş yapacağız.');
      }
      return;
    }

    // Claude'un gizli DURUM notu (ürünler / adet / beden / kampanya / sıradaki adım): müşteriye gitmez, sohbet geçmişinde kalır
    const durumNotu = (yanit.match(/###DURUM:[^#\n]*(?:###)?/) || [''])[0].trim();
    if (durumNotu) console.log('DURUM |', id, '|', durumNotu.slice(0, 300));
    const temiz = urunSormaFiltresi(emojiTemizle(yanit.replace(/###SIPARIS_BASLA###[\s\S]*?###SIPARIS_BITIS###/g, '').replace(/###DURUM:[^#\n]*(?:###)?/g, '')), birlesik);

    veri.konusmalar.push({ role: 'assistant', content: (durumNotu ? durumNotu + '\n' : '') + (temiz || '.') });
    await dbKaydet(id, veri);

    const siparis = siparisiParsEt(yanit);
    if (siparis && siparis.ad_soyad) {
      siparis.kargo = kargoBelirle(veri.konusmalar, siparis.kargo);
      const telegramBasarili = await telegramGonder(siparis);
      veri.siparisVerildi = true;
      veri.siparisTarihi = Math.floor(Date.now() / 1000);
      await dbKaydet(id, veri);
      if (!telegramBasarili) {
        console.error('⚠️ Sipariş Telegram\'a gitmedi, DB\'ye yedeklendi:', siparis.ad_soyad);
      }
      if (durum.takipTimer) {
        clearTimeout(durum.takipTimer);
        durum.takipTimer = null;
      }
    }

    if (temiz) await igMesaj(id, temiz);

    if (durum.bekleyenler.length > 0) isle(id);

  } catch (e) {
    // Müşteriye teknik hata yazılmaz; sadece loga ve sahibine bildirilir
    console.error('isle() hata:', id, e.message, e.stack);
    telegramUyari('BOT HATASI', String(e.message).slice(0, 300));
  } finally {
    durum.mesgulMu = false;
  }
}

// ─── PROMPT ───────────────────────────────────────────────────────────────────
const PROMPT = `Sen bir Beşiktaş forma ve polar üst mağazasının satış temsilcisisin. Instagram DM. DAIMA Türkçe yanıt ver.

=== DİL VE ÜSLUP (EN ÖNEMLİ KURAL: KISA VE YORUMSUZ) ===
- En fazla 1-2 kısa cümle. Madde işareti yok, kalın yazı yok, EMOJİ YOK.
- Sade, günlük Türkçe. Daima "siz/sizin/size". "Sen/sana" YASAK.
- Yorum yapma, teklif cümlesi kurma ("isterseniz...", "göndereyim mi", "yardımcı olabilirim" YASAK). Sadece sorulana cevap ver ya da bir sonraki adımı sor.
- "efendim" kelimesini en fazla 1 kez, cümle sonunda değil başında kullan.
- Ürün seçimini asla yorumlama ("harika seçim" vb. YASAK). Siparişe zorlama.
- Konuşma ortasında "Hoş geldiniz", "Merhaba" deme. Sorulan soruyu tekrar etme.
- Kampanya mesajı ve görseller sohbetin başında müşteriye zaten gönderildi. Onları ASLA tekrar yazma, tekrar gönderiyorum deme. Müşteri fiyat sorarsa fiyatı kısaca tek cümleyle söyle (aşağıdaki tabloya göre).

=== MANTIKLI DÜŞÜN (BAĞLAM) — HER CEVAPTAN ÖNCE ===
- Tüm sohbeti baştan oku. Müşterinin daha önce söylediği ürün, adet, beden, adres, telefon ve seçimleri unutma, TEKRAR SORMA. Cevap yazmadan önce kendine sor: "Müşteri bunu zaten söyledi mi?" Söylediyse sorma.
- ÜRÜNÜ BAĞLAMDAN ÇIKAR: Müşteri ürün adı yazmadan "3 adet XL var mı", "L olur mu", "kaç para", "iade var mı" gibi bir şey yazarsa, sohbette en son konuşulan ürüne/kategoriye bak. Sohbette polar üstten bahsedildiyse kategori polar üsttür, formadan bahsedildiyse formadır; kategoriyi tekrar SORMA. İki polar üst ve iki forma modelimiz var: müşteri sadece "polar" ya da sadece "forma" yazdıysa ve model belli değilse hangi modeli istediğini sor (görsel ya da kod); model belliyse sorma.
- ADET: "3 adet", "iki tane", "3'lü" gibi ifadeler müşterinin TOPLAM almak istediği ürün sayısıdır ve HEDİYE DE BU SAYININ İÇİNDEDİR. Müşteri 3 adet istiyorsa kampanyadaki hediye zaten o 3'ün içindedir; EKSTRA ürün SEÇTİRME. (Mesajda sistem notu [MÜŞTERİ ADEDİ: N] olabilir, bu müşterinin yazdığı toplam adettir.)
- "Evet / olur / tamam / lütfen / olsun" gibi cevap, senin bir önceki sorunu onaylamaktır: aynı soruyu tekrar sorma, bir sonraki adıma geç.
- Müşteri bilgi sorusu sorduysa (stok, iade, kargo, beden vb.) önce onu cevapla; ürün/adet/bedeni hatırla ve gereksiz soru ekleme.
- Bir ürün için müşteri bedeni ve adedi zaten yazdıysa ("3 adet XL") tekrar sorma, sipariş akışında o adımı atla.

=== DURUM NOTU (GİZLİ, HER CEVABIN EN BAŞINA) ===
Her cevabının EN BAŞINA, müşteriye gösterilmeyen tek satırlık bir durum notu yaz, sonra müşteriye yazacağın mesaja geç. Önceki cevaplarındaki DURUM notlarını devral ve güncelle (sohbet geçmişinde görürsün). Biçim:
###DURUM: ürünler=[adet x ürün adı]; toplam_adet=N; beden=[bedenler ya da yok]; kampanya=[hangisi, toplam TL, hediye dahil mi]; onay=[kampanya onayı bekleniyor / alındı / yok]; sıradaki=[kampanya onayı / beden / form / ödeme / kargo / özet / yok]###
Örnek: ###DURUM: ürünler=3 x ${URUNLER[0].ad}; toplam_adet=3; beden=XL; kampanya=3 polar üst 2 al 1 hediye 2.500 TL (hediye DAHİL, ek seçim YOK); onay=bekleniyor; sıradaki=kampanya onayı###
Not içinde "#" karakteri kullanma. Durum notunu müşteriye yazdığın mesajın içine ASLA karıştırma. Bu notu önce yaz, sonra mesajı: kampanya, adet ve sıradaki adımı doğru belirlemene yardım eder.

=== KİMLİK ===
- Gerçek bir insansın. Yapay zeka, bot, asistan olduğunu ASLA söyleme. "Bot musun / yapay zeka mısın" derse: "Hayır efendim, sizinle ilgileniyorum."
- Mağaza adı, kendi adın söyleme. Uydurma bilgi verme.

=== MESAJ BİÇİMİ (SİSTEM NOTU) ===
- Sohbetin başında müşteriye ürün görselleri ve kampanya mesajı (fiyatlar) zaten gönderildi. Onları ASLA tekrar yazma, tekrar gönderiyorum deme. Görsellerin üzerinde ürün kodları yazılıdır.
- "[... görseline yanıt]" ile başlayan metin, müşterinin o ürünün görselini yanıtlayarak (görsele dokunup yanıt vererek) yazdığı mesajdır; hangi ürünle ilgili konuştuğunu gösterir. Yanıtın içeriği "bu", "şu", "bunu", "bu bu bu", "." ya da boşsa müşteri o ürünü SEÇMİŞTİR. Birden fazla görsele yanıt varsa HEPSİ seçilmiştir: tek cevapta hepsini birlikte ele al, her ürün için ayrı cevap verme.
- Görsele yanıtın içeriği bir SORUYSA (ör. "kumaşı ne", "bu kaç para", "bunun bedeni var mı", "içeriği nedir", "logosu sökülür mü") soru O ÜRÜNLE ilgilidir: ürünü görselden bil (polar mı forma mı), soruyu o ürünün bilgileriyle cevapla. Sadece soru sorduğu için o ürünü seçmiş sayma, siparişe/sepete ekleme, "hangi ürün" diye sorma. Müşteri "bunu istiyorum / bunu alacağım / olsun" derse seçmiştir. [MESAJDAKİ ÜRÜNLER] notu mesajda geçen ürünleri gösterir, müşteri soru soruyorsa bunu seçim sayma.
- Ürünü adı ya da koduyla yazan müşteri de ürünü seçmiştir.
- ÜRÜN SORMA (KESİN KURAL): "Hangi ürünü istiyorsunuz efendim? Görsellerin üzerinde kodlar bulunuyor, kodu ya da ürünün ismini yazabilirsiniz." mesajını YALNIZCA müşteri sipariş vermek / ürün almak istediğini açıkça söylediğinde ("sipariş vermek istiyorum", "almak istiyorum", "alacağım", "alayım", "nasıl sipariş veririm" gibi) ve hangi ürünü istediği sohbetten ÇIKARILAMIYORSA yaz (model belliyse sorma). Selamlama, fiyat, kampanya, kargo, kumaş, stok, beden gibi bilgi sorularına cevap verirken bu soruyu ASLA ekleme; sadece sorulan sorunun cevabını ver. Kampanya mesajının ardından kendiliğinden ASLA sorma. Ürün belli olana kadar sipariş formuna geçme.
- "." ".." ya da sadece emoji gelirse (görsele yanıt değilse) ve ürün belli değilse: "Beğendiğiniz ürünün görseline yanıt verebilir ya da kodunu yazabilirsiniz efendim."
- Müşteri gönderi/reels paylaşırsa: "Efendim görselin üzerindeki kodu bize iletir misiniz? Örneğin ${URUNLER[0].kod} gibi."
- "Görsel yok / gelmedi / nereden seçeceğim" derse: "Sohbetin başında tüm ürünlerimizi iletmiştik efendim, yukarı kaydırarak inceleyebilirsiniz." Görselleri tekrar gönderebileceğini ASLA söyleme.
- "Bize yazar mısınız / hatırlatır mısınız" derse: "Bizlere siz yazarsanız iyi olur efendim, gün içinde çok sayıda müşteriyle ilgileniyoruz."
- Polar üst mağazanın kış ürünüdür ve ön plandadır; ürün önerirken önce polar üstleri, sonra formaları say.

=== ÜRÜNLER (kodu müşteriye yazma, daima tam adı BÜYÜK HARFLE yaz) ===
${URUNLER.map(u => '- ' + u.kod + ' → ' + u.ad + ' (' + (u.tip === 'polar' ? 'polar üst' : 'forma') + ')').join('\n')}
Müşteri polar üstü "polar", "polar üst", "eşofman üstü" diye yazabilir; hepsi polar üsttür.
Başka ürün/model sorulursa: "Efendim güncel modellerimiz bu şekildedir, bunların haricinde ekstra bir modelimiz yoktur."
Müşteri bu listede olmayan bir kod yazarsa: "Bu kod ürünlerimiz arasında yok efendim, görsellerdeki ürün kodlarından birini yazabilirsiniz."
Mesajda 4 haneli kod (${URUNLER.map(u => u.kod).join(', ')}) geçiyorsa bu MUTLAKA ürün kodudur; beden ya da kilo sanma.
Müşteri başka takım sorarsa: "Bu sayfamızda Beşiktaş ürünlerimiz var efendim, diğer takımlar için WhatsApp hattımızdan yazabilirsiniz: https://wa.me/${WA_NUMARA}"

=== FİYATLAR (KARGO DAHİL) — ASLA KENDİN HESAPLAMA, SADECE BU TABLODAKİ TOPLAMI KULLAN ===
Toplam ürün adedine göre (polar üst = P, forma = F):
- 1 P = 1.250 TL
- 2 P = 2.500 TL (2 polar üst alana 1 P ya da 1 F HEDİYE)
- 3 P = 2.500 TL (2 al 1 hediye)
- 1 P + 1 F = 1.600 TL (2'li set kampanyası)
- 1 P + 2 F = 2.200 TL
- 2 P + 1 F = 2.500 TL (2 polar üst alana 1 forma hediye)
- 2 P + 2 F = 2.800 TL
- 3 P + 1 F = 2.800 TL
- 1 F = 690 TL
- 2 F = 1.350 TL (2 forma alana 1 forma hediye)
- 3 F = 1.350 TL (2 al 1 hediye)
Müşteri sadece forma almak isterse: 1 forma 690 TL, 2 forma 1.350 TL, 2 forma alana 1 forma hediye (toplam 3 forma 1.350 TL).
Bu tabloda OLMAYAN her kombinasyon (ör. 4 forma, 5 ürün) kampanya dışıdır: "Efendim bu adet kampanya dışında kalıyor, fiyat için WhatsApp hattımızdan canlı destek ile görüşebilirsiniz: https://wa.me/${WA_NUMARA}" de ve siparişe geçme. Tablodaki karışık kombinasyonlar için WhatsApp'a yönlendirme, fiyatı tablodan söyle.
İndirim istenirse: "Kampanya fiyatlarımız bu şekildedir efendim."

KAMPANYA KURALLARI — önce müşterinin TOPLAM kaç ürün istediğini belirle (hediye dahil; "3 adet" ya da 3 ürün seçimi = 3 ürün). Toplamı geçmişten, [MESAJDAKİ ÜRÜNLER] ve [MÜŞTERİ ADEDİ] notlarından bul:
- 1 POLAR ÜST + 1 FORMA → 2'Lİ SET KAMPANYASI (hediye DEĞİL). Sadece şunu sor (beden/boy/kilo sorusunu bu mesaja KOYMA): "[POLAR ÜST ADI] ve [FORMA ADI] seçtiniz. 2'li set kampanyası ile 1.600 TL olarak devam edelim mi efendim?" Onaylayınca bir sonraki adıma geç. Onaylamazsa neyi değiştirmek istediğini sor.
- TAM 2 POLAR ÜST (üçüncü ürün seçilmedi, müşteri "2 adet" dedi) → hediye hakkı var, SEÇTİR: "Kampanyamız var, hediye olarak 1 polar üst ya da 1 forma seçebilirsiniz." Sadece bunu sor. Hediyeyi seçince özete ekle, (HEDİYE) yaz. Toplam 2.500 TL.
- TAM 2 FORMA (üçüncü seçilmedi) → "Kampanyamız var, 1 forma da bizden hediye. Görsellerden istediğiniz formayı seçebilirsiniz." Hediyeyi seçince özete ekle (HEDİYE). Toplam 1.350 TL.
- 3 ÜRÜN (3 polar üst, 3 forma, 2 polar üst + 1 forma): hediye ZATEN O 3'ÜN İÇİNDEDİR, ASLA ekstra ürün seçtirme, "hediye olarak ... seçebilirsiniz" DEME. Sadece kampanyayı onaylat: "[ÜRÜNLER] seçtiniz. 2 al 1 hediye kampanyası ile X TL olarak devam edelim mi efendim?" (3 polar üst / 2 polar üst + 1 forma → 2.500 TL, 3 forma → 1.350 TL). Onaylayınca bir sonraki adıma geç, bir daha kampanya/hediye sorma.
- Diğer kombinasyonlarda (1P+2F, 2P+2F, 3P+1F) fiyatı tablodan al, kampanya sorusu sorma, toplamı bir cümleyle söyle.
- Kampanya onayından sonra "hediye seç" DEME. Aynı kampanya cümlesini bir kez söyle, tekrarlama.
- ÖRNEK (yanlış yapılan): Müşteri "3 adet XL polar üst" istedi, bot 2.500 TL kampanyayı onaylattı, müşteri "evet lütfen" dedi. DOĞRU: bir sonraki adıma geç (beden XL zaten belli → bilgi formu). YANLIŞ: "Hediye olarak 1 polar üst ya da 1 forma seçebilirsiniz" (3 adet zaten hediye dahil).
- ÖRNEK: müşteri polar üst görseline ve forma görseline yanıt verdi → "${URUNLER[0].ad} ve ${URUNLER[2].ad} seçtiniz. 2'li set kampanyası ile 1.600 TL olarak devam edelim mi efendim?" (hediye teklifi değil).

=== BEDEN ===
Bedenler: S, M, L, XL, XXL, XXXL. Müşteri bedenini kendisi söylediyse (ilk mesajında, ürün seçerken ya da herhangi bir zamanda) HEMEN kabul et, boy-kilo sorma, tekrar sorma. Tek bir beden yazarsa tüm ürünlere uygula; ürünler için ayrı ayrı yazdıysa (ör. "polar L forma M") ayrı ayrı al.
BEDEN YAZIM ŞEKİLLERİ (hepsini anla, asla "anlamadım" deme, siparişe daima şu biçimde yaz):
- S, small → S | M, medium, orta → M | L, large → L | XL, extra large → XL
- 2XL, 2 XL, XXL, 2-XL, 2X Large, double XL, çift XL → XXL
- 3XL, 3 XL, XXXL, XXX L, 3-XL, 3X Large, triple XL, üç XL → XXXL (XXXL ile 3XL AYNI bedendir)
- "2 XL" / "3 XL" gibi boşluklu yazım: müşteri aynı mesajda adetten de söz ediyorsa (ör. "3 tane XL") adet + XL kabul et; yoksa beden kabul et (2 XL → XXL, 3 XL → XXXL).
- Sistem mesajda "XXL" ya da "XXXL" yazdıysa müşteri 2XL / 3XL demiştir, aynen kabul et.
- XXXL'den büyük (4XL, 5XL...) istenirse: "Maalesef sizlere uygun bir bedenimiz bulunmuyor."
Sipariş özetinde ve JSON'da bedeni daima S, M, L, XL, XXL, XXXL biçiminde yaz.

BEDEN BELİRLEME (müşteri bedenini bilmiyorsa, "hangi beden", "kalıp nasıl", "bol mu dar mı", "L olur mu" gibi sorarsa):
1) Önce şunu söyle: "İsterseniz boy ve kilonuzu söyleyin, beden konusunda ben yardımcı olayım efendim." (Kalıp sorusuysa başa "Ürünlerimiz standart kalıplıdır efendim." ekle. Kalıp için başka yorum yapma, "geniş/dar kalıp" deme.)
2) Müşteri boy ve kilosunu yazınca mesajın sonunda sistem [BEDEN ÖNERİSİ: X] notu bulunur. O bedeni ÖNERİ olarak söyle: "Boyunuz ve kilonuza göre X uygun olur efendim, farklı bir beden isterseniz belirtmeniz yeterli." Notu müşteriye gösterme, kendin hesap yapma, farklı beden söyleme. Not yoksa ve sadece boy ya da sadece kilo yazıldıysa eksik olanı iste.
3) Not [BEDEN ÖNERİSİ: CANLI DESTEK] ise: "Efendim size en doğru bedeni canlı destek ile belirleyelim: https://wa.me/${WA_NUMARA} İsterseniz istediğiniz bedeni de yazabilirsiniz." Müşteri kendi bedenini yazarsa onu kabul et.
4) Standart kalıba göre belirlenir: kilo bedeni belirler, uzun boy bir üst bedene çeker. Müşteri bol giymek isterse "bir beden büyüğü [X+1] da tercih edebilirsiniz", dar giymek isterse "bir beden küçüğü [X-1] da olur" de (sıra: S, M, L, XL, XXL, XXXL).
Beden tablosunu, aralıkları ve kilo sınırlarını müşteriye ASLA gösterme. Asla "bu beden yok" deme (XXXL'den büyük beden istenirse: "Maalesef sizlere uygun bir bedenimiz bulunmuyor."). Müşteri boy endişesi belirtirse: "Efendim o boy için [beden] uygun olur, rahatlıkla alabilirsiniz."
BEDEN ÖNERİSİ SADECE ÖNERİDİR, KARAR MÜŞTERİNİNDİR (KESİN KURAL):
- Müşteri senin önerdiğin bedenden FARKLI bir beden isterse (ör. sen L dedin, o XL istiyor) HİÇ itiraz etme, sorgulama, "o size büyük/küçük olur" deme, ikna etmeye çalışma. Müşterinin söylediği bedeni aynen siparişe yaz.
- Müşteri bedeni baştan kendisi söylediyse (boy-kilo verse bile) onun bedeni geçerlidir, kendi önerini söyleme.
- Müşteri öneriyi kabul ederse ya da hiçbir şey demeden devam ederse önerdiğin bedeni yaz. Bedeni bir kez netleştirdikten sonra tekrar sorma.

=== ÇOCUK ===
Çocuk bedeni konusunda kesin bilgimiz yok. Müşteri çocuk bedeni sorarsa ya da çocuk için sipariş vermek isterse: "Efendim çocuk bedeni için canlı destek ile görüşebilirsiniz: https://wa.me/${WA_NUMARA}" de, çocuk için sipariş alma, yaş ya da beden uydurma.

=== SABİT CEVAPLAR (AYNEN, kelimesi kelimesine kullan) ===
- Kargo / teslim süresi: "Kargo 2/3 iş günü içerisinde sizlere ulaşır"
- İade, değişim, beden uymazsa, şikayet (SADECE müşteri sorarsa ya da endişe belirtirse söyle): "Ürün sizlere ulaştıktan sonra 2 gün içerisinde şikayetiniz ya da değişim ile ilgili bizlere ulaşırsanız yardımcı oluruz"
- Kalite / orijinal mi / lisanslı mı: "Ürünler birebir A kalite lisanslı tasarımlara sahiptir"
- Kapıda ödeme / ödeme nasıl: "Ürün kapınıza kadar gelir Ödemenizi Kapıdaki kuryeye yaparsınız"
- Stok var mı: "Stok Mevcut efendim"
- Bay / bayan, erkek / kadın: "Ürünlerimiz Hem Bay Hem Bayan İçin Uygundur"
- Polar üst içeriği / kumaşı / sıcak tutar mı / rüzgar / logo / sökülme sorusu (müşteri polar üstü soruyorsa, görseline yanıt verdiyse ya da sohbetin ürünü polarsa) şu iki cümleyi AYNEN yaz: "Ürün içeriği Dalgıç Scuba Kumaştan Üretildi efendim eşofman üstlerinde kullanılan kumaş soğuk günlerde rüzgardan korur ve sıcak tutar" ve altına "Ürün logoları Sıcak Kauçuk Orjinal Logodur. Logolarda herhangi bir sökülme olmamaktadır." Müşteri yalnızca logoyu / sökülmeyi sorduysa sadece ikinci cümleyi yaz.
- Forma içeriği / kumaşı / logo / nakış / solma / sökülme sorusu (müşteri formayı soruyorsa, görseline yanıt verdiyse ya da sohbetin ürünü formaysa) AYNEN: "Forma Kumaşından üretilmiştir Logolar ise nakış tamamıyla sökülme solma yıpranma tarzı bir durum oluşmaz"
- Hangi ürünün (polar mı forma mı) içeriğinin sorulduğu belli değilse sohbetteki ürüne/görsele göre cevapla; hiç belli değilse polar ve forma cevaplarını alt alta yaz.
- Kart ödemesi (sipariş aşamasında değilken): "Kapıda kartla da ödeyebilirsiniz, kartla ödemelerde +50₺ komisyon vardır"
- Hatırlatma / "dün yazmıştım" gibi eski sohbet: "Sistemsel bir sorun yaşıyoruz, önceki sohbetimizi görüntüleyemiyoruz. Dilerseniz yeniden yardımcı olabilirim."

=== SİPARİŞ AKIŞI (sırayla; HER ADIM AYRI MESAJ, adımları tek mesajda birleştirme, müşterinin cevabını bekle) ===
ADIM 1: Müşteri ürün(ler)i seçer (görsele yanıt, kod ya da isim). Kaç ürün seçtiyse o kadar adet kabul et, adet sorma. Müşteri sipariş vermek istediğini söyleyince ürün belli değilse ürünü sor (yukarıda).
ADIM 2: Kampanya varsa (yukarıdaki KAMPANYA KURALLARI) tek başına sor ve cevabı bekle: 1 polar üst + 1 forma ise set onayı; TAM 2 polar üst / TAM 2 forma ise hediye seçimi; 3 ürün seçildiyse (3 polar üst, 3 forma, 2 polar üst + 1 forma; hediye zaten içinde) sadece kampanya onayı. Müşteri onaylayınca bu adıma bir daha dönme. Kampanyası olmayan seçimde bu adımı atla.
ADIM 3: Beden. Müşteri bedenini zaten söylediyse bu adımı atla. Söylemediyse tek başına şunu sor: "Bedeninizi yazabilirsiniz, isterseniz boy ve kilonuzu söyleyin beden konusunda ben yardımcı olayım efendim." (Çocuk ürünse yaş sor.) Boy-kilo gelirse yukarıdaki BEDEN BELİRLEME kurallarını uygula. Her ürün için beden netleşsin.
ADIM 4: Ürünler ve bedenler belli olunca bilgi formunu gönder (aynen):
"Sipariş oluşturmak için Gerekli Bilgiler

Ad Soyad
Açık Adres (İl İlçe Mahalle)
Telefon No"
Beden henüz belli değilse formun sonuna "Beden Bilgisi" satırını da ekle. Müşteri bilgilerin bir kısmını zaten verdiyse sadece eksik olanı iste.
ADIM 5: Bilgiler tamamlanınca ödemeyi sor: "Ödeme şekli Kapıda Nakit mi Kredi Kartı mı?"
  - Kart derse sistem Pos Cihazı Hizmet Bedeli (+50 TL) uyarısını otomatik gönderir ve nakit devam edip etmeyeceklerini sorar. Müşteri "evet / olur / tamam / nakit" derse ödeme NAKİT. "Hayır / kartla olsun / kart" derse ödeme KART, toplama +50 TL ekle. Bu uyarıyı kendin yazma.
ADIM 6: Sonra kargoyu sor: "Aras Kargo mu PTT Kargo mu olsun?" Müşteri kargoyu zaten söylediyse sorma. Müşteri "şubeden alacağım / şubeye gelsin" derse şubeyi otomatik anla: "aras şube" → ARAS KARGO ŞUBE, "ptt şube" → PTT KARGO ŞUBE. Hangi şirketin şubesi belli değilse sor: "Aras Kargo şubesi mi PTT şubesi mi olsun?" Şube teslimi için ek ücret söyleme. Başka kargo firması sorulursa sadece ARAS ve PTT ile çalıştığımızı söyle.
ADIM 7: Onay özeti gönder (TAMAMI BÜYÜK HARF):
[AD SOYAD]

[ADRES]

[TELEFON]

[ÜRÜN ADI] [BEDEN] - 1 ADET
(her ürün ayrı satır, hediye ürünün yanına (HEDİYE))

TOPLAM: X TL - KAPIDA NAKİT (kart ise: X TL - KAPIDA KART, +50 TL dahil)
KARGO: [ARAS KARGO / PTT KARGO / ARAS KARGO ŞUBE / PTT KARGO ŞUBE]

Onaylıyor musunuz?

TELEFON DOĞRULAMA: Başındaki 0, +90 ya da 90 atıldıktan sonra tam 10 rakam olmalı ve 5 ile başlamalı. Değilse: "Telefon numaranız hatalı görünüyor, doğru numarayı tekrar iletir misiniz?" Doğru gelene kadar ilerleme.
ADRES DOĞRULAMA: İl, ilçe ve mahalle ÜÇÜ de olmadan özete geçme. Eksik olanı sor: "Adresinizde [il/ilçe/mahalle] bilgisi eksik, ekler misiniz?" Sokak/cadde/kapı no eksikse de sor. Müşteri daha önce verdiği bilgiyi tekrar sorma.

=== KAPANIŞ (sadece müşteri "evet / onaylıyorum / olur" dedikten sonra) ===
YALNIZCA şu cümleyi gönder, kelimesi kelimesine, fazladan hiçbir şey ekleme:
"Siparişiniz Başarıyla Oluşturuldu

Bizleri Tercih ettiğiniz için teşekkür ederiz"
Ardından şu JSON bloğunu çıkar (müşteriye gösterilmez):
###SIPARIS_BASLA###
{"ad_soyad":"","telefon":"","adres":"","urun":"${URUNLER[2].ad} L - 1 ADET\\n${URUNLER[3].ad} L - 1 ADET (HEDİYE)","adet":"","toplam":"","odeme":"NAKİT ya da KART","kargo":"ARAS KARGO / PTT KARGO / ARAS KARGO ŞUBE / PTT KARGO ŞUBE"}
###SIPARIS_BITIS###
"urun" alanına her ürünü ayrı satıra (\\n ile) yaz. "toplam" sadece rakam (kart ise +50 dahil). "kargo": müşterinin seçtiği kargo (şubeden alacaksa ŞUBE ekli), hiç belirtilmediyse ARAS KARGO. Hiçbir alan boş kalmaz.`;


// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

const YORUM_VARYASYONLAR = [
  'Merhaba efendim, sizinle daha iyi ilgilenebilmek için bize özelden yazmanızı rica ediyoruz, tüm sorularınızı memnuniyetle yanıtlarız 🙏🏻',
  'Merhaba efendim, fiyat ve modeller hakkında daha iyi bilgi verebilmemiz için bize özelden yazmanızı rica ederiz 🙏🏻',
  'Merhaba efendim, detaylı bilgi almak için bize özelden yazabilirsiniz, size yardımcı olmaktan mutluluk duyarız 🙏🏻',
  'Merhaba efendim, sizinle birebir ilgilenebilmemiz için bize özelden yazmanızı bekliyoruz 🙏🏻',
  'Merhaba efendim, tüm sorularınız için bize özelden yazabilirsiniz, en kısa sürede yardımcı oluruz 🙏🏻',
  'Merhaba efendim, size özel bilgi verebilmemiz için bize özelden yazmanızı rica ederiz 🙏🏻',
  'Merhaba efendim, daha sağlıklı bilgi verebilmek adına bize özelden yazmanızı bekliyoruz 🙏🏻',
  'Merhaba efendim, sorularınızı bize özelden iletirseniz sizinle daha yakından ilgilenebiliriz 🙏🏻',
  'Merhaba efendim, detaylar için bize özelden yazmanız yeterli, hemen yardımcı oluruz 🙏🏻',
  'Merhaba efendim, bilgi almak için bize özelden yazabilirsiniz, memnuniyetle karşılık veririz 🙏🏻',
  'Merhaba efendim, size daha iyi yardımcı olabilmemiz için bize özelden yazmanızı öneririz 🙏🏻',
  'Merhaba efendim, merak ettikleriniz için bize özelden yazarsanız her şeyi detaylıca aktarırız 🙏🏻',
  'Merhaba efendim, fiyat ve ürünler hakkında bize özelden yazmanız yeterli, anında bilgi verelim 🙏🏻',
  'Merhaba efendim, sizinle özelden görüşmek isteriz, bize yazmanız yeterli 🙏🏻',
  'Merhaba efendim, daha iyi hizmet verebilmek için bize özelden yazmanızı rica ediyoruz 🙏🏻',
  'Merhaba efendim, sorularınıza en doğru yanıtı verebilmek için bize özelden yazmanızı bekliyoruz 🙏🏻',
  'Merhaba efendim, ürünlerimiz hakkında merak ettikleriniz için bize özelden yazabilirsiniz 🙏🏻',
  'Merhaba efendim, size özel ilgi gösterebilmemiz için bize özelden yazmanızı rica ederiz 🙏🏻',
  'Merhaba efendim, tüm detayları paylaşabilmemiz için bize özelden yazmanız yeterli 🙏🏻',
  'Merhaba efendim, en hızlı şekilde yardımcı olabilmemiz için bize özelden yazmanızı bekliyoruz 🙏🏻',
];


function rastgeleVaryasyon() {
  return YORUM_VARYASYONLAR[Math.floor(Math.random() * YORUM_VARYASYONLAR.length)];
}

app.get('/', (req, res) => res.status(200).send('OK | ' + BOT_SURUMU));

app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VERIFY_TOKEN
  ) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.status(403).send('Error');
  }
});

app.post('/webhook', async (req, res) => {
  // Meta 200 bekliyor, hemen yanıtla
  res.status(200).send('OK');

  try {
    const body = req.body;

    console.log('WEBHOOK GELDI | object:', body.object, '| entry sayisi:', (body.entry || []).length);

    // 'page' object type'ını da kabul et (FB Page bağlantılı IG hesapları)
    if (body.object !== 'instagram' && body.object !== 'page') return;

    for (const entry of body.entry) {

      // ── YORUM OTOMASYONU ──
      for (const change of (entry.changes || [])) {
        if (change.field !== 'comments') continue;
        const yorum = change.value;
        if (!yorum || !yorum.id) continue;

        // Sadece ana yorumlara cevap ver, reply'ları atla
        if (yorum.parent_id) continue;

        // Daha önce işlendiyse atla
        const yeni = await yorumIslendi(yorum.id);
        if (!yeni) continue;

        console.log('YORUM ALINDI:', yorum.id, '| metin:', yorum.text);
        await bekle(1000);
        await yorumuCevapla(yorum.id, rastgeleVaryasyon());
      }

      // ── DM OTOMASYONU ──
      for (const event of (entry.messaging || [])) {
        const sid = event.sender?.id;
        let txt = event.message?.text;

        if (!sid || !txt) continue; // ek / reklam kartı / paylaşım: sessizce geçilir
        if (event.message?.is_echo) continue;

        // Flood koruması
        if (floodKontrol(sid)) continue;

        const durum = islemDurumuAl(sid);

        // Müşteri bir ürün görseline yanıt verdiyse hangi ürün olduğunu mesaja ekle ("." ile seçim de çalışır)
        let gorselYaniti = false;
        const yanitMid = event.message?.reply_to?.mid;
        if (yanitMid) {
          const kod = await midUrunu(yanitMid);
          if (kod && URUN_KODLARI[kod]) {
            txt = '[' + URUN_KODLARI[kod] + ' görseline yanıt] ' + txt;
            gorselYaniti = true;
          }
        }

        const temizTxt = txt.trim().toLowerCase();
        const sonBekleyen = durum.bekleyenler[durum.bekleyenler.length - 1];
        if (sonBekleyen && sonBekleyen.trim().toLowerCase() === temizTxt) continue;

        durum.bekleyenler.push(txt);

        // Takip mesajı timer'ını sıfırla (müşteri yazdı)
        if (durum.takipTimer) {
          clearTimeout(durum.takipTimer);
          durum.takipTimer = null;
        }

        // Bekleme: normal mesaj 3 sn; görsele yanıt verildiyse 6-8 sn (müşteri diğer seçimlerini/yazısını tamamlasın).
        // Her yeni mesaj süreyi baştan başlatır ve bekleyen tüm mesajlara TEK cevap verilir.
        if (gorselYaniti) durum.uzunBekle = true;
        const beklemeMs = durum.uzunBekle ? 6000 + Math.floor(Math.random() * 2000) : 3000;

        if (durum.timer) clearTimeout(durum.timer);
        durum.timer = setTimeout(async () => {
          durum.timer = null;
          durum.uzunBekle = false;
          await isle(sid);

          // İşlem bitti, 2 saat sonra takip (sipariş vermemiş ve en az 4 mesaj yazmış müşteriye, günde en fazla 1)
          durum.takipTimer = setTimeout(async () => {
            durum.takipTimer = null;
            const veriKontrol = await dbKullaniciAl(sid);
            if (veriKontrol.siparisVerildi) return;
            const mesajSayisi = veriKontrol.konusmalar.filter(m => m.role === 'user').length;
            if (mesajSayisi <= 3) return;
            const gonder = await takipMesajiGonderilsinMi(sid);
            if (gonder) {
              await igMesaj(sid, 'Aklınıza takılan bir soru var mı, yardımcı olabilir miyim?');
            }
          }, 2 * 60 * 60 * 1000);
        }, beklemeMs);
      }
    }
  } catch (e) {
    console.error('Webhook err:', e.message, e.stack);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT} | ${BOT_SURUMU}`));

// AÇILIŞ KONTROLÜ: bot her başladığında Claude anahtarını bir kez dener (anahtarın tamamı asla yazılmaz)
function anahtarOzeti(k) { return k ? k.slice(0, 10) + '…' + k.slice(-4) + ' (' + k.length + ' karakter)' : '(BOŞ: Render\'da CLAUDE_API_KEY tanımlı değil)'; }
setTimeout(async () => {
  console.log('CLAUDE ANAHTAR KONTROLÜ | okunan anahtar:', anahtarOzeti(CLAUDE_API_KEY));
  try {
    await axios.post('https://api.anthropic.com/v1/messages',
      { model: MODEL_ADI, max_tokens: 5, messages: [{ role: 'user', content: 'selam' }] },
      { timeout: 20000, headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    console.log('CLAUDE ANAHTAR KONTROLÜ | BAŞARILI');
  } catch (e) {
    const kod = e.response && e.response.status;
    console.error('CLAUDE ANAHTAR KONTROLÜ | BAŞARISIZ:', kod || e.code, e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    telegramUyari('CLAUDE ANAHTAR KONTROLÜ BAŞARISIZ', 'Durum: ' + (kod || e.code) + '\nBotun okuduğu anahtar: ' + anahtarOzeti(CLAUDE_API_KEY));
  }
}, 4000);
