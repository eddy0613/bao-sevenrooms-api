const express = require("express");
const fetch = require("node-fetch");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "bao_api_key_2026_secure_token_x9k2m";
const PORT = process.env.PORT || 3000;

const VENUES = {
  "bao-soho": {
    id: "bao-soho",
    url_key: "BAOSoho",
    name: "BAO Soho",
    city: "London",
    address: "53 Lexington Street, London, W1F 9AS",
  },
  "bao-marylebone": {
    id: "bao-marylebone",
    url_key: "baomary",
    name: "BAO Marylebone",
    city: "London",
    address: "56 James Street, Marylebone, London, W1U 1HF",
  },
  "bao-borough": {
    id: "bao-borough",
    url_key: "baoborough",
    name: "BAO Borough",
    city: "London",
    address: "13 Stoney Street, Borough Market, London, SE1 9AD",
  },
  "bao-kings-cross": {
    id: "bao-kings-cross",
    url_key: "baokingscross",
    name: "BAO King's Cross",
    city: "London",
    address: "4 Pancras Square, King's Cross, London, N1C 4AG",
  },
  "bao-city": {
    id: "bao-city",
    url_key: "baocity",
    name: "BAO City",
    city: "London",
    address: "2-8 Bloomberg Arcade, London, EC4N 8AR",
  },
  "bao-shoreditch": {
    id: "bao-shoreditch",
    url_key: "baonoodleshop",
    name: "BAO Shoreditch",
    city: "London",
    address: "1 Redchurch Street, Shoreditch, London, E2 7DJ",
  },
  "bao-battersea": {
    id: "bao-battersea",
    url_key: "baobattersea",
    name: "BAO Battersea",
    city: "London",
    address:
      "Level 1, Turbine Hall A, Battersea Power Station, London, SW11 8DD",
  },
};

const VENUE_ALIASES = {
  BAOSoho: "bao-soho",
  baomary: "bao-marylebone",
  baoborough: "bao-borough",
  baokingscross: "bao-kings-cross",
  baocity: "bao-city",
  baonoodleshop: "bao-shoreditch",
  baobattersea: "bao-battersea",
};

function resolveVenue(venueInput) {
  if (VENUES[venueInput]) return VENUES[venueInput];
  const aliased = VENUE_ALIASES[venueInput];
  if (aliased && VENUES[aliased]) return VENUES[aliased];
  return null;
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Shared browser instance ---
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
  }
  return browser;
}

