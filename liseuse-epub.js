// Convertisseur EPUB de la liseuse TBL : un seul code pour le navigateur du lecteur (Web\liseuse.html) et pour Node
// (scripts\liseuse\convertir-epub.js, essais et vérification d'un EPUB sur le poste de l'éditeur).
// Plan : .claude\Plans\6-ELC-liseuse-epub-sur-le-poste.md (décision de Marcel du 9 novembre 2026).
//
// Entrée : les octets d'un fichier .epub. Sortie : { titre, auteur, chapitres[], fragments[], rapport,
// versionConvertisseur }. Chaque chapitre a sa partie (selon la table des matières), son numéro, son titre, son
// sous-titre (champ « exergue ») et son nombre de paragraphes ; le texte est dans les fragments (HTML nettoyé,
// environ 50 Ko, chaque image à part, en JPEG réduit inscrit dans la page). La position de lecture se note en
// « chapitre et paragraphe » : le même EPUB passé dans la même version du convertisseur donne toujours la même
// numérotation. Toute modification qui change cette numérotation doit faire avancer VERSION.
//
// Ce qui est reconnu, pour tout EPUB 2 ou 3 :
//   - ordre de lecture (spine), table des matières EPUB 3 (nav) ou EPUB 2 (toc.ncx), parties et sous-titres de partie ;
//   - titres h1 à h6 : premier titre = titre du chapitre, titre suivant avant le texte = sous-titre, plus loin = intertitre ;
//   - numéro de chapitre (« 1 », « IV », « Chapitre 3 ») placé avant le titre ;
//   - paragraphes, texte posé directement dans un div, citations, listes numérotées ou à puces, tableaux (une ligne
//     par rangée), texte préformaté, définitions ;
//   - italique, gras, exposant, indice, petites capitales, sauts de ligne ; appels de note en exposant ;
//   - séparateurs de scène (hr, classes « ornament », « scene-break », lignes « * * * ») en « ⁂ » ;
//   - images : pleine page (document sans texte), bandeau en tête de chapitre, illustration dans le texte ; la
//     couverture et la page de titre sont laissées de côté (la liseuse a les siennes).
//
// Vérification (rapport) : chaque mot du livre source doit se retrouver dans le résultat, sauf ce qui est
// volontairement laissé de côté (couverture, page de titre, page de partie). Sont aussi signalés : balises ou entités
// inconnues, liens vers des fichiers absents de l'EPUB (ex. notes de fin manquantes), images illisibles.
//
// L'hôte fournit deux fonctions : decompresser(octets) (deflate brut) et reduireImage(octets, { chemin, ext, lMax,
// hMax }) qui rend une adresse data: en JPEG (ou '' si l'image est illisible). hoteNavigateur() les fournit pour le
// navigateur (DecompressionStream, canvas).
(function (racine, fabrique) {
  var module_ = fabrique();
  if (typeof module === 'object' && module.exports) { module.exports = module_; } else { racine.LiseuseEpub = module_; }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '2026-11-09.1';
const TAILLE_FRAGMENT = 50 * 1024;
const DIMENSIONS = { pleine: [800, 1200], bandeau: [1200, 700], image: [1000, 1200] };
const RE_BINAIRE = /\.(jpe?g|png|gif|webp|bmp|tiff?|svg|otf|ttf|woff2?|eot|mp3|mp4|m4a|ogg|wav|webm|pdf)$/i;
const DECODEUR = new TextDecoder('utf-8');

/* ---------- Chemins (équivalents de path.posix) ---------- */
function dossierDe(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function extensionDe(p) { const m = /\.[^./]*$/.exec(p); return m ? m[0].toLowerCase() : ''; }
function joindre(base, rel) {
  const parts = [];
  (base ? base + '/' + rel : rel).split('/').forEach((seg) => {
    if (seg === '' || seg === '.') { return; }
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') { parts.pop(); } else { parts.push('..'); } return; }
    parts.push(seg);
  });
  return parts.join('/');
}

/* ---------- Base64 ---------- */
function enBase64(octets) {
  if (typeof Buffer !== 'undefined') { return Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength).toString('base64'); }
  let s = '';
  for (let i = 0; i < octets.length; i += 0x8000) { s += String.fromCharCode.apply(null, octets.subarray(i, i + 0x8000)); }
  return btoa(s);
}

/* ---------- Lecture du zip (répertoire central) ---------- */
// Les fichiers texte (XHTML, OPF, NCX) sont décompressés d'avance ; les images à la demande.
async function ouvrirEpub(octets, hote) {
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const u32 = (p) => vue.getUint32(p, true);
  const u16 = (p) => vue.getUint16(p, true);
  let fin = octets.length - 22;
  while (fin >= 0 && u32(fin) !== 0x06054b50) { fin -= 1; }
  if (fin < 0) { throw new Error('Fichier EPUB illisible (zip sans répertoire central).'); }
  const nombre = u16(fin + 10);
  let p = u32(fin + 16);
  const entrees = new Map();
  for (let i = 0; i < nombre; i += 1) {
    if (u32(p) !== 0x02014b50) { throw new Error('Fichier EPUB abîmé (répertoire central).'); }
    const methode = u16(p + 10);
    const crc = u32(p + 16);
    const tailleComp = u32(p + 20);
    const taille = u32(p + 24);
    const lNom = u16(p + 28);
    const lExtra = u16(p + 30);
    const lCom = u16(p + 32);
    const local = u32(p + 42);
    const nom = DECODEUR.decode(octets.subarray(p + 46, p + 46 + lNom));
    entrees.set(nom, { methode, crc, taille, tailleComp, local });
    p += 46 + lNom + lExtra + lCom;
  }
  const octetsDe = async (e) => {
    const debut = e.local + 30 + u16(e.local + 26) + u16(e.local + 28);
    const brut = octets.subarray(debut, debut + e.tailleComp);
    return e.methode === 0 ? brut : hote.decompresser(brut);
  };
  const textes = new Map();
  await Promise.all([...entrees].filter(([nom]) => !RE_BINAIRE.test(nom) && !nom.endsWith('/')).map(async ([nom, e]) => {
    textes.set(nom, DECODEUR.decode(await octetsDe(e)));
  }));
  return {
    existe: (rel) => entrees.has(rel),
    texte: (rel) => {
      if (textes.has(rel)) { return textes.get(rel); }
      throw new Error('Absent de l’EPUB : ' + rel);
    },
    octets: (rel) => {
      const e = entrees.get(rel);
      if (!e) { throw new Error('Absent de l’EPUB : ' + rel); }
      return octetsDe(e);
    },
    // Même contenu (couverture reprise ailleurs) : même empreinte et même taille dans le zip.
    memeContenu: (a, b) => { const x = entrees.get(a); const y = entrees.get(b); return !!x && !!y && x.crc === y.crc && x.taille === y.taille; },
  };
}

/* ---------- Entités ---------- */
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const ENTITES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', circ: 'ˆ', tilde: '˜', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•', hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', euro: '€', trade: '™', fnof: 'ƒ', larr: '←', rarr: '→', minus: '−', infin: '∞', ne: '≠', le: '≤', ge: '≥', nbhy: '‑' };
LATIN1.forEach((nom, i) => { ENTITES[nom] = String.fromCharCode(160 + i); });

function decoder(s, rapport) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (tout, nom) => {
    if (nom[0] === '#') {
      const n = nom[1] === 'x' || nom[1] === 'X' ? parseInt(nom.slice(2), 16) : Number(nom.slice(1));
      try { return String.fromCodePoint(n); } catch (e) { return ''; }
    }
    if (Object.prototype.hasOwnProperty.call(ENTITES, nom)) { return ENTITES[nom]; }
    if (rapport) { rapport.avertir('entite', 'Entité inconnue : ' + tout); }
    return tout;
  });
}

