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

  // arrondi au millime (demi vers l'infini, comme ROUND d'Excel)
  const r3 = (x) => (x < 0 ? -1 : 1) * Math.round(Math.abs(x) * 1000 + 1e-7) / 1000;
  const num = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  };

  function irppAnnual(rni, bareme) {
    let tax = 0, prev = 0;
    for (const b of bareme) {
      if (rni > b.from) tax += (rni - b.from) * (b.rate - prev);
      prev = b.rate;
    }
    return tax;
  }

  // ctx : { params, contract, chef, enfants, primes:[{cot,imp,mode:'fixed'|'pct',value}], avance, credit, penal }
  function compute(base, ctx) {
    const p = ctx.params, f = p.fiscal;
    const c = p.contracts[ctx.contract] || p.contracts.CDI;
    const primes = ctx.primes.map((x) => ({
      ...x,
      amount: r3(x.mode === 'pct' ? base * num(x.value) : num(x.value))
    }));
    const sum = (fn) => primes.reduce((s, x) => s + (fn(x) ? x.amount : 0), 0);
    const totalPrimes = sum(() => true);
    const brut = base + totalPrimes;
    const brutCot = base + sum((x) => x.cot);
    const brutImp = base + sum((x) => x.imp);
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
      base, primes, totalPrimes: r3(totalPrimes), brut: r3(brut), brutCot: r3(brutCot), brutImp: r3(brutImp),
      cnss, impMens: r3(impMens), annuel, abatt, deduc, rni, irpp, css, retenues: r3(retenues),
      net, autres: r3(autres), netAPayer, patr, at, tfp, fop, cout: r3(brut + patr + at + tfp + fop)
    };
  }

  // trouve le salaire de base selon le mode du contrat
  function solve(mode, amount, ctx) {
    amount = num(amount);
    const sumP = (pred, kind) => ctx.primes.reduce((s, x) => s + (pred(x) && x.mode === kind ? num(x.value) : 0), 0);
    if (mode === MODES.BASE) return compute(r3(amount), ctx);
    if (mode === MODES.GROSS) {
      return compute(r3((amount - sumP(() => true, 'fixed')) / (1 + sumP(() => true, 'pct'))), ctx);
    }
    if (mode === MODES.COT) {
      return compute(r3((amount - sumP((x) => x.cot, 'fixed')) / (1 + sumP((x) => x.cot, 'pct'))), ctx);
    }
    // NET : recherche dichotomique au millime sur le net avant avance
    const target = r3(amount);
    let lo = 0, hi = Math.ceil(Math.max(amount, 1) * 5000);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (compute(mid / 1000, ctx).net >= target) hi = mid; else lo = mid;
    }
    return compute(hi / 1000, ctx);
  }

  const api = { DEFAULT_PARAMS, MODES, compute, solve, r3, num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WP = api;
})(typeof self !== 'undefined' ? self : this);
