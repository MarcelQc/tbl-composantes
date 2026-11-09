/* Fenêtre de paiement par carte des services TBL (facture Stripe, Payment Element), partagée par les éditeurs.
 * Plan « Facturation_Stripe_Services.md » (dépôt TBL, 9 novembre 2026). Modèle : la fenêtre de paiement de
 * l'éditeur de publicité Facebook (editeur-facebook.html, 8 novembre 2026).
 *
 * Usage (dans une composante) :
 *   <script src="paiement-stripe.js?v=__TBL_VERSION__"></script>
 *   var fenetre = TblPaiement.ouvrir({ appeler, params, totalAffiche, retour, textes, surReussi, surFin, trace });
 *   ... la composante demande la facture au serveur (action « payer » ou « reprendre ») ...
 *   fenetre.demarrer(reponse)   // { facture, total, secretPaiement, clePublique, lienPaiement }
 *   fenetre.fermer()            // si le serveur a refusé
 *
 * Options :
 *   appeler(action, params, delai) : pont vers le serveur de la composante (actions « statut » et « annuler ») ;
 *     la réponse de « statut » donne { ok, paye, statut } et celle d'« annuler » { ok, paye, message } ;
 *   params : paramètres ajoutés à ces deux appels (ex. { livreId }) ;
 *   totalAffiche : montant du résumé, montré en attendant la facture ;
 *   retour : adresse de retour exigée par Stripe pour une carte qui demande une redirection (3-D Secure) ;
 *   textes : { reussi, reussiSub, annulee, fermerSansPayer, delai } (textes propres à l'éditeur) ;
 *   estAnnule(r), estAVerifier(r) : réponse « statut » qui met fin à l'attente (facultatif) ;
 *   surReussi(r), surAnnulee(r), surFin(r) : rappels (fenêtre payée, facture annulée, toute réponse utile) ;
 *   trace(texte) : journal de la console (facultatif).
 *
 * Règles (les mêmes que l'EDF) : le numéro de carte reste dans le cadre sécurisé de Stripe ; la fenêtre s'ouvre à
 * la hauteur du bouton cliqué (règle du 8 novembre 2026) et garde sa taille ; Fermer est désactivé pendant le
 * paiement ; fermer sans payer annule la facture après confirmation ; après le paiement, l'état est demandé au
 * serveur (qui le relit chez Stripe) jusqu'à « Paiement réussi » ; sans clé publiable ou si Stripe.js ne se charge
 * pas, un lien ouvre la page de la facture Stripe dans un nouvel onglet.
 */