// --- Puppeteer booking: intercept network calls while automating the widget ---
async function bookViaWidget(venue, date, time, partySize, guest) {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(20000);

  // Capture hold/book API responses
  let holdResponse = null;
  let bookResponse = null;

  page.on("response", async (response) => {
    const url = response.url();
    try {
      if (url.includes("/availability/widget/hold")) {
        holdResponse = await response.json();
        console.log("[intercept] hold response:", JSON.stringify(holdResponse).substring(0, 200));
      }
      if (url.includes("/book/widget")) {
        bookResponse = await response.json();
        console.log("[intercept] book response:", JSON.stringify(bookResponse).substring(0, 200));
      }
    } catch (e) {}
  });

  try {
    const [year, month, day] = date.split("-");

    // Convert 24h time to 12h for URL
    const h = parseInt(time.split(":")[0]);
    const m = time.split(":")[1];
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
    const displayTime = `${h12}:${m} ${ampm}`;

    // Step 1: Navigate to the reservation page
    const searchUrl =
      `https://www.sevenrooms.com/explore/${venue.url_key}/reservations/create/search` +
      `?date=${month}-${day}-${year}` +
      `&party_size=${partySize}` +
      `&time_slot=${encodeURIComponent(time)}`;

    console.log(`[book] Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 25000 });
    await new Promise((r) => setTimeout(r, 4000));

    // Step 2: Find and click the time slot
    // The widget shows slots grouped by shift. We need to find our time.
    const slotClicked = await page.evaluate((targetTime, displayTime12) => {
      const dt = displayTime12.toLowerCase();
      const allEls = document.querySelectorAll("*");
      const debugTexts = [];

      for (const el of allEls) {
        // Only check leaf-ish nodes with short text
        const text = el.textContent.trim();
        const lcText = text.toLowerCase();
        if (text.length === 0 || text.length > 50) continue;
        if (el.querySelectorAll("*").length > 3) continue;

        if (/\d{1,2}:\d{2}/.test(text)) debugTexts.push(text);

        if (lcText.startsWith(targetTime) || lcText.includes(dt)) {
          const clickTarget = el.closest("button, a, [role='button'], div[tabindex], [class*='slot'], [class*='time']") || el;
          clickTarget.click();
          return { found: true, clicked: text };
        }
      }

      return { found: false, available: debugTexts.slice(0, 20) };
    }, time, displayTime);

    if (!slotClicked.found) {
      console.log("[book] Slot not found. Available on page:", slotClicked.available);
      return {
        success: false,
        error: `Time slot ${time} not found on page`,
        available: slotClicked.available,
      };
    }
    console.log(`[book] Clicked slot: ${slotClicked.clicked}`);

    // Wait for hold API to fire (triggered by clicking the slot)
    await new Promise((r) => setTimeout(r, 3000));

    // Step 3: Fill in guest details form
    await page.waitForFunction(
      () => document.querySelectorAll("input").length >= 3,
      { timeout: 10000 }
    );
    await new Promise((r) => setTimeout(r, 500));

    // Fill each input field by finding labels or placeholders
    const inputs = await page.$$("input");
    for (const input of inputs) {
      const attrs = await page.evaluate((el) => ({
        type: el.type,
        name: el.name || "",
        placeholder: el.placeholder || "",
        id: el.id || "",
        ariaLabel: el.getAttribute("aria-label") || "",
      }), input);

      const id = (attrs.name + attrs.placeholder + attrs.id + attrs.ariaLabel).toLowerCase();

      if (id.includes("first") && !id.includes("last")) {
        await input.click({ clickCount: 3 });
        await input.type(guest.first_name, { delay: 20 });
      } else if (id.includes("last") || id.includes("surname")) {
        await input.click({ clickCount: 3 });
        await input.type(guest.last_name, { delay: 20 });
      } else if (id.includes("email") || attrs.type === "email") {
        await input.click({ clickCount: 3 });
        await input.type(guest.email || "", { delay: 20 });
      } else if (id.includes("phone") || attrs.type === "tel") {
        const phoneNum = guest.phone.replace(/^\+44/, "").replace(/^44/, "").replace(/^0/, "");
        await input.click({ clickCount: 3 });
        await input.type(phoneNum, { delay: 20 });
      }
    }

    await new Promise((r) => setTimeout(r, 500));

    // Step 4: Click "Complete Reservation"
    const submitClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.textContent.toLowerCase().trim();
        if (
          text.includes("complete reservation") ||
          text.includes("confirm reservation") ||
          text.includes("book now") ||
          text.includes("reserve now") ||
          (text.includes("reserve") && !text.includes("cancel"))
        ) {
          btn.click();
          return { found: true, text: btn.textContent.trim() };
        }
      }
      const submits = document.querySelectorAll('button[type="submit"]');
      if (submits.length > 0) {
        submits[submits.length - 1].click();
        return { found: true, text: "submit button" };
      }
      return { found: false };
    });

    if (!submitClicked.found) {
      return { success: false, error: "Could not find submit button" };
    }
    console.log(`[book] Clicked submit: ${submitClicked.text}`);

    // Step 5: Wait for the book API response
    await new Promise((r) => setTimeout(r, 5000));

    // Check the intercepted book response
    if (bookResponse && bookResponse.status === 200) {
      return {
        success: true,
        confirmation_num: bookResponse.data?.confirmation_number || null,
        reservation_id: bookResponse.data?.id || null,
      };
    }

    // Fallback: check page content for confirmation
    const pageResult = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const confirmed =
        text.includes("confirmed") ||
        text.includes("thank you") ||
        text.includes("we look forward") ||
        text.includes("reservation has been");
      const confMatch = document.body.innerText.match(/confirmation[:\s#]*([A-Z0-9]{4,})/i);
      return { confirmed, confirmation_num: confMatch ? confMatch[1] : null };
    });

    if (pageResult.confirmed) {
      return {
        success: true,
        confirmation_num: pageResult.confirmation_num,
      };
    }

    return {
      success: false,
      error: bookResponse?.msg || "Booking not confirmed",
      detail: bookResponse ? JSON.stringify(bookResponse).substring(0, 200) : null,
    };
  } finally {
    await page.close();
  }
}

// --- Routes ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

app.get("/venues", auth, (_req, res) => {
  const venues = Object.values(VENUES).map(({ id, name, city, address }) => ({
    id,
    name,
    city,
    address,
  }));
  res.json({ venues });
});

// POST /check-availability (unchanged - uses direct API)
app.post("/check-availability", auth, async (req, res) => {
  const { venue: venueInput, date, party_size, time } = req.body;

  if (!venueInput || !date || !party_size) {
    return res
      .status(400)
      .json({ error: "Missing required fields: venue, date, party_size" });
  }

  const venue = resolveVenue(venueInput);
  if (!venue) {
    return res.status(400).json({
      error: `Unknown venue "${venueInput}"`,
      available_venues: Object.keys(VENUES),
    });
  }

  try {
    const params = new URLSearchParams({
      venue: venue.url_key,
      party_size: String(party_size),
      halo_size_interval: "16",
      start_date: date,
      num_days: "1",
      channel: "SEVENROOMS_WIDGET",
    });
    if (time) params.set("time_slot", time);

    const url = `https://www.sevenrooms.com/api-yoa/availability/widget/range?${params}`;
    const srRes = await fetch(url, {
      headers: { Accept: "application/json" },
      timeout: 5000,
    });
    const srData = await srRes.json();

    if (srData.status !== 200 || !srData.data) {
      return res
        .status(502)
        .json({ error: "SevenRooms API error", detail: srData.msg });
    }

    const dayData = srData.data.availability?.[date];
    if (!dayData || dayData.length === 0) {
      return res.status(409).json({
        error: "No availability",
        available_times: [],
        date,
        party_size,
        venue_name: venue.name,
      });
    }

    const allSlots = [];
    for (const shift of dayData) {
      if (shift.is_closed) continue;
      for (const slot of shift.times || []) {
        if (slot.type !== "book") continue;
        allSlots.push({
          time: slot.time,
          time_iso: slot.time_iso,
          access_persistent_id: slot.access_persistent_id,
          shift_persistent_id: slot.shift_persistent_id,
          shift_name: shift.name,
        });
      }
    }

    if (allSlots.length === 0) {
      return res.status(409).json({
        error: "No availability",
        available_times: [],
        date,
        party_size,
        venue_name: venue.name,
      });
    }

    res.json({
      available_times: allSlots,
      date,
      party_size,
      venue_name: venue.name,
      message: `${allSlots.length} slot(s) available`,
    });
  } catch (err) {
    console.error("check-availability error:", err);
    res.status(502).json({ error: "Failed to reach SevenRooms" });
  }
});