/* ---------- Analyse XHTML (arbre simple, tolérant) ---------- */
const VIDES = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr', 'source', 'image', 'param', 'track', 'embed']);
function analyser(xml, rapport) {
  const racine = { tag: '#racine', attrs: {}, enfants: [] };
  const pile = [racine];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|</g;
  let m;
  while ((m = re.exec(xml))) {
    const haut = pile[pile.length - 1];
    if (m[1] !== undefined) { haut.enfants.push(m[1]); continue; }
    if (m[2]) {
      const nom = m[2].toLowerCase().replace(/^(xhtml|html|h):/, '');
      for (let i = pile.length - 1; i > 0; i -= 1) {
        if (pile[i].tag === nom) { pile.length = i; break; }
      }
      continue;
    }
    if (m[3]) {
      const nom = m[3].toLowerCase().replace(/^(xhtml|html|h):/, '');
      const attrs = {};
      for (const a of (m[4] || '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1].toLowerCase()] = decoder(a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] || '')), null);
      }
      const noeud = { tag: nom, attrs, enfants: [] };
      haut.enfants.push(noeud);
      if (!m[5] && !VIDES.has(nom)) { pile.push(noeud); }
      continue;
    }
    if (m[6] !== undefined) { haut.enfants.push(decoder(m[6], rapport)); continue; }
  }
  return racine;
}
function trouver(noeud, test) {
  if (typeof noeud === 'string') { return null; }
  if (test(noeud)) { return noeud; }
  for (const e of noeud.enfants) { const r = trouver(e, test); if (r) { return r; } }
  return null;
}
function tous(noeud, test, liste = []) {
  if (typeof noeud === 'string') { return liste; }
  if (test(noeud)) { liste.push(noeud); }
  noeud.enfants.forEach((e) => tous(e, test, liste));
  return liste;
}
function texteDe(noeud) {
  if (typeof noeud === 'string') { return noeud; }
  if (IGNORES.has(noeud.tag)) { return ''; }
  if (noeud.tag === 'br') { return ' '; }
  const dedans = noeud.enfants.map(texteDe).join('');
  return BLOCS.has(noeud.tag) || noeud.tag === 'sup' || noeud.tag === 'sub' ? ' ' + dedans + ' ' : dedans;
}
function propre(s) { return s.replace(/[ \t\r\n\f]+/g, ' ').trim(); }
function echapper(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function classes(n) { return (n.attrs && (n.attrs.class || '')) || ''; }
function typeEpub(n) { return (n.attrs && (n.attrs['epub:type'] || n.attrs.role || '')) || ''; }

function resoudre(base, href) {
  const sans = String(href || '').split('#')[0];
  if (!sans || /^[a-z]+:/i.test(sans)) { return ''; }
  let decode = sans;
  try { decode = decodeURIComponent(sans); } catch (e) { /* garde tel quel */ }
  return joindre(base, decode).replace(/^\.\//, '');
}
// Repère d'un lien (« chapitre.xhtml#id_Toc12 » donne « id_Toc12 »).
function ancreDe(href) {
  const a = String(href || '').split('#')[1] || '';
  try { return decodeURIComponent(a); } catch (e) { return a; }
}

/* ---------- Rapport ---------- */
function nouveauRapport() {
  const r = { erreurs: [], avertissements: {}, ignores: [] };
  r.erreur = (msg) => r.erreurs.push(msg);
  r.avertir = (sorte, msg) => { const l = (r.avertissements[sorte] = r.avertissements[sorte] || []); if (!l.includes(msg)) { l.push(msg); } };
  r.ignorer = (quoi, texte) => r.ignores.push({ quoi, texte });
  return r;
}

/* ---------- Table des matières (nav EPUB 3 ou NCX EPUB 2) ---------- */
function lireToc(epub, items, opfArbre, rapport) {
  const navItem = Object.values(items).find((i) => /\bnav\b/.test(i.props));
  const entrees = (liste, dir) => liste.map((li) => {
    const a = li.enfants.find((e) => typeof e !== 'string' && (e.tag === 'a' || e.tag === 'span'));
    const sous = li.enfants.find((e) => typeof e !== 'string' && (e.tag === 'ol' || e.tag === 'ul'));
    return {
      libelle: propre(texteDe(a || li)),
      href: a && a.attrs.href ? resoudre(dir, a.attrs.href) : '',
      ancre: a && a.attrs.href ? ancreDe(a.attrs.href) : '',
      enfants: sous ? entrees(sous.enfants.filter((e) => typeof e !== 'string' && e.tag === 'li'), dir) : [],
    };
  });
  if (navItem && epub.existe(navItem.chemin)) {
    const arbre = analyser(epub.texte(navItem.chemin), rapport);
    const nav = trouver(arbre, (n) => n.tag === 'nav' && /toc/.test(typeEpub(n))) || trouver(arbre, (n) => n.tag === 'nav');
    const ol = nav && trouver(nav, (n) => n.tag === 'ol' || n.tag === 'ul');
    if (ol) {
      return { chemin: navItem.chemin, entrees: entrees(ol.enfants.filter((e) => typeof e !== 'string' && e.tag === 'li'), dossierDe(navItem.chemin)) };
    }
  }
  const spineNoeud = trouver(opfArbre, (n) => n.tag === 'spine');
  const ncxId = spineNoeud && spineNoeud.attrs.toc;
  const ncxItem = (ncxId && items[ncxId]) || Object.values(items).find((i) => /ncx/.test(i.type));
  if (ncxItem && epub.existe(ncxItem.chemin)) {
    const arbre = analyser(epub.texte(ncxItem.chemin), rapport);
    const dir = dossierDe(ncxItem.chemin);
    const points = (n) => n.enfants.filter((e) => typeof e !== 'string' && e.tag === 'navpoint').map((np) => {
      const label = trouver(np, (x) => x.tag === 'navlabel');
      const content = np.enfants.find((e) => typeof e !== 'string' && e.tag === 'content');
      return { libelle: propre(texteDe(label || { tag: 'x', attrs: {}, enfants: [] })), href: content ? resoudre(dir, content.attrs.src) : '', ancre: content ? ancreDe(content.attrs.src) : '', enfants: points(np) };
    });
    const map = trouver(arbre, (n) => n.tag === 'navmap');
    if (map) { return { chemin: ncxItem.chemin, entrees: points(map) }; }
  }
  rapport.avertir('toc', 'Aucune table des matières lisible : titres pris dans les chapitres.');
  return { chemin: '', entrees: [] };
}

// Parties : entrée de premier niveau dont des sous-entrées mènent vers d'autres fichiers. Une sous-entrée sans lien
// donne le sous-titre de la partie (« Thème 1 » devient « Thème 1 : Souvenirs intérieurs »).
function analyserToc(toc, titreLivre) {
  let haut = toc.entrees;
  if (haut.length === 1 && haut[0].enfants.length && propre(haut[0].libelle).toLowerCase() === titreLivre.toLowerCase()) { haut = haut[0].enfants; }
  const partieDe = {};
  const libelleDe = {};
  const ancresDe = {}; // fichier → [{ ancre, libelle }] dans l'ordre de la table : plusieurs chapitres dans un fichier
  const pagesDePartie = new Set();
  const marquer = (e) => {
    if (e.href && !libelleDe[e.href]) { libelleDe[e.href] = e.libelle; }
    if (e.href) { (ancresDe[e.href] = ancresDe[e.href] || []).push({ ancre: e.ancre || '', libelle: e.libelle }); }
    e.enfants.forEach(marquer);
  };
  haut.forEach(marquer);
  haut.forEach((e) => {
    const fichiersEnfants = new Set();
    const parcourir = (x) => x.enfants.forEach((c) => { if (c.href && c.href !== e.href) { fichiersEnfants.add(c.href); } parcourir(c); });
    parcourir(e);
    if (!fichiersEnfants.size) { return; }
    const sousTitre = e.enfants.find((c) => !c.href && c.libelle);
    const nom = sousTitre ? `${e.libelle} : ${sousTitre.libelle}` : e.libelle;
    if (e.href) { partieDe[e.href] = nom; pagesDePartie.add(e.href); }
    fichiersEnfants.forEach((f) => { partieDe[f] = nom; });
  });
  return { partieDe, libelleDe, ancresDe, pagesDePartie };
}

// Repères de la table des matières rencontrés pendant le parcours : on note l'indice du prochain bloc.
// profond : cherche aussi dans les descendants (titre, texte en ligne).
function noterAncres(n, ctx, sortie, profond) {
  if (!ctx.ancres || !ctx.ancres.size || typeof n === 'string') { return; }
  const vise = (x) => !!x.attrs && ((x.attrs.id && ctx.ancres.has(x.attrs.id)) || (x.attrs.name && ctx.ancres.has(x.attrs.name)));
  const liste = profond ? tous(n, vise) : (vise(n) ? [n] : []);
  liste.forEach((x) => {
    const ancre = ctx.ancres.has(x.attrs.id) ? x.attrs.id : x.attrs.name;
    if (!ctx.marques.some((m) => m.ancre === ancre)) { ctx.marques.push({ ancre, index: sortie.length }); }
  });
}

/* ---------- Blocs d'un document ---------- */
const IGNORES = new Set(['head', 'script', 'style', 'template', 'noscript', 'title', 'meta', 'link']);
const BLOCS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'blockquote', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'pre', 'hr', 'nav', 'body', 'address', 'center', 'hgroup', 'details', 'summary', 'svg', 'colgroup', 'col']);
const EN_LIGNE = new Set(['span', 'a', 'em', 'i', 'b', 'strong', 'sup', 'sub', 'small', 'big', 'u', 's', 'strike', 'del', 'ins', 'cite', 'q', 'abbr', 'acronym', 'code', 'kbd', 'samp', 'var', 'dfn', 'mark', 'time', 'br', 'img', 'font', 'tt', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'label', 'data', 'wbr', 'math', 'image', 'object', 'audio', 'video']);
const RE_PAUSE_CLASSE = /ornament|scene-?break|section-?break|separator|separateur|dinkus|asterism|space-break|transition/i;
const RE_PAUSE_TEXTE = /^[\s*·•⁂∗✻✶✦◆◇~#§_=–—.-]{1,15}$/;
const RE_CONTENEUR_TITRE = /title|titre|heading|chapter-?head|chap-?head|en-?tete|card/i;
const RE_NUMERO = /^(?:(?:chapitre|chapter|partie|part)\s+)?(\d{1,3}|[IVXLCDM]{1,7})\.?$/i;

function estPetitesCapitales(n) {
  const style = (n.attrs.style || '').toLowerCase();
  return /small-?caps|smcp|petites?-?cap/i.test(classes(n)) || /font-variant\s*:\s*small-caps/.test(style);
}
function alignement(n) {
  const c = classes(n) + ' ' + (n.attrs.style || '');
  if (/(^|[\s-])(center|centre|centered|align-?center|text-align\s*:\s*center)/i.test(c)) { return 'mo-centre'; }
  if (/(^|[\s-])(right|droite|align-?right|text-align\s*:\s*right)/i.test(c)) { return 'mo-droite'; }
  return '';
}
function estAppelDeNote(n) {
  return n.tag === 'a' && (/noteref/.test(typeEpub(n)) || /noteref|endnote-link|footnote-link|footnote-ref|note-ref|fnref/i.test(classes(n)));
}

// HTML en ligne permis : <em>, <strong>, <sup>, <sub>, <br>, <span class="mo-pc">. Les images rencontrées sont
// rendues à part (liste images).
function enLigne(noeud, ctx) {
  if (typeof noeud === 'string') { return echapper(noeud.replace(/'/g, '’')); }
  const t = noeud.tag;
  if (IGNORES.has(t)) { return ''; }
  if (t === 'br') { return '\u0005'; }
  if (t === 'img' || t === 'image') { ctx.images.push(noeud); return ''; }
  if (t === 'svg') { tous(noeud, (x) => x.tag === 'image' || x.tag === 'img').forEach((x) => ctx.images.push(x)); return ''; }
  if (!EN_LIGNE.has(t) && !BLOCS.has(t)) { ctx.rapport.avertir('balise', 'Balise inconnue (texte gardé) : <' + t + '>'); }
  const dedans = noeud.enfants.map((e) => enLigne(e, ctx)).join('');
  if (estAppelDeNote(noeud)) {
    const lien = resoudre(ctx.dir, noeud.attrs.href);
    if (lien && !ctx.epub.existe(lien)) { ctx.rapport.avertir('note', 'Appel de note vers un fichier absent de l’EPUB (' + lien + ') : seul le numéro est gardé.'); }
    return /<sup>/.test(dedans) ? dedans : '<sup>' + propre(dedans) + '</sup>';
  }
  if (t === 'em' || t === 'i' || t === 'cite' || t === 'dfn' || t === 'var') { return '\u0001' + dedans + '\u0002'; }
  if (t === 'strong' || t === 'b') { return '\u0003' + dedans + '\u0004'; }
  if (t === 'sup') { return '<sup>' + dedans + '</sup>'; }
  if (t === 'sub') { return '<sub>' + dedans + '</sub>'; }
  if (t === 'q') { return '« ' + dedans + ' »'; }
  if (estPetitesCapitales(noeud)) { return '<span class="mo-pc">' + dedans + '</span>'; }
  if (/font-style\s*:\s*italic/i.test(noeud.attrs.style || '')) { return '\u0001' + dedans + '\u0002'; }
  if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(noeud.attrs.style || '')) { return '\u0003' + dedans + '\u0004'; }
  return dedans;
}
function finirLigne(s) {
  s = s.replace(/[ \t\r\n\f]+/g, ' ');
  s = s.replace(/\u0001/g, '<em>').replace(/\u0002/g, '</em>').replace(/\u0003/g, '<strong>').replace(/\u0004/g, '</strong>');
  s = s.replace(/\s*\u0005\s*/g, '<br>').replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
  // Balise vide : retirée, mais l'espace qu'elle contenait reste (« heure<i> </i>du » ne devient pas « heuredu »).
  for (let i = 0; i < 3; i += 1) { s = s.replace(/<(em|strong|sup|sub)>(\s*)<\/\1>/g, (t, b, esp) => (esp ? ' ' : '')).replace(/<span class="mo-pc">(\s*)<\/span>/g, (t, esp) => (esp ? ' ' : '')); }
  return s.replace(/ {2,}/g, ' ').trim();
}
function texteDeLigne(html) { return propre(html.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); }

// Parcours : liste de blocs { sorte, html, texte, classe, niveau, src, alt, liste }.
function blocsDe(noeud, ctx, sortie, cadre) {
  const enfants = noeud.enfants;
  let tampon = [];
  const viderTampon = (parent) => {
    if (!tampon.length) { return; }
    tampon.forEach((e) => noterAncres(e, ctx, sortie, true));
    const images = [];
    const html = finirLigne(tampon.map((e) => enLigne(e, { ...ctx, images })).join(''));
    tampon = [];
    ajouterParagraphe(html, parent, ctx, sortie, cadre);
    images.forEach((img) => ajouterImage(img, ctx, sortie));
  };
  for (const e of enfants) {
    if (typeof e === 'string' || (!BLOCS.has(e.tag) && !IGNORES.has(e.tag))) {
      tampon.push(e);
      continue;
    }
    viderTampon(noeud);
    if (IGNORES.has(e.tag)) { continue; }
    // Bloc de titre (le plus extérieur) : en-tête de chapitre qui regroupe numéro, titre et sous-titre.
    const conteneurTitre = cadre.conteneurTitre || (e.tag === 'header' || e.tag === 'hgroup' || RE_CONTENEUR_TITRE.test(classes(e)) ? e : null);
    traiterBloc(e, ctx, sortie, { ...cadre, parent: noeud, conteneurTitre });
  }
  viderTampon(noeud);
}
function aDesBlocs(n) { return n.enfants.some((e) => typeof e !== 'string' && BLOCS.has(e.tag) && e.tag !== 'svg'); }

function traiterBloc(n, ctx, sortie, cadre) {
  const t = n.tag;
  const cls = classes(n);
  // Blocs lus d'un coup (titre, texte préformaté, rangée…) : leurs repères intérieurs comptent aussi.
  noterAncres(n, ctx, sortie, /^h[1-6]$/.test(t) || t === 'pre' || t === 'tr' || t === 'dt' || t === 'hr' || t === 'svg');
  if (t === 'hr' || (RE_PAUSE_CLASSE.test(cls) && RE_PAUSE_TEXTE.test(propre(texteDe(n)) || '*'))) {
    if (RE_PAUSE_CLASSE.test(cls) && propre(texteDe(n)) && !RE_PAUSE_TEXTE.test(propre(texteDe(n)))) { blocsDe(n, ctx, sortie, cadre); return; }
    sortie.push({ sorte: 'pause' });
    return;
  }
  if (t === 'nav') { return; }
  if (/^h[1-6]$/.test(t)) {
    const images = [];
    const html = finirLigne(n.enfants.map((e) => enLigne(e, { ...ctx, images })).join(''));
    images.forEach((img) => ajouterImage(img, ctx, sortie));
    if (texteDeLigne(html)) {
      sortie.push({ sorte: 'titre', niveau: Number(t[1]), html, texte: texteDeLigne(html), conteneur: cadre.conteneurTitre || null, parent: cadre.parent || null, index: sortie.length });
    }
    return;
  }
  if (t === 'svg') { tous(n, (x) => x.tag === 'image' || x.tag === 'img').forEach((x) => ajouterImage(x, ctx, sortie)); return; }
  if (t === 'ul' || t === 'ol') {
    const ordonnee = t === 'ol' && !/list-style(-type)?\s*:\s*none/i.test(n.attrs.style || '');
    let numero = Number(n.attrs.start) || 1;
    for (const li of n.enfants) {
      if (typeof li === 'string') { if (propre(li)) { ajouterParagraphe(finirLigne(enLigne(li, { ...ctx, images: [] })), n, ctx, sortie, cadre); } continue; }
      if (li.tag !== 'li') { traiterBloc(li, ctx, sortie, cadre); continue; }
      noterAncres(li, ctx, sortie, false);
      const avant = sortie.length;
      blocsDe(li, ctx, sortie, { ...cadre, liste: { ordonnee, profondeur: ((cadre.liste && cadre.liste.profondeur) || 0) + 1 } });
      const premier = sortie.slice(avant).find((b) => b.sorte === 'p');
      if (premier) { premier.puce = ordonnee ? numero + '.' : '•'; }
      numero += 1;
    }
    return;
  }
  if (t === 'blockquote') { blocsDe(n, ctx, sortie, { ...cadre, citation: true }); return; }
  if (t === 'pre') { ajouterParagraphe(finirLigne(texteDe(n).split('\n').map(echapper).join('\u0005')), n, ctx, sortie, { ...cadre, pre: true }); return; }
  if (t === 'tr') {
    const cellules = n.enfants.filter((c) => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'));
    const html = cellules.map((c) => finirLigne(c.enfants.map((e) => enLigne(e, { ...ctx, images: [] })).join(''))).filter(Boolean).join(' · ');
    ajouterParagraphe(html, n, ctx, sortie, { ...cadre, tableau: true });
    return;
  }
  if (t === 'dt') { ajouterParagraphe(finirLigne('\u0003' + n.enfants.map((e) => enLigne(e, { ...ctx, images: [] })).join('') + '\u0004'), n, ctx, sortie, cadre); return; }
  if (/footnote|endnote|rearnote/.test(typeEpub(n)) && (t === 'aside' || t === 'section' || t === 'div' || t === 'li')) { blocsDe(n, ctx, sortie, { ...cadre, note: true }); return; }
  if (/chapter-?num|chapter-?number|chap-?num|numero|ordinal/i.test(cls) && !aDesBlocs(n) && RE_NUMERO.test(propre(texteDe(n)))) {
    sortie.push({ sorte: 'numero', texte: propre(texteDe(n)) });
    return;
  }
  blocsDe(n, ctx, sortie, cadre);
}

function ajouterParagraphe(html, parent, ctx, sortie, cadre) {
  const texte = texteDeLigne(html);
  if (!texte) { return; }
  if (RE_PAUSE_TEXTE.test(texte) && /[*⁂∗✻✶✦◆◇~#§]/.test(texte)) { sortie.push({ sorte: 'pause' }); return; }
  const cls = [];
  const a = parent && parent.attrs ? alignement(parent) : '';
  if (a) { cls.push(a); }
  if (cadre.citation) { cls.push('mo-citation'); }
  if (cadre.pre) { cls.push('mo-pre'); }
  if (cadre.tableau) { cls.push('mo-tableau'); }
  if (cadre.note) { cls.push('mo-note'); }
  sortie.push({ sorte: 'p', html, texte, classe: cls.join(' '), liste: cadre.liste || null });
}

function ajouterImage(n, ctx, sortie) {
  const href = n.attrs.src || n.attrs['xlink:href'] || n.attrs.href || '';
  const chemin = resoudre(ctx.dir, href);
  if (!chemin) { return; }
  if (!ctx.epub.existe(chemin)) { ctx.rapport.erreur('Image absente de l’EPUB : ' + chemin); return; }
  const alt = propre(n.attrs.alt || '');
  sortie.push({ sorte: 'image', src: chemin, alt: /placeholder|^image$|^img$/i.test(alt) ? '' : alt, role: '' });
}

/* ---------- Images : JPEG réduit en data: (SVG gardé tel quel) ---------- */
async function preparerImage(epub, chemin, role, rapport, hote) {
  const ext = extensionDe(chemin);
  const [lMax, hMax] = DIMENSIONS[role] || DIMENSIONS.image;
  let brut;
  try { brut = await epub.octets(chemin); } catch (e) { rapport.erreur('Image illisible : ' + chemin + ' (' + (e.message || e) + ')'); return ''; }
  if (ext === '.svg') { rapport.avertir('image', 'Image SVG gardée telle quelle : ' + chemin); return 'data:image/svg+xml;base64,' + enBase64(brut); }
  try {
    const src = await hote.reduireImage(brut, { chemin, ext, lMax, hMax });
    if (!src) { rapport.erreur('Image illisible : ' + chemin); }
    return src || '';
  } catch (e) {
    rapport.erreur('Image illisible : ' + chemin + ' (' + String((e && e.message) || e).trim().split('\n')[0] + ')');
    return '';
  }
}

/* ---------- Conversion ---------- */
// options : { titre, auteur, progres(fraction) }.
async function convertir(octets, hote, options = {}) {
  const rapport = nouveauRapport();
  const epub = await ouvrirEpub(octets, hote);
  const container = analyser(epub.texte('META-INF/container.xml'), rapport);
  const rootfile = trouver(container, (n) => n.tag === 'rootfile');
  const opfChemin = rootfile.attrs['full-path'];
  const opfDir = dossierDe(opfChemin);
  const opf = analyser(epub.texte(opfChemin), rapport);
  const items = {};
  tous(opf, (n) => n.tag === 'item').forEach((n) => {
    items[n.attrs.id] = { id: n.attrs.id, chemin: resoudre(opfDir, n.attrs.href), type: n.attrs['media-type'] || '', props: n.attrs.properties || '' };
  });
  const spine = tous(opf, (n) => n.tag === 'itemref').map((n) => items[n.attrs.idref]).filter(Boolean);
  const meta = (nom) => { const n = trouver(opf, (x) => x.tag === 'dc:' + nom || x.tag === nom); return n ? propre(texteDe(n)) : ''; };
  const titreLivre = options.titre || meta('title');
  const auteur = options.auteur || meta('creator');

  // Couverture : propriété cover-image (EPUB 3) ou <meta name="cover"> (EPUB 2).
  const metaCouv = trouver(opf, (n) => n.tag === 'meta' && n.attrs.name === 'cover');
  const couverture = Object.values(items).find((i) => /cover-image/.test(i.props)) || (metaCouv && items[metaCouv.attrs.content]);
  const avecCouverture = !!couverture && epub.existe(couverture.chemin);
  const estCouverture = (chemin) => avecCouverture && epub.existe(chemin) && (chemin === couverture.chemin || epub.memeContenu(chemin, couverture.chemin));

  const toc = lireToc(epub, items, opf, rapport);
  const { partieDe, libelleDe, ancresDe, pagesDePartie } = analyserToc(toc, titreLivre);
  const cheminsSpine = new Set(spine.map((i) => i.chemin));

  // Documents du spine en blocs
  const documents = [];
  for (const item of spine) {
    if (!/html|xml/.test(item.type) || item.chemin === toc.chemin) { continue; }
    if (!epub.existe(item.chemin)) { rapport.erreur('Document du spine absent : ' + item.chemin); continue; }
    const arbre = analyser(epub.texte(item.chemin), rapport);
    const body = trouver(arbre, (n) => n.tag === 'body');
    if (!body) { continue; }
    if (trouver(body, (n) => n.tag === 'nav' && /toc/.test(typeEpub(n)))) { rapport.ignorer('table des matières', ''); continue; }
    const dir = dossierDe(item.chemin);
    // Table des matières écrite en texte (Calibre, Word) : presque tout le texte est fait de liens vers les chapitres.
    const liens = tous(body, (n) => n.tag === 'a' && !!n.attrs.href && cheminsSpine.has(resoudre(dir, n.attrs.href)) && resoudre(dir, n.attrs.href) !== item.chemin);
    const motsLiens = liens.reduce((s, a) => s + mots(texteDe(a)).length, 0);
    const texteBody = propre(texteDe(body));
    if (liens.length >= 5 && motsLiens >= 0.8 * mots(texteBody).length - 5) { rapport.ignorer('table des matières', texteBody); continue; }
    const ctx = { epub, dir, rapport, ancres: new Set((ancresDe[item.chemin] || []).map((a) => a.ancre).filter(Boolean)), marques: [] };
    const blocs = [];
    traiterAvecRole(body, ctx, blocs);
    documents.push({ chemin: item.chemin, blocs, texteSource: texteBody, marques: ctx.marques });
  }

  // Segments : un document par chapitre de la table des matières. Un fichier qui contient plusieurs chapitres
  // (repères « fichier#id ») est coupé à chaque repère, et chaque morceau prend son libellé.
  const segments = [];
  documents.forEach((doc) => {
    const entrees = ancresDe[doc.chemin] || [];
    const libelleDuRepere = (ancre) => (entrees.find((e) => e.ancre === ancre) || {}).libelle;
    const coupes = doc.marques.filter((m) => m.index > 0 && libelleDuRepere(m.ancre)).sort((a, b) => a.index - b.index)
      .filter((m, i, l) => !i || m.index !== l[i - 1].index);
    if (!coupes.length) { segments.push({ ...doc, libelle: libelleDe[doc.chemin] }); return; }
    const auDebut = doc.marques.find((m) => m.index === 0 && libelleDuRepere(m.ancre));
    const sansRepere = entrees.find((e) => !e.ancre);
    const bornes = [{ index: 0, libelle: auDebut ? libelleDuRepere(auDebut.ancre) : (sansRepere ? sansRepere.libelle : '') }]
      .concat(coupes.map((m) => ({ index: m.index, libelle: libelleDuRepere(m.ancre) })));
    bornes.forEach((b, i) => {
      const blocs = doc.blocs.slice(b.index, i + 1 < bornes.length ? bornes[i + 1].index : doc.blocs.length);
      if (!blocs.length) { return; }
      segments.push({ chemin: doc.chemin, blocs, texteSource: blocs.map((x) => x.texte || '').join(' '), libelle: b.libelle, decoupe: true, premier: i === 0 });
    });
  });

  // Chapitres
  const chapitres = [];
  const enAttente = []; // images pleine page à placer en tête du chapitre suivant
  let partieCourante = null;
  const pourComparer = (s) => propre(String(s || '').replace(/[   ]/g, ' ')).replace(/[’']/g, '’').toLowerCase();
  const memeTexte = (a, b) => pourComparer(a) === pourComparer(b);
  const RE_NOTE = /^\[\s*←?\s*\d{1,3}\s*\]/;
  segments.forEach((doc) => {
    const textes = doc.blocs.filter((b) => b.sorte === 'p');
    const titres = doc.blocs.filter((b) => b.sorte === 'titre');
    const images = doc.blocs.filter((b) => b.sorte === 'image');
    const mots = textes.reduce((s, b) => s + b.texte.split(' ').length, 0);
    // Document sans texte : image pleine page (couverture laissée de côté), ou page de partie (la liseuse a la sienne).
    if (!textes.length && !titres.length) {
      images.forEach((img) => {
        if (estCouverture(img.src)) { rapport.ignorer('couverture', ''); return; }
        enAttente.push({ ...img, role: 'pleine' });
      });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(partieDe, doc.chemin)) { partieCourante = partieDe[doc.chemin]; }
    if (pagesDePartie.has(doc.chemin) && !textes.length) { rapport.ignorer('page de partie', doc.texteSource); return; }
    // Note de fin seule dans son fichier (Calibre : « [←3] … ») : rangée à la suite du chapitre précédent (Notes).
    if (!doc.libelle && !titres.length && chapitres.length && textes.length <= 3 && RE_NOTE.test(textes[0].texte)) {
      doc.blocs.forEach((b) => { if (b.sorte === 'p') { chapitres[chapitres.length - 1].pieces.push({ ...b, classe: [b.classe, 'mo-note'].filter(Boolean).join(' ') }); } });
      return;
    }
    // Page de titre du livre : titre identique au livre et presque pas de texte.
    if (!chapitres.length && titres.length && titres[0].texte.replace(/\s+/g, ' ').toLowerCase() === titreLivre.replace(/\s+/g, ' ').toLowerCase() && mots < 40) {
      rapport.ignorer('page de titre', doc.texteSource);
      images.forEach((img) => { if (!estCouverture(img.src)) { enAttente.push({ ...img, role: 'pleine' }); } });
      return;
    }
    const chap = { partie: partieCourante, numero: '', titre: '', afficherTitre: true, exergue: '', pieces: [] };
    enAttente.splice(0).forEach((img) => chap.pieces.push(img));
    let texteVu = false;
    let blocTitre = null;
    // Sous-titre : dans le même bloc de titre que le titre, ou titre de niveau inférieur placé juste après lui.
    const estSousTitre = (a, b) => !!a && ((a.conteneur && a.conteneur === b.conteneur)
      || (!a.conteneur && !b.conteneur && a.parent === b.parent && b.index === a.index + 1 && b.niveau > a.niveau));
    let titreDuTexte = false;
    for (const b of doc.blocs) {
      if (b.sorte === 'numero' && !chap.titre && !texteVu) { chap.numero = b.texte; continue; }
      // Titre écrit comme un simple paragraphe (Word, Calibre) : reconnu s'il reprend le libellé de la table des
      // matières. Début d'un fichier coupé sans libellé : un paragraphe court sans ponctuation finale (« Note de
      // l'auteur »).
      if (b.sorte === 'p' && !chap.titre && !texteVu && !titres.length && !b.liste
        && (doc.libelle ? memeTexte(b.texte, doc.libelle) : (doc.decoupe && b.texte.split(' ').length <= 8 && !/[.!?…:;,]$/.test(b.texte)))) {
        chap.titre = b.texte; blocTitre = b; titreDuTexte = true; continue;
      }
      if (b.sorte === 'titre') {
        if (!chap.titre && !texteVu) { chap.titre = b.texte; blocTitre = b; continue; }
        if (!chap.exergue && !texteVu && estSousTitre(blocTitre, b)) { chap.exergue = b.texte; continue; }
        chap.pieces.push({ sorte: 'p', html: b.html, texte: b.texte, classe: 'mo-intertitre' });
        texteVu = true;
        continue;
      }
      if (b.sorte === 'image') {
        if (estCouverture(b.src)) { rapport.ignorer('couverture', ''); continue; }
        chap.pieces.push({ ...b, role: b.role || (!texteVu ? 'bandeau' : 'image') });
        continue;
      }
      if (b.sorte === 'p' && !chap.titre && !texteVu && RE_NUMERO.test(b.texte) && b.texte.length <= 12 && titres.length) { chap.numero = b.texte; continue; }
      if (b.sorte === 'p') { texteVu = true; }
      chap.pieces.push(b);
    }
    // Titre absent du document : celui de la table des matières, sinon « Mentions légales » ou « Section N ».
    // Mentions légales coiffées du titre du livre : nommées « Mentions légales », le titre du livre gardé en tête.
    const RE_LEGAL = /©|droits réservés|ISBN|dépôt légal|copyright|tous droits/i;
    if (chap.titre && chap.titre.replace(/\s+/g, ' ').toLowerCase() === titreLivre.replace(/\s+/g, ' ').toLowerCase() && RE_LEGAL.test(doc.texteSource)) {
      chap.pieces.unshift({ sorte: 'p', html: echapper(chap.titre), texte: chap.titre, classe: 'mo-intertitre mo-centre' });
      chap.titre = '';
    }
    // Titre tiré du texte : « Chapitre 6 Les fissures » donne le numéro « Chapitre 6 » et le titre « Les fissures ».
    const RE_TITRE_NUMERO = /^((?:chapitre|chapter)\s+(?:\d{1,3}|[IVXLCDM]{1,7})|prologue|épilogue|epilogue)\s*[.:–—-]?\s+(\S.*)$/i;
    if (titreDuTexte && !chap.numero && RE_TITRE_NUMERO.test(chap.titre)) {
      const m = RE_TITRE_NUMERO.exec(chap.titre);
      chap.numero = m[1]; chap.titre = m[2];
    }
    if (!chap.titre) {
      chap.afficherTitre = false;
      const libelle = doc.libelle;
      chap.titre = (libelle && libelle.toLowerCase() !== titreLivre.toLowerCase() ? libelle : '') || (RE_LEGAL.test(doc.texteSource) ? 'Mentions légales' : 'Section ' + (chapitres.length + 1));
    }
    chapitres.push(chap);
  });
  if (enAttente.length && chapitres.length) { enAttente.splice(0).forEach((img) => chapitres[chapitres.length - 1].pieces.push(img)); }

  // HTML des pièces et fragments
  const fragments = [];
  let ordre = 0;
  for (let i = 0; i < chapitres.length; i += 1) {
    const c = chapitres[i];
    if (options.progres) { options.progres(i / chapitres.length); }
    let morceau = [];
    let taille = 0;
    let numero = 0;
    let liste = null;
    const pousser = () => {
      if (liste) { morceau.push(liste.fin); liste = null; }
      if (!morceau.length) { return; }
      fragments.push({ chapitre: i, fragment: numero, ordre: ordre++, contenu: morceau.join('\n') });
      numero += 1; morceau = []; taille = 0;
    };
    c.nbParagraphes = 0;
    for (const p of c.pieces) {
      if (p.sorte === 'image') {
        pousser();
        const src = await preparerImage(epub, p.src, p.role || 'image', rapport, hote);
        if (!src) { continue; }
        const classe = p.role === 'pleine' ? 'mo-image mo-pleine' : (p.role === 'bandeau' ? 'mo-image mo-bandeau' : 'mo-image');
        fragments.push({ chapitre: i, fragment: numero, ordre: ordre++, contenu: `<figure class="${classe}"><img src="${src}" alt="${echapper(p.alt || '').replace(/"/g, '&quot;')}"></figure>` });
        numero += 1;
        continue;
      }
      let html;
      if (p.sorte === 'pause') { html = '<p class="mo-pause">⁂</p>'; c.nbParagraphes += 1; }
      else {
        const classe = p.classe ? ` class="${p.classe}"` : '';
        html = `<p${classe}>${p.html}</p>`;
        c.nbParagraphes += 1;
      }
      // Listes : <ol>/<ul> ouvertes autour des paragraphes qui en font partie.
      if (p.liste) {
        const balise = p.liste.ordonnee ? 'ol' : 'ul';
        if (!liste || liste.balise !== balise) {
          if (liste) { morceau.push(liste.fin); }
          liste = { balise, fin: `</${balise}>` };
          morceau.push(`<${balise} class="mo-liste">`);
        }
        html = p.puce ? `<li>${html}</li>` : `<li class="mo-suite">${html}</li>`;
      } else if (liste) { morceau.push(liste.fin); liste = null; }
      if (taille + html.length > TAILLE_FRAGMENT && morceau.length && !liste) { pousser(); }
      morceau.push(html);
      taille += html.length;
    }
    pousser();
    if (!fragments.some((f) => f.chapitre === i)) { fragments.push({ chapitre: i, fragment: 0, ordre: ordre++, contenu: '' }); }
  }
  if (options.progres) { options.progres(1); }

  const livre = {
    titre: titreLivre,
    auteur,
    versionConvertisseur: VERSION,
    chapitres: chapitres.map((c, i) => ({ chapitre: i, partie: c.partie, numero: c.numero, titre: c.titre, afficherTitre: c.afficherTitre, exergue: c.exergue, nbParagraphes: c.nbParagraphes })),
    fragments,
  };
  verifierTexte(documents, livre, rapport);
  livre.rapport = { erreurs: rapport.erreurs, avertissements: rapport.avertissements, ignores: rapport.ignores.map((x) => x.quoi), manquants: rapport.manquants || [] };
  return livre;
}

// Parcours avec le rôle des images (bandeau ou pleine page) selon le conteneur.
function traiterAvecRole(body, ctx, blocs) {
  const avant = blocs.length;
  blocsDe(body, ctx, blocs, {});
  // Rôle des images : d'après la classe d'un ancêtre (chp_img, fullpage…), retrouvée dans l'arbre.
  const roles = new Map();
  const marquer = (n, role) => {
    if (typeof n === 'string') { return; }
    const cls = classes(n);
    const r = /chp_img|chapter-?image|chapter-?head|title-?image|banner|bandeau/i.test(cls) ? 'bandeau' : (/full-?page|fullpage|image-full/i.test(cls) ? 'pleine' : role);
    if (n.tag === 'img' || n.tag === 'image') { roles.set(resoudre(ctx.dir, n.attrs.src || n.attrs['xlink:href'] || n.attrs.href || ''), r); }
    n.enfants.forEach((e) => marquer(e, r));
  };
  marquer(body, '');
  blocs.slice(avant).forEach((b) => { if (b.sorte === 'image' && roles.get(b.src)) { b.role = roles.get(b.src); } });
}

// Chaque mot du texte source doit se retrouver dans le livre converti (sauf ce qui a été laissé de côté).
function mots(s) { return (s.toLowerCase().replace(/[’']/g, '’').match(/[\p{L}\p{N}]+/gu) || []); }
function verifierTexte(documents, livre, rapport) {
  const compte = new Map();
  const ajouter = (s, signe) => mots(s).forEach((m) => compte.set(m, (compte.get(m) || 0) + signe));
  documents.forEach((d) => ajouter(d.texteSource, 1));
  rapport.ignores.forEach((x) => ajouter(x.texte || '', -1));
  const parties = new Set();
  livre.chapitres.forEach((c) => {
    if (c.afficherTitre) { ajouter(c.titre, -1); }
    ajouter(c.numero || '', -1);
    ajouter(c.exergue || '', -1);
    if (c.partie && !parties.has(c.partie)) { parties.add(c.partie); }
  });
  livre.fragments.forEach((f) => ajouter(f.contenu.replace(/<figure[\s\S]*?<\/figure>/g, ' ')
    .replace(/<\/?(sup|sub|p|li|ol|ul|br)\b[^>]*>/g, ' ').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), -1));
  const manquants = [...compte].filter(([, n]) => n > 0);
  // Un mot présent seulement dans le nom d'une partie (ex. sous-titre pris dans la table des matières) n'est pas
  // un manque.
  const motsParties = new Set(mots([...parties].join(' ')));
  const source = documents.map((d) => d.texteSource).join(' ');
  const contexte = (m) => {
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'iu');
    const i = source.search(re);
    return i < 0 ? '' : '« …' + source.slice(Math.max(0, i - 40), i + m.length + 41).trim() + '… »';
  };
  rapport.manquants = manquants.filter(([m]) => !motsParties.has(m)).map(([m, n]) => `${m} ×${n} ${contexte(m)}`);
  if (rapport.manquants.length) { rapport.erreur(`${rapport.manquants.length} mot(s) du livre absents du résultat :\n    ${rapport.manquants.slice(0, 15).join('\n    ')}`); }
}

/* ---------- Hôte navigateur ---------- */
const TYPES_IMAGE = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp' };
function hoteNavigateur() {
  return {
    decompresser: async (octets) => {
      const flux = new Blob([octets]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(flux).arrayBuffer());
    },
    reduireImage: async (octets, info) => {
      const image = await createImageBitmap(new Blob([octets], { type: TYPES_IMAGE[info.ext] || 'image/jpeg' }));
      const r = Math.min(1, info.lMax / image.width, info.hMax / image.height);
      const w = Math.max(1, Math.round(image.width * r));
      const h = Math.max(1, Math.round(image.height * r));
      let toile;
      if (typeof OffscreenCanvas !== 'undefined') { toile = new OffscreenCanvas(w, h); } else { toile = document.createElement('canvas'); toile.width = w; toile.height = h; }
      const g = toile.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(image, 0, 0, w, h);
      if (image.close) { image.close(); }
      const blob = toile.convertToBlob ? await toile.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
        : await new Promise((ok) => toile.toBlob(ok, 'image/jpeg', 0.8));
      return 'data:image/jpeg;base64,' + enBase64(new Uint8Array(await blob.arrayBuffer()));
    },
  };
}

return { VERSION, convertir, hoteNavigateur };
});
