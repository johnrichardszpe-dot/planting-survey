/* Planting Survey - UI. Data in IndexedDB on the phone only. */
(function () {
  'use strict';
  var VERSION = '0.1.0';
  var lang = (navigator.language || 'en').slice(0, 2); if (!STRINGS[lang]) lang = 'en';
  function t(k, v) {
    var s = (STRINGS[lang] && STRINGS[lang][k]) || STRINGS.en[k] || k;
    if (v) Object.keys(v).forEach(function (n) { s = s.split('{' + n + '}').join(v[n]); });
    return s;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  var main = $('main');
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmt(x, n) { return x == null ? '–' : (+x).toFixed(n); }
  function pct(x) { return x == null ? '–' : Math.round(x) + '%'; }
  function day(iso) { return iso ? PS.localStamp(iso).slice(0, 10) : ''; }
  function toast(msg) { var e = $('toast'); e.textContent = msg; e.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(function () { e.hidden = true; }, 2600); }

  // ---------- storage (IndexedDB) ----------
  var STORES = ['sites', 'plots', 'visits', 'photos'];
  var DB = { sites: [], plots: [], visits: [], photos: [] }, idb = null;
  function openDB() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no idb'));
      var q = indexedDB.open('planting-survey', 1);
      q.onupgradeneeded = function () { STORES.forEach(function (s) { if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s, { keyPath: 'id' }); }); };
      q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); };
    });
  }
  function tx(store, mode, fn) {
    return new Promise(function (res, rej) {
      if (!idb) return res();
      var x = idb.transaction(store, mode), r = fn(x.objectStore(store));
      x.oncomplete = function () { res(r && r.result); }; x.onerror = function () { rej(x.error); };
    });
  }
  function put(store, obj) {
    var arr = DB[store], i = arr.findIndex(function (o) { return o.id === obj.id; });
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    return tx(store, 'readwrite', function (s) { s.put(obj); }).catch(function () { toast(t('storageWarn')); });
  }
  function del(store, id) {
    DB[store] = DB[store].filter(function (o) { return o.id !== id; });
    return tx(store, 'readwrite', function (s) { s.delete(id); });
  }
  function loadAll() {
    return Promise.all(STORES.map(function (s) { return tx(s, 'readonly', function (st) { return st.getAll(); }).then(function (r) { DB[s] = r || []; }); }));
  }
  function get(store, id) { return DB[store].filter(function (o) { return o.id === id; })[0]; }
  function plotsOf(siteId) { return DB.plots.filter(function (p) { return p.siteId === siteId; }).sort(function (a, b) { return a.created < b.created ? -1 : 1; }); }
  function visitsOf(plotId) { return DB.visits.filter(function (v) { return v.plotId === plotId; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }
  function photosOf(plotId) { return DB.photos.filter(function (p) { return p.plotId === plotId; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }

  // ---------- sensors ----------
  var heading = null, gotAbs = false, compassOn = false;
  function onOrient(e, abs) {
    var a = e.webkitCompassHeading != null ? null : e.alpha;
    if (e.webkitCompassHeading != null) { // iOS: heading of the top edge; adjust for camera when upright
      heading = PS.norm360(e.webkitCompassHeading); if (window.onHeading) window.onHeading(); return;
    }
    if (a == null || (!abs && !e.absolute)) return;
    var h = PS.cameraHeading(a, e.beta || 0, e.gamma || 0);
    if (h == null) h = PS.norm360(360 - a); // flat phone: direction of top edge
    heading = h; if (window.onHeading) window.onHeading();
  }
  function startCompass() {
    if (compassOn) return; compassOn = true;
    var go = function () {
      if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', function (e) { gotAbs = true; onOrient(e, true); });
      addEventListener('deviceorientation', function (e) { if (!gotAbs) onOrient(e, false); });
    };
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(go, go);
    } else go();
  }
  var gpsWatch = null;
  function stopGps() { if (gpsWatch != null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
  // Watch GPS and report the best (smallest error) fix so far
  function bestGps(cb, fail) {
    stopGps(); if (!navigator.geolocation) return fail();
    var best = null;
    gpsWatch = navigator.geolocation.watchPosition(function (p) {
      if (!best || p.coords.accuracy <= best.acc) best = { lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6), acc: p.coords.accuracy, live: p.coords };
      cb(best, p.coords);
    }, function () { fail(); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }

  // ---------- file helpers ----------
  function download(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    toast(t('exported', { f: name }));
  }
  function stamp() { return PS.localStamp(new Date().toISOString()).slice(0, 10); }
  function exportCSV() {
    if (!DB.visits.length) return toast(t('nothing'));
    download('planting-survey-' + stamp() + '.csv', new Blob(['\ufeff' + PS.toCSV(DB)], { type: 'text/csv' }));
  }
  function blobToData(b) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.readAsDataURL(b); }); }
  function dataToBlob(d) { return fetch(d).then(function (r) { return r.blob(); }); }
  function backup() {
    var withPhotos = DB.photos.length && confirm(t('backupPhotos'));
    var ph = withPhotos ? Promise.all(DB.photos.map(function (p) { return blobToData(p.blob).then(function (d) { var c = Object.assign({}, p); delete c.blob; c.data = d; return c; }); })) : Promise.resolve([]);
    ph.then(function (photos) {
      var o = { app: 'planting-survey', version: VERSION, exported: new Date().toISOString(), sites: DB.sites, plots: DB.plots, visits: DB.visits, photos: photos };
      download('planting-survey-backup-' + stamp() + '.json', new Blob([JSON.stringify(o)], { type: 'application/json' }));
    });
  }
  function restore(file) {
    var r = new FileReader();
    r.onload = function () {
      var o; try { o = JSON.parse(r.result); } catch (e) { o = null; }
      if (!o || o.app !== 'planting-survey') return toast(t('badFile'));
      var n = 0, jobs = [];
      ['sites', 'plots', 'visits'].forEach(function (s) { (o[s] || []).forEach(function (x) { n++; jobs.push(put(s, x)); }); });
      (o.photos || []).forEach(function (p) { n++; jobs.push(dataToBlob(p.data).then(function (b) { var c = Object.assign({}, p); delete c.data; c.blob = b; return put('photos', c); })); });
      Promise.all(jobs).then(function () { toast(t('restored', { n: n })); render(); });
    };
    r.readAsText(file);
  }
  function summaryText(site) {
    var L = [t('summaryHead', { site: site.name })];
    L.push(t('summarySite', { date: site.plantDate || '?', n: site.target || '?' }));
    var S = siteStats(site);
    S.rows.forEach(function (r) {
      L.push(t('summaryPlot', { plot: r.plot.name, area: fmt(r.T.area, 0), date: day(r.v.date), alive: r.T.alive, dead: r.T.dead, missing: r.T.missing,
        surv: pct(r.T.survival), ha: fmt(r.T.stemsHa, 0), h: r.T.meanH == null ? '' : t('summaryAvgH', { h: fmt(r.T.meanH, 0) }) }));
    });
    if (S.rows.length) L.push(t('summaryAll', { surv: pct(S.survival), ha: fmt(S.stemsHa, 0) }));
    if (S.est != null) L.push(t('summaryEst', { n: Math.round(S.est) }));
    L.push('— ' + t('appName') + ' (free) ' + location.href.split('#')[0]);
    return L.join('\n');
  }
  function shareSummary(site) {
    var txt = summaryText(site);
    if (navigator.share) { navigator.share({ title: t('appName'), text: txt }).catch(function () {}); return; }
    sheet('<h2>' + esc(t('share')) + '</h2><textarea id="sumTxt" rows="12" readonly>' + esc(txt) + '</textarea><button class="go" id="cp">Copy</button><button data-close>' + t('close') + '</button>', function () {
      $('cp').onclick = function () { $('sumTxt').select(); (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { toast(t('copied')); }, function () { document.execCommand('copy'); toast(t('copied')); }); };
    });
  }
  // Pooled totals over the latest survey of each plot
  function siteStats(site) {
    var rows = [], a = 0, n = 0, area = 0;
    plotsOf(site.id).forEach(function (p) {
      var vs = visitsOf(p.id); if (!vs.length) return;
      var v = vs[vs.length - 1], T = PS.visitTotals(v, p.radius);
      rows.push({ plot: p, v: v, T: T }); a += T.alive; n += T.total; area += T.area;
    });
    var ha = area ? a * 10000 / area : null;
    return { rows: rows, survival: PS.survivalPct(a, n - a, 0), stemsHa: ha, est: (ha != null && site.areaHa) ? ha * site.areaHa : null };
  }

  // ---------- sheet (pop-up panel) ----------
  function sheet(html, init) {
    var s = $('sheet'); s.innerHTML = '<div class="panel">' + html + '</div>'; s.hidden = false;
    s.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = closeSheet; });
    if (init) init(s);
  }
  function closeSheet() { $('sheet').hidden = true; $('sheet').innerHTML = ''; }

  // ---------- chart (SVG) ----------
  function chart(plot) {
    var vs = visitsOf(plot.id); if (!vs.length) return '';
    var W = 340, H = 180, L = 34, R = 36, T0 = 14, B = 26;
    var pts = vs.map(function (v) { var T = PS.visitTotals(v, plot.radius); return { x: new Date(v.date).getTime(), s: T.survival, h: T.meanH }; });
    var x0 = pts[0].x, x1 = pts[pts.length - 1].x; if (x1 === x0) { x0 -= 864e5; x1 += 864e5; }
    var hMax = Math.max.apply(null, pts.map(function (p) { return p.h || 0; }).concat([10])); hMax = Math.ceil(hMax / 10) * 10;
    var X = function (x) { return L + (x - x0) / (x1 - x0) * (W - L - R); };
    var Ys = function (s) { return T0 + (1 - s / 100) * (H - T0 - B); }, Yh = function (h) { return T0 + (1 - h / hMax) * (H - T0 - B); };
    var g = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(t('chart')) + '">';
    [0, 50, 100].forEach(function (s) { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Ys(s) + '" y2="' + Ys(s) + '" class="grid"/><text x="' + (L - 4) + '" y="' + (Ys(s) + 4) + '" class="ax s" text-anchor="end">' + s + '%</text>'; });
    [0, hMax / 2, hMax].forEach(function (h) { g += '<text x="' + (W - R + 4) + '" y="' + (Yh(h) + 4) + '" class="ax h">' + Math.round(h) + '</text>'; });
    g += '<text x="' + L + '" y="' + (H - 6) + '" class="ax">' + day(new Date(x0).toISOString()) + '</text><text x="' + (W - R) + '" y="' + (H - 6) + '" class="ax" text-anchor="end">' + day(new Date(x1).toISOString()) + '</text>';
    function line(key, Y, cls) {
      var q = pts.filter(function (p) { return p[key] != null; }); if (!q.length) return '';
      var s = '<polyline class="' + cls + '" points="' + q.map(function (p) { return X(p.x).toFixed(1) + ',' + Y(p[key]).toFixed(1); }).join(' ') + '"/>';
      q.forEach(function (p) { s += '<circle class="' + cls + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p[key]).toFixed(1) + '" r="4"/>'; });
      return s;
    }
    g += line('h', Yh, 'lh') + line('s', Ys, 'ls') + '</svg>';
    return '<div class="card"><h3>' + t('chart') + '</h3>' + g + '<div class="legend"><span class="ls">● ' + t('chartSurv') + '</span> <span class="lh">● ' + t('chartH') + '</span></div>' + (vs.length < 2 ? '<p class="small">' + t('oneVisit') + '</p>' : '') + '</div>';
  }

  // ---------- views ----------
  var cleanup = null;
  function go(h) { location.hash = h; }
  function render() {
    if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
    stopGps(); window.onHeading = null; closeSheet();
    var h = location.hash.replace(/^#\/?/, '').split('/'), v = h[0] || '', id = h[1];
    document.body.className = 'v-' + (v || 'home');
    if (v === 'site' && get('sites', id)) viewSite(get('sites', id));
    else if (v === 'site-edit') viewSiteEdit(id === 'new' ? null : get('sites', id));
    else if (v === 'plot-new' && get('sites', id)) viewPlotEdit(get('sites', id), null);
    else if (v === 'plot-edit' && get('plots', id)) viewPlotEdit(get('sites', get('plots', id).siteId), get('plots', id));
    else if (v === 'plot' && get('plots', id)) viewPlot(get('plots', id));
    else if (v === 'visit' && get('visits', id)) viewVisit(get('visits', id));
    else if (v === 'find' && get('plots', id)) viewFind(get('plots', id));
    else if (v === 'photo' && get('plots', id)) viewPhoto(get('plots', id));
    else if (v === 'about') viewAbout();
    else viewHome();
    window.scrollTo(0, 0);
  }
  function top(title, backTo) {
    return '<header class="bar">' + (backTo != null ? '<a class="back" href="#' + backTo + '">' + t('back') + '</a>' : '<img src="icons/icon-192.png" alt="" class="logo">') +
      '<h1>' + esc(title) + '</h1>' + (backTo == null ? '<a class="back" href="#about">ⓘ</a>' : '') + '</header>';
  }

  function viewHome() {
    var h = top(t('appName')) + '<p class="lead">' + t('tagline') + '</p><h2>' + t('sites') + '</h2>';
    if (!DB.sites.length) h += '<p class="empty">' + t('noSites') + '</p>';
    DB.sites.slice().sort(function (a, b) { return a.created < b.created ? -1 : 1; }).forEach(function (s) {
      var S = siteStats(s);
      h += '<a class="item" href="#site/' + s.id + '"><b>' + esc(s.name) + '</b><span>' + t('plotsN', { n: plotsOf(s.id).length }) +
        (S.rows.length ? ' · ' + t('survival') + ' ' + pct(S.survival) : '') + '</span></a>';
    });
    h += '<a class="btn go" href="#site-edit/new">' + t('newSite') + '</a>' +
      '<div class="row"><button id="bCsv">' + t('exportCsv') + '</button></div><div class="row"><button id="bBak">' + t('backup') + '</button><button id="bRes">' + t('restore') + '</button></div>' +
      '<input type="file" id="fRes" accept=".json,application/json" hidden><div class="card"><h3>' + t('howTo') + '</h3>' + t('howToText') + '<p class="small">' + t('install') + '</p></div>';
    main.innerHTML = h;
    $('bCsv').onclick = exportCSV; $('bBak').onclick = backup;
    $('bRes').onclick = function () { $('fRes').click(); }; $('fRes').onchange = function () { if (this.files[0]) restore(this.files[0]); };
  }

  function viewSiteEdit(s) {
    var n = !s; s = s || { id: uid(), name: '', plantDate: '', species: [], target: '', areaHa: '', notes: '', created: new Date().toISOString() };
    main.innerHTML = top(n ? t('newSite').replace('+ ', '') : t('editSite'), n ? '' : 'site/' + s.id) +
      '<form id="f" class="form"><label>' + t('siteName') + '<input name="name" required value="' + esc(s.name) + '"></label>' +
      '<label>' + t('plantDate') + '<input type="date" name="plantDate" value="' + esc(s.plantDate) + '"></label>' +
      '<label>' + t('speciesList') + '<textarea name="species" rows="4" placeholder="' + esc(t('speciesHint')) + '">' + esc((s.species || []).join('\n')) + '</textarea></label>' +
      '<label>' + t('target') + '<input type="number" inputmode="numeric" min="0" name="target" value="' + esc(s.target) + '"></label>' +
      '<label>' + t('siteArea') + '<input type="number" inputmode="decimal" min="0" step="any" name="areaHa" value="' + esc(s.areaHa) + '"></label>' +
      '<label>' + t('notes') + '<textarea name="notes" rows="3">' + esc(s.notes) + '</textarea></label>' +
      '<button class="go" type="submit">' + t('save') + '</button>' + (n ? '' : '<button type="button" class="bad" id="bDel">' + t('del') + '</button>') + '</form>';
    $('f').onsubmit = function (e) {
      e.preventDefault(); var f = e.target;
      if (!f.name.value.trim()) return toast(t('needName'));
      s.name = f.name.value.trim(); s.plantDate = f.plantDate.value; s.notes = f.notes.value;
      s.species = f.species.value.split(/\n|,/).map(function (x) { return x.trim(); }).filter(Boolean);
      s.target = f.target.value === '' ? '' : +f.target.value; s.areaHa = f.areaHa.value === '' ? '' : +f.areaHa.value;
      put('sites', s).then(function () { go('site/' + s.id); });
    };
    if (!n) $('bDel').onclick = function () {
      if (!confirm(t('confirmDelSite', { name: s.name }))) return;
      plotsOf(s.id).forEach(function (p) { visitsOf(p.id).forEach(function (v) { del('visits', v.id); }); photosOf(p.id).forEach(function (x) { del('photos', x.id); }); del('plots', p.id); });
      del('sites', s.id).then(function () { go(''); });
    };
  }

  function viewSite(s) {
    var S = siteStats(s), h = top(s.name, '');
    h += '<div class="card"><p>' + t('plantDate') + ': <b>' + esc(s.plantDate || '–') + '</b><br>' + t('target').split('(')[0] + ': <b>' + esc(s.target || '–') + '</b>' +
      (s.species.length ? '<br>' + esc(s.species.join(', ')) : '') + (s.notes ? '<br><i>' + esc(s.notes) + '</i>' : '') + '</p><a class="btn small" href="#site-edit/' + s.id + '">' + t('edit') + '</a></div>';
    if (S.rows.length) h += '<div class="totals"><div><b>' + pct(S.survival) + '</b><span>' + t('survival') + '</span></div><div><b>' + fmt(S.stemsHa, 0) + '</b><span>' + t('stemsHa') + '</span></div>' +
      (S.est != null ? '<div><b>' + Math.round(S.est) + '</b><span>' + t('estTrees') + '</span></div>' : '') + '</div><p class="small">' + t('latest') + '</p>';
    h += '<h2>' + t('plots') + '</h2>';
    var ps = plotsOf(s.id); if (!ps.length) h += '<p class="empty">' + t('noPlots') + '</p>';
    ps.forEach(function (p) {
      var vs = visitsOf(p.id), T = vs.length ? PS.visitTotals(vs[vs.length - 1], p.radius) : null;
      h += '<a class="item" href="#plot/' + p.id + '"><b>' + esc(p.name) + '</b><span>' + t('visitsN', { n: vs.length }) + (T ? ' · ' + pct(T.survival) + ' · ' + t('lastSurvey', { d: day(vs[vs.length - 1].date) }) : '') + '</span></a>';
    });
    h += '<a class="btn go" href="#plot-new/' + s.id + '">' + t('newPlot') + '</a><div class="row"><button id="bSh">' + t('share') + '</button><button id="bCsv">' + t('exportCsv') + '</button></div>';
    main.innerHTML = h; $('bSh').onclick = function () { shareSummary(s); }; $('bCsv').onclick = exportCSV;
  }

  var RADII = [2, 3.99, 5.64, 7.98];
  function viewPlotEdit(site, p) {
    var n = !p; p = p || { id: uid(), siteId: site.id, name: 'Plot ' + (plotsOf(site.id).length + 1), radius: 5.64, lat: null, lon: null, acc: null, notes: '', created: new Date().toISOString() };
    var custom = RADII.indexOf(p.radius) < 0;
    var h = top(n ? t('newPlot').replace('+ ', '') : p.name, n ? 'site/' + site.id : 'plot/' + p.id) + '<form id="f" class="form"><label>' + t('plotName') + '<input name="name" value="' + esc(p.name) + '"></label>' +
      '<fieldset><legend>' + t('radius') + '</legend><div class="choices">' + RADII.map(function (r) {
        return '<label class="choice"><input type="radio" name="rad" value="' + r + '"' + (p.radius === r ? ' checked' : '') + '><span>' + r + ' m<small>' + t('area', { a: fmt(PS.plotArea(r), 0) }) + '</small></span></label>';
      }).join('') + '<label class="choice"><input type="radio" name="rad" value="c"' + (custom ? ' checked' : '') + '><span>…<small><input name="cr" type="number" step="any" min="0.5" inputmode="decimal" placeholder="m" value="' + (custom ? p.radius : '') + '"></small></span></label></div><p class="small">' + t('radiusInfo') + '</p></fieldset>' +
      '<fieldset><legend>' + t('gps') + '</legend><p id="gpsTxt">' + (p.lat != null ? t('gpsGot', { acc: Math.round(p.acc) }) + ' (' + p.lat + ', ' + p.lon + ')' : t('gpsNone')) + '</p><button type="button" id="bGps" class="go">' + t('getGps') + '</button></fieldset>' +
      '<label>' + t('notes') + '<textarea name="notes" rows="2">' + esc(p.notes) + '</textarea></label><button class="go" type="submit">' + t('save') + '</button>' +
      (n ? '' : '<button type="button" class="bad" id="bDel">' + t('del') + '</button>') + '</form><div class="card"><h3>' + t('markHelpTitle') + '</h3>' + t('markHelp') + '</div>';
    main.innerHTML = h;
    var running = false;
    $('bGps').onclick = function () {
      if (running) { stopGps(); running = false; this.textContent = t('getGps'); return; }
      running = true; this.textContent = t('gpsStop'); $('gpsTxt').textContent = t('gpsWait');
      bestGps(function (b) {
        p.lat = b.lat; p.lon = b.lon; p.acc = b.acc;
        $('gpsTxt').textContent = t('gpsGot', { acc: Math.round(b.acc) }) + ' (' + b.lat + ', ' + b.lon + ')';
        if (b.acc <= 4) { stopGps(); running = false; $('bGps').textContent = t('getGps'); }
      }, function () { running = false; $('bGps').textContent = t('getGps'); if (p.lat == null) $('gpsTxt').textContent = t('gpsFail'); });
    };
    $('f').onsubmit = function (e) {
      e.preventDefault(); var f = e.target, r = f.querySelector('[name=rad]:checked');
      var rad = r && r.value !== 'c' ? +r.value : +f.cr.value;
      if (!(rad > 0)) rad = 5.64;
      p.name = f.name.value.trim() || p.name; p.radius = rad; p.notes = f.notes.value;
      put('plots', p).then(function () { go('plot/' + p.id); });
    };
    if (!n) $('bDel').onclick = function () {
      if (!confirm(t('confirmDel'))) return;
      visitsOf(p.id).forEach(function (v) { del('visits', v.id); }); photosOf(p.id).forEach(function (x) { del('photos', x.id); });
      del('plots', p.id).then(function () { go('site/' + site.id); });
    };
  }

  var urls = [];
  function thumbURL(ph) { var u = URL.createObjectURL(ph.blob); urls.push(u); return u; }
  function freeURLs() { urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = []; }
  function viewPlot(p) {
    var site = get('sites', p.siteId), vs = visitsOf(p.id), ph = photosOf(p.id);
    var h = top(p.name, 'site/' + p.siteId) + '<div class="card"><p>' + esc(site.name) + '<br>' + t('radius') + ': <b>' + p.radius + ' m</b> (' + t('area', { a: fmt(PS.plotArea(p.radius), 1) }) + ')<br>' +
      (p.lat != null ? 'GPS: ' + p.lat + ', ' + p.lon + ' (±' + Math.round(p.acc) + ' m)' : t('noPlotGps')) + (p.notes ? '<br><i>' + esc(p.notes) + '</i>' : '') + '</p><a class="btn small" href="#plot-edit/' + p.id + '">' + t('edit') + '</a></div>' +
      '<button class="go big" id="bNew">' + t('newSurvey') + '</button><div class="row"><a class="btn" href="#photo/' + p.id + '">' + t('photoPoint') + '</a><a class="btn" href="#find/' + p.id + '">' + t('findPlot') + '</a></div>';
    h += chart(p) + '<h2>' + t('surveys') + '</h2>';
    if (!vs.length) h += '<p class="empty">' + t('noSurveys') + '</p>';
    vs.slice().reverse().forEach(function (v) {
      var T = PS.visitTotals(v, p.radius);
      h += '<a class="item" href="#visit/' + v.id + '"><b>' + PS.localStamp(v.date).slice(0, 16) + '</b><span>' + T.alive + ' ' + t('alive').toLowerCase() + ' · ' + T.dead + ' ' + t('dead').toLowerCase() + ' · ' + T.missing + ' ' + t('missing').toLowerCase() +
        ' · ' + pct(T.survival) + ' · ' + fmt(T.stemsHa, 0) + '/ha' + (T.meanH != null ? ' · ' + fmt(T.meanH, 0) + ' cm' : '') + '</span></a>';
    });
    h += '<h2>' + t('photos') + '</h2>' + (ph.length ? '<div class="thumbs">' + ph.slice().reverse().map(function (x) {
      return '<figure data-ph="' + x.id + '"><img src="' + thumbURL(x) + '" alt=""><figcaption>' + day(x.date) + (x.bearing != null ? ' · ' + Math.round(x.bearing) + '° ' + PS.compassWord(x.bearing) : '') + '</figcaption></figure>';
    }).join('') + '</div>' : '<p class="empty">' + t('noPhotos') + '</p>');
    main.innerHTML = h; cleanup = freeURLs;
    $('bNew').onclick = function () {
      var counts = {}; (site.species.length ? site.species : ['Tree']).forEach(function (s) { counts[s] = { alive: 0, dead: 0, missing: 0 }; });
      var v = { id: uid(), plotId: p.id, date: new Date().toISOString(), counts: counts, trees: [], notes: '' };
      put('visits', v).then(function () { go('visit/' + v.id); });
    };
    main.querySelectorAll('[data-ph]').forEach(function (f) {
      f.onclick = function () {
        var x = get('photos', f.dataset.ph);
        sheet('<img class="full" src="' + f.querySelector('img').src + '"><p>' + PS.localStamp(x.date) + (x.bearing != null ? ' · ' + Math.round(x.bearing) + '° ' + PS.compassWord(x.bearing) : '') + '</p><div class="row"><button class="bad" id="pd">' + t('del') + '</button><button data-close>' + t('close') + '</button></div>', function () {
          $('pd').onclick = function () { if (confirm(t('confirmDel'))) del('photos', x.id).then(render); };
        });
      };
    });
  }

  function viewVisit(v) {
    var p = get('plots', v.plotId), site = get('sites', p.siteId);
    function save() { put('visits', v); }
    function draw() {
      var T = PS.visitTotals(v, p.radius);
      var h = top(p.name + ' · ' + t('survey'), 'plot/' + p.id) +
        '<div class="totals sticky"><div><b>' + pct(T.survival) + '</b><span>' + t('survival') + '</span></div><div><b>' + fmt(T.stemsHa, 0) + '</b><span>' + t('stemsHa') + '</span></div><div><b>' + (T.meanH == null ? '–' : fmt(T.meanH, 0) + '<small>cm</small>') + '</b><span>' + t('avgH') + '</span></div><div><b>' + T.total + '</b><span>' + t('counted') + '</span></div></div>' +
        (T.missing ? '<p class="small center">' + t('foundOnly') + ': ' + pct(T.survivalFound) + '</p>' : '') + '<p class="small">' + t('tapHelp') + '</p>';
      Object.keys(v.counts).forEach(function (sp) {
        var c = v.counts[sp];
        h += '<div class="sp"><div class="spn">' + esc(sp) + '</div><div class="cnt">' + ['alive', 'dead', 'missing'].map(function (st) {
          return '<div class="cc"><button class="tap ' + st + '" data-sp="' + esc(sp) + '" data-st="' + st + '" data-d="1"><b>' + c[st] + '</b>' + t(st) + '</button><button class="minus" data-sp="' + esc(sp) + '" data-st="' + st + '" data-d="-1" aria-label="minus">−</button></div>';
        }).join('') + '</div></div>';
      });
      h += '<button id="bSp">' + t('addSpecies') + '</button><button class="go" id="bMeas">' + t('measureTree') + '</button>';
      if (v.trees.length) {
        h += '<h3>' + t('measuredTrees') + ' (' + v.trees.length + ')</h3><div class="list">' + v.trees.map(function (tr, i) {
          return '<div class="tree"><span>' + (i + 1) + '. ' + esc(tr.species) + ' · ' + (tr.h != null ? tr.h + ' cm' : '–') + (tr.d != null ? ' · ' + tr.d + ' mm ' + (tr.dAt === 'dbh' ? '@1.3 m' : '@base') : '') + ' · ' + t(tr.health === 'stressed' ? 'stressed' : 'good').split(' ')[0] + '</span><button class="minus" data-tdel="' + i + '">✕</button></div>';
        }).join('') + '</div>';
      }
      h += '<form class="form" id="vf"><label>' + t('visitDate') + '<input type="datetime-local" name="date" value="' + PS.localStamp(v.date).slice(0, 16).replace(' ', 'T') + '"></label>' +
        '<label>' + t('visitNotes') + '<textarea name="notes" rows="3">' + esc(v.notes) + '</textarea></label></form>' +
        '<a class="btn go big" href="#plot/' + p.id + '">' + t('done') + '</a><button class="bad" id="vDel">' + t('del') + '</button>';
      var y = window.scrollY; main.innerHTML = h; window.scrollTo(0, y);
      main.querySelectorAll('[data-st]').forEach(function (b) {
        b.onclick = function () { var c = v.counts[b.dataset.sp]; c[b.dataset.st] = Math.max(0, c[b.dataset.st] + +b.dataset.d);
          if (b.dataset.st === 'alive') { var m = v.trees.filter(function (x) { return x.species === b.dataset.sp; }).length; if (c.alive < m) c.alive = m; }
          if (navigator.vibrate) navigator.vibrate(15); save(); draw(); };
      });
      main.querySelectorAll('[data-tdel]').forEach(function (b) {
        b.onclick = function () { if (!confirm(t('confirmDel'))) return; var tr = v.trees.splice(+b.dataset.tdel, 1)[0]; if (v.counts[tr.species]) v.counts[tr.species].alive = Math.max(0, v.counts[tr.species].alive - 1); save(); draw(); };
      });
      $('bSp').onclick = function () { var n = (prompt(t('speciesPrompt')) || '').trim(); if (n && !v.counts[n]) { v.counts[n] = { alive: 0, dead: 0, missing: 0 }; if (site.species.indexOf(n) < 0) { site.species.push(n); put('sites', site); } save(); draw(); } };
      $('bMeas').onclick = measure;
      var vf = $('vf');
      vf.date.onchange = function () { var d = new Date(vf.date.value); if (!isNaN(d)) { v.date = d.toISOString(); save(); } };
      vf.notes.oninput = function () { v.notes = vf.notes.value; clearTimeout(draw.n); draw.n = setTimeout(save, 400); };
      $('vDel').onclick = function () { if (confirm(t('confirmDel'))) del('visits', v.id).then(function () { go('plot/' + p.id); }); };
    }
    function measure() {
      var sps = Object.keys(v.counts);
      sheet('<h2>' + t('measureTree') + '</h2><form class="form" id="mf"><label>' + t('species') + '<select name="sp">' + sps.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select></label>' +
        '<label>' + t('height') + '<input name="h" type="number" inputmode="decimal" step="any" min="0"></label>' +
        '<label>' + t('diam') + '<input name="d" type="number" inputmode="decimal" step="any" min="0"></label>' +
        '<fieldset><legend>' + t('diamAt') + '</legend><div class="choices two"><label class="choice"><input type="radio" name="at" value="base" checked><span>' + t('atBase') + '</span></label><label class="choice"><input type="radio" name="at" value="dbh"><span>' + t('atDbh') + '</span></label></div></fieldset>' +
        '<fieldset><legend>' + t('health') + '</legend><div class="choices two"><label class="choice"><input type="radio" name="hl" value="good" checked><span>' + t('good') + '</span></label><label class="choice"><input type="radio" name="hl" value="stressed"><span>' + t('stressed') + '</span></label></div></fieldset>' +
        '<label>' + t('notes') + '<input name="note"></label><p class="small">' + t('measureNote') + '</p><button class="go" type="submit">' + t('save') + '</button><button type="button" data-close>' + t('cancel') + '</button></form>', function () {
        var mf = $('mf');
        mf.onsubmit = function (e) {
          e.preventDefault();
          var num = function (x) { return x === '' ? null : +x; };
          var tr = { species: mf.sp.value, h: num(mf.h.value), d: num(mf.d.value), dAt: mf.querySelector('[name=at]:checked').value, health: mf.querySelector('[name=hl]:checked').value, note: mf.note.value };
          v.trees.push(tr); v.counts[tr.species].alive++; save(); closeSheet(); draw();
        };
      });
    }
    draw();
  }

  function viewFind(p) {
    main.innerHTML = top(t('findPlot').replace(/^\S+ /, ''), 'plot/' + p.id) + '<div class="find">' + (p.lat == null ? '<p>' + t('noPlotGps') + '</p>' :
      '<svg viewBox="-50 -50 100 100" class="arrow"><circle r="46" class="ring"/><path id="arr" d="M0,-40 L16,10 L0,2 L-16,10 Z"/></svg><p class="dist" id="fd">' + t('gpsWait') + '</p><p id="fb"></p><p class="small" id="fa"></p>') + '</div>';
    if (p.lat == null) return;
    startCompass(); var last = null;
    function upd() {
      if (!last) return;
      var d = PS.distanceM(last.latitude, last.longitude, p.lat, p.lon), b = PS.bearingDeg(last.latitude, last.longitude, p.lat, p.lon);
      var close = d <= Math.max(5, last.accuracy);
      $('fd').textContent = close ? t('youAreHere') : t('distance', { d: Math.round(d) });
      $('fb').textContent = close ? '' : t('toward', { dir: PS.compassWord(b), b: Math.round(b) });
      $('fa').textContent = t('accuracy', { acc: Math.round(last.accuracy) }) + (heading == null ? ' · ' + t('noCompass') : '');
      $('arr').setAttribute('transform', 'rotate(' + (heading == null ? b : b - heading) + ')');
    }
    window.onHeading = upd;
    bestGps(function (b, live) { last = live; upd(); }, function () { $('fd').textContent = t('gpsFail'); });
  }

  function compress(src, w, h) {
    var max = 1280, k = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise(function (res) { c.toBlob(function (b) { res({ blob: b, w: c.width, h: c.height }); }, 'image/jpeg', 0.7); });
  }
  function viewPhoto(p) {
    var ph = photosOf(p.id), last = ph[ph.length - 1], stream = null, ghostURL = last ? URL.createObjectURL(last.blob) : null;
    main.innerHTML = '<div class="cam"><video id="vid" playsinline muted autoplay></video>' + (ghostURL ? '<img id="ghost" src="' + ghostURL + '" alt="">' : '') +
      '<div class="camtop"><a class="back" href="#plot/' + p.id + '">' + t('back') + '</a><span id="hd">' + t('noCompass') + '</span></div><div id="turn" class="turn"></div>' +
      '<div class="cambot">' + (ghostURL ? '<label class="small">' + t('ghost') + ' <input type="range" id="op" min="0" max="90" value="40"></label><p class="small">' + t('ghostHelp') + '</p>' : '') +
      '<button class="go big" id="snap">' + t('takePhoto') + '</button><button id="pick">' + t('pickPhoto') + '</button><input type="file" id="file" accept="image/*" capture="environment" hidden></div></div>';
    document.body.className = 'v-photo';
    cleanup = function () { if (stream) stream.getTracks().forEach(function (tr) { tr.stop(); }); if (ghostURL) URL.revokeObjectURL(ghostURL); };
    if (ghostURL) { $('op').oninput = function () { $('ghost').style.opacity = this.value / 100; }; $('ghost').style.opacity = 0.4; }
    startCompass();
    window.onHeading = function () {
      if (heading == null) return;
      $('hd').textContent = t('facing', { b: Math.round(heading), w: PS.compassWord(heading) });
      if (last && last.bearing != null) {
        var d = PS.angleDiff(last.bearing, heading);
        $('turn').textContent = Math.abs(d) <= 3 ? t('onTarget') : t('turn', { dir: t(d > 0 ? 'right' : 'left'), n: Math.round(Math.abs(d)) });
        $('turn').className = 'turn' + (Math.abs(d) <= 3 ? ' ok' : '');
      }
    };
    function saveBlob(r) {
      var o = { id: uid(), plotId: p.id, date: new Date().toISOString(), bearing: heading == null ? null : Math.round(heading), w: r.w, h: r.h, blob: r.blob };
      put('photos', o).then(function () { toast(t('photoSaved')); go('plot/' + p.id); });
    }
    var vid = $('vid');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
        .then(function (s) { stream = s; vid.srcObject = s; }, function () { toast(t('noCamera')); });
    } else toast(t('noCamera'));
    $('snap').onclick = function () {
      if (!stream || !vid.videoWidth) return $('file').click();
      compress(vid, vid.videoWidth, vid.videoHeight).then(saveBlob);
    };
    $('pick').onclick = function () { $('file').click(); };
    $('file').onchange = function () {
      var f = this.files[0]; if (!f) return;
      var img = new Image(), u = URL.createObjectURL(f);
      img.onload = function () { compress(img, img.naturalWidth, img.naturalHeight).then(function (r) { URL.revokeObjectURL(u); saveBlob(r); }); };
      img.src = u;
    };
  }

  function viewAbout() {
    main.innerHTML = top(t('about'), '') + '<div class="card">' + t('aboutText') + '</div><div class="card"><h3>' + t('howTo') + '</h3>' + t('howToText') +
      '<p class="small">' + t('method') + '</p></div><p class="small center">' + t('version', { v: VERSION }) + ' · <a href="https://github.com/johnrichardszpe-dot/planting-survey">GitHub</a></p>';
  }

  // ---------- start ----------
  window.addEventListener('hashchange', render);
  $('sheet').addEventListener('click', function (e) { if (e.target.id === 'sheet') closeSheet(); });
  openDB().then(function (d) { idb = d; return loadAll(); }).catch(function () { toast(t('storageWarn')); }).then(function () {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    render();
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  window.PSApp = { DB: DB, version: VERSION };
})();
