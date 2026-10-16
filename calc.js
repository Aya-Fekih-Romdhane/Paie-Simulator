/* Moteur de calcul de paie (Tunisie) - mêmes règles que le classeur Excel paie_wind_payroll.xlsx */
(function (root) {
  'use strict';

  const DEFAULT_PARAMS = {
    contracts: {
      CDI:    { cnssS: 0.0968, cnssP: 0.1707, at: 0.005, tfp: 0.02, foprolos: 0.01, irpp: true,  css: true  },
      CDD:    { cnssS: 0.0968, cnssP: 0.1707, at: 0.005, tfp: 0.02, foprolos: 0.01, irpp: true,  css: true  },
      KARAMA: { cnssS: 0.0968, cnssP: 0,      at: 0,     tfp: 0.02, foprolos: 0.01, irpp: true,  css: true  },
      SIVP:   { cnssS: 0,      cnssP: 0,      at: 0,     tfp: 0,    foprolos: 0,    irpp: false, css: false }
    },
    fiscal: { abattRate: 0.10, abattCap: 2000, chef: 300, enfant: 100, maxEnfants: 4, cssRate: 0.005, cssSeuil: 5000 },
    bareme: [
      { from: 0, rate: 0 }, { from: 5000, rate: 0.15 }, { from: 10000, rate: 0.25 }, { from: 20000, rate: 0.30 },
      { from: 30000, rate: 0.33 }, { from: 40000, rate: 0.36 }, { from: 50000, rate: 0.38 }, { from: 70000, rate: 0.40 }
    ],
    catalog: [
      { name: 'Prime de convention', cot: true, imp: true },
      { name: "Prime d'ancienneté", cot: true, imp: true },
      { name: 'Prime de rendement', cot: true, imp: true },
      { name: 'Prime de responsabilité', cot: true, imp: true },
      { name: 'Prime de transport', cot: false, imp: false },
      { name: 'Prime de présence', cot: false, imp: false },
      { name: 'Prime panier', cot: false, imp: false },
      { name: 'Prime de fonction', cot: false, imp: false },
      { name: 'Prime de poussière', cot: false, imp: false },
      { name: 'Prime de lait', cot: false, imp: false },
      { name: 'Prime cotisable seulement (exemple)', cot: true, imp: false },
      { name: 'Prime imposable seulement (exemple)', cot: false, imp: true }
    ]
  };

  const MODES = { NET: 'net', GROSS: 'gross', COT: 'cot', BASE: 'base' };
  // régime de paie : au mois (compté en jours) ou à l'heure (compté en heures)
  const REGIMES = { MENSUEL: 'mensuel', HORAIRE: 'horaire' };
  // heures mensuelles d'un temps plein (48 h/semaine) ; un mi-temps en fait la moitié (104 h)
  const HOURS_FULL = 208;

  // arrondi au millime (demi vers l'infini, comme ROUND d'Excel)
  const r3 = (x) => (x < 0 ? -1 : 1) * Math.round(Math.abs(x) * 1000 + 1e-7) / 1000;
  const num = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  };

  // jours du mois : prev = jours prévus (J.Prev), trav = travaillés ('' ou absent = auto),
  // feries = jours fériés payés, conges = congés payés / maladie ; absences non payées = reste
  function normDays(d) {
    const prev = Math.max(1, num(d && d.prev) || 26);
    const fer = Math.max(0, num(d && d.feries)), con = Math.max(0, num(d && d.conges));
    const auto = !d || d.trav === '' || d.trav == null;
    const trav = auto ? Math.max(0, prev - fer - con) : Math.max(0, num(d.trav));
    const abs = Math.max(0, prev - trav - fer - con);
    return { prev, trav, fer, con, abs, auto, over: trav + fer + con > prev + 1e-9 };
  }

  // quotité de travail : 1 = temps plein, 0.5 = mi-temps
  const normQuotite = (q) => { const v = num(q); return v > 0 && v <= 1 ? v : 1; };

  // heures du mois, même forme que normDays ; par défaut 208 h (104 h pour un mi-temps)
  function normHours(h, q) {
    const prev = Math.max(1, num(h && h.prev) || r3(HOURS_FULL * normQuotite(q)));
    const fer = Math.max(0, num(h && h.feries)), con = Math.max(0, num(h && h.conges));
    const auto = !h || h.trav === '' || h.trav == null;
    const trav = auto ? Math.max(0, prev - fer - con) : Math.max(0, num(h.trav));
    const abs = Math.max(0, prev - trav - fer - con);
    return { prev, trav, fer, con, abs, auto, over: trav + fer + con > prev + 1e-9 };
  }

  function irppAnnual(rni, bareme) {
    let tax = 0, prev = 0;
    for (const b of bareme) {
      if (rni > b.from) tax += (rni - b.from) * (b.rate - prev);
      prev = b.rate;
    }
    return tax;
  }

  // ctx : { params, contract, chef, enfants, regime, quotite, days, hours, primes:[{cot,imp,mode:'fixed'|'pct',value}], avance, credit, penal }
  // base = salaire de base MENSUEL d'un TEMPS PLEIN. La quotité (1 = temps plein, 0.5 = mi-temps)
  // réduit de moitié le salaire et les primes ; en régime horaire tout est compté en heures
  // (208 h pour un temps plein, 104 h pour un mi-temps) au lieu de jours.
  function compute(base, ctx) {
    const p = ctx.params, f = p.fiscal;
    const c = p.contracts[ctx.contract] || p.contracts.CDI;
    const q = normQuotite(ctx.quotite);
    const horaire = ctx.regime === REGIMES.HORAIRE;
    const D = normDays(ctx.days);
    const U = horaire ? normHours(ctx.hours, q) : D;              // unités de paie du mois
    // en horaire le taux est au prorata d'un temps plein (208 h) : les 104 h d'un mi-temps
    // donnent déjà la moitié du salaire, la quotité ne s'applique donc qu'aux primes.
    const rate = horaire ? base / HOURS_FULL : r3(base * q) / U.prev;
    const gBase = r3(rate * U.trav);
    const gFer = r3(rate * U.fer);
    const gCon = r3(rate * U.con);
    const gAbs = U.abs > 0 ? -r3(rate * U.abs) : 0;               // information (déjà exclue du gain de base)
    const basePaid = r3(gBase + gFer + gCon);
    const primes = ctx.primes.map((x) => {
      const full = r3((x.mode === 'pct' ? base * num(x.value) : num(x.value)) * q);
      return { ...x, full, amount: r3(full * U.trav / U.prev) };
    });
    const sum = (fn) => primes.reduce((s, x) => s + (fn(x) ? x.amount : 0), 0);
    const totalPrimes = sum(() => true);
    const brut = basePaid + totalPrimes;
    const brutCot = basePaid + sum((x) => x.cot);
    const brutImp = basePaid + sum((x) => x.imp);
    const cnss = r3(brutCot * c.cnssS);
    const impMens = brutImp - cnss;
    const annuel = impMens * 12;
    const abatt = Math.min(annuel * f.abattRate, f.abattCap);
    const deduc = (ctx.chef ? f.chef : 0) + Math.min(ctx.enfants || 0, f.maxEnfants) * f.enfant;
    const rni = Math.max(0, annuel - abatt - deduc);
    const irppA = c.irpp ? irppAnnual(rni, p.bareme) : 0;
    const irpp = r3(irppA / 12);
    const css = c.css && rni > f.cssSeuil ? r3(rni * f.cssRate / 12) : 0;
    const retenues = cnss + irpp + css;
    const net = r3(brut - retenues);
    const autres = num(ctx.avance) + num(ctx.credit) + num(ctx.penal);
    const netAPayer = r3(net - autres);
    const patr = r3(brutCot * c.cnssP), at = r3(brutCot * c.at), tfp = r3(brutCot * c.tfp), fop = r3(brutCot * c.foprolos);
    return {
      base, q, horaire, unit: horaire ? 'h' : 'j', days: D, units: U,
      rate, daily: rate, baseMois: r3(rate * U.prev), gBase, gFer, gCon, gAbs, basePaid,
      primes, totalPrimes: r3(totalPrimes), brut: r3(brut), brutCot: r3(brutCot), brutImp: r3(brutImp),
      cnss, impMens: r3(impMens), annuel, abatt, deduc, rni, irpp, css, retenues: r3(retenues),
      net, autres: r3(autres), netAPayer, patr, at, tfp, fop, cout: r3(brut + patr + at + tfp + fop)
    };
  }

  // salaire de base mensuel d'un temps plein (mois complet) selon le mode du contrat.
  // En régime horaire, le mode BASE attend le TAUX HORAIRE et non un montant mensuel.
  function solveBase(mode, amount, ctx) {
    amount = num(amount);
    const horaire = ctx.regime === REGIMES.HORAIRE;
    if (mode === MODES.BASE) return horaire ? amount * HOURS_FULL : r3(amount);
    const q = normQuotite(ctx.quotite);
    const sumP = (pred, kind) => ctx.primes.reduce((s, x) => s + (pred(x) && x.mode === kind ? num(x.value) : 0), 0);
    // formules directes réservées au cas simple (mensuel, temps plein)
    if (!horaire && q === 1) {
      if (mode === MODES.GROSS) return r3((amount - sumP(() => true, 'fixed')) / (1 + sumP(() => true, 'pct')));
      if (mode === MODES.COT) return r3((amount - sumP((x) => x.cot, 'fixed')) / (1 + sumP((x) => x.cot, 'pct')));
    }
    // sinon recherche dichotomique au millime sur le montant visé (mois complet, avant avance)
    const field = mode === MODES.GROSS ? 'brut' : mode === MODES.COT ? 'brutCot' : 'net';
    const target = r3(amount);
    let hi = Math.max(1000, Math.ceil(Math.max(amount, 1) * 1000));
    for (let i = 0; i < 40 && compute(hi / 1000, ctx)[field] < target; i++) hi *= 2;
    let lo = 0;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (compute(mid / 1000, ctx)[field] >= target) hi = mid; else lo = mid;
    }
    return hi / 1000;
  }

  // retourne le calcul du mois ; .full = même calcul sur un mois complet (sans absence),
  // au même régime et à la même quotité : pour un mi-temps, un mois complet reste un mi-temps.
  function solve(mode, amount, ctx) {
    const fullCtx = Object.assign({}, ctx, {
      days: ctx.days ? { prev: ctx.days.prev } : null,
      hours: ctx.hours ? { prev: ctx.hours.prev } : null
    });
    const base = solveBase(mode, amount, fullCtx);
    const r = compute(base, ctx);
    r.full = compute(base, fullCtx);
    return r;
  }

  const api = { DEFAULT_PARAMS, MODES, REGIMES, HOURS_FULL, compute, solve, solveBase, normDays, normHours, normQuotite, r3, num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WP = api;
})(typeof self !== 'undefined' ? self : this);
