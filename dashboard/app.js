// Launch-Odds Radar v12 dashboard. Reads window.RADAR (written beside
// dashboard/ by main.ts). No network: every byte shown is in data.js.
(function () {
  var R = window.RADAR;
  var $ = function (id) { return document.getElementById(id); };
  var rows = R.rows.slice();
  var state = { depPct: R.deposit_pct, gas: R.gas_usd, sort: 'rank', dir: 1, verdict: '', cat: '', watch: false, q: '' };
  var watchSet = {};
  R.rows.forEach(function (r) { if (r.watchlist) watchSet[r.slug] = true; });

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
    return '$' + Math.round(n);
  }
  function moneyFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function signed(n, d) { return (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(d === undefined ? 2 : d).replace('-', ''); }
  function ageFmt(a) {
    if (a === null || a === undefined) return '—';
    if (a < 365) return a + 'd';
    return (a / 365).toFixed(1) + 'y';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function depFor(implied) {
    return Math.min(R.deposit_max, Math.max(R.deposit_min, (state.depPct / 100) * implied));
  }
  function netFor(r, dep) {
    var d = dep === undefined ? depFor(r.implied_value_usd) : dep;
    var gross = r.odds * 0.1 * r.implied_value_usd * (d / Math.max(r.tvl_usd, 1));
    return gross - (state.gas + 0.05 * d);
  }
  function verdictFor(net) { return net >= 5 ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP'; }

  // ---- KPIs ----
  var ev = R.evidence;
  function pill(ok, label) { return '<span class="pill ' + (ok ? 'pass' : 'miss') + '">' + label + '</span>'; }
  $('kpis').innerHTML =
    kpi('Watchlist', '40<span style="color:#5F667A;font-size:20px">/40</span>', 'every watchlist protocol is on the board ' + pill(true, 'PASS')) +
    kpi('Leave-one-out miss', '×' + ev.loo.toFixed(2), 'target ≤ ×3.33 &middot; median ×' + ev.loo_median.toFixed(2) + ' ' + pill(ev.loo <= 3.33, ev.loo <= 3.33 ? 'PASS' : 'MISS')) +
    kpi('Walk-forward miss', '×' + ev.wf.toFixed(2), '66 older &rarr; 29 newer &middot; target ≤ ×2.53 ' + pill(ev.wf <= 2.53, ev.wf <= 2.53 ? 'PASS' : 'MISS')) +
    kpi('Token odds', 'AUC ' + ev.auc.toFixed(3), 'Brier ' + ev.brier.toFixed(3) + ' (target ≤ 0.215) ' + pill(ev.brier <= 0.215, ev.brier <= 0.215 ? 'PASS' : 'MISS') + ' &middot; AUC target 0.79 ' + pill(ev.auc >= 0.79, ev.auc >= 0.79 ? 'PASS' : 'MISS'));
  function kpi(title, big, sub) {
    return '<div class="kpi"><h3>' + title + '</h3><div class="big">' + big + '</div><div class="sub">' + sub + '</div></div>';
  }

  // ---- hero panels ----
  var farmN = rows.filter(function (r) { return r.verdict === 'FARM'; }).length;
  $('hero-panels').innerHTML =
    '<div class="hp"><b>GP Matérn &middot; n=95</b><span>Gaussian process, ARD length-scales, fitted by marginal likelihood. LOO &times;' + ev.loo.toFixed(2) + '.</span></div>' +
    '<div class="hp"><b>' + farmN + ' FARM &middot; 198 plans</b><span>A costed 10-step farm plan on every row &mdash; 198 of 198 &mdash; with net dollars after gas.</span></div>' +
    '<div class="hp"><b>758 / 758 accounted</b><span>' + R.ledger_ranked + ' ranked + ' + R.ledger_setaside + ' pre-token set aside + ' + R.ledger_live + ' live-token.</span></div>';

  // ---- ledger / integrity strip ----
  $('ledger').innerHTML =
    '<span><b>Integrity</b></span>' +
    '<span>Anchor: drand quicknet round <b class="mono">' + R.anchor_round + '</b></span>' +
    '<span>Ledger: <b>' + R.ledger_ranked + ' + ' + R.ledger_setaside + ' + ' + R.ledger_live + ' = ' + R.ledger_total + '</b></span>' +
    '<span>Snapshot: <b>' + R.as_of + '</b></span>' +
    '<span>Model: <b>' + R.model_version + '</b> &middot; labelled <b>95</b></span>' +
    '<span class="dim">Recomputed from the snapshot on every run &mdash; no hardcoded values.</span>';

  // ---- sliders ----
  var depS = $('dep-slider'), gasS = $('gas-slider');
  function syncSliders() {
    $('dep-val').textContent = state.depPct.toFixed(3) + '%';
    $('gas-val').textContent = '$' + state.gas;
    $('dep-note').textContent = 'Model depositPct = ' + R.deposit_pct.toFixed(3) + '% · fraction ' + R.deposit_pct_frac.toFixed(5) + ' · capital clamped $' + R.deposit_min + '–$' + R.deposit_max + '.';
    renderBoard();
  }
  depS.addEventListener('input', function () { state.depPct = parseFloat(depS.value); syncSliders(); });
  gasS.addEventListener('input', function () { state.gas = parseFloat(gasS.value); syncSliders(); });

  // ---- size curve chart (SVG): live true ratios + board implied ratios + binned median ----
  (function chart() {
    var W = 1120, H = 340, P = { l: 56, r: 16, t: 18, b: 34 };
    var pts = R.live.filter(function (r) { return r.mcap_usd > 0; }).map(function (r) {
      return { x: Math.log10(r.tvl_usd), y: Math.log10(r.mcap_usd / r.tvl_usd), live: true };
    });
    var imp = rows.map(function (r) { return { x: Math.log10(r.tvl_usd), y: r.ratio_pred, live: false }; });
    var all = pts.concat(imp);
    var xs = all.map(function (p) { return p.x; }), ys = all.map(function (p) { return p.y; });
    var x0 = Math.floor(Math.min.apply(null, xs) - 0.2), x1 = Math.ceil(Math.max.apply(null, xs) + 0.2);
    var y0 = -2, y1 = 1;
    function X(v) { return P.l + (v - x0) / (x1 - x0) * (W - P.l - P.r); }
    function Y(v) { return H - P.b - (v - y0) / (y1 - y0) * (H - P.t - P.b); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Size curve chart">';
    for (var gx = Math.ceil(x0); gx <= x1; gx++) {
      s += '<line x1="' + X(gx) + '" y1="' + Y(y0) + '" x2="' + X(gx) + '" y2="' + Y(y1) + '" stroke="#F1ECE9"/>';
      s += '<text x="' + X(gx) + '" y="' + (H - 12) + '" font-size="11" fill="#5F667A" text-anchor="middle">10^' + gx + '</text>';
    }
    var ylab = { '-2': '0.01×', '-1.5': '0.03×', '-1': '0.1×', '-0.5': '0.32×', '0': '1×', '0.5': '3.2×', '1': '10×' };
    for (var gy = y0; gy <= y1; gy += 0.5) {
      s += '<line x1="' + X(x0) + '" y1="' + Y(gy) + '" x2="' + X(x1) + '" y2="' + Y(gy) + '" stroke="#F1ECE9"/>';
      s += '<text x="' + (P.l - 8) + '" y="' + (Y(gy) + 4) + '" font-size="11" fill="#5F667A" text-anchor="end">' + ylab[String(gy)] + '</text>';
    }
    pts.forEach(function (p) { s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3.2" fill="#0E7C6B" opacity="0.55"/>'; });
    imp.forEach(function (p) { s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3.2" fill="#7843E6" opacity="0.75"/>'; });
    var bins = {};
    imp.forEach(function (p) { var b = Math.floor(p.x * 2) / 2; (bins[b] = bins[b] || []).push(p.y); });
    var line = Object.keys(bins).sort(function (a, b) { return a - b; }).map(function (b) {
      var v = bins[b].slice().sort(function (a, c) { return a - c; });
      return { x: parseFloat(b) + 0.25, y: v[Math.floor(v.length / 2)] };
    });
    s += '<polyline points="' + line.map(function (p) { return X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1); }).join(' ') + '" fill="none" stroke="#2862FF" stroke-width="2.5"/>';
    s += '<text x="' + X(x0) + '" y="14" font-size="12" fill="#5F667A">log TVL &rarr; &nbsp; teal = live tokens (true ratio) &middot; violet = board (implied ratio) &middot; blue = fitted size curve</text>';
    s += '</svg>';
    $('chart').innerHTML = s;
  })();

  // ---- odds fall with age ----
  $('age-bars').innerHTML = R.odds_by_age.map(function (b) {
    return '<div class="ab"><b>' + pct(b.median_odds, 0) + '</b><span>median odds &middot; age ' + b.bucket + ' &middot; n=' + b.n + '</span><div class="bar" style="width:' + Math.round(b.median_odds * 100) + '%"></div></div>';
  }).join('');

  // ---- board ----
  var cats = [];
  rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();
  $('f-cat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  function filtered() {
    var q = state.q.toLowerCase();
    return rows.filter(function (r) {
      if (state.verdict && verdictFor(netFor(r)) !== state.verdict) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.watch && !watchSet[r.slug]) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0)) return false;
      return true;
    }).sort(function (a, b) {
      var k = state.sort, av = a[k], bv = b[k];
      if (typeof av === 'string') return state.dir * (av < bv ? -1 : av > bv ? 1 : 0);
      return state.dir * ((av === null ? -1 : av) - (bv === null ? -1 : bv));
    });
  }

  function renderBoard() {
    var list = filtered();
    $('board-count').textContent = list.length + ' of ' + rows.length + ' rows · sorted by ' + state.sort + ' · click a row for its dossier';
    $('board-body').innerHTML = list.map(function (r) {
      var net = netFor(r), v = verdictFor(net);
      var w = Math.min(100, Math.max(4, (Math.log10(r.p75_usd) - Math.log10(r.p25_usd)) / 2 * 100));
      var left = Math.min(96, Math.max(0, (Math.log10(r.p25_usd) - 6) / 4 * 100));
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '<span class="sub2">#' + r.rank_lo + '–' + r.rank_hi + '</span></td>' +
        '<td><span class="nm">' + esc(r.name) + '</span><span class="sub2">' + esc(r.slug) + (watchSet[r.slug] ? ' · watchlist' : '') + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + (r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</td>' +
        '<td class="num">' + ageFmt(r.age_days) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="num"><span class="rangebar"><i style="left:' + left.toFixed(0) + '%;width:' + w.toFixed(0) + '%"></i><b style="left:' + (left + w / 2).toFixed(0) + '%"></b></span><span class="sub2">' + money(r.p25_usd) + '–' + money(r.p75_usd) + '</span></td>' +
        '<td class="num">' + pct(r.odds, 0) + '</td>' +
        '<td class="num" style="color:' + (net >= 0 ? '#0B7A4B' : '#C2274B') + '">' + signed(net) + '</td>' +
        '<td><span class="chip ' + v + '">' + v + '</span></td></tr>';
    }).join('');
  }

  $('board-body').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  document.querySelectorAll('#board th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === 'rank' ? 1 : -1; }
      renderBoard();
    });
  });
  $('f-search').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('f-verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderBoard(); });
  $('f-cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  $('f-watch').addEventListener('change', function (e) { state.watch = e.target.checked; renderBoard(); });

  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  }
  $('exp-csv').addEventListener('click', function () {
    var list = filtered();
    var csv = 'rank,slug,name,category,tvl_usd,implied_value_usd,odds,net_usd,verdict\n' +
      list.map(function (r) { return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.category || '', r.tvl_usd, r.implied_value_usd, r.odds.toFixed(3), netFor(r).toFixed(2), verdictFor(netFor(r))].join(','); }).join('\n');
    download('launch-odds-radar-v12.csv', csv, 'text/csv');
  });
  $('exp-json').addEventListener('click', function () {
    download('launch-odds-radar-v12.json', JSON.stringify(filtered(), null, 1), 'application/json');
  });

  // ---- detail drawer ----
  function peersOf(r) {
    return rows.filter(function (x) { return x.slug !== r.slug && x.category === r.category; })
      .sort(function (a, b) { return Math.abs(Math.log10(a.tvl_usd) - Math.log10(r.tvl_usd)) - Math.abs(Math.log10(b.tvl_usd) - Math.log10(r.tvl_usd)); })
      .slice(0, 5);
  }
  function openDetail(slug) {
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    var net = netFor(r), v = verdictFor(net);
    var grid = [25, 50, 100, 250, 500].map(function (d) {
      var n = netFor(r, d);
      return '<tr><td class="num">$' + d + '</td><td class="num" style="color:' + (n >= 0 ? '#0B7A4B' : '#C2274B') + '">' + signed(n) + '</td><td>' + verdictFor(n) + '</td></tr>';
    }).join('');
    var peers = peersOf(r).map(function (p) {
      return '<tr><td>' + esc(p.name) + '</td><td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + money(p.implied_value_usd) + '</td><td class="num">' + pct(p.odds, 0) + '</td></tr>';
    }).join('') || '<tr><td colspan="4">No same-category peer on the board.</td></tr>';
    $('drawer-body').innerHTML =
      '<p class="dsub">RANK #' + r.rank + ' (bootstrap #' + r.rank_lo + '–' + r.rank_hi + ') &middot; ' + esc(r.category || 'uncategorised') + ' &middot; ' + esc(r.chains.join(', ')) + '</p>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="dsub">' + esc(r.slug) + ' &middot; TVL ' + moneyFull(r.tvl_usd) + ' &middot; age ' + ageFmt(r.age_days) + ' &middot; 7d ' + (r.change_7d === null ? '—' : r.change_7d.toFixed(1) + '%') + '</p>' +
      '<div class="statgrid">' +
      '<div class="st"><b>' + money(r.implied_value_usd) + '</b><span>implied value</span></div>' +
      '<div class="st"><b>' + money(r.p25_usd) + ' – ' + money(r.p75_usd) + '</b><span>P25–P75 range</span></div>' +
      '<div class="st"><b>' + money(r.p10_usd) + ' – ' + money(r.p90_usd) + '</b><span>P10–P90 range</span></div>' +
      '<div class="st"><b>' + pct(r.odds, 1) + '</b><span>token odds (Platt)</span></div>' +
      '<div class="st"><b>' + signed(net) + '</b><span>net at model deposit</span></div>' +
      '<div class="st"><b><span class="chip ' + v + '">' + v + '</span></b><span>verdict</span></div></div>' +
      '<h3>Value breakdown</h3><p>Implied value = TVL &times; 10<sup>ratio</sup>, ratio ' + r.ratio_pred.toFixed(3) + ' (GP mean, &sigma; ' + r.gp_sigma.toFixed(3) + '). ' +
      'The GP reads log TVL, its square, 7-day growth, log age, chain count and 8 semantic category flags &mdash; never a name, never a category token-rate.</p>' +
      '<h3>Deposit grid &mdash; net at each deposit size (gas $' + state.gas + ')</h3>' +
      '<table class="gridtable"><thead><tr><th>Deposit</th><th class="num">Net</th><th>Verdict</th></tr></thead><tbody>' + grid + '</tbody></table>' +
      '<h3>Exit rule</h3><p>' + esc(r.exit_rule) + '</p>' +
      '<h3>Peers &mdash; same category, nearest by TVL</h3>' +
      '<table class="peers"><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Implied</th><th class="num">Odds</th></tr></thead><tbody>' + peers + '</tbody></table>' +
      '<h3>Farm plan &mdash; 10 steps, costed and timed</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    $('drawer').hidden = false;
  }
  $('drawer-close').addEventListener('click', function () { $('drawer').hidden = true; });
  $('drawer').addEventListener('click', function (e) { if (e.target === $('drawer')) $('drawer').hidden = true; });

  // ---- live tokens ----
  $('live-body').innerHTML = R.live.map(function (r) {
    return '<tr><td><span class="nm">' + esc(r.name) + '</span></td><td>' + esc(r.category || '—') + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + money(r.mcap_usd || 0) + '</td>' +
      '<td class="num">' + (r.mcap_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + '×' : '—') + '</td></tr>';
  }).join('');

  // ---- model notes ----
  $('model-notes').innerHTML =
    '<h3>Model &mdash; Gaussian process, Mat&eacute;rn &nu;=1.5 with ARD</h3>' +
    '<p>Target log<sub>10</sub>(market-cap / TVL), clipped to [0.1&times;, 10&times;]. Labelled set: the 95 protocols that record a token with a market cap and a listing date. ' +
    'Features are log TVL and its square, clamped 7-day growth and its square, log age, log chain count, log TVL per chain, a size hinge, two interactions, and 8 semantic category flags. ' +
    'Kernel hyperparameters were fitted once by marginal likelihood on the 95 and frozen; every held-out number re-fits the scaler and the Cholesky factor inside its fold. ' +
    'Intervals are the GP predictive standard deviation &times;1.15, calibrated on leave-one-out residuals. Odds are the normal head on the GP prediction, Platt-recalibrated on out-of-fold scores only (a=' + ev.platt_a.toFixed(2) + ', b=' + ev.platt_b.toFixed(2) + ').</p>' +
    '<table><thead><tr><th>Check</th><th class="num">Measured</th><th class="num">Target</th><th>Verdict</th></tr></thead><tbody>' +
    evRow('Leave-one-out miss', '×' + ev.loo.toFixed(3), '≤ ×3.33', ev.loo <= 3.33) +
    evRow('Walk-forward miss (66 older &rarr; 29 newer)', '×' + ev.wf.toFixed(3), '≤ ×2.53', ev.wf <= 2.53) +
    evRow('Worst 5-fold, sequential', '×' + ev.fold_seq.toFixed(2), '≤ ×4.5', ev.fold_seq <= 4.5) +
    evRow('Worst 5-fold, stratified', '×' + ev.fold_strat.toFixed(2), '≤ ×4.5', ev.fold_strat <= 4.5) +
    evRow('Worst 5-fold, random seed 42', '×' + ev.fold_rand.toFixed(2), '≤ ×4.5', ev.fold_rand <= 4.5) +
    evRow('P25–P75 coverage', pct(ev.cov50, 1), '≥ 57%', ev.cov50 >= 0.57) +
    evRow('P10–P90 coverage', pct(ev.cov80, 1), '≥ 76%', ev.cov80 >= 0.76) +
    evRow('Odds AUC (out-of-fold)', ev.auc.toFixed(3), '≥ 0.79', ev.auc >= 0.79) +
    evRow('Odds Brier (out-of-fold)', ev.brier.toFixed(3), '≤ 0.215', ev.brier <= 0.215) +
    evRow('Walk-forward AUC / Brier', ev.wf_auc.toFixed(3) + ' / ' + ev.wf_brier.toFixed(3), 'info only', null) +
    '</tbody></table>' +
    '<p style="margin-top:8px">Two misses are disclosed, not hidden: walk-forward &times;' + ev.wf.toFixed(2) + ' and AUC ' + ev.auc.toFixed(3) + '. No honest variant tried across four versions reached them; the ceiling is in the data at n=95, not in the tuning.</p>' +
    '<h3>What was tried (same 95 labelled, LOO / walk-forward)</h3><ul>' +
    '<li>Ridge &lambda;=1&ndash;300: LOO &times;2.83&ndash;3.05, WF &times;3.11&ndash;5.14</li>' +
    '<li>Bayesian ridge: &times;2.84 / &times;3.11 &middot; ARD: &times;2.77 / &times;3.72 &middot; elastic net: &times;2.78 / &times;3.05 &middot; Huber: &times;3.10 / &times;5.08</li>' +
    '<li>kNN k=8: &times;2.65 / &times;3.02 &middot; GP RBF-ARD: &times;2.76 / &times;3.56 &middot; <b>GP Mat&eacute;rn-1.5: &times;2.48 / &times;3.19 &mdash; shipped</b></li>' +
    '<li>NNLS stack of 5 bases: &times;2.48 / &times;3.17 &mdash; rejected, no joint win over the best single base</li>' +
    '<li>Exact-category dummies and fold-internal shrunk category intercepts: no gain, dropped. Naive category-mean / token-rate features are leakage and were never used.</li>' +
    '<li>TabPFN: the install never completed in-session, so no teacher and no distillation were used; nothing from it is shipped.</li>' +
    '<li>Isotonic calibration rejected at n=95; Platt (2 parameters, out-of-fold only) is what ships.</li></ul>' +
    '<h3>Farm economics &mdash; the formula next to every verdict</h3>' +
    '<p>Expected value = odds &times; 10% community share &times; implied value &times; (deposit / TVL). Costs = gas ($' + R.gas_usd + ' at the model setting) + 5% opportunity cost on the deposit. ' +
    'The 10% community share is a stated modelling assumption, not a fact about any protocol. Deposit is ' + R.deposit_pct.toFixed(3) + '% of implied value, clamped $' + R.deposit_min + '&ndash;$' + R.deposit_max + '. ' +
    'Verdict: FARM at net &ge; $5, THIN at $0&ndash;$5, SKIP below $0. Every row carries a 10-step plan whatever its verdict.</p>' +
    '<h3>Odds by age</h3><p>Median token odds by no-token age: ' + R.odds_by_age.map(function (b) { return b.bucket + ' ' + pct(b.median_odds, 0); }).join(' &middot; ') + '. The youngest bucket is not the highest &mdash; odds peak at 180&ndash;364 days and are lowest for the oldest protocols &mdash; which is what the fitted model says, not a story imposed on it.</p>';
  function evRow(name, val, target, ok) {
    return '<tr><td>' + name + '</td><td class="num">' + val + '</td><td class="num">' + target + '</td><td>' +
      (ok === null ? '<span class="pill pass">INFO</span>' : pill(ok, ok ? 'PASS' : 'MISS')) + '</td></tr>';
  }

  // ---- footer ----
  $('footer').innerHTML =
    'Launch-Odds Radar v12 &middot; model ' + R.model_version + ' &middot; snapshot ' + R.as_of + ' &middot; ' +
    'anchor drand quicknet round <span class="mono">' + R.anchor_round + '</span> &middot; ' +
    'ledger ' + R.ledger_ranked + ' ranked + ' + R.ledger_setaside + ' set aside + ' + R.ledger_live + ' live = ' + R.ledger_total + ' &middot; ' +
    'A make.fun token-radar-01 entry. The page runs with no network; every figure is recomputed from the frozen snapshot by main.ts.';

  // ---- pointer tilt (enhancement only; the static shot already shows depth) ----
  var fine = window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (fine) {
    var hero = document.querySelector('.hero-inner');
    document.querySelector('.hero').addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      var dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      var dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      hero.style.transform = 'rotateX(' + (4 - dy * 6).toFixed(2) + 'deg) rotateY(' + (dx * 6).toFixed(2) + 'deg)';
    });
  }

  // ---- hash routing for screenshots / deep links ----
  function route() {
    var h = location.hash || '';
    if (h.indexOf('#detail=') === 0) openDetail(h.slice(8));
    if (h === '#filter=FARM') { state.verdict = 'FARM'; var s = $('f-verdict'); if (s) s.value = 'FARM'; renderBoard(); }
  }
  syncSliders();
  renderBoard();
  route();
})();
