/* =========================================================================
   Walden & Finch — private fitness / nutrition tracker
   Single-user. All data lives in localStorage on this device.
   Food data: USDA FoodData Central API.
   ========================================================================= */
(function () {
  'use strict';

  /* ----------------------------- storage ------------------------------ */
  var K = {
    profile: 'wf_fit_profile',
    log:     'wf_fit_log',       // { 'YYYY-MM-DD': { meals:{...}, exercise:[...] } }
    fav:     'wf_fit_fav',       // [ foodItem ]
    recent:  'wf_fit_recent',    // [ foodItem ]  (most-recent first)
    key:     'wf_fit_usdakey'
  };

  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  var DEFAULT_PROFILE = {
    sex: 'female', age: 30, height: 168, weight: 160, goal: 145,
    activity: 1.375, pace: 1
  };

  var state = {
    profile: Object.assign({}, DEFAULT_PROFILE, load(K.profile, {})),
    log:     load(K.log, {}),
    fav:     load(K.fav, []),
    recent:  load(K.recent, []),
    usdaKey: localStorage.getItem(K.key) || 'DEMO_KEY',
    date:    fmtDate(new Date()),
    addMeal: 'breakfast',
    pending: null   // food awaiting quantity confirmation
  };

  /* ----------------------------- helpers ------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function fmtDate(d) {
    var y = d.getFullYear(), m = ('0' + (d.getMonth() + 1)).slice(-2), day = ('0' + d.getDate()).slice(-2);
    return y + '-' + m + '-' + day;
  }
  function parseDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function round(n) { return Math.round(n || 0); }
  function lbToKg(lb) { return lb * 0.45359237; }

  var MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
  var MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };

  /* -------------------------- day accessors --------------------------- */
  function day(dateStr) {
    var d = state.log[dateStr];
    if (!d) {
      d = { meals: { breakfast: [], lunch: [], dinner: [], snacks: [] }, exercise: [] };
      state.log[dateStr] = d;
    }
    if (!d.meals) d.meals = { breakfast: [], lunch: [], dinner: [], snacks: [] };
    if (!d.exercise) d.exercise = [];
    return d;
  }
  function today() { return day(state.date); }
  function persistLog() { save(K.log, state.log); }

  /* --------------------------- goal maths ----------------------------- */
  // Mifflin-St Jeor BMR, then TDEE, then subtract deficit for pace.
  function bmr(p) {
    var kg = lbToKg(p.weight);
    var base = 10 * kg + 6.25 * p.height - 5 * p.age;
    return p.sex === 'male' ? base + 5 : base - 161;
  }
  function tdee(p) { return bmr(p) * p.activity; }
  function dailyGoal(p) {
    var deficit = (p.pace || 0) * 3500 / 7; // 3500 kcal per lb, spread over week
    var g = tdee(p) - deficit;
    return Math.max(1200, round(g)); // sane floor
  }

  // Calories burned by distance, from body weight.
  function milesCalories(activity, miles, weightLb) {
    var perMilePerLb = { run: 0.75, walk: 0.53, cycle: 0.28 };
    return round((perMilePerLb[activity] || 0.6) * weightLb * miles);
  }
  function stepsToMiles(steps) { return steps / 2000; } // ~2000 steps/mile

  /* --------------------------- USDA search ---------------------------- */
  function usdaSearch(query) {
    var url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
      + '?api_key=' + encodeURIComponent(state.usdaKey)
      + '&query=' + encodeURIComponent(query)
      + '&pageSize=25&dataType=Foundation,SR%20Legacy,Branded';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('USDA ' + r.status);
      return r.json();
    }).then(function (data) {
      return (data.foods || []).map(normalizeFood).filter(Boolean);
    });
  }

  // Pull a nutrient (per 100g) by USDA nutrient number.
  function nutrientPer100(food, numbers) {
    var arr = food.foodNutrients || [];
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      var num = n.nutrientNumber || (n.nutrient && n.nutrient.number);
      if (num && numbers.indexOf(String(num)) !== -1) {
        var val = (n.value != null) ? n.value : n.amount;
        if (val != null) return val;
      }
    }
    return 0;
  }

  // Reduce a USDA food to a compact item with per-100g nutrition.
  function normalizeFood(food) {
    var kcal = nutrientPer100(food, ['1008', '208']);
    var protein = nutrientPer100(food, ['1003', '203']);
    var carbs = nutrientPer100(food, ['1005', '205']);
    var fat = nutrientPer100(food, ['1004', '204']);

    // Branded foods sometimes only carry label nutrients (per serving).
    if (!kcal && food.labelNutrients && food.labelNutrients.calories && food.servingSize) {
      var factor = 100 / food.servingSize; // serving grams -> per 100g
      var L = food.labelNutrients;
      kcal = (L.calories.value || 0) * factor;
      protein = (L.protein ? L.protein.value : 0) * factor;
      carbs = (L.carbohydrates ? L.carbohydrates.value : 0) * factor;
      fat = (L.fat ? L.fat.value : 0) * factor;
    }
    if (!kcal) return null;

    var item = {
      id: 'usda-' + (food.fdcId || Math.abs(hash(food.description || ''))),
      name: titleCase(food.description || 'Food'),
      brand: food.brandOwner || food.brandName || '',
      per100: { kcal: kcal, protein: protein, carbs: carbs, fat: fat }
    };
    // A natural serving size if the food declares one.
    if (food.servingSize && food.servingSizeUnit) {
      var unit = (food.servingSizeUnit || '').toLowerCase();
      if (unit === 'g' || unit === 'ml') {
        item.serving = { grams: food.servingSize, label: 'serving (' + round(food.servingSize) + ' ' + unit + ')' };
      }
    }
    return item;
  }

  function titleCase(s) {
    s = s.toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }

  /* ----------------------- nutrition for a qty ------------------------ */
  // unit is 'g' or a serving multiplier ('serving'); returns nutrition object.
  function computeNutrition(item, amount, unit) {
    var grams;
    if (unit === 'serving' && item.serving) grams = amount * item.serving.grams;
    else grams = amount; // grams
    var f = grams / 100;
    return {
      grams: grams,
      kcal: round(item.per100.kcal * f),
      protein: round(item.per100.protein * f),
      carbs: round(item.per100.carbs * f),
      fat: round(item.per100.fat * f)
    };
  }

  /* ============================= RENDER =============================== */

  function renderAll() {
    renderDateLabel();
    renderDiary();
    renderExerciseView();
  }

  function renderDateLabel() {
    var lbl = $('#datePick');
    var t = fmtDate(new Date());
    var y = fmtDate(new Date(Date.now() - 86400000));
    if (state.date === t) lbl.textContent = 'Today';
    else if (state.date === y) lbl.textContent = 'Yesterday';
    else {
      var d = parseDate(state.date);
      lbl.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    $('#dateInput').value = state.date;
  }

  function dayTotals() {
    var d = today(), t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    MEALS.forEach(function (m) {
      d.meals[m].forEach(function (f) {
        t.kcal += f.kcal; t.protein += f.protein; t.carbs += f.carbs; t.fat += f.fat;
      });
    });
    return t;
  }
  function exerciseTotal() {
    return today().exercise.reduce(function (s, e) { return s + (e.kcal || 0); }, 0);
  }

  function renderDiary() {
    var goal = dailyGoal(state.profile);
    var t = dayTotals();
    var ex = exerciseTotal();
    var remaining = goal - t.kcal + ex;

    // Budget breakdown
    $('#bdGoal').textContent = goal;
    $('#bdFood').textContent = round(t.kcal);
    $('#bdExercise').textContent = round(ex);
    $('#bdRemaining').textContent = round(remaining);
    $('#remainingNum').textContent = round(Math.abs(remaining));
    $('#remainingLabel').textContent = remaining >= 0 ? 'remaining' : 'over';

    // Ring
    var budget = goal + ex;
    var consumed = t.kcal;
    var pct = budget > 0 ? Math.min(1, consumed / budget) : 0;
    var C = 2 * Math.PI * 52; // 326.7
    var ring = $('#ringFill');
    ring.style.strokeDashoffset = C * (1 - pct);
    ring.style.stroke = remaining < 0 ? 'var(--terracotta)' : (pct > 0.85 ? 'var(--mustard)' : 'var(--navy)');

    // Macros (goal split 30/40/30 as reference)
    setMacro('p', t.protein, goal * 0.30 / 4);
    setMacro('c', t.carbs, goal * 0.40 / 4);
    setMacro('f', t.fat, goal * 0.30 / 9);

    // Deficit strip
    renderDeficit(goal, t.kcal, ex);

    // Meals
    var host = $('#meals');
    host.innerHTML = '';
    MEALS.forEach(function (m) {
      var d = today();
      var items = d.meals[m];
      var kcal = items.reduce(function (s, f) { return s + f.kcal; }, 0);

      var card = el('div', 'meal');
      var head = el('div', 'meal-head');
      head.innerHTML = '<h3>' + MEAL_LABEL[m] + ' <span class="meal-kcal">' + round(kcal) + ' cal</span></h3>';
      var right = el('div', 'meal-head-right');
      var addBtn = el('button', 'add-link', '+ Add');
      addBtn.addEventListener('click', function () { openAdd(m); });
      right.appendChild(addBtn);
      head.appendChild(right);
      card.appendChild(head);

      var body = el('div', 'meal-items');
      items.forEach(function (f, idx) {
        var row = el('div', 'food-row');
        var sub = round(f.grams) + ' g · ' + f.protein + 'P ' + f.carbs + 'C ' + f.fat + 'F';
        row.innerHTML = '<div class="fr-main"><div class="fr-name">' + escapeHtml(f.name) + '</div>'
          + '<div class="fr-sub">' + sub + '</div></div>';
        var rr = el('div', 'fr-right');
        rr.innerHTML = '<span class="fr-kcal">' + f.kcal + '</span>';
        var del = el('button', 'del-btn', '×');
        del.addEventListener('click', function () { removeFood(m, idx); });
        rr.appendChild(del);
        row.appendChild(rr);
        body.appendChild(row);
      });
      card.appendChild(body);
      host.appendChild(card);
    });

    // Exercise items in diary
    var exHost = $('#exerciseItems');
    exHost.innerHTML = '';
    var exList = today().exercise;
    if (!exList.length) {
      exHost.innerHTML = '<div class="food-row"><div class="fr-main"><div class="fr-sub">No activity logged.</div></div></div>';
    } else {
      exList.forEach(function (e, idx) {
        var row = el('div', 'food-row');
        row.innerHTML = '<div class="fr-main"><div class="fr-name">' + escapeHtml(e.label) + '</div></div>';
        var rr = el('div', 'fr-right');
        rr.innerHTML = '<span class="fr-kcal">+' + e.kcal + '</span>';
        var del = el('button', 'del-btn', '×');
        del.addEventListener('click', function () { removeExercise(idx); });
        rr.appendChild(del);
        row.appendChild(rr);
        exHost.appendChild(row);
      });
    }
  }

  function setMacro(prefix, val, goalGrams) {
    $('#' + prefix + 'Val').textContent = round(val) + 'g';
    var pct = goalGrams > 0 ? Math.min(100, (val / goalGrams) * 100) : 0;
    $('#' + prefix + 'Bar').style.width = pct + '%';
  }

  function renderDeficit(goal, food, ex) {
    var strip = $('#deficitStrip');
    var icon = $('#deficitIcon');
    var text = $('#deficitText');
    var net = food - ex;               // net calories eaten
    var maint = tdee(state.profile);   // maintenance
    var delta = maint - net;           // positive = deficit

    if (food === 0 && ex === 0) {
      strip.classList.remove('over');
      icon.textContent = '▾';
      text.textContent = 'Log your day to see the deficit breakdown.';
      return;
    }

    if (delta >= 0) {
      strip.classList.remove('over');
      icon.textContent = '▾';
      var perWeek = (delta * 7 / 3500);
      text.innerHTML = 'Net <b>' + round(net) + '</b> cal vs. maintenance <b>' + round(maint)
        + '</b> — a <b>' + round(delta) + ' cal</b> deficit today ≈ <b>' + perWeek.toFixed(2) + ' lb/week</b> if repeated.';
    } else {
      strip.classList.add('over');
      icon.textContent = '▴';
      var surplus = -delta;
      text.innerHTML = 'Net <b>' + round(net) + '</b> cal is <b>' + round(surplus)
        + ' cal</b> over maintenance (<b>' + round(maint) + '</b>). Add a walk or trim a snack to swing back into deficit.';
    }
  }

  /* --------------------------- Add view ------------------------------- */
  function openAdd(meal) {
    state.addMeal = meal || state.addMeal;
    $('#addMealTag').textContent = MEAL_LABEL[state.addMeal];
    switchView('add');
    renderFav();
    renderRecent();
    setTimeout(function () { $('#foodSearch').focus(); }, 50);
  }

  function chipFor(item, isFav) {
    var chip = el('button', 'chip' + (isFav ? ' fav' : ''));
    chip.innerHTML = (isFav ? '<span class="star">★</span>' : '')
      + escapeHtml(item.name)
      + ' <span class="chip-kcal">' + round(item.per100.kcal) + '/100g</span>';
    chip.addEventListener('click', function () { openQty(item); });
    return chip;
  }

  function renderFav() {
    var host = $('#favList'); host.innerHTML = '';
    state.fav.forEach(function (item) { host.appendChild(chipFor(item, true)); });
  }
  function renderRecent() {
    var host = $('#recentList'); host.innerHTML = '';
    state.recent.slice(0, 12).forEach(function (item) { host.appendChild(chipFor(item, isFav(item))); });
  }

  function isFav(item) { return state.fav.some(function (f) { return f.id === item.id; }); }

  function runSearch() {
    var q = $('#foodSearch').value.trim();
    if (!q) return;
    var stateEl = $('#searchState');
    stateEl.textContent = 'Searching USDA database…';
    $('#resultsBlock').classList.add('hidden');
    usdaSearch(q).then(function (items) {
      stateEl.textContent = items.length ? '' : 'No matches. Try a simpler term.';
      var host = $('#resultsList'); host.innerHTML = '';
      items.forEach(function (item) {
        var row = el('div', 'result-row');
        var sub = item.brand ? escapeHtml(item.brand) : 'per 100 g';
        row.innerHTML = '<div class="rr-main"><div class="rr-name">' + escapeHtml(item.name) + '</div>'
          + '<div class="rr-sub">' + sub + '</div></div>'
          + '<span class="rr-kcal">' + round(item.per100.kcal) + ' cal</span>';
        row.addEventListener('click', function () { openQty(item); });
        host.appendChild(row);
      });
      $('#resultsBlock').classList.remove('hidden');
    }).catch(function (err) {
      if (state.usdaKey === 'DEMO_KEY' && /42\d|429|403/.test(String(err.message))) {
        stateEl.textContent = 'The shared demo key is rate-limited. Add your own free USDA key under Profile → USDA key.';
      } else {
        stateEl.textContent = 'Search failed (' + err.message + '). Check your connection or USDA key.';
      }
    });
  }

  /* -------------------------- Quantity modal -------------------------- */
  function openQty(item) {
    state.pending = item;
    $('#qtyName').textContent = item.name;
    $('#qtyBrand').textContent = item.brand || '';
    $('#qtyMeal').value = state.addMeal;
    $('#qtyFav').checked = isFav(item);

    // Units
    var unitSel = $('#qtyUnit');
    unitSel.innerHTML = '';
    unitSel.appendChild(new Option('grams', 'g'));
    if (item.serving) unitSel.appendChild(new Option(item.serving.label, 'serving'));
    unitSel.value = item.serving ? 'serving' : 'g';
    $('#qtyAmount').value = item.serving ? 1 : 100;

    updateQtyNutri();
    $('#qtyModal').classList.remove('hidden');
  }
  function closeQty() { $('#qtyModal').classList.add('hidden'); state.pending = null; }

  function updateQtyNutri() {
    if (!state.pending) return;
    var amount = parseFloat($('#qtyAmount').value) || 0;
    var unit = $('#qtyUnit').value;
    var n = computeNutrition(state.pending, amount, unit);
    $('#qtyNutri').innerHTML =
      '<div><b>' + n.kcal + '</b><span>cal</span></div>' +
      '<div><b>' + n.protein + 'g</b><span>protein</span></div>' +
      '<div><b>' + n.carbs + 'g</b><span>carbs</span></div>' +
      '<div><b>' + n.fat + 'g</b><span>fat</span></div>';
  }

  function confirmQty() {
    if (!state.pending) return;
    var item = state.pending;
    var amount = parseFloat($('#qtyAmount').value) || 0;
    var unit = $('#qtyUnit').value;
    var meal = $('#qtyMeal').value;
    var n = computeNutrition(item, amount, unit);

    today().meals[meal].push({
      id: item.id, name: item.name, grams: n.grams,
      kcal: n.kcal, protein: n.protein, carbs: n.carbs, fat: n.fat
    });
    persistLog();

    // favorites
    if ($('#qtyFav').checked) addFav(item); else removeFav(item);
    // recent
    pushRecent(item);

    closeQty();
    toast(item.name + ' added to ' + MEAL_LABEL[meal]);
    renderDiary();
    switchView('today');
  }

  function addFav(item) {
    if (!isFav(item)) { state.fav.unshift(stripItem(item)); save(K.fav, state.fav); }
  }
  function removeFav(item) {
    state.fav = state.fav.filter(function (f) { return f.id !== item.id; });
    save(K.fav, state.fav);
  }
  function pushRecent(item) {
    state.recent = state.recent.filter(function (f) { return f.id !== item.id; });
    state.recent.unshift(stripItem(item));
    state.recent = state.recent.slice(0, 30);
    save(K.recent, state.recent);
  }
  function stripItem(item) {
    return { id: item.id, name: item.name, brand: item.brand, per100: item.per100, serving: item.serving };
  }

  /* --------------------------- remove ops ----------------------------- */
  function removeFood(meal, idx) { today().meals[meal].splice(idx, 1); persistLog(); renderDiary(); }
  function removeExercise(idx) { today().exercise.splice(idx, 1); persistLog(); renderAll(); }

  /* --------------------------- Exercise ------------------------------- */
  function renderExerciseView() {
    updateExEstimates();
    var host = $('#exLogList'); host.innerHTML = '';
    var list = today().exercise;
    if (!list.length) { host.innerHTML = '<div class="hint">Nothing logged for this day.</div>'; return; }
    list.forEach(function (e, idx) {
      var row = el('div', 'result-row');
      row.innerHTML = '<div class="rr-main"><div class="rr-name">' + escapeHtml(e.label) + '</div></div>'
        + '<span class="rr-kcal">+' + e.kcal + ' cal</span>';
      var del = el('button', 'del-btn', '×');
      del.addEventListener('click', function () { removeExercise(idx); });
      row.appendChild(del);
      host.appendChild(row);
    });
  }

  function updateExEstimates() {
    var w = state.profile.weight;
    var act = $('#exActivity').value;
    var miles = parseFloat($('#exMiles').value) || 0;
    $('#exMilesEst').textContent = '≈ ' + milesCalories(act, miles, w) + ' cal';
    var steps = parseFloat($('#exSteps').value) || 0;
    var mi = stepsToMiles(steps);
    $('#exStepsEst').textContent = '≈ ' + milesCalories('walk', mi, w) + ' cal · ' + mi.toFixed(1) + ' mi';
  }

  function addMiles() {
    var act = $('#exActivity').value;
    var miles = parseFloat($('#exMiles').value) || 0;
    if (miles <= 0) { toast('Enter a distance first'); return; }
    var kcal = milesCalories(act, miles, state.profile.weight);
    var label = ({ run: 'Run', walk: 'Walk', cycle: 'Cycle' }[act]) + ' · ' + miles + ' mi';
    today().exercise.push({ type: act, label: label, kcal: kcal });
    persistLog();
    $('#exMiles').value = '';
    toast('+' + kcal + ' cal from ' + label);
    renderAll();
  }

  function setSteps() {
    var steps = parseFloat($('#exSteps').value) || 0;
    if (steps <= 0) { toast('Enter your step count'); return; }
    var mi = stepsToMiles(steps);
    var kcal = milesCalories('walk', mi, state.profile.weight);
    // replace any existing steps entry for the day
    today().exercise = today().exercise.filter(function (e) { return e.type !== 'steps'; });
    today().exercise.push({ type: 'steps', label: steps.toLocaleString() + ' steps (' + mi.toFixed(1) + ' mi)', kcal: kcal });
    persistLog();
    toast('Steps set · +' + kcal + ' cal');
    renderAll();
  }

  /* ---------------------------- Profile ------------------------------- */
  function loadProfileForm() {
    var p = state.profile;
    $('#pfSex').value = p.sex;
    $('#pfAge').value = p.age;
    $('#pfHeight').value = p.height;
    $('#pfWeight').value = p.weight;
    $('#pfGoal').value = p.goal;
    $('#pfActivity').value = String(p.activity);
    $('#pfPace').value = String(p.pace);
    $('#pfUsdaKey').value = (state.usdaKey === 'DEMO_KEY') ? '' : state.usdaKey;
    renderGoalPreview();
  }

  function readProfileForm() {
    return {
      sex: $('#pfSex').value,
      age: parseInt($('#pfAge').value, 10) || 30,
      height: parseFloat($('#pfHeight').value) || 168,
      weight: parseFloat($('#pfWeight').value) || 160,
      goal: parseFloat($('#pfGoal').value) || 145,
      activity: parseFloat($('#pfActivity').value) || 1.375,
      pace: parseFloat($('#pfPace').value)
    };
  }

  function renderGoalPreview() {
    var p = readProfileForm();
    var goal = dailyGoal(p);
    var maint = round(tdee(p));
    var diff = p.weight - p.goal;
    var weeks = (p.pace > 0 && diff !== 0) ? Math.abs(diff) / p.pace : 0;
    var msg = '<span class="big"><b>' + goal + '</b> cal / day</span>';
    msg += 'Maintenance ≈ <b>' + maint + '</b> cal. ';
    if (p.pace === 0) msg += 'Set to maintain your current weight.';
    else if (weeks > 0) msg += 'At ' + p.pace + ' lb/week, about <b>' + Math.ceil(weeks) + ' weeks</b> to reach ' + p.goal + ' lb.';
    $('#goalPreview').innerHTML = msg;
  }

  function saveProfile() {
    state.profile = readProfileForm();
    save(K.profile, state.profile);
    var key = $('#pfUsdaKey').value.trim();
    state.usdaKey = key || 'DEMO_KEY';
    if (key) localStorage.setItem(K.key, key); else localStorage.removeItem(K.key);
    toast('Profile saved');
    renderAll();
  }

  function exportData() {
    var blob = new Blob([JSON.stringify({
      profile: state.profile, log: state.log, fav: state.fav, recent: state.recent
    }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'walden-finch-fitness-' + state.date + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function resetData() {
    if (!confirm('Erase ALL fitness data on this device? This cannot be undone.')) return;
    [K.profile, K.log, K.fav, K.recent, K.key].forEach(function (k) { localStorage.removeItem(k); });
    state.profile = Object.assign({}, DEFAULT_PROFILE);
    state.log = {}; state.fav = []; state.recent = []; state.usdaKey = 'DEMO_KEY';
    loadProfileForm(); renderAll();
    toast('All data erased');
  }

  /* ---------------------------- navigation ---------------------------- */
  function switchView(name) {
    $$('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('#view-' + name).classList.remove('hidden');
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === name); });
    if (name === 'today') renderDiary();
    if (name === 'exercise') renderExerciseView();
    if (name === 'profile') loadProfileForm();
    if (name === 'add') { renderFav(); renderRecent(); }
    window.scrollTo(0, 0);
  }

  function shiftDate(deltaDays) {
    var d = parseDate(state.date);
    d.setDate(d.getDate() + deltaDays);
    state.date = fmtDate(d);
    renderAll();
  }

  /* ------------------------------ toast ------------------------------- */
  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------ wiring ------------------------------ */
  function init() {
    // tabs
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var v = t.getAttribute('data-view');
        if (v === 'add') openAdd(state.addMeal); else switchView(v);
      });
    });

    // date nav
    $('#prevDay').addEventListener('click', function () { shiftDate(-1); });
    $('#nextDay').addEventListener('click', function () { shiftDate(1); });
    $('#datePick').addEventListener('click', function () {
      var inp = $('#dateInput');
      if (inp.showPicker) inp.showPicker(); else inp.focus();
    });
    $('#dateInput').addEventListener('change', function () {
      if (this.value) { state.date = this.value; renderAll(); }
    });

    // search
    $('#searchBtn').addEventListener('click', runSearch);
    $('#foodSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') runSearch(); });

    // quantity modal
    $('#qtyAmount').addEventListener('input', updateQtyNutri);
    $('#qtyUnit').addEventListener('change', updateQtyNutri);
    $('#qtyAdd').addEventListener('click', confirmQty);
    $('#qtyCancel').addEventListener('click', closeQty);
    $('#qtyClose').addEventListener('click', closeQty);
    $('#qtyModal').addEventListener('click', function (e) { if (e.target === this) closeQty(); });

    // exercise
    ['#exActivity', '#exMiles', '#exSteps'].forEach(function (s) {
      $(s).addEventListener('input', updateExEstimates);
    });
    $('#exAddMiles').addEventListener('click', addMiles);
    $('#exAddSteps').addEventListener('click', setSteps);
    $$('[data-goexercise]').forEach(function (b) { b.addEventListener('click', function () { switchView('exercise'); }); });

    // profile
    ['#pfSex', '#pfAge', '#pfHeight', '#pfWeight', '#pfGoal', '#pfActivity', '#pfPace'].forEach(function (s) {
      $(s).addEventListener('input', renderGoalPreview);
    });
    $('#saveProfile').addEventListener('click', saveProfile);
    $('#exportData').addEventListener('click', exportData);
    $('#resetData').addEventListener('click', resetData);

    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
