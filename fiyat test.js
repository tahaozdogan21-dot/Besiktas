// Kullanım: index.js ve siparis.html ile AYNI klasörde:  node fiyat_test.js
// Herhangi bir satır FAIL derse reklam vermeden önce düzeltin.
const fs = require('fs');
let fail = 0, ok = 0;
const check = (ad, cond, detay) => { if (cond) ok++; else { fail++; console.log('FAIL:', ad, detay !== undefined ? '→ ' + JSON.stringify(detay) : ''); } };

const bot = fs.readFileSync(__dirname + '/index.js', 'utf8');
const html = fs.readFileSync(__dirname + '/siparis.html', 'utf8');
const blok = (src, bas, bit) => { const a = src.indexOf(bas); if (a < 0) return null; const b = src.indexOf(bit, a + bas.length); return b < 0 ? null : src.slice(a, b + bit.length); };
const norm = t => t.replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean).join('\n');

// 1) Bot ve sipariş sayfasının fiyat motoru BİREBİR aynı mı?
const M = '// >>> FIYAT_MOTORU_BASLA', ME = '// <<< FIYAT_MOTORU_BITIS';
const botMotor = blok(bot, M, ME), htmlMotor = blok(html, M, ME);
check('bot fiyat motoru bloğu var', !!botMotor);
check('siparis.html fiyat motoru bloğu var', !!htmlMotor);
check('BOT ve SİPARİŞ SAYFASI FİYAT KODU BİREBİR AYNI', botMotor && htmlMotor && norm(botMotor) === norm(htmlMotor));
if (!botMotor) process.exit(1);

// 2) Motoru çalıştır
const motor = new Function(botMotor.replace(/^\/\/.*$/gm, '') + '\nreturn { fiyatHesapla, FIYAT_SURUMU, POS_BEDELI };')();
const fh = motor.fiyatHesapla;
const T = (e, f) => { const r = fh(e, f); return r.ok ? r.toplam : null; };

// 3) Sizin verdiğiniz fiyatlar (ALTIN LİSTE)
const altin = [
  [0, 1, 690, '1 forma'], [0, 2, 1350, '2 forma'], [0, 3, 1350, '2 forma alana 3. forma hediye'],
  [1, 0, 1250, '1 eşofman'], [2, 0, 2500, '2 eşofman'],
  [3, 0, 2500, '2 eşofman alana 3. eşofman bedava'],
  [2, 1, 2500, '2 eşofman alana 1 forma hediye'],
  [1, 1, 1940, '1 eşofman + 1 forma (hediye yok)'],
  [1, 2, 2200, '1 eşofman + 2 forma = 2.200'],
];
altin.forEach(([e, f, beklenen, ad]) => check('ALTIN: ' + ad, T(e, f) === beklenen, { e, f, sonuc: T(e, f), beklenen }));

// 3b) KAMPANYA DIŞI: toplam 4 ve üzeri adet fiyatlanmaz (doğrudan canlı destek)
[[0, 4], [4, 0], [2, 2], [1, 3], [3, 1], [2, 3], [3, 3], [4, 4], [0, 5], [5, 0]].forEach(([e, f]) => check(`4+ adet reddedilir: ${e} eşofman + ${f} forma`, !fh(e, f).ok));
// 4) Sınırlar
check('5 eşofman kabul edilmez', !fh(5, 0).ok);
check('5 forma kabul edilmez', !fh(0, 5).ok);
check('negatif kabul edilmez', !fh(-1, 1).ok);
check('ondalık kabul edilmez', !fh(1.5, 1).ok);
check('0 ürün = 0 TL', T(0, 0) === 0);

// 5) Tüm kombinasyonlar için mantık kontrolleri
for (let e = 0; e <= 4; e++) for (let f = 0; f <= 4; f++) {
  const t = T(e, f);
  if (e + f > 3) { check(`(${e}e,${f}f) toplam 4+ adet → fiyat YOK`, t === null); continue; }
  check(`(${e}e,${f}f) hesaplanıyor`, t !== null);
  const liste = e * 1250 + f * 690;
  check(`(${e}e,${f}f) liste fiyatından pahalı olamaz`, t <= liste, { t, liste });
  if (T(e, f + 1) !== null) check(`(${e}e,${f}f→${f + 1}f) forma eklemek fiyatı düşürmemeli`, T(e, f + 1) >= t, [t, T(e, f + 1)]);
  if (T(e, f + 1) !== null) check(`(${e}e,${f}f→${f + 1}f) tek forma 690'dan fazla eklememeli`, T(e, f + 1) - t <= 690, [t, T(e, f + 1)]);
  if (T(e + 1, f) !== null) check(`(${e}e→${e + 1}e,${f}f) eşofman eklemek fiyatı düşürmemeli`, T(e + 1, f) >= t, [t, T(e + 1, f)]);
  check(`(${e}e,${f}f) toplam tam sayı`, Number.isInteger(t), t);
}

