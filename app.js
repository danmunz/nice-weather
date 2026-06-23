/* ============================================
   isitniceout.com — App Logic
   ============================================ */

(function () {
  'use strict';

  const API_BASE = 'https://api.weather.gov';
  const TIMEOUT_MS = 8000;
  const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  const POINTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const STALENESS_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
  const PRECIP_NOISE_THRESHOLD_MM = 1.0;

  const SKY_PASSLIST = [
    'clear', 'sunny', 'mostly sunny', 'partly sunny',
    'mostly clear', 'fair', 'partly cloudy', 'a few clouds'
  ];

  const PRECIP_KEYWORDS = [
    'rain', 'drizzle', 'snow', 'showers', 'thunderstorm', 'sleet', 'freezing'
  ];

  const TEMP_MIN_C = 16.5;
  const TEMP_MAX_C = 25.5;
  const WIND_MAX_KMH = 24;

  // --- State ---
  let activeController = null;
  let loadingTimer5s = null;
  let loadingTimer12s = null;

  // --- DOM ---
  const app = document.getElementById('app');
  const stateContainer = document.getElementById('state-container');

  // Add aria-live region
  const liveRegion = document.createElement('div');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.className = 'sr-only';
  app.appendChild(liveRegion);

  // --- Utilities ---

  function celsiusToFahrenheit(c) {
    return Math.round(c * 9 / 5 + 32);
  }

  function kmhToMph(kmh) {
    return Math.round(kmh * 0.621371);
  }

  function roundCoord(val) {
    return Math.round(val * 100) / 100;
  }

  function formatTime(isoString) {
    try {
      const date = new Date(isoString);
      const hours = date.getHours();
      const minutes = date.getMinutes();
      const ampm = hours >= 12 ? 'pm' : 'am';
      const h = hours % 12 || 12;
      const m = minutes.toString().padStart(2, '0');
      return `${h}:${m} ${ampm}`;
    } catch {
      return '';
    }
  }

  // --- Fetch with Timeout ---

  async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    // Link to active controller for cancellation
    if (activeController) {
      activeController.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { 'Accept': 'application/geo+json', ...options.headers }
      });
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`CLIENT_ERROR_${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Fetch with Retry ---

  async function fetchWithRetry(url, options = {}, timeoutMs = TIMEOUT_MS) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (e) {
      if (e.message.startsWith('CLIENT_ERROR_')) throw e;
      if (activeController && activeController.signal.aborted) throw e;
      await new Promise(r => setTimeout(r, 1000));
      return await fetchWithTimeout(url, options, timeoutMs);
    }
  }

  // --- Caching ---

  function getObsCache(lat, lon) {
    const key = `nws_obs_${lat}_${lon}`;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
      return data;
    } catch {
      return null;
    }
  }

  function setObsCache(lat, lon, alerts, observation) {
    const key = `nws_obs_${lat}_${lon}`;
    try {
      sessionStorage.setItem(key, JSON.stringify({
        timestamp: Date.now(),
        alerts,
        observation
      }));
    } catch { /* quota exceeded — acceptable to skip */ }
  }

  function getPointsCache(lat, lon) {
    const key = `nws_points_${lat}_${lon}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.timestamp > POINTS_CACHE_TTL_MS) return null;
      return data;
    } catch {
      return null;
    }
  }

  function setPointsCache(lat, lon, stationUrl) {
    const key = `nws_points_${lat}_${lon}`;
    try {
      localStorage.setItem(key, JSON.stringify({
        timestamp: Date.now(),
        stationUrl
      }));
    } catch { /* acceptable to skip */ }
  }

  // --- Rendering ---

  function render(html) {
    stateContainer.innerHTML = html;
  }

  function announce(text) {
    liveRegion.textContent = text;
  }

  function showPrompt() {
    render('<button id="prompt" class="prompt" type="button">is it nice out<span class="cursor"></span></button>');
    const btn = document.getElementById('prompt');
    btn.addEventListener('click', handleClick);
    announce('');
  }

  function showLoading() {
    render(
      '<p class="loading-text">checking...</p>' +
      '<p id="loading-sub" class="loading-subtext"></p>'
    );

    loadingTimer5s = setTimeout(() => {
      const sub = document.getElementById('loading-sub');
      if (sub) {
        sub.textContent = 'still working...';
        sub.classList.add('visible');
      }
    }, 5000);

    loadingTimer12s = setTimeout(() => {
      const sub = document.getElementById('loading-sub');
      if (sub) {
        sub.textContent = "this is taking a while — hang on.";
      }
    }, 12000);
  }

  function clearLoadingTimers() {
    if (loadingTimer5s) { clearTimeout(loadingTimer5s); loadingTimer5s = null; }
    if (loadingTimer12s) { clearTimeout(loadingTimer12s); loadingTimer12s = null; }
  }

  function showResult(answer, details, alerts, stationUrl, tableData) {
    const isYes = answer === 'yes';
    const hasAlerts = alerts && alerts.length > 0;

    let html = '<div class="result" id="result">';
    html += `<h1 class="answer-text">${answer}</h1>`;

    if (details.length > 0) {
      html += '<ul class="detail-lines">';
      details.forEach(d => {
        html += `<li class="detail-line">${d}</li>`;
      });
      html += '</ul>';
    }

    if (isYes && hasAlerts) {
      html += '<div class="alert-banner">';
      alerts.forEach(a => {
        const expiry = a.expires ? ` until ${formatTime(a.expires)}` : '';
        html += `<p class="alert-line">but a <a href="${escapeAttr(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.event)}</a> is in effect${expiry}</p>`;
      });
      html += '</div>';
    }

    // Data table
    if (tableData) {
      html += '<table class="data-table">';
      tableData.forEach(row => {
        const cls = row.fail ? ' class="fail"' : '';
        html += `<tr${cls}><td>${row.label}</td><td>${row.value}</td></tr>`;
      });
      html += '</table>';
    }

    html += '<p class="footer">data from the <a href="' + escapeAttr(stationUrl || 'https://www.weather.gov') + '" target="_blank" rel="noopener">national weather service</a></p>';
    html += '<button class="check-again" type="button">check again</button>';
    html += '</div>';

    render(html);

    // Trigger enter animation
    requestAnimationFrame(() => {
      const result = document.getElementById('result');
      if (result) result.classList.add('entered');
      document.querySelectorAll('.detail-line').forEach(el => {
        el.classList.add('entered');
      });
    });

    // Wire check-again
    const checkAgain = stateContainer.querySelector('.check-again');
    if (checkAgain) checkAgain.addEventListener('click', showPrompt);

    // Announce for screen readers
    const announcementParts = [answer];
    details.forEach(d => announcementParts.push(stripHtml(d)));
    if (hasAlerts && isYes) {
      alerts.forEach(a => announcementParts.push(`but a ${a.event} is in effect`));
    }
    announce(announcementParts.join('. '));
  }

  function showIDK(subtext) {
    let html = '<div class="result" id="result">';
    html += '<h1 class="answer-text">idk</h1>';
    html += `<ul class="detail-lines"><li class="detail-line">${escapeHtml(subtext)}</li></ul>`;
    html += '<button class="check-again" type="button">check again</button>';
    html += '</div>';

    render(html);

    requestAnimationFrame(() => {
      const result = document.getElementById('result');
      if (result) result.classList.add('entered');
      document.querySelectorAll('.detail-line').forEach(el => {
        el.classList.add('entered');
      });
    });

    const checkAgain = stateContainer.querySelector('.check-again');
    if (checkAgain) checkAgain.addEventListener('click', showPrompt);

    announce(`I don't know. ${subtext}`);
  }

  // --- HTML Escaping ---

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function stripHtml(str) {
    const div = document.createElement('div');
    div.innerHTML = str;
    return div.textContent || '';
  }

  // --- Main Pipeline ---

  async function handleClick() {
    // Abort any in-flight pipeline
    if (activeController) {
      activeController.abort();
    }
    activeController = new AbortController();

    showLoading();

    // Offline check
    if (!navigator.onLine) {
      clearLoadingTimers();
      showIDK("you're offline right now");
      return;
    }

    // Geolocation
    let lat, lon;
    try {
      const pos = await getPosition();
      lat = roundCoord(pos.coords.latitude);
      lon = roundCoord(pos.coords.longitude);
    } catch (e) {
      clearLoadingTimers();
      showIDK("i don't know where you are — you have to let me see your location");
      return;
    }

    // Check abort
    if (activeController.signal.aborted) return;

    // Check observation cache
    const cached = getObsCache(lat, lon);
    if (cached) {
      clearLoadingTimers();
      runAlgorithm(cached.alerts, cached.observation, null);
      return;
    }

    // Fetch data
    try {
      const pointsCache = getPointsCache(lat, lon);

      // Parallel: alerts + points (or just alerts if points cached)
      let alertsData, stationUrl;

      if (pointsCache) {
        stationUrl = pointsCache.stationUrl;
        const alertsResp = await fetchWithRetry(`${API_BASE}/alerts/active?point=${lat},${lon}`);
        const alertsJson = await alertsResp.json();
        alertsData = alertsJson.features || [];
      } else {
        const [alertsResp, pointsResp] = await Promise.all([
          fetchWithRetry(`${API_BASE}/alerts/active?point=${lat},${lon}`),
          fetchWithRetry(`${API_BASE}/points/${lat},${lon}`)
        ]);
        const alertsJson = await alertsResp.json();
        alertsData = alertsJson.features || [];

        const pointsJson = await pointsResp.json();
        if (!pointsJson.properties || !pointsJson.properties.observationStations) {
          throw new Error('PARSE_ERROR');
        }

        // Get first station from stations list
        const stationsResp = await fetchWithRetry(pointsJson.properties.observationStations);
        const stationsJson = await stationsResp.json();
        if (!stationsJson.features || stationsJson.features.length === 0) {
          throw new Error('PARSE_ERROR');
        }
        stationUrl = stationsJson.features[0].id + '/observations/latest';
        setPointsCache(lat, lon, stationUrl);
      }

      if (activeController.signal.aborted) return;

      // Fetch observation
      const obsResp = await fetchWithRetry(stationUrl);
      const obsJson = await obsResp.json();

      if (!obsJson.properties) {
        throw new Error('PARSE_ERROR');
      }

      if (activeController.signal.aborted) return;

      // Staleness check
      const obsTimestamp = obsJson.properties.timestamp;
      if (obsTimestamp) {
        const age = Date.now() - new Date(obsTimestamp).getTime();
        if (age > STALENESS_THRESHOLD_MS) {
          clearLoadingTimers();
          showIDK("weather data is stale — the station might be having issues");
          return;
        }
      }

      // Cache
      setObsCache(lat, lon, alertsData, obsJson);

      clearLoadingTimers();
      runAlgorithm(alertsData, obsJson, stationUrl);

    } catch (e) {
      clearLoadingTimers();
      if (activeController.signal.aborted) return;

      if (e.message === 'PARSE_ERROR' || e.message.startsWith('CLIENT_ERROR_')) {
        showIDK("got something weird back from the weather service — try again");
      } else {
        showIDK("the weather service is being slow — try again in a sec");
      }
    }
  }

  // --- Geolocation Promise ---

  function getPosition() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000
      });
    });
  }

  // --- Comfort Algorithm ---

  function runAlgorithm(alertsData, obsJson, stationUrl) {
    const props = obsJson.properties;
    const failures = [];
    const tableData = [];

    // Null checks for required fields
    if (props.temperature == null || props.temperature.value == null) {
      showIDK("got something weird back from the weather service — try again");
      return;
    }
    if (props.windSpeed == null || props.windSpeed.value == null) {
      showIDK("got something weird back from the weather service — try again");
      return;
    }
    if (!props.textDescription) {
      showIDK("got something weird back from the weather service — try again");
      return;
    }

    // Temperature
    const tempC = props.temperature.value;
    const tempF = celsiusToFahrenheit(tempC);
    let tempFail = false;

    if (tempC < TEMP_MIN_C) {
      failures.push(`too cold (${tempF}°)`);
      tempFail = true;
    } else if (tempC > TEMP_MAX_C) {
      failures.push(`too hot (${tempF}°)`);
      tempFail = true;
    }

    tableData.push({ label: 'temp', value: `${tempF}°`, fail: tempFail });

    // Wind
    const windKmh = props.windSpeed.value;
    const windMph = kmhToMph(windKmh);
    const windFail = windKmh >= WIND_MAX_KMH;

    if (windFail) {
      failures.push(`way too windy (${windMph} mph)`);
    }

    tableData.push({ label: 'wind', value: `${windMph} mph`, fail: windFail });

    // Sky condition
    const description = props.textDescription;
    const descLower = description.toLowerCase();
    const skyPasses = SKY_PASSLIST.some(term => descLower.includes(term));

    // Precipitation
    const precipVal = props.precipitationLastHour ? props.precipitationLastHour.value : null;
    let precipFailed = false;

    if (precipVal != null && precipVal > PRECIP_NOISE_THRESHOLD_MM) {
      precipFailed = true;
    }
    if (!precipFailed) {
      for (const keyword of PRECIP_KEYWORDS) {
        if (descLower.includes(keyword)) {
          precipFailed = true;
          break;
        }
      }
    }

    if (precipFailed) {
      if (tempF <= 35) {
        failures.push("it's snowing");
      } else {
        failures.push("it's raining");
      }
    }

    tableData.push({ label: 'sky', value: descLower, fail: !skyPasses });
    tableData.push({ label: 'precip', value: precipFailed ? (tempF <= 35 ? 'snow' : 'rain') : 'none', fail: precipFailed });

    if (!skyPasses && !precipFailed) {
      failures.push(`sky isn't great (${escapeHtml(descLower)})`);
    }

    // Alert evaluation
    const qualifyingAlerts = filterAlerts(alertsData);
    const extremeAlerts = qualifyingAlerts.filter(a => a.properties.severity === 'Extreme');

    // Extreme override
    if (extremeAlerts.length > 0) {
      extremeAlerts.forEach(a => {
        failures.push(`there's a ${escapeHtml(a.properties.event.toLowerCase())} right now`);
      });
    }

    // Determine state
    const isNice = failures.length === 0 && extremeAlerts.length === 0;

    if (isNice) {
      const details = [
        `${tempF}° and ${escapeHtml(descLower)}`,
        `wind is ${windMph} mph`
      ];

      const nonExtremeAlerts = qualifyingAlerts
        .filter(a => a.properties.severity !== 'Extreme')
        .map(a => ({
          event: a.properties.event,
          expires: a.properties.expires,
          url: a.properties.id || a.id || '#'
        }));

      showResult('yes', details, nonExtremeAlerts, stationUrl, tableData);
    } else {
      showResult('no', failures, null, stationUrl, tableData);
    }
  }

  // --- Alert Filtering ---

  function filterAlerts(features) {
    if (!features || !Array.isArray(features)) return [];
    return features.filter(f => {
      const p = f.properties;
      if (!p) return false;
      if (p.messageType === 'Test') return false;
      if (p.event && p.event.includes('Statement')) return false;
      const validSeverities = ['Extreme', 'Severe', 'Moderate'];
      return validSeverities.includes(p.severity);
    });
  }

  // --- Init ---

  function init() {
    const btn = document.getElementById('prompt');
    if (btn) btn.addEventListener('click', handleClick);
  }

  init();
})();