(function () {
  'use strict';
  if (window.TblPaiement) { return; }

  // Hauteur (coordonnées du document) du dernier élément cliqué : la fenêtre s'y place.
  var ancreY = null;
  document.addEventListener('click', function (e) {
    var r = e.target && e.target.getBoundingClientRect ? e.target.getBoundingClientRect() : null;
    ancreY = r ? r.top + window.scrollY : e.pageY;
  }, true);

  var CSS = '' +
    '#tbl-paiement{position:absolute;inset:0;z-index:300}' +
    '#tbl-paiement .tp-voile{position:fixed;inset:0;background:rgba(0,0,0,.72)}' +
    '#tbl-paiement .tp-boite{position:absolute;left:50%;transform:translateX(-50%);width:min(520px,calc(100% - 24px));' +
    'background:var(--tbl-paper,#16181c);color:var(--tbl-ink,#f5f5f5);border:1px solid var(--tbl-line,#34373e);' +
    'border-radius:var(--tbl-radius,14px);box-shadow:0 20px 50px rgba(0,0,0,.6);padding:var(--tbl-space-md,24px);' +
    'font-family:var(--tbl-font-body,Arial,Helvetica,sans-serif);box-sizing:border-box}' +
    '#tbl-paiement h2{font-family:var(--tbl-font-heading,Arial,Helvetica,sans-serif);margin:0 0 10px;font-size:1.15rem}' +
    '#tbl-paiement p{margin:0 0 10px;font-size:.95rem;line-height:1.45}' +
    '#tbl-paiement .tp-sub{color:var(--tbl-muted,#b7bac2);font-size:.88rem}' +
    '#tbl-paiement .tp-zone{min-height:260px;margin:12px 0;position:relative}' +
    '#tbl-paiement .tp-attente{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}' +
    '#tbl-paiement .tp-roue{width:28px;height:28px;border:3px solid var(--tbl-line,#34373e);border-top-color:var(--tbl-accent,#e52530);' +
    'border-radius:50%;animation:tp-tour .9s linear infinite;margin-bottom:8px}' +
    '@keyframes tp-tour{to{transform:rotate(360deg)}}' +
    '#tbl-paiement .tp-btns{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:12px}' +
    '#tbl-paiement .tp-btn{appearance:none;border:1px solid var(--tbl-accent,#e52530);background:var(--tbl-accent,#e52530);color:#fff;' +
    'border-radius:var(--tbl-radius-btn,9px);padding:10px 16px;font-weight:700;font-size:.95rem;cursor:pointer;text-decoration:none;display:inline-block}' +
    '#tbl-paiement .tp-btn.tp-sec{background:transparent;color:var(--tbl-ink,#f5f5f5);border-color:var(--tbl-line,#34373e)}' +
    '#tbl-paiement .tp-btn:disabled{opacity:.5;cursor:default}' +
    '#tbl-paiement .tp-btn[hidden],#tbl-paiement [hidden]{display:none !important}' +
    '#tbl-paiement a{color:var(--tbl-accent,#e52530)}' +
    '#tbl-paiement .tp-confirm{border-top:1px solid var(--tbl-line,#34373e);margin-top:12px;padding-top:12px}';

  function installerCss() {
    if (document.getElementById('tbl-paiement-css')) { return; }
    var s = document.createElement('style');
    s.id = 'tbl-paiement-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  function el(tag, classe, texte) {
    var e = document.createElement(tag);
    if (classe) { e.className = classe; }
    if (texte !== undefined && texte !== null) { e.textContent = texte; }
    return e;
  }
  function argent(cents) {
    return (Math.round(cents) / 100).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });
  }
  function couleurCss(nom, defaut) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
    return v || defaut;
  }

  // Stripe.js, chargé seulement au moment de payer (toujours depuis js.stripe.com, jamais copié).
  var promesseStripe = null;
  function chargerStripe() {
    if (!promesseStripe) {
      promesseStripe = new Promise(function (ok, ko) {
        if (window.Stripe) { ok(window.Stripe); return; }
        var s = document.createElement('script');
        s.src = 'https://js.stripe.com/v3/';
        s.onload = function () { if (window.Stripe) { ok(window.Stripe); } else { ko(new Error('Stripe.js absent')); } };
        s.onerror = function () { promesseStripe = null; ko(new Error('Stripe.js non chargé')); };
        document.head.appendChild(s);
      });
    }
    return promesseStripe;
  }

  // Place le haut de la fenêtre à la hauteur du bouton cliqué, sans dépasser le bas de la page ; suit sa taille.
  function placer(boite) {
    function calculer() {
      var hautPage = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      var h = boite.offsetHeight;
      var y = ancreY !== null ? ancreY - 20 : window.scrollY + 20;
      y = Math.min(y, hautPage - h - 12);
      boite.style.top = Math.max(12, y) + 'px';
    }
    calculer();
    if (window.ResizeObserver) { new ResizeObserver(calculer).observe(boite); }
  }

  function ouvrir(o) {
    o = o || {};
    var textes = o.textes || {};
    var trace = typeof o.trace === 'function' ? o.trace : function () {};
    var params = o.params || {};
    function avec(extra) { var p = {}; Object.keys(params).forEach(function (k) { p[k] = params[k]; }); return p; }
    installerCss();
    var ancienne = document.getElementById('tbl-paiement');
    if (ancienne) { ancienne.remove(); }

    var m = el('div'); m.id = 'tbl-paiement';
    var voile = el('div', 'tp-voile');
    var b = el('div', 'tp-boite'); b.setAttribute('role', 'dialog'); b.setAttribute('aria-modal', 'true');
    var titre = el('h2', null, 'Préparation de votre facture');
    var corps = el('div');
    var intro = el('p', null, 'Traitement en cours : nous préparons votre facture' + (o.totalAffiche ? ' de ' + o.totalAffiche : '') + '. Le formulaire de paiement s’affiche dans un instant.');
    corps.appendChild(intro);
    var zone = el('div', 'tp-zone');
    var attente = el('div', 'tp-attente');
    attente.appendChild(el('div', 'tp-roue'));
    var attenteTexte = el('p', 'tp-sub', 'Traitement en cours…');
    attente.appendChild(attenteTexte);
    zone.appendChild(attente);
    var formulaire = el('div');
    zone.appendChild(formulaire);
    corps.appendChild(zone);
    var etatP = el('p', 'tp-sub', '');
    etatP.setAttribute('role', 'status'); etatP.setAttribute('aria-live', 'polite');
    corps.appendChild(etatP);
    var secours = el('p', 'tp-sub'); secours.hidden = true;
    var lienSecours = el('a', null, 'payer sur la page de Stripe (nouvel onglet)');
    lienSecours.target = '_blank'; lienSecours.rel = 'noopener';
    secours.appendChild(document.createTextNode('Ou '));
    secours.appendChild(lienSecours);
    secours.appendChild(document.createTextNode('.'));
    corps.appendChild(secours);
    var confirm = el('div', 'tp-confirm'); confirm.hidden = true;
    var btns = el('div', 'tp-btns');
    var fermerBt = el('button', 'tp-btn tp-sec', 'Fermer'); fermerBt.type = 'button'; fermerBt.disabled = true;
    var payerBt = el('button', 'tp-btn', 'Payer'); payerBt.type = 'button'; payerBt.hidden = true;
    btns.appendChild(fermerBt); btns.appendChild(payerBt);
    b.appendChild(titre); b.appendChild(corps); b.appendChild(confirm); b.appendChild(btns);
    m.appendChild(voile); m.appendChild(b);
    document.body.appendChild(m);
    placer(b);
    trace('fenêtre de paiement ouverte (traitement en cours)');

    var rep = null;
    var fini = false, enCours = false, debut = Date.now(), minuterie = null;
    var regle = false, paiementEnCours = false, paiementAccepte = false;
    function arreter() { fini = true; clearInterval(minuterie); document.removeEventListener('visibilitychange', verifier); fermerBt.disabled = false; }
    function fermer() { arreter(); m.remove(); }
    function finAttente() { attente.hidden = true; }
    function sansFormulaire() {
      finAttente();
      zone.style.minHeight = '0';
      formulaire.hidden = true;
      payerBt.hidden = true;
      etatP.textContent = 'Le formulaire de paiement n’a pas pu s’afficher.';
      secours.hidden = false;
      secours.firstChild.textContent = '';
      secours.lastChild.textContent = '';
      lienSecours.textContent = 'Payer ma facture sur la page de Stripe (nouvel onglet)';
      lienSecours.className = 'tp-btn';
      lienSecours.focus();
    }

    function demarrer(r) {
      rep = r;
      titre.textContent = 'Votre facture est prête';
      intro.textContent = 'Facture ' + (rep.facture || '') + ' : ' + argent(rep.total || 0) + '. Payez-la par carte ci-dessous : le paiement est traité de façon sécurisée par Stripe, notre partenaire de paiement. Si vous fermez cette fenêtre sans payer, la facture est annulée.';
      payerBt.textContent = 'Payer ' + argent(rep.total || 0);
      lienSecours.href = rep.lienPaiement || '#';
      secours.hidden = !rep.lienPaiement;
      fermerBt.disabled = false;
      attenteTexte.textContent = 'Chargement du formulaire de paiement…';
      if (!(rep.secretPaiement && rep.clePublique)) { sansFormulaire(); return; }
      chargerStripe().then(function (Stripe) {
        if (fini) { return; }
        var stripe = Stripe(rep.clePublique, { locale: 'fr-CA' });
        var elements = stripe.elements({
          clientSecret: rep.secretPaiement,
          locale: 'fr-CA',
          appearance: {
            theme: 'night',
            variables: {
              colorPrimary: couleurCss('--tbl-accent', '#e52530'),
              colorBackground: couleurCss('--tbl-paper-2', '#111317'),
              colorText: couleurCss('--tbl-ink', '#f5f5f5'),
              borderRadius: '8px'
            }
          }
        });
        var carte = elements.create('payment', { layout: 'tabs' });
        carte.on('ready', function () { finAttente(); payerBt.hidden = false; etatP.textContent = ''; trace('formulaire de carte prêt'); });
        carte.on('loaderror', function () { trace('formulaire de carte en erreur'); sansFormulaire(); });
        carte.mount(formulaire);
        payerBt.addEventListener('click', async function () {
          // Pendant tout le traitement, Fermer reste désactivé : un clic ne doit jamais annuler une facture en train
          // d'être payée.
          paiementEnCours = true;
          payerBt.disabled = true;
          fermerBt.disabled = true;
          confirm.hidden = true;
          etatP.textContent = 'Paiement en cours…';
          var r2 = await stripe.confirmPayment({
            elements: elements,
            redirect: 'if_required',
            confirmParams: { return_url: o.retour || 'https://www.editionstbl.ca/dashboardauteur' }
          });
          if (r2.error) {
            paiementEnCours = false;
            fermerBt.disabled = false;
            payerBt.disabled = false;
            etatP.textContent = r2.error.message || 'Le paiement a été refusé. Vérifiez la carte ou essayez-en une autre.';
            trace('carte refusée');
            return;
          }
          paiementAccepte = true;
          payerBt.hidden = true;
          etatP.textContent = 'Paiement accepté. Confirmation en cours…';
          trace('carte acceptée par Stripe, confirmation demandée au serveur');
          verifier();
        });
      }).catch(sansFormulaire);
      minuterie = setInterval(verifier, 4000);
      document.addEventListener('visibilitychange', verifier);
    }

    // Fermer sans avoir payé : confirmation dans la fenêtre, puis la facture est annulée (aucun courriel).
    function demanderFermeture() {
      confirm.textContent = '';
      confirm.appendChild(el('p', null, textes.fermerSansPayer || ('La facture ' + (rep.facture || '') + ' sera annulée et vous ne recevrez aucun courriel.')));
      var lignes = el('div', 'tp-btns');
      var continuer = el('button', 'tp-btn tp-sec', 'Continuer le paiement'); continuer.type = 'button';
      var annuler = el('button', 'tp-btn', 'Annuler la facture'); annuler.type = 'button';
      lignes.appendChild(continuer); lignes.appendChild(annuler);
      confirm.appendChild(lignes);
      confirm.hidden = false;
      btns.hidden = true;
      continuer.addEventListener('click', function () { confirm.hidden = true; btns.hidden = false; });
      annuler.addEventListener('click', async function () {
        continuer.disabled = true; annuler.disabled = true;
        etatP.textContent = 'Annulation de la facture…';
        var r = await o.appeler('annuler', avec(), 20000);
        confirm.hidden = true; btns.hidden = false;
        if (r && r.ok && r.paye) { reussi(r); return; }
        if (typeof o.surFin === 'function') { o.surFin(r); }
        if (!r || !r.ok) {
          etatP.textContent = (r && r.message) || 'L’annulation n’a pas pu être faite. Réessayez dans un instant.';
          return;
        }
        fermer();
        if (typeof o.surAnnulee === 'function') { o.surAnnulee(r, rep); }
      });
    }
    fermerBt.addEventListener('click', function () {
      if (regle || !rep || paiementAccepte) { fermer(); return; }
      if (paiementEnCours || !confirm.hidden) { return; }
      demanderFermeture();
    });

    function reussi(r) {
      regle = true;
      arreter();
      payerBt.hidden = true;
      titre.textContent = 'Paiement réussi';
      corps.textContent = '';
      corps.appendChild(el('p', null, textes.reussi || ('Merci ! Votre facture ' + (r.facture || rep.facture || '') + ' est payée.')));
      corps.appendChild(el('p', 'tp-sub', textes.reussiSub || 'La facture payée est dans l’onglet Documents de l’Espace Auteurs.'));
      fermerBt.className = 'tp-btn'; fermerBt.focus();
      trace('paiement réussi');
      if (typeof o.surReussi === 'function') { o.surReussi(r, rep); }
    }
    async function verifier() {
      if (fini || enCours || document.hidden || !rep) { return; }
      if (Date.now() - debut > 30 * 60 * 1000) {
        arreter();
        etatP.textContent = textes.delai || 'Nous n’avons pas encore reçu la confirmation du paiement. Si vous avez payé, vous recevrez un courriel sous peu.';
        return;
      }
      enCours = true;
      var r = await o.appeler('statut', avec(), 15000);
      enCours = false;
      if (fini || !r || !r.ok) { return; }
      if (r.paye) { reussi(r); return; }
      if (typeof o.estAVerifier === 'function' && o.estAVerifier(r)) {
        regle = true;
        arreter();
        etatP.textContent = 'Le paiement est reçu, mais son montant doit être vérifié par l’équipe TBL. Nous vous écrirons.';
        if (typeof o.surFin === 'function') { o.surFin(r); }
      } else if (typeof o.estAnnule === 'function' && o.estAnnule(r)) {
        regle = true;
        arreter();
        etatP.textContent = textes.annulee || 'Cette facture a été annulée.';
        if (typeof o.surFin === 'function') { o.surFin(r); }
      }
    }
    return { demarrer: demarrer, fermer: fermer };
  }

  window.TblPaiement = { ouvrir: ouvrir, chargerStripe: chargerStripe };
})();
