/* Planting Survey - pure maths and data helpers, shared by the app and the node tests. */
(function (root) {
  'use strict';
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // Circular plot area (m2) from radius (m). 5.64 m -> ~100 m2, 7.98 m -> ~200 m2, 3.99 m -> ~50 m2
  function plotArea(radiusM) { return Math.PI * radiusM * radiusM; }
  function radiusForArea(areaM2) { return Math.sqrt(areaM2 / Math.PI); }
  // Survival %: alive / (alive + dead + missing). Missing trees are counted as not surviving
  // (conservative). surviveFound leaves missing ones out (they may be found again later).
  function survivalPct(alive, dead, missing) {
    var n = alive + dead + (missing || 0); return n > 0 ? 100 * alive / n : null;
  }
  function surviveFound(alive, dead) { return survivalPct(alive, dead, 0); }
  // Stems per hectare = live trees counted / plot area (m2) * 10 000
  function stemsPerHa(count, radiusM) { var a = plotArea(radiusM); return a > 0 ? count * 10000 / a : null; }
  function mean(arr) {
    var v = arr.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null;
  }

  function norm360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function angleDiff(a, b) { var d = norm360(a - b); return d > 180 ? d - 360 : d; }
  // Compass bearing of the REAR CAMERA from W3C deviceorientation (alpha absolute, 0 = north). From tree-gauge.
  function cameraHeading(alpha, beta, gamma) {
    var a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
    var ca = Math.cos(a), sa = Math.sin(a), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    var east = -(ca * sg + sa * sb * cg), north = ca * sb * cg - sa * sg;
    if (Math.abs(east) < 1e-9 && Math.abs(north) < 1e-9) return null;
    return norm360(Math.atan2(east, north) * R2D);
  }
  // Great-circle distance (m) and initial bearing (deg) from point 1 to point 2
  function distanceM(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * D2R, p2 = lat2 * D2R, dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    return norm360(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * R2D);
  }
  var DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compassWord(deg) { return deg == null ? '' : DIRS[Math.round(norm360(deg) / 45) % 8]; }

  // Totals for one visit. visit.counts = {species: {alive, dead, missing}}; visit.trees = [{species,h,d,dAt,health}]
  // Measured trees are part of the alive count (adding one adds 1 alive).
  function visitTotals(visit, radiusM) {
    var a = 0, d = 0, m = 0, sp = {};
    Object.keys(visit.counts || {}).forEach(function (k) {
      var c = visit.counts[k]; a += c.alive || 0; d += c.dead || 0; m += c.missing || 0;
      sp[k] = { alive: c.alive || 0, dead: c.dead || 0, missing: c.missing || 0,
        survival: survivalPct(c.alive || 0, c.dead || 0, c.missing || 0) };
    });
    var trees = visit.trees || [];
    var hs = trees.map(function (t) { return t.h; }), ds = trees.map(function (t) { return t.d; });
    var stressed = trees.filter(function (t) { return t.health === 'stressed'; }).length;
    return { alive: a, dead: d, missing: m, total: a + d + m, survival: survivalPct(a, d, m),
      survivalFound: surviveFound(a, d), stemsHa: stemsPerHa(a, radiusM), area: plotArea(radiusM),
      meanH: mean(hs), nH: hs.filter(function (x) { return typeof x === 'number'; }).length,
      meanD: mean(ds), measured: trees.length, stressed: stressed, species: sp };
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // Local time string with offset, e.g. 2026-10-21 20:58 +08:00
  function localStamp(iso) {
    var t = new Date(iso), o = -t.getTimezoneOffset(), s = o >= 0 ? '+' : '-'; o = Math.abs(o);
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) +
      ' ' + s + pad(Math.floor(o / 60)) + ':' + pad(o % 60);
  }
  function csvCell(v) {
    if (v == null) return ''; v = String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function r(x, n) { return x == null ? '' : +x.toFixed(n); }
  var CSV_HEAD = ['row_type', 'site', 'plot', 'plot_lat', 'plot_lon', 'gps_accuracy_m', 'plot_radius_m', 'plot_area_m2',
    'visit_date_utc', 'visit_date_local', 'species', 'status', 'count', 'height_cm', 'stem_diam_mm', 'diam_measured_at',
    'health', 'plot_survival_pct', 'plot_stems_per_ha', 'notes'];
  // One row per species x status count, plus one row per measured tree (measured trees are ALSO inside the alive counts)
  function toCSV(db) {
    var rows = [CSV_HEAD];
    db.visits.slice().sort(function (x, y) { return x.date < y.date ? -1 : 1; }).forEach(function (v) {
      var p = db.plots.filter(function (q) { return q.id === v.plotId; })[0]; if (!p) return;
      var s = db.sites.filter(function (q) { return q.id === p.siteId; })[0] || {};
      var T = visitTotals(v, p.radius);
      var base = [s.name, p.name, p.lat, p.lon, p.acc == null ? '' : Math.round(p.acc), p.radius, r(T.area, 2),
        new Date(v.date).toISOString(), localStamp(v.date)];
      Object.keys(v.counts || {}).forEach(function (k) {
        ['alive', 'dead', 'missing'].forEach(function (st) {
          rows.push(['count'].concat(base, [k, st, v.counts[k][st] || 0, '', '', '', '', r(T.survival, 1), r(T.stemsHa, 0), v.notes || '']));
        });
      });
      (v.trees || []).forEach(function (t) {
        rows.push(['measured_tree'].concat(base, [t.species, 'alive', 1, t.h == null ? '' : t.h, t.d == null ? '' : t.d,
          t.d == null ? '' : (t.dAt === 'dbh' ? '1.3m (DBH)' : 'base'), t.health || '', r(T.survival, 1), r(T.stemsHa, 0), t.note || '']));
      });
    });
    return rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  var api = { plotArea: plotArea, radiusForArea: radiusForArea, survivalPct: survivalPct, surviveFound: surviveFound,
    stemsPerHa: stemsPerHa, mean: mean, norm360: norm360, angleDiff: angleDiff, cameraHeading: cameraHeading,
    distanceM: distanceM, bearingDeg: bearingDeg, compassWord: compassWord, visitTotals: visitTotals,
    localStamp: localStamp, csvCell: csvCell, toCSV: toCSV, CSV_HEAD: CSV_HEAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PS = api;
})(this);