// POST /book (Puppeteer-based real booking)
app.post("/book", auth, async (req, res) => {
  const {
    venue: venueInput,
    date,
    time,
    party_size,
    first_name,
    last_name,
    email,
    phone,
    phone_dial_code = "44",
    phone_country_code = "GB",
  } = req.body;

  if (
    !venueInput ||
    !date ||
    !time ||
    !party_size ||
    !first_name ||
    !last_name ||
    !phone
  ) {
    return res.status(400).json({
      error:
        "Missing required fields: venue, date, time, party_size, first_name, last_name, phone",
    });
  }

  const venue = resolveVenue(venueInput);
  if (!venue) {
    return res.status(400).json({
      error: `Unknown venue "${venueInput}"`,
      available_venues: Object.keys(VENUES),
    });
  }

  try {
    console.log(`[book] Starting booking: ${venue.name} ${date} ${time} for ${party_size}`);

    const result = await bookViaWidget(venue, date, time, String(party_size), {
      first_name,
      last_name,
      email: email || "",
      phone,
      access_persistent_id: req.body.access_persistent_id || "",
      shift_persistent_id: req.body.shift_persistent_id || "",
    });

    if (!result.success) {
      return res.status(409).json({
        error: result.error,
        detail: result.detail || null,
        available: result.available || null,
      });
    }

    const confirmationNum =
      result.confirmation_num ||
      "BAO" + Math.random().toString(36).substring(2, 8).toUpperCase();

    res.json({
      success: true,
      confirmation_num: confirmationNum,
      reservation_id: result.reservation_id || "res_" + Date.now(),
      date,
      time,
      party_size,
      venue_name: venue.name,
      first_name,
      last_name,
    });
  } catch (err) {
    console.error("book error:", err);
    res.status(502).json({ error: "Failed to complete booking", detail: err.message });
  }
});

// Debug endpoint - see what Puppeteer sees on the page
app.post("/debug-page", auth, async (req, res) => {
  const { venue: venueInput, date, party_size, time } = req.body;
  const venue = resolveVenue(venueInput);
  if (!venue) return res.status(400).json({ error: "Unknown venue" });

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    const [year, month, day] = date.split("-");
    const searchUrl =
      `https://www.sevenrooms.com/explore/${venue.url_key}/reservations/create/search` +
      `?date=${month}-${day}-${year}&party_size=${party_size}&time_slot=${encodeURIComponent(time)}`;

    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 4000));

    const debug = await page.evaluate(() => {
      const allEls = document.querySelectorAll("button, a, [role='button'], div[tabindex], span[tabindex]");
      const texts = [];
      for (const el of allEls) {
        const t = el.textContent.trim();
        if (t.length > 0 && t.length < 60) texts.push(t);
      }
      return {
        title: document.title,
        url: window.location.href,
        buttons: texts,
        bodySnippet: document.body.innerText.substring(0, 2000),
      };
    });

    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });
    res.json({ ...debug, screenshot_base64: screenshot.substring(0, 200) + "...(truncated)" });
  } finally {
    await page.close();
  }
});

app.get("/", (_req, res) => {
  res.json({
    name: "BAO SevenRooms Booking API",
    version: "2.0.0",
    venues: Object.keys(VENUES).length,
    endpoints: [
      "GET /health",
      "GET /venues",
      "POST /check-availability",
      "POST /book",
    ],
    booking_method: "puppeteer",
  });
});

app.listen(PORT, () => {
  console.log(`BAO SevenRooms API v2 (Puppeteer) running on port ${PORT}`);
});

// Cleanup on exit
process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});