// 6) SOHBET KORUMASI (bot'taki gerçek kod)
const K = '// >>> FIYAT_KORUMA_BASLA', KE = '// <<< FIYAT_KORUMA_BITIS';
const korumaKod = blok(bot, K, KE);
check('koruma bloğu var', !!korumaKod);
const urunKodlari = (bot.match(/\{ kod: '(\d{4})', tip: '(\w+)',\s+ad: '([^']+)'/g) || []).map(x => x.match(/kod: '(\d{4})', tip: '(\w+)'/));
const URUN_KODLARI = {}, URUN_TIPLERI = {};
urunKodlari.forEach(m => { URUN_KODLARI[m[1]] = 1; URUN_TIPLERI[m[1]] = m[2]; });
const kalemAdetKod = blok(bot, 'function kalemAdetleri', '\n}\n');
const G = new Function('URUN_KODLARI', 'URUN_TIPLERI', botMotor.replace(/^\/\/.*$/gm, '') + '\n' + kalemAdetKod + '\n' + korumaKod.replace(/^\/\/.*$/gm, '') + '\nreturn { fiyatKoruma, sepetCikar, tutarlariBul };')(URUN_KODLARI, URUN_TIPLERI);

const kor = (metin) => { const sepet = G.sepetCikar(metin); const baz = metin.replace(/###[A-Z_]+:[^#]*###/g, '').trim(); return G.fiyatKoruma(baz, sepet); };
const korumaKodDis = blok(bot, '// >>> FIYAT_KORUMA_BASLA', '// <<< FIYAT_KORUMA_BITIS');
const URUN_TIPLERI_TEST = {};
(bot.match(/\{ kod: '(\d{4})', tip: '(\w+)'/g) || []).forEach(x => { const m = x.match(/kod: '(\d{4})', tip: '(\w+)'/); URUN_TIPLERI_TEST[m[1]] = m[2]; });
const KT = blok(bot, '// >>> KAMPANYA_TALIMATI_BASLA', '// <<< KAMPANYA_TALIMATI_BITIS');
check('kampanya talimatı bloğu var', !!KT);
const KTF = new Function('URUN_TIPLERI', botMotor.replace(/^\/\/.*$/gm, '') + '\n' + korumaKodDis.replace(/^\/\/.*$/gm, '') + '\nfunction sil(){}\n' + KT.replace(/^\/\/.*$/gm, '') + '\nreturn { kampanyaTalimati, kampanyaKoruma };')(URUN_TIPLERI_TEST);
const kampanyaTalimati = KTF.kampanyaTalimati, kampanyaKoruma = KTF.kampanyaKoruma;
let kt;
kt = kampanyaTalimati(1, 1); check('1 eşofman + 1 forma → kampanya cümlesi YOK', kt.metin === '' && !kt.kart && !kt.zorunlu, kt);
kt = kampanyaTalimati(1, 0); check('1 eşofman → 2 eşofman alana hediye teklifi + eşofman kartları (zorunlu DEĞİL, sadece teklif)', /2 eşofman üstü alana 1 hediye/.test(kt.metin) && kt.kart === 'esofman' && !kt.zorunlu, kt);
kt = kampanyaTalimati(2, 0); check('2 eşofman → hediye SEÇİM kutusu, SEÇMEK ZORUNLU', /forma ya da eşofman üstü/.test(kt.metin) && kt.kart === 'secim' && kt.zorunlu, kt);
kt = kampanyaTalimati(2, 1); check('2 eşofman + 1 forma → hediye seçildi, tamam', kt.kart === null && !kt.zorunlu && /tamam/.test(kt.metin), kt);
kt = kampanyaTalimati(3, 0); check('3 eşofman (3. hediye seçildi) → tamam', kt.kart === null && !kt.zorunlu, kt);
kt = kampanyaTalimati(0, 2); check('2 forma → 3. forma hediye + forma kartları (eşofman DEĞİL), SEÇMEK ZORUNLU', /üçüncüsü bizden hediye/.test(kt.metin) && kt.kart === 'forma' && kt.zorunlu, kt);
kt = kampanyaTalimati(0, 1); check('sadece 1 forma → cümle yok', kt.metin === '' && !kt.kart, kt);
kt = kampanyaTalimati(0, 3); check('3 forma → tamam', kt.kart === null && !kt.zorunlu && /tamam/.test(kt.metin), kt);
kt = kampanyaTalimati(1, 2); check('1 eşofman + 2 forma → kampanya cümlesi yok (4. ürüne itmez)', kt.metin === '' && !kt.kart, kt);
[[2, 2], [4, 0], [0, 4], [1, 3], [5, 0]].forEach(([e, f]) => { kt = kampanyaTalimati(e, f); check(`${e} eşofman + ${f} forma → SORUSUZ canlı destek`, /WHATSAPP/.test(kt.metin) && /soru sorma/.test(kt.metin) && !kt.kart, kt); });
for (let e = 0; e <= 3; e++) for (let f = 0; f <= 3; f++) { const x = kampanyaTalimati(e, f); check(`talimat (${e}e,${f}f) 350/600/625 rakamı içermez`, !/350|600|625/.test(x.metin), x.metin); }
// Kampanya cümlesi koruması (ekran görüntüsündeki hata): 1 eşofman + 1 forma iken Claude "2 eşofman alana hediye" derse
// Kampanya cümlesi koruması: sepetle uyuşmayan hediye cümlesi silinir, doğrusu konur
const sepetE1 = [{ kod: '0201' }];
let kk = kampanyaKoruma('Evet. 2 forma alana 3. forma hediye. Seçiniz.', sepetE1);
check('1 eşofman sepetinde yanlış "2 forma alana hediye" cümlesi silinir, doğrusu konur', !/2 forma alana/.test(kk.metin) && /2 eşofman üstü alana 1 hediye/.test(kk.metin) && kk.mudahale, kk.metin);
kk = kampanyaKoruma('Siparişiniz hazır, hediye dahil.', [{ kod: '0201' }, { kod: '0202' }, { kod: '0101' }]);
check('Tamamlanmış sepette hediye cümlesi silinir (hesap gizli)', !/hediye/i.test(kk.metin), kk.metin);
kk = kampanyaKoruma('1. BJK SİYAH EŞOFMAN L\n2. BEŞİKTAŞ SİYAH FORMA L (HEDİYE)', [{ kod: '0201' }, { kod: '0202' }, { kod: '0102' }]);
check('"(HEDİYE)" özet satırı korunur', /\(HEDİYE\)/.test(kk.metin) && !kk.mudahale, kk.metin);
kk = kampanyaKoruma('Bir forma daha seçerseniz üçüncüsü bizden hediye.', [{ kod: '0101' }, { kod: '0102' }]);
check('Doğru cümle bozulmaz (2 forma)', /üçüncüsü bizden hediye/.test(kk.metin) && !kk.mudahale, kk);
kk = kampanyaKoruma('2 eşofman üstü alana 1 forma hediye.', []);
check('Sepet boşsa (yazıyla sipariş) dokunulmaz', kk.metin.includes('hediye') && !kk.mudahale, kk);
kk = kampanyaKoruma('2 eşofman üstü alana 1 hediye. Seçiniz.', [{ kod: '0201' }, { kod: '0202' }]);
check('2 eşofman → doğru hediye cümlesi kalır', /2 eşofman üstü alana 1 hediye/.test(kk.metin), kk.metin);
kk = kampanyaKoruma('2 eşofman alana hediye eşofman olur.', [{ kod: '0101' }, { kod: '0102' }]);
check('2 FORMA sepetinde "eşofman hediye" iddiası silinir (forma kampanyasında eşofman hediye OLMAZ)', !/eşofman/.test(kk.metin) && /üçüncüsü bizden hediye/.test(kk.metin), kk.metin);
kk = kampanyaKoruma('Hediyeyi istemiyorsanız sorun değil.', [{ kod: '0201' }, { kod: '0202' }], true);
check('Müşteri hediyeyi reddettiyse kampanya cümlesi tekrar eklenmez', kk.metin === 'Hediyeyi istemiyorsanız sorun değil.' && !kk.mudahale, kk);
let r;
r = kor('Toplam 2.600 TL olur. ###SEPET:0201:1,0101:2###');
check('1 eşofman + 2 forma: yanlış 2.600 silinir, doğrusu 2.200', /Toplam tutar: 2\.200 TL/.test(r.metin) && !/2\.600/.test(r.metin), r.metin);
r = kor('2 eşofman ve 1 forma toplam 2.850 TL olacak. ###SEPET:0201:1,0202:1,0101:1###');
check('YANLIŞ toplam silinip doğrusu yazılır', /Toplam tutar: 2\.500 TL/.test(r.metin) && !/2\.850/.test(r.metin) && r.mudahale, r.metin);
r = kor('Toplamınız 3.000 TL. Aşağıdaki kutucuktan tamamlayın. ###SIPARIS_FORM:0201:L:1,0202:XL:1,0101:M:1###');
check('Form aşamasında yanlış toplam düzeltilir (2.500)', /Toplam tutar: 2\.500 TL/.test(r.metin) && !/3\.000/.test(r.metin), r.metin);
r = kor('Toplamınız 3.100 TL. ###SIPARIS_FORM:0201:L:1,0202:XL:1,0101:M:1,0103:L:1###');
check('4 ürünlük sepet (kampanya dışı) → fiyat yok, doğrudan canlı destek', r.ozel && !/3\.100/.test(r.metin), r);
r = kor('2 eşofman üstü alana 1 forma hediye. Kartlardan seçebilirsiniz. ###SEPET:0201:1,0202:1###');
check('Doğru kampanya cümlesi korunur + toplam eklenir', /hediye/.test(r.metin) && /2\.500 TL/.test(r.metin), r.metin);
r = kor('3. eşofman üstünüz yarı fiyatına 625₺ olacaktır. ###SEPET:0201:2,0202:1###');
check('HESAP GİZLİ: 625 cümlesi gitmez; 3 eşofman = 2.500 (3. bedava)', !/625/.test(r.metin) && /2\.500 TL/.test(r.metin), r.metin);
r = kor('1 eşofmanla forma 350₺ olur. Dilerseniz seçebilirsiniz.');
check('HESAP GİZLİ: eski 350 ara fiyatı sohbete çıkamaz', !/350/.test(r.metin) && r.mudahale, r);
r = kor('Eşofman üstlerimiz 1.250₺, 2 eşofman üstü alana 1 forma hediye.');
check('Sabit birim fiyat (1.250) ve kampanya teklifi serbest', /1\.250/.test(r.metin) && !r.mudahale, r);
r = kor('Yarı fiyatına 625₺ ve 4. eşofman 600₺.');
check('Ara fiyatlar (625/600) silinir', !/625|600/.test(r.metin) && r.mudahale, r);
r = kor('İki eşofman ve bir forma 2.400 TL.');
check('Sepetsiz uydurma toplam silinir', !/2\.400/.test(r.metin) && r.mudahale, r);
r = kor('Size özel 500 TL indirim yapabiliriz.');
check('Uydurma indirim tutarı silinir', !/500/.test(r.metin) && r.mudahale, r);
r = kor('1 forma 690 TL, kargo dahil.');
check('Normal fiyat cümlesi dokunulmaz', r.metin.includes('690') && !r.mudahale, r);
r = kor('Siparişiniz hazır. ###SIPARIS_FORM:0201:L:5###');
check('5 eşofman → fiyat yok, canlı destek', r.ozel && !/\d\.\d{3}/.test(r.metin), r);
r = kor('Siparişiniz hazır. ###SIPARIS_FORM:0101:M:5###');
check('5 forma → canlı destek', r.ozel, r);
r = kor('Siparişiniz hazır. ###SIPARIS_FORM:9999:M:1###');
check('Bilinmeyen ürün kodu → canlı destek', r.ozel, r);
r = kor('Siparişiniz hazır. ###SIPARIS_FORM:0101:M:0###');
check('0 adet → canlı destek', r.ozel, r);
r = kor('Tutar 1250 lira.');
check('"1250 lira" biçimi de yakalanır (tek başına serbest sabit fiyat)', G.tutarlariBul('Tutar 1250 lira.')[0] === 1250);
check('₺1.350 biçimi yakalanır', G.tutarlariBul('₺1.350')[0] === 1350);
check('"1350₺" biçimi yakalanır', G.tutarlariBul('1350₺')[0] === 1350);
check('"3 forma 2.600" (₺ yok) yakalanır', G.tutarlariBul('3 forma 2.600 olur').includes(2600));
r = kor('1 eşofman ve 3 forma toplam 2.600 TL. ###SEPET:0201:1,0101:3###');
check('1 eşofman + 3 forma = 4 ürün → kampanya dışı, fiyat yok', r.ozel && !/2\.600/.test(r.metin), r);
r = kor('2 eşofman ve 1 forma toplam 2.850 TL. ###SEPET:0201:1,0202:1,0101:1###');
check('2 eşofman + 1 forma = 2.500', /2\.500 TL/.test(r.metin), r.metin);
r = kor('Toplam 1.600 TL. ###SEPET:0201:1,0102:1###');
check('1 eşofman + 1 forma: eski 1.600 yanlış, doğrusu 1.940', /1\.940 TL/.test(r.metin) && !/1\.600/.test(r.metin), r.metin);

// 7) HTML canlı deneme (jsdom varsa): sayfa gerçekten aynı sonucu gösteriyor mu?
let JSDOM = null; try { JSDOM = require('jsdom').JSDOM; } catch (e) {}
if (JSDOM) {
  const kod = { '0101': 'f', '0102': 'f', '0103': 'f', '0201': 'e', '0202': 'e' };
  const dene = (e, f) => {
    const parcalar = [];
    for (let i = 0; i < e; i++) parcalar.push((i % 2 ? '0202' : '0201') + ':L:1');
    for (let i = 0; i < f; i++) parcalar.push(['0101', '0102', '0103'][i % 3] + ':M:1');
    const dom = new JSDOM(html, { url: 'https://x.test/siparis.html?urunler=' + encodeURIComponent(parcalar.join(',')), runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window, d = w.document;
    return { toplam: d.getElementById('toplam').textContent, buton: d.getElementById('ileri').disabled };
  };
  for (let e = 0; e <= 4; e++) for (let f = 0; f <= 4; f++) {
    if (e + f === 0) continue;
    const beklenen = T(e, f);
    const s = dene(e, f);
    if (beklenen === null) check(`SAYFA (${e}e,${f}f) toplam 4+ adet: sipariş ENGELLİ`, s.buton === true && s.toplam === '-', s);
    else check(`SAYFA (${e}e,${f}f) ekranda ${beklenen} TL`, s.toplam.replace(/\D/g, '') === String(beklenen), s);
  }
  check('SAYFA 5 eşofman engelli', dene(5, 0).buton === true);
  check('SAYFA 5 forma engelli', dene(0, 5).buton === true);
  check('SAYFA 4 forma engelli', dene(0, 4).buton === true);
} else console.log('(jsdom kurulu değil; sayfa canlı testi atlandı: npm i jsdom)');


// 8) BEDEN ALGILAMA (müşteri sadece S/M/L/XL yazınca bot sessiz kalmamalı)
const BB = blok(bot, '// >>> BEDEN_ALGILA_BASLA', '// <<< BEDEN_ALGILA_BITIS');
check('beden algılama bloğu var', !!BB);
const BF = new Function('URUN_TIPLERI', BB.replace(/^\/\/.*$/gm, '') + '\nreturn { bedenAlgila, bedenUygula };')(URUN_TIPLERI_TEST);
const ba = BF.bedenAlgila;
['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 's', 'm', 'l', 'xl', 'xxl', 'XL beden', 'l beden', 'L beden olsun', 'bedenim XL', 'evet L', 'tamam M', '3xl', '2XL', 'xl olsun lütfen'].forEach(x =>
  check(`beden algılanır: "${x}"`, ba(x) && ba(x).liste.length === 1, ba(x)));
['XS', 'merhaba', 'kaç para', 'L kaç para', 'beden', 'evet', 'kargo ne zaman', 'siyah L', 'boyum 180 kilom 80', ''].forEach(x =>
  check(`beden SAYILMAZ: "${x}"`, ba(x) === null, ba(x)));
let bs = ba('forma L eşofman XL'); check('forma L eşofman XL → kategori bazlı', bs && bs.ozel.forma === 'L' && bs.ozel.esofman === 'XL', bs);
bs = ba('L forma XL eşofman'); check('L forma XL eşofman → kategori bazlı', bs && bs.ozel.forma === 'L' && bs.ozel.esofman === 'XL', bs);
bs = ba('eşofman üstü XL'); check('eşofman üstü XL', bs && bs.ozel.esofman === 'XL', bs);
bs = ba('L ve XL'); check('L ve XL → iki beden listesi', bs && bs.liste.join() === 'L,XL', bs);
const anlamsizKod = bot.match(/function anlamsizMi[\s\S]*?\n}\n/)[0];
const anlamsizMi = new Function('bedenAlgila', anlamsizKod + '\nreturn anlamsizMi;')(ba);
check('SESSİZLİK HATASI KAPALI: "L" artık yok sayılmaz', anlamsizMi('L') === false);
check('SESSİZLİK HATASI KAPALI: "M" yok sayılmaz', anlamsizMi('M') === false);
check('Anlamsız tek harf ("x") hâlâ yok sayılır', anlamsizMi('x') === true);
const bu = BF.bedenUygula;
const sepE_F = [{ kod: '0201', beden: null }, { kod: '0102', beden: null }];
let u = bu(sepE_F, ba('L')); check('tek beden bekleyen hepsine', u.degisti && u.sepet.every(k => k.beden === 'L'), u);
u = bu(sepE_F, ba('eşofman XL forma L')); check('kategoriye göre', u.degisti && u.sepet[0].beden === 'XL' && u.sepet[1].beden === 'L', u);
u = bu(sepE_F, ba('L XL')); check('iki beden sırayla', u.degisti && u.sepet[0].beden === 'L' && u.sepet[1].beden === 'XL', u);
u = bu([{ kod: '0201', beden: null }, { kod: '0102', beden: null }, { kod: '0103', beden: null }], ba('L XL')); check('sayı uyuşmuyorsa dokunma (Claude sorsun)', !u.degisti && u.sepet.every(k => !k.beden), u);
u = bu([{ kod: '0201', beden: 'L' }], ba('XL')); check('bekleyen yoksa dokunma', !u.degisti, u);
u = bu([{ kod: '0201', beden: 'L' }, { kod: '0102', beden: null }], ba('M')); check('sadece bekleyene atanır, eskisi bozulmaz', u.degisti && u.sepet[0].beden === 'L' && u.sepet[1].beden === 'M', u);
u = bu([{ kod: '0102', beden: null }], ba('eşofman XL')); check('kategoriye uyan ürün yoksa dokunma', !u.degisti, u);

// 9) KAMPANYA DIŞI ADET (yazıyla): toplam 4+ → doğrudan WhatsApp
const AT = blok(bot, '// >>> ADET_TALEBI_BASLA', '// <<< ADET_TALEBI_BITIS');
check('adet talebi bloğu var', !!AT);
const adetTalebi = new Function(AT.replace(/^\/\/.*$/gm, '') + '\nreturn adetTalebi;')();
[['4 forma istiyorum', 4], ['4 tane forma', 4], ['dört forma', 4], ['5 adet eşofman üstü', 5], ['2 forma 2 eşofman', 4], ['iki eşofman iki forma', 4], ['10 forma', 10], ['4 siyah forma', 4], ['3 forma 2 eşofman', 5], ['6 adet beşiktaş forması', 6]].forEach(([m, n]) =>
  check(`WhatsApp'a gider: "${m}"`, adetTalebi(m) >= 4, adetTalebi(m)));
[['2 forma', 2], ['3 forma', 3], ['2 eşofman 1 forma', 3], ['iki forma alırsam üçüncü forma bedava mı', 2], ['10 numaralı forma isim yazsın', 0], ['10 numara forma', 0], ['bir forma istiyorum', 1], ['180 cm 80 kg forma', 0], ['3. forma bedava mı', 0], ['2 al 1 hediye forma', 1], ['merhaba', 0], ['L beden', 0], ['1250 tl eşofman', 0]].forEach(([m, n]) =>
  check(`WhatsApp'a GİTMEZ (kampanya içi/alakasız): "${m}"`, adetTalebi(m) < 4, adetTalebi(m)));

console.log(`\n${ok} kontrol geçti, ${fail} kontrol BAŞARISIZ`);
process.exit(fail ? 1 : 0);
